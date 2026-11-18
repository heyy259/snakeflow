// 期 3 流读写主干冒烟：纯函数单测（Node import src/se/streams.js）+ playwright 集成。
//
// 覆盖验证门（.sisyphus/plans/se-wiring-phase-1-3.md §4.4）：
//   1. 纯函数：单一中文 name 契约（toStreamName）、投影（重投影保 position / 删流减节点 / 改名新增）、
//      tags↔fields 往返、isReservedTagKey、统一文档收窄（name / scan·processes 忽略）。
//   2. 集成（真实 SE + vite 代理 + playwright）：
//      a. 中文名端到端：UI 绑定 tab → 建流「现货套利复盘」→ SE stream.list 断言
//         name === 「现货套利复盘」（SE name 即显示名）→ UI 重命名 → SE name 级联更新；
//      b. SE 外部 stream.create+write → 画布出现新节点；
//      c. 画布编辑提交 → SE stream.read 内容一致；
//      d. SE 外部 stream.write → 画布节点增量刷新；
//      e. CAS 冲突：外部抬高 version → 画布提交 → 覆盖/放弃确认；
//      f. 旧统一文档（含 scan/processes、无 title）加载不报错且字段被忽略（绑定 SE tab 加载）；
//      g. 绑定 tab 建流走真实 SE（P7 已移除未绑定本地画布逃生舱）。
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
const PORT = 5297;
const BASE = `http://localhost:${PORT}`;
const SYSTEM_ID = 'streams-s';
// (f) 加载旧文档的隔离标签页必须绑定真实 SE（逃生舱已移除）。
const LEGACY_SID = `streams-legacy-${Date.now().toString(36)}`;
const TOKEN = `streams-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
  const graph = await import(pathToFileURL(path.join(ROOT, 'src/graph.js')).href);
  const doc = await import(pathToFileURL(path.join(ROOT, 'src/document.js')).href);

  // G1 单一中文 name 契约（toStreamName：中文原生保留、非法折叠、去重）
  const nameContract = await import(pathToFileURL(path.join(ROOT, 'src/se/nameContract.js')).href);
  check('name：中文原生保留', nameContract.isValidStreamName('现货套利复盘') && nameContract.toStreamName('现货套利复盘') === '现货套利复盘');
  check('name：混合字符 → 非法转_并折叠', nameContract.toStreamName('Hello World-A') === 'Hello_World_A', nameContract.toStreamName('Hello World-A'));
  check('name：连续/首尾下划线折叠去除', nameContract.toStreamName('__a__b__') === 'a_b', nameContract.toStreamName('__a__b__'));
  check('name：重名追加 _2', nameContract.toStreamName('abc', ['abc']) === 'abc_2');
  check('name：重名追加 _3', nameContract.toStreamName('abc', ['abc', 'abc_2']) === 'abc_3');
  check('name：合法字符原样保留', nameContract.toStreamName('Node_1') === 'Node_1');
  check('name：空输入回退 stream_<8hex>', /^stream_[0-9a-f]{8}$/.test(nameContract.toStreamName('')), nameContract.toStreamName(''));

  // 稳定 id 映射
  check('id 映射：name→id→name 往返', streams.streamNameFromId(streams.streamNodeId('abc_1')) === 'abc_1');
  check('id 映射：本地节点返回 null', streams.streamNameFromId('n-3') === null);

  // tags ↔ fields 往返
  check('tags→fields→tags 往返', JSON.stringify(streams.fieldsToTags(streams.tagsToFields({ a: '1', b: '' }))) === JSON.stringify({ a: '1', b: '' }));

  // 保留键谓词
  check('保留键：canvas 精确', graph.isReservedTagKey('canvas') === true && graph.isReservedTagKey('canvasx') === false);
  check('保留键：edge. 前缀', graph.isReservedTagKey('edge.target') === true && graph.isReservedTagKey('edge') === false);
  check('保留前缀常量', JSON.stringify(graph.RESERVED_TAG_PREFIXES) === JSON.stringify(['canvas', 'edge.']));

  // 投影：list 元数据 + 坐标缓存 → nodes
  const list = [
    { name: 'B流', description: 'd', tags: { k: 'v' }, version: 4 },
    { name: 'a', tags: {}, version: 1 },
  ];
  const prev = [
    { id: 's-B流', position: { x: 64, y: 32 }, data: { content: '旧内容', fields: [{ key: 'canvas', value: 'false' }] }, style: { width: 300 } },
  ];
  const p1 = streams.projectStreams(list, prev, { center: { x: 100, y: 100 } });
  const nb = p1.nodes.find((n) => n.id === 's-B流');
  const na = p1.nodes.find((n) => n.id === 's-a');
  check('投影：重投影保 position', nb.position.x === 64 && nb.position.y === 32);
  check('投影：name/描述/tags 映射', nb.data.name === 'B流' && nb.data.description === 'd' && nb.data.fields.some((f) => f.key === 'k' && f.value === 'v'));
  // 期 4 起 SE 是 canvas 唯一真源：不再从 prev 合并本地旧值。
  check('投影：canvas 不再从 prev 合并（SE 为真源）', !nb.data.fields.some((f) => f.key === 'canvas'));
  const p1c = streams.projectStreams([{ name: 'c', tags: { canvas: 'false' } }], [], {});
  check('投影：canvas 直接来自 SE tags', p1c.nodes[0].data.fields.some((f) => f.key === 'canvas' && f.value === 'false'));
  check('投影：内容缓存保留', nb.data.content === '旧内容');
  check('投影：渲染宽度保留', nb.style && nb.style.width === 300);
  check('投影：name 直接映射（单一 name）', na.data.name === 'a');
  check('投影：新流落点近视口中心', Math.abs(na.position.x - 100) <= 48 && Math.abs(na.position.y - 100) <= 48);
  check('投影：版本表回传', p1.versions['B流'] === 4 && p1.versions.a === 1);
  // 删流 → removedIds（必须显式 confirmedRemoved；缺失≠删除）
  const p2 = streams.projectStreams([list[1]], prev, { confirmedRemoved: new Set(['B流']) });
  check('投影：删流回传 removedIds', p2.removedIds.includes('s-B流') && !p2.nodes.some((n) => n.id === 's-B流'));
  const p2b = streams.projectStreams([list[1]], prev, {});
  check(
    '投影：未确认缺失保留节点（keepMissing 默认）',
    !p2b.removedIds.length && p2b.nodes.some((n) => n.id === 's-B流') && p2b.keptMissingIds.includes('s-B流')
  );
  // 改名：新名新增、旧名移除（旧名由 rename 事件 tombstone）
  const p3 = streams.projectStreams([{ name: 'b_new', tags: {} }], prev, { confirmedRemoved: new Set(['B流']) });
  check('投影：改名 → 新增新节点 + 移除旧节点', p3.nodes.some((n) => n.id === 's-b_new') && p3.removedIds.includes('s-B流'));

  // 统一文档收窄
  const built = doc.buildDocument(
    {
      name: 'sys',
      nodes: [
        {
          id: 's-x',
          position: { x: 1, y: 2 },
          data: { name: '标题', description: 'D', content: 'C', fields: [{ key: 'k', value: 'v' }], scan: { state: 'scanning', position: 3 }, processes: [{ id: 'p', tool: 't', name: 'n' }] },
        },
      ],
      edges: [],
      tools: {},
    },
    null
  );
  const bs = built.streams[0];
  check('文档：stream 增 name', bs.name === '标题');
  check('文档：写端移除 scan/processes', bs.scan === undefined && bs.processes === undefined);
  check('文档 v2：写端移除内联 content、改为 source.file_path', !('content' in bs) && bs.source?.file_path === 'sys.streams/标题.md');
  check('文档：tags 保留', bs.tags.k === 'v');
  const parsed = doc.parseDocument({
    version: '1.0',
    streams: [{ id: 's-x', name: '旧名', title: '标题2', tags: { k: 'v' }, scan: { state: 'paused', position: 5 }, processes: ['a + b'] }],
    edges: [],
    tools: {},
  });
  const pn = parsed.nodes[0];
  check('文档：读端缺 name 回落旧 title', doc.parseDocument({ version: '1.0', streams: [{ id: 's-y', title: '旧名' }], edges: [], tools: {} }).nodes[0].data.name === '旧名');
  check('文档：读端 name 优先于 title', pn.data.name === '旧名');
  check('文档：读端忽略 scan/processes', pn.data.scan === undefined && pn.data.processes === undefined);
}

// ─────────────────────────────────────────────────────────────────────────────
// 进程 / HTTP / WS 工具（沿用 smoke-se.mjs 模式）
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
const CREATED_GRAPHS = [path.resolve(ROOT, `graphs/${SYSTEM_ID}.se.json`)];

let se = null;
let vite = null;
let browser = null;
let rpcWs = null;
const backups = new Map();

try {
  await unitTests();

  // ── 备份用户工作区文件 + 写入确定性的初始工作区 ──────────────────────────────
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

  // ── 起 SE + vite ────────────────────────────────────────────────────────────
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

  // ── 起 playwright ───────────────────────────────────────────────────────────
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) pageErrors.push(m.text());
  });
  // UI 重命名走级联（stream.rename）会弹 window.confirm 确认改写边键 → 自动接受。
  page.on('dialog', (d) => d.accept().catch(() => {}));
  /** 按标题文本定位画布节点（不依赖 ReactFlow data-id 属性）。 */
  const nodeByTitle = (title) =>
    page.evaluateHandle((t) => {
      const n = Array.from(document.querySelectorAll('.react-flow__node')).find(
        (el) => (el.innerText || '').includes(t)
      );
      return n || null;
    }, title);
  // 选中节点的 resize control 会覆盖「与其重叠的邻居节点」内容区，真实鼠标双击会被拦截。
  // 先点画布空白清空选择，再点目标节点标题区把它置顶并选中；随后双击内容仍走真实鼠标路径，
  // 不绕过交互（只消除测试自身造成的选中态遮挡）。
  const focusNodeForEdit = async (node) => {
    const pane = await page.$('.react-flow__pane');
    const paneBox = pane ? await pane.boundingBox() : null;
    if (paneBox) {
      await page.mouse.click(paneBox.x + 8, paneBox.y + paneBox.height - 8);
      await page.waitForTimeout(150);
    }
    const box = await node.boundingBox();
    if (box) {
      await page.mouse.click(box.x + Math.min(24, box.width / 2), box.y + 12);
      await page.waitForTimeout(150);
    }
    return node.$('.agent-content');
  };
  /** 轮询等待画布节点出现（ReactFlow 渲染较 setNodes 有一帧延迟）。 */
  const waitForCanvasNode = async (title, timeout = 12000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const has = await page.evaluate(
        (t) =>
          Array.from(document.querySelectorAll('.react-flow__node')).some((n) =>
            (n.innerText || '').includes(t)
          ),
        title
      );
      if (has) return true;
      await page.waitForTimeout(250);
    }
    return false;
  };

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow', { timeout: 15000 });
  await page.waitForTimeout(500);

  // ── (a) UI 绑定 tab（连接或启动系统对话框，真实 UI 路径）─────────────────────
  await page.click('.tab-add');
  await page.waitForSelector('.newtab-dialog', { timeout: 8000 });
  await page.click('.newtab-choice-system');
  await page.waitForTimeout(500);
  await page.waitForSelector('.newtab-sys-row', { timeout: 8000 });
  const picked = await page.evaluate((sys) => {
    const row = Array.from(document.querySelectorAll('.newtab-sys-row')).find((r) =>
      r.textContent.includes(sys)
    );
    if (!row) return false;
    row.querySelector('input[type="radio"]').click();
    return true;
  }, SYSTEM_ID);
  check('(a) 系统列表出现目标系统', picked);
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
  await page.waitForTimeout(500);
  check('(a) tab 绑定后顶栏 SE 徽标出现', !!(await page.$('.se-badge')));

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

  // 激活流面板
  const activateRail = async (icon) => {
    for (const b of await page.$$('.rail-btn')) {
      if ((await b.textContent()).includes(icon)) {
        if ((await b.getAttribute('aria-pressed')) !== 'true') await b.click();
        break;
      }
    }
    await page.waitForTimeout(350);
  };
  await activateRail('🌊');

  // ── (a) 中文名端到端：建流（SE name 即显示名）──────────────────────────────
  await page.click('.sidebar-head .head-btn[title="新建流"]');
  await page.waitForTimeout(250);
  await page.fill('.modal input[type="text"]', '现货套利复盘');
  await page.click('.dlg-actions .primary');
  await page.waitForTimeout(700);

  let listA = [];
  try {
    listA = await seRpc('stream.list', {});
  } catch (err) {
    listA = [];
  }
  const created = Array.isArray(listA) ? listA.find((s) => s && s.name === '现货套利复盘') : null;
  check('(a) SE stream.create 落库（name 一致）', !!created, JSON.stringify(created));
  check('(a) name 即中文显示名原样保真', !!created && created.name === '现货套利复盘', created && created.name);
  check('(a) UI 流列表显示中文名', await page.evaluate(() =>
    Array.from(document.querySelectorAll('.stream-name')).some((e) => e.textContent === '现货套利复盘')
  ));
  const createdName = created ? created.name : null;

  // ── (a) UI 重命名 → SE stream.rename（级联；name 即标识）────────────────────
  if (createdName) {
    await page.evaluate((name) => {
      const item = Array.from(document.querySelectorAll('.stream-item')).find(
        (e) => e.querySelector('.stream-name')?.textContent === name
      );
      // 操作按钮顺序：👁 / ✏️ / 🗑
      item.querySelectorAll('.stream-actions button')[1].click();
    }, '现货套利复盘');
    await page.waitForTimeout(350);
    await page.fill('.modal input[type="text"]', '现货套利复盘v2');
    await page.click('.dlg-actions .primary');
    const renameConfirm = page.locator('.modal:has(h3:text-is("确认改名"))');
    await renameConfirm.waitFor({ timeout: 5000 }).catch(() => {});
    if (await renameConfirm.count()) {
      await renameConfirm.locator('.dlg-actions .primary').click();
    }
    await page.waitForTimeout(800);
    let meta = null;
    try {
      meta = await seRpc('stream.get_metadata', { name: '现货套利复盘v2' });
    } catch (err) {
      meta = null;
    }
    check('(a) UI 重命名 → SE name 更新', !!meta && meta.name === '现货套利复盘v2', JSON.stringify(meta));
    let listRenamed = [];
    try {
      listRenamed = await seRpc('stream.list', {});
    } catch (err) {
      listRenamed = [];
    }
    check('(a) 旧 name 已消失（级联重命名）', Array.isArray(listRenamed) && !listRenamed.some((s) => s.name === createdName));
  } else {
    check('(a) UI 重命名', false, '未取到 created name');
  }

  // ── (b) SE 外部 stream.create + write → 画布出现新节点 ──────────────────────
  await seRpc('stream.create', { name: '外部流', tags: { src: 'se' } });
  await seRpc('stream.write', { name: '外部流', text: '外部内容' });
  let appeared = false;
  for (let i = 0; i < 30; i += 1) {
    appeared = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.stream-name')).some((e) => e.textContent === '外部流')
    );
    if (appeared) break;
    await page.waitForTimeout(300);
  }
  check('(b) 外部建流经重投影出现在画布/列表', appeared);
  const bNode = await waitForCanvasNode('外部流');
  check('(b) 外部流节点在画布', bNode);

  // ── (c) 画布编辑提交 → SE stream.read 一致 ─────────────────────────────────
  const extNodeH = await nodeByTitle('外部流');
  const extNode = extNodeH.asElement();
  if (extNode) {
    const contentEl = await focusNodeForEdit(extNode);
    await contentEl.dblclick();
    const pm = await page.waitForSelector('.ProseMirror', { timeout: 15000 }).catch(() => null);
    if (pm) {
      await pm.click();
      await page.keyboard.type('画布写入内容');
      await page.waitForTimeout(900);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1000);
      let read = null;
      try {
        read = await seRpc('stream.read', { name: '外部流' });
      } catch (err) {
        read = null;
      }
      check('(c) 画布编辑提交 → SE 内容一致', !!read && String(read.text).includes('画布写入内容'), read ? JSON.stringify(read.text).slice(0, 80) : 'read fail');
    } else {
      check('(c) 画布编辑提交', false, 'ProseMirror 未挂载');
    }
  } else {
      check('(c) 画布编辑提交', false, '未找到 外部流 节点');
  }

  // ── (d) SE 外部 write → 画布节点增量刷新 ───────────────────────────────────
  await seRpc('stream.write', { name: '外部流', text: '外部刷新XYZ' });
  let refreshed = false;
  for (let i = 0; i < 30; i += 1) {
    refreshed = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.react-flow__node')).some(
        (n) => (n.innerText || '').includes('外部刷新XYZ')
      )
    );
    if (refreshed) break;
    await page.waitForTimeout(300);
  }
  check('(d) 外部写入 → 画布节点增量刷新', refreshed);

  // ── (e) CAS 冲突：外部抬高 version → 画布提交 → 覆盖/放弃确认 ───────────────
  const extNode2H = await nodeByTitle('外部流');
  const extNode2 = extNode2H.asElement();
  if (extNode2) {
    const contentEl2 = await focusNodeForEdit(extNode2);
    await contentEl2.dblclick();
    const pm2 = await page.waitForSelector('.ProseMirror', { timeout: 15000 }).catch(() => null);
    if (pm2) {
      await pm2.click();
      await page.keyboard.type('本地冲突提交');
      await page.waitForTimeout(900);
      // 编辑中由外部写抬高 version（on_change 在编辑中只记 stale、不改 version 基线）
      await seRpc('stream.write', { name: '外部流', text: '外部冲突版本' });
      await page.waitForTimeout(800);
      const doneBtn = await page.$('.flow-edit-hud .node-toolbar button[title*="完成"]');
      if (doneBtn) await doneBtn.click();
      else await page.keyboard.press('Escape');
      const conflict = await page.waitForSelector('.cas-conflict', { timeout: 5000 }).catch(() => null);
      if (conflict) {
        check('(e) CAS 冲突弹覆盖/放弃确认', true);
        await page.click('.cas-discard');
        await page.waitForTimeout(500);
        check('(e) 放弃后对话框关闭', !(await page.$('.cas-conflict')));
      } else {
        // 小范围编辑走 range CAS 自动重试（orchestrator commitContent），不弹 whole-write 冲突框；
        // 断言本地编辑与远端新版本都被保留，无静默覆盖。
        const read = await seRpc('stream.read', { name: '外部流' }).catch(() => null);
        const text = read ? String(read.text) : '';
        check(
          '(e) CAS 小范围自动合并（本地+远端均保留）',
          text.includes('本地冲突提交') && text.includes('外部冲突版本'),
          JSON.stringify(text).slice(0, 120)
        );
        check('(e) 放弃后对话框关闭', !(await page.$('.cas-conflict')));
      }
    } else {
      check('(e) CAS 冲突', false, 'ProseMirror 未挂载');
    }
  } else {
      check('(e) CAS 冲突', false, '未找到 外部流 节点');
  }

  // ── (f) 旧统一文档（含 scan/processes、无 title）加载不报错且字段被忽略 ──────
  const legacyDoc = {
    version: '1.0',
    streams: [
      { id: 's-legacy', name: '旧文档流', description: '', tags: { k: 'v' }, content: '旧内容', position: { x: 40, y: 40 }, scan: { state: 'paused', position: 5, ok: 2, fail: 1 }, processes: ['a + b'] },
    ],
    edges: [],
    tools: {},
  };
  const legacyPath = path.join(ROOT, 'graphs', 'smoke-se-legacy.se.json');
  fs.writeFileSync(legacyPath, JSON.stringify(legacyDoc, null, 2));
  // 新开绑定 SE 的隔离 tab 加载（本地画布逃生舱已移除；独占系统避免与主投影互相覆盖）
  // createBoundTab 已等到活动 tab 属于本系统（精确 systemId）、在线且绑定弹窗关闭，可直接取样。
  await createBoundTab(page, LEGACY_SID);
  await activateRail('🌊');
  // P7：绑定 tab 下文档 s-* 流按 overlay 语义不注入（SE 为结构真源）。先建一个真实 SE 流，
  // 用于验证加载旧文档不覆盖 SE 真源、也不把文档 scan/processes 字段带进画布。
  const beforeF = (await page.$$('.stream-item')).length;
  await page.click('.sidebar-head .head-btn[title="新建流"]');
  await page.waitForTimeout(250);
  await page.fill('.modal input[type="text"]', 'SE真源流');
  await page.click('.dlg-actions .primary');
  await page.waitForFunction(
    (n) => document.querySelectorAll('.stream-item').length > n,
    beforeF,
    { timeout: 20000 }
  );
  const loadBtn = await page.evaluateHandle(() =>
    Array.from(document.querySelectorAll('.toolbar button')).find((b) => b.textContent.includes('加载文档'))
  );
  await loadBtn.asElement().click();
  await page.waitForTimeout(300);
  await page.fill('.modal .dlg-row input[type="text"]', legacyPath);
  await page.click('.dlg-actions .primary');
  await page.waitForSelector('.doc-strategy', { timeout: 8000 });
  await page.evaluate(() =>
    Array.from(document.querySelectorAll('.doc-strategy button')).find((b) => b.textContent === '整页替换').click()
  );
  await page.waitForTimeout(700);
  check('(f) 旧文档加载不报错（SE 真源流保留）', await page.evaluate(() =>
    Array.from(document.querySelectorAll('.stream-name')).some((e) => e.textContent === 'SE真源流')
  ));
  check('(f) 绑定 tab：文档 s-* 流不注入（overlay，SE 为结构真源）', await page.evaluate(() =>
    !Array.from(document.querySelectorAll('.stream-name')).some((e) => e.textContent === '旧文档流')
  ));
  check('(f) 旧文档字段被忽略（无扫描态）', await page.evaluate(() =>
    !document.querySelector('.scan-strip.scanning')
  ));

  // ── (g) 逃生舱已移除：绑定 tab 建流走真实 SE（不再是本地画布）──────────────
  // P7 后每个 tab 必绑 SE，旧「未绑定本地建流」断言不可达；改为验证 SE-backed 建流。
  const beforeG = (await page.$$('.stream-item')).length;
  await page.click('.sidebar-head .head-btn[title="新建流"]');
  await page.waitForTimeout(250);
  await page.fill('.modal input[type="text"]', '本地流G');
  await page.click('.dlg-actions .primary');
  await page.waitForFunction(
    (n) => document.querySelectorAll('.stream-item').length > n,
    beforeG,
    { timeout: 20000 }
  );
  const localOk = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.stream-name')).some((e) => e.textContent === '本地流G')
  );
  check('(g) 绑定 tab 建流出现在列表（SE 真源）', localOk);
  check('(g) 绑定 tab 显示 SE 徽标', !!(await page.$('.se-badge')));
  check('(g) 绑定 tab 无 CAS 冲突框', !(await page.$('.cas-conflict')));

  // ── 控制台无异常 ────────────────────────────────────────────────────────────
  const realErrors = pageErrors.filter((e) => !/favicon|React DevTools/i.test(e));
  check('控制台无错误', realErrors.length === 0, realErrors.slice(0, 3).join(' || '));

  await page.screenshot({ path: '.sisyphus/smoke-se-streams.png' });
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
  cleanupSeSystem(LEGACY_SID);
  fs.rmSync(path.resolve(ROOT, 'graphs', 'smoke-se-legacy.se.json'), { force: true });
  // 本用例 seed 的 workspace 里全是测试 tab：清掉运行时派生出来的 SE storage。
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
  purgeTestTabsFromWorkspace(path.resolve(ROOT, 'graphs/.workspace.json'));
  cleanupGraphArtifacts(SYSTEM_ID);
  cleanupGraphArtifacts(LEGACY_SID);
  for (const f of CREATED_GRAPHS) fs.rmSync(f, { force: true });
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
