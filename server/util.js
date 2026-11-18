// 服务端通用工具：HTTP 辅助、PowerShell 对话框、OS/进程探针。零 __dirname 依赖。
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { isPidAlive } from './platform/process.js';

export function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

export function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });
}

// ── 系统对话框（平台适配唯一实现）──────────────────────────────────────────
export { parseDialogOpts, runDialog } from './platform/dialog.js';

// ── 盘符 / 目录探测 / 外部打开 ──────────────────────────────────────────────

/**
 * 枚举可见盘符：win32 探 A-Z；非 win32 固定根。
 */
export function listDrives() {
  if (process.platform === 'win32') {
    const drives = [];
    for (let i = 0; i < 26; i += 1) {
      const letter = String.fromCharCode(65 + i);
      const root = `${letter}:\\`;
      try {
        if (fs.existsSync(root)) {
          drives.push({ name: `本地磁盘 (${letter}:)`, path: root, label: root });
        }
      } catch (err) {
        /* 单盘探测失败跳过 */
      }
    }
    return drives;
  }
  return [{ name: '/', path: '/', label: '/' }];
}

// 目录探测：statSync 跟随重解析点；失败时退回 lstatSync（覆盖 OneDrive 离线/占位符场景）。
export function probeIsDir(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch (err) {
    /* 跟随失败，退回 lstat */
  }
  try {
    return fs.lstatSync(target).isDirectory();
  } catch (err) {
    return false;
  }
}

// 递归去环：解析真实路径并折叠大小写；解析失败退回原路径。
export function realDirKey(target) {
  let real = target;
  try {
    real = fs.realpathSync(target);
  } catch (err) {
    real = target;
  }
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

// 条目元信息：statSync 跟随 junction/重解析点；失败再退回 lstat/dirent，避免目录被误判为文件。
export function entryMeta(entryPath, dirent) {
  let stat = null;
  try {
    stat = fs.statSync(entryPath);
  } catch (err) {
    stat = null;
  }
  const isDir = stat ? stat.isDirectory() : dirent.isDirectory() || probeIsDir(entryPath);
  return { type: isDir ? 'dir' : 'file', size: stat ? stat.size : 0, mtime: stat ? stat.mtimeMs : 0 };
}

export function runDetached(cmd, args, ignoreExitCode) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err) => {
      if (err && !ignoreExitCode) reject(err);
      else resolve();
    });
  });
}

/**
 * 唤起系统程序打开/定位目标。explorer.exe 常以非零码退出但已成功 spawn，
 * 故 reveal 分支忽略退出码；其余平台正常反馈错误。
 */
export async function openPath(target, reveal) {
  if (process.platform === 'win32') {
    if (reveal) {
      const isDir = probeIsDir(target);
      if (isDir) await runDetached('explorer.exe', [target], true);
      else await runDetached('explorer.exe', [`/select,${target}`], true);
      return;
    }
    await runDetached('cmd.exe', ['/c', 'start', '""', target], false);
    return;
  }
  if (process.platform === 'darwin') {
    await runDetached('open', reveal ? ['-R', target] : [target], false);
    return;
  }
  await runDetached('xdg-open', [target], false);
}

// ── 进程探针 / 进程树（平台适配唯一实现）──────────────────────────────────
export { isPidAlive, killProcessTree, waitForProcessDead } from './platform/process.js';

/**
 * 读取进程启动时间作为 PID 复用判别证据。
 *
 * 只读取数值/时间字段，不读取命令行或路径，避免 Windows 非 ASCII 编码与引号差异。
 * 返回平台原始格式字符串（同一进程多次查询稳定），不可用返回 null。
 */
