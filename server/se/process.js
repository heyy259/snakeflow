// SE 进程生命周期（期 2/5）：排他锁、孤儿回收、spawn 全状态机、退出钩子、系统枚举。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  SE_DEFAULT_HOST,
  SE_ENV_ADMIN_TOKEN,
  SE_SPAWN_READY_TIMEOUT_MS,
  SE_SPAWN_POLL_MS,
  SE_LOCK_STALE_MS,
  SE_LOCK_NAME,
  SE_STDERR_CLOSE_GRACE_MS,
  seSpawnedSystems,
  seSpawnInflight,
  activeSpawnNonces,
} from './state.js';
import {
  seStorageDirOf,
  seRuntimeDirOf,
  readSeRegistry,
  writeSeOwner,
  readSeOwner,
  removeSeOwner,
  removeSeToken,
} from './registry.js';
import {
  resolveSeRuntimeForServer,
  resolveSeToken,
  probeTcp,
  verifySeSystem,
  sanitizeSeSystemId,
} from './resolve.js';
import { buildSeSpawnSpec } from './runtime/seSpawnSpec.js';
import { versionSatisfies } from './runtime/seRuntime.js';
import {
  isPidAlive,
  killProcessTree,
  waitForProcessDead,
  findListeningProcess,
  getProcessStartTime,
  isNodeOrViteProcess,
} from '../util.js';
import { verifyOwnedOrphan } from './instanceIdentity.js';
import { removeFileBestEffort } from '../resilientFs.js';
import { seSystemsDir } from '../paths.js';
import { seSpawnPlatformOptions } from '../platform/process.js';
import {
  claimStorageDir,
  removeEmptyClaim,
  resolveStorageId,
} from './identity.js';

const seSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 从 snakeeats stderr 识别实例锁冲突（README 文档化的稳定文案）：
 *   ``storage root already owned by pid <N|unknown>: <root> (lock=<path>)``
 * 返回 { holderPid, root, lock } 或 null。Node 不再把 traceback 原样抛给用户。
 */
export function parseStorageRootBusy(text) {
  const s = String(text == null ? '' : text);
  const m = s.match(
    /storage root already owned by pid\s+(\d+|unknown):\s*([\s\S]*?)\s*\(lock=([\s\S]*?)\)/
  );
  if (!m) return null;
  const pid = m[1] === 'unknown' ? null : Number(m[1]);
  return {
    holderPid: Number.isInteger(pid) && pid > 0 ? pid : null,
    root: String(m[2] || '').trim(),
    lock: String(m[3] || '').trim(),
  };
}

let seExitHookInstalled = false;

/**
 * storage 目录排他锁：<dir>/.spawn.lock 含 {pid, at, nonce}。
 * 判定顺序：① nonce 命中本进程在途集合 → 真占用；② 异进程 pid 存活且未过期 → 占用；
 * ③ 其余（本进程残留/死 pid/过期/旧格式无 nonce）→ 陈旧，覆盖。
 * 返回锁文件路径，已被占用返回 null。
 */
function acquireSpawnLock(systemId, spawnNonce) {
  const dir = seRuntimeDirOf(systemId);
  fs.mkdirSync(dir, { recursive: true });
  const lockFile = path.join(dir, SE_LOCK_NAME);
  try {
    // 读锁文件（解析失败视为无锁，与现状一致）
    const raw = JSON.parse(fs.readFileSync(lockFile, 'utf-8'));
    const at = Number(raw && raw.at);
    const pid = Number(raw && raw.pid);
    const nonce = raw && typeof raw.nonce === 'string' ? raw.nonce : '';
    // ① nonce 在本进程在途集合 → 真占用（同进程并发/别名 key，返回 null）
    if (nonce && activeSpawnNonces.has(nonce)) {
      return null;
    }
    // ② 否则 pid 存活且 pid !== process.pid 且 at 未过期（SE_LOCK_STALE_MS）→ 占用（返回 null）
    if (
      Number.isFinite(at) &&
      Date.now() - at < SE_LOCK_STALE_MS &&
      isPidAlive(pid) &&
      pid !== process.pid
    ) {
      return null;
    }
    // ③ 其余（本进程残留/死 pid/过期/旧格式无 nonce）→ 陈旧，覆盖
  } catch (err) {
    /* 无锁 / 半写文件：视为无锁 */
  }
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now(), nonce: spawnNonce }));
  return lockFile;
}

