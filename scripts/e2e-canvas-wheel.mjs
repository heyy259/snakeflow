// React Flow 统一滚轮契约（playwright-core + 系统 Chrome；当前旧实现应红，新实现应绿）。
//
// 契约：renderer 内一次真实 wheel = 一次平移，或 Ctrl+wheel = 一次半指数精细缩放；
// 平移时 zoom 不变、节点内部不原生滚动、指针锚点不漂移，且不被 d3 再处理一次。
// 只读 `.react-flow__viewport` 的 computed transform；不访问 d3 / React Flow 私有 store，
// 不注入生产测试钩子，不向 renderer 派发 synthetic wheel。Shift/Ctrl 由真实键盘按住表达。
//
// 隔离：SE preflight + 独立端口 + 独占 ASCII 配置/正文/storage；四个用户状态文件先备份，
// finally 关闭浏览器与 vite 进程树后完整还原。运行：node scripts/e2e-canvas-wheel.mjs。
import { chromium } from 'playwright-core';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sePreflightSkip, cleanupGraphArtifacts } from './se-ui-helper.mjs';
import {
  ROOT,
  spawnViteSe,
  waitForServer,
  anyListener,
  closeViteGracefully,
  cleanupSeStorage,
  pythonProcesses,
} from './se-test-helper.mjs';

const PORT = 5301;
const BASE = `http://localhost:${PORT}`;
const TS = Date.now().toString(36);
const SID = `wheel-${TS}`;
const TAB_ID = 't-canvas-wheel';
const GRAPHS = path.join(ROOT, 'graphs');
const WS_FILE = path.join(GRAPHS, '.workspace.json');
const FIXTURE = path.join(GRAPHS, `${SID}.se.json`);
const STREAM_DIR = path.join(GRAPHS, `${SID}.streams`);
const STORAGE_DIR = path.join(ROOT, 'se-systems', SID);
const USER_FILES = [
  WS_FILE,
  path.join(GRAPHS, '.frecency.json'),
  path.join(GRAPHS, '.ui.json'),
  path.join(GRAPHS, '.snippets.json'),
];
const NODE_A = 'WheelA';
const NODE_B = 'WheelB';
const NODE_A_SEL = `.react-flow__node[data-id="s-${NODE_A}"]`;
const NODE_B_SEL = `.react-flow__node[data-id="s-${NODE_B}"]`;
const WATCHDOG_MS = 300000;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 2;
const PAN_SPEED = 1.15;

await sePreflightSkip();
if (await anyListener(PORT)) {
  console.error(`FAIL  独立端口 ${PORT} 已被占用；未写入任何测试文件`);
  process.exit(1);
}

const results = [];
const cleanupErrors = [];
const backups = [];
let tempDir = null;
let vite = null;
let browser = null;
let watchdogTimer = null;
let cleaned = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const near = (a, b, tolerance = 0.75) =>
  Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
const brief = (vp) =>
  vp
    ? `{x:${vp.x.toFixed(3)}, y:${vp.y.toFixed(3)}, zoom:${vp.zoom.toFixed(6)}}`
    : 'null';

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${String(detail).slice(0, 700)}` : ''}`);
}

function must(value, message) {
  if (!value) throw new Error(`FIXTURE/SETUP: ${message}`);
  return value;
}

async function attempt(label, action) {
  try {
    await action();
  } catch (err) {
    const detail = `${label}: ${(err && err.message) || String(err)}`;
    cleanupErrors.push(detail);
    console.warn(`WARN  清理 ${detail}`);
  }
}

function removeFile(file) {
  if (!fs.existsSync(file)) return true;
  try {
    fs.unlinkSync(file);
  } catch (err) {
    cleanupErrors.push(`unlink ${file}: ${(err && err.message) || String(err)}`);
  }
  return !fs.existsSync(file);
}

// OneDrive/中文路径下不调用 fs.rmSync；仅删除本测试独占 temp 目录。
function removeTree(dir) {
  if (!dir || !fs.existsSync(dir)) return true;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    cleanupErrors.push(`readdir ${dir}: ${(err && err.message) || String(err)}`);
  }
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) removeTree(target);
    else removeFile(target);
  }
  try {
    fs.rmdirSync(dir);
  } catch (err) {
    cleanupErrors.push(`rmdir ${dir}: ${(err && err.message) || String(err)}`);
  }
  if (process.platform === 'win32' && fs.existsSync(dir)) {
    const out = spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', dir], { stdio: 'ignore' });
    if (out.error) cleanupErrors.push(`cmd rmdir ${dir}: ${out.error.message}`);
  }
  return !fs.existsSync(dir);
}

