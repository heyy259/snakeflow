// 临时冒烟：流面板核心交互（阶段 3/4 验证，非正式 e2e）
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

const PORT = 5198;
const BASE = `http://localhost:${PORT}`;
// 每个 tab 必须绑定真实 SE：本次运行专属系统 id（纯 ASCII，避免 OneDrive 删除隐患）。
const SID = `smoke-streams-${Date.now().toString(36)}`;
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
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 140) : ''}`);
};

const backups = new Map();
for (const f of BACKUP_FILES) {
  if (fs.existsSync(f)) { fs.copyFileSync(f, f + '.smk-bak'); backups.set(f, true); }
}
function restore() {
  for (const f of BACKUP_FILES) {
    const bak = f + '.smk-bak';
    if (backups.get(f) && fs.existsSync(bak)) { fs.copyFileSync(bak, f); fs.rmSync(bak, { force: true }); }
    else if (fs.existsSync(bak)) fs.rmSync(bak, { force: true });
  }
}

const server = spawn((process.platform === 'win32' ? 'npx.cmd' : 'npx'), ['vite', '--port', String(PORT), '--strictPort'], { cwd: process.cwd(), stdio: 'ignore', shell: process.platform === 'win32', env: await seEnv() });
let browser;
try {
  await waitForServer(BASE);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow', { timeout: 15000 });
  await page.waitForTimeout(600);

  // 0. 新建绑定真实 SE 的空标签页（隔离用户既有工作区，计数确定）+ 切到流面板。
  //    本地草稿逃生舱已移除：必须经 createBoundTab 起一个独占 SE。
  await createBoundTab(page, SID);
  const activateRail = async (icon) => {
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
  };
  await activateRail('🌊');

  const railStreams = await page.$('.rail-btn[aria-pressed="true"]');
  check('流面板激活', (await railStreams?.textContent())?.includes('🌊'));
  check('空页空态提示', await page.evaluate(() => document.querySelector('.streams-empty')?.innerText.includes('新建你的第一个流')));
  check('画布空态提示', !!(await page.$('.flow-empty-hint')));

  // 用「＋新建」建 3 个流。SE 往返 + 对账投影为异步，故等待列表实际新增该项再返回
  // （固定 sleep 在真实 SE 路径下不可靠）。
  const createStream = async (name) => {
    const before = (await page.$$('.stream-item')).length;
    await page.click('.sidebar-head .head-btn');
    await page.waitForSelector('.modal input[type="text"]', { timeout: 8000 });
    await page.fill('.modal input[type="text"]', name);
    await page.click('.dlg-actions .primary');
    await page.waitForFunction(
      (n) => document.querySelectorAll('.stream-item').length > n,
      before,
      { timeout: 20000 }
    );
    await page.waitForTimeout(200);
  };
  await createStream('流甲');
  await createStream('流乙');
  await createStream('流丙');
  check('新建 3 流上画布', (await page.$$('.react-flow__node')).length === 3);
  check('流列表 3 项', (await page.$$('.stream-item')).length === 3);
  check('数量徽标 3/3', await page.evaluate(() => /画布 3 \/ 共 3/.test(document.querySelector('.streams-panel').innerText)));

  // 1. 眼睛隐藏「流甲」
  const eyeOf = async (name) => {
    const item = await page.evaluateHandle(
      (n) =>
        Array.from(document.querySelectorAll('.stream-item')).find(
          (e) => e.querySelector('.stream-name')?.textContent === n
        ),
      name
    );
    const el = item.asElement();
    await el.hover();
    await page.waitForTimeout(150);
    await (await el.$('.stream-actions button')).click();
    await page.waitForTimeout(350);
  };
  await eyeOf('流甲');
  check('眼睛隐藏后画布 3→2', (await page.$$('.react-flow__node')).length === 2);
  check('隐藏项 dimmed', !!(await page.$('.stream-item.is-hidden')));
  check('隐藏流仍在列表', (await page.$$('.stream-item')).length === 3);

  // 2. 眼睛恢复
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('.stream-item.is-hidden'))[0];
    el.querySelector('.stream-actions button').click();
  });
  await page.waitForTimeout(350);
  check('眼睛恢复后画布还原 3', (await page.$$('.react-flow__node')).length === 3);

  // 3. 键盘 Delete = 从画布移除（数据保留）
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('.stream-item')).find(
      (e) => e.querySelector('.stream-name')?.textContent === '流乙'
    );
    el.click(); // 单击可见流 = 平移居中并选中节点
  });
  await page.waitForTimeout(500);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(400);
  check('Delete 后画布 3→2', (await page.$$('.react-flow__node')).length === 2);
  check('Delete 后列表仍 3 项（语义分层）', (await page.$$('.stream-item')).length === 3);
  check('被删流以隐藏态留在列表', await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('.stream-item')).find(
      (e) => e.querySelector('.stream-name')?.textContent === '流乙'
    );
    return el?.classList.contains('is-hidden');
  }));

  // 4. Ctrl+Z 撤销隐藏
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(500);
  check('undo 后节点回来', (await page.$$('.react-flow__node')).length === 3);

  // 5. 隐藏流双击上画布（显示 + 居中，不进入编辑）
  await eyeOf('流甲');
  const beforeDbl = (await page.$$('.react-flow__node')).length;
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('.stream-item.is-hidden'))[0];
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await page.waitForTimeout(400);
  check('隐藏流双击上画布', (await page.$$('.react-flow__node')).length === beforeDbl + 1);
  check('双击显示后不再隐藏', await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('.stream-item')).find(
      (e) => e.querySelector('.stream-name')?.textContent === '流甲'
    );
    return !!el && !el.classList.contains('is-hidden');
  }));

  // 6. 拖拽隐藏流上画布（dataTransfer 模拟 HTML5 DnD）
  //    步骤 5 已把流甲显示出来，需重新隐藏一个流作为拖拽源。
  await eyeOf('流甲');
  const beforeDrop = (await page.$$('.react-flow__node')).length;
  const dropPos = await page.evaluate(() => {
    const pane = document.querySelector('.react-flow__pane');
    const box = pane.getBoundingClientRect();
    const dt = new DataTransfer();
    const item = Array.from(document.querySelectorAll('.stream-item.is-hidden'))[0];
    item.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const flow = document.querySelector('.flow');
    const x = box.x + box.width * 0.3;
    const y = box.y + box.height * 0.3;
    flow.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientX: x, clientY: y }));
    flow.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientX: x, clientY: y }));
    return { x, y };
  });
  await page.waitForTimeout(400);
  check('拖拽隐藏流上画布', (await page.$$('.react-flow__node')).length === beforeDrop + 1, JSON.stringify(dropPos));

  // 7. 右键菜单 + 删除流确认
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('.stream-item')).find(
      (e) => e.querySelector('.stream-name')?.textContent === '流丙'
    );
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 }));
  });
  await page.waitForTimeout(300);
  check('右键菜单出现', !!(await page.$('.context-menu')));
  await page.evaluate(() =>
    Array.from(document.querySelectorAll('.context-menu button'))
      .find((b) => b.textContent.includes('删除流'))
      .click()
  );
  await page.waitForTimeout(300);
  check('删除确认对话框', !!(await page.$('.modal .dlg-note')));
  await page.click('.dlg-actions .primary.danger');
  await page.waitForTimeout(400);
  check('删除流后列表 3→2', (await page.$$('.stream-item')).length === 2);

  // 8. 右键「编辑标签」对话框
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('.stream-item'))[0];
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 }));
  });
  await page.waitForTimeout(250);
  await page.evaluate(() =>
    Array.from(document.querySelectorAll('.context-menu button'))
      .find((b) => b.textContent.includes('编辑标签'))
      .click()
  );
  await page.waitForTimeout(300);
  check('元数据对话框出现', !!(await page.$('.tags-editor')));
  await page.fill('.modal .dlg-textarea', '冒烟描述');
  await page.click('.modal .tag-add');
  await page.waitForTimeout(200);
  await page.fill('.tag-row .tag-key', '类型');
  await page.fill('.tag-row .tag-value', '日志');
  await page.click('.dlg-actions .primary');
  await page.waitForTimeout(400);
  check('描述出现在列表项', await page.evaluate(() => Array.from(document.querySelectorAll('.stream-desc')).some((e) => e.textContent === '冒烟描述')));
  check('标签 chip 出现在列表项', await page.evaluate(() => Array.from(document.querySelectorAll('.tag-chip')).some((e) => e.textContent.includes('类型'))));
  check('普通标签同步到画布节点 fields 区', await page.evaluate(() =>
    Array.from(document.querySelectorAll('.react-flow__node .agent-field-key')).some((e) => e.textContent === '类型')
  ));
  check('canvas 保留键不上画布节点 fields 区', await page.evaluate(() =>
    !Array.from(document.querySelectorAll('.react-flow__node .agent-field-key')).some((e) => e.textContent === 'canvas')
  ));

  // 9. 重名新建被拦截
  await page.click('.sidebar-head .head-btn');
  await page.waitForTimeout(250);
  const existing = await page.evaluate(() => document.querySelector('.stream-name').textContent);
  await page.fill('.modal input[type="text"]', existing);
  await page.waitForTimeout(200);
  check('重名禁用创建按钮', await page.evaluate(() => document.querySelector('.dlg-actions .primary').disabled));

  check('控制台无错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' || '));
  await page.screenshot({ path: '.sisyphus/smoke-streams.png' });

  // 10. 多选批量清理（R2）：选中 → 聚合确认 → 删除。
  await page.keyboard.press('Escape'); // 关闭第 9 步遗留的新建对话框
  await page.waitForTimeout(250);
  await createStream('批甲');
  await createStream('批乙');
  const beforeBatch = (await page.$$('.stream-item')).length;
  await page.evaluate(() => {
    const names = ['批甲', '批乙'];
    Array.from(document.querySelectorAll('.stream-item')).forEach((el) => {
      if (names.includes(el.querySelector('.stream-name')?.textContent)) {
        el.querySelector('.stream-check').click();
      }
    });
  });
  await page.waitForTimeout(200);
  check('多选后选择栏显示已选 2', await page.evaluate(() =>
    /已选 2 \/ \d+/.test(document.querySelector('.stream-select-bar')?.innerText || '')
  ));
  await page.click('.stream-select-bar .head-btn.danger');
  await page.waitForTimeout(300);
  check('批量删除确认框出现', !!(await page.$('.modal .dlg-note')));
  await page.click('.dlg-actions .primary');
  await page.waitForFunction(
    (n) => document.querySelectorAll('.stream-item').length <= n - 2,
    beforeBatch,
    { timeout: 20000 }
  );
  await page.waitForTimeout(200);
  check('批量删除后列表 -2', (await page.$$('.stream-item')).length === beforeBatch - 2);
} catch (err) {
  check('冒烟执行', false, String((err && err.message) || err));
} finally {
  if (browser) await browser.close();
  // Windows 下 shell:true 的 kill() 只杀 npx 壳，必须 taskkill /T 杀整棵树防 vite 孤儿
  if (process.platform === 'win32') { try { spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } else { try { spawnSync('pkill', ['-TERM', '-P', String(server.pid)], { stdio: 'ignore' }); } catch { /* ignore */ } try { server.kill('SIGTERM'); } catch { /* ignore */ } }
  cleanupSeSystem(SID);
  restore();
  // 测试 tab 在真实 graphs/ 下生成的配置 / .streams 目录一并清掉，避免逐轮堆积。
  purgeTestTabsFromWorkspace();
  cleanupGraphArtifacts(SID);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
