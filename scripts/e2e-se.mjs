// 期 9 交付物 D5 —— SE 端到端测试（真实 snakeeats 实例 + Vite dev server）。
//
// 覆盖（严格按序）：
//   1. 生命周期 API：新 id endpoint=offline → POST spawn=200 online+port>0 → systems 含 alive
//      → 重复 spawn=200 online（registry 端口不变，不双 spawn）；
//   2. HTTP 白名单：伪造 Origin → 403；非法 system_id（..%2Fbad）→ 400；
//   3. WS 握手：浏览器侧「不送 auth 帧」，经代理 system.info 直接返回正确 system_id
//      （证明 Node 代理代发 auth、token 不出 Node 进程）；
//   4. WS 关闭码：未注册系统（se gone）与 token 不可用系统各自以 4401/1011 关闭，
//      有界超时断言「不挂起」；
//   5. 收尾：finally 关 WS → 杀带外 SE → closeViteGracefully(vite)（taskkill /T 连带托管 SE）
//      → 按 storage 兜底杀 python → cleanupSeStorage → pythonProcesses() 断言无 se-systems 孤儿。
//   另有 150s 看门狗：超时强清 vite/SE/storage 并 exit 2，脚本永不无限挂起。
//
// 端口：5299（strictPort；先 anyListener 预检，占用即快速失败，不碰 5199）。
// SE 可用性：se-preflight 判定；不可用打印 SKIP 并 exit 0（--require 或 SE_REQUIRE=1 时 exit 1）。
//
// ⚠ OneDrive 环境隐患（本仓库位于 OneDrive 同步区）：
//   对非 ASCII 文件名调用 fs.rmSync 可能令 Node 以 0xC0000409 崩溃并遗留孤儿进程；
//   故本脚本 system_id / storage 目录名一律 ASCII，删除只走 helper 的 cleanupSeStorage
//   （EPERM 重试 + cmd rmdir 兜底），绝不自行对 CJK 路径调用 fs.rmSync。
import { execFileSync, spawnSync } from 'node:child_process';
import { WebSocket } from 'ws';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { preflight } from './se-preflight.mjs';
import {
  ROOT,
  SE_SYSTEMS_DIR,
  resolveSeRuntimeForTests,
  spawnSe,
  readRegistryPort,
  waitRegistryPort,
  killTree,
  connectSeRpc,
  connectSeDirect,
  spawnViteSe,
  waitForServer,
  anyListener,
  cleanupSeStorage,
  closeViteGracefully,
  pythonProcesses,
} from './se-test-helper.mjs';

const RUNTIME = await resolveSeRuntimeForTests();

const PORT = 5299;
const BASE = `http://localhost:${PORT}`;
// 全部 id 纯 ASCII（OneDrive rmSync 隐患；见头注）。
const TS = Date.now().toString(36);
const SYSTEM_ID = `e2e9-main-${TS}`;
const GHOST_ID = `e2e9-ghost-${TS}`; // 无 registry：验证 se gone → 1011
const UNAUTH_ID = `e2e9-unauth-${TS}`; // 带外 SE，token 未知于代理：验证 4401
const TOKEN = `e2e9-tok-${TS}-${Math.random().toString(36).slice(2)}`;
const TOKEN_MANUAL = `e2e9-man-${TS}-${Math.random().toString(36).slice(2)}`;
const STORAGE_IDS = [SYSTEM_ID, GHOST_ID, UNAUTH_ID];
const WATCHDOG_MS = 150000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 220) : ''}`);
};

// ── 预检：无真实 SE 时 SKIP；--require / SE_REQUIRE=1 时按失败退出 ────────────
const pf = await preflight();
if (!pf.available) {
  const strict = process.argv.includes('--require') || process.env.SE_REQUIRE === '1';
  console.log(`SKIP: SE unavailable (${pf.reason})`);
  process.exit(strict ? 1 : 0);
}
console.log(`SE preflight: AVAILABLE — ${pf.reason}`);
console.log(`  python:        ${RUNTIME.ok ? RUNTIME.python : ''}`);
console.log(`  packageParent: ${RUNTIME.ok ? RUNTIME.packageParent : ''}`);
console.log(`  root:          ${ROOT}`);

// ── 有界 HTTP / WS 工具（只发原始请求，不借 helper 的正向 RPC 封装）───────────
function httpJson(method, pathname, body = null, headers = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const finalHeaders = { 'X-RF-Session': 'smoke-test-session', ...headers };
    if (payload != null) {
      finalHeaders['Content-Type'] = 'application/json';
      finalHeaders['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(
      { host: 'localhost', port: PORT, path: pathname, method, headers: finalHeaders },
      (res) => {
        let raw = '';
        res.setEncoding('utf-8');
        res.on('data', (c) => {
          raw += c;
        });
        res.on('end', () => {
          clearTimeout(timer);
          let data = null;
          try {
            data = raw ? JSON.parse(raw) : null;
          } catch (err) {
            data = null;
          }
          resolve({ status: res.statusCode, data, raw });
        });
      }
    );
    const timer = setTimeout(() => {
      req.destroy(new Error(`HTTP ${method} ${pathname} timeout`));
    }, timeoutMs);
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    if (payload != null) req.write(payload);
    req.end();
  });
}
const httpGet = (p, h) => httpJson('GET', p, null, h);
const httpPost = (p, b) => httpJson('POST', p, b);

/** 打开经代理的 ws（成功 upgrade 即 resolve；不发送任何帧）。 */
function openProxyWs(systemId, { timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/api/se/ws?system_id=${encodeURIComponent(systemId)}`, {
      headers: { 'X-RF-Session': 'smoke-test-session' },
    });
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch (err) {
        /* 忽略 */
      }
      reject(new Error('ws open timeout'));
    }, timeout);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ws.once('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      reject(new Error(`unexpected response ${res.statusCode}`));
    });
  });
}