async function backupUserFiles() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-wheel-'));
  for (let i = 0; i < USER_FILES.length; i += 1) {
    const file = USER_FILES[i];
    const existed = fs.existsSync(file);
    const backup = path.join(tempDir, `user-${i}.bak`);
    if (existed) fs.copyFileSync(file, backup);
    backups.push({ file, backup, existed });
  }
}

async function restoreUserFiles() {
  let ok = true;
  for (const entry of backups) {
    let restored = false;
    let lastError = '';
    for (let attemptNo = 0; attemptNo < 5; attemptNo += 1) {
      try {
        if (entry.existed) {
          fs.copyFileSync(entry.backup, entry.file);
          restored = fs.readFileSync(entry.file).equals(fs.readFileSync(entry.backup));
        } else {
          if (fs.existsSync(entry.file)) fs.unlinkSync(entry.file);
          restored = !fs.existsSync(entry.file);
        }
        if (restored) break;
        lastError = '写后校验不一致';
      } catch (err) {
        lastError = (err && err.message) || String(err);
      }
      await sleep(350);
    }
    if (!restored) {
      ok = false;
      console.error(`FAIL  还原 ${entry.file}: ${lastError}`);
    }
  }
  return ok;
}

function seedFixture() {
  for (const target of [FIXTURE, STREAM_DIR, STORAGE_DIR]) {
    if (fs.existsSync(target)) throw new Error(`拒绝覆盖已有测试路径: ${target}`);
  }
  fs.mkdirSync(GRAPHS, { recursive: true });
  fs.mkdirSync(STREAM_DIR);
  const longBody = Array.from(
    { length: 80 },
    (_, i) => `Wheel native-scroll fixture line ${String(i + 1).padStart(2, '0')} — deterministic overflow content.`
  ).join('\n\n');
  fs.writeFileSync(path.join(STREAM_DIR, `${NODE_A}.md`), longBody, 'utf-8');
  fs.writeFileSync(
    path.join(STREAM_DIR, `${NODE_B}.md`),
    'Wheel readonly body selection anchor. Plain wheel must pan this descendant without zooming.',
    'utf-8'
  );
  fs.writeFileSync(
    WS_FILE,
    JSON.stringify({ activeId: TAB_ID, tabs: [{ id: TAB_ID, name: SID }] }),
    'utf-8'
  );
  fs.writeFileSync(path.join(GRAPHS, '.frecency.json'), '[]', 'utf-8');
  fs.writeFileSync(
    path.join(GRAPHS, '.ui.json'),
    JSON.stringify({
      sidebarWidth: 300,
      sidebarCollapsed: false,
      activePanel: 'streams',
      sortKey: 'name',
      sortDir: 'asc',
      colW: { size: 74, time: 122 },
    }),
    'utf-8'
  );
  fs.writeFileSync(path.join(GRAPHS, '.snippets.json'), '[]', 'utf-8');
  fs.writeFileSync(
    FIXTURE,
    JSON.stringify(
      {
        $schema: 'snake-manifest-v1',
        namespace: SID,
        streams: [
          {
            name: NODE_A,
            description: '',
            tags: {},
            id: `s-${NODE_A}`,
            source: { file_path: `${SID}.streams/${NODE_A}.md`, encoding: 'utf-8' },
          },
          {
            name: NODE_B,
            description: '',
            tags: {},
            id: `s-${NODE_B}`,
            source: { file_path: `${SID}.streams/${NODE_B}.md`, encoding: 'utf-8' },
          },
        ],
        tools: {},
        system: {
          name: SID,
          graph: {
            format_version: '5.0',
            edges: [],
            layout: {
              [NODE_A]: { x: 64, y: 64, width: 320, height: 220 },
              [NODE_B]: { x: 496, y: 80, width: 320 },
            },
            viewport: { x: 32, y: 24, zoom: 1 },
          },
        },
      },
      null,
      2
    ),
    'utf-8'
  );
}

