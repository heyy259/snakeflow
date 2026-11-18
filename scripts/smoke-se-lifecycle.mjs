// 期 2 生命周期冒烟：tab↔system 绑定的 Node 侧全状态机（对应 SE接线方案.md §7-2 验收 a-e，
// 已按需求 A–E 收口改写 (c)：alive-unauthed / attach-token 已取消）。
//
// 覆盖验证门：
//   (a) 无 SE 时 POST /api/se/spawn 一键起系统（life-a），经代理 system.info 通；
//   (b) 脚本自起 SE（life-b, token=T）+ vite 带 SNAKEEATS_ADMIN_TOKEN=T → endpoint online + 代理通（attach 路径）；
//   (c) 脚本自起 SE（life-c）+ 可验证己方 owner → POST /api/se/spawn 按 E2 回收后全新拉起；
//   (d) 关 vite（优雅关闭触发退出钩子）后无 vite spawn 的 python 孤儿（life-a / 回收后的 life-c 消失）；
//   (e) 重启 vite → 重 spawn life-a 同 storage → 先写入的流从快照恢复（stream.list 含该流）；
//   (f) 当前 Vite spawn token 的 /end（E1）；无 owner 的 /end 必须 fail closed，不误杀。
//
// 说明（SE 事实，2026-09-21 核实）：stream.create 的元数据不写 journal，仅随 30s 周期快照落盘；
// 故 (e) 需等待快照窗口（≤45s），随后硬杀/优雅关 vite，重启后从 snapshot 恢复。
//
// 人工起的 life-b 由脚本自行清理；life-a 与（被回收后的）life-c 由 vite 托管，验证退出钩子。
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { WebSocket } from 'ws';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveSeRuntimeForTests,
  spawnSe as spawnSeHelper,
  seEnvForTests,
} from './se-test-helper.mjs';
import { findListeningProcess } from '../server/util.js';
import { cleanupSeSystem } from './se-ui-helper.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5198;
const BASE = `http://localhost:${PORT}`;
const RUNTIME = await resolveSeRuntimeForTests();
const PYTHON = RUNTIME.ok ? RUNTIME.python : '';
const SE_PACKAGE_PARENT = RUNTIME.ok ? RUNTIME.packageParent : '';
const TOKEN_T = `lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const TOKEN_UNKNOWN = `unknown-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 200) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const storageDirOf = (id) => path.join(ROOT, 'se-systems', id);
const registryFileOf = (id) => path.join(storageDirOf(id), 'registry', '.registry.json');

function readRegistryPort(id) {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryFileOf(id), 'utf-8'));
    const entry = parsed && typeof parsed === 'object' ? parsed[id] : null;
    const port = entry ? Number(entry.port) : NaN;
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch (err) {
    return null;
  }
}

function writeVerifiableOwner(id, vitePid = 99999999) {
  const port = readRegistryPort(id);
  const listener = findListeningProcess(port);
  if (listener.status !== 'found' || !listener.startedAt) {
    throw new Error(`无法读取 listener 身份：${id} ${JSON.stringify(listener)}`);
  }
  fs.writeFileSync(
    path.join(storageDirOf(id), '.owner.json'),
    JSON.stringify({
      pid: listener.pid,
      vitePid,
      port,
      listenerPid: listener.pid,
      listenerStartedAt: listener.startedAt,
      at: Date.now(),
    })
  );
  return listener;
}

async function waitRegistry(id, timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const port = readRegistryPort(id);
    if (port) return port;
    await sleep(300);
  }
  return null;
}

