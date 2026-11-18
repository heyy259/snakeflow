// 图 v2 手动「保存/加载文档」冒烟（重写自 v1 版；playwright-core + 系统 Chrome）。
//
// v2 通路：💾 保存文档 = 保存到 `graphs/<tabname>.se.json`（配置只记 source.file_path）+ 正文文件；
// 📂 加载文档 = `/api/fs/read` → parseDocument → 按引用水合 → 预览 → 三选策略。
// 覆盖：v2 保存结构、v2/v1/v0 加载回退、合并-跳过/覆盖、无可视节点错误。
//
// P7：本地画布逃生舱已移除，每个 tab 必绑真实 SE。绑定 tab 下加载统一文档为 **overlay 语义**：
// 文档 `s-*` 流不注入（SE 是结构真源），只有本地 `n-*` 节点落到画布（也出现在流面板）。
// 因此「三选策略」必须在**无既有 SE 流的绑定 tab** 上验证：否则既有 SE 流会与文档 overlay
// 节点叠加，令流数断言漂移。策略本身的冲突判定/合并逻辑与本地面板一致。
//
// 自隔离：启动前把 `graphs/.workspace.json` 换成**单个 ASCII 探针 tab**，跑完完整还原；
// 不触碰真实图谱配置。OneDrive 下统一 unlinkSync（非 ASCII rmSync 会崩）。
// 运行：node scripts/smoke-doc.mjs（全绿退出码 0）。
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {
  sePreflightSkip,
  seEnv,
  createBoundTab,
  cleanupSeSystem,
  cleanupGraphArtifacts,
  purgeTestTabsFromWorkspace,
} from './se-ui-helper.mjs';

const ROOT = process.cwd();
const PORT = 5196;
const BASE = `http://localhost:${PORT}`;
const GRAPHS = path.join(ROOT, 'graphs');
const WS = path.join(GRAPHS, '.workspace.json');
const BACKUP_FILES = ['.workspace.json', '.frecency.json', '.ui.json'].map((f) => path.join(GRAPHS, f));

// ASCII 名（OneDrive + 非 ASCII rmSync 崩溃规避）。
const V2_NAME = 'smoke-doc-v2'; // 由 app 保存产出（工作区探针 tab 自动绑定的 system id 同源）
const V2B_NAME = 'smoke-doc-v2b'; // 测试自写、供加载/合并用例
const LOAD_TAB = 'smoke-doc-load';
const V2_CFG = path.join(GRAPHS, `${V2_NAME}.se.json`);
const V2_DIR = path.join(GRAPHS, `${V2_NAME}.streams`);
const V2B_CFG = path.join(GRAPHS, `${V2B_NAME}.se.json`);
const V2B_DIR = path.join(GRAPHS, `${V2B_NAME}.streams`);
const LOAD_CFG = path.join(GRAPHS, `${LOAD_TAB}.se.json`);
const LOAD_DIR = path.join(GRAPHS, `${LOAD_TAB}.streams`);
// 策略段专用绑定 tab 的 system id（纯 ASCII 唯一，finally 清理 storage）。
const STRAT_SID = `smoke-doc-strat-${Date.now().toString(36)}`;

await sePreflightSkip();

