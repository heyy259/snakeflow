// E2E：外部配置包原地绑定。
// 验证：从 graphs/ 之外的 .se.json 新建 tab → 自动保存写回原包；新建流的 md 落到
// <包名>.streams/；不得生成 graphs/<包名>.se.json / graphs/<包名>.streams 副本。
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sePreflightSkip, seEnv, cleanupSeSystem } from './se-ui-helper.mjs';

const ROOT = process.cwd();
const PORT = 5199;
const BASE = `http://localhost:${PORT}`;
const GRAPHS = path.join(ROOT, 'graphs');
const WS = path.join(GRAPHS, '.workspace.json');
const BACKUP_FILES = ['.workspace.json', '.ui.json', '.configs.json'].map((f) =>
  path.join(GRAPHS, f)
);

const STAMP = Date.now().toString(36);
const PKG = `pkg-inplace-${STAMP}`;
const PKG_DIR = path.join(os.tmpdir(), `rf-inplace-${STAMP}`);
const PKG_PATH = path.join(PKG_DIR, `${PKG}.se.json`);
const PKG_STREAMS = path.join(PKG_DIR, `${PKG}.streams`);
const GRAPHS_CFG = path.join(GRAPHS, `${PKG}.se.json`);
const GRAPHS_DIR = path.join(GRAPHS, `${PKG}.streams`);

await sePreflightSkip();

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 200) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const backups = new Map();
for (const f of BACKUP_FILES) {
  if (fs.existsSync(f)) {
    fs.copyFileSync(f, f + '.ip-bak');
    backups.set(f, true);
  }
}
function restore() {
  for (const f of BACKUP_FILES) {
    const bak = f + '.ip-bak';
    if (backups.get(f) && fs.existsSync(bak)) {
      fs.copyFileSync(bak, f);
      try { fs.unlinkSync(bak); } catch { /* ignore */ }
    } else if (fs.existsSync(bak)) {
      try { fs.unlinkSync(bak); } catch { /* ignore */ }
    }
  }
}

fs.mkdirSync(PKG_STREAMS, { recursive: true });
fs.writeFileSync(
  path.join(PKG_STREAMS, 'alpha.md'),
  '# alpha\n\n原始正文。\n',
  'utf-8'
);
fs.writeFileSync(
  PKG_PATH,
  JSON.stringify(
    {
      $schema: 'snake-manifest-v1',
      id: PKG,
      namespace: PKG,
      streams: [
        {
          name: 'alpha',
          description: '',
          tags: {},
          source: { file_path: `${PKG}.streams/alpha.md`, encoding: 'utf-8' },
        },
      ],
      tools: {},
      system: { graph: { format_version: '5.0', layout: { alpha: { x: 120, y: 160 } } } },
    },
    null,
    2
  ),
  'utf-8'
);

fs.writeFileSync(
  WS,
  JSON.stringify({ workspaceVersion: 2, activeId: 't-inplace', tabs: [{ id: 't-inplace', name: '' }] }),
  'utf-8'
);

const server = spawn('npx.cmd', ['vite', '--port', String(PORT), '--strictPort'], {
  cwd: ROOT,
  stdio: 'ignore',
  shell: true,
  env: await seEnv(),
});
let browser;
let systemIds = [];

