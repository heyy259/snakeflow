// 期 9（Phase 9）SE 集成测试共享基建。
//
// 从既有 smoke-se-*.mjs 中抽取的「起真实 snakeeats SE + 连 RPC / 起 vite / 清理」工具集合，
// 仅供期 9 新增测试 import 使用；既有 5 个 smoke 脚本保持原样，不被本模块替代或修改。
//
// 设计约束：
//   - import 本模块除「解析 runtime」外无副作用，spawn / 杀进程全部由调用方显式触发；
//   - python 解释器 / SE 包父目录 / spawn 规格统一来自 shared（env → config → auto 单一链路），
//     与 server 使用同一 descriptor 与 spawn spec，避免 cwd/PYTHONPATH/encoding 再次漂移；
//   - Windows 路径含空格 / 中日韩字符，python spawn 一律 shell:false。
//
// 忠实复刻的来源：
//   - smoke-se.mjs            spawnSe(117-139)、killTree(141-148)、readRegistryPort(39-48)、
//                             waitRegistry(50-58)、anyListener(61-77)、waitForServer(79-95)、
//                             vite spawn(232-243)
//   - smoke-se-lifecycle.mjs  closeViteGracefully(152-179)、pythonProcesses(214-233)、
//                             storage EPERM 重试清理(535-549)
//   - smoke-se-edges.mjs      connectSeDirect(290-337)、connectSeRpc(340+)
import { execFile, spawn, spawnSync } from 'node:child_process';
import { WebSocket } from 'ws';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSeRuntime } from '../server/se/runtime/seRuntime.js';
import { buildSeSpawnSpec } from '../server/se/runtime/seSpawnSpec.js';
import { removeRecursiveWithRetry } from '../server/resilientFs.js';

/** 仓库根（scripts/ 的上一级）。 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** SE 临时 storage 根：<ROOT>/se-systems/<id>/。 */
export const SE_SYSTEMS_DIR = path.join(ROOT, 'se-systems');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 测试用 runtime descriptor：与 server 同一解析链（env → config → auto probe）。 */
export async function resolveSeRuntimeForTests() {
  return resolveSeRuntime({ projectRoot: ROOT });
}

/** 兼容包装：仅返回 python（不可用时 ''）。新代码请直接用 descriptor。 */
export async function resolvePython() {
  const rt = await resolveSeRuntimeForTests();
  return rt.ok ? rt.python : '';
}

/** 兼容包装：仅返回包父目录（不可用时 ''）。新代码请直接用 descriptor。 */
export async function resolvePackageParent() {
  const rt = await resolveSeRuntimeForTests();
  return rt.ok ? rt.packageParent : '';
}

/** 起 vite 子进程必须携带的 SE env：仅 descriptor 可用时注入 SE_PYTHON / SE_PACKAGE_PATH。 */
export async function seEnvForTests() {
  const rt = await resolveSeRuntimeForTests();
  return {
    ...process.env,
    RF_ALLOW_INSECURE_TEST: '1',
    RF_SESSION_SECRET: 'smoke-test-session',
    ...(rt.ok ? { SE_PYTHON: rt.python, SE_PACKAGE_PATH: rt.packageParent } : {}),
  };
}

/**
 * 起一个真实 SE：python -u -m snakeeats serve --port 0 --storage <storage> [--manifest <path>]。
 * 规格（cwd / PYTHONPATH / encoding / argv）统一由 shared/seSpawnSpec 生成；身份与 token 只走 env。
 * stderr 留尾部用于诊断，通过 child.getStderr() / child._stderrTail 读取。
 * manifest 为非空字符串时追加 --manifest（不改动省略 manifest 的既有调用行为）。
 * 传入 runtime 可复用一次解析结果，避免每个 smoke 脚本重复 probe。
 */
export async function spawnSe({ id, token, storage, systemId, manifest, runtime } = {}) {
  const sid = systemId != null ? systemId : id;
  const rt = runtime || (await resolveSeRuntimeForTests());
  if (!rt.ok) throw new Error(rt.reason);
  const storageDir = storage || path.join(SE_SYSTEMS_DIR, id);
  const spec = buildSeSpawnSpec(rt, { storageDir, systemId: sid, token });
  if (typeof manifest === 'string' && manifest) spec.args.push('--manifest', manifest);

  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: spec.stdio,
    windowsHide: spec.windowsHide,
  });
  let stderrTail = '';
  // stdout/stderr 并行 drain（防 Windows stdio 死锁）；stderr 留尾部用于诊断。
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => {
    stderrTail = (stderrTail + String(d)).slice(-2000);
  });
  child.getStderr = () => stderrTail;
  Object.defineProperty(child, '_stderrTail', {
    configurable: true,
    enumerable: false,
    get: () => stderrTail,
  });
  return child;
}

