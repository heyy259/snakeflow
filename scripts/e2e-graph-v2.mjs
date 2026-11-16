// 图 v2 浏览器端到端（playwright-core + 系统 Chrome）：懒加载 + 纯指针工作区 + tab 重命名。
//
// 自隔离：临时改写 `graphs/.workspace.json` 为纯指针探针（1 个 ASCII tab），铺好探针配置
// `graphs/__v2e2e.se.json` + 正文 `graphs/__v2e2e.streams/NodeA.md`；跑完**完整还原**并清理。
// 不触碰真实图谱配置（工作区里只有探针 tab）。OneDrive 下用 unlinkSync（避免非 ASCII rmSync 崩溃）。
// P7：每个 tab 强制绑定真实 SE，探针 tab（name=__v2e2e）会自动分配同名 system 并拉起。
// 运行：node scripts/e2e-graph-v2.mjs（全绿退出码 0）。
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { sePreflightSkip, seEnv, cleanupSeSystem } from './se-ui-helper.mjs';

const ROOT = process.cwd();
const PORT = 5197;
const BASE = `http://localhost:${PORT}`;
const GRAPHS = path.join(ROOT, 'graphs');
const WS = path.join(GRAPHS, '.workspace.json');
const WS_BAK = path.join(GRAPHS, '.workspace.v2e2e.bak');
const PROBE = '__v2e2e';
const PROBE_RENAMED = '__v2e2e_renamed';
const PROBE_CFG = path.join(GRAPHS, `${PROBE}.se.json`);
const PROBE_DIR = path.join(GRAPHS, `${PROBE}.streams`);
const REN_CFG = path.join(GRAPHS, `${PROBE_RENAMED}.se.json`);
const REN_DIR = path.join(GRAPHS, `${PROBE_RENAMED}.streams`);
const PROBE_TEXT = 'probe-line-1\nprobe-line-2';
// P7：探针 tab 自动绑定的 system id（由 tab name 派生），finally 清理其 storage。
const PROBE_SID = PROBE;

