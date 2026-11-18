// 期 1 接线层冒烟：浏览器(ws 客户端) ↔ Vite 代理 ↔ SE 的 JSON-RPC 通路。
//
// 覆盖验证门：
//   1. 经代理 call('system.info') 返回 system_id === 'smoketest'；
//   2. 伪造 Origin 的 WS upgrade 被拒；
//   3. 杀掉 SE → 浏览器侧连接被关闭；重启 SE → 重连后调用恢复可用；
//   4. /api/se/endpoint 不返回 token；
//   5. /api/se/systems 枚举到存活系统。
//
// 自动 spawn 真实 SE（python -m snakeeats serve --port 0 --storage <tmp>）与
// vite；finally 清理全部子进程与临时 storage。
import { spawn, spawnSync } from 'node:child_process';
import { WebSocket } from 'ws';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5197;
const BASE = `http://localhost:${PORT}`;
const SYSTEM_ID = 'smoketest';
const TOKEN = `smk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
import {
  resolveSeRuntimeForTests,
  spawnSe as spawnSeHelper,
  seEnvForTests,
} from './se-test-helper.mjs';
const RUNTIME = await resolveSeRuntimeForTests();
const PYTHON = RUNTIME.ok ? RUNTIME.python : '';
const SE_PACKAGE_PARENT = RUNTIME.ok ? RUNTIME.packageParent : '';
const STORAGE = path.join(ROOT, 'se-systems', SYSTEM_ID);
const REGISTRY = path.join(STORAGE, 'registry', '.registry.json');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 160) : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readRegistryPort() {
  try {
    const parsed = JSON.parse(fs.readFileSync(REGISTRY, 'utf-8'));
    const entry = parsed && typeof parsed === 'object' ? parsed[SYSTEM_ID] : null;
    const port = entry ? Number(entry.port) : NaN;
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch (err) {
    return null;
  }
}

async function waitRegistry(timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const port = readRegistryPort();
    if (port) return port;
    await sleep(300);
  }
  return null;
}

/** 端口是否已有监听（防上一次 vite 残留导致 strictPort 假失败）。 */
function anyListener(port, timeout = 800) {
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

function waitForServer(url, timeout = 25000) {
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

function httpGetJson(pathname) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://localhost:${PORT}${pathname}`, { headers: { 'X-RF-Session': 'smoke-test-session' } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(body) });
          } catch (err) {
            reject(new Error(`bad json from ${pathname}`));
          }
        });
      })
      .on('error', reject);
  });
}

let seStderr = '';
let viteOutput = '';
async function spawnSe() {
  const child = await spawnSeHelper({ runtime: RUNTIME, storage: STORAGE, token: TOKEN, systemId: SYSTEM_ID });
  child.stderr.on('data', (d) => {
    seStderr = (seStderr + String(d)).slice(-2000);
  });
  return child;
}

function killTree(child) {
  if (!child || child.exitCode != null || child.pid == null) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch (err) {
    /* 尽力而为 */
  }
}

function wsUrl() {
  return `ws://localhost:${PORT}/api/se/ws?system_id=${SYSTEM_ID}`;
}

/** 建立一条浏览器侧 ws（可伪造 Origin）；open 前失败即 reject。 */
function openWs({ origin, timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = origin
      ? new WebSocket(wsUrl(), { headers: { Origin: origin, 'X-RF-Session': 'smoke-test-session' } })
      : new WebSocket(wsUrl(), { headers: { 'X-RF-Session': 'smoke-test-session' } });
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch (err) {
        /* 忽略 */
      }
      reject(new Error('ws open timeout'));
    }, timeout);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      reject(new Error(`unexpected response ${res.statusCode}`));
    });
  });
}

