// 「启动 / 切换标签自动 attach-or-spawn」浏览器 E2E（真实 snakeeats + Vite dev server + Chrome）。
//
// 覆盖设计文档 docs/superpowers/specs/2026-09-23-se-auto-spawn-on-startup-design.md 的核心验收：
//   (A) 偏好 autoSpawnSe=false（P7 后该偏好已被移除、读取即忽略）：启动恢复一个「已绑定但未运行」
//       的标签 → 仍强制自动拉起（端点 online、状态点转绿），证明不存在「关闭自动拉起」的本地逃生舱；
//   (B) 偏好 autoSpawnSe=true（默认）：同一场景 → 自动拉起同一 storage 的 SE（端点 online）、
//       tabbar 状态点转绿（.tab-se-dot.se-dot-online）、离线只读横幅消失、经代理 system.info 通。
//
// 手法：向 graphs/.workspace.json 写入「活动标签绑定 system」的确定性工作区 + graphs/.ui.json
// 写入开关值，加载页面后观察行为；finally 还原两个文件、清理 storage、关浏览器/vite。
// 端口 5297（strictPort；先 anyListener 预检）。chrome 不可用或 SE 不可用 → SKIP（exit 0）。
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { preflight } from './se-preflight.mjs';
import { cleanupGraphArtifacts, purgeTestTabsFromWorkspace } from './se-ui-helper.mjs';
import {
  ROOT,
  seEnvForTests,
  waitForServer,
  anyListener,
  closeViteGracefully,
  cleanupSeStorage,
} from './se-test-helper.mjs';

const PORT = 5297;
const BASE = `http://localhost:${PORT}`;
const TS = Date.now().toString(36);
const SID = `autospawn-${TS}`; // 纯 ASCII（OneDrive rmSync 隐患）
const WS_FILE = path.join(ROOT, 'graphs', '.workspace.json');
const UI_FILE = path.join(ROOT, 'graphs', '.ui.json');
const WATCHDOG_MS = 300000;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 220) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 工作区 / 偏好 备份与还原（不污染用户数据）────────────────────────────────
const backups = new Map();
for (const f of [WS_FILE, UI_FILE]) {
  if (fs.existsSync(f)) {
    fs.copyFileSync(f, f + '.autospawn-bak');
    backups.set(f, true);
  }
}
function restore() {
  for (const f of [WS_FILE, UI_FILE]) {
    const bak = f + '.autospawn-bak';
    if (backups.get(f) && fs.existsSync(bak)) {
      fs.copyFileSync(bak, f);
      try { fs.rmSync(bak, { force: true }); } catch { /* 忽略 */ }
    } else if (fs.existsSync(bak)) {
      try { fs.rmSync(bak, { force: true }); } catch { /* 忽略 */ }
    }
  }
}

/** 写入确定的「活动标签绑定 systemId」工作区 + autoSpawnSe 开关。 */
function seed(systemId, autoSpawnSe) {
  fs.mkdirSync(path.dirname(WS_FILE), { recursive: true });
  fs.writeFileSync(
    WS_FILE,
    JSON.stringify({
      activeId: 't-auto',
      tabs: [
        {
          id: 't-auto',
          name: 'autospawn',
          system: {
            system_id: systemId,
            display_name: 'AutoSpawn',
            manifest_path: null,
            storage_dir: `se-systems/${systemId}`,
          },
        },
      ],
      store: { 't-auto': { nodes: [], edges: [], tools: {} } },
    })
  );
  fs.writeFileSync(UI_FILE, JSON.stringify({ autoSpawnSe }));
}

/** 起 vite（带 IPC：disconnect 触发退出钩子，连带清理其托管的 SE）。 */
async function spawnViteIpc() {
  const env = await seEnvForTests();
  delete env.SNAKEEATS_ADMIN_TOKEN;
  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env,
  });
  let out = '';
  const drain = (d) => { out = (out + String(d)).slice(-3000); };
  child.stdout.on('data', drain);
  child.stderr.on('data', drain);
  child.getOutput = () => out;
  return child;
}

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
          resolve({ status: res.statusCode, data });
        });
      }
    );
    const timer = setTimeout(() => req.destroy(new Error(`GET ${pathname} timeout`)), timeoutMs);
    req.on('error', (err) => { clearTimeout(timer); reject(err); });
    req.end();
  });
}

async function waitEndpointOnline(systemId, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const res = await httpGetJson(`/api/se/endpoint?system_id=${encodeURIComponent(systemId)}`, 5000);
      last = res.data;
      if (last && last.status === 'online') return last;
    } catch {
      last = null;
    }
    await sleep(500);
  }
  return last;
}

let browser = null;
let viteA = null;
let viteB = null;
let watchdogTimer = null;

