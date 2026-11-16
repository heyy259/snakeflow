// 临时冒烟：节点扫描条 + 终端（阶段 8/9 验证，非正式 e2e）。
// 本地画布逃生舱已移除：标签页必须绑定真实 SE，扫描经 SE scan.* 路由（无「未绑定请先绑定」本地拒绝、
// 无本地随机游走 mock）；真实 SE 扫描生命周期由 scripts/smoke-se-scan.mjs 覆盖。
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
import { connectSeRpc, SE_SYSTEMS_DIR } from './se-test-helper.mjs';

const PORT = 5194;
const BASE = `http://localhost:${PORT}`;
const SID = `smoke-scan-${Date.now().toString(36)}`;
const BACKUP_FILES = ['graphs/.workspace.json', 'graphs/.frecency.json', 'graphs/.ui.json'].map((p) => path.resolve(p));

// 真实 SE 扫描权限流程需要至少一个会阻塞的标记工具：暂停必须等当前工具结束才 settle。
// 工具文件放在隔离 storage（se-systems/<SID>）下，绝不碰 dev 数据。
const TOOL_NAME = 'probe_sleep';
const TOOL_DIR = path.join(SE_SYSTEMS_DIR, SID, 'tools');
const TOOL_FILE = path.join(TOOL_DIR, `${TOOL_NAME}.py`);
const TOOL_BODY = [
  'import json, sys, time',
  "params = json.loads(sys.stdin.read() or '{}')",
  "time.sleep(float(params.get('seconds', 2)))",
  "print(json.dumps({'done': True}))",
  '',
].join('\n');
// 第三行后放标记：扫描会执行 probe_sleep 2 秒，给暂停/切换留出稳定窗口。
const STREAM_NAME = '扫描流';
const STREAM_CONTENT = '第一行\n第二行\n第三行\n@{probe_sleep|{"seconds":2}}\n';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 有界轮询：fn 返回真值即成功；超时返回 false（绝不无限等待）。 */
async function waitFor(fn, timeoutMs, intervalMs = 150) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await fn()) return true;
    } catch (err) {
      /* 页面/WS 尚在切换：继续轮询 */
    }
    await sleep(intervalMs);
  }
  return false;
}

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

const seFrames = [];
const seRecvFrames = [];
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

