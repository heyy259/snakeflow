// 期 6-8 冒烟：scanDriver 单元接线（纯 fake call，无真实 SE / vite / playwright / 子进程）。
//
// 覆盖契约（src/se/scanDriver.js）：
//   - action：start / pause / resume / stop / setpos / rescan 的 RPC 方法与乐观态；
//   - 暂停诚实化（2026-10-25）：pause 消费 pause_phase（pausing→paused），旧后端降级；
//     resume 失败 resume-target-missing 不重置 idle，候选回调 + reanchor_to 透传；
//   - onEvent：state / position / scan_complete / anchor_stale / marker_executed /
//     marker_failed / error 的权威态与计数语义（含 normal_delete_failed 不计入）；
//   - 重锚事件：reanchored toast；resume-target-missing 事件 → paused + 候选回调；
//   - stdin 提示：marker_failed.hint → toast；eof+fail → 「完成（有失败）」；
//   - hydrate：scan.status 对账（含 pause_phase）；reapply：重投影后恢复 node.data.scan；
//   - isActive()=false：仍发 RPC，但不落地画布。
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 180) : ''}`);
};

/** 构造一个隔离的 fake harness（可变 nodes / calls / toasts / responder / active）。 */
function makeHarness(initialNodes, { activeMode = true, onResumeTargetMissing } = {}) {
  const state = {
    nodes: initialNodes,
    active: activeMode,
    calls: [],
    toasts: [],
    responder: async () => ({}),
  };
  const call = async (m, p) => {
    state.calls.push({ m, p });
    return state.responder(m, p);
  };
  const setNodes = (fn) => {
    state.nodes = typeof fn === 'function' ? fn(state.nodes) : fn;
  };
  const driver = createScanDriver({
    call,
    isActive: () => state.active,
    getNodes: () => state.nodes,
    setNodes,
    notify: (t, k) => state.toasts.push({ t, k }),
    onResumeTargetMissing,
  });
  return { state, driver };
}

const nodeA = () => ({ id: 's-a', position: { x: 0, y: 0 }, data: { name: 'A', content: 'hello @{x}' } });
const scanOf = (h, id = 's-a') => {
  const n = h.state.nodes.find((x) => x.id === id);
  return n && n.data ? n.data.scan : undefined;
};
const emit = (h, change, extra = {}) =>
  h.driver.onEvent('scan.on_change', { stream_name: 'a', change, ...extra });
const resetCalls = (h) => {
  h.state.calls.length = 0;
};
/** 用 scan.status 把节点 hydrate 成 settled PAUSED + 可切换权限。 */
const seedPausedAuthority = async (h, over = {}) => {
  h.state.responder = async (m) =>
    m === 'scan.status'
      ? {
          state: 'paused',
          pause_phase: 'paused',
          position: 0,
          authority: 'workspace-write',
          allowed_authorities: ['workspace-write', 'full'],
          can_set_authority: true,
          ...over,
        }
      : {};
  await h.driver.hydrate();
  resetCalls(h);
};

const scanDriver = await import(pathToFileURL(path.join(ROOT, 'src/se/scanDriver.js')).href);
const { createScanDriver } = scanDriver;

// ── 契约面 ────────────────────────────────────────────────────────────────────
{
  const h = makeHarness([nodeA()]);
  check('契约：topics 含 scan.on_change', Array.isArray(h.driver.topics) && h.driver.topics.includes('scan.on_change'));
  check(
    '契约：方法齐全',
    ['onEvent', 'hydrate', 'reset', 'reapply', 'action'].every((k) => typeof h.driver[k] === 'function')
  );
}

// ── action：start ─────────────────────────────────────────────────────────────
{
  const h = makeHarness([nodeA()]);
  await h.driver.action('s-a', 'start');
  const c = h.state.calls[0];
  check('start → scan.start{stream_name:a}', c && c.m === 'scan.start' && c.p.stream_name === 'a', JSON.stringify(c));
  check(
    'start 缺省 authority → 仅 {stream_name}（向后兼容）',
    c && Object.keys(c.p).join(',') === 'stream_name' && !('authority' in c.p),
    JSON.stringify(c)
  );
  check('start → 乐观置 scanning', scanOf(h)?.state === 'scanning');
}

// ── action：start 显式 authority（仅非空字符串才附带）────────────────────────
{
  const h = makeHarness([nodeA()]);
  await h.driver.action('s-a', 'start', 'workspace-write');
  const c = h.state.calls[0];
  check(
    "start('workspace-write') → scan.start 带 authority",
    c?.m === 'scan.start' && c.p.stream_name === 'a' && c.p.authority === 'workspace-write',
    JSON.stringify(c)
  );

  const h2 = makeHarness([nodeA()]);
  await h2.driver.action('s-a', 'start', 'full');
  const c2 = h2.state.calls[0];
  check(
    "start('full') → scan.start 带 authority",
    c2?.m === 'scan.start' && c2.p.stream_name === 'a' && c2.p.authority === 'full',
    JSON.stringify(c2)
  );

  const h3 = makeHarness([nodeA()]);
  await h3.driver.action('s-a', 'start', '');
  const c3 = h3.state.calls[0];
  check(
    "start('') → 退回仅 {stream_name}",
    c3?.m === 'scan.start' && Object.keys(c3.p).join(',') === 'stream_name',
    JSON.stringify(c3)
  );
}

// ── action：空内容 start 被拦截 ────────────────────────────────────────────────
{
  const h = makeHarness([{ id: 's-e', position: { x: 0, y: 0 }, data: { name: 'E', content: '   ' } }]);
  resetCalls(h);
  await h.driver.action('s-e', 'start');
  check('空内容 start → 无 RPC', h.state.calls.length === 0, JSON.stringify(h.state.calls));
  check(
    '空内容 start → warn 提示',
    h.state.toasts.some((t) => t.t === '内容为空，无法扫描' && t.k === 'warn'),
    JSON.stringify(h.state.toasts)
  );
}

// ── action：pause / resume / stop ─────────────────────────────────────────────
{
  const h = makeHarness([nodeA()]);
  resetCalls(h);
  await h.driver.action('s-a', 'pause');
  check('pause → scan.pause{stream_name:a}', h.state.calls[0]?.m === 'scan.pause' && h.state.calls[0].p.stream_name === 'a');
  check('pause → state paused', scanOf(h)?.state === 'paused');

  resetCalls(h);
  await h.driver.action('s-a', 'resume');
  check('resume → scan.resume{stream_name:a}', h.state.calls[0]?.m === 'scan.resume' && h.state.calls[0].p.stream_name === 'a');
  check('resume → state scanning', scanOf(h)?.state === 'scanning');

  h.driver.onEvent('scan.on_change', { stream_name: 'a', change: { type: 'position', position: 8 } });
  resetCalls(h);
  await h.driver.action('s-a', 'stop');
  check('stop → scan.stop{stream_name:a}', h.state.calls[0]?.m === 'scan.stop' && h.state.calls[0].p.stream_name === 'a');
  const s = scanOf(h);
  check('stop → idle/0/0/0', s?.state === 'idle' && s.position === 0 && s.ok === 0 && s.fail === 0, JSON.stringify(s));
}

// ── pause_phase：轮内暂停诚实化（2026-10-25）────────────────────────────────
{
  const h = makeHarness([nodeA()]);
  h.state.responder = async (m) =>
    m === 'scan.pause' ? { success: true, state: 'scanning', pause_phase: 'pausing' } : {};
  await h.driver.action('s-a', 'pause');
  const s = scanOf(h);
  check(
    'pause(pausing) → state scanning + pausePhase pausing',
    s?.state === 'scanning' && s?.pausePhase === 'pausing',
    JSON.stringify(s)
  );
  emit(h, { type: 'state', old_state: 'scanning', new_state: 'paused', pause_phase: 'paused' });
  const s2 = scanOf(h);
  check(
    'settle → state paused + pausePhase paused',
    s2?.state === 'paused' && s2?.pausePhase === 'paused',
    JSON.stringify(s2)
  );
}

// 旧后端（无 pause_phase，返回 state:"pausing"）降级兼容。
{
  const h = makeHarness([nodeA()]);
  h.state.responder = async (m) => (m === 'scan.pause' ? { success: true, state: 'pausing' } : {});
  await h.driver.action('s-a', 'pause');
  const s = scanOf(h);
  check(
    '旧后端 pause{state:pausing} → scanning/pausing',
    s?.state === 'scanning' && s?.pausePhase === 'pausing',
    JSON.stringify(s)
  );
}

// ── resume 失败 resume-target-missing：不重置 idle + 候选 + reanchor_to ──────
{
  const seen = [];
  const h = makeHarness([nodeA()], { onResumeTargetMissing: (info) => seen.push(info) });
  emit(h, { type: 'state', new_state: 'paused', pause_phase: 'paused' });
  h.state.responder = async (m) =>
    m === 'scan.resume'
      ? {
          success: false,
          error: {
            kind: 'resume-target-missing',
            message: 'no target',
            candidates: [{ tool: 'x', position: 4, context: 'CTX' }],
          },
        }
      : {};
  await h.driver.action('s-a', 'resume');
  const s = scanOf(h);
  check('resume 失败(resume-target-missing) → 保持 paused（不重置 idle）', s?.state === 'paused', JSON.stringify(s));
  check(
    'resume 失败 → 候选回调 + 候选入 scan 态',
    seen.length === 1 && seen[0].candidates.length === 1 && s?.resumeMissing?.candidates?.length === 1,
    JSON.stringify({ seen, s })
  );

  resetCalls(h);
  h.state.responder = async () => ({ success: true, state: 'scanning' });
  await h.driver.action('s-a', 'resume', 42);
  const c = h.state.calls[0];
  check(
    'resume(payload) → reanchor_to 透传',
    c?.m === 'scan.resume' && c.p.reanchor_to === 42,
    JSON.stringify(c)
  );
  check('resume(payload) → 清空 resumeMissing', scanOf(h)?.resumeMissing == null, JSON.stringify(scanOf(h)));
}

// ── onEvent：reanchored / resume-target-missing ──────────────────────────────
{
  const h = makeHarness([nodeA()]);
  emit(h, { type: 'reanchored', from: 0, to: 4, method: 'next', remaining: 2 });
  check(
    'reanchored → scanning + 重新定位 toast',
    scanOf(h)?.state === 'scanning' &&
      h.state.toasts.some((t) => t.t === '已重新定位到第 3 步' && t.k === 'ok'),
    JSON.stringify({ s: scanOf(h), toasts: h.state.toasts })
  );
}
{
  const seen = [];
  const h = makeHarness([nodeA()], { onResumeTargetMissing: (info) => seen.push(info) });
  emit(h, { type: 'state', new_state: 'scanning' });
  emit(h, {
    type: 'resume-target-missing',
    reason: 'rewritten-no-frontier',
    position: 6,
    candidates: [{ tool: 'ok', position: 9, context: 'x' }],
  });
  const s = scanOf(h);
  check(
    'resume-target-missing 事件 → paused + 候选',
    s?.state === 'paused' && s?.pausePhase === 'paused' && s?.resumeMissing?.candidates?.length === 1,
    JSON.stringify(s)
  );
  check(
    'resume-target-missing 事件 → 回调一次',
    seen.length === 1 && seen[0].reason === 'rewritten-no-frontier',
    JSON.stringify(seen)
  );
  check(
    'resume-target-missing 事件 → warn 提示',
    h.state.toasts.some((t) => String(t.t).includes('无法定位剩余步骤') && t.k === 'warn'),
    JSON.stringify(h.state.toasts)
  );
}

// ── onEvent：marker_failed.hint / scan_complete 原因映射 ─────────────────────
{
  const h = makeHarness([nodeA()]);
  emit(h, {
    type: 'marker_failed',
    reason: '前台执行失败',
    hint: '提示：请在标记里传参数，或改为后台 keep_stdin 交互。',
  });
  check(
    'marker_failed.hint → toast',
    h.state.toasts.some((t) => String(t.t).includes('keep_stdin') && t.k === 'warn'),
    JSON.stringify(h.state.toasts)
  );
}
{
  const h = makeHarness([nodeA()]);
  emit(h, { type: 'scan_complete', reason: 'eof', normal_failed: 1 });
  check(
    'scan_complete eof+fail → 完成（有失败）',
    h.state.toasts.some((t) => String(t.t).includes('完成（有失败）') && t.k === 'warn'),
    JSON.stringify(h.state.toasts)
  );
  const h2 = makeHarness([nodeA()]);
  emit(h2, { type: 'scan_complete', reason: 'resume-target-missing', normal_failed: 0 });
  check(
    'scan_complete resume-target-missing → 中断文案',
    h2.state.toasts.some((t) => String(t.t).includes('无法定位剩余步骤') && t.k === 'warn'),
    JSON.stringify(h2.state.toasts)
  );
}

// ── action：setpos ────────────────────────────────────────────────────────────
{
  const h = makeHarness([nodeA()]);
  resetCalls(h);
  await h.driver.action('s-a', 'setpos', 42);
  const c = h.state.calls[0];
  check(
    'setpos → scan.move{stream_name:a,position:42}',
    c?.m === 'scan.move' && c.p.stream_name === 'a' && c.p.position === 42,
    JSON.stringify(c)
  );
  check('setpos → position 42', scanOf(h)?.position === 42);
}

// ── action：rescan ────────────────────────────────────────────────────────────
{
  const h = makeHarness([nodeA()]);
  resetCalls(h);
  await h.driver.action('s-a', 'rescan');
  const c = h.state.calls[0];
  check(
    'rescan → scan.rescan{stream_name:a,mode:start}',
    c?.m === 'scan.rescan' && c.p.stream_name === 'a' && c.p.mode === 'start',
    JSON.stringify(c)
  );
  check('rescan → 乐观置 scanning', scanOf(h)?.state === 'scanning');

  const h2 = makeHarness([{ id: 's-e', position: { x: 0, y: 0 }, data: { name: 'E', content: '\n ' } }]);
  resetCalls(h2);
  await h2.driver.action('s-e', 'rescan');
  check('空内容 rescan → 无 RPC + warn', h2.state.calls.length === 0 && h2.state.toasts.some((t) => t.k === 'warn'));
}

// ── action：tick no-op / 非 s-* id 忽略 ───────────────────────────────────────
{
  const h = makeHarness([nodeA()]);
  resetCalls(h);
  await h.driver.action('s-a', 'tick');
  check('tick → no-op（无 RPC）', h.state.calls.length === 0);
  await h.driver.action('n-local', 'start');
  check('非 s-* id → 忽略（无 RPC）', h.state.calls.length === 0);
  // 未同步的本地 pending 节点：start 必须给出可感知提示（避免“点了没反应”）。
  check(
    '非 s-* id start → warn 提示待同步',
    h.state.toasts.some((t) => t.t === '该节点未同步到 SE（待同步），无法扫描' && t.k === 'warn'),
    JSON.stringify(h.state.toasts)
  );

  // 非 start 动作仍静默（节点可能已删除等情况，避免噪音）。
  const h2 = makeHarness([nodeA()]);
  resetCalls(h2);
  await h2.driver.action('n-local', 'pause');
  await h2.driver.action('n-local', 'stop');
  await h2.driver.action('n-local', 'rescan');
  check(
    '非 s-* id 非 start → 静默（无 RPC / 无提示）',
    h2.state.calls.length === 0 && h2.state.toasts.length === 0,
    JSON.stringify({ calls: h2.state.calls, toasts: h2.state.toasts })
  );
}

// ── onEvent：position / state ─────────────────────────────────────────────────
{
  const h = makeHarness([nodeA()]);
  emit(h, { type: 'position', position: 7 });
  check('onEvent position → 7', scanOf(h)?.position === 7);
  emit(h, { type: 'state', new_state: 'scanning' });
  check('onEvent state → scanning', scanOf(h)?.state === 'scanning');
  emit(h, { type: 'position', position: 9 });
  emit(h, { type: 'state', new_state: 'idle' });
  check('onEvent state idle → position 归零', scanOf(h)?.state === 'idle' && scanOf(h).position === 0);
  emit(h, { type: 'state', state: 'paused' });
  check('onEvent state 回落 c.state', scanOf(h)?.state === 'paused');

  // 未知流：不建节点。
  const before = h.state.nodes.length;
  emit(h, { type: 'position', position: 1 }, { stream_name: 'ghost' });
  check('onEvent 未知流 → 不建节点', h.state.nodes.length === before && !h.state.nodes.some((n) => n.id === 's-ghost'));

  // name 回落。
  emit(h, { type: 'position', position: 3 }, { stream_name: undefined, name: 'a' });
  check('onEvent name 回落', scanOf(h)?.position === 3);
}

// ── onEvent：marker_executed（单 / 多）────────────────────────────────────────
{
  const h = makeHarness([nodeA()]);
  // 归零
  emit(h, { type: 'scan_complete', normal_succeeded: 0, background_started: 0, normal_failed: 0, background_failed: 0 });
  emit(h, { type: 'marker_executed', success: true });
  check('marker_executed 单成功 → ok=1/fail=0', scanOf(h)?.ok === 1 && scanOf(h).fail === 0, JSON.stringify(scanOf(h)));
  emit(h, { type: 'marker_executed', success: false });
  check('marker_executed 单失败 → ok=1/fail=1', scanOf(h)?.ok === 1 && scanOf(h).fail === 1, JSON.stringify(scanOf(h)));

  emit(h, { type: 'scan_complete', normal_succeeded: 0, background_started: 0, normal_failed: 0, background_failed: 0 });
  emit(h, { type: 'marker_executed', result: { count: 2, succeeded: 3, failed: 1 } });
  check('marker_executed 批量 → ok=3/fail=1', scanOf(h)?.ok === 3 && scanOf(h).fail === 1, JSON.stringify(scanOf(h)));
  check(
    'marker_found/skipped/denied/window → 不计数',
    (() => {
      const before = `${scanOf(h).ok}/${scanOf(h).fail}`;
      emit(h, { type: 'marker_found' });
      emit(h, { type: 'marker_skipped' });
      emit(h, { type: 'marker_denied' });
      emit(h, { type: 'scan_window' });
      return `${scanOf(h).ok}/${scanOf(h).fail}` === before;
    })()
  );
}

// ── onEvent：marker_failed 只在后台启动失败时补计 ─────────────────────────────
{
  const h = makeHarness([nodeA()]);
  emit(h, { type: 'scan_complete', normal_succeeded: 0, background_started: 0, normal_failed: 0, background_failed: 0 });
  emit(h, { type: 'marker_failed', reason: 'background 启动失败' });
  check('marker_failed(background 启动失败) → fail=1', scanOf(h)?.fail === 1, JSON.stringify(scanOf(h)));
  emit(h, { type: 'marker_failed', reason: '前台执行失败' });
  check('marker_failed(前台) → 不重复计数', scanOf(h)?.fail === 1, JSON.stringify(scanOf(h)));
}

// ── onEvent：scan_complete 权威计数（normal_delete_failed 不计）───────────────
{
  const h = makeHarness([nodeA()]);
  emit(h, { type: 'position', position: 55 });
  emit(h, {
    type: 'scan_complete',
    normal_succeeded: 2,
    background_started: 3,
    normal_failed: 1,
    background_failed: 4,
    normal_delete_failed: 99,
  });
  const s = scanOf(h);
  check('scan_complete → ok=5', s?.ok === 5, JSON.stringify(s));
  check('scan_complete → fail=5（不含 delete_failed）', s?.fail === 5, JSON.stringify(s));
  check('scan_complete → idle + position 0', s?.state === 'idle' && s.position === 0, JSON.stringify(s));
  check(
    'scan_complete → notify 完成（有失败）',
    h.state.toasts.some((t) => t.t === '扫描完成（有失败）: 5 ok, 5 fail' && t.k === 'warn'),
    JSON.stringify(h.state.toasts)
  );
}

// ── onEvent：anchor_stale 不自动重扫 ─────────────────────────────────────────
{
  const h = makeHarness([nodeA()]);
  resetCalls(h);
  emit(h, { type: 'state', new_state: 'scanning' });
  emit(h, { type: 'anchor_stale' });
  check('anchor_stale → idle', scanOf(h)?.state === 'idle');
  check('anchor_stale → 无自动重扫 RPC', h.state.calls.length === 0, JSON.stringify(h.state.calls));
  check(
    'anchor_stale → warn 提示',
    h.state.toasts.some((t) => t.t === '扫描锚失效，需重扫' && t.k === 'warn'),
    JSON.stringify(h.state.toasts)
  );
}

// ── onEvent：error 提示 ───────────────────────────────────────────────────────
{
  const h = makeHarness([nodeA()]);
  emit(h, { type: 'error', message: 'boom' });
  check('error → warn 提示含文案', h.state.toasts.some((t) => t.t === '扫描错误：boom' && t.k === 'warn'));
  emit(h, { type: 'error' });
  check('error 无文案 → 未知', h.state.toasts.some((t) => t.t === '扫描错误：未知'));
}

// ── hydrate：scan.status 对账 ────────────────────────────────────────────────
{
  const h = makeHarness([{ id: 's-b', position: { x: 0, y: 0 }, data: { name: 'B', content: 'x' } }]);
  h.state.responder = async (m) => {
    if (m === 'scan.status') {
      return {
        state: 'paused',
        pause_phase: 'paused',
        position: 3,
        normal_succeeded: 2,
        background_started: 1,
        normal_failed: 4,
        background_failed: 5,
      };
    }
    return {};
  };
  await h.driver.hydrate();
  const s = scanOf(h, 's-b');
  check('hydrate → state paused', s?.state === 'paused', JSON.stringify(s));
  check('hydrate → pausePhase paused', s?.pausePhase === 'paused', JSON.stringify(s));
  check('hydrate → position 3', s?.position === 3);
  check('hydrate → ok=3（2+1）', s?.ok === 3);
  check('hydrate → fail=9（4+5）', s?.fail === 9);
  check('hydrate → 调用 scan.status', h.state.calls.some((c) => c.m === 'scan.status' && c.p.stream_name === 'b'));
}

// ── reapply：重投影抹掉 data.scan 后恢复 ─────────────────────────────────────
{
  const h = makeHarness([nodeA()]);
  await h.driver.action('s-a', 'start');
  // 模拟 projectStreams 重投影：节点 data 只保留 name/content，scan 被丢弃。
  h.state.nodes = h.state.nodes.map((n) => ({ ...n, data: { name: n.data.name, content: n.data.content } }));
  check('reapply 前置：scan 已被抹掉', scanOf(h) === undefined);
  h.driver.reapply();
  check('reapply → 恢复 scan（scanning）', scanOf(h)?.state === 'scanning', JSON.stringify(scanOf(h)));
}

// ── reset：清空权威态（不回写画布）────────────────────────────────────────────
{
  const h = makeHarness([nodeA()]);
  await h.driver.action('s-a', 'start');
  h.driver.reset();
  h.state.nodes = h.state.nodes.map((n) => ({ ...n, data: { name: n.data.name, content: n.data.content } }));
  h.driver.reapply();
  check('reset → 清空后 reapply 不再写回', scanOf(h) === undefined);
}

// ── isActive=false：仍发 RPC 但不落地画布 ────────────────────────────────────
{
  const h = makeHarness([nodeA()], { activeMode: false });
  resetCalls(h);
  await h.driver.action('s-a', 'setpos', 5);
  const c = h.state.calls[0];
  check('inactive → setpos 仍发 scan.move', c?.m === 'scan.move' && c.p.position === 5, JSON.stringify(c));
  check('inactive → 不写节点 data.scan', scanOf(h) === undefined);

  const h2 = makeHarness([nodeA()], { activeMode: false });
  emit(h2, { type: 'position', position: 5 });
  check('inactive → onEvent 不写节点', scanOf(h2) === undefined);
}

// ── action：setauthority（settled PAUSED + canSetAuthority）───────────────────
{
  const h = makeHarness([nodeA()]);
  await seedPausedAuthority(h);
  let resolveRpc;
  h.state.responder = (m) => {
    if (m === 'scan.set_authority') {
      return new Promise((resolve) => {
        resolveRpc = resolve;
      });
    }
    return Promise.resolve({});
  };
  const p = h.driver.action('s-a', 'setauthority', 'full');
  const c = h.state.calls[0];
  const inflight = scanOf(h);
  check(
    'setauthority → scan.set_authority{stream_name:a,authority:full}',
    c?.m === 'scan.set_authority' && c.p.stream_name === 'a' && c.p.authority === 'full',
    JSON.stringify(c)
  );
  check(
    'setauthority → 同步阶段不改 authority（无乐观更新）',
    inflight?.authority === 'workspace-write',
    JSON.stringify(inflight)
  );
  check('setauthority → in-flight switchingAuthority=true', inflight?.switchingAuthority === true);
  resolveRpc({ success: true, authority: 'full' });
  await p;
  const done = scanOf(h);
  check('setauthority 成功 → authority=res.authority(full)', done?.authority === 'full', JSON.stringify(done));
  check('setauthority 成功 → switchingAuthority=false', done?.switchingAuthority === false, JSON.stringify(done));
}
{
  // 响应缺 authority → 回退到请求值。
  const h = makeHarness([nodeA()]);
  await seedPausedAuthority(h);
  h.state.responder = async (m) => (m === 'scan.set_authority' ? { success: true } : {});
  await h.driver.action('s-a', 'setauthority', 'full');
  check(
    'setauthority 成功但响应缺 authority → 回退请求值',
    scanOf(h)?.authority === 'full' && scanOf(h)?.switchingAuthority === false,
    JSON.stringify(scanOf(h))
  );
}
{
  // {success:false}：保持旧 authority + warn。
  const h = makeHarness([nodeA()]);
  await seedPausedAuthority(h);
  h.state.responder = async (m) =>
    m === 'scan.set_authority' ? { success: false, error: { message: 'not allowed' } } : {};
  await h.driver.action('s-a', 'setauthority', 'full');
  const s = scanOf(h);
  check('setauthority {success:false} → 保持旧 authority', s?.authority === 'workspace-write', JSON.stringify(s));
  check('setauthority {success:false} → switching=false', s?.switchingAuthority === false);
  check(
    'setauthority {success:false} → warn toast',
    h.state.toasts.some((t) => String(t.t).includes('切换扫描权限失败') && t.k === 'warn'),
    JSON.stringify(h.state.toasts)
  );
}
{
  // 抛错：保持旧 authority + warn。
  const h = makeHarness([nodeA()]);
  await seedPausedAuthority(h);
  h.state.responder = async (m) => {
    if (m === 'scan.set_authority') throw new Error('boom');
    return {};
  };
  await h.driver.action('s-a', 'setauthority', 'full');
  const s = scanOf(h);
  check('setauthority 抛错 → 保持旧 authority', s?.authority === 'workspace-write', JSON.stringify(s));
  check('setauthority 抛错 → switching=false', s?.switchingAuthority === false);
  check(
    'setauthority 抛错 → warn toast 含 boom',
    h.state.toasts.some((t) => String(t.t).includes('boom') && t.k === 'warn'),
    JSON.stringify(h.state.toasts)
  );
}
{
  // 未暂停（idle）：无 RPC + warn。
  const h = makeHarness([nodeA()]);
  resetCalls(h);
  await h.driver.action('s-a', 'setauthority', 'full');
  check('setauthority idle → 无 RPC', h.state.calls.length === 0, JSON.stringify(h.state.calls));
  check(
    'setauthority idle → warn（含暂停）',
    h.state.toasts.some((t) => String(t.t).includes('暂停') && t.k === 'warn'),
    JSON.stringify(h.state.toasts)
  );

  // paused 但 canSetAuthority=false：无 RPC + warn。
  const h2 = makeHarness([nodeA()]);
  await seedPausedAuthority(h2, { can_set_authority: false });
  await h2.driver.action('s-a', 'setauthority', 'full');
  check('setauthority paused 无权限 → 无 RPC', h2.state.calls.length === 0, JSON.stringify(h2.state.calls));
  check(
    'setauthority paused 无权限 → warn（含无权）',
    h2.state.toasts.some((t) => String(t.t).includes('无权') && t.k === 'warn'),
    JSON.stringify(h2.state.toasts)
  );

  // scanning 但 canSetAuthority=true：仍拒绝（必须 settled PAUSED）。
  const h3 = makeHarness([nodeA()]);
  await seedPausedAuthority(h3, { state: 'scanning', pause_phase: 'none' });
  await h3.driver.action('s-a', 'setauthority', 'full');
  check('setauthority scanning → 无 RPC', h3.state.calls.length === 0, JSON.stringify(h3.state.calls));
  check(
    'setauthority scanning → warn（含暂停）',
    h3.state.toasts.some((t) => String(t.t).includes('暂停') && t.k === 'warn'),
    JSON.stringify(h3.state.toasts)
  );
}

// ── onEvent：authority 轴（change.type=authority / 顶层 authority）────────────
{
  const h = makeHarness([nodeA()]);
  emit(h, { type: 'authority', old_authority: 'workspace-write', new_authority: 'full', generation: 9 });
  const s = scanOf(h);
  check('onEvent authority 事件 → authority=full', s?.authority === 'full', JSON.stringify(s));
  check(
    'onEvent authority 事件 → 不改 state / pausePhase',
    s?.state === 'idle' && s?.pausePhase === 'none',
    JSON.stringify(s)
  );
}
{
  const h = makeHarness([nodeA()]);
  emit(h, { type: 'position', position: 2 }, { authority: 'workspace-write' });
  check(
    'onEvent 顶层 authority → 更新 authority（并与 position 共存）',
    scanOf(h)?.authority === 'workspace-write' && scanOf(h)?.position === 2,
    JSON.stringify(scanOf(h))
  );
}
{
  // 事件回填清 in-flight 标记。
  const h = makeHarness([nodeA()]);
  await seedPausedAuthority(h);
  h.state.responder = (m) =>
    m === 'scan.set_authority' ? new Promise(() => {}) : Promise.resolve({});
  h.driver.action('s-a', 'setauthority', 'full');
  check('authority 事件回填前置：switching=true', scanOf(h)?.switchingAuthority === true);
  emit(h, { type: 'authority', old_authority: 'workspace-write', new_authority: 'full', generation: 10 });
  const s = scanOf(h);
  check(
    'authority 事件回填 → authority=full + 清 switching',
    s?.authority === 'full' && s?.switchingAuthority === false,
    JSON.stringify(s)
  );
}

// ── hydrate：authority 轴映射（加法，不破坏既有字段）─────────────────────────
{
  const h = makeHarness([{ id: 's-b', position: { x: 0, y: 0 }, data: { name: 'B', content: 'x' } }]);
  h.state.responder = async (m) =>
    m === 'scan.status'
      ? {
          state: 'paused',
          pause_phase: 'paused',
          position: 3,
          normal_succeeded: 2,
          background_started: 1,
          normal_failed: 4,
          background_failed: 5,
          authority: 'workspace-write',
          allowed_authorities: ['workspace-write', 'full'],
          can_set_authority: true,
        }
      : {};
  await h.driver.hydrate();
  const s = scanOf(h, 's-b');
  check('hydrate authority → workspace-write', s?.authority === 'workspace-write', JSON.stringify(s));
  check(
    'hydrate allowed_authorities → 拷贝数组',
    Array.isArray(s?.allowedAuthorities) && s.allowedAuthorities.join(',') === 'workspace-write,full',
    JSON.stringify(s)
  );
  check('hydrate can_set_authority → canSetAuthority=true', s?.canSetAuthority === true);
  check('hydrate → switchingAuthority=false', s?.switchingAuthority === false, JSON.stringify(s));
  check(
    'hydrate authority 块仍映射既有 state/pause/position/counters',
    s?.state === 'paused' && s?.pausePhase === 'paused' && s?.position === 3 && s?.ok === 3 && s?.fail === 9,
    JSON.stringify(s)
  );
}
{
  // 旧 SE（status 无 authority 字段）→ 安全默认值。
  const h = makeHarness([{ id: 's-b', position: { x: 0, y: 0 }, data: { name: 'B', content: 'x' } }]);
  h.state.responder = async (m) => (m === 'scan.status' ? { state: 'idle' } : {});
  await h.driver.hydrate();
  const s = scanOf(h, 's-b');
  check(
    'hydrate 旧 status → authority=null / allowed=[] / canSet=false',
    s?.authority === null &&
      Array.isArray(s.allowedAuthorities) &&
      s.allowedAuthorities.length === 0 &&
      s.canSetAuthority === false &&
      s.switchingAuthority === false,
    JSON.stringify(s)
  );
}
{
  // idleScan（stop → idle）仍带 authority 轴默认值。
  const h = makeHarness([nodeA()]);
  await h.driver.action('s-a', 'stop');
  const s = scanOf(h);
  check(
    'idleScan → authority=null / allowed=[] / canSet=false / switching=false',
    s?.authority === null &&
      Array.isArray(s.allowedAuthorities) &&
      s.allowedAuthorities.length === 0 &&
      s.canSetAuthority === false &&
      s.switchingAuthority === false,
    JSON.stringify(s)
  );
}
{
  // start 不抹掉服务端 authority 轴（加法字段随 cur 保留）。
  const h = makeHarness([nodeA()]);
  await seedPausedAuthority(h);
  emit(h, { type: 'state', new_state: 'idle', pause_phase: 'none' });
  await h.driver.action('s-a', 'start');
  const s = scanOf(h);
  check(
    'start 清空上一次的 authority 轴（不显示陈旧事实）',
    s?.authority === null &&
      Array.isArray(s.allowedAuthorities) &&
      s.allowedAuthorities.length === 0 &&
      s.canSetAuthority === false &&
      s.state === 'scanning',
    JSON.stringify(s)
  );
}
{
  // rescan is a new scan too: the previous authority axis must not leak.
  const h = makeHarness([nodeA()]);
  await seedPausedAuthority(h);
  emit(h, { type: 'state', new_state: 'idle', pause_phase: 'none' });
  await h.driver.action('s-a', 'rescan');
  const s = scanOf(h);
  check(
    'rescan 清空上一次的 authority 轴',
    s?.authority === null && s?.canSetAuthority === false && s?.state === 'scanning',
    JSON.stringify(s)
  );
}
{
  // scan_complete returns to idle; no authority axis may survive.
  const h = makeHarness([nodeA()]);
  await seedPausedAuthority(h);
  emit(h, {
    type: 'scan_complete',
    normal_succeeded: 1,
    background_started: 0,
    normal_failed: 0,
    background_failed: 0,
  });
  const s = scanOf(h);
  check(
    'scan_complete 清空 authority 轴',
    s?.state === 'idle' && s?.authority === null && s?.canSetAuthority === false,
    JSON.stringify(s)
  );
}
{
  // A late pause-status response must not overwrite a newer scanning state.
  const h = makeHarness([nodeA()]);
  let resolveStatus;
  h.state.responder = (m) => {
    if (m === 'scan.status') {
      return new Promise((r) => {
        resolveStatus = r;
      });
    }
    return {};
  };
  emit(h, { type: 'state', new_state: 'paused', pause_phase: 'paused' });
  emit(h, { type: 'state', new_state: 'scanning', pause_phase: 'none' });
  resolveStatus({
    authority: 'workspace-write',
    allowed_authorities: ['workspace-write', 'full'],
    can_set_authority: true,
  });
  await new Promise((r) => setTimeout(r, 0));
  const s = scanOf(h);
  check(
    'stale pause status 不覆盖后续 scanning 状态',
    s?.state === 'scanning' && s?.authority == null,
    JSON.stringify(s)
  );
}

{
  // 暂停事件必须触发一次 scan.status 水合，否则 allowedAuthorities/canSetAuthority
  // 只在 tab 重新激活/reload 时才出现，暂停当下的切换控件会缺失。
  const h = makeHarness([nodeA()]);
  h.state.responder = async (m) => {
    if (m === 'scan.status') {
      return {
        state: 'paused',
        pause_phase: 'paused',
        authority: 'workspace-write',
        allowed_authorities: ['workspace-write', 'full'],
        can_set_authority: true,
      };
    }
    return {};
  };
  emit(h, { type: 'state', new_state: 'paused', pause_phase: 'paused' });
  await new Promise((r) => setTimeout(r, 0));
  const s = scanOf(h);
  check('pause 事件触发 scan.status 水合 authority', s?.authority === 'workspace-write', JSON.stringify(s));
  check(
    'pause 事件触发 scan.status 水合 allowedAuthorities',
    Array.isArray(s?.allowedAuthorities) && s.allowedAuthorities.includes('full'),
    JSON.stringify(s)
  );
  check('pause 事件触发 scan.status 水合 canSetAuthority', s?.canSetAuthority === true, JSON.stringify(s));
}
{
  // pause action 直接返回 settled paused 时，也必须在同一 tab 水合切换信息。
  const h = makeHarness([nodeA()]);
  h.state.responder = async (m) => {
    if (m === 'scan.pause') return { success: true, state: 'paused', pause_phase: 'paused' };
    if (m === 'scan.status') {
      return {
        authority: 'workspace-write',
        allowed_authorities: ['workspace-write', 'full'],
        can_set_authority: true,
      };
    }
    return {};
  };
  await h.driver.action('s-a', 'pause');
  await new Promise((r) => setTimeout(r, 0));
  const s = scanOf(h);
  check(
    'pause action 直接 settled 时也水合 allowedAuthorities/canSetAuthority',
    Array.isArray(s?.allowedAuthorities) && s.allowedAuthorities.includes('full') && s?.canSetAuthority === true,
    JSON.stringify(s)
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
