// 期 5 冒烟：边 = 流标签（全案）。纯函数 + 真实 SE + vite + playwright。
//
// 覆盖验证门（.sisyphus/plans/se-wiring-phase-4-5.md §3.3）：
//   1. 边往返：连线 → tags['edge.<目标>']===''；reload（等价重连）→ 边由 stream.list 派生还原。
//   2. 注释：边工具栏写注释 → tag value 更新；清空 → value '' （不是删键）。
//   3. 删边：tag 键消失。
//   4. 自环：A→A 成立。
//   5. rename 级联：A→B、C→A 存在时 rename A→D → 无 edge.A 残留、C 的 edge.D 注释保留。
//   6. delete 级联：删除 B（被 D→B 引用）→ D 的 edge.B 键消失、对话框示入边数。
//   7. 悬空边：外部删除目标 → 横幅出现 → 逐条清除 → tag 键消失；无「全部清除」。
//   8. 保留前缀：edge.* 不出现在 chips/pills；但流面板搜索可命中边注释。
//   9. B1 回归：删除带自环的流（自环引用不得中断删除级联）。
//      B3 回归并入 (5)：rename 后节点位置/内容保持。
//      B2 回归见 Part 1 纯函数段：级联应用层逐条容错、不抛、失败入 diff。
//
// 明确留作人工/无法稳定自动化的部分（不弱化断言，仅登记）：
//   - B2 端到端「级联中途断连 → CascadeRepairDialog 出现且可重试收敛」需在 RPC 之间强杀
//     SE/断网，无法确定性重现；本脚本以强制失败的 fake client 直测 `src/se/cascade.js` 的
//     容错与 diff 合并，UI 对话框本身的呈现留作人工验证（§3.3-8）。
//   - R1（绑定离线时拒绝创建 s-* 边）与 R2（切 tab / 重投影失败清除陈旧悬空横幅）为状态
//     驱动分支，未在本脚本中制造离线态；以 `lsp_diagnostics` + 既有回归不红兜底。
//   - FIX-1（内容编辑中改名 → 先 exitEdit 提交再迁移 id）：需编辑会话 + 改名时序，
//     留作人工验证；FIX-2 的「非活动系统仍返回真实投影」以 Part 1 纯函数断言锚定
//     （diffEdgeRefs 有效投影不伪造差异）。
//   - FIX-3（绑定离线时 onReconnect/commitEdgeLabel/removeEdge 拒绝 s-* 结构编辑）：需
//     制造绑定但未在线态，留作人工验证。
//
// 为保证 UI 连线稳定：先把流建入 SE（直连 WS，不经 vite），再预写「已绑定 SE 且节点坐标
// 分散」的工作区，让应用启动即投影到固定位置，避免节点重叠导致 handle 不可点。
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
const PORT = 5299;
const BASE = `http://localhost:${PORT}`;
const SYSTEM_ID = 'edges-s';
const TOKEN = `edges-${Date.now()}-${Math.random().toString(36).slice(2)}`;
import {
  resolveSeRuntimeForTests,
  spawnSe as spawnSeHelper,
  seEnvForTests,
} from './se-test-helper.mjs';
import {
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
// Part 1：纯函数单测（src/se/edges.js）
// ─────────────────────────────────────────────────────────────────────────────
async function unitTests() {
  const edgesMod = await import(pathToFileURL(path.join(ROOT, 'src/se/edges.js')).href);

  check('edgeTagKey 重导出自 tagOps', edgesMod.edgeTagKey('x') === 'edge.x');
  check('edgeTagTarget 重导出自 tagOps', edgesMod.edgeTagTarget('edge.x') === 'x');
  check('edgeId 稳定', edgesMod.edgeId('a', 'b') === 'se-e-a__b');

  const list = [
    { name: 'a', tags: { 'edge.b': '', 'edge.missing': 'gone', k: 'v' } },
    { name: 'b', tags: { 'edge.a': 'lab', 'edge.bad-name': '' } },
  ];
  const r = edgesMod.deriveEdgesFromTags(list);
  const ids = r.edges.map((e) => e.id).sort();
  check('派生：有效边', ids.includes('se-e-a__b') && ids.includes('se-e-b__a'), JSON.stringify(ids));
  check('派生：label 保留', r.edges.find((e) => e.id === 'se-e-b__a').label === 'lab');
  check(
    '派生：缺失/非法目标 → dangling',
    r.dangling.some((d) => d.source === 'a' && d.target === 'missing') &&
      r.dangling.some((d) => d.source === 'b' && d.target === 'bad-name'),
    JSON.stringify(r.dangling)
  );
  check('派生：普通标签不派生边', !r.edges.some((e) => e.target === 'k'));

  const self = edgesMod.deriveEdgesFromTags([{ name: 'solo', tags: { 'edge.solo': 'self' } }]);
  check('派生：自环边', self.edges.length === 1 && self.edges[0].source === 'solo' && self.edges[0].target === 'solo');

  const weird = edgesMod.deriveEdgesFromTags([{ name: 'x', tags: { 'edge.': '', 'edge.y': '1' } }]);
  check('派生：空目标忽略 + 缺目标入 dangling', weird.edges.length === 0 && weird.dangling.length === 1);

  // ── B2：级联应用层必须逐条容错、绝不抛出（不可在 UI 中稳定制造中断，故直测模块）──────
  const cascadeMod = await import(pathToFileURL(path.join(ROOT, 'src/se/cascade.js')).href);
  const calls = [];
  const flakyClient = {
    call: async (m, p) => {
      calls.push(`${m}:${p.name}:${p.key}`);
      if (m === 'stream.remove_tag' && p.name === 'boom') throw new Error('forced-fail');
      return {};
    },
  };
  let renameThrew = false;
  let renameFailures = [];
  try {
    renameFailures = await cascadeMod.applyRenameCascade(flakyClient, 'old', 'new', [
      { source: 'ok', label: 'L1' },
      { source: 'boom', label: 'L2' },
      { source: 'old', label: '' }, // 自环 → 落到 new
    ]);
  } catch (err) {
    renameThrew = true;
  }
  check('B2 applyRenameCascade 不抛出', !renameThrew);
  check(
    'B2 applyRenameCascade 收集失败且不阻断后续',
    renameFailures.length === 1 &&
      renameFailures[0].stream === 'boom' &&
      renameFailures[0].key === 'edge.new' &&
      /forced-fail/.test(renameFailures[0].actual),
    JSON.stringify(renameFailures)
  );
  check(
    'B2 自环改写落到新名（remove new/edge.old + set new/edge.new）',
    calls.includes('stream.remove_tag:new:edge.old') && calls.includes('stream.set_tag:new:edge.new'),
    JSON.stringify(calls)
  );

  let delThrew = false;
  let delFailures = [];
  try {
    delFailures = await cascadeMod.applyDeleteCascade(flakyClient, 'target', [
      { source: 'ok2' },
      { source: 'boom' },
    ]);
  } catch (err) {
    delThrew = true;
  }
  check('B2 applyDeleteCascade 不抛出且收集失败', !delThrew && delFailures.length === 1 && delFailures[0].stream === 'boom');

  const merged = cascadeMod.mergeCascadeDiffs(
    [
      { stream: 'a', key: 'edge.b', expected: '', actual: null },
      { stream: 'boom', key: 'edge.new', expected: 'L2', actual: null },
    ],
    [{ stream: 'boom', key: 'edge.new', expected: 'L2', actual: 'RPC 失败：forced-fail' }]
  );
  check(
    'B2 mergeCascadeDiffs 用错误描述覆盖同键通用差异、不重复',
    merged.length === 2 &&
      merged.some((d) => d.stream === 'a') &&
      merged.filter((d) => d.stream === 'boom' && /forced-fail/.test(d.actual)).length === 1,
    JSON.stringify(merged)
  );

  // ── FIX-2：diffEdgeRefs 只把「投影缺失」判为失败；有效投影绝不伪造差异 ──────────────
  // 回归锚点：旧行为下 reprojectSeSystem 对非活动系统返回 false，diffEdgeRefs 把「跳过」
  // 误判为「投影失败」而对每条期望边伪造 `(重投影失败)`。现非活动系统返回真实投影。
  const validProjection = {
    nodes: [],
    edges: [
      { id: 'se-e-a__b', source: 'a', target: 'b', label: '' },
      { id: 'se-e-b__a', source: 'b', target: 'a', label: 'lab' },
    ],
    dangling: [],
  };
  const noFabricated = cascadeMod.diffEdgeRefs(validProjection, [
    { source: 'a', target: 'b', label: '' },
    { source: 'b', target: 'a', label: 'lab' },
  ]);
  check('FIX-2 diffEdgeRefs 有效投影不伪造差异', noFabricated.length === 0, JSON.stringify(noFabricated));

  const realMismatch = cascadeMod.diffEdgeRefs(validProjection, [
    { source: 'a', target: 'b', label: 'changed' },
    { source: 'a', target: 'zzz', label: null },
  ]);
  check(
    'FIX-2 diffEdgeRefs 仍能报真实差异',
    realMismatch.length === 1 &&
      realMismatch[0].stream === 'a' &&
      realMismatch[0].key === 'edge.b' &&
      realMismatch[0].expected === 'changed',
    JSON.stringify(realMismatch)
  );

  const hardFailure = cascadeMod.diffEdgeRefs(false, [{ source: 'a', target: 'b', label: '' }]);
  check(
    'FIX-2 diffEdgeRefs 仅投影缺失时标为失败',
    hardFailure.length === 1 && /重投影失败/.test(hardFailure[0].actual),
    JSON.stringify(hardFailure)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 进程 / HTTP / WS 工具
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
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch (err) {
    /* 尽力而为 */
  }
}

/** 直连 SE（带 auth 帧），用于启动应用前预建流。 */
function connectSeDirect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch (err) {
        /* 忽略 */
      }
      reject(new Error('se direct open timeout'));
    }, 10000);
    ws.on('open', () => {
      clearTimeout(timer);
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
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) {
          const e = new Error(msg.error.message || 'rpc error');
          e.code = msg.error.code;
          if (msg.error.data) e.data = msg.error.data;
          rej(e);
        } else res(msg.result);
      });
      const call = (method, params = {}) =>
        new Promise((res, rej) => {
          const id = nextId++;
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ jsonrpc: '2.0', method, params, id }));
        });
      call('auth', { token: TOKEN })
        .then(() => resolve({ ws, call }))
        .catch(reject);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** 经 vite 代理的 SE RPC（ID 自增，notification 忽略）。 */
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
              if (msg.error.data) err.data = msg.error.data;
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
// Part 2：集成
// ─────────────────────────────────────────────────────────────────────────────
const BACKUP_FILES = ['graphs/.workspace.json', 'graphs/.frecency.json', 'graphs/.ui.json'].map((p) => path.resolve(ROOT, p));
const WORKSPACE = path.resolve(ROOT, 'graphs/.workspace.json');
const TAB_ID = 't-edges';

