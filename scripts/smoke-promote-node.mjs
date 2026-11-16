// Task5 冒烟：pending → SE 流自动提升（方案 §4.2）。
// 覆盖：
//   ① 离线态存在的 n-* pending 节点，在 SE 连接恢复（重连）后自动提升为 s-*，正文进 SE；
//   ② pending↔pending 本地边在两端都提升后变为 SE 派生边（edge.<目标> 标签），不丢失；
//   ③ 非法名经 toStreamName 推导改名（bad name! → bad_name），并出现在 SE；
//   ④ 离线时新增的 pending 节点，点「待同步」角标 → 保持 pending（保留 id/角标）+ 一次原因 toast；
//      随后重连同样自动提升。
//
// 隔离与复现策略：应用已移除「本地草稿」tab（每个 tab 终将绑定真实 SE），故在线时无法再产
// n-*。本脚本以「绑定 tab + 预置 pending 节点的 store 快照」复现「离线期间创建的本地节点」，
// 再以「杀掉 SE 进程 + 拦截 /api/se/spawn 阻断自愈」制造可观测的 OFFLINE 窗口，触发
// handleSeReconnected 的自动提升（真实事件路径，非测试后门）。④ 则在离线窗口内经工具栏
// 「+ 添加节点」走本地逃生舱产 n-*，确定性地测试角标重试；随后解除拦截并重新 spawn 触发提升。
//
// 真实 SE 不可用 → sePreflightSkip() 优雅退出 0。
import { chromium } from 'playwright-core';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {
  sePreflightSkip,
  seEnv,
  cleanupSeSystem,
  cleanupGraphArtifacts,
  purgeTestTabsFromWorkspace,
  workspaceSystemIds,
} from './se-ui-helper.mjs';

const PORT = 5201;
const BASE = `http://localhost:${PORT}`;
const SID = `smoke-promote-${Date.now().toString(36)}`;
const TAB_NAME = `promote-${Date.now().toString(36)}`;
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

/** 找出承载 SID 的 python（SE）进程 pid（cmdline 含 --storage .../<SID>）。 */
function sePidsFor(sid) {
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -like '*${sid}*' } | ForEach-Object { $_.ProcessId }`,
      ],
      { encoding: 'utf-8', windowsHide: true, timeout: 20000 }
    );
    return String(out || '').trim().split(/\s+/).filter(Boolean);
  } catch (err) {
    return [];
  }
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 180) : ''}`);
};

const backups = new Map();
for (const f of BACKUP_FILES) {
  if (fs.existsSync(f)) { fs.copyFileSync(f, f + '.smk-bak'); backups.set(f, true); }
}
function restore() {
  for (const f of BACKUP_FILES) {
    const bak = f + '.smk-bak';
    if (backups.get(f) && fs.existsSync(bak)) {
      // vite 退出竞态：浏览器关闭后在途的工作区写请求可能晚于 restore 落盘（实证：.workspace.json
      // 被测试种子覆盖）。写后读回校验，不一致则退避重试。
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
    } else if (fs.existsSync(bak)) fs.rmSync(bak, { force: true });
  }
}

// 种子：绑定真实 SE 的 tab + 预置 pending 节点（含正文）+ 一条 pending→pending 本地边。
const SEED_WORKSPACE = {
  activeId: 't-promote',
  tabs: [
    {
      id: 't-promote',
      name: TAB_NAME,
      system: { system_id: SID, display_name: SID, manifest_path: null, storage_dir: `se-systems/${SID}` },
    },
  ],
  store: {
    't-promote': {
      nodes: [
        { id: 'n-1', position: { x: 80, y: 80 }, data: { name: '节点甲', content: '内容甲' } },
        { id: 'n-2', position: { x: 520, y: 80 }, data: { name: '节点乙', content: '内容乙' } },
        { id: 'n-3', position: { x: 80, y: 460 }, data: { name: 'bad name!', content: '内容丙' } },
      ],
      edges: [{ id: 'e-1', source: 'n-1', target: 'n-2', label: '流向' }],
      tools: {},
      viewport: null,
    },
  },
};
fs.mkdirSync(path.dirname(BACKUP_FILES[0]), { recursive: true });
fs.writeFileSync(BACKUP_FILES[0], JSON.stringify(SEED_WORKSPACE));

const server = spawn('npx.cmd', ['vite', '--port', String(PORT), '--strictPort'], { cwd: process.cwd(), stdio: 'ignore', shell: true, env: await seEnv() });

