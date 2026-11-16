// 期 8 冒烟（纯 Node 单测）：进程 driver 的投影 / 事件 / 发送 / 停止 / 合成日志 / 重贴。
//
// 覆盖验证门：
//   1. hydrate：list_processes → 按 console_stream 归位到正确节点；waiting 取 keep_stdin。
//   2. process_started：经 get_process_info 解析归属并加入进程；process_exited 移除。
//   3. sendInput：成功追加 `> text` 且清 waiting；not-found/denied 追加正确 kind 日志且不抛。
//   4. stopProcess：移除进程 + 警告日志 + notify。
//   5. 合成行环形缓冲：>500 行丢最旧（console 正文已由 App 单读者通路负责，driver 不再读流）。
//   6. reapply：节点 data 被清空后重贴 processes/termLog（合成行）。
//   7. isActive=false：hydrate/onEvent 不写节点。
//   8. 单读者纪律：driver **从不** `stream.read`（假 call 对 stream.read 直接 throw）。
//
// 无真实 SE / vite / playwright / spawn：call 为内存假实现。npm script 不涉及。
import { createProcessDriver } from '../src/se/processDriver.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 200) : ''}`);
};

// ── 假 harness ────────────────────────────────────────────────────────────────
const nodes = [
  { id: 's-a', data: { name: 'A' } },
  { id: 's-b', data: { name: 'B' } },
];

let active = true;
let listProcessCalls = 0;
let streamReadAttempts = 0;
const notifications = [];

const call = async (method, params) => {
  if (method === 'tool.list_processes') {
    listProcessCalls += 1;
    return [
      { process_name: 'proc_a', tool_name: 'toolA', console_stream: 'a_console', keep_stdin: true },
      { process_name: 'proc_b', tool_name: 'toolB', console_stream: 'b_console', keep_stdin: false },
    ];
  }
  if (method === 'tool.get_process_info') {
    if (params.process_name === 'proc_c') {
      return { process_name: 'proc_c', tool_name: 'toolC', console_stream: 'a_console', keep_stdin: false };
    }
    if (params.process_name === 'proc_new') {
      return { process_name: 'proc_new', tool_name: 'toolNew', console_stream: 'b_console', keep_stdin: false };
    }
    return null;
  }
  if (method === 'tool.send_input') {
    if (params.data === 'ok') return { success: true, error: null };
    if (params.data === 'missing') return { success: false, error: { kind: 'not-found', message: 'no such proc' } };
    if (params.data === 'denied') return { success: false, error: { kind: 'denied', message: 'denied by policy' } };
    return { success: false, error: { kind: 'execution-failed', message: 'boom' } };
  }
  if (method === 'tool.stop_process') {
    return { success: true, killed: true, errors: [] };
  }
  if (method === 'stream.read') {
    streamReadAttempts += 1;
    throw new Error('unexpected stream.read');
  }
  throw new Error(`unexpected ${method}`);
};

const setNodes = (updater) => {
  const next = typeof updater === 'function' ? updater(nodes) : updater;
  nodes.length = 0;
  nodes.push(...next);
};

const makeDriver = (overrides = {}) =>
  createProcessDriver({
    call,
    isActive: () => active,
    getNodes: () => nodes,
    setNodes,
    notify: (text, kind) => notifications.push([text, kind]),
    ...overrides,
  });

const nodeById = (id) => nodes.find((n) => n.id === id);

// ── 主流程 ────────────────────────────────────────────────────────────────────
const driver = makeDriver();

check('topics 含 tool.process.on_change', Array.isArray(driver.topics) && driver.topics.includes('tool.process.on_change'));

// 1. hydrate
await driver.hydrate();
const na = nodeById('s-a');
const nb = nodeById('s-b');
check('hydrate: s-a 归位到 a_console 进程', !!na.data.processes && na.data.processes.length === 1 && na.data.processes[0].name === 'proc_a');
check('hydrate: s-a waiting 取 keep_stdin=true', na.data.processes[0].waiting === true);
check('hydrate: s-b 归位到 b_console 进程', !!nb.data.processes && nb.data.processes.length === 1 && nb.data.processes[0].name === 'proc_b');
check('hydrate: s-b waiting=false', nb.data.processes[0].waiting === false);