/** 附加页面诊断：把浏览器侧错误打到 Node 控制台（失败时定位用）。 */
function attachDiag(page, tag) {
  page.on('pageerror', (e) => console.log(`[${tag}] PAGEERROR: ${e.stack || e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`[${tag}] CONSOLE.ERROR: ${m.text()}`);
  });
}

async function cleanupAndExit(code) {
  clearTimeout(watchdogTimer);
  try { if (browser) await browser.close(); } catch { /* 忽略 */ }
  if (viteA) await closeViteGracefully(viteA).catch(() => {});
  if (viteB) await closeViteGracefully(viteB).catch(() => {});
  await sleep(1200);
  restore();
  await cleanupSeStorage({ id: SID });
  purgeTestTabsFromWorkspace(WS_FILE);
  cleanupGraphArtifacts('autospawn');
  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
  process.exit(code);
}

watchdogTimer = setTimeout(() => {
  console.error('\nWATCHDOG: e2e-se-autostart 超时，强清退出');
  cleanupAndExit(2);
}, WATCHDOG_MS);

try {
  const pf = await preflight();
  if (!pf.available) {
    console.log(`SKIP: SE unavailable (${pf.reason})`);
    clearTimeout(watchdogTimer);
    restore();
    process.exit(0);
  }
  console.log(`SE preflight: AVAILABLE — ${pf.reason}`);
  console.log(`  system_id: ${SID}  port: ${PORT}`);

  if (await anyListener(PORT)) throw new Error(`端口 ${PORT} 已被占用，请先清理`);
  await cleanupSeStorage({ id: SID });

  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch (err) {
    console.log(`SKIP: chrome 不可用（${(err && err.message) || err}）`);
    await cleanupAndExit(0);
  }

  // ══ Phase A：autoSpawnSe=false 已被忽略 → 仍强制自动拉起 ═══════════════
  // P7：应用移除了「暂不绑定」本地逃生舱，dev server 强制 spawn；该偏好存盘即被忽略。
  seed(SID, false);
  viteA = await spawnViteIpc();
  try {
    await waitForServer(BASE);
  } catch (err) {
    throw new Error(`vite#A 未就绪：${err.message}\n${viteA.getOutput()}`);
  }
  {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    attachDiag(page, 'A');
    try {
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.react-flow', { timeout: 20000 });
      // 绑定 tab 存在（说明恢复生效）。
      check('(A) 已绑定标签挂载（.tab-se-dot 存在）', !!(await page.$('.tab-se-dot')));
      // 偏好被忽略：仍强制自动拉起 → 状态点转绿。
      let greenA = true;
      try {
        await page.waitForSelector('.tab-se-dot.se-dot-online', { timeout: 70000 });
      } catch {
        greenA = false;
      }
      check('(A) 开关关闭仍强制拉起：状态点转 online（绿）', greenA);
      const ep = await waitEndpointOnline(SID, 30000);
      check(
        '(A) 开关关闭：端点 online（强制自动拉起）',
        ep && ep.status === 'online',
        JSON.stringify(ep)
      );
      const bannerAGone = await page
        .waitForFunction(() => !document.querySelector('.se-offline-banner'), null, { timeout: 10000 })
        .then(() => true)
        .catch(() => false);
      check('(A) 离线只读横幅消失', bannerAGone);
    } finally {
      await page.close().catch(() => {});
    }
  }
  await closeViteGracefully(viteA);
  viteA = null;

  // ══ Phase B：开关开启（默认）→ 自动拉起 + 状态点转绿 ═══════════════════
  seed(SID, true);
  viteB = await spawnViteIpc();
  try {
    await waitForServer(BASE);
  } catch (err) {
    throw new Error(`vite#B 未就绪：${err.message}\n${viteB.getOutput()}`);
  }
  {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    attachDiag(page, 'B');
    try {
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.react-flow', { timeout: 20000 });

      let green = true;
      try {
        await page.waitForSelector('.tab-se-dot.se-dot-online', { timeout: 70000 });
      } catch {
        green = false;
      }
      check('(B) 开关开启：tabbar 状态点转 online（绿）', green);

      const ep = await waitEndpointOnline(SID, 60000);
      check('(B) 端点 online（自动拉起成功）', ep && ep.status === 'online', JSON.stringify(ep));

      const bannerGone = await page
        .waitForFunction(() => !document.querySelector('.se-offline-banner'), null, { timeout: 10000 })
        .then(() => true)
        .catch(() => false);
      check('(B) 离线只读横幅消失', bannerGone);

      // 经代理 system.info：证明连接 + 身份校验通过（同样内容的系统被拉起）。
      let info = null;
      for (let attempt = 0; attempt < 10 && !(info && info.system_id === SID); attempt += 1) {
        info = await page.evaluate(
          (sid) =>
            new Promise((resolve) => {
              let ws;
              try {
                ws = new WebSocket(`ws://localhost:${location.port}/api/se/ws?system_id=${encodeURIComponent(sid)}`);
              } catch {
                resolve(null);
                return;
              }
              const t = setTimeout(() => { try { ws.close(); } catch { /* 忽略 */ } resolve(null); }, 3000);
              ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'system.info', params: {}, id: 1 }));
              ws.onmessage = (e) => {
                try {
                  const m = JSON.parse(e.data);
                  if (m && m.id === 1) { clearTimeout(t); ws.close(); resolve(m.result || null); }
                } catch { /* 忽略 */ }
              };
              ws.onerror = () => { clearTimeout(t); resolve(null); };
            }),
          SID
        );
        if (!(info && info.system_id === SID)) await sleep(500);
      }
      check('(B) 经代理 system.info 通（身份校验）', info && info.system_id === SID, JSON.stringify(info));
    } finally {
      await page.close().catch(() => {});
    }
  }
  await closeViteGracefully(viteB);
  viteB = null;
} catch (err) {
  check('e2e 执行', false, String((err && err.stack) || err));
}

await cleanupAndExit(results.some((r) => !r.ok) ? 1 : 0);
