// 「关闭绑定 SE 的标签页 → 立即重开同一配置项」回归 E2E（真实 snakeeats + Vite dev server + Chrome）。
//
// 回归 bug：关闭绑定 SE 的标签页后立即重开同一配置项 → 状态一直闪重连、工具注册失败。
// 修复语义（本测试的被测行为；不改 src）：
//   - closeTab 同步登记关闭任务（POST /api/se/end；服务端同步 taskkill 后才回包）；
//     重开路径 attachOrSpawn 会 await 该登记（等旧实例死透）再探活 / spawn；
//   - 在途异步握手带世代（epoch）守卫：关闭后不回写、不复活 client。
//
// 覆盖（严格按序，对应任务 a–i）：
//   (a) 经配置面板打开含 tools 的配置包 → 新建绑定 SE 的标签页；
//   (b) 等系统真实 online（/api/se/endpoint + .tab-se-dot.se-dot-online）；
//   (c) 记录旧实例 port；
//   (d) 点 .tab-close（window.confirm 自动接受）；
//   (e) 不插入额外等待，立即经配置面板重开同一配置项；
//   (f) 合理超时内回到 online，且此后 ~3s 状态不回落（无闪断循环）；
//   (g) /api/se/endpoint 的 port 与旧实例不同（全新实例），且旧端口不再监听；
//   (h) tool.list（经代理 WS，等价浏览器通路）含配置声明的全部工具；UI 工具列表无「注册失败」；
//   (i) 清理：关标签页 → 关 vite（killTree 连带托管 SE）→ 按 storage 清残 → 断言无 python 孤儿
//       → 还原工作区/偏好文件、删除测试配置副本。
//   (j) 布局单载体回归（本次 bug 盲区）：拖动唯一流节点（及可选右缘 resize）→ 关闭前断言
//       坐标/宽高已写入配置 `system.graph.layout` → 重开后节点坐标（与可选宽高）与拖动后一致。
//   (k) 删除流 → 立即关标签页（优雅停机+终态快照）→ 配置面板重开 → 已删流不复活
//       （画布无该节点 + 活文档 .se.json streams 无该流）。
//   (l) 新建流 → 编辑正文 → 关 → 重开 → 正文不回退（重开后正文 == 关闭前 == 磁盘正文，非空）。
//   (m) 已保存正文 → 关标签页/停 SE → 仅外部改隔离 .md → 先冷重启 SE 并证实快照仍旧 →
//       再重开 ReactFlow → SE/节点收敛到 file-fresh，自动保存稳定窗后磁盘字节不被陈旧稿回写。
//
// 隔离策略（重要）：不直接打开用户真实 graphs/manifest.se.json 所派生的 system_id
//   （本机 se-systems/manifest 已存在真实 SE 数据，绝不可触碰）；而是把 manifest.se.json
//   复制为 graphs/<唯一名>.se.json 作为测试配置项。相对路径（流正文 / tool_path）按配置文件
//   所在目录解析，复制后行为不变；测试 system_id/storage 均测试独占，可安全清理。
//   副本微调：仅测试副本去除流的 canvas:false（源 fixture 值），使唯一流节点可见可拖动；
//   并把流正文 source 从 manifest.streams/（真实仓库文件）重定位到 <TEST_ID>.streams/
//   （测试独占，removeFixture 连带清理），使 (k) 的「连同正文文件一起删除」与 (l) 的正文
//   写回只触测试副本目录，绝不碰真实 manifest.streams/。源 graphs/manifest.se.json 绝不动。
//
// 端口 5300（strictPort；先 anyListener 预检）。SE 不可用 / chrome 不可用 → SKIP（exit 0）。
// 看门狗 600s（(k)/(l)/(m) 追加三轮关→重开后需覆盖冷启动旧快照验证与自动保存稳定窗）：
// 超时强清 vite/SE/storage 并 exit 2，脚本永不无限挂起。
import { chromium } from 'playwright-core';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { sePreflightSkip } from './se-ui-helper.mjs';
import {
  ROOT,
  resolveSeRuntimeForTests,
  spawnViteSe,
  waitForServer,
  anyListener,
  closeViteGracefully,
  cleanupSeStorage,
  connectSeRpc,
  pythonProcesses,
} from './se-test-helper.mjs';

const RUNTIME = await resolveSeRuntimeForTests();

const PORT = 5300;
const BASE = `http://localhost:${PORT}`;
const TS = Date.now().toString(36);
// 种子 tab（id=t-seed，无 name → 由 tab.id 派生 system id 't-seed'）：保证关测试 tab 时
// 不会触发「最后一个 tab 的替补逻辑」，且其 system/storage 均测试独占。
const SEED_ID = 't-seed';
// 测试配置副本名 = 派生 system_id（deriveSystemId 对 ASCII 名直通）。
const TEST_ID = `e2e-cr-${TS}`;
// 布局回归锚点：fixture 唯一流（manifest.se.json → FLOW_EXAMPLE）；节点 id = SE 投影 id。
const NODE_NAME = 'FLOW_EXAMPLE';
const NODE_ID = `s-${NODE_NAME}`;
const FIXTURE_SRC = path.join(ROOT, 'graphs', 'manifest.se.json');
const FIXTURE = path.join(ROOT, 'graphs', `${TEST_ID}.se.json`);
const WS_FILE = path.join(ROOT, 'graphs', '.workspace.json');
const UI_FILE = path.join(ROOT, 'graphs', '.ui.json');
const FRECENCY_FILE = path.join(ROOT, 'graphs', '.frecency.json');
const BACKUP_FILES = [WS_FILE, UI_FILE, FRECENCY_FILE];
const WATCHDOG_MS = 600000;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 240) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 预检（无真实 SE → SKIP exit 0；先于任何文件改动）────────────────────────
await sePreflightSkip();
console.log(`  python:        ${RUNTIME.ok ? RUNTIME.python : ''}`);
console.log(`  packageParent: ${RUNTIME.ok ? RUNTIME.packageParent : ''}`);
console.log(`  system_id:     ${TEST_ID}（配置副本 ${TEST_ID}.se.json）  port: ${PORT}`);

// ── 读取源配置包：确认含 tools（本测试的断言基线）────────────────────────────
const manifest = JSON.parse(fs.readFileSync(FIXTURE_SRC, 'utf-8'));
const declaredTools = Object.keys(manifest.tools || {})
  .map((n) => String(n))
  .filter(Boolean);
if (declaredTools.length === 0) {
  console.log(`FAIL  fixture ${path.basename(FIXTURE_SRC)} 不含 tools，无法验证工具注册`);
  process.exit(1);
}