function probeTcp(port, timeout = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function anyListener(port, timeout = 800) {
  return probeTcp(port, timeout);
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

function httpJson(method, pathname, body, port = PORT) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(
      { host: 'localhost', port, path: pathname, method, headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch (err) {
            parsed = null;
          }
          resolve({ status: res.statusCode, data: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const httpGetJson = (p, port) => httpJson('GET', p, undefined, port);
const httpPostJson = (p, b, port) => httpJson('POST', p, b, port);

// ── vite / SE 进程 ──────────────────────────────────────────────────────────

let viteOutput = '';
async function spawnVite({ adminToken, port = PORT }) {
  const env = await seEnvForTests();
  if (adminToken) env.SNAKEEATS_ADMIN_TOKEN = adminToken;
  else delete env.SNAKEEATS_ADMIN_TOKEN;
  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(process.execPath, [viteBin, '--port', String(port), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env,
  });
  viteOutput = '';
  const drain = (d) => {
    viteOutput = (viteOutput + String(d)).slice(-4000);
  };
  child.stdout.on('data', drain);
  child.stderr.on('data', drain);
  return child;
}

/** 优雅关闭 vite：IPC disconnect 触发退出钩子（Windows 上 SIGTERM 是硬杀，不触发）。 */
function closeViteGracefully(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode != null) return resolve();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    child.once('exit', finish);
    try {
      child.disconnect();
    } catch (err) {
      try {
        child.kill();
      } catch (e) {
        /* 忽略 */
      }
    }
    setTimeout(() => {
      if (!done) {
        killTree(child);
        finish();
      }
    }, 12000);
  });
}

let seStderr = '';
async function spawnSe(id, token) {
  const child = await spawnSeHelper({ runtime: RUNTIME, id, token, storage: storageDirOf(id) });
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

/** 枚举 python.exe 的命令行（用于孤儿核对）。 */
function pythonProcesses() {
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`,
      ],
      { encoding: 'utf-8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const parsed = JSON.parse(out || '[]');
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr
      .filter((x) => x && x.CommandLine)
      .map((x) => ({ pid: x.ProcessId, cmd: String(x.CommandLine) }));
  } catch (err) {
    return [];
  }
}

// ── WebSocket / JSON-RPC（浏览器侧）─────────────────────────────────────────

function wsUrl(systemId) {
  return `ws://localhost:${PORT}/api/se/ws?system_id=${encodeURIComponent(systemId)}`;
}

function openWs(systemId, { timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(systemId));
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
  });
}

function rpc(ws, method, params = {}, id = 1, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timeout`)), timeout);
    const onMessage = (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (err) {
        return;
      }
      if (!msg || msg.id !== id) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      if (msg.error) reject(new Error(msg.error.message || 'rpc error'));
      else resolve(msg.result);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ jsonrpc: '2.0', method, params, id }));
  });
}

/** 等待 ws 以指定 close code 关闭（代理 token 不可用 = 4401）。 */
function closedWithCode(ws, code, ms) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve(ws._closeCode === code);
      return;
    }
    const timer = setTimeout(() => resolve(false), ms);
    ws.once('close', (c) => {
      clearTimeout(timer);
      resolve(c === code);
    });
  });
}

async function proxySystemInfo(systemId) {
  const ws = await openWs(systemId);
  try {
    return await rpc(ws, 'system.info');
  } finally {
    try {
      ws.close();
    } catch (err) {
      /* 忽略 */
    }
  }
}

/** 轮询快照文件，确认流已落盘（stream.create 元数据仅快照持久化）。 */
async function waitSnapshotHasStream(id, streamName, timeout = 45000) {
  const file = path.join(storageDirOf(id), 'snapshots', id, 'snapshot.json');
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (j && j.streams && j.streams[streamName]) return true;
    } catch (err) {
      /* 尚未生成 */
    }
    await sleep(1000);
  }
  return false;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

let vite1 = null;
let vite2 = null;
let vite3 = null;
let seB = null;
let seC = null;
let seF = null;

try {
  // 清理本测试占用的 storage（不动其它系统）。
  for (const id of ['life-a', 'life-b', 'life-c', 'life-e', 'life-f']) {
    cleanupSeSystem(id);
  }
  if (await anyListener(PORT)) throw new Error(`端口 ${PORT} 已被占用，请先清理`);

  // ══ vite#1：env 带 TOKEN_T（用于 (a) spawn + (b) attach）══════════════════
  vite1 = await spawnVite({ adminToken: TOKEN_T });
  try {
    await waitForServer(BASE);
  } catch (err) {
    throw new Error(`${err.message}\n[vite#1]\n${viteOutput}`);
  }

  // ── (a) 无 SE 一键起 life-a ────────────────────────────────────────────
  const spawnA = await httpPostJson('/api/se/spawn', { system_id: 'life-a' });
  check(
    '(a) POST /api/se/spawn life-a 返回 online',
    spawnA.status === 200 && spawnA.data && spawnA.data.status === 'online',
    JSON.stringify(spawnA.data)
  );
  const infoA = await proxySystemInfo('life-a');
  check('(a) 经代理 system.info life-a 通', infoA && infoA.system_id === 'life-a', JSON.stringify(infoA));
  const portA = readRegistryPort('life-a');
  let ownerA = null;
  try {
    ownerA = JSON.parse(fs.readFileSync(path.join(storageDirOf('life-a'), '.owner.json'), 'utf-8'));
  } catch (err) {
    ownerA = null;
  }
  check(
    '(a) owner 记录 listener PID/启动时间',
    ownerA &&
      Number.isInteger(ownerA.listenerPid) &&
      ownerA.listenerPid > 0 &&
      typeof ownerA.listenerStartedAt === 'string' &&
      ownerA.listenerStartedAt.length > 0,
    JSON.stringify(ownerA)
  );

  // (a2) 写入一条流（供 (e) 恢复验证）；元数据需等快照窗口。
  let wrote = false;
  try {
    const ws = await openWs('life-a');
    await rpc(ws, 'stream.create', {
      name: 'recover_stream',
      description: 'lifecycle gate e',
      tags: { k: 'v' },
    });
    await rpc(ws, 'stream.write', { name: 'recover_stream', text: 'hello-recovered' });
    ws.close();
    wrote = true;
  } catch (err) {
    check('(e-pre) 写入 recover_stream', false, String((err && err.message) || err));
  }
  const snapshotReady = wrote && (await waitSnapshotHasStream('life-a', 'recover_stream', 45000));
  check('(e-pre) recover_stream 随快照落盘（等待 ≤45s）', snapshotReady);

  // ── (b) 手动起 life-b（token=T）+ vite 带 T → attach 路径 ───────────────
  seB = await spawnSe('life-b', TOKEN_T);
  const portB = await waitRegistry('life-b');
  check('(b) 手动 SE life-b 启动并注册', !!portB, portB ? `port=${portB}` : seStderr);
  const epB = await httpGetJson('/api/se/endpoint?system_id=life-b');
  check('(b) endpoint life-b status=online', epB.data && epB.data.status === 'online', JSON.stringify(epB.data));
  const infoB = await proxySystemInfo('life-b');
  check('(b) 经代理 system.info life-b 通', infoB && infoB.system_id === 'life-b', JSON.stringify(infoB));
  const endB = await httpPostJson('/api/se/end', { system_id: 'life-b' });
  check(
    '(b) env-token 外部 attach 无 owner → fail closed',
    endB.status === 200 && endB.data && endB.data.ok === false && endB.data.code === 'process-identity-unknown',
    JSON.stringify(endB.data)
  );
  check('(b) 外部 attach 未被误杀', await probeTcp(portB), `port=${portB}`);

  // ── (d-part1) 关闭 vite#1 → life-a（vite 托管）应被退出钩子杀掉，无孤儿 ──
  if (vite1) {
    await closeViteGracefully(vite1);
    vite1 = null;
  }
  let portADead = false;
  const t0d = Date.now();
  while (Date.now() - t0d < 10000) {
    if (!(await probeTcp(portA))) {
      portADead = true;
      break;
    }
    await sleep(400);
  }
  const lifeAOrphans = pythonProcesses().filter((p) =>
    p.cmd.includes(path.join(ROOT, 'se-systems', 'life-a'))
  );
  check('(d) 关 vite#1 后 life-a 进程消失', portADead, portADead ? '' : `port ${portA} 仍存活`);
  check(
    '(d) 无 life-a python 孤儿进程',
    lifeAOrphans.length === 0,
    lifeAOrphans.map((p) => `${p.pid}`).join(',')
  );

  // ══ vite#2：env 无 SNAKEEATS_ADMIN_TOKEN（用于 (c) 无归属回收重拉）════════
  vite2 = await spawnVite({ adminToken: null });
  try {
    await waitForServer(BASE);
  } catch (err) {
    throw new Error(`${err.message}\n[vite#2]\n${viteOutput}`);
  }

  // ── (c) 手动起 life-c + 可验证己方 owner → E2 回收重拉 ───────────────
  seC = await spawnSe('life-c', TOKEN_UNKNOWN);
  const portC = await waitRegistry('life-c');
  check('(c) 手动 SE life-c 启动并注册', !!portC, portC ? `port=${portC}` : seStderr);
  const epC = await httpGetJson('/api/se/endpoint?system_id=life-c');
  check(
    '(c) endpoint life-c status=offline（D：alive-unauthed 已取消）',
    epC.data && epC.data.status === 'offline' && epC.data.alive === true,
    JSON.stringify(epC.data)
  );
  let ownerC = null;
  try {
    ownerC = writeVerifiableOwner('life-c');
  } catch (err) {
    check('(c) 写入可验证 owner', false, String((err && err.message) || err));
  }
  const spawnC1 = await httpPostJson('/api/se/spawn', { system_id: 'life-c' });
  check(
    '(c) E2：spawn life-c 回收己方可验证孤儿后返回 online',
    !!ownerC && spawnC1.status === 200 && spawnC1.data && spawnC1.data.status === 'online',
    JSON.stringify(spawnC1.data)
  );
  const portC2 = readRegistryPort('life-c');
  check('(c) E2：回收后全新实例（registry 端口已更换）', !!portC2 && portC2 !== portC, `${portC} -> ${portC2}`);
  let oldPortCDead = false;
  {
    const t0c = Date.now();
    while (Date.now() - t0c < 8000) {
      if (!(await probeTcp(portC))) {
        oldPortCDead = true;
        break;
      }
      await sleep(300);
    }
  }
  check('(c) E2：旧己方孤儿（旧端口）已停止', oldPortCDead, oldPortCDead ? '' : `port ${portC} 仍存活`);
  const infoC = await proxySystemInfo('life-c');
  check('(c) 回收重拉后经代理 system.info life-c 通', infoC && infoC.system_id === 'life-c', JSON.stringify(infoC));

  // 关闭 vite#2：回收后的 life-c 现为 vite#2 spawn 托管 → 退出钩子应杀掉它。
  if (vite2) {
    await closeViteGracefully(vite2);
    vite2 = null;
  }
  let portC2Dead = false;
  {
    const t0c2 = Date.now();
    while (Date.now() - t0c2 < 10000) {
      if (portC2 && !(await probeTcp(portC2))) {
        portC2Dead = true;
        break;
      }
      await sleep(400);
    }
  }
  check('(d) 关 vite#2 后回收重拉的 life-c 被退出钩子杀掉', portC2Dead, portC2Dead ? '' : `port ${portC2} 仍存活`);

  // ══ vite#3：重启，重 spawn life-a 同 storage → 快照恢复 ═══════════════════
  vite3 = await spawnVite({ adminToken: TOKEN_T });
  try {
    await waitForServer(BASE);
  } catch (err) {
    throw new Error(`${err.message}\n[vite#3]\n${viteOutput}`);
  }
  const respawnA = await httpPostJson('/api/se/spawn', { system_id: 'life-a' });
  check(
    '(e) 重启 vite 后重 spawn life-a 返回 online',
    respawnA.status === 200 && respawnA.data && respawnA.data.status === 'online',
    JSON.stringify(respawnA.data)
  );
  let listA = null;
  try {
    const ws = await openWs('life-a');
    listA = await rpc(ws, 'stream.list', {});
    ws.close();
  } catch (err) {
    listA = null;
  }
  const restored = Array.isArray(listA) && listA.some((s) => s && s.name === 'recover_stream');
  check(
    '(e) 重启后 stream.list 含 recover_stream（快照恢复）',
    restored,
    Array.isArray(listA) ? `共 ${listA.length} 流` : 'stream.list 失败'
  );

  // ── (f1) E1：当前 Vite spawn token 的 /end，不依赖命令行 storage ───────
  const portA3 = readRegistryPort('life-a');
  const endA = await httpPostJson('/api/se/end', { system_id: 'life-a' });
  check(
    '(f1) E1：POST /api/se/end life-a 返回 killed',
    endA.status === 200 && endA.data && endA.data.ok === true && endA.data.killed === true,
    JSON.stringify(endA.data)
  );
  let portA3Dead = false;
  {
    const t0a = Date.now();
    while (Date.now() - t0a < 15000) {
      if (!(await probeTcp(portA3))) {
        portA3Dead = true;
        break;
      }
      await sleep(300);
    }
  }
  check('(f1) E1：life-a 端口已关闭', portA3Dead, portA3Dead ? '' : `port ${portA3} 仍存活`);

  // ── (f2) 无 owner 的 /end 必须 fail closed，不误杀 ─────────────────────
  seF = await spawnSe('life-f', TOKEN_UNKNOWN);
  const portF = await waitRegistry('life-f');
  check('(f2) 手动 SE life-f 启动并注册（无 owner）', !!portF, portF ? `port=${portF}` : seStderr);
  const endF = await httpPostJson('/api/se/end', { system_id: 'life-f' });
  check(
    '(f2) 无 owner → process-identity-unknown',
    endF.status === 200 && endF.data && endF.data.ok === false && endF.data.code === 'process-identity-unknown',
    JSON.stringify(endF.data)
  );
  await sleep(800);
  check('(f2) 无 owner 时未误杀', await probeTcp(portF), `port=${portF}`);
  check('(f2) 未知状态保留 registry', readRegistryPort('life-f') === portF, `registry=${readRegistryPort('life-f')}`);

  if (vite3) {
    await closeViteGracefully(vite3);
    vite3 = null;
  }

  // ══ E：双 vite 并发 → owned-by-other-vite，绝不误杀 ════════════════════
  {
    const PORT2 = PORT + 50;
    const BASE2 = `http://localhost:${PORT2}`;
    if (await anyListener(PORT2)) throw new Error(`端口 ${PORT2} 已被占用，请先清理`);
    let vite4 = null;
    let vite5 = null;
    try {
      // vite#4 起并 spawn life-e（owner=vite#4，存活）。
      vite4 = await spawnVite({ adminToken: TOKEN_T });
      await waitForServer(BASE);
      const spawnE = await httpPostJson('/api/se/spawn', { system_id: 'life-e' });
      check('(E) vite#4 spawn life-e online', spawnE.status === 200 && spawnE.data && spawnE.data.status === 'online', JSON.stringify(spawnE.data));
      const portE = readRegistryPort('life-e');
      // vite#5（另一活 vite，不同端口）尝试 spawn 同一系统 → 409 owned-by-other-vite，绝不误杀。
      vite5 = await spawnVite({ adminToken: TOKEN_T, port: PORT2 });
      await waitForServer(BASE2);
      const spawnE5 = await httpPostJson('/api/se/spawn', { system_id: 'life-e' }, PORT2);
      check(
        '(E) vite#5 spawn life-e → 409 owned-by-other-vite',
        spawnE5.status === 409 && spawnE5.data && spawnE5.data.status === 'owned-by-other-vite',
        JSON.stringify(spawnE5.data)
      );
      check(
        '(E) vite#5 未误杀：life-e 端口不变且仍存活',
        readRegistryPort('life-e') === portE && (await probeTcp(portE)),
        `portE=${portE} registry=${readRegistryPort('life-e')}`
      );
    } finally {
      if (vite5) await closeViteGracefully(vite5);
      if (vite4) await closeViteGracefully(vite4);
    }
    let portEDead = false;
    {
      const t0e = Date.now();
      while (Date.now() - t0e < 10000) {
        const pe = readRegistryPort('life-e');
        if (!pe || !(await probeTcp(pe))) {
          portEDead = true;
          break;
        }
        await sleep(400);
      }
    }
    check('(E) 关 vite#4/#5 后 life-e 被退出钩子杀掉', portEDead);
  }
} catch (err) {
  check('冒烟执行', false, String((err && err.stack) || err));
} finally {
  killTree(seB);
  killTree(seC);
  killTree(seF);
  if (vite1) await closeViteGracefully(vite1).catch(() => {});
  if (vite2) await closeViteGracefully(vite2).catch(() => {});
  if (vite3) await closeViteGracefully(vite3).catch(() => {});
  await sleep(1500);
  for (const id of ['life-a', 'life-b', 'life-c', 'life-e', 'life-f']) {
    cleanupSeSystem(id);
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