const server = spawn('npx.cmd', ['vite', '--port', String(PORT), '--strictPort'], { cwd: process.cwd(), stdio: 'ignore', shell: true, env: await seEnv() });
let browser;
let page;
try {
  await waitForServer(BASE);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));
  // 采集浏览器→代理的 SE WS 帧：用于证明扫描确实路由到 SE（而非本地 mock）。
  page.on('websocket', (ws) => {
    if (!/\/api\/se\/ws/.test(ws.url())) return;
    ws.on('framesent', (f) => seFrames.push(String(f.payload)));
    ws.on('framereceived', (f) => seRecvFrames.push(String(f.payload)));
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow', { timeout: 15000 });
  await page.waitForTimeout(600);

  // 0. 新建绑定真实 SE 的标签页（本地草稿逃生舱已移除）
  await createBoundTab(page, SID);
  // createBoundTab 的 online 轮询可能在旧 active tab 上提前通过；显式切回本 SID 的绑定 tab，
  // 否则后续建流会落到旧 tab 的真实数据里（并导致节点文本断言失败）。
  await page.waitForFunction(
    (sid) => Array.from(document.querySelectorAll('.tab')).some((t) => (t.getAttribute('title') || '').includes(sid)),
    SID,
    { timeout: 30000 }
  );
  await page.evaluate((sid) => {
    const tab = Array.from(document.querySelectorAll('.tab')).find((t) =>
      (t.getAttribute('title') || '').includes(sid)
    );
    if (tab && !tab.classList.contains('active')) tab.click();
  }, SID);
  await page.waitForFunction(
    (sid) => {
      const active = document.querySelector('.tab.active');
      return !!(
        active &&
        (active.getAttribute('title') || '').includes(sid) &&
        active.querySelector('.tab-se-dot.se-dot-online')
      );
    },
    SID,
    { timeout: 30000 }
  );
  await page.waitForTimeout(500);

  // 0b. 真实 SE 上注册一个会 sleep 的探测工具（scan 执行标记用）。
  //     经 /api/se/ws 代理（root token 由代理注入）调用 tool.register，断言 RPC 成功。
  fs.mkdirSync(TOOL_DIR, { recursive: true });
  fs.writeFileSync(TOOL_FILE, TOOL_BODY, 'utf-8');
  let registeredTool = null;
  let registrationError = '';
  // createBoundTab 只等 UI 状态点；代理 upstream 的 auth 可能仍在建立，允许有界重试。
  for (let attempt = 0; attempt < 3 && !registeredTool; attempt += 1) {
    let regRpc = null;
    try {
      regRpc = await connectSeRpc({ vitePort: PORT, systemId: SID, timeout: 15000 });
      const reg = await regRpc.call(
        'tool.register',
        {
          name: TOOL_NAME,
          description: 'P5-QA3 probe: read JSON from stdin, sleep seconds (default 2), print done.',
          tool_path: TOOL_FILE,
          execution_path: TOOL_DIR,
        },
        15000
      );
      if (reg && reg.success !== false) {
        registeredTool = reg;
        registrationError = '';
      } else {
        registrationError = JSON.stringify(reg);
      }
    } catch (err) {
      registrationError = String((err && err.message) || err);
    } finally {
      if (regRpc) regRpc.close();
    }
    if (!registeredTool && attempt < 2) await sleep(2000);
  }
  check('真实 SE 注册 probe_sleep 工具', !!registeredTool, registrationError);

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

  // 建一个带正文的流：扫描必须针对真实 SE 流节点（空节点无 stream name，不会发 scan.start）。
  await activateRail('🌊');
  const beforeStreams = (await page.$$('.stream-item')).length;
  await page.click('.sidebar-head .head-btn');
  await page.waitForSelector('.modal input[type="text"]', { timeout: 8000 });
  await page.fill('.modal input[type="text"]', STREAM_NAME);
  const textareas = await page.$$('.modal .dlg-textarea');
  await textareas[textareas.length - 1].fill(STREAM_CONTENT);
  await page.click('.dlg-actions .primary');
  await page.waitForFunction(
    (n) => document.querySelectorAll('.stream-item').length > n,
    beforeStreams,
    { timeout: 20000 }
  );
  // 绑定 tab：新流的正文经 SE 异步回读水合；内容为空时 scan 驱动会直接拒绝（不发 scan.start）。
  // 旧 tab 的水合竞态可能短暂把旧节点留在画布上：按正文定位本次新建的节点，绝不点第一个节点。
  const streamNode = page.locator('.react-flow__node').filter({ hasText: '第一行' }).first();
  await streamNode.waitFor({ state: 'visible', timeout: 60000 });
  await page.waitForTimeout(300);

  // 旧 tab 节点可能残留在同一画布：所有扫描控件断言都限定在本次新建的 streamNode 内，
  // 绝不使用全局 querySelector('.scan-state')（会命中旧节点的常驻扫描条）。
  const nodeScanBar = () => streamNode.locator('.scan-strip');
  const nodeScanState = async () =>
    (await streamNode
      .locator('.scan-state')
      .first()
      .textContent()
      .catch(() => '')) || '';
  const nodeControlCount = () => streamNode.locator('.scan-controls').count();
  const nodeBadgeCount = () => streamNode.locator('.scan-authority-badge').count();
  const nodeBadgeText = async () => {
    const badge = streamNode.locator('.scan-authority-badge').first();
    return (await badge.count()) ? ((await badge.textContent()) || '').trim() : '';
  };
  const nodeSelect = (label) => streamNode.locator(`select[aria-label="${label}"]`);
  const clickNodeButton = (label) =>
    streamNode.evaluate((node, text) => {
      const btn = Array.from(node.querySelectorAll('.scan-controls > button')).find((b) =>
        b.textContent.includes(text)
      );
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    }, label);

  // 1. 扫描条常驻行：待机；未选中无控制行（先点空白处取消新建流的自动选中）
  // 找画布上真正空白的点（避开节点/侧栏/控件）取消选中；新节点位置不固定，不能写死坐标。
  const emptyPoint = await page.evaluate(() => {
    const pane = document.querySelector('.react-flow__pane');
    if (!pane) return null;
    const r = pane.getBoundingClientRect();
    for (let y = r.top + 50; y < r.bottom - 50; y += 40) {
      for (let x = r.left + 50; x < r.right - 50; x += 40) {
        const el = document.elementFromPoint(x, y);
        if (
          el &&
          (el === pane || pane.contains(el)) &&
          !el.closest('.react-flow__node') &&
          !el.closest('button') &&
          !el.closest('select') &&
          !el.closest('input') &&
          !el.closest('.file-sidebar')
        ) {
          return { x, y };
        }
      }
    }
    return null;
  });
  if (emptyPoint) await page.mouse.click(emptyPoint.x, emptyPoint.y);
  await page.waitForTimeout(300);
  check('扫描条常驻行存在', (await nodeScanBar().count()) > 0);
  check('待机状态文案', (await nodeScanState()) === '待机');
  check('未选中无控制行', (await nodeControlCount()) === 0);

  // 2. 选中绑定节点 → 展开控制行；验证 idle 权限选择器来自 UI 契约。
  const wsFrame = (method, key, value) =>
    seFrames.some((raw) => {
      try {
        const msg = JSON.parse(raw);
        if (!msg || msg.method !== method) return false;
        return key === undefined || (msg.params && msg.params[key] === value);
      } catch (err) {
        return false;
      }
    });

  await streamNode.click();
  check('选中后控制行展开', await waitFor(async () => (await nodeControlCount()) > 0, 8000));

  // 2a. idle 初始权限选择器：存在且选项 = 默认 / workspace-write / full。
  const idleAuthority = nodeSelect('扫描权限');
  const idleAuthorityCount = await idleAuthority.count();
  check('idle 权限选择器存在', idleAuthorityCount > 0);
  const idleOptions =
    idleAuthorityCount > 0
      ? await idleAuthority.first().evaluate((el) => Array.from(el.options).map((o) => o.value))
      : [];
  check(
    'idle 权限选项为 默认/workspace-write/full',
    idleOptions.length === 3 &&
      idleOptions[0] === '' &&
      idleOptions.includes('workspace-write') &&
      idleOptions.includes('full'),
    JSON.stringify(idleOptions)
  );
  if (idleAuthorityCount > 0) await idleAuthority.first().selectOption('workspace-write');
  check(
    'idle 选择初始权限 workspace-write',
    idleAuthorityCount > 0 && (await idleAuthority.first().inputValue()) === 'workspace-write'
  );

  // 2b. 开始：浏览器发出的 scan.start 必须携带 authority=workspace-write。
  await clickNodeButton('开始');
  const routedToSe = await waitFor(() => wsFrame('scan.start'), 10000);
  check('绑定节点「开始」→ 经 SE scan.start（WS 帧）', routedToSe);
  check(
    'scan.start 帧携带 authority=workspace-write',
    await waitFor(() => wsFrame('scan.start', 'authority', 'workspace-write'), 10000),
    seFrames.filter((f) => f.includes('scan.start')).slice(-1)[0] || ''
  );
  check('无本地「请先绑定」toast（已绑定，能力门放行）', await page.evaluate(() =>
    !Array.from(document.querySelectorAll('.toast')).some((t) => t.textContent.includes('请先绑定'))
  ));
  const reachedScanning = await waitFor(async () => {
    const label = await nodeScanState();
    if (label === '扫描中' || label === '暂停中…') return true;
    return streamNode.evaluate((node) => {
      const pause = Array.from(node.querySelectorAll('.scan-controls > button')).find((b) =>
        b.textContent.includes('暂停')
      );
      return !!(pause && !pause.disabled);
    });
  }, 15000);
  check('开始后进入非待机状态', reachedScanning);

  // scan.start 会创建 _scan_log/_console 并触发重投影，可能丢失节点选中态并卸载控制行。
  // 有界重试：重新选中 → 等控制行 → 派发暂停；先断言点击已派发，再断言 paused。
  const ensureSelected = async () => {
    if ((await nodeControlCount()) > 0) return true;
    await streamNode.click().catch(() => {});
    return waitFor(async () => (await nodeControlCount()) > 0, 8000);
  };
  let pauseDispatched = false;
  for (let attempt = 0; attempt < 6 && !pauseDispatched; attempt += 1) {
    if (!(await ensureSelected())) continue;
    pauseDispatched = await clickNodeButton('暂停');
    if (!pauseDispatched) await page.waitForTimeout(200);
  }
  check('暂停点击已派发（重投影后自动重新选中）', pauseDispatched);
  if (pauseDispatched) {
    check('暂停请求 routed 到 SE scan.pause', await waitFor(() => wsFrame('scan.pause'), 10000));
  }
  const paused = await waitFor(async () => (await nodeScanState()) === '已暂停', 25000);
  check('暂停后 settles 到「已暂停」', paused, await nodeScanState());
  // 额外读取服务端 scan.status：证明徽标不是本地乐观值，且 allowed/canSet 也来自服务端事实。
  let pausedStatus = null;
  try {
    const statusRpc = await connectSeRpc({ vitePort: PORT, systemId: SID, timeout: 10000 });
    try {
      pausedStatus = await statusRpc.call('scan.status', { stream_name: STREAM_NAME }, 10000);
    } finally {
      statusRpc.close();
    }
  } catch (err) {
    pausedStatus = { error: String((err && err.message) || err) };
  }
  check(
    '暂停时 scan.status 权威值可读（服务端事实）',
    !!pausedStatus && !pausedStatus.error,
    JSON.stringify(pausedStatus).slice(0, 260)
  );
  // 暂停响应/事件到达与 React 渲染有一帧延迟：有界等待徽标出现，再做取值断言。
  const badgeReady = await waitFor(async () => (await nodeBadgeCount()) > 0, 5000);
  check('暂停后权限徽标出现', badgeReady);
  const badgeText = await nodeBadgeText();
  const serverAuthority = pausedStatus && !pausedStatus.error ? pausedStatus.authority : null;
  check(
    '暂停徽标与 scan.status authority 一致（非本地乐观）',
    !!serverAuthority && new RegExp(`权限[:：]\\s*${String(serverAuthority).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(badgeText),
    `badge=${badgeText || '<none>'} server=${serverAuthority}`
  );

  // 扫描事件可能触发重投影并丢失节点选中态：重新选中（用户仍可操作同一节点）以展开控制行。
  check('暂停后节点可重新选中并展开控制行', await ensureSelected());
  const lastScanEvent = (() => {
    for (let i = seRecvFrames.length - 1; i >= 0; i -= 1) {
      try {
        const msg = JSON.parse(seRecvFrames[i]);
        if (!msg || msg.method !== 'scan.on_change') continue;
        const p = msg.params || {};
        const c = p.change || {};
        return `authority=${p.authority} type=${c.type} state=${c.new_state || c.state || ''}`;
      } catch (err) {
        /* 非 JSON 帧 */
      }
    }
    return '';
  })();
  // Vite 代理注入的是 root token；SE 的 resolve_scan_authority 对 root 无条件返回 full
  // （snakeeats/tests/tools/test_scan_authority.py::test_root_maps_to_full_even_when_lower_is_requested）。
  // UI 仍正确发出 scan.start{authority:workspace-write}；这里断言徽标严格跟随服务端事实 full。
  check(
    '暂停徽标遵循服务端 authority（root 代理 → full；非本地乐观）',
    serverAuthority === 'full' && /权限[:：]\s*full\b/.test(badgeText),
    `badge=${badgeText || '<none>'} server=${serverAuthority} lastEvent=${lastScanEvent || '<none>'}`
  );

  // 3b. 暂停时切换权限：控件必须在同一 tab、无 reload 的情况下由 scan.status 水合出现。
  // 选项严格来自服务端 allowed_authorities；若存在不同档才执行切换，否则如实记录 root 代理只有 full。
  const switchAuthority = nodeSelect('切换扫描权限');
  const switchReady = await waitFor(async () => (await switchAuthority.count()) > 0, 15000);
  const switchAuthorityCount = switchReady ? await switchAuthority.count() : 0;
  check(
    '暂停后切换权限选择器存在（无需 reload）',
    switchAuthorityCount > 0,
    `serverAllowed=${JSON.stringify(pausedStatus && pausedStatus.allowed_authorities)} canSet=${pausedStatus && pausedStatus.can_set_authority}`
  );
  const switchOptions =
    switchAuthorityCount > 0
      ? await switchAuthority.first().evaluate((el) => Array.from(el.options).map((o) => o.value))
      : [];
  const serverAllowed = Array.isArray(pausedStatus && pausedStatus.allowed_authorities)
    ? pausedStatus.allowed_authorities
    : [];
  check(
    '切换权限选项与服务端 allowed_authorities 一致',
    switchOptions.length === serverAllowed.length && switchOptions.every((v) => serverAllowed.includes(v)),
    `ui=${JSON.stringify(switchOptions)} server=${JSON.stringify(serverAllowed)}`
  );
  const switchTarget = switchOptions.find((v) => v && v !== serverAuthority);
  if (switchTarget) {
    await switchAuthority.first().selectOption(switchTarget);
    check(
      `scan.set_authority 帧携带 authority=${switchTarget}`,
      await waitFor(() => wsFrame('scan.set_authority', 'authority', switchTarget), 15000),
      seFrames.filter((f) => f.includes('scan.set_authority')).slice(-1)[0] || ''
    );
    const badgeSwitched = await waitFor(
      async () =>
        new RegExp(`权限[:：]\\s*${String(switchTarget).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(
          await nodeBadgeText()
        ),
      15000
    );
    check(`切换后徽标显示服务端 authority=${switchTarget}`, badgeSwitched, await nodeBadgeText());
  } else {
    check(
      'root 代理 allowed_authorities 仅含 full：无不同档可切换（P3/驱动单测已覆盖 set_authority）',
      switchOptions.length === 1 && switchOptions[0] === 'full',
      JSON.stringify(switchOptions)
    );
  }

  // 4. 停止 → 待机，避免残留后台扫描影响后续断言。
  await ensureSelected();
  await clickNodeButton('停止');
  const stopped = await waitFor(async () => (await nodeScanState()) === '待机', 15000);
  check(
    '停止后回到「待机」',
    stopped,
    await streamNode.evaluate((node) =>
      JSON.stringify({
        state: node.querySelector('.scan-state')?.textContent || null,
        buttons: Array.from(node.querySelectorAll('.scan-controls > button')).map((b) => ({
          t: b.textContent.trim(),
          d: b.disabled,
        })),
      })
    )
  );

  // 5. 终端：全新 SE 无后台进程，不兜底 demo 进程（无假进程）
  check('终端折叠条存在', !!(await page.$('.terminal-panel')));
  check('无后台进程文案', await page.evaluate(() =>
    (document.querySelector('.term-summary')?.textContent || '').includes('无后台进程')
  ));
  check('无进程 chips', (await page.$$('.term-chip')).length === 0);
  check('无等待输入徽标', !(await page.$('.term-wait-badge')));

  // 6. 关闭重开（reload）→ 重新 hydrate；idle 不得残留任何 authority 徽标。
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow', { timeout: 15000 });
  await streamNode.waitFor({ state: 'visible', timeout: 30000 });
  await streamNode.click();
  await waitFor(async () => (await nodeControlCount()) > 0, 8000);
  check(
    '重载后无陈旧权限徽标',
    (await streamNode.locator('.scan-authority-badge').count()) === 0,
    await streamNode.evaluate((node) => node.querySelector('.scan-authority-badge')?.textContent || '')
  );
  check('重载后 idle 权限选择器存在', (await nodeSelect('扫描权限').count()) > 0);

  check('控制台无错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' || '));
  await page.screenshot({ path: '.sisyphus/smoke-scan.png' });
} catch (err) {
  check('冒烟执行', false, String((err && err.message) || err));
  console.log('CATCH ' + String((err && err.message) || err));
  // 失败时保留现场：节点文本 / 扫描条状态/徽标 / 选择器，便于区分基线问题与脚本问题。
  if (page) {
    try {
      const diag = await page.evaluate(() => ({
        url: location.href,
        nodes: Array.from(document.querySelectorAll('.react-flow__node')).map((n) => n.textContent || ''),
        state: document.querySelector('.scan-state')?.textContent || null,
        badge: document.querySelector('.scan-authority-badge')?.textContent || null,
        idleAuthority: !!document.querySelector('select[aria-label="扫描权限"]'),
        switchAuthority: !!document.querySelector('select[aria-label="切换扫描权限"]'),
        toasts: Array.from(document.querySelectorAll('.toast')).map((t) => t.textContent || ''),
        tabs: Array.from(document.querySelectorAll('.tab')).map((t) => ({
          title: t.getAttribute('title'),
          active: t.classList.contains('active'),
        })),
        canvasCount: document.querySelectorAll('.react-flow').length,
      }));
      diag.recvCount = seRecvFrames.length;
      diag.scanEvents = seRecvFrames
        .map((raw) => {
          try {
            const msg = JSON.parse(raw);
            return msg && msg.method === 'scan.on_change' ? msg.params : null;
          } catch (err) {
            return null;
          }
        })
        .filter(Boolean)
        .slice(-3);
      console.log('DIAG ' + JSON.stringify(diag).slice(0, 2000));
      await page.screenshot({ path: '.sisyphus/smoke-scan-fail.png' });
    } catch (diagErr) {
      console.log('DIAG-ERR ' + String((diagErr && diagErr.message) || diagErr));
    }
  }
} finally {
  if (browser) await browser.close();
  // Windows 下 shell:true 的 kill() 只杀 npx 壳，必须 taskkill /T 杀整棵树防 vite 孤儿
  try { spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 尽力而为 */ }
  // 先显式移除测试工具文件/目录，再交给 cleanupSeSystem 兜底删整个隔离 storage。
  try { fs.rmSync(TOOL_FILE, { force: true }); } catch { /* best effort */ }
  try { fs.rmdirSync(TOOL_DIR); } catch { /* 目录非空/已删除：交给 cleanupSeSystem */ }
  cleanupSeSystem(SID);
  restore();
  // 测试 tab 在真实 graphs/ 下生成的配置 / .streams 目录一并清掉，避免逐轮堆积。
  purgeTestTabsFromWorkspace();
  cleanupGraphArtifacts(SID);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
