// 期 4 冒烟：tag 快照-差分/可见性接线/fields 行内编辑（G-7）/G-3 元数据安全。
//
// 覆盖验证门（.sisyphus/plans/se-wiring-phase-4-5.md §2.3）：
//   1. 纯函数：tagOps（edgeTagKey/edgeTagTarget/diffTags/capture/apply）+ streams
//      （tagsToFields 过滤 edge.*、canvas 直接取 SE tags、不合并 prev）。
//   2. 集成（真实 SE + vite 代理 + playwright）：
//      a. 可见性往返：隐藏 → tags.canvas==='false'；显示 → 键**不存在**（非空串）；
//      b. undo/redo：Ctrl+Z 还原隐藏（SE + 画布双还原）；Ctrl+Y 再显示；
//      c. fields 接线（G-7）：画布节点增/改/删属性行 → SE tags 同步；
//      d. 保留键拒绝：手写 canvas/edge.x 被拒并提示，SE 不变；
//      e. G-3 回归：有 edge.probe 标签时保存元数据不删除它；
//      f. SE 真源：外部改 canvas tag → 重投影（结构操作触发）后可见性同步；
//      g. 逃生舱已移除：绑定 tab 可见性走真实 SE（独占系统，无本地回落）。
//
// 自动 spawn 真实 SE + vite；finally 清理子进程、临时 storage 与 graphs 备份。
import { spawn, spawnSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5298;
const BASE = `http://localhost:${PORT}`;
const SYSTEM_ID = 'tags-s';
// (g) 隔离标签页必须绑定真实 SE（P7 已移除未绑定本地画布逃生舱）。
const ESCAPE_SID = `tags-escape-${Date.now().toString(36)}`;
const TOKEN = `tags-${Date.now()}-${Math.random().toString(36).slice(2)}`;
import {
  resolveSeRuntimeForTests,
  spawnSe as spawnSeHelper,
  seEnvForTests,
} from './se-test-helper.mjs';
import {
  createBoundTab,
  cleanupSeSystem,
  cleanupGraphArtifacts,
  purgeTestTabsFromWorkspace,
  workspaceSystemIds,
} from './se-ui-helper.mjs';
const RUNTIME = await resolveSeRuntimeForTests();
const PYTHON = RUNTIME.ok ? RUNTIME.python : '';
const SE_PACKAGE_PARENT = RUNTIME.ok ? RUNTIME.packageParent : '';
const STORAGE = path.join(ROOT, 'se-systems', SYSTEM_ID);
const REGISTRY = path.join(STORAGE, 'registry', '.registry.json');
const WS_PATH = `/api/se/ws?system_id=${encodeURIComponent(SYSTEM_ID)}`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 180) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Part 1：纯函数单测
// ─────────────────────────────────────────────────────────────────────────────
async function unitTests() {
  const streams = await import(pathToFileURL(path.join(ROOT, 'src/se/streams.js')).href);
  const tagOps = await import(pathToFileURL(path.join(ROOT, 'src/se/tagOps.js')).href);

  // edge key 编解码
  check('edgeTagKey：name → edge.<name>', tagOps.edgeTagKey('abc_1') === 'edge.abc_1');
  check('edgeTagTarget：往返', tagOps.edgeTagTarget(tagOps.edgeTagKey('abc')) === 'abc');
  check('edgeTagTarget：非 edge 前缀 → null', tagOps.edgeTagTarget('canvas') === null);

  // diffTags：还原到 before 的最小差量
  const d1 = tagOps.diffTags({ a: '1', b: '2' }, { a: '1', b: '9', c: '3' });
  check('diffTags：值不同 → set', d1.set.b === '2' && !('a' in d1.set));
  check('diffTags：current 多出 → remove', d1.remove.length === 1 && d1.remove[0] === 'c');
  const d2 = tagOps.diffTags({}, { a: '1' });
  check('diffTags：空快照 → 全 remove', Object.keys(d2.set).length === 0 && d2.remove[0] === 'a');
  const d3 = tagOps.diffTags({ x: '' }, {});
  check('diffTags：空串值按需 set', d3.set.x === '');
  const d4 = tagOps.diffTags({ a: '1' }, { a: '1' });
  check('diffTags：全等 → 空差量', Object.keys(d4.set).length === 0 && d4.remove.length === 0);

  // streams：tagsToFields 过滤 edge.*、保留 canvas
  const f1 = streams.tagsToFields({ canvas: 'false', 'edge.B': '', k: 'v' });
  check('tagsToFields：过滤 edge.*', !f1.some((f) => f.key.startsWith('edge.')));
  check('tagsToFields：保留 canvas', f1.some((f) => f.key === 'canvas' && f.value === 'false'));

  // streams：projectStreams canvas 直接来自 SE tags（不再合并 prev）
  const list = [{ name: 'a', tags: { canvas: 'false', k: 'v' }, version: 1 }];
  const prev = [
    { id: 's-a', position: { x: 0, y: 0 }, data: { fields: [{ key: 'canvas', value: 'true' }] } },
  ];
  const p1 = streams.projectStreams(list, prev, {});
  const na = p1.nodes.find((n) => n.id === 's-a');
  check('投影：canvas 取 SE（false）', na.data.fields.some((f) => f.key === 'canvas' && f.value === 'false'));
  const list2 = [{ name: 'a', tags: { k: 'v' }, version: 1 }];
  const p2 = streams.projectStreams(list2, prev, {});
  check('投影：SE 无 canvas 时不合并本地旧值', !p2.nodes.find((n) => n.id === 's-a').data.fields.some((f) => f.key === 'canvas'));

  // captureStreamTags / applyTagSnapshot（fake client）
  const store = { a: { k: 'v' } };
  const fake = {
    calls: [],
    async call(method, params) {
      this.calls.push({ method, params });
      if (method === 'stream.get_metadata') {
        if (!(params.name in store)) {
          const e = new Error('missing');
          e.code = -32002;
          throw e;
        }
        return { name: params.name, tags: { ...store[params.name] } };
      }
      if (method === 'stream.set_tag') {
        store[params.name] = { ...(store[params.name] || {}), [params.key]: params.value };
        return {};
      }
      if (method === 'stream.remove_tag') {
        const t = { ...(store[params.name] || {}) };
        delete t[params.key];
        store[params.name] = t;
        return {};
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const cap = await tagOps.captureStreamTags(fake, ['a', 'missing']);
  check('captureStreamTags：命中取 tags', cap.a && cap.a.k === 'v');
  check('captureStreamTags：缺失记 null', cap.missing === null);
  store.a = { k: 'CHANGED', extra: '1' };
  const applied = await tagOps.applyTagSnapshot(fake, { a: { k: 'v' } });
  check('applyTagSnapshot：还原 set/remove', store.a.k === 'v' && !('extra' in store.a));
  check('applyTagSnapshot：返回逐流结果', applied.length === 1 && applied[0].name === 'a' && applied[0].changed === true);
}

// ─────────────────────────────────────────────────────────────────────────────
// 进程 / HTTP / WS 工具（沿用 smoke-se-streams.mjs 模式）
// ─────────────────────────────────────────────────────────────────────────────
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
function anyListener(port, timeout = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: 'localhost', port });
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
      .get(`http://localhost:${PORT}${pathname}`, (res) => {
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

/** 经代理的 SE 侧 RPC 客户端（id 自增，notification 忽略）。 */
function connectSeRpc() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}${WS_PATH}`);
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch (err) {
        /* 忽略 */
      }
      reject(new Error('se rpc ws open timeout'));
    }, 10000);
    ws.on('open', () => {
      clearTimeout(timer);
      let nextId = 1;
      const rpc = (method, params = {}, timeout = 8000) =>
        new Promise((res, rej) => {
          const id = nextId++;
          const t = setTimeout(() => rej(new Error(`${method} timeout`)), timeout);
          const onMessage = (data) => {
            let msg;
            try {
              msg = JSON.parse(data.toString());
            } catch (err) {
              return;
            }
            if (!msg || msg.id !== id) return;
            clearTimeout(t);
            ws.off('message', onMessage);
            if (msg.error) {
              const err = new Error(msg.error.message || 'rpc error');
              err.code = msg.error.code;
              rej(err);
            } else res(msg.result);
          };
          ws.on('message', onMessage);
          ws.send(JSON.stringify({ jsonrpc: '2.0', method, params, id }));
        });
      resolve({ ws, rpc });
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Part 2：集成（playwright）
// ─────────────────────────────────────────────────────────────────────────────
const BACKUP_FILES = ['graphs/.workspace.json', 'graphs/.frecency.json', 'graphs/.ui.json'].map((p) => path.resolve(ROOT, p));

let se = null;
let vite = null;
let browser = null;
let rpcWs = null;
const backups = new Map();

try {
  await unitTests();

  for (const f of BACKUP_FILES) {
    if (fs.existsSync(f)) {
      fs.copyFileSync(f, f + '.smk-bak');
      backups.set(f, true);
    }
  }
  fs.mkdirSync(path.resolve(ROOT, 'graphs'), { recursive: true });
  fs.writeFileSync(
    path.resolve(ROOT, 'graphs/.workspace.json'),
    JSON.stringify({ activeId: 't-smoke', tabs: [{ id: 't-smoke', name: '' }], store: { 't-smoke': { nodes: [], edges: [], tools: {} } } })
  );

  // 本机 Node 的 fs.rmSync(recursive) 为静默 no-op，改用 crash-safe 删除，保证可重复运行。
  cleanupSeSystem(SYSTEM_ID);
  if (await anyListener(PORT)) throw new Error(`端口 ${PORT} 已被占用，请先清理`);

  se = await spawnSe();
  const sePort = await waitRegistry();
  check('集成前置：SE 启动并落盘 registry', !!sePort, sePort ? `port=${sePort}` : seStderr);
  if (!sePort) throw new Error('SE 未就绪');

  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  vite = spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...await seEnvForTests(),
      SNAKEEATS_ADMIN_TOKEN: TOKEN,
      SNAKEEATS_SYSTEM_ID: SYSTEM_ID,
    },
  });
  let viteOutput = '';
  vite.stdout.on('data', (d) => (viteOutput = (viteOutput + String(d)).slice(-3000)));
  vite.stderr.on('data', (d) => (viteOutput = (viteOutput + String(d)).slice(-3000)));
  try {
    await waitForServer(BASE);
  } catch (err) {
    throw new Error(`${err.message}\n[vite]\n${viteOutput}`);
  }

  const ep = await httpGetJson(`/api/se/endpoint?system_id=${SYSTEM_ID}`);
  check('集成前置：endpoint online', ep.data && ep.data.status === 'online', JSON.stringify(ep.data));

  const seRpcConn = await connectSeRpc();
  rpcWs = seRpcConn.ws;
  let seRpc = seRpcConn.rpc;

  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) pageErrors.push(m.text());
  });

  const metaTags = async (name) => {
    try {
      const meta = await seRpc('stream.get_metadata', { name });
      return (meta && meta.tags) || {};
    } catch (err) {
      return null;
    }
  };
  const streamItemHidden = (title) =>
    page.evaluate((t) => {
      const item = Array.from(document.querySelectorAll('.stream-item')).find(
        (e) => e.querySelector('.stream-name')?.textContent === t
      );
      return item ? item.classList.contains('is-hidden') : null;
    }, title);
  const clickEye = (title) =>
    page.evaluate((t) => {
      const item = Array.from(document.querySelectorAll('.stream-item')).find(
        (e) => e.querySelector('.stream-name')?.textContent === t
      );
      if (!item) return false;
      item.querySelectorAll('.stream-actions button')[0].click();
      return true;
    }, title);
  const nodeHandle = async (title) => (await page.evaluateHandle((t) => {
    return (
      Array.from(document.querySelectorAll('.react-flow__node')).find((el) =>
        (el.innerText || '').includes(t)
      ) || null
    );
  }, title)).asElement();
  const waitForCanvasNode = async (title, timeout = 12000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const has = await page.evaluate(
        (t) => Array.from(document.querySelectorAll('.react-flow__node')).some((n) => (n.innerText || '').includes(t)),
        title
      );
      if (has) return true;
      await page.waitForTimeout(250);
    }
    return false;
  };
  const activateRail = async (icon) => {
    for (const b of await page.$$('.rail-btn')) {
      if ((await b.textContent()).includes(icon)) {
        if ((await b.getAttribute('aria-pressed')) !== 'true') await b.click();
        break;
      }
    }
    await page.waitForTimeout(350);
  };
  const fieldKeyTexts = (title) =>
    page.evaluate((t) => {
      const node = Array.from(document.querySelectorAll('.react-flow__node')).find((el) =>
        (el.innerText || '').includes(t)
      );
      if (!node) return null;
      return Array.from(node.querySelectorAll('.agent-field-key')).map((e) => (e.textContent || '').trim());
    }, title);
  const editField = async (title, which, part, text) => {
    const node = await nodeHandle(title);
    if (!node) return false;
    const els = await node.$$(`.agent-field-${part === 'key' ? 'key' : 'value'}`);
    const el = which === 'last' ? els[els.length - 1] : els[which];
    if (!el) return false;
    await el.dblclick();
    await page.waitForTimeout(150);
    await page.fill(`.agent-edit-f${part === 'key' ? 'k' : 'v'}`, text);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(700);
    return true;
  };
  const deleteField = async (title, which) => {
    const node = await nodeHandle(title);
    if (!node) return false;
    const els = await node.$$('.agent-field-del');
    const el = which === 'last' ? els[els.length - 1] : els[which];
    if (!el) return false;
    await el.click();
    await page.waitForTimeout(700);
    return true;
  };

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow', { timeout: 15000 });
  await page.waitForTimeout(500);

  // ── 绑定 SE tab ─────────────────────────────────────────────────────────────
  await page.click('.tab-add');
  await page.waitForSelector('.newtab-dialog', { timeout: 8000 });
  await page.click('.newtab-choice-system');
  await page.waitForTimeout(500);
  await page.waitForSelector('.newtab-sys-row', { timeout: 8000 });
  const picked = await page.evaluate((sys) => {
    const row = Array.from(document.querySelectorAll('.newtab-sys-row')).find((r) => r.textContent.includes(sys));
    if (!row) return false;
    row.querySelector('input[type="radio"]').click();
    return true;
  }, SYSTEM_ID);
  check('绑定：系统列表出现目标系统', picked);
  await page.click('.newtab-dialog .dlg-actions .primary');
  // 生命周期收口（需求 A–E）：绑定外部已运行（无 owner）的 SE 时，vite 按 registry 端口
  // 回收该进程并全新拉起（不再弹「粘贴 token」挂接框），故测试无需粘贴 token。
  await page.waitForTimeout(800);
  try {
    await page.waitForSelector('.modal-overlay', { state: 'detached', timeout: 25000 });
  } catch (err) {
    const txt = await page.evaluate(() =>
      document.querySelector('.modal-overlay') ? document.querySelector('.modal-overlay').innerText : '(none)'
    );
    throw new Error(`绑定弹窗未关闭：${txt}`);
  }
  await page.waitForSelector('.se-badge', { timeout: 20000 });
  await page.waitForTimeout(600);
  // 生命周期收口：绑定回收了外部 SE 并全新拉起，旧的 rpc WS 已被代理关闭 → 重连到新实例。
  try {
    rpcWs.close();
  } catch (err) {
    /* 忽略 */
  }
  {
    const rec = await connectSeRpc();
    rpcWs = rec.ws;
    seRpc = rec.rpc;
  }
  await activateRail('🌊');

  // ── 建流（带初始标签 probe=one）────────────────────────────────────────────
  const TITLE = '标签测试流';
  await page.click('.sidebar-head .head-btn');
  await page.waitForTimeout(250);
  await page.fill('.modal input[type="text"]', TITLE);
  await page.click('.modal .tag-add');
  await page.waitForTimeout(150);
  await page.fill('.modal .tag-key', 'probe');
  await page.fill('.modal .tag-value', 'one');
  await page.click('.dlg-actions .primary');
  await page.waitForTimeout(900);

  let listA = [];
  try {
    listA = await seRpc('stream.list', {});
  } catch (err) {
    listA = [];
  }
  const created = Array.isArray(listA) ? listA.find((s) => s && s.name === TITLE) : null;
  check('建流：SE stream.create 落库', !!created, JSON.stringify(created));
  const NAME = created ? created.name : null;
  check('建流：初始 tag 写入', !!NAME && (await metaTags(NAME)).probe === 'one');
  check('建流：画布节点出现', await waitForCanvasNode(TITLE, 8000));

  // ── (a) 可见性往返 ──────────────────────────────────────────────────────────
  if (NAME) {
    await clickEye(TITLE);
    await page.waitForTimeout(1000);
    let tags = await metaTags(NAME);
    check('(a) 隐藏 → tags.canvas==="false"', tags && tags.canvas === 'false', JSON.stringify(tags));
    check('(a) 隐藏 → 列表项 is-hidden', (await streamItemHidden(TITLE)) === true);

    await clickEye(TITLE);
    await page.waitForTimeout(1000);
    tags = await metaTags(NAME);
    check('(a) 显示 → canvas 键不存在（非空串）', tags && !('canvas' in tags), JSON.stringify(tags));
    check('(a) 显示 → 列表项恢复', (await streamItemHidden(TITLE)) === false);

    // ── (b) undo/redo 双还原 ──────────────────────────────────────────────────
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(1200);
    tags = await metaTags(NAME);
    check('(b) Ctrl+Z → SE canvas 还原为 false', tags && tags.canvas === 'false', JSON.stringify(tags));
    check('(b) Ctrl+Z → 画布节点隐藏', (await streamItemHidden(TITLE)) === true);
    await page.keyboard.press('Control+y');
    await page.waitForTimeout(1200);
    tags = await metaTags(NAME);
    check('(b) Ctrl+Y → SE canvas 键消失', tags && !('canvas' in tags), JSON.stringify(tags));
    check('(b) Ctrl+Y → 画布节点恢复', (await streamItemHidden(TITLE)) === false);

    // ── (c) fields 接线（G-7）─────────────────────────────────────────────────
    // 改键 probe → probe2
    await editField(TITLE, 0, 'key', 'probe2');
    tags = await metaTags(NAME);
    check('(c) 改键 → set_tag 新键 / 旧键消失', tags && tags.probe2 === 'one' && !('probe' in tags), JSON.stringify(tags));
    // 改值 one → two
    await editField(TITLE, 0, 'value', 'two');
    tags = await metaTags(NAME);
    check('(c) 改值 → set_tag 覆盖', tags && tags.probe2 === 'two', JSON.stringify(tags));
    // 新增行（键 added）：先选中节点让 NodeToolbar 出现，再点「+ 属性」
    const nodeForAdd = await nodeHandle(TITLE);
    if (nodeForAdd) {
      await nodeForAdd.click();
      await page.waitForTimeout(400);
      const addClicked = await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button')).find(
          (x) => x.textContent.trim() === '+ 属性'
        );
        if (!b) return false;
        b.click();
        return true;
      });
      check('(c) NodeToolbar「+ 属性」可点', addClicked);
      await page.waitForTimeout(300);
    }
    await editField(TITLE, 'last', 'key', 'added');
    tags = await metaTags(NAME);
    check('(c) 新增键 → set_tag（值空串）', tags && 'added' in tags && tags.added === '', JSON.stringify(tags));
    await editField(TITLE, 'last', 'value', 'v');
    tags = await metaTags(NAME);
    check('(c) 新增键改值 → set_tag', tags && tags.added === 'v', JSON.stringify(tags));
    // 删行
    await deleteField(TITLE, 'last');
    tags = await metaTags(NAME);
    check('(c) 删行 → remove_tag', tags && !('added' in tags), JSON.stringify(tags));

    // ── (d) 保留键拒绝 ────────────────────────────────────────────────────────
    await editField(TITLE, 0, 'key', 'canvas');
    await page.waitForTimeout(200);
    const toastText = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.toast')).map((t) => t.textContent).join(' | ')
    );
    check('(d) 手写 canvas 被拒并提示', /保留键/.test(toastText), toastText);
    tags = await metaTags(NAME);
    check('(d) 拒绝后 SE 不变（probe2 仍在）', tags && tags.probe2 === 'two' && !('canvas' in tags), JSON.stringify(tags));

    // ── (e) G-3：保存元数据不删 edge.* ────────────────────────────────────────
    await seRpc('stream.set_tag', { name: NAME, key: 'edge.probe', value: 'x' });
    // 右键 → 编辑标签 → 改描述 + 加普通标签 → 保存
    const itemH = await page.evaluateHandle((t) =>
      Array.from(document.querySelectorAll('.stream-item')).find((e) => e.querySelector('.stream-name')?.textContent === t) || null, TITLE);
    await itemH.asElement().click({ button: 'right' });
    await page.waitForSelector('.context-menu', { timeout: 5000 });
    await page.evaluate(() =>
      Array.from(document.querySelectorAll('.context-menu button')).find((b) => b.textContent.includes('编辑标签')).click()
    );
    await page.waitForSelector('.modal .tags-editor', { timeout: 5000 });
    await page.fill('.modal .dlg-textarea', 'G3 描述');
    await page.click('.modal .tag-add');
    await page.waitForTimeout(150);
    const tagKeyInputs = await page.$$('.modal .tag-key');
    const tagValInputs = await page.$$('.modal .tag-value');
    await tagKeyInputs[tagKeyInputs.length - 1].fill('meta');
    await tagValInputs[tagValInputs.length - 1].fill('yes');
    await page.click('.modal .dlg-actions .primary');
    await page.waitForTimeout(1200);
    tags = await metaTags(NAME);
    check('(e) G-3：edge.probe 保存元数据后仍在', tags && tags['edge.probe'] === 'x', JSON.stringify(tags));
    check('(e) G-3：普通标签正常写入', tags && tags.meta === 'yes', JSON.stringify(tags));

    // ── (f) SE 真源：外部改 tag → 重投影同步 ──────────────────────────────────
    await clickEye(TITLE); // 隐藏 → canvas=false
    await page.waitForTimeout(1000);
    check('(f) 前置：隐藏成功', (await streamItemHidden(TITLE)) === true);
    await seRpc('stream.remove_tag', { name: NAME, key: 'canvas' }); // 外部改
    // 触发一次结构操作（外部建流 + 写）→ on_change 未知流 → 全量重投影
    await seRpc('stream.create', { name: '外部同步流' });
    await seRpc('stream.write', { name: '外部同步流', text: 'x' });
    let syncedVisible = false;
    for (let i = 0; i < 30; i += 1) {
      syncedVisible = (await streamItemHidden(TITLE)) === false;
      if (syncedVisible) break;
      await page.waitForTimeout(300);
    }
    check('(f) 外部删除 canvas → 重投影后显示', syncedVisible);

    // ── (h) se-content undo/redo（D1）──────────────────────────────────────────
    const readText = async () => {
      try {
        const r = await seRpc('stream.read', { name: NAME });
        return r && r.text != null ? String(r.text) : '';
      } catch (err) {
        return null;
      }
    };
    const contentNode = await nodeHandle(TITLE);
    const contentEl = contentNode ? await contentNode.$('.agent-content') : null;
    const beforeContent = await page.evaluate((t) => {
      const n = Array.from(document.querySelectorAll('.react-flow__node')).find((el) =>
        (el.innerText || '').includes(t)
      );
      return n ? (n.innerText || '').length : -1;
    }, TITLE);
    if (contentEl) {
      await contentEl.dblclick();
      const pm = await page.waitForSelector('.ProseMirror', { timeout: 15000 }).catch(() => null);
      if (pm) {
        await pm.click();
        await page.keyboard.type('期四内容撤销测试XYZ');
        await page.waitForTimeout(900);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(1500);
        const afterEdit = await readText();
        check('(h) 内容编辑提交到 SE', !!afterEdit && afterEdit.includes('期四内容撤销测试XYZ'), JSON.stringify(afterEdit));
        await page.keyboard.press('Control+z');
        await page.waitForTimeout(1800);
        const afterUndo = await readText();
        check('(h) Ctrl+Z → SE 内容回退（se-content undo）', afterUndo !== null && !afterUndo.includes('期四内容撤销测试XYZ'), JSON.stringify(afterUndo));
        await page.keyboard.press('Control+y');
        await page.waitForTimeout(1800);
        const afterRedo = await readText();
        check('(h) Ctrl+Y → SE 内容恢复（se-content redo）', !!afterRedo && afterRedo.includes('期四内容撤销测试XYZ'), JSON.stringify(afterRedo));
      } else {
        check('(h) se-content undo/redo', false, 'ProseMirror 未挂载');
      }
    } else {
      check('(h) se-content undo/redo', false, `未找到内容区（beforeLen=${beforeContent}）`);
    }
  } else {
    check('集成可见性/fields 用例', false, '未取到 created name');
  }

  // ── (g) 逃生舱已移除：绑定 tab 可见性走真实 SE（独占系统）──────────────────
  // P7 后每个 tab 必绑 SE，旧「未绑定本地隐藏」断言不可达；改为验证 SE-backed 可见性。
  await createBoundTab(page, ESCAPE_SID);
  await activateRail('🌊');
  const beforeG = (await page.$$('.stream-item')).length;
  await page.click('.sidebar-head .head-btn');
  await page.waitForTimeout(250);
  await page.fill('.modal input[type="text"]', '本地可见流');
  await page.click('.dlg-actions .primary');
  await page.waitForFunction(
    (n) => document.querySelectorAll('.stream-item').length > n,
    beforeG,
    { timeout: 20000 }
  );
  await clickEye('本地可见流');
  await page.waitForTimeout(500);
  check('(g) 绑定：SE 隐藏生效', (await streamItemHidden('本地可见流')) === true);
  check('(g) 绑定：SE 徽标出现', !!(await page.$('.se-badge')));

  const realErrors = pageErrors.filter((e) => !/favicon|React DevTools/i.test(e));
  check('控制台无错误', realErrors.length === 0, realErrors.slice(0, 3).join(' || '));

  await page.screenshot({ path: '.sisyphus/smoke-se-tags.png' });
} catch (err) {
  check('冒烟执行', false, String((err && err.stack) || err));
} finally {
  try {
    if (rpcWs && rpcWs.readyState === WebSocket.OPEN) rpcWs.close();
  } catch (err) {
    /* 忽略 */
  }
  if (browser) await browser.close().catch(() => {});
  killTree(se);
  killTree(vite);
  await sleep(1200);
  fs.rmSync(STORAGE, { recursive: true, force: true });
  cleanupSeSystem(ESCAPE_SID);
  // 本用例 seed 的 workspace 里全是测试 tab：清掉运行时派生出来的 SE storage（如 se_<hash>）。
  for (const id of workspaceSystemIds(path.resolve(ROOT, 'graphs/.workspace.json'))) cleanupSeSystem(id);
  for (const f of BACKUP_FILES) {
    const bak = f + '.smk-bak';
    if (backups?.get(f) && fs.existsSync(bak)) {
      fs.copyFileSync(bak, f);
      fs.rmSync(bak, { force: true });
    } else if (fs.existsSync(bak)) {
      fs.rmSync(bak, { force: true });
    }
  }
  // 恢复的备份可能已被旧版测试污染：再剔除一次测试 tab，避免逐轮累积。
  purgeTestTabsFromWorkspace(path.resolve(ROOT, 'graphs/.workspace.json'));
  cleanupGraphArtifacts(SYSTEM_ID);
  cleanupGraphArtifacts(ESCAPE_SID);
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