/** 读 <SE_SYSTEMS_DIR>/<id>/registry/.registry.json → entry[id].port；不可读/非法返回 null。 */
export function readRegistryPort({ id } = {}) {
  try {
    const file = path.join(SE_SYSTEMS_DIR, id, 'registry', '.registry.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const entry = parsed && typeof parsed === 'object' ? parsed[id] : null;
    const port = entry ? Number(entry.port) : NaN;
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch (err) {
    return null;
  }
}

/** 轮询 registry 直到端口落盘，超时返回 null。 */
export async function waitRegistryPort({ id, timeoutMs = 25000, intervalMs = 300 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const port = readRegistryPort({ id });
    if (port) return port;
    await sleep(intervalMs);
  }
  return null;
}

/**
 * 读 <SE_SYSTEMS_DIR>/<id>/registry/.registry.json → 第一个合法 port（不限定 entry key）。
 * 用于 --manifest 场景：SE 可能以 manifest 的 id 注册，而非 env 的 system id；
 * 不可读 / 无任何合法 port 时返回 null。
 */
export function readRegistryAnyPort({ id } = {}) {
  try {
    const file = path.join(SE_SYSTEMS_DIR, id, 'registry', '.registry.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return null;
    for (const entry of Object.values(parsed)) {
      const port = entry ? Number(entry.port) : NaN;
      if (Number.isInteger(port) && port > 0) return port;
    }
    return null;
  } catch (err) {
    return null;
  }
}

/** 轮询 registry 中任意 entry 的端口，超时返回 null。 */
export async function waitRegistryAnyPort({ id, timeoutMs = 25000, intervalMs = 300 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const port = readRegistryAnyPort({ id });
    if (port) return port;
    await sleep(intervalMs);
  }
  return null;
}

/**
 * 每 tick 先查 id-keyed entry，未命中再查任意 entry；超时返回 null。
 * 选择（id vs 任意）仍由调用方决定，本函数只是便捷组合。
 */
export async function waitRegistryPortOrAny({ id, timeoutMs = 25000, intervalMs = 300 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const port = readRegistryPort({ id }) || readRegistryAnyPort({ id });
    if (port) return port;
    await sleep(intervalMs);
  }
  return null;
}

/** 杀整棵进程树（Windows taskkill /T /F）；尽力而为，绝不抛出。 */
export function killTree(child) {
  if (!child || child.exitCode != null || child.pid == null) return;
  try {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch (err) {
    /* 尽力而为 */
  }
}

/** 端口是否已有监听（防上一次 vite 残留导致 strictPort 假失败）。 */
export function anyListener(port, timeout = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: 'localhost', port });
    let settled = false;
    const done = (listening) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** HTTP 轮询直到 url 可访问（vite 就绪）；超时 reject。 */
export function waitForServer(url, timeout = 25000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      http
        .get(url, (res) => {
          res.resume();
          resolve();
        })
        .on('error', () => {
          if (Date.now() - t0 > timeout) reject(new Error('vite server timeout'));
          else setTimeout(tick, 400);
        });
    };
    tick();
  });
}

/**
 * 起 vite（直接用 node 跑 vite bin，不经 npx.cmd/shell，pid 即真实进程 → 清理可靠）。
 * env 注入 SE_PYTHON / SE_PACKAGE_PATH（仅 runtime 可用时；不可用由 preflight 门禁跳过）
 * 与 attach 用 token / system id；输出留尾部，通过 child.getOutput() 读取。
 */
export async function spawnViteSe({ port, systemId, token, allowInsecureTest = true } = {}) {
  const env = await seEnvForTests();
  if (!allowInsecureTest) env.RF_ALLOW_INSECURE_TEST = '0';
  if (token != null) env.SNAKEEATS_ADMIN_TOKEN = token;
  else delete env.SNAKEEATS_ADMIN_TOKEN;
  if (systemId != null) env.SNAKEEATS_SYSTEM_ID = systemId;
  else delete env.SNAKEEATS_SYSTEM_ID;

  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(process.execPath, [viteBin, '--port', String(port), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  let outputTail = '';
  const drain = (d) => {
    outputTail = (outputTail + String(d)).slice(-3000);
  };
  child.stdout.on('data', drain);
  child.stderr.on('data', drain);
  child.getOutput = () => outputTail;
  return child;
}

/**
 * 在一条已开 ws 上构造 JSON-RPC 客户端：id 自增，按 id 匹配响应，
 * notification 忽略；错误带 code/data；close() 关闭底层 ws。
 */
function makeRpcClient(ws, defaultTimeout = 8000) {
  let nextId = 1;
  const pending = new Map();
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      return;
    }
    if (!msg || msg.id == null || !pending.has(msg.id)) return;
    const { res, rej, timer } = pending.get(msg.id);
    pending.delete(msg.id);
    clearTimeout(timer);
    if (msg.error) {
      const e = new Error(msg.error.message || 'rpc error');
      e.code = msg.error.code;
      if (msg.error.data) e.data = msg.error.data;
      rej(e);
    } else {
      res(msg.result);
    }
  });
  const call = (method, params = {}, timeoutMs = defaultTimeout) =>
    new Promise((res, rej) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        rej(new Error(`${method} timeout`));
      }, timeoutMs);
      pending.set(id, { res, rej, timer });
      ws.send(JSON.stringify({ jsonrpc: '2.0', method, params, id }));
    });
  const close = () => {
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    } catch (err) {
      /* 忽略 */
    }
  };
  return { ws, call, rpc: call, close };
}