function waitForServer(url, timeout = 25000) {
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

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 160) : ''}`);
};
const safeUnlink = (p) => { try { fs.unlinkSync(p); } catch { /* ignore */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const backups = new Map();
for (const f of BACKUP_FILES) {
  if (fs.existsSync(f)) { fs.copyFileSync(f, f + '.smk-bak'); backups.set(f, true); }
}

function purgeDir(dir) {
  try {
    for (const f of fs.readdirSync(dir)) safeUnlink(path.join(dir, f));
    fs.rmdirSync(dir);
  } catch { /* ignore */ }
}
function restore() {
  for (const f of BACKUP_FILES) {
    const bak = f + '.smk-bak';
    if (backups.get(f) && fs.existsSync(bak)) { fs.copyFileSync(bak, f); safeUnlink(bak); }
    else if (fs.existsSync(bak)) safeUnlink(bak);
  }
  const extra = [V2_CFG, LOAD_CFG, path.join(GRAPHS, 'smoke-v0-legacy.se.json'), path.join(GRAPHS, 'smoke-v1-legacy.se.json')];
  for (const name of FIXTURES) { extra.push(path.join(GRAPHS, `${name}.se.json`)); }
  for (const f of extra) safeUnlink(f);
  // v0/v1 旧文档加载后 app 会自动保存并为其节点分配 .streams/ 目录，一并清理。
  const legacyDirs = ['smoke-v0-legacy.streams', 'smoke-v1-legacy.streams'].map((n) => path.join(GRAPHS, n));
  for (const d of [V2_DIR, LOAD_DIR, ...FIXTURES.map((n) => path.join(GRAPHS, `${n}.streams`)), ...legacyDirs]) purgeDir(d);
  // 恢复的备份可能带有历史测试 tab；同时清掉本用例绑定 tab 的图表产物。
  purgeTestTabsFromWorkspace(WS);
  cleanupGraphArtifacts(STRAT_SID);
}

// P7：收尾清理本机 SE storage。工作区探针 tab 的 system id 由 app 派生，读回工作区取真值；
// STRAT_SID 显式加入兜底。必须在 vite 进程树被 taskkill 之后调用。
function cleanupSystems() {
  const ids = new Set([V2_NAME, STRAT_SID]);
  try {
    const ws = JSON.parse(fs.readFileSync(WS, 'utf-8'));
    for (const t of Array.isArray(ws.tabs) ? ws.tabs : []) {
      const sid = t?.system?.system_id;
      if (sid) ids.add(String(sid));
    }
  } catch { /* ignore */ }
  for (const id of ids) cleanupSeSystem(id);
}

// 每次加载用**唯一 basename** 的 v2 夹具：加载后 app 会把 tab 改名为该 basename，自动保存随即将该
// 文件重写为当前画布；唯一名保证"下一个夹具"不被上一个 tab 的自动保存覆盖。
const FIXTURES = ['smoke-doc-src1', 'smoke-doc-src2', 'smoke-doc-src3'];
function writeV2(name, aDesc = '') {
  const dir = path.join(GRAPHS, `${name}.streams`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'A.md'), 'A 正文', 'utf-8');
  fs.writeFileSync(path.join(dir, 'B.md'), 'B 正文', 'utf-8');
  fs.writeFileSync(
    path.join(GRAPHS, `${name}.se.json`),
    JSON.stringify(
      {
        version: '3.0',
        system: { name },
        streams: [
          { id: 'n-a', name: '文档流A', description: aDesc, tags: {}, position: { x: 80, y: 80 }, source: { file_path: `graphs/${name}.streams/A.md`, encoding: 'utf-8' } },
          { id: 'n-b', name: '文档流B', description: '', tags: { canvas: 'false' }, position: { x: 460, y: 80 }, source: { file_path: `graphs/${name}.streams/B.md`, encoding: 'utf-8' } },
        ],
        edges: [],
        tools: {},
      },
      null,
      2
    ),
    'utf-8'
  );
}

const server = spawn((process.platform === 'win32' ? 'npx.cmd' : 'npx'), ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore', shell: process.platform === 'win32', env: await seEnv() });
let browser;
const watchdog = setTimeout(() => {
  check('看门狗：超时强制退出', false);
  try { if (browser) browser.close(); } catch { /* ignore */ }
  if (process.platform === 'win32') { try { spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } else { try { spawnSync('pkill', ['-TERM', '-P', String(server.pid)], { stdio: 'ignore' }); } catch { /* ignore */ } try { server.kill('SIGTERM'); } catch { /* ignore */ } }
  cleanupSystems();
  restore();
  const f = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - f.length}/${results.length} PASS ====`);
  process.exit(2);
}, 240000);