// ── 备份 / 还原用户数据 + 测试配置副本 ──────────────────────────────────────
const backups = new Map();
for (const f of BACKUP_FILES) {
  if (fs.existsSync(f)) {
    fs.copyFileSync(f, f + '.cr-bak');
    backups.set(f, true);
  }
}
async function restore() {
  for (const f of BACKUP_FILES) {
    const bak = f + '.cr-bak';
    if (backups.get(f) && fs.existsSync(bak)) {
      const want = fs.readFileSync(bak, 'utf-8');
      // vite 退出竞态：浏览器关闭后在途的工作区写请求仍可能晚于 restore 落盘，
      // 把种子工作区写回去（实证：.workspace.json 被 t-seed 覆盖）。写后校验，不一致重试。
      for (let attempt = 0; attempt < 5; attempt += 1) {
        fs.copyFileSync(bak, f);
        let cur = null;
        try { cur = fs.readFileSync(f, 'utf-8'); } catch { cur = null; }
        if (cur === want) break;
        await sleep(400);
      }
      try { fs.unlinkSync(bak); } catch { /* 忽略 */ }
    } else if (fs.existsSync(bak)) {
      try { fs.unlinkSync(bak); } catch { /* 忽略 */ }
    }
  }
}
fs.mkdirSync(path.join(ROOT, 'graphs'), { recursive: true });
fs.copyFileSync(FIXTURE_SRC, FIXTURE);
// 副本微调（只改测试副本）：源包唯一流带 canvas:false（隐藏）→ 画布不渲染、无法拖动。
// 去除该标签使节点可见，供 (j) 坐标/宽高回归；其余字段保持源包原样。
{
  const copyDoc = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8'));
  let revealed = false;
  for (const s of Array.isArray(copyDoc.streams) ? copyDoc.streams : []) {
    if (s && s.tags && typeof s.tags === 'object' && String(s.tags.canvas) === 'false') {
      delete s.tags.canvas;
      revealed = true;
    }
  }
  // 正文重定位（测试独占化）：源包流正文引用 manifest.streams/<名>.md（真实仓库跟踪文件）。
  // planDocumentSources「已有 source 即保留」→ 正文写回/删除(mode='file') 会直指真实文件。
  // 复制内容到 <TEST_ID>.streams/<同名> 并改写副本 source.file_path；removeFixture 连带清理。
  let relocated = 0;
  for (const s of Array.isArray(copyDoc.streams) ? copyDoc.streams : []) {
    const fp = s && s.source && typeof s.source === 'object' ? String(s.source.file_path || '') : '';
    if (!/^manifest\.streams\//i.test(fp)) continue;
    const base = fp.split('/').pop();
    const srcAbs = path.join(ROOT, 'graphs', fp);
    const dstAbs = path.join(ROOT, 'graphs', `${TEST_ID}.streams`, base);
    if (!base || !fs.existsSync(srcAbs)) continue;
    fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
    fs.copyFileSync(srcAbs, dstAbs);
    s.source.file_path = `${TEST_ID}.streams/${base}`;
    relocated += 1;
  }
  if (revealed || relocated) fs.writeFileSync(FIXTURE, JSON.stringify(copyDoc, null, 2), 'utf-8');
}
console.log(`  测试配置:     graphs/${TEST_ID}.se.json（复制自 manifest.se.json，tools=${declaredTools.length}，已去 canvas:false，正文重定位至 ${TEST_ID}.streams/）`);
console.log(`  工具基线:     ${declaredTools.join(', ')}`);

// 确定性工作区种子：仅一个无 system 的 tab（t-seed）→ 应用自动分配系统 't-seed'。
fs.writeFileSync(
  WS_FILE,
  JSON.stringify({
    activeId: 't-seed',
    tabs: [{ id: 't-seed', name: '' }],
    store: { 't-seed': { nodes: [], edges: [], tools: {}, viewport: null } },
  })
);

/** 递归删除（规避本机 Node v24.12.0 的 fs.rmSync 静默 no-op；与 helper 同法）。 */
function rmrfCrashSafe(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { /* 忽略 */ }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) rmrfCrashSafe(p);
    else { try { fs.unlinkSync(p); } catch { /* 忽略 */ } }
  }
  try { fs.rmdirSync(dir); } catch { /* 忽略 */ }
  if (process.platform === 'win32' && fs.existsSync(dir)) {
    try { spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', dir], { stdio: 'ignore' }); } catch { /* 忽略 */ }
  }
}

/** 删除测试配置副本及其兄弟 .streams/ 目录（应用写回正文时会在同目录生成）。 */
function removeFixture() {
  const targets = [FIXTURE, FIXTURE.replace(/\.se\.json$/i, '.streams')];
  for (const target of targets) {
    if (!fs.existsSync(target)) continue;
    let isDir = false;
    try { isDir = fs.statSync(target).isDirectory(); } catch { /* 忽略 */ }
    if (isDir) rmrfCrashSafe(target);
    else {
      try { fs.unlinkSync(target); } catch { /* 忽略 */ }
      if (fs.existsSync(target)) {
        try { spawnSync('cmd', ['/c', 'del', '/f', '/q', target], { stdio: 'ignore' }); } catch { /* 忽略 */ }
      }
    }
  }
}

// ── HTTP / TCP 工具（Node 侧直连 vite 代理，等价浏览器同源请求）──────────────
function httpGetJson(pathname, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: 'localhost', port: PORT, path: pathname, method: 'GET' },
      (res) => {
        let raw = '';
        res.setEncoding('utf-8');
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          clearTimeout(timer);
          let data = null;
          try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
          resolve({ status: res.statusCode, data, raw });
        });
      }
    );
    const timer = setTimeout(() => req.destroy(new Error(`GET ${pathname} timeout`)), timeoutMs);
    req.on('error', (err) => { clearTimeout(timer); reject(err); });
    req.end();
  });
}

/** Node 侧调用真实 /api/se/spawn：不经过应用标签页，供 (m) 先冷重启、后重开。 */
function httpPostJson(pathname, body, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body == null ? {} : body);
    const req = http.request(
      {
        host: 'localhost',
        port: PORT,
        path: pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf-8');
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          clearTimeout(timer);
          let data = null;
          try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
          resolve({ status: res.statusCode, data, raw });
        });
      }
    );
    const timer = setTimeout(() => req.destroy(new Error(`POST ${pathname} timeout`)), timeoutMs);
    req.on('error', (err) => { clearTimeout(timer); reject(err); });
    req.write(payload);
    req.end();
  });
}