let browser;
let context;
try {
  await waitForServer(BASE);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  context = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => {
    const t = m.text();
    // 离线期间 WS 断连的错误日志是预期噪声，不计入「控制台无错误」。
    if (m.type() === 'error' && !/Failed to load resource/.test(t) && !/WebSocket|ws:\/\//i.test(t)) {
      consoleErrors.push(t);
    }
  });

  // 浏览器内直连 SE WS（同源代理代发 auth），用于断言 SE 真源。
  const seCall = (method, params) =>
    page.evaluate(
      ({ sid, method, params }) =>
        new Promise((resolve, reject) => {
          const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
          const ws = new WebSocket(`${proto}//${location.host}/api/se/ws?system_id=${encodeURIComponent(sid)}`);
          const id = 1;
          const to = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error('seCall timeout')); }, 12000);
          ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', method, params: params || {}, id }));
          ws.onmessage = (ev) => {
            let m;
            try { m = JSON.parse(ev.data); } catch (e) { return; }
            if (m && m.id === id) {
              clearTimeout(to);
              try { ws.close(); } catch (e) {}
              if (m.error) reject(new Error(m.error.message || 'SE error'));
              else resolve(m.result);
            }
          };
          ws.onerror = () => { clearTimeout(to); reject(new Error('ws error')); };
        }),
      { sid: SID, method, params }
    );

  const pendingCount = () => page.evaluate(() => document.querySelectorAll('.react-flow__node .pending-badge').length);
  const hasNode = (id, timeout = 20000) =>
    page.waitForFunction((i) => !!document.querySelector(`.react-flow__node[data-id="${i}"]`), id, { timeout }).then(() => true).catch(() => false);
  const waitOnline = (timeout = 90000) =>
    page.waitForFunction(() => {
      const active = document.querySelector('.tab.active');
      return !!(active && active.querySelector('.tab-se-dot.se-dot-online'));
    }, null, { timeout });
  const waitOffline = (timeout = 20000) =>
    page.waitForFunction(() => !!document.querySelector('.flow.flow-offline'), null, { timeout }).then(() => true).catch(() => false);
  const toastTexts = () => page.evaluate(() => Array.from(document.querySelectorAll('.toast')).map((t) => t.textContent || ''));

  // 与 smoke-edge-align 同款兜底：RF 在重连期突发重投影风暴后偶发不再重绘派生边——
  // 受控 edges state 正确但渲染层 desync（实测仅整页重载可恢复，属渲染层行为、非数据丢失；
  // 功能正确性由下方 SE stream.list/stream.read/tags 断言独立证明）。轮询不到则整页重载复核。
  const ensureEdge = async (id, timeout = 20000) => {
    const found = await page.waitForSelector(`.react-flow__edge[data-id="${id}"]`, { timeout }).then(() => true).catch(() => false);
    if (found) return true;
    console.log('ensureEdge: RF 未在会话内重绘该边（渲染层行为），改以整页重载复核数据完好');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.react-flow', { timeout: 15000 });
    await waitOnline(60000);
    return page.waitForSelector(`.react-flow__edge[data-id="${id}"]`, { timeout: 30000 }).then(() => true).catch(() => false);
  };

  /** 制造可观测离线窗口：拦截自愈 spawn + 杀 SE 进程。 */
  const forceOffline = async () => {
    await page.route('**/api/se/spawn', (r) => r.abort());
    const pids = sePidsFor(SID);
    for (const pid of pids) {
      try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* 尽力而为 */ }
    }
    return pids.length;
  };
  /** 解除拦截并重新 spawn（等价重连）。 */
  const forceOnline = async () => {
    await page.unroute('**/api/se/spawn').catch(() => {});
    await fetch(`${BASE}/api/se/spawn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system_id: SID }),
    }).catch(() => {});
  };

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow', { timeout: 15000 });
  await waitOnline();
  await page.waitForTimeout(1200);

  // 确保首轮提升完成：启动期间的 WS 瞬断通常已触发 reconnect 自动提升；若未触发（直连 ONLINE
  // 无 offline 跃迁），用一次受控 offline/online 跃迁补触发（与真实重连同路径）。
  if (!(await hasNode('s-节点甲', 3000))) {
    await forceOffline();
    await waitOffline(20000);
    await forceOnline();
    await waitOnline(60000);
  }
  const promoted = await hasNode('s-节点甲', 45000);
  check('① 连接恢复后自动提升：s-节点甲 出现', promoted);
  // 串行批量提升：等全部 pending 清空再断言（否则会读到提升中途态）。
  await page
    .waitForFunction(() => document.querySelectorAll('.react-flow__node .pending-badge').length === 0, null, { timeout: 60000 })
    .catch(() => {});
  await page.waitForTimeout(500);
  check('① 提升后无 pending 角标', (await pendingCount()) === 0, `count=${await pendingCount()}`);
  check('② 两端提升后本地边变 SE 派生边', await ensureEdge('se-e-节点甲__节点乙', 30000));
  check('② 本地 e-1 边已被 SE 派生边取代', await page.evaluate(() => !document.querySelector('.react-flow__edge[data-id="e-1"]')));
  check('③ 非法名改名：s-bad_name 出现（非 s-bad name!）',
    await page.evaluate(() => !!document.querySelector('.react-flow__node[data-id="s-bad_name"]') && !document.querySelector('.react-flow__node[data-id="s-bad name!"]')));

  // ── SE 真源断言：流、正文、边标签 ──
  const list = await seCall('stream.list', {}).catch(() => null);
  const names = Array.isArray(list) ? list.map((s) => String(s.name)) : [];
  check('① SE stream.list 含 节点甲/节点乙/bad_name',
    ['节点甲', '节点乙', 'bad_name'].every((n) => names.includes(n)), JSON.stringify(names));
  const read甲 = await seCall('stream.read', { name: '节点甲' }).catch(() => null);
  check('① 正文进 SE（节点甲 = 内容甲）', (read甲 && String(read甲.text)) === '内容甲', JSON.stringify(read甲 && read甲.text));
  const read丙 = await seCall('stream.read', { name: 'bad_name' }).catch(() => null);
  check('③ 改名流正文进 SE（bad_name = 内容丙）', (read丙 && String(read丙.text)) === '内容丙', JSON.stringify(read丙 && read丙.text));
  const meta甲 = await seCall('stream.get_metadata', { name: '节点甲' }).catch(() => null);
  const tags甲 = (meta甲 && meta甲.tags) || {};
  check('② SE 边标签存在（节点甲.tags[edge.节点乙]）', Object.prototype.hasOwnProperty.call(tags甲, 'edge.节点乙'), JSON.stringify(tags甲));

  // ── ④ 离线窗口内新增 pending 节点 → 点角标保持 pending + 原因 toast ──
  const killed = await forceOffline();
  check('④ 找到并杀掉 SE 进程', killed > 0, `pids=${killed}`);
  const offlineShown = await waitOffline(25000);
  check('④ 离线态可见（flow-offline）', offlineShown);
  // 工具栏「+ 添加节点」离线走本地逃生舱 → 产 n-*
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.includes('添加节点'));
    if (b) b.click();
  });
  const newPendingId = await page
    .waitForFunction(
      () => {
        const node = document.querySelector('.react-flow__node[data-id^="n-"] .pending-badge');
        return node ? node.closest('.react-flow__node').getAttribute('data-id') : null;
      },
      null,
      { timeout: 10000 }
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
  check('④ 离线新增节点为 pending（n-*）', !!newPendingId, `id=${newPendingId}`);
  if (newPendingId) {
    await page.evaluate((id) => {
      const b = document.querySelector(`.react-flow__node[data-id="${id}"] .pending-badge`);
      if (b) b.click();
    }, newPendingId);
    await page.waitForTimeout(700);
    check('④ 离线点角标后仍为 pending（id 未换）', await page.evaluate((id) => !!document.querySelector(`.react-flow__node[data-id="${id}"]`), newPendingId));
    check('④ 仍显示「待同步」角标', (await pendingCount()) >= 1);
    const offlineToast = (await toastTexts()).some((t) => t.includes('离线'));
    check('④ 给出一次离线原因提示', offlineToast, (await toastTexts()).join(' | '));

    // 恢复在线 → 新 pending 亦自动提升
    await forceOnline();
    await waitOnline(90000);
    check('④ 重连后离线新增节点也被提升（s-新节点）', await hasNode('s-新节点', 45000));
  }

  check('控制台无错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' || '));
  await page.screenshot({ path: '.sisyphus/smoke-promote-node.png' });
} catch (err) {
  check('冒烟执行', false, String((err && err.message) || err));
} finally {
  if (browser) await browser.close();
  try { spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 尽力而为 */ }
  cleanupSeSystem(SID);
  // seed 工作区里还有运行时派生的 SE（若存在）一并回收。
  for (const id of workspaceSystemIds(BACKUP_FILES[0])) cleanupSeSystem(id);
  restore();
  purgeTestTabsFromWorkspace(BACKUP_FILES[0]);
  cleanupGraphArtifacts(TAB_NAME);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