function killPythonByStorage() {
  if (process.platform !== 'win32') return [];
  let pids = [];
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -like '*${SID}*' } | ForEach-Object { $_.ProcessId }`,
      ],
      { encoding: 'utf-8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 }
    );
    pids = String(out)
      .split(/\r?\n/)
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch (err) {
    cleanupErrors.push(`enumerate ${SID} python: ${(err && err.message) || String(err)}`);
  }
  for (const pid of pids) {
    const out = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 15000,
    });
    if (out.error) cleanupErrors.push(`taskkill python ${pid}: ${out.error.message}`);
  }
  return pids;
}

async function readViewport(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.react-flow__viewport');
    if (!el) throw new Error('FIXTURE/SETUP: .react-flow__viewport 不存在');
    const matrix = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    return { x: matrix.m41, y: matrix.m42, zoom: matrix.m11 };
  });
}

async function resetViewport(page) {
  await page.locator('.react-flow__controls-fitview').click();
  await page.waitForTimeout(450);
  return readViewport(page);
}

async function blankPoint(page) {
  const point = await page.evaluate(() => {
    const pane = document.querySelector('.react-flow__pane');
    if (!pane) return null;
    const r = pane.getBoundingClientRect();
    for (const fy of [0.82, 0.68, 0.48, 0.3, 0.9]) {
      for (const fx of [0.55, 0.72, 0.38, 0.25, 0.85]) {
        const x = r.left + r.width * fx;
        const y = r.top + r.height * fy;
        if (document.elementFromPoint(x, y) === pane) return { x, y };
      }
    }
    return null;
  });
  return must(point, '找不到未被节点/控件遮挡的空白 pane 坐标');
}

async function targetPoint(locator) {
  const box = await locator.boundingBox();
  must(box && box.width > 4 && box.height > 4, `目标不可见/无尺寸: ${locator}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// 所有 wheel 都是 Chrome 接收的真实指针输入；绝不 evaluate(dispatchEvent(new WheelEvent))。
async function wheelAt(page, point, deltaX, deltaY, modifier = null) {
  if (modifier) await page.keyboard.down(modifier);
  try {
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(deltaX, deltaY);
  } finally {
    if (modifier) await page.keyboard.up(modifier);
  }
  // duration:0 应已收敛；延迟取样同时捕获旧 d3 / 意外第二次处理造成的后续漂移。
  await page.waitForTimeout(280);
  return readViewport(page);
}

function checkPan(name, before, after, deltaX, deltaY) {
  const expected = {
    x: before.x - (deltaX / before.zoom) * PAN_SPEED,
    y: before.y - (deltaY / before.zoom) * PAN_SPEED,
    zoom: before.zoom,
  };
  check(
    `${name}: 一次 wheel 恰好平移一次且 zoom 不变`,
    near(after.x, expected.x) && near(after.y, expected.y) && near(after.zoom, expected.zoom, 0.0002),
    `before=${brief(before)} expected=${brief(expected)} actual=${brief(after)} delta=(${deltaX},${deltaY})`
  );
}

function checkStationary(name, before, after) {
  check(
    name,
    near(after.x, before.x) && near(after.y, before.y) && near(after.zoom, before.zoom, 0.0002),
    `before=${brief(before)} actual=${brief(after)}`
  );
}

async function readNodePosition(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    return { x: m.m41, y: m.m42 };
  }, selector);
}

function readSavedViewport() {
  try {
    const doc = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8').replace(/^\uFEFF/, ''));
    const vp = doc && doc.system && doc.system.graph && doc.system.graph.viewport;
    return vp && Number.isFinite(Number(vp.x)) && Number.isFinite(Number(vp.y)) && Number.isFinite(Number(vp.zoom))
      ? { x: Number(vp.x), y: Number(vp.y), zoom: Number(vp.zoom) }
      : null;
  } catch (err) {
    return null; // 原子替换/OneDrive 短暂读写窗口由轮询覆盖。
  }
}

async function waitSavedViewport(expected, timeoutMs = 12000) {
  const t0 = Date.now();
  let vp = null;
  while (Date.now() - t0 < timeoutMs) {
    vp = readSavedViewport();
    if (vp && near(vp.x, expected.x) && near(vp.y, expected.y) && near(vp.zoom, expected.zoom, 0.0002)) {
      return { ok: true, vp };
    }
    await sleep(300);
  }
  return { ok: false, vp };
}

