import path from 'node:path';
import { spawn } from 'node:child_process';
import { isInside } from '../../../shared/paths.js';
import { buildSeEnv } from './seSpawnSpec.js';

export const SE_PROBE_TIMEOUT_MS = 15000;

export function isPathInside(parent, child) {
  if (!parent || !child) return false;
  return isInside(path.resolve(parent), path.resolve(child));
}

const PROBE_IMPORT_CODE =
  "import snakeeats,sys,json;print(json.dumps({'file':snakeeats.__file__,'version':getattr(snakeeats,'__version__',''),'python':'%d.%d'%sys.version_info[:2]}))";

function lastLines(text, count = 3) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-count).join(' / ');
}

function failureDetail(result) {
  const combined = [result.stderr, result.stdout].filter(Boolean).join('\n');
  const tail = lastLines(combined, 3);
  if (tail) return tail;
  if (result.error) return result.error.message;
  return `exit=${result.status == null ? 'null' : result.status}`;
}

function runPython(python, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(python, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // best effort
      }
      finish({ status: null, error: new Error(`python probe timeout after ${timeoutMs}ms`) });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => finish({ status: null, error }));
    child.on('close', (status) => finish({ status, error: null }));
  });
}

export async function probeSeRuntime(descriptor, { baseEnv = process.env, timeoutMs = SE_PROBE_TIMEOUT_MS } = {}) {
  const python = descriptor && descriptor.python;
  const mode = descriptor && descriptor.mode === 'pip' ? 'pip' : 'dir';
  const packageParent = descriptor && descriptor.packageParent;
  const cwd = mode === 'pip'
    ? descriptor.dataRoot || descriptor.appRoot || process.cwd()
    : packageParent;
  try {
    if (!python || (mode === 'dir' && !packageParent)) {
      return {
        ok: false,
        reason: `SE 运行时描述不完整：python=${python || '(空)'}, packageParent=${packageParent || '(空)'}`,
      };
    }
    const env = buildSeEnv({ ...descriptor, mode, packageParent }, { baseEnv });
    const imported = await runPython(python, ['-c', PROBE_IMPORT_CODE], { cwd, env, timeoutMs });
    if (imported.error || imported.status !== 0) {
      return {
        ok: false,
        reason: `import snakeeats 失败：${failureDetail(imported)}（python=${python}, packageParent=${packageParent || '(pip)'}）`,
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(String(imported.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '{}');
    } catch (err) {
      return { ok: false, reason: `import 探测输出不是 JSON：${String(imported.stdout || '').slice(-200)}` };
    }
    const moduleFile = String(parsed.file || '');
    const pkgVersion = String(parsed.version || '');
    const pythonVersion = String(parsed.python || '');
    if (!moduleFile || moduleFile === 'None' || !path.isAbsolute(moduleFile)) {
      return { ok: false, reason: `import snakeeats 返回了无效模块路径：${moduleFile || '(空)'}` };
    }
    if (mode === 'dir' && !isInside(packageParent, moduleFile)) {
      return {
        ok: false,
        reason: `import snakeeats 命中 ${moduleFile}，不在 ${packageParent} 下（疑似 PYTHONPATH/site-packages shadow）`,
      };
    }
    if (mode === 'pip' && descriptor.appRoot && isInside(descriptor.appRoot, moduleFile)) {
      return {
        ok: false,
        reason: `pip 模式命中了应用目录内的 snakeeats（${moduleFile}），疑似本地影子包；请使用已安装到 Python 环境的 snakeeats`,
      };
    }

    const helped = await runPython(python, ['-m', 'snakeeats', 'serve', '--help'], { cwd, env, timeoutMs });
    if (helped.error || helped.status !== 0) {
      const code = helped.error ? helped.error.code || helped.error.message : helped.status;
      return {
        ok: false,
        reason: `包可导入但入口不可用：python -m snakeeats serve --help 退出码 ${code}：${failureDetail(helped)}`,
      };
    }

    return {
      ok: true,
      reason: 'import snakeeats + serve --help ok',
      version: pkgVersion,
      pythonVersion,
      moduleFile,
    };
  } catch (err) {
    return { ok: false, reason: `探测 SE 运行时异常：${err && err.message ? err.message : String(err)}` };
  }
}