/** 等待 ws 关闭并返回 close code；超时 terminate 并返回 null（断言不挂起）。 */
function waitCloseCode(ws, timeoutMs = 10000) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve(typeof ws._closeCode === 'number' ? ws._closeCode : null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch (err) {
        /* 忽略 */
      }
      resolve(null);
    }, timeoutMs);
    ws.once('close', (code) => {
      clearTimeout(timer);
      resolve(typeof code === 'number' ? code : null);
    });
  });
}

/** 兜底：按 storage id 找 python 进程并 taskkill /T /F（vite 意外死时防孤儿）。 */
function killPythonByStorage(id) {
  let pids = [];
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -like '*${id}*' } | ForEach-Object { $_.ProcessId }`,
        ],
        { encoding: 'utf-8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 }
      );
      pids = String(out)
        .split(/\r?\n/)
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isInteger(n) && n > 0);
    } else {
      const out = execFileSync('ps', ['-eo', 'pid=,args='], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 20000,
      });
      for (const line of String(out).split(/\r?\n/)) {
        if (!/python/i.test(line) || !line.includes(id)) continue;
        const match = line.trim().match(/^(\d+)\s+/);
        if (match) pids.push(Number(match[1]));
      }
    }
  } catch (err) {
    return [];
  }
  for (const pid of pids) {
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 15000,
        });
      } else {
        process.kill(pid, 'SIGTERM');
      }
    } catch (err) {
      /* 已退出或权限不足：尽力而为 */
    }
  }
  return pids;
}

/**
 * spawn 前清锁（方案 §G-7「spawn 前清锁」的 e2e 落实）：
 * vite 的 releaseSpawnLock 用 fs.rmSync(lockFile,{force:true})，但本机 Node v24.12.0
 * 的 fs.rmSync 对「文件」是静默 no-op（不抛错也不删除，unlinkSync 正常），导致成功
 * spawn 后 .spawn.lock 残留。本脚本不修改 vite.config.js，按方案在测试侧于 spawn 前清残留锁。
 */
function clearStaleSpawnLock(id) {
  const dir = path.join(SE_SYSTEMS_DIR, id);
  let cleared = 0;
  for (const name of ['.spawn.lock', '.snakeeats.lock']) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    try {
      fs.unlinkSync(file);
      cleared += 1;
    } catch (err) {
      console.warn(`清理 ${id}/${name} 失败（忽略）: ${(err && err.message) || err}`);
    }
  }
  if (cleared > 0) {
    console.log(
      `WARN  清理残留锁文件 ${cleared} 个（${id}）：本机 Node v${process.versions.node} 的 fs.rmSync 对文件静默 no-op，` +
        'vite releaseSpawnLock 删不掉；e2e 按方案 G-7 于 spawn 前清锁（未改 vite.config.js）'
    );
  }
  return cleared;
}

// ── 看门狗 / 信号：任何情况下都不留孤儿、不无限挂起 ─────────────────────────
let vite = null;
let manualSe = null;
let rpcClient = null;

function emergencyCleanup(exitCode, why) {
  console.error(why);
  try {
    if (rpcClient) rpcClient.close();
  } catch (err) {
    /* 忽略 */
  }
  killTree(manualSe);
  killTree(vite);
  for (const id of STORAGE_IDS) killPythonByStorage(id);
  for (const id of STORAGE_IDS) {
    try {
      fs.rmSync(path.join(SE_SYSTEMS_DIR, id), { recursive: true, force: true });
    } catch (err) {
      /* 忽略 */
    }
  }
  process.exit(exitCode);
}

const watchdog = setTimeout(() => {
  emergencyCleanup(2, `WATCHDOG: e2e-se 超过 ${WATCHDOG_MS / 1000}s 未完成，强制清理后退出 2`);
}, WATCHDOG_MS);
process.once('SIGINT', () => emergencyCleanup(130, 'SIGINT: 强制清理后退出 130'));
process.once('SIGTERM', () => emergencyCleanup(143, 'SIGTERM: 强制清理后退出 143'));

try {
  // 开跑前清本测试 storage（ASCII id；删除只走 helper）。
  for (const id of STORAGE_IDS) await cleanupSeStorage({ id });

  // ── 0. 端口预检 + 起 vite ────────────────────────────────────────────────
  if (await anyListener(PORT)) {
    check(`端口 ${PORT} 空闲`, false, '已被占用（上一次 vite 残留？先清理再跑）');
    throw new Error(`端口 ${PORT} 已被占用`);
  }
  check(`端口 ${PORT} 空闲`, true);

  vite = await spawnViteSe({ port: PORT, systemId: SYSTEM_ID, token: TOKEN, allowInsecureTest: false });
  try {
    await waitForServer(BASE, 30000);
  } catch (err) {
    throw new Error(`${err.message}\n[vite]\n${vite.getOutput()}`);
  }
  check('vite 启动于 5299', true);

  // ── 1. 生命周期 API ──────────────────────────────────────────────────────
  const ep0 = await httpGet(`/api/se/endpoint?system_id=${SYSTEM_ID}`);
  check(
    '(1) 新 system_id endpoint = offline',
    ep0.status === 200 && ep0.data && ep0.data.status === 'offline' && ep0.data.alive === false,
    JSON.stringify(ep0.data)
  );
  check('(1) endpoint 绝不返回 token', !(ep0.data && 'token' in ep0.data));

  clearStaleSpawnLock(SYSTEM_ID);
  const sp1 = await httpPost('/api/se/spawn', { system_id: SYSTEM_ID });
  const spawnPort = sp1.data && Number(sp1.data.port);
  check(
    '(1) POST /api/se/spawn = 200 online + port>0',
    sp1.status === 200 &&
      sp1.data &&
      sp1.data.status === 'online' &&
      Number.isInteger(spawnPort) &&
      spawnPort > 0,
    JSON.stringify(sp1.data)
  );
  if (!Number.isInteger(spawnPort) || spawnPort <= 0) throw new Error('spawn 未返回端口，后续用例跳过');

  const systems1 = await httpGet('/api/se/systems');
  const hit = Array.isArray(systems1.data)
    ? systems1.data.find((s) => s && s.system_id === SYSTEM_ID && s.alive === true)
    : null;
  check('(1) /api/se/systems 含该 id 且 alive', !!hit, JSON.stringify(systems1.data).slice(0, 180));

  const ep1 = await httpGet(`/api/se/endpoint?system_id=${SYSTEM_ID}`);
  check(
    '(1) spawn 后 endpoint = online 且端口一致',
    ep1.data && ep1.data.status === 'online' && ep1.data.port === spawnPort,
    JSON.stringify(ep1.data)
  );

  const sp2 = await httpPost('/api/se/spawn', { system_id: SYSTEM_ID });
  await sleep(600);
  const regPort = readRegistryPort({ id: SYSTEM_ID });
  check(
    '(1) 重复 spawn = 200 online（不双 spawn）',
    sp2.status === 200 &&
      sp2.data &&
      sp2.data.status === 'online' &&
      Number(sp2.data.port) === spawnPort &&
      regPort === spawnPort,
    `resp=${JSON.stringify(sp2.data)} registry=${regPort}`
  );

  // ── 2. HTTP 白名单 / 非法 system_id ──────────────────────────────────────
  const evil = await httpGet('/api/se/systems', { Origin: 'http://evil.example' });
  check('(2) 伪造 Origin → 403', evil.status === 403, `status=${evil.status} body=${String(evil.raw || '').slice(0, 80)}`);

  const badId = await httpGet('/api/se/endpoint?system_id=..%2Fbad');
  check('(2) 非法 system_id (..%2Fbad) → 400', badId.status === 400, `status=${badId.status} body=${String(badId.raw || '').slice(0, 80)}`);

  // ── 3. WS 握手：浏览器不送 auth 帧，代理代发 ──────────────────────────────
  rpcClient = await connectSeRpc({ vitePort: PORT, systemId: SYSTEM_ID, timeout: 8000 });
  const info = await rpcClient.call('system.info');
  check(
    '(3) 不送 auth 帧经代理 system.info 返回正确 system_id',
    !!(info && info.system_id === SYSTEM_ID),
    JSON.stringify(info)
  );
  rpcClient.close();
  rpcClient = null;

  // ── 4a. WS 关闭码：未注册系统（se gone）→ 1011 / 4401 ────────────────────
  let ghostCode = null;
  try {
    const ghostWs = await openProxyWs(GHOST_ID);
    ghostCode = await waitCloseCode(ghostWs, 10000);
  } catch (err) {
    ghostCode = `open-error: ${(err && err.message) || err}`;
  }
  check(
    '(4a) 未注册系统的代理 WS 以 1011/4401 关闭（非挂起）',
    ghostCode === 1011 || ghostCode === 4401,
    `close code=${ghostCode}`
  );

  // ── 4b. WS 关闭码：token 不可用（带外 SE 的 token 不在代理内存）→ 4401 ───
  manualSe = await spawnSe({ id: UNAUTH_ID, token: TOKEN_MANUAL });
  const manualPort = await waitRegistryPort({ id: UNAUTH_ID, timeoutMs: 25000 });
  check(
    '(4b) 带外 SE 启动并落盘 registry',
    !!manualPort,
    manualPort ? `port=${manualPort}` : String(manualSe.getStderr() || '').slice(-160)
  );
  if (manualPort) {
    let directOk = false;
    try {
      const direct = await connectSeDirect({ port: manualPort, token: TOKEN_MANUAL, timeout: 8000 });
      const dInfo = await direct.call('system.info');
      directOk = !!(dInfo && dInfo.system_id === UNAUTH_ID);
      direct.close();
    } catch (err) {
      directOk = false;
    }
    check('(4b) 带外 SE 本身可用（直连 auth + system.info）', directOk);

    let manualCode = null;
    try {
      const ws = await openProxyWs(UNAUTH_ID);
      manualCode = await waitCloseCode(ws, 10000);
    } catch (err) {
      manualCode = `open-error: ${(err && err.message) || err}`;
    }
    check(
      '(4b) token 不可用的代理 WS 以 4401/1011 关闭（非挂起）',
      manualCode === 4401 || manualCode === 1011,
      `close code=${manualCode}`
    );
  }
} catch (err) {
  check('e2e-se 执行', false, String((err && err.stack) || err));
} finally {
  // ── 5. 收尾：关 WS → 杀带外 SE → 优雅关 vite → 兜底杀 python → 清 storage ──
  try {
    if (rpcClient) rpcClient.close();
  } catch (err) {
    /* 忽略 */
  }
  rpcClient = null;

  killTree(manualSe);
  manualSe = null;

  // helper：无 IPC 通道时退化为 taskkill /T /F（连带 vite 托管的 SE 整棵树）。
  try {
    await closeViteGracefully(vite);
  } catch (err) {
    /* 忽略 */
  }
  vite = null;

  let viteClosed = false;
  const tQuiet = Date.now();
  while (Date.now() - tQuiet < 8000) {
    if (!(await anyListener(PORT))) {
      viteClosed = true;
      break;
    }
    await sleep(300);
  }
  check('(5) vite 已关闭（5299 无监听）', viteClosed);

  // 兜底：vite 意外先死时，按 storage 找到并杀掉残留 python。
  for (const id of STORAGE_IDS) killPythonByStorage(id);

  // 清 storage（helper：EPERM 重试 + cmd rmdir 兜底；ASCII id）。
  for (const id of STORAGE_IDS) await cleanupSeStorage({ id });

  // 孤儿核对：轮询至多 12s。硬断言只看「本测试三个 storage 目录」的指令行，
  // 避免并发跑其它 smoke（各自的 SE 合法存活）时误判；其余 se-systems 引用仅 INFO。
  const ourDirs = STORAGE_IDS.map((id) => path.join(SE_SYSTEMS_DIR, id));
  let orphans = [];
  const tOrphan = Date.now();
  while (Date.now() - tOrphan < 12000) {
    orphans = (await pythonProcesses()).filter((cmd) => ourDirs.some((d) => cmd.includes(d)));
    if (orphans.length === 0) break;
    await sleep(600);
  }
  check(
    '(5) pythonProcesses 无本测试 storage 孤儿',
    orphans.length === 0,
    orphans.map((c) => String(c).slice(-120)).join(' || ')
  );
  const foreign = (await pythonProcesses()).filter(
    (cmd) => cmd.includes(SE_SYSTEMS_DIR) && !ourDirs.some((d) => cmd.includes(d))
  );
  if (foreign.length) {
    console.log(`INFO 其它 se-systems 实例（非本测试，不判定）: ${foreign.map((c) => String(c).slice(-100)).join(' || ')}`);
  }

  const left = STORAGE_IDS.filter((id) => fs.existsSync(path.join(SE_SYSTEMS_DIR, id)));
  check('(5) storage 已清理无残留（ASCII id）', left.length === 0, left.join(','));
}

clearTimeout(watchdog);
const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