/** 在一条已开 ws 上发单次 JSON-RPC 调用并等响应。 */
function rpc(ws, method, params = {}, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timeout`)), timeout);
    const onMessage = (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (err) {
        return;
      }
      if (!msg || msg.id !== 1) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      if (msg.error) reject(new Error(msg.error.message || 'rpc error'));
      else resolve(msg.result);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }));
  });
}

function closedWithin(ws, ms) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    ws.once('close', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

let se = null;
let vite = null;
let probe = null;

try {
  fs.rmSync(STORAGE, { recursive: true, force: true });

  // ── 起 SE ────────────────────────────────────────────────────────────────
  se = await spawnSe();
  const sePort = await waitRegistry();
  check('SE 启动并落盘 registry', !!sePort, sePort ? `port=${sePort}` : seStderr);
  if (!sePort) throw new Error('SE 未就绪，后续用例跳过');

  // ── 起 vite（带 attach token）────────────────────────────────────────────
  // 直接用 node 跑 vite bin（不经 npx.cmd/shell），pid 即真实进程 → 清理可靠。
  if (await anyListener(PORT)) {
    throw new Error(`端口 ${PORT} 已被占用（上次 vite 残留？先清理再跑）`);
  }
  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  vite = spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...await seEnvForTests(), RF_ALLOW_INSECURE_TEST: '0', SNAKEEATS_ADMIN_TOKEN: TOKEN, SNAKEEATS_SYSTEM_ID: SYSTEM_ID },
  });
  vite.stdout.on('data', (d) => {
    viteOutput = (viteOutput + String(d)).slice(-3000);
  });
  vite.stderr.on('data', (d) => {
    viteOutput = (viteOutput + String(d)).slice(-3000);
  });
  try {
    await waitForServer(BASE);
  } catch (err) {
    throw new Error(`${err.message}\n[vite]\n${viteOutput}`);
  }
  check('vite 启动', true);

  // ── 5. /api/se/systems + endpoint（不返回 token）─────────────────────────
  const systems = await httpGetJson('/api/se/systems');
  const hit = Array.isArray(systems.data)
    ? systems.data.find((s) => s && s.system_id === SYSTEM_ID && s.alive)
    : null;
  check('/api/se/systems 枚举到存活系统', !!hit, JSON.stringify(systems.data).slice(0, 140));

  const endpoint = await httpGetJson(`/api/se/endpoint?system_id=${SYSTEM_ID}`);
  check('/api/se/endpoint 状态 online', endpoint.data && endpoint.data.status === 'online', JSON.stringify(endpoint.data));
  check('/api/se/endpoint 不返回 token', !(endpoint.data && 'token' in endpoint.data));

  // ── 2. 伪造 Origin 被拒 ──────────────────────────────────────────────────
  let forgedRejected = false;
  try {
    const bad = await openWs({ origin: 'http://evil.example' });
    bad.close();
  } catch (err) {
    forgedRejected = true;
  }
  check('伪造 Origin 的 WS 连接被拒', forgedRejected);

  // ── 1. 经代理 system.info ────────────────────────────────────────────────
  probe = await openWs();
  const info = await rpc(probe, 'system.info');
  check('经代理 system.info 返回 system_id', info && info.system_id === SYSTEM_ID, JSON.stringify(info));

  // ── 3. 杀 SE → 浏览器侧连接被关闭 ────────────────────────────────────────
  killTree(se);
  const closed = await closedWithin(probe, 10000);
  check('杀 SE 后浏览器侧连接被关闭', closed);

  // ── 3b. 重启 SE → 重连 + system.info 恢复 ─────────────────────────────────
  se = await spawnSe();
  const restartPort = await waitRegistry();
  check('SE 重启落盘 registry', !!restartPort, restartPort ? `port=${restartPort}` : seStderr);

  let recovered = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    try {
      const ws = await openWs({ timeout: 5000 });
      const res = await rpc(ws, 'system.info', {}, 5000);
      ws.close();
      if (res && res.system_id === SYSTEM_ID) {
        recovered = res;
        break;
      }
    } catch (err) {
      /* SE 或 registry 尚未就绪：重试 */
    }
    await sleep(500);
  }
  check('重启 SE 后重连 + system.info 恢复', !!recovered, recovered ? JSON.stringify(recovered) : 'timeout');
} catch (err) {
  check('冒烟执行', false, String((err && err.stack) || err));
} finally {
  try {
    if (probe && probe.readyState === WebSocket.OPEN) probe.close();
  } catch (err) {
    /* 忽略 */
  }
  killTree(se);
  killTree(vite);
  await sleep(1200);
  // 临时 storage 清理（含 registry / journal / snapshots）；父目录空了也一并移除
  // （期 2 才把 se-systems/ 加进 .gitignore，期 1 不残留）。
  fs.rmSync(STORAGE, { recursive: true, force: true });
  try {
    const parent = path.join(ROOT, 'se-systems');
    if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
  } catch (err) {
    /* 忽略 */
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
