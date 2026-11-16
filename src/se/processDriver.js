// 期 8 进程驱动（方案 §2.1/§2.2）：SE 进程生命周期 → 画布节点运行时投影。
//
// 归属：`createSeRuntime` 每系统挂一个实例（runtime.js），订阅主题仅
// `tool.process.on_change`。
//
// 期 14（方案 D4/AC-4）：**本驱动绝不 `stream.read`**——`_console` 正文由 App 的
// 通用内容通路（单读者）写入 `s-{base}_console` 节点 `data.content`，再派生到父节点
// `data.termBody`。本驱动只维护进程清单与**合成行**（进程启动/退出/停止、`> input`、
// reader_error），写入父节点 `data.termLog`。
//
// 职责与纪律：
// - 不 import React / DOM / SEClient / vite / playwright / spawn；只经注入的
//   `call` / `isActive` / `getNodes` / `setNodes` / `notify` 与外界交互（方案 §2.1）。
// - **每一次** `setNodes` 都是函数式 `setNodes(nds => …)`，且前置 `isActive()` 守卫
//   （后台 tab 只缓存权威态、不写画布）。
// - 进程生命周期受扫描任务作用域约束：任务结束后 `get_process_info` 可能返回
//   `null` / `-33001`，故 `console_stream` 必须第一时间缓存进 `index`。
//
// 事实（SE 源码核实 2026-09-22）：
// - `tool.list_processes {}` → `list[dict]`，键含
//   `process_name/tool_name/params/console_stream/start_time/status/running_time/keep_stdin`；
// - `tool.get_process_info {process_name}` → 同形 dict + `exit_code/timeout/*_buffer_size`；
// - `tool.send_input {process_name,data}` → `{success, error}`（**业务失败不 throw**）；
// - `tool.stop_process {process_name}` → `{success, killed, errors}`；
// - 事件 `tool.process.on_change` 的 `change.type` ∈
//   `process_started`（**无 console_stream**）/ `process_exited` / `reader_error`。
//
// 映射链（procAssoc.js）：`console_stream` → `scanStreamFromConsole` → 扫描流 name
// → `streamNodeId` → 画布节点 id；反查节点归属。

import { consoleStreamFor, scanStreamFromConsole } from './procAssoc.js';
import { streamNodeId, streamNameFromId } from './streams.js';

/** 单节点合并合成日志行数上限（环形缓冲，超出丢最旧）。 */
const MAX_LINES = 500;

/**
 * 创建进程驱动。
 *
 * @param {{
 *   call:(method:string, params?:object)=>Promise<any>,
 *   isActive:()=>boolean,
 *   getNodes:()=>Array,
 *   setNodes:(updater:(nds:Array)=>Array)=>void,
 *   notify:(text:string, kind?:string)=>void,
 * }} deps
 * @returns {{
 *   topics:string[],
 *   onEvent:(topic:string, params:object)=>Promise<any>|undefined,
 *   hydrate:()=>Promise<void>,
 *   reset:()=>void,
 *   reapply:()=>void,
 *   logFor:(nodeId:string)=>Array<{kind:string,text:string}>,
 *   sendInput:(nodeId:string, processName:string, text:string)=>Promise<any>,
 *   stopProcess:(nodeId:string, processName:string)=>Promise<any>,
 * }}
 */