try {
  // 0. 隔离工作区：单个 ASCII 探针 tab（避免 app 自动保存触碰真实图谱）。
  fs.writeFileSync(WS, JSON.stringify({ activeId: 't-sd', tabs: [{ id: 't-sd', name: V2_NAME }] }), 'utf-8');

  await waitForServer(BASE);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow', { timeout: 15000 });
  // P7：工作区探针 tab 自动绑定并拉起 SE；等其在线后再走 SE 建流路径（否则会落到旧的本地分支）。
  await page.waitForSelector('.tab-se-dot.se-dot-online', { timeout: 90000 }).catch(() => {});
  await sleep(900);

  const activateRail = async (icon) => {
    // 若已折叠：先展开（点当前 active 的 rail-btn）。
    if (await page.$('.file-sidebar.collapsed')) {
      const active = await page.$('.rail-btn.active');
      if (active) await active.click();
      await sleep(300);
    }
    for (const b of await page.$$('.rail-btn')) {
      if ((await b.textContent()).includes(icon)) {
        if ((await b.getAttribute('aria-pressed')) !== 'true') await b.click();
        break;
      }
    }
    await sleep(400);
  };
  const clickToolbar = async (text) => {
    const h = await page.evaluateHandle((t) => Array.from(document.querySelectorAll('.toolbar button')).find((b) => b.textContent.includes(t)), text);
    await h.asElement().click();
  };
  const confirmModal = async () => { await page.click('.dlg-actions .primary'); await sleep(800); };
  const clickStrategy = async (label) => {
    await page.evaluate((t) => {
      Array.from(document.querySelectorAll('.doc-strategy button')).find((b) => b.textContent === t)?.click();
    }, label);
    await sleep(900);
  };

  // 1. 探针 tab 建 2 流（1 隐藏）。P7 建流走 SE：填正文（R-3.1）以便保存时正文落盘。
  await activateRail('🌊');
  const createStream = async (name, content) => {
    const before = (await page.$$('.stream-item')).length;
    await page.click('.sidebar-head .head-btn[title="新建流"]');
    await page.waitForSelector('.modal input[type="text"]', { timeout: 8000 });
    await page.fill('.modal input[type="text"]', name);
    // 新建对话框第二个 textarea 是「初始内容」；填了才会经 stream.write 落 SE，进而被读回节点 → 保存落盘。
    await page.fill('.modal textarea[placeholder^="初始内容"]', content);
    await page.click('.dlg-actions .primary');
    // SE 往返 + 对账投影为异步，等列表实际新增该项再返回（固定 sleep 在真实 SE 路径下不可靠）。
    await page.waitForFunction(
      (n) => document.querySelectorAll('.stream-item').length > n,
      before,
      { timeout: 20000 }
    );
    await sleep(200);
  };
  // 单击可见流 = 聚焦并 stream.read 回灌节点内容（保证保存时 data.content 已就绪）。
  const focusItem = async (name) => {
    await page.evaluate((n) => {
      const el = Array.from(document.querySelectorAll('.stream-item')).find((e) => e.querySelector('.stream-name')?.textContent === n);
      el?.click();
    }, name);
    await sleep(700);
  };
  const hideItem = async (name) => {
    await page.evaluate((n) => {
      const el = Array.from(document.querySelectorAll('.stream-item')).find((e) => e.querySelector('.stream-name')?.textContent === n);
      el?.querySelector('.stream-actions button')?.click();
    }, name);
    await sleep(500);
  };
  await createStream('文档流A', 'A 正文');
  await focusItem('文档流A');
  await createStream('文档流B', 'B 正文');
  await focusItem('文档流B');
  await hideItem('文档流B');
  check('准备：2 流（1 隐藏）', (await page.$$('.stream-item')).length === 2 && (await page.$$('.stream-item.is-hidden')).length === 1);

  // 2. 保存 → 配置只记 source.file_path + 正文文件落盘。
  //    工具栏「保存」与自动保存共用 syncGraphFiles；graphs tab 写 graphs/<名>.se.json。
  await clickToolbar('保存');
  await sleep(300);
  check('保存：graphs/smoke-doc-v2.se.json 已写入', fs.existsSync(V2_CFG));
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(V2_CFG, 'utf-8')); } catch { /* ignore */ }
  check(
    'v3 顶层结构 + $schema snake-manifest-v1',
    doc?.$schema === 'snake-manifest-v1' && Array.isArray(doc.streams) && !!doc.tools && typeof doc.system?.name === 'string' && Array.isArray(doc.system?.graph?.edges),
    JSON.stringify({ $schema: doc?.$schema, n: doc?.streams?.length })
  );
  check(
    'v2：stream 只记 source.file_path、无内联 content',
    Array.isArray(doc?.streams) && doc.streams.length === 2 && doc.streams.every((s) => s.source?.file_path && !('content' in s)),
    JSON.stringify(doc?.streams?.map((s) => s.source?.file_path))
  );
  check('streams 含隐藏流（tags.canvas=false）', doc?.streams?.some((s) => s.tags?.canvas === 'false'));
  check(
    '正文文件已落盘',
    doc?.streams?.every((s) => {
      const fp = String(s.source.file_path).replace(/\\/g, '/');
      const abs = /^([A-Za-z]:\/|\/\/|\/)/.test(fp) ? fp : path.join(ROOT, fp.startsWith('graphs/') ? fp : `graphs/${fp}`);
      return fs.existsSync(abs);
    })
  );

  // 3. 策略段：新开**空 SE** 绑定 tab。绑定 tab 下文档 `n-*` 流为本地 overlay 节点，
  //    面板可见；空 SE 保证 overlay 结果即文档结果，避免与既有 SE 流叠加令计数漂移。
  //    （task P7：`createBoundTab` 独占 system，跑完 cleanupSeSystem。）
  await createBoundTab(page, STRAT_SID);
  await activateRail('🌊');
  check('策略页：绑定 tab 流列表为空（无既有 SE 流干扰）', (await page.$$('.stream-item')).length === 0, `n=${(await page.$$('.stream-item')).length}`);

  const loadDoc = async (target) => {
    await clickToolbar('加载文档');
    await page.waitForSelector('.modal .dlg-row input[type="text"]', { timeout: 8000 });
    await page.fill('.modal .dlg-row input[type="text"]', target);
    await page.click('.dlg-actions .primary');
  };

  // 3a. 📂 加载 v2 夹具 → 预览 → 整页替换。
  writeV2(FIXTURES[0]);
  await loadDoc(FIXTURES[0]);
  await page.waitForSelector('.doc-strategy', { timeout: 15000 });
  check('预览：含 2 流 / 0 工具', await page.evaluate(() => /含\s*2\s*流\s*\/\s*0\s*工具/.test(document.querySelector('.modal .dlg-note')?.textContent || '')));
  await clickStrategy('整页替换');
  // 空 SE 上整页替换 = 文档 overlay 节点即当前流列表：1 可见（A）+ 1 隐藏（B，canvas:false）。
  check('替换后：1 可见节点 + 1 隐藏流', (await page.$$('.react-flow__node')).length === 1 && (await page.$$('.stream-item.is-hidden')).length === 1);

  // 4. 合并-跳过冲突：当前页 A 改描述 + 删 B，再载入 → B 加回、A 保留当前描述。
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('.stream-item')).find((e) => e.querySelector('.stream-name')?.textContent === '文档流A');
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 }));
  });
  await sleep(250);
  await page.evaluate(() => Array.from(document.querySelectorAll('.context-menu button')).find((b) => b.textContent.includes('编辑标签')).click());
  await sleep(250);
  await page.fill('.modal .dlg-textarea', '当前页独有描述');
  await confirmModal();
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('.stream-item.is-hidden'))[0];
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 }));
  });
  await sleep(250);
  await page.evaluate(() => Array.from(document.querySelectorAll('.context-menu button')).find((b) => b.textContent.includes('删除流')).click());
  await sleep(250);
  await page.click('.dlg-actions .primary.danger');
  await sleep(500);
  check('合并前：仅 1 流', (await page.$$('.stream-item')).length === 1);
  writeV2(FIXTURES[1]);
  await loadDoc(FIXTURES[1]);
  await page.waitForSelector('.doc-strategy', { timeout: 15000 });
  await clickStrategy('合并-跳过冲突');
  // 绑定 tab：同名冲突（文档 A）跳过，非冲突（文档 B）以本地 overlay 节点并入 → 2 流。
  check('跳过后：B 加回（2 流）', (await page.$$('.stream-item')).length === 2, `streams=${(await page.$$('.stream-item')).length}`);
  check('跳过：冲突流保留当前描述', await page.evaluate(() =>
    Array.from(document.querySelectorAll('.stream-item')).some(
      (e) => e.querySelector('.stream-name')?.textContent === '文档流A' && e.querySelector('.stream-desc')?.textContent === '当前页独有描述'
    )
  ));

  // 5. 合并-覆盖冲突：描述被文档版替换、流数不增。
  writeV2(FIXTURES[2], '文档描述');
  await loadDoc(FIXTURES[2]);
  await page.waitForSelector('.doc-strategy', { timeout: 15000 });
  await clickStrategy('合并-覆盖冲突');
  check('覆盖后：A 描述被文档版替换', await page.evaluate(() =>
    Array.from(document.querySelectorAll('.stream-item')).some(
      (e) => e.querySelector('.stream-name')?.textContent === '文档流A' && e.querySelector('.stream-desc')?.textContent === '文档描述'
    )
  ));
  // 覆盖按同名原地改写 overlay 节点，不新增 → 仍 2。
  check('覆盖后：流数不增（2）', (await page.$$('.stream-item')).length === 2);

  // 6. v0 旧逻辑格式自动升级。
  fs.writeFileSync(path.join(GRAPHS, 'smoke-v0-legacy.se.json'), JSON.stringify({
    nodes: [{ id: 'x1', title: '旧节点', content: '旧内容', fields: [{ key: 'canvas', value: 'false' }] }],
    edges: [],
  }, null, 2));
  await loadDoc('smoke-v0-legacy');
  await sleep(600);
  check('v0：无预览直接升级替换', !(await page.$('.doc-strategy')));
  check('v0：canvas:false 生效（0 可见节点 + 1 隐藏流）', (await page.$$('.react-flow__node')).length === 0 && (await page.$$('.stream-item.is-hidden')).length === 1);
  safeUnlink(path.join(GRAPHS, 'smoke-v0-legacy.se.json'));

  // 7. v1 内联旧文档（含废弃 scan/processes + 一条边）→ 忽略字段、正常渲染、内容按内联读入。
  fs.writeFileSync(path.join(GRAPHS, 'smoke-v1-legacy.se.json'), JSON.stringify({
    version: '1.0',
    system: { name: 'smoke-v1' },
    streams: [
      { id: 's1', name: 'v1旧流A', title: 'v1旧流A', description: 'v1旧描述', tags: {}, content: '# v1 旧内容', position: { x: 80, y: 80 }, scan: { state: 'scanning', position: 3, ok: 2, fail: 1 }, processes: [{ id: 'p-1', tool: 'bash', name: 'pytest', waiting: true }] },
      { id: 's2', name: 'v1旧流B', title: 'v1旧流B', description: '', tags: {}, content: '', position: { x: 460, y: 80 } },
    ],
    edges: [{ source: 's1', target: 's2', label: '旧边' }],
    tools: {},
  }, null, 2));
  await loadDoc('smoke-v1-legacy');
  await page.waitForSelector('.doc-strategy', { timeout: 15000 });
  check('v1：预览出现且含 2 流 / 0 工具', await page.evaluate(() => {
    const note = document.querySelector('.modal .dlg-note')?.textContent || '';
    return !!document.querySelector('.doc-strategy') && /含\s*2\s*流\s*\/\s*0\s*工具/.test(note);
  }));
  await clickStrategy('整页替换');
  // v0 刚把画布清成 0 SE 节点；v1 的 s1/s2 作本地 overlay 注入 → 2 流 2 节点。
  check('v1：含 scan/processes 正常渲染（2 流 2 节点）', (await page.$$('.stream-item')).length === 2 && (await page.$$('.react-flow__node')).length === 2);
  check('v1：edges 快照重现', (await page.$$('.react-flow__edge')).length >= 1);
  check('v1：内联内容读入（name/description 保留）', await page.evaluate(() => {
    const nodeOk = Array.from(document.querySelectorAll('.react-flow__node')).some((el) => el.textContent.includes('v1旧流A'));
    const descOk = Array.from(document.querySelectorAll('.stream-item')).some(
      (e) => e.querySelector('.stream-name')?.textContent === 'v1旧流A' && e.querySelector('.stream-desc')?.textContent === 'v1旧描述'
    );
    return nodeOk && descOk;
  }));
  safeUnlink(path.join(GRAPHS, 'smoke-v1-legacy.se.json'));

  check('无页面级 JS 错误', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' || '));
} catch (err) {
  check('冒烟执行', false, String((err && err.message) || err));
} finally {
  clearTimeout(watchdog);
  if (browser) await browser.close();
  if (process.platform === 'win32') { try { spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } else { try { spawnSync('pkill', ['-TERM', '-P', String(server.pid)], { stdio: 'ignore' }); } catch { /* ignore */ } try { server.kill('SIGTERM'); } catch { /* ignore */ } }
  cleanupSystems();
  restore();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