async function waitRestoredViewport(page, expected, timeoutMs = 12000) {
  const t0 = Date.now();
  let vp = null;
  while (Date.now() - t0 < timeoutMs) {
    vp = await readViewport(page);
    if (near(vp.x, expected.x) && near(vp.y, expected.y) && near(vp.zoom, expected.zoom, 0.0002)) {
      return { ok: true, vp };
    }
    await page.waitForTimeout(250);
  }
  return { ok: false, vp };
}

async function cleanupAndExit(requestedCode = null) {
  if (cleaned) return;
  cleaned = true;
  if (watchdogTimer) clearTimeout(watchdogTimer);
  if (results.some((r) => !r.ok) && vite && typeof vite.getOutput === 'function') {
    console.log(`\n[vite output tail]\n${String(vite.getOutput()).slice(-1800)}`);
  }
  await attempt('关闭 Chrome', async () => {
    if (browser) await browser.close();
  });
  browser = null;
  await attempt('关闭 vite/SE 进程树', async () => {
    if (vite) await closeViteGracefully(vite);
  });
  vite = null;
  await sleep(800);
  killPythonByStorage();
  await attempt(`删除 SE storage ${SID}`, () => cleanupSeStorage({ id: SID }));
  await attempt(`删除图 fixture ${SID}`, async () => cleanupGraphArtifacts(SID));
  const restored = await restoreUserFiles();
  if (tempDir) removeTree(tempDir);
  const portFree = !(await anyListener(PORT));
  const orphanCommands = (await pythonProcesses()).filter((cmd) => cmd.includes(SID));
  const artifacts = [FIXTURE, STREAM_DIR, STORAGE_DIR, tempDir].filter((p) => p && fs.existsSync(p));
  check(
    'CLEANUP: 用户文件还原、端口/进程树释放、fixture/backup 无残留',
    restored && cleanupErrors.length === 0 && portFree && orphanCommands.length === 0 && artifacts.length === 0,
    `restored=${restored} portFree=${portFree} orphans=${orphanCommands.length} artifacts=${JSON.stringify(artifacts)} errors=${JSON.stringify(cleanupErrors.slice(0, 3))}`
  );
  console.log('GAP  可滚动 .term-log（移除 nowheel 后）未覆盖：公共 UI 无法确定性地制造真实进程日志溢出；未以合成日志弱化该行为断言。');
  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
  process.exit(requestedCode == null ? (failed.length ? 1 : 0) : requestedCode);
}

watchdogTimer = setTimeout(() => {
  console.error(`\nWATCHDOG: canvas-wheel 超过 ${WATCHDOG_MS / 1000}s，强制清理`);
  cleanupAndExit(2).catch((err) => {
    console.error(`WATCHDOG cleanup failed: ${(err && err.stack) || err}`);
    process.exit(2);
  });
}, WATCHDOG_MS);
process.once('SIGINT', () => {
  cleanupAndExit(130).catch((err) => {
    console.error(`SIGINT cleanup failed: ${(err && err.stack) || err}`);
    process.exit(130);
  });
});
process.once('SIGTERM', () => {
  cleanupAndExit(143).catch((err) => {
    console.error(`SIGTERM cleanup failed: ${(err && err.stack) || err}`);
    process.exit(143);
  });
});