export function getProcessStartTime(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return null;
  try {
    if (process.platform === 'win32') {
      const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${n}" -ErrorAction SilentlyContinue; if (-not $p) { $p = Get-Process -Id ${n} -ErrorAction SilentlyContinue }; $t = if ($p -and $p.CreationDate) { $p.CreationDate } elseif ($p -and $p.StartTime) { $p.StartTime }; if ($t) { $t.ToUniversalTime().ToString("o") }`;
      const out = String(
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
          encoding: 'utf-8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 5000,
        }) || ''
      ).trim();
      return /^\d{4}-\d{2}-\d{2}T/.test(out) ? out : null;
    }
    const out = String(
      execFileSync('ps', ['-p', String(n), '-o', 'lstart='], {
        encoding: 'utf-8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      }) || ''
    ).trim();
    return out.split(/\r?\n/)[0].trim() || null;
  } catch (err) {
    return null;
  }
}

/** 同一 PID 且启动时间未变 → 仍是同一进程（防 PID 复用）。 */
export function isSameProcess(pid, startedAt) {
  const expected = String(startedAt == null ? '' : startedAt).trim();
  if (!expected || !isPidAlive(pid)) return false;
  const current = getProcessStartTime(pid);
  return !!current && current === expected;
}

/**
 * 由监听端口反查 listener。结果必须区分三态：
 * - found：唯一 PID（可能附带启动时间）；
 * - not-listening：命令成功且确认没有监听；
 * - unknown：命令失败/超时/多监听者/结果不可解析。
 *
 * 调用方不得把 unknown 当成 not-listening。
 */
export function findListeningProcess(port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n <= 0) {
    return { status: 'unknown', reason: 'invalid-port', pids: [] };
  }
  try {
    let rawPids = [];
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], {
        encoding: 'utf-8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      });
      for (const line of String(out).split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/);
        if (
          cols.length >= 5 &&
          cols[3] === 'LISTENING' &&
          cols[1] &&
          cols[1].endsWith(`:${n}`)
        ) {
          rawPids.push(Number(cols[4]));
        }
      }
    } else {
      const out = execFileSync('lsof', ['-ti', `tcp:${n}`, '-sTCP:LISTEN'], {
        encoding: 'utf-8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      });
      rawPids = String(out)
        .split(/\r?\n/)
        .map((line) => Number(line.trim()))
        .filter(Boolean);
    }
    const pids = [...new Set(rawPids.filter((pid) => Number.isInteger(pid) && pid > 0))];
    if (pids.length === 0) return { status: 'not-listening', pids: [] };
    if (pids.length > 1) {
      return { status: 'unknown', reason: 'multiple-listeners', pids };
    }
    const pid = pids[0];
    return { status: 'found', pid, startedAt: getProcessStartTime(pid), pids };
  } catch (err) {
    return {
      status: 'unknown',
      reason: 'listener-query-failed',
      pids: [],
      detail: String((err && err.message) || err),
    };
  }
}

/** 读取进程命令行（win32 走 PowerShell CIM / wmic 兜底；其它 ps）。失败返回 ''。 */
export function getProcessCmdline(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return '';
  try {
    if (process.platform === 'win32') {
      try {
        return String(
          execFileSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-Command',
              `(Get-CimInstance Win32_Process -Filter "ProcessId=${n}").CommandLine`,
            ],
            {
              encoding: 'utf-8',
              windowsHide: true,
              stdio: ['ignore', 'pipe', 'ignore'],
              timeout: 8000,
            }
          ) || ''
        );
      } catch (err) {
        return String(
          execFileSync('wmic', ['process', 'where', `processid=${n}`, 'get', 'commandline'], {
            encoding: 'utf-8',
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 8000,
          }) || ''
        );
      }
    }
    return String(
      execFileSync('ps', ['-p', String(n), '-o', 'command='], {
        encoding: 'utf-8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }) || ''
    );
  } catch (err) {
    return '';
  }
}

/**
 * 校验 pid 是否为 node/vite 进程（E：判定「另一活 vite 持有」用）。
 * 防 pid 复用误报：旧 vite pid 被无关进程复用时返回 false → 视为 vite 已死，可回收。
 * 不确定返回 false（宁可误判为已死并进入 snakeeats 校验的回收分支，也不误阻回收）。
 */
export function isNodeOrViteProcess(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  const cmd = getProcessCmdline(n);
  if (!cmd) return false;
  return /node|vite/i.test(cmd);
}