export function createProcessDriver({ call, isActive, getNodes, setNodes, notify }) {
  /** process_name → { nodeId, tool_name, console_stream, waiting } */
  const index = new Map();
  /** nodeId → { lines:Array<{kind,text}> }（合成行环形缓冲）。 */
  const logs = new Map();

  const active = () => (typeof isActive === 'function' ? !!isActive() : true);
  const warn = (text) => {
    if (typeof notify === 'function') notify(text, 'warn');
  };
  const nodeList = () => {
    const n = getNodes();
    return Array.isArray(n) ? n : [];
  };

  // ── 合成日志环形缓冲 ────────────────────────────────────────────────────────

  function ensureLog(nodeId) {
    const id = String(nodeId);
    let entry = logs.get(id);
    if (!entry) {
      entry = { lines: [] };
      logs.set(id, entry);
    }
    return entry;
  }

  /** 追加一行并裁剪（>500 行丢最旧）。 */
  function appendLine(nodeId, kind, text) {
    const entry = ensureLog(nodeId);
    const line = { kind: String(kind || 'system'), text: String(text == null ? '' : text) };
    entry.lines.push(line);
    while (entry.lines.length > MAX_LINES) entry.lines.shift();
    return entry;
  }

  /** 当前日志行（副本）；无则 null。 */
  function linesFor(nodeId) {
    const entry = logs.get(String(nodeId));
    return entry && entry.lines.length ? entry.lines.slice() : null;
  }

  // ── 投影（进程 + 终端日志，全部函数式 setNodes）────────────────────────────

  /** 某节点当前进程清单（按 index 反查，waiting 由 keep_stdin/发送结果维护）。 */
  function processesForNode(nodeId) {
    const id = String(nodeId);
    const out = [];
    index.forEach((v, processName) => {
      if (String(v.nodeId) !== id) return;
      out.push({
        id: processName,
        tool: v.tool_name || '',
        name: processName,
        waiting: !!v.waiting,
      });
    });
    return out;
  }

  /** 组装节点 data：空 processes/termLog 一律 delete（运行时不落盘）。 */
  function buildData(prev, procs, lines) {
    const data = { ...(prev && typeof prev === 'object' ? prev : {}) };
    if (procs && procs.length) data.processes = procs;
    else delete data.processes;
    if (lines && lines.length) data.termLog = lines;
    else delete data.termLog;
    return data;
  }

  /** 重投影单个节点（isActive 守卫）。 */
  function projectNode(nodeId) {
    if (!active()) return;
    const id = String(nodeId == null ? '' : nodeId);
    if (!id) return;
    setNodes((nds) =>
      (Array.isArray(nds) ? nds : []).map((n) => {
        if (String(n && n.id) !== id) return n;
        return { ...n, data: buildData(n && n.data, processesForNode(id), linesFor(id)) };
      })
    );
  }

  /** 重投影所有 s-* 节点（无进程者 delete data.processes / data.termLog）。 */
  function projectAllS() {
    if (!active()) return;
    setNodes((nds) =>
      (Array.isArray(nds) ? nds : []).map((n) => {
        const id = String(n && n.id);
        if (streamNameFromId(id) === null) return n;
        return { ...n, data: buildData(n && n.data, processesForNode(id), linesFor(id)) };
      })
    );
  }

  // ── 归属判定 ───────────────────────────────────────────────────────────────

  /** 事件无 console_stream 时的兜底：唯一 scanning 节点；不唯一 → null（忽略）。 */
  function uniqueScanningNodeId() {
    const candidates = nodeList().filter(
      (n) => n && n.data && n.data.scan && n.data.scan.state === 'scanning'
    );
    return candidates.length === 1 ? String(candidates[0].id) : null;
  }

  // ── hydrate ────────────────────────────────────────────────────────────────

  /** 重建 index（从 list_processes），播种日志缓冲，并把进程投影到全部 s-* 节点。 */
  async function hydrate() {
    if (!active()) return;
    let raw;
    try {
      raw = await call('tool.list_processes', {});
    } catch (err) {
      return;
    }
    const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.list) ? raw.list : [];

    index.clear();
    list.forEach((p) => {
      if (!p || p.process_name == null || p.process_name === '') return;
      const processName = String(p.process_name);
      let consoleStream = p.console_stream != null ? String(p.console_stream) : '';
      let stream = consoleStream ? scanStreamFromConsole(consoleStream) : null;
      // 缺 console_stream：仅当载荷带 stream 字段（或 params.stream）才回落；否则跳过。
      if (!stream) {
        const rawStream =
          p.stream != null
            ? String(p.stream)
            : p.params && p.params.stream != null
              ? String(p.params.stream)
              : '';
        if (rawStream) {
          stream = rawStream;
          consoleStream = consoleStreamFor(rawStream);
        }
      }
      if (!stream) return;
      const nodeId = streamNodeId(stream);
      const cs = consoleStream || consoleStreamFor(stream);
      index.set(processName, {
        nodeId,
        tool_name: p.tool_name != null ? String(p.tool_name) : '',
        console_stream: cs,
        waiting: !!p.keep_stdin,
      });
    });

    projectAllS();
  }

  // ── 事件处理 ───────────────────────────────────────────────────────────────

  async function handleStarted(change) {
    const processName = String(change && change.process_name != null ? change.process_name : '');
    if (!processName) return;
    const evtTool = change && change.tool_name != null ? String(change.tool_name) : '';

    // 事件无 console_stream：先用 get_process_info 取 console_stream 解析归属。
    let info = null;
    try {
      info = await call('tool.get_process_info', { process_name: processName });
    } catch (err) {
      info = null;
    }
    const infoStream = info && info.console_stream != null ? String(info.console_stream) : '';
    let nodeId = null;
    if (infoStream) {
      const stream = scanStreamFromConsole(infoStream);
      if (stream) nodeId = streamNodeId(stream);
    }
    if (!nodeId) nodeId = uniqueScanningNodeId();
    if (!nodeId) return; // 未分配：忽略

    const streamName = streamNameFromId(nodeId);
    const cs = infoStream || consoleStreamFor(streamName || '');
    const toolName = evtTool || (info && info.tool_name != null ? String(info.tool_name) : '');
    index.set(processName, {
      nodeId,
      tool_name: toolName,
      console_stream: cs,
      waiting: info ? !!info.keep_stdin : false,
    });
    appendLine(nodeId, 'system', `进程启动: ${toolName} (${processName})`);
    projectNode(nodeId);
  }

  function handleExited(change) {
    const processName = String(change && change.process_name != null ? change.process_name : '');
    if (!processName) return;
    const entry = index.get(processName);
    if (!entry) return; // 未索引：忽略
    index.delete(processName);
    const toolName = change && change.tool_name != null ? String(change.tool_name) : entry.tool_name;
    appendLine(
      entry.nodeId,
      'warning',
      `进程退出: ${toolName} (${processName}) 退出码=${change ? change.exit_code : ''} 原因=${
        change ? change.reason : ''
      }`
    );
    projectNode(entry.nodeId);
  }

  function handleReaderError(change) {
    const processName = String(change && change.process_name != null ? change.process_name : '');
    const entry = index.get(processName);
    if (!entry) return;
    appendLine(
      entry.nodeId,
      'error',
      `[reader_error ${change ? change.channel : ''}] ${processName}: ${change ? change.error : ''}`
    );
    projectNode(entry.nodeId);
  }

  /** 主题分发（仅 `tool.process.on_change`）。 */
  function onEvent(topic, params) {
    if (topic !== 'tool.process.on_change') return undefined;
    const change = (params && params.change) || {};
    switch (change.type) {
      case 'process_started':
        return handleStarted(change);
      case 'process_exited':
        return handleExited(change);
      case 'reader_error':
        return handleReaderError(change);
      default:
        return undefined;
    }
  }

  // ── 用户操作 ───────────────────────────────────────────────────────────────

  async function sendInput(nodeId, processName, text) {
    const name = String(processName == null ? '' : processName);
    const body = String(text == null ? '' : text);
    let res;
    try {
      res = await call('tool.send_input', { process_name: name, data: body });
    } catch (err) {
      res = {
        success: false,
        error: { kind: 'execution-failed', message: err && err.message ? err.message : String(err) },
      };
    }
    if (res && res.success) {
      appendLine(nodeId, 'system', `> ${body}`);
      const entry = index.get(name);
      if (entry) entry.waiting = false;
      projectNode(nodeId);
      return res;
    }
    const kind = res && res.error && res.error.kind;
    const logKind = kind === 'not-found' ? 'error' : kind === 'denied' ? 'warning' : 'error';
    const message = (res && res.error && res.error.message) || '发送失败';
    appendLine(nodeId, logKind, message);
    projectNode(nodeId);
    if (typeof notify === 'function') notify(message, 'warn');
    return res;
  }

  async function stopProcess(nodeId, processName) {
    const name = String(processName == null ? '' : processName);
    let res;
    try {
      res = await call('tool.stop_process', { process_name: name });
    } catch (err) {
      warn(err && err.message ? err.message : '停止失败');
      return undefined;
    }
    if (res && res.success !== false) {
      const entry = index.get(name);
      const nid = entry ? entry.nodeId : nodeId;
      const toolName = entry ? entry.tool_name : '';
      index.delete(name);
      appendLine(nid, 'warning', `已停止进程: ${toolName} + ${name}`);
      projectNode(nid);
      if (typeof notify === 'function') notify('已停止 ' + name, 'warn');
    }
    return res;
  }

  // ── 读取 / 重贴 / 重置 ─────────────────────────────────────────────────────

  function logFor(nodeId) {
    const entry = logs.get(String(nodeId == null ? '' : nodeId));
    return entry && entry.lines ? entry.lines.slice() : [];
  }

  /** 重投影后把权威态重新贴回节点（index/logs 所涉节点），幂等。 */
  function reapply() {
    if (!active()) return;
    const ids = new Set();
    index.forEach((v) => ids.add(String(v.nodeId)));
    logs.forEach((_v, k) => ids.add(String(k)));
    if (!ids.size) return;
    setNodes((nds) =>
      (Array.isArray(nds) ? nds : []).map((n) => {
        const id = String(n && n.id);
        if (!ids.has(id)) return n;
        return { ...n, data: buildData(n && n.data, processesForNode(id), linesFor(id)) };
      })
    );
  }

  /** 清空全部 per-system 状态（切 tab / 卸载）。 */
  function reset() {
    index.clear();
    logs.clear();
  }

  return {
    topics: ['tool.process.on_change'],
    onEvent,
    hydrate,
    reset,
    reapply,
    logFor,
    sendInput,
    stopProcess,
  };
}