let se = null;
let vite = null;
let browser = null;
let rpcWs = null;
let pageErrors = [];
const backups = new Map();

/** 预写工作区：已绑定 SE 的 tab + 分散坐标的 s-* 节点（重投影保留坐标）。 */
function seedWorkspace() {
  fs.mkdirSync(path.dirname(WORKSPACE), { recursive: true });
  fs.writeFileSync(
    WORKSPACE,
    JSON.stringify({
      activeId: TAB_ID,
      tabs: [
        {
          id: TAB_ID,
          name: 'edges',
          system: { system_id: SYSTEM_ID, display_name: 'edges-s', manifest_path: null, storage_dir: `se-systems/${SYSTEM_ID}` },
        },
      ],
      store: {
        [TAB_ID]: {
          nodes: [
            { id: 's-edg_a', position: { x: 60, y: 80 }, data: { name: 'edg_a' } },
            { id: 's-edg_b', position: { x: 560, y: 80 }, data: { name: 'edg_b' } },
            { id: 's-edg_c', position: { x: 60, y: 440 }, data: { name: 'edg_c' } },
          ],
          edges: [],
          tools: {},
        },
      },
    })
  );
}

try {
  await unitTests();

  for (const f of BACKUP_FILES) {
    if (fs.existsSync(f)) {
      fs.copyFileSync(f, f + '.smk-bak');
      backups.set(f, true);
    }
  }

  cleanupSeSystem(SYSTEM_ID);
  if (await anyListener(PORT)) throw new Error(`端口 ${PORT} 已被占用，请先清理`);

  // ── 起 SE；直连预建 3 流；预写工作区；再起 vite ─────────────────────────────
  se = await spawnSe();
  const sePort = await waitRegistry();
  check('集成前置：SE 启动并落盘 registry', !!sePort, sePort ? `port=${sePort}` : seStderr);
  if (!sePort) throw new Error('SE 未就绪');

  let directWs = null;
  try {
    const direct = await connectSeDirect(sePort);
    directWs = direct.ws;
    await direct.call('stream.create', { name: 'edg_a' });
    await direct.call('stream.write', { name: 'edg_a', text: 'A' });
    await direct.call('stream.create', { name: 'edg_b' });
    await direct.call('stream.write', { name: 'edg_b', text: 'B' });
    await direct.call('stream.create', { name: 'edg_c' });
    await direct.call('stream.write', { name: 'edg_c', text: 'C' });
    check('前置：直连预建 3 流', true);
  } finally {
    if (directWs) {
      try {
        directWs.close();
      } catch (err) {
        /* 忽略 */
      }
    }
  }
  seedWorkspace();

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
  const seRpc = seRpcConn.rpc;

  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) pageErrors.push(m.text());
  });
  page.on('dialog', (d) => d.accept().catch(() => {}));

  const metaTags = async (name) => {
    try {
      const meta = await seRpc('stream.get_metadata', { name });
      return (meta && meta.tags) || {};
    } catch (err) {
      return null;
    }
  };
  const tag = async (name, key) => {
    const t = await metaTags(name);
    return t ? t[key] : undefined;
  };
  const nodeHandle = async (title) =>
    (
      await page.evaluateHandle(
        (t) => Array.from(document.querySelectorAll('.react-flow__node')).find((el) => (el.innerText || '').includes(t)) || null,
        title
      )
    ).asElement();
  const waitForCanvasNode = async (title, timeout = 20000) => {
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
  /** React Flow 节点自身的 translate 变换（= 流坐标落点），用于断言 rename 前后不跳位。 */
  const nodeTransform = (title) =>
    page.evaluate((t) => {
      const el = Array.from(document.querySelectorAll('.react-flow__node')).find((n) => (n.innerText || '').includes(t));
      return el ? el.style.transform : null;
    }, title);
  const activateRail = async (icon) => {
    for (const b of await page.$$('.rail-btn')) {
      if ((await b.textContent()).includes(icon)) {
        if ((await b.getAttribute('aria-pressed')) !== 'true') await b.click();
        break;
      }
    }
    await page.waitForTimeout(350);
  };
  const findHandle = async (node, type) => {
    let h = await node.$(`.react-flow__handle.${type}`);
    if (!h) h = await node.$(`.react-flow__handle-${type === 'source' ? 'bottom' : 'top'}`);
    return h;
  };
  const connectNodes = async (titleA, titleB, attempts = 3) => {
    // 选中节点会展开终端面板遮住底部 source handle：先折叠再取消选中。
    await page.evaluate(() => {
      document.querySelectorAll('.react-flow__node .terminal-panel.expanded .term-bar').forEach((b) => b.click());
    });
    await page.waitForTimeout(350);
    await page.mouse.click(1540, 920);
    await page.waitForTimeout(250);

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const before = await edgeCount();
      // 选中源节点：idle 尾巴（扫描条/终端）在未选中时被 CSS 隐藏，会改变节点高度进而移动底部
      // source handle；先选中使尾巴常驻，保证拖拽期间 handle 位置稳定。
      const aSel = await nodeHandle(titleA);
      if (!aSel) return false;
      await aSel.click();
      await page.waitForTimeout(300);
      const a = await nodeHandle(titleA);
      const b = await nodeHandle(titleB);
      if (!a || !b) return false;
      const sh = await findHandle(a, 'source');
      const th = await findHandle(b, 'target');
      if (!sh || !th) return false;
      const sbox = await sh.boundingBox();
      const tbox = await th.boundingBox();
      if (!sbox || !tbox) return false;
      // 连接点在节点边缘：`.agent-node` 现为 overflow:visible（重写了原 overflow:hidden 裁剪），
      // 故直接命中 handle 中心即可，无需再对准内侧四分之一。
      const sc = { x: sbox.x + sbox.width / 2, y: sbox.y + sbox.height / 2 };
      const tc = { x: tbox.x + tbox.width / 2, y: tbox.y + tbox.height / 2 };
      if (attempt === 0) {
        const diag = await page.evaluate(({ x, y }) => ({
          els: document.elementsFromPoint(x, y).slice(0, 4).map((e) => `${e.tagName}.${e.className}`),
          vw: window.innerWidth,
          vh: window.innerHeight,
        }), { x: tc.x, y: tc.y });
        console.log('CONN_DIAG', JSON.stringify({ sc, tc, diag }));
      }
      await page.mouse.move(sc.x, sc.y);
      await page.mouse.down();
      await page.mouse.move(tc.x, tc.y, { steps: 18 });
      await page.mouse.up();
      await page.waitForTimeout(1400);
      if ((await edgeCount()) > before) return true;
      // 异步重投影期间手势可能丢失 → 取消选中、静置后重试（重复连线会被应用拒绝，安全幂等）。
      await page.mouse.click(1540, 920);
      await page.waitForTimeout(700);
    }
    return false;
  };
  /** 改端点：抓住边靠 target 一端（SVG path 末端内 10px）拖到另一节点的 target handle。 */
  const rewireEdgeTo = async (toTitle) => {
    const pt = await page.evaluate(() => {
      const path = document.querySelector('.react-flow__edge-path');
      if (!path) return null;
      const len = path.getTotalLength();
      const p = path.getPointAtLength(Math.max(0, len - 10));
      const m = path.getScreenCTM();
      return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f };
    });
    if (!pt) return false;
    const b = await nodeHandle(toTitle);
    const th = b ? await findHandle(b, 'target') : null;
    if (!th) return false;
    const tb = await th.boundingBox();
    if (!tb) return false;
    await page.mouse.move(pt.x, pt.y);
    await page.waitForTimeout(250);
    await page.mouse.down();
    await page.waitForTimeout(150);
    await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 18 });
    await page.mouse.up();
    await page.waitForTimeout(1300);
    return true;
  };
  const edgeCount = () => page.evaluate(() => document.querySelectorAll('.react-flow__edge').length);
  const selectEdge = async () => {
    // 取边 path 中点，用真实鼠标点击选中（避免对 SVG path 的 viewport 检查）。
    const pt = await page.evaluate(() => {
      const path = document.querySelector('.react-flow__edge-path');
      if (!path) return null;
      const len = path.getTotalLength();
      const p = path.getPointAtLength(len * 0.5);
      const m = path.getScreenCTM();
      return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f };
    });
    if (!pt) return false;
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(450);
    return true;
  };
  const clickEdgeToolbar = (label) =>
    page.evaluate((text) => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === text);
      if (!b) return false;
      b.click();
      return true;
    }, label);
  const openEdgeLabelEditor = async () => {
    await selectEdge();
    if (await clickEdgeToolbar('编辑文字')) return true;
    return page.evaluate(() => {
      const p = document.querySelector('.react-flow__edge-path');
      if (!p) return false;
      p.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, view: window }));
      return true;
    });
  };
  /** 轮询等待流列表出现该名称项（列表随异步重投影刷新，直接查会偶发 miss）。 */
  const waitForStreamItem = async (title, timeout = 10000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const h = await page.evaluateHandle(
        (t) => Array.from(document.querySelectorAll('.stream-item')).find((e) => e.querySelector('.stream-name')?.textContent === t) || null,
        title
      );
      const el = h.asElement();
      if (el) return el;
      await page.waitForTimeout(250);
    }
    return null;
  };
  const streamItemRightClick = async (title, menuText) => {
    const el = await waitForStreamItem(title);
    if (!el) {
      const names = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.stream-item .stream-name')).map((e) => e.textContent)
      );
      console.log('NO_STREAM_ITEM', title, 'have=', JSON.stringify(names));
      return false;
    }
    await el.click({ button: 'right' });
    const menu = await page.waitForSelector('.context-menu', { timeout: 5000 }).catch(() => null);
    if (!menu) return false;
    return page.evaluate((text) => {
      const b = Array.from(document.querySelectorAll('.context-menu button')).find((x) => x.textContent.includes(text));
      if (!b) return false;
      b.click();
      return true;
    }, menuText);
  };

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow', { timeout: 15000 });
  await page.waitForSelector('.se-badge', { timeout: 25000 });
  check('前置：绑定 tab 投影 3 流', (await waitForCanvasNode('edg_a')) && (await waitForCanvasNode('edg_b')) && (await waitForCanvasNode('edg_c')));
  await activateRail('🌊');

  // ── (1) 边往返：UI 连线 A→B；reload 后派生还原 ─────────────────────────────
  const connected = await connectNodes('edg_a', 'edg_b');
  const tagsA = await metaTags('edg_a');
  check('(1) 连线 → tags["edge.edg_b"]===""', connected && !!tagsA && tagsA['edge.edg_b'] === '', JSON.stringify(tagsA));
  check('(1) 画布出现边', (await edgeCount()) >= 1, `edges=${await edgeCount()}`);

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow', { timeout: 15000 });
  await page.waitForSelector('.se-badge', { timeout: 25000 }).catch(() => {});
  let restored = false;
  for (let i = 0; i < 50; i += 1) {
    if ((await edgeCount()) >= 1) {
      restored = true;
      break;
    }
    await page.waitForTimeout(300);
  }
  check('(1) reload 后边经 stream.list 派生还原', restored, `edges=${await edgeCount()}`);
  await waitForCanvasNode('edg_a');

  // ── (2) 注释：选中边 → 编辑文字 → tag value 更新 ───────────────────────────
  if (await openEdgeLabelEditor()) {
    const input = await page.waitForSelector('.edge-edit-input', { timeout: 5000 }).catch(() => null);
    if (input) {
      await input.fill('EDGELABELZ');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1100);
      check('(2) 写注释 → tag value 更新', (await tag('edg_a', 'edge.edg_b')) === 'EDGELABELZ', JSON.stringify(await tag('edg_a', 'edge.edg_b')));
    } else {
      check('(2) 写注释', false, '未挂载 .edge-edit-input');
    }
  } else {
    check('(2) 写注释', false, '未能打开边编辑');
  }

  // ── (3) 改端点：A→B 拖到 A→C（旧键消失 + 新键出现 + 注释随迁）──────────────
  await rewireEdgeTo('edg_c');
  await page.waitForTimeout(600);
  {
    const t = await metaTags('edg_a');
    check('(3) 改端点 → 旧键 edge.edg_b 消失、新键 edge.edg_c 出现', !!t && !('edge.edg_b' in t) && 'edge.edg_c' in t, JSON.stringify(t));
    check('(3) 注释随迁', !!t && t['edge.edg_c'] === 'EDGELABELZ', JSON.stringify(t));
  }

  // ── (3b) 清空注释 → value ''（不删键）─────────────────────────────────────
  if (await openEdgeLabelEditor()) {
    const input2 = await page.waitForSelector('.edge-edit-input', { timeout: 5000 }).catch(() => null);
    if (input2) {
      await input2.fill('');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1100);
      const t = await metaTags('edg_a');
      check('(3b) 清空 → value 变 ""（键仍在）', !!t && 'edge.edg_c' in t && t['edge.edg_c'] === '', JSON.stringify(t));
    } else {
      check('(3b) 清空注释', false, '未挂载编辑框');
    }
  } else {
    check('(3b) 清空注释', false, '未能打开边编辑');
  }

  // ── (3c) 删边：选中边 → 工具栏「删除」→ tag 键消失 ────────────────────────
  if (await selectEdge()) {
    const clicked = await clickEdgeToolbar('删除');
    await page.waitForTimeout(1400);
    const t = await metaTags('edg_a');
    check('(3c) 删边 → tag 键消失', clicked && !!t && !('edge.edg_c' in t), JSON.stringify(t));
  } else {
    check('(3c) 删边', false, '未能选中边');
  }

  // ── (4) 自环 A→A ───────────────────────────────────────────────────────────
  await connectNodes('edg_a', 'edg_a');
  check('(4) 自环 A→A 成立', (await tag('edg_a', 'edge.edg_a')) === '', JSON.stringify(await metaTags('edg_a')));

  // ── (5) rename 级联 ────────────────────────────────────────────────────────
  await connectNodes('edg_a', 'edg_b');
  await connectNodes('edg_c', 'edg_a');
  await page.waitForTimeout(900);
  await seRpc('stream.set_tag', { name: 'edg_c', key: 'edge.edg_a', value: 'KEEPLAB' });
  // B3：改名时节点 id s-<old>→s-<new>，缓存必须随迁；否则节点跳回默认落点且内容短暂丢失。
  await seRpc('stream.write', { name: 'edg_a', text: 'BDY_CONTENT_MARK' });
  await page.waitForTimeout(900);
  const posBeforeRename = await nodeTransform('edg_a');
  const renamed = await streamItemRightClick('edg_a', '重命名');
  check('(5) 右键菜单出现「重命名」', renamed);
  if (renamed) {
    await page.waitForSelector('.modal input[type="text"]', { timeout: 5000 });
    await page.fill('.modal input[type="text"]', 'edg_d');
    await page.click('.modal .dlg-actions .primary');
    // 改名确认已由原生 window.confirm 改为应用内 Modal（避免原生模态打断画布指针手势）：
    // 提交侧栏改名表单后，还需在确认框点一次「确认改名」。
    await page.waitForSelector('.modal h3:has-text("确认改名")', { timeout: 5000 });
    await page.click('.modal .dlg-actions .primary');
    await page.waitForTimeout(2200);
    const posAfterRename = await nodeTransform('edg_d');
    check(
      '(5) B3 rename 后节点位置保持（不跳默认落点）',
      !!posBeforeRename && posAfterRename === posBeforeRename,
      `before=${posBeforeRename} after=${posAfterRename}`
    );
    const contentKept = await page.evaluate(
      () =>
        Array.from(document.querySelectorAll('.react-flow__node')).some(
          (n) => (n.innerText || '').includes('BDY_CONTENT_MARK')
        )
    );
    check('(5) B3 rename 后内容未丢失', contentKept);
    const list = await seRpc('stream.list', {});
    const names = (list || []).map((s) => s.name);
    check('(5) rename 生效（edg_d 有、edg_a 无）', names.includes('edg_d') && !names.includes('edg_a'), JSON.stringify(names));
    const td = await metaTags('edg_d');
    check('(5) 无 edge.edg_a 残留、D 仍有 edge.edg_b', !!td && !('edge.edg_a' in td) && 'edge.edg_b' in td, JSON.stringify(td));
    const tc = await metaTags('edg_c');
    check('(5) C 的入边刷新为 edge.edg_d 且注释保留', !!tc && tc['edge.edg_d'] === 'KEEPLAB' && !('edge.edg_a' in tc), JSON.stringify(tc));
    check('(5) 全库无 edge.edg_a 残留', !(list || []).some((s) => s.tags && 'edge.edg_a' in s.tags));
    // 根因回归：在线改名必须把 app-owned 镜像 .md 与 source.file_path 一起迁移。
    const edgeDocPath = path.resolve(ROOT, 'graphs', 'edges.se.json');
    let edgeDoc = null;
    try {
      edgeDoc = JSON.parse(fs.readFileSync(edgeDocPath, 'utf8'));
    } catch {
      edgeDoc = null;
    }
    const dRow = edgeDoc && Array.isArray(edgeDoc.streams)
      ? edgeDoc.streams.find((s) => s && s.name === 'edg_d')
      : null;
    check(
      '(5) 改名后 .se.json source 指向新镜像',
      !!dRow && dRow.source && dRow.source.file_path === 'edges.streams/edg_d.md',
      JSON.stringify(dRow)
    );
    check(
      '(5) 改名后新镜像文件存在',
      fs.existsSync(path.resolve(ROOT, 'graphs', 'edges.streams', 'edg_d.md'))
    );
    check(
      '(5) 改名后旧镜像文件不存在',
      !fs.existsSync(path.resolve(ROOT, 'graphs', 'edges.streams', 'edg_a.md'))
    );
  } else {
    check('(5) rename 级联', false, '未打开对话框');
  }

  // ── (6) delete 级联：删除 B（被 D→B 引用）──────────────────────────────────
  const delOpened = await streamItemRightClick('edg_b', '删除流');
  check('(6) 右键菜单出现「删除流…」', delOpened);
  if (delOpened) {
    await page.waitForSelector('.modal .dlg-actions .primary.danger', { timeout: 5000 });
    const dlgText = await page.evaluate(() => document.querySelector('.modal .dlg-note')?.textContent || '');
    check('(6) 删除对话框显示「指向它的连线」入边数', /指向它的连线/.test(dlgText), dlgText);
    await page.click('.modal .dlg-actions .primary.danger');
    await page.waitForTimeout(2200);
    const td = await metaTags('edg_d');
    check('(6) 删除 B → D 的 edge.edg_b 键消失', !!td && !('edge.edg_b' in td), JSON.stringify(td));
    const list = await seRpc('stream.list', {});
    check('(6) B 已删除', !(list || []).some((s) => s.name === 'edg_b'));
  } else {
    check('(6) delete 级联', false, '未打开删除对话框');
  }

  // ── (7) 悬空边：外部删除目标 → 横幅 → 逐条清除 ─────────────────────────────
  await connectNodes('edg_d', 'edg_c'); // D（已改名 edg_d）→ C
  await page.waitForTimeout(900);
  const td7 = await metaTags('edg_d');
  if (!td7 || !('edge.edg_c' in td7)) {
    await seRpc('stream.set_tag', { name: 'edg_d', key: 'edge.edg_c', value: '' });
  }
  await seRpc('stream.set_tag', { name: 'edg_d', key: 'edge.ghost', value: 'gone' }); // 目标缺失 = 悬空
  await seRpc('stream.create', { name: '外部' });
  await seRpc('stream.write', { name: '外部', text: 'x' }); // 未知流 → 重投影
  let bannerSeen = false;
  for (let i = 0; i < 50; i += 1) {
    bannerSeen = await page.evaluate(() => /悬空边/.test(document.querySelector('.se-dangling-banner')?.textContent || ''));
    if (bannerSeen) break;
    await page.waitForTimeout(300);
  }
  check('(7) 外部删除目标 → 悬空边横幅出现', bannerSeen);
  if (bannerSeen) {
    await page.evaluate(() => document.querySelector('.se-dangling-banner button')?.click());
    await page.waitForSelector('.dangling-list', { timeout: 5000 }).catch(() => {});
    const hasBatch = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.modal button')).some((b) => /全部清除|批量/.test(b.textContent))
    );
    check('(7) 对话框无「全部清除」批量按钮', !hasBatch);
    const cleared = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.dangling-row'));
      const row = rows.find((r) => r.textContent.includes('ghost')) || rows[0];
      if (!row) return false;
      const btn = Array.from(row.querySelectorAll('button')).find((b) => b.textContent.trim() === '清除');
      if (!btn) return false;
      btn.click();
      return true;
    });
    check('(7) 逐条「清除」可点', cleared);
    await page.waitForTimeout(1800);
    const td2 = await metaTags('edg_d');
    check('(7) 清除后 edge.ghost 键消失', !!td2 && !('edge.ghost' in td2), JSON.stringify(td2));
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.modal button')).find((x) => x.textContent.trim() === '关闭');
      if (b) b.click();
    });
    await page.waitForTimeout(300);
  }

  // ── (8) 保留前缀：edge.* 不入 chips/pills；搜索可命中边注释 ──────────────────
  await seRpc('stream.set_tag', { name: 'edg_d', key: 'edge.edg_c', value: 'SEARCHTOKEN' });
  await seRpc('stream.create', { name: '外部2' });
  await seRpc('stream.write', { name: '外部2', text: 'z' });
  await page.waitForTimeout(1800);
  const chipsHaveEdge = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.stream-tags .tag-chip')).some((c) => c.textContent.includes('edge.'))
  );
  check('(8) edge.* 不出现在流 chips', !chipsHaveEdge);
  const pillsHaveEdge = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.tfbar-key')).some((c) => c.textContent.includes('edge'))
  );
  check('(8) edge.* 不出现在过滤 pills', !pillsHaveEdge);
  await page.fill('.tfbar-search input', 'SEARCHTOKEN');
  await page.waitForTimeout(800);
  const searchHitD = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.stream-item')).some(
      (e) => e.querySelector('.stream-name')?.textContent === 'edg_d'
    )
  );
  check('(8) 搜索可命中边注释（流D 显示）', searchHitD);
  await page.fill('.tfbar-search input', '');
  await page.waitForTimeout(400);

  // ── (9) B1 回归：删除带自环的流（自身引用不得使删除级联失败）────────────────
  // 自环 A→A 时流 A 自身持有 edge.A，旧实现把它算作「入边引用」，删除后 remove_tag(A)
  // 抛 StreamNotFoundError → 删除级联中断、节点残留。此处断言不再发生。
  await seRpc('stream.create', { name: '自环流' });
  await seRpc('stream.write', { name: '自环流', text: 'SELF' });
  await waitForCanvasNode('自环流');
  await seRpc('stream.set_tag', { name: '自环流', key: 'edge.自环流', value: 'self' });
  await seRpc('stream.create', { name: '外部3' });
  await seRpc('stream.write', { name: '外部3', text: 'w' }); // 未知流 → 重投影（纳入自环 tag）
  await page.waitForTimeout(1200);
  const delSelf = await streamItemRightClick('自环流', '删除流');
  check('(9) B1 右键删除自环流对话框出现', delSelf);
  if (delSelf) {
    await page.waitForSelector('.modal .dlg-actions .primary.danger', { timeout: 5000 });
    await page.click('.modal .dlg-actions .primary.danger');
    await page.waitForTimeout(2200);
    const list = await seRpc('stream.list', {});
    check('(9) B1 自环流已从 SE 删除', !(list || []).some((s) => s.name === '自环流'));
    check(
      '(9) B1 无 edge.自环流 残留（无新悬空）',
      !(list || []).some((s) => s.tags && 'edge.自环流' in s.tags)
    );
    const selfOnCanvas = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.react-flow__node')).some((n) => (n.innerText || '').includes('自环流'))
    );
    check('(9) B1 自环流节点消失（删除级联未被自环引用中断）', !selfOnCanvas);
    const cascadeDialog = await page.evaluate(() => /级联校验未收敛/.test(document.body.innerText));
    check('(9) B1 无级联修复对话框（自环不入级联）', !cascadeDialog);
  } else {
    check('(9) B1 自环流删除级联', false, '未打开删除对话框');
  }

  const realErrors = pageErrors.filter((e) => !/favicon|React DevTools/i.test(e));
  check('控制台无错误', realErrors.length === 0, realErrors.slice(0, 3).join(' || '));

  await page.screenshot({ path: '.sisyphus/smoke-se-edges.png' });
} catch (err) {
  check('冒烟执行', false, String((err && err.stack) || err) + ' || PAGEERR=' + pageErrors.slice(0, 4).join(' || '));
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
  cleanupSeSystem(SYSTEM_ID);
  // 本用例 seed 的 workspace 里全是测试 tab：清掉运行时派生出来的 SE storage。
  for (const id of workspaceSystemIds(WORKSPACE)) cleanupSeSystem(id);
  for (const f of BACKUP_FILES) {
    const bak = f + '.smk-bak';
    if (backups?.get(f) && fs.existsSync(bak)) {
      fs.copyFileSync(bak, f);
      fs.rmSync(bak, { force: true });
    } else if (fs.existsSync(bak)) {
      fs.rmSync(bak, { force: true });
    }
  }
  purgeTestTabsFromWorkspace(WORKSPACE);
  cleanupGraphArtifacts(SYSTEM_ID);
  // 这个 tab 名为 'edges'，auto-sync 会落到 graphs/edges.se.json + graphs/edges.streams/（一并清除）。
  cleanupGraphArtifacts('edges');
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