try {
  await backupUserFiles();
  seedFixture();
  vite = await spawnViteSe({ port: PORT });
  try {
    await waitForServer(BASE, 45000);
  } catch (err) {
    throw new Error(`vite 未就绪: ${(err && err.message) || err}\n${vite.getOutput()}`);
  }
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  page.setDefaultTimeout(20000);
  page.on('pageerror', (err) => console.log(`[pageerror] ${err.stack || err.message}`));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.react-flow__viewport', { timeout: 30000 });
  await page.waitForSelector('.tab.active .tab-se-dot.se-dot-online', { timeout: 90000 });
  await page.waitForSelector(NODE_A_SEL, { timeout: 30000 });
  await page.waitForSelector(NODE_B_SEL, { timeout: 30000 });
  await page.waitForFunction(
    () => {
      const a = document.querySelector('.react-flow__node[data-id="s-WheelA"] .agent-content');
      const b = document.querySelector('.react-flow__node[data-id="s-WheelB"] .agent-content');
      return !!a && !!b && a.textContent.includes('native-scroll fixture') && b.textContent.includes('selection anchor');
    },
    null,
    { timeout: 30000 }
  );
  await page.waitForTimeout(700);
  check('SETUP: 真实 SE + 两节点正文 + computed viewport 就绪', true);

  // 1) 空白 pane：旧 zoomOnScroll 应在这里明确失败，而非启动/fixture 失败。
  let before = await resetViewport(page);
  let point = await blankPoint(page);
  let after = await wheelAt(page, point, 0, 80);
  checkPan('blank pane 普通纵向 wheel', before, after, 0, 80);

  // 2) 只读节点正文 descendant：nodrag 只管文本/拖拽，不应取消统一 wheel 平移。
  before = await resetViewport(page);
  point = await targetPoint(page.locator(`${NODE_B_SEL} .agent-content`));
  after = await wheelAt(page, point, 0, 64);
  checkPan('read-only node body 普通 wheel', before, after, 0, 64);

  // 只读正文文本选择放在 marquee/编辑之前，避免库级选区状态跨用例污染。
  // Range 仅测量真实字形坐标，不调用 selection.addRange；选择本身仍由真实 mouse drag 完成。
  before = await resetViewport(page);
  const textParagraph = page.locator(`${NODE_B_SEL} .agent-content .md-body p`).first();
  await textParagraph.waitFor({ state: 'visible' });
  const textDrag = await textParagraph.evaluate((p) => {
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    const textNode = walker.nextNode();
    if (!textNode || !textNode.nodeValue.includes('Wheel readonly')) return null;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, Math.min(20, textNode.nodeValue.length));
    const rect = range.getBoundingClientRect();
    return { x1: rect.left + 1, x2: rect.right - 1, y: rect.top + rect.height / 2 };
  });
  must(textDrag && textDrag.x2 - textDrag.x1 > 30, '只读正文真实字形范围不可见');
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await page.mouse.move(textDrag.x1, textDrag.y);
  await page.mouse.down();
  await page.mouse.move(textDrag.x2, textDrag.y, { steps: 16 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const selectedText = await page.evaluate(() => String(window.getSelection().toString() || '').trim());
  check('只读节点正文仍可选择文本', selectedText.length >= 4, JSON.stringify(selectedText));
  checkStationary('文本选择时 viewport 不动', before, await readViewport(page));

  // 3) Shift 纵向滚轮转横向；真实按住 Shift，不合成修饰事件。
  before = await resetViewport(page);
  point = await blankPoint(page);
  after = await wheelAt(page, point, 0, 72, 'Shift');
  checkPan('Shift+wheel 横向平移', before, after, 72, 0);

  // 4) trackpad-like XY 一次输入应各平移一次。
  before = await resetViewport(page);
  point = await blankPoint(page);
  after = await wheelAt(page, point, 36, 54);
  checkPan('trackpad-like XY wheel', before, after, 36, 54);

  // 5) Ctrl 小 wheel：d3 像素轮指数 0.002 的一半 = 0.001；锚点公式证明无双 d3。
  before = await resetViewport(page);
  point = await blankPoint(page);
  const rendererRect = await page.locator('.react-flow__renderer').boundingBox();
  must(rendererRect, 'renderer 无 boundingBox');
  const fineDelta = -12;
  const expectedFineZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, before.zoom * 2 ** (-fineDelta * 0.001)));
  const localX = point.x - rendererRect.x;
  const localY = point.y - rendererRect.y;
  const ratio = expectedFineZoom / before.zoom;
  const expectedFine = {
    x: localX - (localX - before.x) * ratio,
    y: localY - (localY - before.y) * ratio,
    zoom: expectedFineZoom,
  };
  after = await wheelAt(page, point, 0, fineDelta, 'Control');
  check(
    'Ctrl small-wheel: 半指数 fine zoom + 指针锚点 + 无双重 d3',
    near(after.x, expectedFine.x) && near(after.y, expectedFine.y) && near(after.zoom, expectedFine.zoom, 0.0002),
    `before=${brief(before)} expected=${brief(expectedFine)} actual=${brief(after)} deltaY=${fineDelta}`
  );

  // 6) 真实可滚动节点正文：统一画布平移时内部 scrollTop 必须不变。
  before = await resetViewport(page);
  const scrollWrap = page.locator(`${NODE_A_SEL} .agent-content-wrap`);
  const overflow = await scrollWrap.evaluate((el) => {
    el.scrollTop = 0;
    return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollTop: el.scrollTop };
  });
  must(overflow.scrollHeight > overflow.clientHeight + 20, `固定高度节点未形成真实 overflow: ${JSON.stringify(overflow)}`);
  point = await targetPoint(scrollWrap);
  after = await wheelAt(page, point, 0, 76);
  checkPan('scrollable node body wheel', before, after, 0, 76);
  const innerScrollTop = await scrollWrap.evaluate((el) => el.scrollTop);
  check('scrollable node body: 内部 scrollTop 不变', innerScrollTop === 0, `before=0 actual=${innerScrollTop}`);

  // 7) Milkdown：wheel 平移画布但编辑会话与焦点不被偷走。
  await resetViewport(page);
  await page.locator(`${NODE_B_SEL} .agent-content`).dblclick();
  const proseMirror = page.locator(`${NODE_B_SEL} .ProseMirror`);
  await proseMirror.waitFor({ state: 'visible', timeout: 30000 });
  await proseMirror.click();
  before = await readViewport(page);
  point = await targetPoint(proseMirror);
  after = await wheelAt(page, point, 0, 48);
  checkPan('Milkdown 编辑区 wheel', before, after, 0, 48);
  const milkdownFocused = await page.evaluate(() => {
    const pm = document.querySelector('.react-flow__node[data-id="s-WheelB"] .ProseMirror');
    return !!pm && document.activeElement === pm && pm.isContentEditable && !!document.querySelector('.agent-node.editing');
  });
  check('Milkdown wheel 后保留编辑态与焦点', milkdownFocused);

  // 8) 源码 textarea 同样平移并保持编辑焦点；nopan 不阻断此统一 wheel 契约。
  await page.locator('.flow-edit-hud [data-tb-source="1"]').click();
  const sourceEditor = page.locator(`${NODE_B_SEL} textarea.node-source-edit`);
  await sourceEditor.waitFor({ state: 'visible', timeout: 15000 });
  await sourceEditor.click();
  before = await readViewport(page);
  point = await targetPoint(sourceEditor);
  after = await wheelAt(page, point, 0, 44);
  checkPan('source editor wheel', before, after, 0, 44);
  const sourceFocused = await page.evaluate(() => {
    const source = document.querySelector('.react-flow__node[data-id="s-WheelB"] textarea.node-source-edit');
    return !!source && document.activeElement === source && !!document.querySelector('.agent-node.editing');
  });
  check('source editor wheel 后保留编辑态与焦点', sourceFocused);
  await page.locator('.flow-edit-hud .ntb-done').click();
  await page.waitForSelector('.agent-node.editing', { state: 'detached', timeout: 15000 });

  // 9) marquee：用库默认的公共 Shift selection key，避免当前 panOnDrag=true 抢占空白左拖。
  // Shift+拖选本身不能移动 viewport，松开完成选择；不是 synthetic modifier event。
  before = await resetViewport(page);
  const marquee = await page.evaluate((sel) => {
    const pane = document.querySelector('.react-flow__pane');
    const node = document.querySelector(sel);
    if (!pane || !node) return null;
    const pr = pane.getBoundingClientRect();
    const r = node.getBoundingClientRect();
    const candidates = [
      { start: { x: r.left - 28, y: r.top - 28 }, end: { x: r.right + 20, y: r.bottom + 20 } },
      { start: { x: r.right + 28, y: r.top - 28 }, end: { x: r.left - 20, y: r.bottom + 20 } },
      { start: { x: r.left - 28, y: r.bottom + 28 }, end: { x: r.right + 20, y: r.top - 20 } },
      { start: { x: r.right + 28, y: r.bottom + 28 }, end: { x: r.left - 20, y: r.top - 20 } },
    ];
    return candidates.find(
      (c) =>
        c.start.x > pr.left &&
        c.start.y > pr.top &&
        c.start.x < pr.right &&
        c.start.y < pr.bottom &&
        document.elementFromPoint(c.start.x, c.start.y) === pane
    ) || null;
  }, NODE_B_SEL);
  must(marquee, '找不到可发起 marquee 的空白起点');
  let marqueeVisible = false;
  let duringMarquee = before;
  await page.keyboard.down('Shift');
  try {
    await page.mouse.move(marquee.start.x, marquee.start.y);
    await page.mouse.down();
    await page.mouse.move(marquee.end.x, marquee.end.y, { steps: 12 });
    await page.waitForTimeout(180);
    marqueeVisible = (await page.locator('.react-flow__selection').count()) > 0;
    duringMarquee = await readViewport(page);
  } finally {
    await page.mouse.up();
    await page.keyboard.up('Shift');
  }
  await page.waitForTimeout(250);
  const selectedCount = await page.locator('.react-flow__node.selected').count();
  check('marquee 显示选择框并完成节点选择', marqueeVisible && selectedCount >= 1, `visible=${marqueeVisible} selected=${selectedCount}`);
  checkStationary('marquee 拖动期间 viewport 不动', before, duringMarquee);
  checkStationary('marquee 完成后 viewport 不动', before, await readViewport(page));

  // 10) 节点标题拖拽：节点移动，viewport 不动。
  before = await resetViewport(page);
  const nodePosBefore = await readNodePosition(page, NODE_B_SEL);
  point = await targetPoint(page.locator(`${NODE_B_SEL} .agent-title`));
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 72, point.y + 48, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const nodePosAfter = await readNodePosition(page, NODE_B_SEL);
  check(
    '节点标题拖拽仍可移动节点',
    !!nodePosBefore && !!nodePosAfter && (Math.abs(nodePosAfter.x - nodePosBefore.x) > 30 || Math.abs(nodePosAfter.y - nodePosBefore.y) > 30),
    `before=${JSON.stringify(nodePosBefore)} after=${JSON.stringify(nodePosAfter)}`
  );
  checkStationary('节点拖拽时 viewport 不动', before, await readViewport(page));

  // 12) MiniMap 是 renderer 外的独立交互面：其 wheel 缩放必须保留。
  before = await resetViewport(page);
  point = await targetPoint(page.locator('.react-flow__minimap'));
  after = await wheelAt(page, point, 0, -60);
  check('MiniMap wheel 仍可缩放', after.zoom > before.zoom + 0.0002, `before=${brief(before)} after=${brief(after)}`);

  // 13) Controls 不经统一 wheel listener：zoom in/out 按钮保持原语义。
  before = await resetViewport(page);
  await page.locator('.react-flow__controls-zoomin').click();
  await page.waitForTimeout(300);
  const afterZoomIn = await readViewport(page);
  check('Controls zoom-in 仍可缩放', afterZoomIn.zoom > before.zoom + 0.0002, `before=${brief(before)} after=${brief(afterZoomIn)}`);
  await page.locator('.react-flow__controls-zoomout').click();
  await page.waitForTimeout(300);
  const afterZoomOut = await readViewport(page);
  check('Controls zoom-out 仍可缩放', afterZoomOut.zoom < afterZoomIn.zoom - 0.0002, `before=${brief(afterZoomIn)} after=${brief(afterZoomOut)}`);

  // 14) 最后再做一次真实 wheel，经公共「保存」按钮落盘，reload 恢复同一最终 viewport。
  await resetViewport(page);
  point = await blankPoint(page);
  const finalViewport = await wheelAt(page, point, 0, 36);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const saved = await waitSavedViewport(finalViewport);
  check('公共保存保留最终 viewport', saved.ok, `expected=${brief(finalViewport)} disk=${brief(saved.vp)}`);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.react-flow__viewport', { timeout: 30000 });
  await page.waitForSelector(NODE_A_SEL, { timeout: 30000 });
  await page.waitForSelector(NODE_B_SEL, { timeout: 30000 });
  await page.waitForSelector('.tab.active .tab-se-dot.se-dot-online', { timeout: 90000 });
  const restoredViewport = await waitRestoredViewport(page, finalViewport);
  check('save/reload 恢复最终 viewport', restoredViewport.ok, `expected=${brief(finalViewport)} actual=${brief(restoredViewport.vp)}`);
} catch (err) {
  check('SETUP / E2E execution', false, (err && err.stack) || String(err));
}

await cleanupAndExit();