try {
  await waitForServer(BASE);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.route('**/api/dialog/open', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ path: PKG_PATH.replace(/\\/g, '/') }),
    })
  );

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow', { timeout: 15000 });

  await page.click('.tab-add');
  await page.waitForSelector('.newtab-dialog', { timeout: 10000 });
  await page.click('.newtab-choice-package');
  await page.waitForSelector('.modal .pkg-summary', { timeout: 20000 });
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('.modal .dlg-actions .primary')).find((b) =>
      b.textContent.includes('确认导入')
    );
    btn?.click();
  });
  await sleep(2500);

  await page.waitForFunction(
    (pkg) => Array.from(document.querySelectorAll('.tab')).some((t) => t.textContent.includes(pkg)),
    PKG,
    { timeout: 120000 }
  );
  const tabInfo = await page.evaluate((pkg) => {
    const t = Array.from(document.querySelectorAll('.tab')).find((x) => x.textContent.includes(pkg));
    return {
      text: t?.textContent.trim() || '',
      active: !!t?.classList.contains('active'),
      dot: t?.querySelector('.tab-se-dot')?.className || '',
      online: !!t?.querySelector('.tab-se-dot.se-dot-online'),
    };
  }, PKG);
  check('包 tab 已创建且在线', tabInfo.online, JSON.stringify(tabInfo));
  await page.evaluate((pkg) => {
    const t = Array.from(document.querySelectorAll('.tab')).find((x) => x.textContent.includes(pkg));
    t?.click();
  }, PKG);
  await sleep(800);

  check('绑定完成：外部包 tab 在线', true);
  await page.waitForSelector('.newtab-dialog', { state: 'detached', timeout: 60000 }).catch(() => {});
  await sleep(600);

  // 切到流面板（已是 active 且展开时不要再点，否则会折叠）。
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.rail-btn')).find((x) =>
      x.textContent.includes('🌊')
    );
    if (!b) return;
    const sidebar = document.querySelector('.file-sidebar');
    const collapsed = !!sidebar?.classList.contains('collapsed');
    if (b.classList.contains('active')) {
      if (collapsed) b.click();
    } else {
      b.click();
    }
  });
  await sleep(400);
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('.stream-name')).some((e) => e.textContent === 'alpha'),
    undefined,
    { timeout: 30000 }
  );
  check('导入后 alpha 出现在流面板', true);

  const before = (await page.$$('.stream-item')).length;
  await page.click('.sidebar-head .head-btn[title="新建流"]');
  await page.waitForSelector('.modal input[type="text"]', { timeout: 8000 });
  await page.fill('.modal input[type="text"]', 'beta');
  await page.fill('.modal textarea[placeholder^="初始内容"]', 'B 正文');
  await page.click('.modal .dlg-actions .primary');
  await page.waitForFunction(
    (n) => document.querySelectorAll('.stream-item').length > n,
    before,
    { timeout: 30000 }
  );
  await sleep(2200);

  const doc = JSON.parse(fs.readFileSync(PKG_PATH, 'utf-8'));
  const byName = new Map((Array.isArray(doc.streams) ? doc.streams : []).map((s) => [s.name, s]));
  check('外部包配置写回：含 alpha + beta', byName.has('alpha') && byName.has('beta'), [...byName.keys()].join(','));
  check(
    'alpha source 保持包内路径',
    byName.get('alpha')?.source?.file_path === `${PKG}.streams/alpha.md`,
    JSON.stringify(byName.get('alpha')?.source)
  );
  check(
    'beta source 写回包内 streams 目录',
    byName.get('beta')?.source?.file_path === `${PKG}.streams/beta.md`,
    JSON.stringify(byName.get('beta')?.source)
  );
  const betaFile = path.join(PKG_STREAMS, 'beta.md');
  check('beta 正文文件已生成', fs.existsSync(betaFile));
  check(
    'beta 正文内容正确',
    fs.existsSync(betaFile) && fs.readFileSync(betaFile, 'utf-8').includes('B 正文')
  );
  check(
    'alpha 原文件未被多余重写',
    fs.readFileSync(path.join(PKG_STREAMS, 'alpha.md'), 'utf-8') === '# alpha\n\n原始正文。\n'
  );
  check('未生成 graphs/<包名>.se.json 副本', !fs.existsSync(GRAPHS_CFG));
  check('未生成 graphs/<包名>.streams 副本', !fs.existsSync(GRAPHS_DIR));

  const ws = JSON.parse(fs.readFileSync(WS, 'utf-8'));
  const tab = (Array.isArray(ws.tabs) ? ws.tabs : []).find((t) => t.system?.manifest_path);
  check('工作区 tab 绑定 manifest_path', !!tab, JSON.stringify(tab?.system || null));
  check('工作区 tab 未复制 docPath', !tab?.docPath, JSON.stringify(tab?.docPath || null));

  systemIds = (Array.isArray(ws.tabs) ? ws.tabs : [])
    .map((t) => t?.system?.system_id)
    .filter(Boolean)
    .map(String);

  check('无页面级 JS 错误', consoleErrors.length === 0, consoleErrors[0] || '');
} catch (err) {
  check('执行异常', false, err && (err.stack || err.message));
} finally {
  try { if (browser) await browser.close(); } catch { /* ignore */ }
  try { spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
  for (const sid of new Set(systemIds)) cleanupSeSystem(sid);
  restore();
  try { fs.rmSync(PKG_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
if (failed.length) process.exit(1);