function releaseSpawnLock(lockFile, spawnNonce) {
  if (!lockFile) return;
  try {
    const raw = JSON.parse(fs.readFileSync(lockFile, 'utf-8'));
    const nonce = raw && typeof raw.nonce === 'string' ? raw.nonce : '';
    // nonce 不匹配说明锁已被后续 spawn 覆盖，不得误删。
    if (nonce !== spawnNonce) return;
  } catch (err) {
    /* 读不出 / 解析失败：无从判别，按己方锁删除 */
  }
  removeFileBestEffort(lockFile);
}

function clearKilledProcess(systemId) {
  removeSeOwner(systemId);
  removeSeToken(systemId);
  seSpawnedSystems.delete(systemId);
}

/**
 * 强杀前再次校验同一 listener PID + 启动时间；确认原进程已不存在后才清 owner/token/内存登记。
 */
export function killSameProcess(systemId, pid, startedAt) {
  const n = Number(pid);
  const expected = String(startedAt || '').trim();
  if (!Number.isInteger(n) || n <= 0 || !expected) return false;
  if (!isPidAlive(n)) {
    clearKilledProcess(systemId);
    return true;
  }
  const currentStart = getProcessStartTime(n);
  if (!currentStart) return false;
  if (currentStart !== expected) {
    clearKilledProcess(systemId);
    return true;
  }
  killProcessTree(n);
  if (!waitForProcessDead(n)) return false;
  clearKilledProcess(systemId);
  return true;
}

/** E2：新 owner 用 listener 身份；旧 owner 仅在进程启动早于 owner 写入时可迁移。 */
function reclaimOwnedOrphan(systemId, owner, regPort) {
  const verified = verifyOwnedOrphan({ owner, expectedPort: regPort });
  if (!verified.ok) return { ok: false, status: verified.status, reason: verified.reason };
  const killed = killSameProcess(systemId, verified.pid, verified.startedAt);
  return killed ? { ok: true, pid: verified.pid } : { ok: false, reason: 'kill-unconfirmed' };
}

/**
 * 退出即杀：对全部 vite spawn 的子进程 taskkill /PID <pid> /T /F。
 * 不能用 `snake down`（只摘注册项不停进程）。exit 事件内只允许同步操作。
 */
function seShutdownChildren() {
  for (const [systemId, entry] of seSpawnedSystems.entries()) {
    if (entry && entry.pid) {
      killProcessTree(entry.pid);
      // 仅在确认已死时才删 owner；杀失败则保留 owner，供下次启动按 owner.port 回收（C）。
      if (waitForProcessDead(entry.pid)) removeSeOwner(systemId);
    }
  }
  for (const id of [...seSpawnInflight.keys()]) {
    const entry = seSpawnedSystems.get(id);
    if (entry && entry.pid) {
      killProcessTree(entry.pid);
      if (waitForProcessDead(entry.pid)) removeSeOwner(id);
    }
  }
}

/**
 * 注册退出钩子（一次）：正常退出 / Ctrl+C / SIGTERM / IPC disconnect。
 * Windows 上硬杀（TerminateProcess）无法被捕获——正常关闭走 exit/SIGINT；
 * 冒烟测试用 IPC disconnect 触发确定性优雅关闭（见 smoke-se-lifecycle.mjs）。
 */
export function installSeExitHooks() {
  if (seExitHookInstalled) return;
  seExitHookInstalled = true;
  process.on('exit', seShutdownChildren);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    try {
      process.on(sig, () => {
        seShutdownChildren();
        process.exit(0);
      });
    } catch (err) {
      /* 平台不支持该信号 */
    }
  }
  // IPC 通道断开（父进程退出 / disconnect）：确定性优雅关闭，用于冒烟验证。
  if (typeof process.send === 'function') {
    process.on('disconnect', () => {
      seShutdownChildren();
      process.exit(0);
    });
  }
}

/**
 * spawn 一个 SE 系统（期 2 §5.5 全状态机）：
 * 排他锁 → 运行时解析 → spawn → 轮询 registry → system.info 校验 → 记录 owner。
 * 仅带 listener 启动时间的己方 owner 可回收；无 owner/旧 owner fail closed。
 * 并发冲突抛 owned-by-other-vite / port-unverifiable / locked。
 */
