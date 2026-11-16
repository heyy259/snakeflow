// Task 3 冒烟：入口门控（绑定在线时快速加节点改走 SE 新建流，不再产 n-* 本地节点）。
// 覆盖：① 工具栏「+ 添加节点」；③ 双击画布空白；② 从节点手柄拖连线到空白松手。
// 绑定在线：三入口均唤起「新建流」对话框（走 registerEntries/SE）；离线/未绑定维持本地行为（本套件不覆盖）。
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

const PORT = 5196;
const BASE = `http://localhost:${PORT}`;
const SID = `smoke-gate-${Date.now().toString(36)}`;
const BACKUP_FILES = ['graphs/.workspace.json', 'graphs/.frecency.json', 'graphs/.ui.json'].map((p) => path.resolve(p));

await sePreflightSkip();

function waitForServer(url, timeout = 20000) {
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

const backups = new Map();
for (const f of BACKUP_FILES) {
  if (fs.existsSync(f)) { fs.copyFileSync(f, f + '.smk-bak'); backups.set(f, true); }
}
function restore() {
  for (const f of BACKUP_FILES) {
    const bak = f + '.smk-bak';
    if (backups.get(f) && fs.existsSync(bak)) {
      // vite 退出竞态：在途工作区写可能晚于 restore 落盘（实证污染），写后读回校验重试。
      const want = fs.readFileSync(bak, 'utf-8');
      for (let i = 0; i < 5; i += 1) {
        fs.copyFileSync(bak, f);
        let cur = null;
        try { cur = fs.readFileSync(f, 'utf-8'); } catch { cur = null; }
        if (cur === want) break;
        const until = Date.now() + 400;
        while (Date.now() < until) { /* 退避 */ }
      }
      fs.rmSync(bak, { force: true });
    }
    else if (fs.existsSync(bak)) fs.rmSync(bak, { force: true });
  }
}

const server = spawn('npx.cmd', ['vite', '--port', String(PORT), '--strictPort'], { cwd: process.cwd(), stdio: 'ignore', shell: true, env: await seEnv() });
let browser;
try {
  await waitForServer(BASE);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text()); });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow', { timeout: 15000 });
  await page.waitForTimeout(600);
  await createBoundTab(page, SID);

  // 打开流侧栏（统计流项需要）
  const activateRail = async (icon) => {
    for (const b of await page.$$('.rail-btn')) {
      if ((await b.textContent()).includes(icon)) {
        if ((await b.getAttribute('aria-pressed')) !== 'true') await b.click();
        break;
      }
    }
    await page.waitForTimeout(400);
  };
  await activateRail('🌊');

  const clickButtonByText = (text) =>
    page.evaluate((t) => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.includes(t));
      if (!b) return false;
      b.click();
      return true;
    }, text);

  const cancelModal = () =>
    page.evaluate(() => {
      const modal = document.querySelector('.modal');
      if (!modal) return false;
      const b = Array.from(modal.querySelectorAll('button')).find((x) => x.textContent.trim() === '取消');
      if (!b) return false;
      b.click();
      return true;
    });

  const counts = () =>
    page.evaluate(() => ({
      nodes: document.querySelectorAll('.react-flow__node').length,
      localNodes: document.querySelectorAll('.react-flow__node[data-id^="n-"]').length,
      edges: document.querySelectorAll('.react-flow__edge').length,
      localEdges: document.querySelectorAll('.react-flow__edge[data-id^="e-"]').length,
      streamItems: document.querySelectorAll('.stream-item').length,
    }));

  const modalInputValue = () =>
    page.$eval('.modal input[type="text"]', (el) => el.value).catch(() => null);

  const hasNode = (id) =>
    page.evaluate((i) => !!document.querySelector(`.react-flow__node[data-id="${i}"]`), id);

  const waitStreamItem = async (name, timeout = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const has = await page.evaluate(
        (n) => Array.from(document.querySelectorAll('.stream-item .stream-name')).some((e) => (e.textContent || '').trim() === n),
        name
      );
      if (has) return true;
      await page.waitForTimeout(250);
    }
    return false;
  };

  const paneBox = async () => (await (await page.$('.react-flow__pane')).boundingBox());

  // ── 入口①：工具栏「+ 添加节点」在线 → 唤起新建流对话框（预填「新节点」），不产 n-* ──
  {
    const before = await counts();
    const clicked = await clickButtonByText('添加节点');
    check('入口①：找到工具栏「+ 添加节点」', clicked);
    await page.waitForSelector('.modal input[type="text"]', { timeout: 8000 }).catch(() => null);
    const val = await modalInputValue();
    const after = await counts();
    check('入口①：唤起新建流对话框', val !== null, `input=${JSON.stringify(val)}`);
    check('入口①：预填默认名「新节点」', val === '新节点');
    check('入口①：未产 n-* 本地节点', after.localNodes === before.localNodes && after.nodes === before.nodes,
      `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    await cancelModal();
    await page.waitForTimeout(300);
    const cancelled = await counts();
    check('入口①：取消后不创建（流数/节点数不变）',
      cancelled.nodes === before.nodes && cancelled.streamItems === before.streamItems);
  }

  // ── 入口③：双击画布空白 → 唤起新建流对话框 ──
  {
    const before = await counts();
    const box = await paneBox();
    await page.mouse.dblclick(box.x + 22, box.y + 22);
    await page.waitForTimeout(500);
    const val = await modalInputValue();
    const after = await counts();
    check('入口③：双击空白唤起新建流对话框', val !== null, `input=${JSON.stringify(val)}`);
    check('入口③：未产 n-* 本地节点', after.localNodes === before.localNodes && after.nodes === before.nodes,
      `after=${JSON.stringify(after)}`);
    await cancelModal();
    await page.waitForTimeout(300);
  }

  // ── 入口① 提交：创建 SE 流（s-* 节点 + 流项），无 n-* ──
  {
    const before = await counts();
    await clickButtonByText('添加节点');
    await page.waitForSelector('.modal input[type="text"]', { timeout: 8000 });
    await page.fill('.modal input[type="text"]', '门控流');
    await page.evaluate(() => {
      const modal = document.querySelector('.modal');
      const b = modal && Array.from(modal.querySelectorAll('button')).find((x) => x.textContent.includes('创建'));
      if (b) b.click();
    });
    const itemOk = await waitStreamItem('门控流');
    const nodeOk = await hasNode('s-门控流');
    await page.waitForTimeout(400);
    const after = await counts();
    check('入口①：提交后创建 SE 流（流列表出现「门控流」）', itemOk);
    check('入口①：画布出现 s-* 流节点', nodeOk, `hasNode=s-门控流=${nodeOk}`);
    check('入口①：新节点为 s-*，无 n-*', after.localNodes === 0);
    check('入口①：节点数增加', after.nodes > before.nodes, `before=${before.nodes} after=${after.nodes}`);
  }

  // ── 入口②：从节点手柄拖连线到空白松手 → 唤起对话框；取消不补边；创建后补 SE 边 ──
  {
    // 收起可能的展开终端 + 取消选中
    await page.evaluate(() => {
      document.querySelectorAll('.react-flow__node .terminal-panel.expanded .term-bar').forEach((b) => b.click());
    });
    await page.waitForTimeout(300);
    const box = await paneBox();
    await page.mouse.click(box.x + 12, box.y + 12);
    await page.waitForTimeout(300);

    const dragFromNodeToEmpty = async () => {
      const node = await page.$('.react-flow__node[data-id="s-门控流"]');
      if (!node) return false;
      await node.click();
      await page.waitForTimeout(300);
      let h = await node.$('.react-flow__handle.source');
      if (!h) h = await node.$('.react-flow__handle-bottom');
      if (!h) return false;
      const hb = await h.boundingBox();
      if (!hb) return false;
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
      await page.mouse.down();
      // 拖到左上角空白区（远离所有节点）后再松手 → connectionState 无 toNode
      await page.mouse.move(box.x + 30, box.y + 30, { steps: 20 });
      await page.mouse.up();
      await page.waitForTimeout(700);
      return true;
    };

    const before = await counts();
    const dragged = await dragFromNodeToEmpty();
    check('入口②：找到源节点 source handle 并完成拖拽', dragged);
    await page.waitForSelector('.modal input[type="text"]', { timeout: 8000 }).catch(() => null);
    const val = await modalInputValue();
    check('入口②：松手于空白 → 唤起新建流对话框', val !== null, `input=${JSON.stringify(val)}`);
    const afterCancel = await counts();
    check('入口②：拖拽未直接补 n-* 节点/边',
      afterCancel.localNodes === before.localNodes && afterCancel.nodes === before.nodes,
      `after=${JSON.stringify(afterCancel)}`);
    await cancelModal();
    await page.waitForTimeout(400);
    const afterCancel2 = await counts();
    check('入口②：取消不创建、不补边', afterCancel2.edges === before.edges && afterCancel2.nodes === before.nodes);

    // 再拖一次并创建 → 补 fromId → 新流 的 SE 边
    const edgeBefore = (await counts()).edges;
    await page.mouse.click(box.x + 12, box.y + 12);
    await page.waitForTimeout(300);
    await dragFromNodeToEmpty();
    await page.waitForSelector('.modal input[type="text"]', { timeout: 8000 });
    await page.fill('.modal input[type="text"]', '门控边');
    await page.evaluate(() => {
      const modal = document.querySelector('.modal');
      const b = modal && Array.from(modal.querySelectorAll('button')).find((x) => x.textContent.includes('创建'));
      if (b) b.click();
    });
    await waitStreamItem('门控边');
    // 等边出现（SE 写→重投影异步）
    let edgeOk = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      if ((await counts()).edges > edgeBefore) { edgeOk = true; break; }
      await page.waitForTimeout(300);
    }
    check('入口②：创建成功后补 SE 边（fromId → 新流）', edgeOk, `edges ${edgeBefore} → ${(await counts()).edges}`);
    const finalCounts = await counts();
    check('入口②：补的是 SE 边（无本地 e-* 边）', finalCounts.localEdges === 0, `localEdges=${finalCounts.localEdges}`);
    check('入口②：全程无 n-* 本地节点', finalCounts.localNodes === 0);
  }

  check('控制台无错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' || '));
  await page.screenshot({ path: '.sisyphus/smoke-entry-gating.png' });
} catch (err) {
  check('冒烟执行', false, String((err && err.message) || err));
} finally {
  if (browser) await browser.close();
  try { spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 尽力而为 */ }
  cleanupSeSystem(SID);
  restore();
  // 测试 tab 在真实 graphs/ 下生成的配置 / .streams 目录一并清掉，避免逐轮堆积。
  purgeTestTabsFromWorkspace();
  cleanupGraphArtifacts(SID);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
