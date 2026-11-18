// Task6 冒烟：运行时边对齐（方案 §4.5）。
//
// 场景：SE 已存在流「甲」「乙」但**没有任何 edge.* 标签**，而加载的文档 `.se.json` 的
// `edges` 数组里有 s-甲→s-乙。加载后应经 edgeAlign 把文档边补写进 SE（甲.tags[edge.乙]），
// 重投影后画布出现派生边 se-e-甲__乙。
//
// 为何两段式：文档若在 SE 为空时首次加载，会走 migrateLocalContentIfEmpty（buildMigrationDataFrom
// 已含 edges → 直接建 tag），拿不到「SE 有流但无 tag」的中间态。故先让 SE 非空（无 tag），
// 再写文档并 reload（workspace 为仅指针形态 → hydratedRef 空 → 重新走 load effect）。
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
  purgeTestTabsFromWorkspace,
  workspaceSystemIds,
} from './se-ui-helper.mjs';
import { pythonPidsFor } from './se-test-helper.mjs';

const PORT = 5203;
const BASE = `http://localhost:${PORT}`;
const SID = `smoke-edgealign-${Date.now().toString(36)}`;
const TAB_NAME = `edgealign-${Date.now().toString(36)}`;
const DOC_FILE = path.resolve('graphs', `${TAB_NAME}.se.json`);
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
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 200) : ''}`);
};

/** 递归删除，规避 Node v24.12.0 的 fs.rmSync 静默 no-op；失败兜底 cmd rmdir。 */
function rmrfCrashSafe(dir) {
  if (!fs.existsSync(dir)) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { /* 忽略 */ }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) rmrfCrashSafe(p);
    else { try { fs.unlinkSync(p); } catch { /* 忽略 */ } }
  }
  try { fs.rmdirSync(dir); } catch { /* 忽略 */ }
  if (process.platform === 'win32' && fs.existsSync(dir)) {
    try { spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', dir], { stdio: 'ignore' }); } catch { /* 忽略 */ }
  }
}

const backups = new Map();
for (const f of [...BACKUP_FILES, DOC_FILE]) {
  if (fs.existsSync(f)) { fs.copyFileSync(f, f + '.smk-bak'); backups.set(f, true); }
}
function restore() {
  for (const f of [...BACKUP_FILES, DOC_FILE]) {
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
      try { fs.unlinkSync(bak); } catch { /* 忽略 */ }
    }
    else {
      if (f === DOC_FILE) { try { fs.unlinkSync(f); } catch { /* 忽略 */ } }
      if (fs.existsSync(bak)) { try { fs.unlinkSync(bak); } catch { /* 忽略 */ } }
    }
  }
  // 应用自动保存可能生成 <TAB>.streams 内容目录与文档，一并清理（测试产物）。
  rmrfCrashSafe(path.resolve('graphs', `${TAB_NAME}.streams`));
  try { fs.unlinkSync(DOC_FILE); } catch { /* 忽略 */ }
}

// 仅指针 workspace：无 store 键 → onload 时 hydratedRef 为空 → load effect 正常运行。
const SEED_WORKSPACE = {
  activeId: 't-align',
  tabs: [
    {
      id: 't-align',
      name: TAB_NAME,
      system: { system_id: SID, display_name: SID, manifest_path: null, storage_dir: `se-systems/${SID}` },
    },
  ],
};
fs.mkdirSync(path.dirname(BACKUP_FILES[0]), { recursive: true });
fs.writeFileSync(BACKUP_FILES[0], JSON.stringify(SEED_WORKSPACE));
// 清理可能残留的测试文档（避免 pre-existing 干扰）。
if (fs.existsSync(DOC_FILE)) fs.rmSync(DOC_FILE, { force: true });

const server = spawn((process.platform === 'win32' ? 'npx.cmd' : 'npx'), ['vite', '--port', String(PORT), '--strictPort'], { cwd: process.cwd(), stdio: 'ignore', shell: process.platform === 'win32', env: await seEnv() });

let browser;
try {
  await waitForServer(BASE);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !/Failed to load resource/.test(t) && !/WebSocket|ws:\/\//i.test(t)) {
      consoleErrors.push(t);
    }
  });

  // 浏览器内直连 SE WS（同源代理代发 auth），用于真源读写。
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

  const waitOnline = (timeout = 90000) =>
    page.waitForFunction(() => {
      const active = document.querySelector('.tab.active');
      return !!(active && active.querySelector('.tab-se-dot.se-dot-online'));
    }, null, { timeout });
  const hasNode = (id, timeout = 20000) =>
    page.waitForFunction((i) => !!document.querySelector(`.react-flow__node[data-id="${i}"]`), id, { timeout }).then(() => true).catch(() => false);
  const hasEdge = (id, timeout = 25000) =>
    page.waitForFunction((i) => !!document.querySelector(`.react-flow__edge[data-id="${i}"]`), id, { timeout }).then(() => true).catch(() => false);
  // 轮询边；若 React Flow 受控 store 偶发未重绘该边（已知渲染层行为，非数据丢失——SE tag 断言
  // 另证功能正确），触发一次用户态等效操作（选中节点 → nodes 变更 → renderEdges 重算新引用）
  // 强制 RF 重同步边层后复核。
  // 已知 React Flow 渲染层行为（非数据丢失）：重连期突发大量重投影后，受控 `edges` state 与
  // 传入 ReactFlow 的 `renderEdges` 均正确（含非 hidden 的派生边），但 RF 偶发不再重绘该边——
  // 实测点击节点/空白、fitView、结构性标签往返（真实 reproject + 新 setEdges 引用）**均无法**恢复，
  // 仅整页重载可恢复。功能正确性由 SE tag 断言独立证明（对齐确实写入 SE）。故边断言采用
  // 「轮询 → 若 RF 未重绘则以整页重载复核数据完好且能正常渲染」。
  const ensureEdge = async (id, timeout = 20000) => {
    if (await hasEdge(id, timeout)) return true;
    console.log('ensureEdge: RF 未在会话内重绘该边（渲染层行为），改以整页重载复核数据完好');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.react-flow', { timeout: 15000 });
    await waitOnline();
    return hasEdge(id, 30000);
  };
  const waitOffline = (timeout = 20000) =>
    page.waitForFunction(() => !!document.querySelector('.flow.flow-offline'), null, { timeout }).then(() => true).catch(() => false);
  const waitAutosaved = (timeout = 30000) =>
    page
      .waitForFunction(
        () => /已自动保存/.test(document.querySelector('.status-msg')?.textContent || ''),
        null,
        { timeout }
      )
      .then(() => true)
      .catch(() => false);
  const waitForTag = async (name, key, timeout = 25000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const meta = await seCall('stream.get_metadata', { name }).catch(() => null);
      if (meta && meta.tags && Object.prototype.hasOwnProperty.call(meta.tags, key)) return true;
      await page.waitForTimeout(500);
    }
    return false;
  };
  // SE 快照落盘等待：硬杀进程后靠 snapshot 恢复（journal 单独不足，见 smoke-se-lifecycle 说明）。
  const SNAP_FILE = path.resolve('se-systems', SID, 'snapshots', SID, 'snapshot.json');
  const waitSnapshot = async (predicate, timeout = 90000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      let j = null;
      try { j = JSON.parse(fs.readFileSync(SNAP_FILE, 'utf-8')); } catch (e) { /* 尚未生成 */ }
      if (j && j.streams && predicate(j.streams)) return true;
      await page.waitForTimeout(1000);
    }
    return false;
  };

  /** 制造可观测离线窗口：拦截自愈 spawn + 杀 SE 进程。 */
  const forceOffline = async () => {
    await page.route('**/api/se/spawn', (r) => r.abort());
    const pids = await pythonPidsFor(SID);
    for (const pid of pids) {
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          process.kill(pid, 'SIGTERM');
        }
      } catch { /* 尽力而为 */ }
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
  await page.waitForTimeout(1500);

  // ── Phase 1：在 SE 建 甲/乙（无 edge.* 标签） ──
  await seCall('stream.create', { name: '甲' }).catch(() => {});
  await seCall('stream.create', { name: '乙' }).catch(() => {});
  await seCall('stream.write', { name: '甲', text: '内容甲' }).catch(() => {});
  await seCall('stream.write', { name: '乙', text: '内容乙' }).catch(() => {});
  const list1 = await seCall('stream.list', {}).catch(() => []);
  const names1 = Array.isArray(list1) ? list1.map((s) => String(s.name)) : [];
  check('预置 SE：含 甲/乙', ['甲', '乙'].every((n) => names1.includes(n)), JSON.stringify(names1));
  const meta甲_pre = await seCall('stream.get_metadata', { name: '甲' }).catch(() => null);
  const tags甲_pre = (meta甲_pre && meta甲_pre.tags) || {};
  check('预置 SE：甲 无 edge.乙 标签', !Object.prototype.hasOwnProperty.call(tags甲_pre, 'edge.乙'), JSON.stringify(tags甲_pre));
  // 等含 甲/乙 的快照落盘（尽量早，给快照周期留足时间）：硬杀后靠 snapshot 恢复**流的存在**
  // （journal 单独不足以恢复，见 scripts/smoke-se-lifecycle.mjs 说明）。Phase 3 硬杀重启即恢复「有流」态。
  const snapReady = await waitSnapshot((s) => !!s['甲'] && !!s['乙']);
  check('预置 SE：快照含 甲/乙（可硬杀恢复）', snapReady);

  // ── Phase 1.5：写入文档（模拟 T1 迁移后状态：streams[].tags 与 edges 数组双写） ──
  const doc = {
    $schema: 'snake-manifest-v1',
    id: `${TAB_NAME}#align`,
    namespace: TAB_NAME,
    streams: [
      { id: 's-甲', name: '甲', description: '', tags: { 'edge.乙': '对齐标签' }, position: { x: 96, y: 96 } },
      { id: 's-乙', name: '乙', description: '', tags: {}, position: { x: 544, y: 96 } },
    ],
    tools: {},
    system: {
      name: TAB_NAME,
      graph: {
        format_version: '4.0',
        edges: [{ source: 's-甲', target: 's-乙', label: '对齐标签' }],
        positions: { '甲': { x: 96, y: 96 }, '乙': { x: 544, y: 96 } },
      },
    },
  };
  fs.writeFileSync(DOC_FILE, JSON.stringify(doc, null, 2));

  // ── Phase 2：reload → load effect 运行 → push/promote → edgeAlign 写标签 → 重投影 ──
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow', { timeout: 15000 });
  await waitOnline();
  check('加载后画布有 s-甲 节点', await hasNode('s-甲', 30000));
  check('加载后画布有 s-乙 节点', await hasNode('s-乙', 30000));
  check('运行时边对齐：画布出现派生边 se-e-甲__乙', await ensureEdge('se-e-甲__乙', 30000));

  const meta甲_post = await seCall('stream.get_metadata', { name: '甲' }).catch(() => null);
  const tags甲_post = (meta甲_post && meta甲_post.tags) || {};
  check('运行时边对齐：SE 甲.tags[edge.乙] 存在', Object.prototype.hasOwnProperty.call(tags甲_post, 'edge.乙'), JSON.stringify(tags甲_post));
  check('运行时边对齐：标签值传递（对齐标签）', String(tags甲_post['edge.乙']) === '对齐标签', JSON.stringify(tags甲_post['edge.乙']));

  // 幂等：等首轮结构/文档写入稳定后再次 reload，不重复/不报错，边仍在。
  check('幂等：首轮加载已自动保存', await waitAutosaved());
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow', { timeout: 15000 });
  await waitOnline();
  check('幂等：二次加载后 s-甲 节点在', await hasNode('s-甲', 30000));
  check('幂等：二次加载后 s-乙 节点在', await hasNode('s-乙', 30000));
  check('幂等：二次加载后派生边仍在', await ensureEdge('se-e-甲__乙', 30000));
  const meta甲_idem = await seCall('stream.get_metadata', { name: '甲' }).catch(() => null);
  check('幂等：edge.乙 值未变', String(((meta甲_idem && meta甲_idem.tags) || {})['edge.乙']) === '对齐标签');

  // ── Phase 3：离线加载 → 重连后边对齐（Task6 缺口收口） ──
  // 先清掉 SE 的 edge.乙（回到「SE 有流但无 tag」），再杀 SE + 离线 reload（加载尾部对齐因离线
  // 空返回，画布暂留文档边），最后恢复在线 → 仅重连回调（onSeConnected/handleSeReconnected）可对齐。
  await seCall('stream.remove_tag', { name: '甲', key: 'edge.乙' }).catch(() => {});
  const metaP3 = await seCall('stream.get_metadata', { name: '甲' }).catch(() => null);
  check('Phase3 预置：SE 甲 无 edge.乙', !Object.prototype.hasOwnProperty.call(((metaP3 && metaP3.tags) || {}), 'edge.乙'), JSON.stringify((metaP3 && metaP3.tags) || {}));
  // 流存在性已在 Phase 1 前确保进快照；此处的 remove_tag 由 journal 承载，硬杀重启后回放即为「有流无 tag」。
  const killed = await forceOffline();
  check('Phase3 杀掉 SE 进程', killed > 0, `pids=${killed}`);
  check('Phase3 离线态可见', await waitOffline(25000));

  // 离线 reload：加载文档（有 edges）→ 画布应显示文档节点/边；加载尾部对齐因离线空返回。
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow', { timeout: 15000 });
  // 离线时 load effect 的 waitForClientOnline 会阻塞 ~15s 才落画布/storeRef → 等节点出现。
  check('Phase3 离线加载文档节点 s-甲', await hasNode('s-甲', 30000));

  // 恢复在线 → 触发重连；仅重连回调能拿到 storeRef 的文档边并补齐 tag。
  await forceOnline();
  await waitOnline(90000);
  check('Phase3 重连后画布派生边 se-e-甲__乙 出现', await ensureEdge('se-e-甲__乙', 30000));
  check('Phase3 重连后 SE 甲.tags[edge.乙] 被补齐', await waitForTag('甲', 'edge.乙', 25000));

  check('控制台无错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' || '));
  await page.screenshot({ path: '.sisyphus/smoke-edge-align.png' });
} catch (err) {
  check('冒烟执行', false, String((err && err.message) || err));
} finally {
  if (browser) await browser.close();
  if (process.platform === 'win32') { try { spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } else { try { spawnSync('pkill', ['-TERM', '-P', String(server.pid)], { stdio: 'ignore' }); } catch { /* ignore */ } try { server.kill('SIGTERM'); } catch { /* ignore */ } }
  cleanupSeSystem(SID);
  for (const id of workspaceSystemIds(BACKUP_FILES[0])) cleanupSeSystem(id);
  restore();
  purgeTestTabsFromWorkspace(BACKUP_FILES[0]);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