/** 127.0.0.1 TCP 探测（SE 只绑 127.0.0.1；不用 localhost 防 ::1 解析误差）。 */
function probeTcp127(port, timeout = 800) {
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

// ── 浏览器侧辅助 ────────────────────────────────────────────────────────────
let browser = null;
let vite = null;
let watchdogTimer = null;

/** 附加页面诊断：浏览器侧错误 + /api/se/* 非 2xx 响应（含 body）打到 Node 控制台。 */
function attachDiag(page, tag) {
  page.on('pageerror', (e) => console.log(`[${tag}] PAGEERROR: ${e.stack || e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`[${tag}] CONSOLE.ERROR: ${m.text()}`);
  });
  page.on('response', async (r) => {
    const u = r.url();
    if (!/\/api\/se\//.test(u) || r.status() < 400) return;
    let body = '';
    try { body = String(await r.text()).slice(0, 300); } catch { /* 忽略 */ }
    console.log(`[${tag}] HTTP ${r.status()} ${u.replace(BASE, '')} ${body}`);
  });
}

/** 读测试 system 的 spawn 排他锁（诊断用：本机 Node 的 fs.rmSync 对文件静默 no-op，
 *  releaseSpawnLock 删不掉 → 同 vite 进程内二次 spawn 会被 "locked" 拒绝）。 */
function readSpawnLock() {
  const f = path.join(ROOT, 'se-systems', TEST_ID, '.spawn.lock');
  try {
    return fs.readFileSync(f, 'utf-8').trim();
  } catch {
    return null;
  }
}

/** 激活侧栏 rail 面板（同 smoke-tools/e2e 约定；折叠时再点一次展开）。 */
async function activateRail(page, icon) {
  for (const b of await page.$$('.rail-btn')) {
    if ((await b.textContent()).includes(icon)) {
      if ((await b.getAttribute('aria-pressed')) !== 'true') await b.click();
      break;
    }
  }
  await page.waitForTimeout(250);
  if (await page.$('.file-sidebar.collapsed')) {
    for (const b of await page.$$('.rail-btn')) {
      if ((await b.textContent()).includes(icon)) { await b.click(); break; }
    }
  }
  await page.waitForTimeout(350);
}

const cfgRowSel = () => `.cfg-row:has(.cfg-name:text-is("${TEST_ID}"))`;
const tabCloseSel = () => `.tab:has(.tab-name:text-is("${TEST_ID}")) .tab-close`;

/** 测试 tab 的 SE 状态点 class（tab 不存在 → null）。 */
const dotClassOf = (page) =>
  page.evaluate((n) => {
    const tab = [...document.querySelectorAll('.tab')].find(
      (t) => t.querySelector('.tab-name') && t.querySelector('.tab-name').textContent === n
    );
    const dot = tab ? tab.querySelector('.tab-se-dot') : null;
    return dot ? dot.className : null;
  }, TEST_ID);

// ── 布局断言工具（(j) 回归：坐标/宽高经 system.graph.layout 往返）───────────
/** 浮点近似比较（位置/宽高断言容差）。 */
const near = (a, b, tol = 1.5) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

/** 读 React Flow 节点自身 transform → flow 坐标（父级 viewport 平移/缩放不经此元素）。 */
async function nodeFlowPos(page, id) {
  return page.evaluate((nid) => {
    const el = document.querySelector(`.react-flow__node[data-id="${nid}"]`);
    if (!el) return null;
    const m = /matrix\(([^)]+)\)/.exec(getComputedStyle(el).transform || '');
    if (!m) return null;
    const p = m[1].split(',').map((v) => parseFloat(v));
    if (p.length < 6 || !Number.isFinite(p[4]) || !Number.isFinite(p[5])) return null;
    return { x: p[4], y: p[5] };
  }, id);
}

/** 轮询节点 flow 坐标直到与 expected 一致（容差 tol）；超时返回最后一次读数。 */
async function waitNodeFlowPos(page, id, expected, timeoutMs, tol = 1.5) {
  const t0 = Date.now();
  let pos = null;
  while (Date.now() - t0 < timeoutMs) {
    pos = await nodeFlowPos(page, id).catch(() => null);
    if (pos && expected && near(pos.x, expected.x, tol) && near(pos.y, expected.y, tol)) {
      return { ok: true, pos };
    }
    await sleep(400);
  }
  return { ok: false, pos };
}

/** 读节点 CSS 计算宽度（CSS px，不受父级 viewport 缩放影响）。 */
async function nodeCssWidth(page, id) {
  return page.evaluate((nid) => {
    const el = document.querySelector(`.react-flow__node[data-id="${nid}"]`);
    if (!el) return null;
    const w = parseFloat(getComputedStyle(el).width);
    return Number.isFinite(w) ? w : null;
  }, id);
}

/** 按住节点标题栏拖动（dx/dy 为屏幕像素）。正文区带 nodrag（只读文本可选），不可再从中心抓取。 */
async function dragNodeBy(page, id, dx, dy) {
  const node = page.locator(`.react-flow__node[data-id="${id}"]`);
  const titleBox = await node.locator('.agent-title').boundingBox().catch(() => null);
  const box = titleBox || (await node.boundingBox());
  if (!box) return false;
  const cx = box.x + box.width / 2;
  const cy = titleBox ? box.y + box.height / 2 : box.y + Math.min(box.height / 2, 12);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy + dy, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  return true;
}

/** 拖动节点右缘 resize 线（节点选中后才渲染；控件缺失/不可见 → false）。 */
async function resizeNodeRightBy(page, id, dx) {
  const control = page.locator(`.react-flow__node[data-id="${id}"] .react-flow__resize-control.right`);
  if ((await control.count()) === 0) return false;
  const box = await control.first().boundingBox();
  if (!box) return false;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  return true;
}

/** 读测试副本 .se.json 的 system.graph.layout（缺失/解析失败 → null）。 */
function readDocLayout() {
  try {
    const doc = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8').replace(/^\uFEFF/, ''));
    const l = doc.system && doc.system.graph ? doc.system.graph.layout : null;
    return l && typeof l === 'object' ? l : null;
  } catch {
    return null;
  }
}

/** 轮询落盘 layout 直到 predicate 满足（自动保存 600ms 防抖 + 写盘 + OneDrive 落盘延迟）。 */
async function waitDocLayout(pred, timeoutMs) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = readDocLayout();
    if (last && pred(last)) return { ok: true, layout: last };
    await sleep(300);
  }
  return { ok: false, layout: last };
}

// ── (k)/(l) 回归工具：文档 streams 列表 + 节点正文 + 磁盘正文 ─────────────
/** 读测试副本 .se.json 的流名数组（缺失/解析失败/非数组 → null）。 */
function readDocStreamNames() {
  try {
    const doc = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8').replace(/^\uFEFF/, ''));
    if (!Array.isArray(doc.streams)) return null;
    return doc.streams.map((s) => String((s && s.name) || ''));
  } catch {
    return null;
  }
}

/** 轮询落盘 streams 列表直到 predicate 满足（删除落盘 + 关停终态快照 + OneDrive 落盘延迟）。 */
async function waitDocStreams(pred, timeoutMs) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = readDocStreamNames();
    if (last && pred(last)) return { ok: true, names: last };
    await sleep(300);
  }
  return { ok: false, names: last };
}

/** 读节点正文全量：.agent-content 的 title 属性恒等于 data.content（节点缺失/编辑态 → null）。 */
async function nodeContent(page, id) {
  return page.evaluate((nid) => {
    const el = document.querySelector(`.react-flow__node[data-id="${nid}"] .agent-content`);
    return el ? el.getAttribute('title') : null;
  }, id);
}

/** 轮询节点正文直到 predicate 满足；超时返回最后一次读数。 */
async function waitNodeContent(page, id, pred, timeoutMs) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await nodeContent(page, id).catch(() => null);
    if (last != null && pred(last)) return { ok: true, content: last };
    await sleep(300);
  }
  return { ok: false, content: last };
}

/** 测试副本兄弟 .streams 目录下流正文文件（graphs/<TEST_ID>.streams/<名>.md）的绝对路径。 */
const streamFileAbs = (name) => path.join(ROOT, 'graphs', `${TEST_ID}.streams`, `${name}.md`);

/** 读流正文磁盘文件（缺失/读取失败 → null）。 */
function readStreamFile(name) {
  try {
    return fs.readFileSync(streamFileAbs(name), 'utf-8');
  } catch {
    return null;
  }
}

/** 轮询磁盘正文直到 predicate 满足（正文写回防抖 + OneDrive 落盘延迟）。 */
async function waitStreamFile(name, pred, timeoutMs) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = readStreamFile(name);
    if (last != null && pred(last)) return { ok: true, text: last };
    await sleep(300);
  }
  return { ok: false, text: last };
}

/** 正文比较归一（CRLF + 末尾空白差异不计）。 */
const normText = (s) => String(s).replace(/\r\n/g, '\n').trimEnd();
/** 失败诊断摘要（前 80 字符）。 */
const head80 = (s) => String(s == null ? '(null)' : s).slice(0, 80);

/** 轮询 endpoint 直到 online 且（可选）port != excludePort；超时返回最后一次数据。 */
async function waitEndpointOnline(timeoutMs, excludePort = null) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      last = (await httpGetJson(`/api/se/endpoint?system_id=${TEST_ID}`)).data;
    } catch (err) {
      last = { error: (err && err.message) || String(err) };
    }
    if (
      last &&
      last.status === 'online' &&
      Number.isInteger(Number(last.port)) &&
      Number(last.port) > 0 &&
      (excludePort == null || Number(last.port) !== Number(excludePort))
    ) {
      return last;
    }
    await sleep(400);
  }
  return last;
}

async function waitTabGone(page, timeoutMs = 30000) {
  return page
    .waitForFunction(
      (n) => ![...document.querySelectorAll('.tab-name')].some((e) => e.textContent === n),
      TEST_ID,
      { timeout: timeoutMs }
    )
    .then(() => true)
    .catch(() => false);
}

/** 等状态点转绿（瞬时绿也可能先到，真实性由 endpoint/tool.list 断言兜底）。 */
async function waitTabDotOnline(page, timeoutMs) {
  try {
    await page.waitForFunction(
      (n) => {
        const tab = [...document.querySelectorAll('.tab')].find(
          (t) => t.querySelector('.tab-name') && t.querySelector('.tab-name').textContent === n
        );
        return !!(tab && tab.querySelector('.tab-se-dot.se-dot-online'));
      },
      TEST_ID,
      { timeout: timeoutMs }
    );
    return true;
  } catch {
    return false;
  }
}

/** tool.list 行 → 名称数组（数组行 或 字典键 两种形状都容错）。 */
function listToolNames(raw) {
  if (Array.isArray(raw)) return raw.map((r) => (r && r.name != null ? String(r.name) : '')).filter(Boolean);
  if (raw && typeof raw === 'object') return Object.keys(raw);
  return [];
}

/** 单次经真实代理 WS 读取流正文；连接/RPC/响应形状失败均显式返回非 ok，绝不把 null 当正文。 */
async function readSeStreamContent(name, timeoutMs = 8000) {
  let client = null;
  try {
    client = await connectSeRpc({ vitePort: PORT, systemId: TEST_ID, timeout: timeoutMs });
    const raw = await client.call('stream.read', { name }, timeoutMs);
    if (!raw || typeof raw !== 'object' || !Object.prototype.hasOwnProperty.call(raw, 'text')) {
      return { ok: false, text: null, raw };
    }
    return { ok: true, text: raw.text != null ? String(raw.text) : '', raw };
  } catch (err) {
    return { ok: false, text: null, error: (err && err.message) || String(err) };
  } finally {
    try { if (client) client.close(); } catch { /* 忽略 */ }
  }
}

/** 轮询真实 SE 正文直到 predicate 满足；超时保留最后响应/错误供回归诊断。 */
async function waitSeStreamContent(name, pred, timeoutMs) {
  const t0 = Date.now();
  let last = null;
  let attempts = 0;
  while (Date.now() - t0 < timeoutMs) {
    attempts += 1;
    last = await readSeStreamContent(name);
    if (last.ok && pred(last.text)) return { ...last, ok: true, attempts };
    await sleep(300);
  }
  return { ...(last || { text: null }), ok: false, attempts };
}

/** 经代理 WS 轮询 tool.list，直到配置声明的工具全部存在。 */
async function waitToolsRegistered(timeoutMs) {
  const t0 = Date.now();
  let raw = null;
  let attempts = 0;
  while (Date.now() - t0 < timeoutMs) {
    attempts += 1;
    let client = null;
    try {
      client = await connectSeRpc({ vitePort: PORT, systemId: TEST_ID, timeout: 8000 });
      raw = await client.call('tool.list', {});
    } catch (err) {
      raw = `error: ${(err && err.message) || err}`;
    } finally {
      try { if (client) client.close(); } catch { /* 忽略 */ }
    }
    const names = listToolNames(raw);
    if (declaredTools.every((n) => names.includes(n))) return { ok: true, names, raw, attempts };
    await sleep(1000);
  }
  return { ok: false, names: listToolNames(raw), raw, attempts };
}

/** UI 工具面板：等「注册失败」判定稳定（行出现且无 .tool-status-failed → 立即返回；
 *  保持空列表到超时则按「无失败标注」放行，缺失行作为诊断信息由调用方打印）。 */
async function waitUiToolsSettled(page, timeoutMs) {
  const snapshot = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.tool-row')].map((r) => ({
        name: (r.querySelector('.tool-name') || {}).textContent || '',
        status: (r.querySelector('.tool-status') || {}).textContent || '',
        failed: !!r.querySelector('.tool-status-failed'),
      }))
    );
  const t0 = Date.now();
  let state = [];
  while (Date.now() - t0 < timeoutMs) {
    state = await snapshot();
    const failed = state.filter((r) => r.failed);
    if (failed.length) return { ok: false, failedRows: failed, missing: [], state };
    const names = state.map((r) => r.name);
    if (declaredTools.every((n) => names.includes(n))) return { ok: true, failedRows: [], missing: [], state };
    await sleep(400);
  }
  const failed = state.filter((r) => r.failed);
  const missing = declaredTools.filter((n) => !state.some((r) => r.name === n));
  return { ok: failed.length === 0, failedRows: failed, missing, state };
}

/** ~3s 稳定性观察：状态点持续绿 + endpoint 持续 online 且 port 不变。 */
async function observeStable(page, expectedPort, ms = 3000) {
  const samples = [];
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const cls = await dotClassOf(page).catch(() => null);
    let ep = null;
    try { ep = (await httpGetJson(`/api/se/endpoint?system_id=${TEST_ID}`)).data; } catch { ep = null; }
    samples.push({ cls, status: ep && ep.status, port: ep && ep.port });
    const ok =
      /se-dot-online/.test(cls || '') &&
      ep &&
      ep.status === 'online' &&
      Number(ep.port) === Number(expectedPort);
    if (!ok) {
      return { ok: false, detail: `第 ${samples.length} 次采样回退: ${JSON.stringify(samples[samples.length - 1])}` };
    }
    await sleep(250);
  }
  return { ok: true, detail: `${samples.length} 次采样持续 online @port ${expectedPort}` };
}

// ── 收尾（幂等；watchdog / SIGINT / 正常路径共用）────────────────────────────
let cleaned = false;
async function cleanupAndExit(code) {
  if (cleaned) return;
  cleaned = true;
  clearTimeout(watchdogTimer);
  // 失败诊断：vite 输出尾部（spawn 409/错误原因常在 dev server 侧）。
  if (results.some((r) => !r.ok) && vite && typeof vite.getOutput === 'function') {
    console.log(`\n[vite output tail]\n${String(vite.getOutput()).slice(-3000)}`);
  }
  try { if (browser) await browser.close(); } catch { /* 忽略 */ }
  browser = null;
  try { if (vite) await closeViteGracefully(vite); } catch { /* 忽略 */ }
  vite = null;
  await sleep(1200);

  // 兜底：vite 意外先死时，按 storage 找 python 并 taskkill（helper 的 cleanupSeStorage 只删目录）。
  // 先做孤儿核对（等待 ≤12s），再删 storage，避免「删目录时进程仍持句柄」干扰判定。
  const ourDirs = [path.join(ROOT, 'se-systems', TEST_ID), path.join(ROOT, 'se-systems', SEED_ID)];
  let orphans = [];
  const tOrphan = Date.now();
  while (Date.now() - tOrphan < 12000) {
    orphans = (await pythonProcesses()).filter((cmd) => ourDirs.some((d) => cmd.includes(d)));
    if (orphans.length === 0) break;
    await sleep(600);
  }
  check(
    '(i) 无本测试 storage 的 python 孤儿',
    orphans.length === 0,
    orphans.map((c) => String(c).slice(-120)).join(' || ')
  );

  await cleanupSeStorage({ id: TEST_ID });
  await cleanupSeStorage({ id: SEED_ID });
  removeFixture();
  await restore();
  const left = [TEST_ID, SEED_ID].filter((id) => fs.existsSync(path.join(ROOT, 'se-systems', id)));
  check('(i) storage 已清理无残留', left.length === 0, left.join(','));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
  process.exit(code);
}

watchdogTimer = setTimeout(() => {
  console.error('\nWATCHDOG: e2e-se-close-reopen 超时，强清退出');
  cleanupAndExit(2).catch(() => process.exit(2));
}, WATCHDOG_MS);
process.once('SIGINT', () => { cleanupAndExit(130).catch(() => process.exit(130)); });

// ── 主流程 ──────────────────────────────────────────────────────────────────
try {
  if (await anyListener(PORT)) throw new Error(`端口 ${PORT} 已被占用，请先清理`);
  await cleanupSeStorage({ id: TEST_ID });
  await cleanupSeStorage({ id: SEED_ID });

  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch (err) {
    console.log(`SKIP: chrome 不可用（${(err && err.message) || err}）`);
    await cleanupAndExit(0);
  }

  vite = await spawnViteSe({ port: PORT });
  try {
    await waitForServer(BASE, 45000);
  } catch (err) {
    throw new Error(`${err.message}\n[vite]\n${vite.getOutput()}`);
  }
  check(`vite 启动于 ${PORT}`, true);

  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  page.setDefaultNavigationTimeout(60000);
  attachDiag(page, 'cr');
  // 关闭标签页会弹 window.confirm（「将同时停止对应的 SE 系统…」）→ 预先接受。
  page.on('dialog', (d) => d.accept().catch(() => {}));
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.react-flow', { timeout: 20000 });

    // ── (a) 配置面板打开含 tools 的配置包 → 绑定 SE 的新标签页 ──────────────
    // createBoundTab 只接受 systemId、不加载配置包（无法注册工具），故首次创建同样走
    // 配置面板的「双击配置项」正常打开路径——与重开路径完全同源，最能复现回归场景。
    await activateRail(page, '⚙');
    // 先等配置面板完成首次 refresh（.cfg-row 出现），规避负载态下 panels 数据源未就绪的竞态。
    // 等应用壳就绪（rail 出现）再激活，规避启动繁忙期点击落空。
    await page.waitForSelector('.rail-btn', { timeout: 40000 }).catch(() => {});
    await activateRail(page, '⚙');
    // 面板可能因首次数据加载/重渲染尚未渲染 → 轮询重试激活，直到配置项行出现。
    for (let i = 0; i < 12; i += 1) {
      if ((await page.$$('.cfg-row')).length > 0) break;
      await activateRail(page, '⚙');
      await page.waitForTimeout(700);
    }
    await page.waitForFunction(
      (n) => [...document.querySelectorAll('.cfg-row')].some(
        (r) => r.querySelector('.cfg-name') && r.querySelector('.cfg-name').textContent === n
      ),
      TEST_ID,
      { timeout: 40000 }
    );
    check('(a) 配置面板列出测试配置项', true);
    await page.locator(cfgRowSel()).dblclick();
    await page.waitForFunction(
      (n) => [...document.querySelectorAll('.tab-name')].some((e) => e.textContent === n),
      TEST_ID,
      { timeout: 15000 }
    );
    check('(a) 打开配置项 → 新建绑定 SE 的标签页', true);

    // ── (b) 等系统 online（endpoint 真值；状态点绿由 (f) 稳定性观察最终背书）──
    const ep1 = await waitEndpointOnline(90000);
    check(
      '(b) 首次实例 endpoint online',
      !!(ep1 && ep1.status === 'online' && Number(ep1.port) > 0),
      JSON.stringify(ep1)
    );
    const dot1 = await waitTabDotOnline(page, 30000).then(() => dotClassOf(page)).catch(() => null);
    check('(b) 首次实例状态点 online（绿）', /se-dot-online/.test(dot1 || ''), `dot=${dot1}`);
    // 前置：首个实例已注册全部工具（关闭前具备完整运行态，回归才有意义）。
    const preTools = await waitToolsRegistered(60000);
    check(
      '(pre) 首个实例已注册全部配置工具（关闭前基线）',
      preTools.ok,
      `缺失=${declaredTools.filter((n) => !preTools.names.includes(n)).join(',') || '无'} raw=${String(JSON.stringify(preTools.raw)).slice(0, 160)}`
    );

    // ── (j) 布局基线 + 拖动 → 关闭前布局落盘（本次布局单载体改造的回归锚点）──
    await page.waitForSelector(`.react-flow__node[data-id="${NODE_ID}"]`, { timeout: 30000 }).catch(() => {});
    const posBefore = await nodeFlowPos(page, NODE_ID);
    check('(j) 布局基线：唯一流节点已渲染（拖动前坐标可读）', !!posBefore, JSON.stringify(posBefore));
    // 拖动（屏幕像素）→ 记录拖动后 flow 坐标：关闭→重开后必须一致。
    const dragged = posBefore
      ? await dragNodeBy(page, NODE_ID, 160, 120).then(() => nodeFlowPos(page, NODE_ID))
      : null;
    check(
      '(j) 拖动节点：坐标发生变化',
      !!posBefore && !!dragged && (!near(dragged.x, posBefore.x) || !near(dragged.y, posBefore.y)),
      `before=${JSON.stringify(posBefore)} after=${JSON.stringify(dragged)}`
    );
    // 尺寸交互（右缘 resize）：控件缺失/未生效则按任务约定降级为「至少断言坐标」。
    const widthBefore = await nodeCssWidth(page, NODE_ID);
    const resized = await resizeNodeRightBy(page, NODE_ID, 80);
    const widthDragged = resized ? await nodeCssWidth(page, NODE_ID) : null;
    const sizeTracked = !!(
      resized && widthBefore != null && widthDragged != null && Math.abs(widthDragged - widthBefore) > 4
    );
    console.log(
      sizeTracked
        ? `INFO 尺寸交互：width ${widthBefore} → ${widthDragged}`
        : 'INFO 尺寸交互不可用/未生效：仅断言坐标（任务允许的降级）'
    );
    const expectWidth = sizeTracked ? widthDragged : null;
    // 关闭前先等布局落盘（system.graph.layout 单载体）：既做断言真值，也避免「关闭→重开」竞态。
    const persisted = await waitDocLayout(
      (l) =>
        !!dragged &&
        !!l[NODE_NAME] &&
        near(Number(l[NODE_NAME].x), dragged.x) &&
        near(Number(l[NODE_NAME].y), dragged.y) &&
        (expectWidth == null || near(Number(l[NODE_NAME].width), expectWidth, 2)),
      20000
    );
    check(
      '(j) 拖动后布局已落盘 system.graph.layout（坐标 + 宽高）',
      persisted.ok,
      `layout=${JSON.stringify(persisted.layout && persisted.layout[NODE_NAME])} dragged=${JSON.stringify(dragged)} width=${expectWidth}`
    );

    // ── (c) 记录旧实例 port ────────────────────────────────────────────────
    const oldPort = Number(ep1 && ep1.port);
    check('(c) 记录旧实例 port', Number.isInteger(oldPort) && oldPort > 0, `oldPort=${oldPort}`);
    const lockAfterFirst = readSpawnLock();
    if (lockAfterFirst) {
      console.log(`INFO 首次 spawn 后 .spawn.lock 残留（本机 Node fs.rmSync 对文件 no-op）: ${lockAfterFirst}`);
    }

    // ── (d) 关闭标签页（confirm 自动接受）──────────────────────────────────
    await page.locator(tabCloseSel()).click();
    const closedD = await waitTabGone(page, 30000);
    check('(d) SE 停止后标签页才移除', closedD);
    // ── (e) 重开同一配置项 ─────────────────────────────────────────────────
    await page.locator(cfgRowSel()).dblclick();
    const reopenedTab = await page
      .waitForFunction(
        (n) => [...document.querySelectorAll('.tab-name')].some((e) => e.textContent === n),
        TEST_ID,
        { timeout: 15000 }
      )
      .then(() => true)
      .catch(() => false);
    check('(e) 立即重开 → 标签页恢复', reopenedTab);

    // ── (f) 合理超时内回到 online；状态点转绿 ─────────────────────────────
    const ep2 = await waitEndpointOnline(90000, oldPort);
    check(
      '(f) 重开后 endpoint 回到 online',
      !!(ep2 && ep2.status === 'online' && Number(ep2.port) > 0),
      `${JSON.stringify(ep2)} spawnLock=${readSpawnLock() || '(none)'}`
    );
    // (d) 环境护栏（产品行为相关）：本机 Node v24.12.0 的 fs.rmSync 对文件静默 no-op
    // → vite.config.js releaseSpawnLock 删不掉锁 → 首次 spawn 的 .spawn.lock 残留；同 vite
    // 进程内二次 spawn 被 acquireSpawnLock（新鲜 + 持有 pid 存活）拒绝 409 locked，重开永远
    // 起不来（状态闪重连）。此处以「首次锁是否原样未动」判定：正常 Node 下重开 spawn 会新建/
    // 重写/清理该锁 → 恒过；被阻塞时锁与首次完全一致。
    const lockAfterReopen = readSpawnLock();
    const staleLockUnchanged = !!lockAfterReopen && lockAfterReopen === lockAfterFirst;
    check(
      '(d) 重开未被首次 spawn 残留的 .spawn.lock 阻塞（锁已清理/重写）',
      !staleLockUnchanged,
      staleLockUnchanged
        ? `陈旧 lock 原样未动: ${lockAfterReopen}`
        : `lockAfterReopen=${lockAfterReopen || '(none)'} lockAfterFirst=${lockAfterFirst || '(none)'}`
    );
    await waitTabDotOnline(page, 30000);
    const dot2 = await dotClassOf(page);
    check('(f) 重开后状态点 online（绿）', /se-dot-online/.test(dot2 || ''), `dot=${dot2}`);

    // ── (g) 全新实例：port 不同 + 旧端口不再监听 ───────────────────────────
    const newPort = Number(ep2 && ep2.port);
    check(
      '(g) 全新实例：port 与旧实例不同（旧实例确实被杀）',
      Number.isInteger(newPort) && newPort > 0 && newPort !== oldPort,
      `oldPort=${oldPort} newPort=${newPort}`
    );
    const oldPortDead = Number.isInteger(oldPort) && oldPort > 0 ? !(await probeTcp127(oldPort)) : false;
    check('(g) 旧实例端口不再监听', oldPortDead, `oldPort=${oldPort}`);

    // ── (h) 工具注册成功：WS tool.list + UI 无「注册失败」───────────────────
    const tools2 = await waitToolsRegistered(60000);
    check(
      '(h) 重开后全部配置工具已注册（经代理 tool.list）',
      tools2.ok,
      `缺失=${declaredTools.filter((n) => !tools2.names.includes(n)).join(',') || '无'} 实得=${JSON.stringify(tools2.names).slice(0, 200)}`
    );
    await activateRail(page, '🧰');
    const ui = await waitUiToolsSettled(page, 8000);
    check(
      '(h) UI 工具列表无「注册失败」标注',
      ui.ok,
      `失败=${JSON.stringify(ui.failedRows).slice(0, 200)}`
    );
    if (ui.missing.length) {
      console.log(
        `INFO UI 未渲染工具行（注册真值以 tool.list 为准，不判定失败）: ${ui.missing.join(',')}`
      );
    }
    const unregistered = ui.state.filter((r) => r.status && !r.failed);
    if (unregistered.length) {
      console.log(`INFO UI 暂标未注册（tool.list 已证实注册成功，仅提示）: ${unregistered.map((r) => r.name).join(',')}`);
    }

    // ── (f) 稳定性：online 后观察 ~3s，状态点/端点不回落（无闪断循环）──────
    const stable = await observeStable(page, newPort, 3000);
    check('(f) online 后 ~3s 稳定（无闪断循环）', stable.ok, `${stable.detail} | dot=${await dotClassOf(page)}`);

    // ── (j) 关闭→重开：节点坐标（与宽高）与拖动后一致 ───────────────────────
    const reopened = await waitNodeFlowPos(page, NODE_ID, dragged, 30000);
    check(
      '(j) 重开：节点坐标与拖动后一致（system.graph.layout 往返）',
      reopened.ok,
      `expect=${JSON.stringify(dragged)} got=${JSON.stringify(reopened.pos)}`
    );
    if (expectWidth != null) {
      const widthReopened = await nodeCssWidth(page, NODE_ID);
      check(
        '(j) 重开：节点宽高与拖动后一致（layout width → style 往返）',
        widthReopened != null && near(widthReopened, expectWidth, 2.5),
        `expect=${expectWidth} got=${widthReopened}`
      );
    } else {
      console.log('INFO 尺寸交互未跟踪：重开仅断言坐标（任务允许的降级）');
    }

    // ── (k)/(l) 前置：新建陪跑流 L_REPLAY ─────────────────────────────────
    // 删唯一流会命中 B4 空投影守卫（orchestrator：SE 空列表 + 画布仍有 s-* 节点 → 拒落地，
    // 画布节点按设计保留；非本场景考察点），故先建陪跑流，使 (k) 删除的是非末流；
    // 陪跑流同时供 (l) 的「编辑→关→重开→正文不回退」复用。
    const L_NAME = 'L_REPLAY';
    const L_NODE_ID = `s-${L_NAME}`;
    const L_MARK = `E2E-L-REPLAY-${TS}`;
    const L_INIT = `init ${L_MARK}`;
    const L_EDITED = `${L_INIT}\n\nedited ${L_MARK} 正文不回退锚点`;
    const lNodeSel = `.react-flow__node[data-id="${L_NODE_ID}"]`;
    await activateRail(page, '🌊');
    await page.locator('.streams-panel button[title="新建流"]').click();
    const createDlg = page.locator('.modal:has(h3:text-is("新建流"))');
    await createDlg.waitFor({ timeout: 10000 });
    await createDlg.locator('input[placeholder="名称（必填）"]').fill(L_NAME);
    await createDlg.locator('textarea[placeholder^="初始内容"]').fill(L_INIT);
    await createDlg.locator('.dlg-actions button.primary').click();
    const lCreated = await page
      .waitForSelector(lNodeSel, { timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    check('(k/l) 前置：陪跑流节点已渲染', lCreated);
    // 等创建播种的正文就位（在线创建经 registerEntries/planImport 播种版本+正文，异步）。
    const seeded = await waitNodeContent(page, L_NODE_ID, (t) => t.includes(L_MARK), 15000);
    check('(k/l) 前置：陪跑流初始正文已就位', seeded.ok, head80(seeded.content));

    // ── (k) 删除流 → 立即关标签页（优雅停机+终态快照）→ 配置面板重开 → 不复活 ──
    // Tier-1 根因回归：历史上删除只进 SE 内存 + taskkill /F 硬杀 → 删除回退 → 复活。
    // 删除驱动（核实：src/sidebar/StreamItem.jsx 🗑 button[title="删除流…"] → App.jsx
    // openDeleteStream → 受控 DeleteStreamDialog）：画布键盘 Delete 只是「从画布移除」
    // （onBeforeDelete return false + canvas:false 隐藏），并非删除流；DeleteStreamDialog
    // 是 React ModalOverlay（非 window.confirm），page.on('dialog') 不受理，须点「删除」按钮
    // （button.danger，默认 mode='file' 连正文一起删——正文已重定位至 <TEST_ID>.streams/）。
    const streamRowSel = `.stream-item:has(.stream-name:text-is("${NODE_NAME}"))`;
    await page.waitForSelector(streamRowSel, { timeout: 15000 });
    // 行内操作按钮悬停才渲染（.stream-item:hover .stream-actions）→ 先 hover 再点。
    await page.locator(streamRowSel).hover();
    await page.locator(`${streamRowSel} button[title="删除流…"]`).click();
    // 绑定在线：openDeleteStream 先 await stream.list 抓入边引用再渲染确认框 → 等其出现。
    const delDlg = page.locator('.modal:has(h3:text-is("删除流"))');
    await delDlg.waitFor({ timeout: 15000 });
    await delDlg.locator('.dlg-actions button.danger').click();
    const nodeGone = await page
      .waitForFunction(
        (id) => !document.querySelector(`.react-flow__node[data-id="${id}"]`),
        NODE_ID,
        { timeout: 15000 }
      )
      .then(() => true)
      .catch(() => false);
    check('(k) 删除后节点从画布消失', nodeGone);
    // 立即关闭：压在风险窗口上（tab 关闭的 window.confirm 由 page.on('dialog') 自动受理，同场景 d）。
    await page.locator(tabCloseSel()).click();
    await waitTabGone(page, 30000);
    // 文档层断言：删除已耐久化——活文档 .se.json 的 streams 列表不含该流
    // （deleteStream 的 flushDeletion 立即落盘 + 关停终态快照兜底；轮询覆盖落盘延迟）。
    const docPurged = await waitDocStreams((names) => !names.includes(NODE_NAME), 15000);
    check(
      '(k) 删除已耐久化：.se.json streams 不含该流',
      docPurged.ok,
      `streams=${JSON.stringify(docPurged.names)}`
    );
    // 重开（配置面板双击，同场景 e；Task 10 起走活文档优先路径，断言语义不变）。
    // 当前 rail 停在 🌊（删除/新建在流面板操作）→ 先切回 ⚙ 配置面板再双击。
    await activateRail(page, '⚙');
    await page.locator(cfgRowSel()).dblclick();
    const ep3 = await waitEndpointOnline(90000, newPort);
    check('(k) 重开后 endpoint online', !!(ep3 && ep3.status === 'online'), JSON.stringify(ep3));
    const resurrected = await page
      .waitForSelector(`.react-flow__node[data-id="${NODE_ID}"]`, { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    check('(k) 已删除流重开后不复活（画布无该节点）', !resurrected);
    const docAfterReopen = await waitDocStreams((names) => !names.includes(NODE_NAME), 5000);
    check(
      '(k) 重开后文档 streams 仍不含该流',
      docAfterReopen.ok,
      `streams=${JSON.stringify(docAfterReopen.names)}`
    );
    const companionBack = await page
      .waitForSelector(lNodeSel, { timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    check('(k) 陪跑流重开后仍在画布（删除不误伤其它流）', companionBack);

    // ── (l) 编辑陪跑流正文 → 关 → 重开 → 正文不回退 ────────────────────────
    // Tier-1 根因回归：bindSystem 重建曾用挑包空 existingContents → 全量误判 contentChanged
    // → 无 CAS 覆盖写（陈旧包清空 SE 新内容）。断言重开后正文 == 关闭前正文（非空）且与磁盘一致。
    // 编辑驱动：双击 .agent-content 进就地编辑 → 工具栏 </> 切源码模式（textarea，规避 Milkdown
    // 驱动不确定性）→ 改写 → ✓完成（onExitEdit → exitEdit(true) → stream.write CAS）。
    await page.locator(`${lNodeSel} .agent-content`).dblclick();
    await page.waitForSelector('.flow-edit-hud .node-toolbar', { timeout: 10000 });
    await page.locator('.flow-edit-hud button[data-tb-source="1"]').click();
    const srcBox = page.locator(`${lNodeSel} textarea.node-source-edit`);
    await srcBox.waitFor({ timeout: 10000 });
    await srcBox.fill(L_EDITED);
    await page.waitForTimeout(800); // 源码→markdown 500ms 防抖桥接（exitEdit flush 兜底）
    await page.locator('.flow-edit-hud button.ntb-done').click();
    const committed = await waitNodeContent(page, L_NODE_ID, (t) => t.includes(`edited ${L_MARK}`), 15000);
    check('(l) 编辑已提交（节点正文含编辑锚点）', committed.ok, head80(committed.content));
    const beforeL = committed.ok ? committed.content : null;
    // 关闭前先等编辑稿写回磁盘正文文件（断言真值 + 避免关→开竞态）。
    const diskBefore = beforeL
      ? await waitStreamFile(L_NAME, (t) => normText(t) === normText(beforeL), 20000)
      : { ok: false, text: null };
    check(
      '(l) 编辑稿已写回磁盘正文文件',
      diskBefore.ok,
      `disk=${head80(diskBefore.text)} before=${head80(beforeL)}`
    );
    // 关 → 等待终止完成后重开（rail 停在 🌊，先切回 ⚙）。
    await page.locator(tabCloseSel()).click();
    await waitTabGone(page, 30000);
    await activateRail(page, '⚙');
    await page.locator(cfgRowSel()).dblclick();
    const ep4 = await waitEndpointOnline(90000, Number(ep3 && ep3.port));
    check('(l) 重开后 endpoint online', !!(ep4 && ep4.status === 'online'), JSON.stringify(ep4));
    const lBack = await page
      .waitForSelector(lNodeSel, { timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    check('(l) 重开后流节点仍在画布', lBack);
    // 内容加载可能滞后于节点渲染（contentState unknown→loaded）→ 轮询到非空再断言。
    const settledL = await waitNodeContent(page, L_NODE_ID, (t) => t.trim().length > 0, 20000);
    const afterL = settledL.content;
    check('(l) 重开后正文非空（已加载）', settledL.ok, head80(afterL));
    check(
      '(l) 正文不回退：重开后 == 关闭前',
      settledL.ok && beforeL != null && afterL === beforeL,
      `before=${head80(beforeL)} after=${head80(afterL)}`
    );
    const diskAfter = readStreamFile(L_NAME);
    check(
      '(l) 磁盘正文与重开后一致（未被陈旧包覆盖）',
      diskAfter != null && afterL != null && normText(diskAfter) === normText(afterL),
      `disk=${head80(diskAfter)} after=${head80(afterL)}`
    );

    // ── (m) 停机外部改文件 → 冷启动旧快照 → 重开时 file-fresh 优先 ──────────
    // 关键顺序不可换：先在 (l) 的已保存旧稿上关停真实 SE；仅在旧端口确认关闭后写隔离正文；
    // 再经 /api/se/spawn 拉起同 storage，并在配置标签页仍不存在时 stream.read 证实旧快照；
    // 最后才让 ReactFlow 重开。否则无法区分「文件优先」与「SE 启动时已直接读到新文件」。
    let latestSePort = ep4 && ep4.port ? Number(ep4.port) : newPort;
    const M_MARK = `E2E-M-FILE-FRESH-${TS}`;
    const M_FILE_FRESH = `${beforeL || L_EDITED}\n\nfile-fresh ${M_MARK}`;
    const mFreshBytes = Buffer.from(M_FILE_FRESH, 'utf-8');
    const mPrecondition = !!(
      beforeL &&
      beforeL.trim().length > 0 &&
      diskBefore.ok &&
      !beforeL.includes(M_MARK) &&
      M_FILE_FRESH !== beforeL
    );
    check(
      '(m) 非空已保存旧稿与唯一 file-fresh 标记可区分（非空断言前置）',
      mPrecondition,
      `old=${head80(beforeL)} fresh=${head80(M_FILE_FRESH)}`
    );
    if (!mPrecondition) throw new Error('(m) 缺少已保存旧稿，拒绝执行可空通过的冷启动场景');

    await page.locator(tabCloseSel()).click();
    const mClosed = await waitTabGone(page, 30000);
    const mOldPort = Number(ep4 && ep4.port);
    let mOldPortDead = false;
    const tMDead = Date.now();
    while (Date.now() - tMDead < 30000) {
      if (Number.isInteger(mOldPort) && mOldPort > 0 && !(await probeTcp127(mOldPort))) {
        mOldPortDead = true;
        break;
      }
      await sleep(400);
    }
    check('(m) 配置标签页已关闭且旧 SE 端口已停止', mClosed && mOldPortDead, `tabGone=${mClosed} oldPort=${mOldPort}`);
    if (!mClosed || !mOldPortDead) throw new Error('(m) 旧 SE 未确认停止，拒绝在运行中伪做停机外部编辑');

    // 停机窗口只改这个测试独占的陪跑流 .md；不改 .se.json、工作区或任何真实 fixture。
    fs.writeFileSync(streamFileAbs(L_NAME), mFreshBytes);
    let mDownBytes = null;
    try { mDownBytes = fs.readFileSync(streamFileAbs(L_NAME)); } catch { mDownBytes = null; }
    const mExternalWriteExact = !!mDownBytes && mDownBytes.equals(mFreshBytes);
    check(
      '(m) 停机期间仅隔离 backing .md 已逐字节改为 file-fresh',
      mExternalWriteExact,
      `path=${streamFileAbs(L_NAME)} bytes=${mDownBytes ? mDownBytes.length : '(unreadable)'}`
    );
    if (!mExternalWriteExact) throw new Error('(m) 外部 file-fresh 写盘未逐字节确认');

    // 不经过应用标签页先冷重启：SE 只能从关闭时 snapshot/journal 恢复，正文应仍旧。
    const mSpawn = await httpPostJson('/api/se/spawn', { system_id: TEST_ID });
    const ep5 = mSpawn && mSpawn.data;
    const mSpawnOnline = !!(
      mSpawn.status === 200 &&
      ep5 &&
      ep5.status === 'online' &&
      Number.isInteger(Number(ep5.port)) &&
      Number(ep5.port) > 0 &&
      Number(ep5.port) !== mOldPort
    );
    check('(m) 应用未重开前真实 SE 已冷重启为新实例', mSpawnOnline, JSON.stringify(ep5));
    if (!mSpawnOnline) throw new Error(`(m) 冷重启失败: HTTP ${mSpawn.status} ${JSON.stringify(ep5)}`);
    latestSePort = Number(ep5.port);

    // 这是非空场景的核心反证：若这里已含 M_MARK，后面的 file-fresh 收敛就不能证明应用对齐。
    const mColdRead = await readSeStreamContent(L_NAME);
    const mTabStillGone = await page.evaluate(
      (n) => ![...document.querySelectorAll('.tab-name')].some((e) => e.textContent === n),
      TEST_ID
    );
    check(
      '(m) 重开应用前 RPC 证实冷恢复 SE 仍逐字持有旧稿（尚无 file-fresh）',
      mColdRead.ok && mColdRead.text === beforeL && !mColdRead.text.includes(M_MARK),
      `old=${head80(beforeL)} restored=${head80(mColdRead.text)} error=${mColdRead.error || ''}`
    );
    check('(m) 上述旧快照 RPC 采样时应用配置标签页仍关闭', mTabStillGone, `tabGone=${mTabStillGone}`);

    // 现在才重开 ReactFlow：期待 orchestrator 文件对齐推动 SE，再投影到节点，而非反向回写旧稿。
    await activateRail(page, '⚙');
    await page.locator(cfgRowSel()).dblclick();
    const mReopenedTab = await page
      .waitForFunction(
        (n) => [...document.querySelectorAll('.tab-name')].some((e) => e.textContent === n),
        TEST_ID,
        { timeout: 15000 }
      )
      .then(() => true)
      .catch(() => false);
    const ep6 = await waitEndpointOnline(90000);
    if (ep6 && ep6.status === 'online' && Number(ep6.port) > 0) latestSePort = Number(ep6.port);
    const mDotOnline = await waitTabDotOnline(page, 30000);
    check(
      '(m) ReactFlow 已重开并附着到刚验证过旧快照的同一 SE',
      mReopenedTab && mDotOnline && !!(ep6 && ep6.status === 'online') && Number(ep6.port) === Number(ep5.port),
      `tab=${mReopenedTab} dot=${mDotOnline} coldPort=${ep5.port} endpoint=${JSON.stringify(ep6)}`
    );

    // 并发轮询两个真实可观测面；唯一 M_MARK 防止旧稿/空稿/初始 fixture 造成假绿。
    const [mSeFresh, mNodeFresh] = await Promise.all([
      waitSeStreamContent(L_NAME, (t) => t.includes(M_MARK), 30000),
      waitNodeContent(page, L_NODE_ID, (t) => t.includes(M_MARK), 30000),
    ]);
    check(
      '(m) 重开后真实 SE 已对齐到外部 file-fresh',
      mSeFresh.ok && mSeFresh.text.includes(M_MARK),
      `text=${head80(mSeFresh.text)} error=${mSeFresh.error || ''} attempts=${mSeFresh.attempts}`
    );
    check(
      '(m) 重开后 ReactFlow 节点已对齐到外部 file-fresh',
      mNodeFresh.ok && mNodeFresh.content.includes(M_MARK),
      `node=${head80(mNodeFresh.content)}`
    );

    // 覆盖 600ms 自动保存防抖、SE 回写及 OneDrive 落盘窗口；最终必须逐字节仍是外部新稿。
    await sleep(4000);
    let mStableBytes = null;
    try { mStableBytes = fs.readFileSync(streamFileAbs(L_NAME)); } catch { mStableBytes = null; }
    check(
      '(m) 自动保存稳定窗后 backing .md 字节仍等于 file-fresh（无陈旧稿回写）',
      !!mStableBytes && mStableBytes.equals(mFreshBytes),
      `expectBytes=${mFreshBytes.length} actualBytes=${mStableBytes ? mStableBytes.length : '(unreadable)'} disk=${head80(mStableBytes)}`
    );

    // ── (i) 清理：关重开后的标签页（系统随关）──────────────────────────────
    await page.locator(tabCloseSel()).click().catch(() => {});
    const tabGone = await waitTabGone(page, 30000);
    check('(i) 清理：重开标签页已关闭', tabGone);
    let portDead = false;
    const tDead = Date.now();
    // 放宽窗口（10s→30s）：本机 Python/OneDrive/taskkill 子进程开销大，关闭可能接近 12s 预算。
    const finalPort = latestSePort;
    while (Date.now() - tDead < 30000) {
      if (!(await probeTcp127(finalPort))) { portDead = true; break; }
      await sleep(400);
    }
    check('(i) 清理：当前测试实例已停止（端口关闭）', portDead, `port=${finalPort}`);
  } finally {
    await page.close().catch(() => {});
  }
} catch (err) {
  check('e2e 执行', false, String((err && err.stack) || err));
}

await cleanupAndExit(results.some((r) => !r.ok) ? 1 : 0);