await sePreflightSkip();

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 180) : ''}`);
};
const safeUnlink = (p) => { try { fs.unlinkSync(p); } catch { /* ignore */ } };
const safeRmdir = (p) => { try { fs.rmdirSync(p); } catch { /* ignore */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForServer(url, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      http.get(url, (res) => { res.resume(); resolve(); }).on('error', () => {
        if (Date.now() - t0 > timeout) reject(new Error('server timeout'));
        else setTimeout(tick, 400);
      });
    };
    tick();
  });
}

let hadWorkspace = false;
let server = null;
let browser = null;
let watchdog = null;

function cleanup() {
  if (watchdog) clearTimeout(watchdog);
  try { if (browser) browser.close(); } catch { /* ignore */ }
  try { if (server && server.pid) spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
  // 还原工作区（hadWorkspace 判定，绝不误删真实文件）。
  try {
    if (hadWorkspace && fs.existsSync(WS_BAK)) fs.copyFileSync(WS_BAK, WS);
    else if (!hadWorkspace && fs.existsSync(WS)) safeUnlink(WS);
    safeUnlink(WS_BAK);
  } catch { /* ignore */ }
  // 清理探针产物。
  for (const p of [PROBE_CFG, REN_CFG]) safeUnlink(p);
  for (const p of [path.join(REN_DIR, 'NodeA.md'), path.join(REN_DIR, 'NodeB.md'), path.join(PROBE_DIR, 'NodeA.md')]) safeUnlink(p);
  safeRmdir(REN_DIR);
  safeRmdir(PROBE_DIR);
  // P7：清理自动绑定 SE 的 storage（vite 树已被 taskkill）。
  cleanupSeSystem(PROBE_SID);
}

try {
  // 1. 备份工作区，铺探针（纯指针 + v2 配置 + 正文）。
  hadWorkspace = fs.existsSync(WS);
  if (hadWorkspace) fs.copyFileSync(WS, WS_BAK);
  fs.writeFileSync(WS, JSON.stringify({ activeId: 't-v2e2e', tabs: [{ id: 't-v2e2e', name: PROBE }] }), 'utf-8');
  fs.mkdirSync(PROBE_DIR, { recursive: true });
  fs.writeFileSync(path.join(PROBE_DIR, 'NodeA.md'), PROBE_TEXT, 'utf-8');
  fs.writeFileSync(
    PROBE_CFG,
    JSON.stringify(
      {
        version: '3.0',
        system: { name: PROBE },
        streams: [
          {
            id: 'n-1',
            name: 'NodeA',
            description: '',
            tags: {},
            position: { x: 80, y: 80 },
            source: { file_path: `${PROBE}.streams/NodeA.md`, encoding: 'utf-8' },
          },
        ],
        edges: [],
        tools: {},
      },
      null,
      2
    ),
    'utf-8'
  );

  server = spawn('npx.cmd', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
    shell: true,
    env: await seEnv(),
  });
  watchdog = setTimeout(() => {
    check('看门狗：超时强制退出', false);
    cleanup();
    const f = results.filter((r) => !r.ok);
    console.log(`\n==== ${results.length - f.length}/${results.length} PASS ====`);
    process.exit(2);
  }, 120000);

  await waitForServer(BASE);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow', { timeout: 15000 });
  // P7：探针 tab 自动绑定 SE 并迁移本地图；等 SE 在线 + 迁移投影完成后再断言节点。
  await page
    .waitForSelector('.tab-se-dot.se-dot-online', { timeout: 90000 })
    .catch(() => {});
  await sleep(800);

  // 2. 懒加载：探针节点应被渲染（标题 + 正文）。
  await page.waitForSelector('.react-flow__node', { timeout: 60000 });
  await sleep(500);
  const nodeText = await page.$eval('.react-flow__node', (el) => el.textContent || '').catch(() => '');
  check('懒加载：graphs/<名>.se.json 被读入并渲染节点（标题 NodeA）', nodeText.includes('NodeA'), nodeText.slice(0, 80));
  check('懒加载：正文按 source.file_path 水合（含 probe 文本）', nodeText.includes('probe-line-1'), nodeText.slice(0, 120));

  // 3. 纯指针：自动保存后 .workspace.json 不含 store。
  await sleep(1200);
  let wsJson = null;
  try {
    wsJson = JSON.parse(fs.readFileSync(WS, 'utf-8'));
  } catch { /* ignore */ }
  check(
    '纯指针工作区：.workspace.json 含 tabs 且不含 store',
    !!wsJson && Array.isArray(wsJson.tabs) && !('store' in wsJson),
    JSON.stringify(wsJson)
  );

  // 4. tab 重命名（D11）：配置 + .streams/ 目录改名 + source 前缀迁移。
  await page.fill('.graph-title', PROBE_RENAMED);
  await page.click('.flow');
  await sleep(1600);
  const renCfgExists = fs.existsSync(REN_CFG);
  let renCfg = null;
  try {
    renCfg = JSON.parse(fs.readFileSync(REN_CFG, 'utf-8'));
  } catch { /* ignore */ }
  check(
    'tab 重命名：配置文件 graphs/__v2e2e_renamed.se.json 生成',
    renCfgExists,
    `exists=${renCfgExists}`
  );
  check(
    'tab 重命名：source.file_path 迁移到新 .streams 目录',
    renCfg?.streams?.[0]?.source?.file_path === `${PROBE_RENAMED}.streams/NodeA.md`,
    JSON.stringify(renCfg?.streams?.[0]?.source || null)
  );
  check(
    'tab 重命名：旧配置移除 + 内容文件随目录迁移',
    !fs.existsSync(PROBE_CFG) && fs.existsSync(path.join(REN_DIR, 'NodeA.md')),
    `oldGone=${!fs.existsSync(PROBE_CFG)} newContent=${fs.existsSync(path.join(REN_DIR, 'NodeA.md'))}`
  );

  // 5. GET /api/graphs/text：只读文本视图端点（Y1 逻辑图，回填正文）。
  await sleep(500);
  const textRes = await fetch(
    `${BASE}/api/graphs/text?name=${encodeURIComponent(PROBE_RENAMED)}&format=json`
  );
  const textBody = textRes.ok ? await textRes.json() : null;
  check(
    'GET /api/graphs/text：返回逻辑图节点数组（含正文）',
    textRes.status === 200 &&
      textBody &&
      Array.isArray(textBody.nodes) &&
      textBody.nodes.length >= 1 &&
      String(textBody.nodes[0]?.content || '').includes('probe-line-1'),
    `HTTP ${textRes.status} nodes=${textBody?.nodes?.length}`
  );
  const yamlRes = await fetch(
    `${BASE}/api/graphs/text?name=${encodeURIComponent(PROBE_RENAMED)}&format=yaml`
  );
  const yamlText = yamlRes.ok ? await yamlRes.text() : '';
  check(
    'GET /api/graphs/text：format=yaml 返回 YAML',
    yamlRes.status === 200 && /^nodes:/m.test(yamlText),
    yamlText.slice(0, 60)
  );

  check('无页面级 JS 错误', pageErrors.length === 0, pageErrors.slice(0, 2).join(' || '));
} catch (err) {
  check('e2e 执行', false, err.stack || String(err));
} finally {
  cleanup();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