export async function spawnSeSystem(systemId, { intent = 'connect', claimed = false } = {}) {
  const inflight = seSpawnInflight.get(systemId);
  if (inflight) return inflight;
  // nonce 必须同步注册且早于 task 创建：冷路径下 acquireSpawnLock 在首个 await 前同步执行，
  // 锁文件需能立即区分「本进程活持有」与「历史残留」。
  const spawnNonce = crypto.randomBytes(8).toString('hex');
  activeSpawnNonces.add(spawnNonce);
  const task = (async () => {
    // ⓪ 身份/占位（在任何 registry/owner 读写之前）：
    //    - create：必须由 /api/se/create 用非递归 mkdir 原子占位；绝不进入回收/attach；
    //    - connect/start：别名在 spawn 前直接失败（不写旧根）；目录不存在则原子占位。
    //      exact 已存在 → 走原状态机（可由 Python 锁仲裁）。
    let claimOwned = claimed === true;
    if (intent === 'create') {
      if (!claimOwned) {
        throw Object.assign(new Error('create requires an atomically claimed storage root'), {
          status: 'identity-conflict',
        });
      }
    } else {
      const resolved = resolveStorageId(systemId);
      if (resolved.kind === 'invalid') {
        throw Object.assign(new Error('invalid system_id'), { status: 'identity-invalid' });
      }
      if (resolved.kind === 'alias') {
        throw Object.assign(
          new Error(`system_id case mismatch: disk uses ${resolved.dirName}`),
          { status: 'identity-mismatch', canonical: resolved.dirName }
        );
      }
      if (resolved.kind === 'ambiguous') {
        throw Object.assign(new Error('ambiguous system_id case variants'), {
          status: 'identity-conflict',
          candidates: resolved.dirNames,
        });
      }
      if (resolved.kind === 'absent') {
        const claim = claimStorageDir(systemId);
        if (!claim.ok) {
          const again = resolveStorageId(systemId);
          if (again.kind === 'alias') {
            throw Object.assign(
              new Error(`system_id case mismatch: disk uses ${again.dirName}`),
              { status: 'identity-mismatch', canonical: again.dirName }
            );
          }
          throw Object.assign(new Error('storage root claim raced'), {
            status: 'storage-root-busy',
          });
        }
        claimOwned = true;
      }
    }
    // ① 幂等守卫（Oracle Q3 规则 2）：本 vite 已持有该系统存活子进程 → 直接 online，
    //    绝不再 kill/重 spawn（防重复 /api/se/spawn 误杀自己刚拉起的实例）。
    const ours = seSpawnedSystems.get(systemId);
    if (ours) {
      const tcpAlive = ours.port ? await probeTcp(ours.port) : false;
      const childAlive = !ours.pid || isPidAlive(ours.pid);
      if (tcpAlive && childAlive) {
        return { system_id: systemId, port: ours.port, status: 'online' };
      }
      // 本 vite 登记的实例已死（子进程退出或端口关闭）→ 清登记，继续回收/全新 spawn。
      seSpawnedSystems.delete(systemId);
    }

    // ② 已注册且存活：
    //    - 另一活 Vite 持有 → owned-by-other-vite；
    //    - 己方 owner 且 listener/start-time 完整 → E2 回收；
    //    - 无 owner 或旧 owner → fail closed，不自动回收无法证明归属的进程。
    // 仅 connect/start 允许复用已有 storage；create 已在 ⓪ 原子占位。
    if (intent !== 'create') {
      const preReg = readSeRegistry(systemId);
      if (preReg && (await probeTcp(preReg.port))) {
        const owner = readSeOwner(systemId);
        if (owner) {
          const ownerVitePid = Number(owner.vitePid);
          const ownerIsOtherLiveVite =
            Number.isInteger(ownerVitePid) &&
            ownerVitePid > 0 &&
            ownerVitePid !== process.pid &&
            isPidAlive(ownerVitePid) &&
            isNodeOrViteProcess(ownerVitePid);
          if (ownerIsOtherLiveVite) {
            throw Object.assign(new Error('alive but owned by another running vite'), {
              status: 'owned-by-other-vite',
              port: preReg.port,
            });
          }
          const reclaimed = reclaimOwnedOrphan(systemId, owner, preReg.port);
          console.log(
            reclaimed.ok
              ? `[se] reclaimed owned orphan ${systemId} on port ${preReg.port}`
              : `[se] owned orphan ${systemId} not reclaimed: ${reclaimed.reason || reclaimed.status}`
          );
          if (!reclaimed.ok) {
            throw Object.assign(
              new Error(`owned system not verifiably reclaimable: ${reclaimed.reason || reclaimed.status}`),
              {
                status: 'port-unverifiable',
                reason: reclaimed.reason || reclaimed.status,
                port: preReg.port,
              }
            );
          }
        } else {
          const envToken = resolveSeToken(systemId);
          if (envToken) {
            try {
              await verifySeSystem(systemId, preReg.port, envToken);
              seSpawnedSystems.set(systemId, {
                port: preReg.port,
                token: envToken,
                storageDir: seStorageDirOf(systemId),
              });
              console.log(`[se] attached env-token ${systemId} on port ${preReg.port}`);
              return { system_id: systemId, port: preReg.port, status: 'online' };
            } catch (err) {
              // env token 对该端点无效；继续 fail closed，不猜测归属。
            }
          }
          throw Object.assign(new Error('unowned live system is not automatically reclaimable'), {
            status: 'port-unverifiable',
            reason: 'owner-missing',
            port: preReg.port,
          });
        }
      } else if (preReg) {
        removeSeOwner(systemId);
        removeSeToken(systemId);
      }
    }

    // ③ 排他锁：防多 tab / 多 vite 实例并发 spawn 同系统。
    const lockFile = acquireSpawnLock(systemId, spawnNonce);
    // 旧 registry 可能留有上一轮的陈旧条目（硬杀不会摘除）：记录其 mtime，
    // 就绪判定必须等文件被新进程重写（mtime 前进），否则会连到已死端口。
    const regFilePath = path.join(seStorageDirOf(systemId), 'registry', '.registry.json');
    let preRegistryMtime = 0;
    try {
      preRegistryMtime = fs.statSync(regFilePath).mtimeMs;
    } catch (err) {
      preRegistryMtime = 0;
    }
    if (!lockFile) {
      if (claimOwned) removeEmptyClaim(systemId);
      throw Object.assign(new Error('spawn already in progress'), { status: 'locked' });
    }
    let spawnSucceeded = false;
    try {
      const runtime = await resolveSeRuntimeForServer();
      if (!runtime.ok) throw new Error(runtime.reason);
      const token = crypto.randomBytes(24).toString('hex');
      const storageDir = seStorageDirOf(systemId);
      const spec = buildSeSpawnSpec(runtime, { storageDir, systemId, token });
      let stdout = '';
      let stderr = '';
      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: spec.stdio,
        ...seSpawnPlatformOptions(),
      });
      const entry = { pid: child.pid, token, storageDir, port: null, child };
      seSpawnedSystems.set(systemId, entry);
      let exitCode = null;
      let closeResolve = null;
      const closePromise = new Promise((resolve) => {
        closeResolve = resolve;
      });
      // stdout/stderr 并行 drain（防 Windows stdio 死锁）；留尾部用于诊断。
      child.stdout.on('data', (d) => {
        stdout = (stdout + String(d)).slice(-4000);
      });
      child.stderr.on('data', (d) => {
        stderr = (stderr + String(d)).slice(-4000);
      });
      child.on('error', (err) => {
        stderr = (stderr + `\nspawn error: ${err.message}`).slice(-4000);
      });
      child.on('exit', (code) => {
        exitCode = code == null ? -1 : code;
        if (seSpawnedSystems.get(systemId) === entry) seSpawnedSystems.delete(systemId);
      });
      // 'close' 晚于 'exit'：Windows 上最后一行 stderr（含 RuntimeError）可能还没 drain。
      child.on('close', () => {
        if (closeResolve) closeResolve();
      });

      // ④ 就绪 = 轮询 registry 出现该系统条目（stdout 缓冲不可靠）。
      const t0 = Date.now();
      let reg = null;
      while (Date.now() - t0 < SE_SPAWN_READY_TIMEOUT_MS) {
        if (exitCode != null) break;
        const candidate = readSeRegistry(systemId);
        if (candidate) {
          let mtime = 0;
          try {
            mtime = fs.statSync(regFilePath).mtimeMs;
          } catch (err) {
            mtime = 0;
          }
          if (mtime > preRegistryMtime) {
            reg = candidate;
            break;
          }
        }
        await seSleep(SE_SPAWN_POLL_MS);
      }
      if (exitCode != null) {
        // 等 stdio 排空（有界）：1s 失败时最后一行 RuntimeError 可能晚于 exit 到达。
        await Promise.race([closePromise, seSleep(SE_STDERR_CLOSE_GRACE_MS)]);
        const text = stderr || stdout;
        const busy = parseStorageRootBusy(text);
        if (busy) {
          const holderAlive = busy.holderPid ? isPidAlive(busy.holderPid) : false;
          throw Object.assign(
            new Error(`storage root already owned by pid ${busy.holderPid ?? 'unknown'}`),
            {
              status: 'storage-root-busy',
              systemId,
              holderPid: busy.holderPid,
              holderAlive,
              root: busy.root,
              lock: busy.lock,
              exitCode,
            }
          );
        }
        throw new Error(
          `SE 进程退出 code=${exitCode}：${text.slice(-600) || '(无输出)'}`
        );
      }
      if (!reg) {
        killProcessTree(child.pid);
        waitForProcessDead(child.pid);
        if (seSpawnedSystems.get(systemId) === entry) seSpawnedSystems.delete(systemId);
        await Promise.race([closePromise, seSleep(SE_STDERR_CLOSE_GRACE_MS)]);
        throw new Error(`SE 就绪超时：${(stderr || stdout).slice(-600) || '(无输出)'}`);
      }
      entry.port = reg.port;
      // ⑤ system.info 校验 system_id / 协议 / 版本 / 直接子进程身份；失配则清理。
      let info;
      try {
        info = await verifySeSystem(systemId, reg.port, token);
        if (info.protocol_version != null && Number(info.protocol_version) !== 1) {
          throw new Error(`SnakeEats wire protocol ${info.protocol_version} 不受支持（支持 1）`);
        }
        if (info.version && runtime.versionRange && !versionSatisfies(info.version, runtime.versionRange)) {
          throw new Error(`SnakeEats 版本 ${info.version} 不在支持区间 ${runtime.versionRange}`);
        }
      } catch (err) {
        killProcessTree(child.pid);
        waitForProcessDead(child.pid);
        if (seSpawnedSystems.get(systemId) === entry) seSpawnedSystems.delete(systemId);
        throw err;
      }
      const listener = info && info.pid
        ? { status: 'found', pid: Number(info.pid), startedAt: info.started_at || null }
        : findListeningProcess(reg.port);
      const listenerPid = listener.status === 'found' ? listener.pid : null;
      const listenerStartedAt = listener.status === 'found' ? listener.startedAt : null;
      if (!listenerPid || !listenerStartedAt) {
        console.warn(
          `[se] owner identity incomplete for ${systemId}: listener=${listener.status}${
            listener.reason ? `/${listener.reason}` : ''
          }`
        );
      }
      writeSeOwner(systemId, {
        pid: child.pid,
        port: reg.port,
        listenerPid,
        listenerStartedAt,
        instanceId: info && info.instance_id,
        startedAt: info && info.started_at,
        mode: runtime.mode,
        version: info && info.version,
        protocolVersion: info && info.protocol_version,
      });
      entry.instanceId = info && info.instance_id;
      entry.mode = runtime.mode;
      entry.version = info && info.version;
      entry.protocolVersion = info && info.protocol_version;
      spawnSucceeded = true;
      return { system_id: systemId, port: reg.port, status: 'online' };
    } finally {
      releaseSpawnLock(lockFile, spawnNonce);
      // create/start 在 Python 起来前失败的占位目录：仍为空才回收（有内容则留给清理器）。
      if (claimOwned && !spawnSucceeded) removeEmptyClaim(systemId);
    }
  })();
  seSpawnInflight.set(systemId, task);
  try {
    return await task;
  } finally {
    seSpawnInflight.delete(systemId);
    activeSpawnNonces.delete(spawnNonce);
  }
}

/** 枚举 se-systems 下各系统的 registry/.registry.json + 逐端口探测。 */
export async function listSeSystems() {
  let names = [];
  try {
    names = fs
      .readdirSync(seSystemsDir, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name);
  } catch (err) {
    return [];
  }
  const results = [];
  for (const name of names) {
    const systemId = sanitizeSeSystemId(name);
    if (!systemId) continue;
    const reg = readSeRegistry(systemId);
    if (!reg) continue;
    results.push({
      system_id: systemId,
      port: reg.port,
      alive: await probeTcp(reg.port),
      source: 'registry',
    });
  }
  results.sort((a, b) => a.system_id.localeCompare(b.system_id));
  return results;
}