/** 经 vite 代理的 SE RPC：ws://localhost:<vitePort>/api/se/ws?system_id=<systemId>。 */
export async function connectSeRpc({ vitePort, systemId, timeout = 8000 } = {}) {
  const sessionResponse = await fetch(`http://localhost:${vitePort}/api/session`);
  if (!sessionResponse.ok) throw new Error(`session bootstrap failed: HTTP ${sessionResponse.status}`);
  const sessionData = await sessionResponse.json();
  const session = String(sessionData.session || '');
  return new Promise((resolve, reject) => {
    const url = `ws://localhost:${vitePort}/api/se/ws?system_id=${encodeURIComponent(systemId)}`;
    const ws = new WebSocket(url, { headers: { 'X-RF-Session': session } });
    const openTimer = setTimeout(() => {
      try {
        ws.terminate();
      } catch (err) {
        /* 忽略 */
      }
      reject(new Error('se rpc ws open timeout'));
    }, 10000);
    ws.on('open', () => {
      clearTimeout(openTimer);
      resolve(makeRpcClient(ws, timeout));
    });
    ws.on('error', (err) => {
      clearTimeout(openTimer);
      reject(err);
    });
  });
}

/** 直连 SE（ws://127.0.0.1:<port>），open 后先发 auth 帧并等 result.status==='ok'。 */
export function connectSeDirect({ port, token, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const openTimer = setTimeout(() => {
      try {
        ws.terminate();
      } catch (err) {
        /* 忽略 */
      }
      reject(new Error('se direct open timeout'));
    }, 10000);
    ws.on('open', () => {
      clearTimeout(openTimer);
      const client = makeRpcClient(ws, timeout);
      // 首帧固定为 id=1 的 auth（客户端 nextId 从 1 开始）。
      client
        .call('auth', { token })
        .then((auth) => {
          if (!auth || auth.status !== 'ok') {
            client.close();
            reject(new Error(`se auth failed: ${JSON.stringify(auth)}`));
            return;
          }
          resolve(client);
        })
        .catch((err) => {
          client.close();
          reject(err);
        });
    });
    ws.on('error', (err) => {
      clearTimeout(openTimer);
      reject(err);
    });
  });
}

/**
 * 清理 SE storage：Windows 下被强杀的 SE 可能仍短暂持有目录句柄（EPERM），
 * 重试 retries 轮；成功后若 se-systems/ 已空则一并移除。
 * 删除委托 server/resilientFs.js 唯一安全原语，绝不直接 fs.rmSync（OneDrive 下会静默留残/崩溃）。
 */
export async function cleanupSeStorage({ id, retries = 8, delayMs = 500 } = {}) {
  const dir = path.join(SE_SYSTEMS_DIR, id);
  let removed = false;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    removed = removeRecursiveWithRetry(dir, { recursive: true, bestEffort: true, tries: 1, cmdFallback: true });
    if (removed) break;
    if (attempt < retries - 1) await sleep(delayMs);
  }
  if (!removed) console.warn(`清理 ${id} storage 未删净（忽略）: ${dir}`);
  try {
    if (fs.existsSync(SE_SYSTEMS_DIR) && fs.readdirSync(SE_SYSTEMS_DIR).length === 0) {
      fs.rmdirSync(SE_SYSTEMS_DIR);
    }
  } catch (err) {
    /* se-systems 根删除失败不影响调用方 */
  }
}

/**
 * 优雅关闭 vite：有 IPC 通道时 disconnect 触发退出钩子（Windows 上 SIGTERM 是硬杀，
 * 不触发钩子），等 exit 最多 fallbackMs；无 IPC 或超时则 killTree。绝不抛出。
 */
export async function closeViteGracefully(child, fallbackMs = 12000) {
  if (!child || child.exitCode != null) return;
  const hasIpc = !!(child.connected && typeof child.disconnect === 'function');
  if (!hasIpc) {
    killTree(child);
    return;
  }
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish();
    }, fallbackMs);
    child.once('exit', finish);
    try {
      child.disconnect();
    } catch (err) {
      killTree(child);
      finish();
    }
  });
}

/** 枚举 python.exe 的命令行（用于孤儿核对）；PowerShell CIM，失败返回 []。 */
export function pythonProcesses() {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`,
      ],
      { encoding: 'utf-8', windowsHide: true, timeout: 20000 },
      (err, stdout) => {
        if (err) {
          resolve([]);
          return;
        }
        try {
          const parsed = JSON.parse(String(stdout || '[]').trim() || '[]');
          const arr = Array.isArray(parsed) ? parsed : [parsed];
          resolve(arr.filter((x) => x && x.CommandLine).map((x) => String(x.CommandLine)));
        } catch (parseErr) {
          resolve([]);
        }
      }
    );
  });
}