// 2. process_started / process_exited
await driver.onEvent('tool.process.on_change', {
  change: { type: 'process_started', process_name: 'proc_c', tool_name: 'toolC' },
});
check('process_started: 经 get_process_info 加入 proc_c', nodeById('s-a').data.processes.some((p) => p.name === 'proc_c'));
check('process_started: 启动日志', driver.logFor('s-a').some((l) => l.text === '进程启动: toolC (proc_c)'));

driver.onEvent('tool.process.on_change', {
  change: { type: 'process_exited', process_name: 'proc_c', tool_name: 'toolC', exit_code: 0, reason: 'done', status: 'dead' },
});
check('process_exited: 移除 proc_c', !nodeById('s-a').data.processes.some((p) => p.name === 'proc_c'));
check('process_exited: 退出警告日志', driver.logFor('s-a').some((l) => l.kind === 'warning' && l.text.includes('进程退出: toolC (proc_c)')));

// 3. sendInput
const rOk = await driver.sendInput('s-a', 'proc_a', 'ok');
check('sendInput 成功：返回 success', rOk && rOk.success === true);
check('sendInput 成功：追加 > text', driver.logFor('s-a').some((l) => l.kind === 'system' && l.text === '> ok'));
check('sendInput 成功：等待位清除', nodeById('s-a').data.processes.find((p) => p.name === 'proc_a').waiting === false);

const rMissing = await driver.sendInput('s-a', 'proc_a', 'missing');
check('sendInput not-found：返回 success=false', rMissing && rMissing.success === false);
check('sendInput not-found：错误行 kind=error', driver.logFor('s-a').some((l) => l.kind === 'error' && l.text === 'no such proc'));

const rDenied = await driver.sendInput('s-a', 'proc_a', 'denied');
check('sendInput denied：警告行 kind=warning', driver.logFor('s-a').some((l) => l.kind === 'warning' && l.text === 'denied by policy'));
check('sendInput 业务失败不抛并 notify', notifications.some(([t]) => t === 'denied by policy'));

// 4. stopProcess
await driver.stopProcess('s-b', 'proc_b');
check('stopProcess: 移除 proc_b（空则删字段）', !(nodeById('s-b').data.processes || []).some((p) => p.name === 'proc_b'));
check('stopProcess: 警告日志', driver.logFor('s-b').some((l) => l.kind === 'warning' && l.text === '已停止进程: toolB + proc_b'));
check('stopProcess: notify 已停止', notifications.some(([t, k]) => t === '已停止 proc_b' && k === 'warn'));

// 5. 合成行环形缓冲（上限 500 丢最旧）
for (let i = 0; i < 600; i += 1) await driver.sendInput('s-a', 'proc_a', 'ok');
const last = driver.logFor('s-a');
check('环形缓冲: 行数封顶 500', last.length === 500, `len=${last.length}`);
check('环形缓冲: 丢弃最旧（首行仍是合成行）', last[0].kind === 'system' && last[0].text === '> ok');
check('单读者: 合成日志不含 console 正文（driver 从不读流）', !last.some((l) => l.text === 'line1' || l.text === 'line2'));
check('单读者: driver 从未调用 stream.read', streamReadAttempts === 0, `attempts=${streamReadAttempts}`);

// 6. reapply
nodeById('s-a').data = { name: 'A' };
nodeById('s-b').data = { name: 'B' };
driver.reapply();
const naR = nodeById('s-a');
check('reapply: 重贴 processes', Array.isArray(naR.data.processes) && naR.data.processes.some((p) => p.name === 'proc_a'));
check('reapply: 重贴 termLog（合成行）', Array.isArray(naR.data.termLog) && naR.data.termLog.length > 0);
check('reapply: 无进程节点清空 processes', !('processes' in nodeById('s-b').data));

// 7. isActive=false
const snap = JSON.stringify(nodes);
const inactive = makeDriver({ isActive: () => false });
const listCallsBefore = listProcessCalls;
await inactive.hydrate();
await inactive.onEvent('tool.process.on_change', {
  change: { type: 'process_started', process_name: 'proc_new', tool_name: 'toolNew' },
});
check('isActive=false: hydrate 早退（不调 list_processes）', listProcessCalls === listCallsBefore);
check('isActive=false: 不写节点', JSON.stringify(nodes) === snap);

// 8. reset
driver.reset();
check('reset: logFor 清空', driver.logFor('s-a').length === 0);
check('reset: logFor 未知节点返回空数组', Array.isArray(driver.logFor('s-zzz')) && driver.logFor('s-zzz').length === 0);

// ── 汇总 ──────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
