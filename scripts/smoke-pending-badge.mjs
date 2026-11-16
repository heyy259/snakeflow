// Task 4 冒烟：pending 节点 UI 可见性（纯离线，不依赖 SE）。
// 非 `s-` 前缀节点（本地草稿 n-*）在 SE 中不存在 → 节点标题区渲染 .pending-badge「待同步」；
// 选中后 ScanBar 动作按钮以 aria-disabled 视觉禁用（保留可点击，供 scanDriver 兜底 toast）。
// 隔离：写入确定性工作区（含一个 n-* 与一个 s-* 节点）后加载；finally 还原用户数据。
// 注：pending 判定只取决于 id 前缀（streamNameFromId === null），与是否绑定 SE 无关，故离线即可复现。
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {
  cleanupSeSystem,
  cleanupGraphArtifacts,
  purgeTestTabsFromWorkspace,
  workspaceSystemIds,
} from './se-ui-helper.mjs';

const PORT = 5197;
const BASE = `http://localhost:${PORT}`;
const BACKUP_FILES = ['graphs/.workspace.json', 'graphs/.frecency.json', 'graphs/.ui.json'].map((p) => path.resolve(p));

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

// 种子：n-pending（非 s-* → pending）+ s-甲（s-* → 非 pending），验证正/负两种渲染。
const SEED_WORKSPACE = {
  activeId: 't-pending',
  tabs: [{ id: 't-pending', name: '待同步' }],
  store: {
    't-pending': {
      nodes: [
        { id: 'n-pending', position: { x: 80, y: 80 }, data: { name: '待同步节点', content: '本地草稿内容' } },
        { id: 's-甲', position: { x: 460, y: 80 }, data: { name: 'SE 流甲', content: 'SE 内容' } },
      ],
      edges: [],
    },
  },
};
fs.mkdirSync(path.dirname(BACKUP_FILES[0]), { recursive: true });
fs.writeFileSync(BACKUP_FILES[0], JSON.stringify(SEED_WORKSPACE));

// 纯离线：不注入 SE env，dev server 无法 spawn SE，页面停留未绑定态。
const server = spawn('npx.cmd', ['vite', '--port', String(PORT), '--strictPort'], { cwd: process.cwd(), stdio: 'ignore', shell: true });

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
  await page.waitForSelector('.react-flow__node[data-id="n-pending"]', { timeout: 15000 });
  await page.waitForTimeout(500);

  // ── 1. pending 角标 ──
  const badge = await page.evaluate(() => {
    const n = document.querySelector('.react-flow__node[data-id="n-pending"]');
    const b = n && n.querySelector('.pending-badge');
    return b ? { text: (b.textContent || '').trim(), title: b.getAttribute('title') || '' } : null;
  });
  check('pending 节点标题区出现 .pending-badge', !!badge, JSON.stringify(badge));
  check('角标文案为「待同步」', !!badge && badge.text === '待同步', badge && badge.text);
  check('角标 title 提示未同步 SE', !!badge && badge.title.includes('未同步'), badge && badge.title);

  // ── 2. 非 pending（s-*）节点无角标 ──
  const sBadge = await page.evaluate(() =>
    document.querySelectorAll('.react-flow__node[data-id="s-甲"] .pending-badge').length
  );
  check('s-* 节点不出现 pending 角标', sBadge === 0, `count=${sBadge}`);

  // ── 3. 选中 pending 节点 → ScanBar 动作按钮 aria-disabled（可点击），非原生 disabled ──
  await page.click('.react-flow__node[data-id="n-pending"]');
  await page.waitForSelector('.scan-controls', { timeout: 8000 });
  const startBtn = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.scan-controls > button')).find((x) => x.textContent.includes('开始'));
    if (!b) return null;
    return { aria: b.getAttribute('aria-disabled'), disabled: b.disabled, title: b.getAttribute('title') || '' };
  });
  check('选中 pending 节点出现扫描控制行', !!startBtn);
  check('pending「开始」aria-disabled=true（视觉禁用）', !!startBtn && startBtn.aria === 'true', JSON.stringify(startBtn));
  check('pending「开始」非原生 disabled（保留可点击以出 toast）', !!startBtn && startBtn.disabled === false);
  check('pending「开始」title 提示无法扫描', !!startBtn && startBtn.title.includes('未同步'), startBtn && startBtn.title);

  check('控制台无错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' || '));
  await page.screenshot({ path: '.sisyphus/smoke-pending-badge.png' });
} catch (err) {
  check('冒烟执行', false, String((err && err.message) || err));
} finally {
  if (browser) await browser.close();
  // Windows 下 shell:true 的 kill() 只杀 npx 壳，必须 taskkill /T 杀整棵树防 vite 孤儿
  try { spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 尽力而为 */ }
  // dev server 可能按本用例 tab 名派生并 spawn 出 SE（se_<hash>）：按 seed 工作区回收。
  for (const id of workspaceSystemIds(BACKUP_FILES[0])) cleanupSeSystem(id);
  restore();
  purgeTestTabsFromWorkspace(BACKUP_FILES[0]);
  cleanupGraphArtifacts('待同步');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
