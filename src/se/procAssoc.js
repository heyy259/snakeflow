// 期 7 关联纯函数：console 流 ↔ 扫描流 ↔ 节点 id 映射 + 内部流判定。
//
// 事实（SE 源码核实 2026-09-22）：
// - 扫描任务启动时创建 `{stream}_console` / `{stream}_scan_log` 两条**普通流**
//   （`tools/task_manager.py::create_log_streams`，命名内联无 helper）；
// - 工具子进程 stdout/stderr 经执行器写入 `{stream}_console`（`[stdout]`/`[stderr]`
//   前缀），**不推送**；前端须经 `stream.on_change` + `stream.read{name,start}` 增量读；
// - 进程以 `process_name` 寻址，`tool.list_processes`/`get_process_info` 返回的
//   `console_stream` 即 `{stream}_console`（`tools/task_manager.py:106` 注入 executor）；
// - `_scan_log` = 扫描正文记账流，UI 不渲染，但同样不得进重投影（G-1）。
//
// 本模块纯函数、无 React / DOM 依赖，可在 Node 侧直接 import 做单测。

/** 内部流后缀（非用户流，不得进全量重投影）——顺序无关。 */
export const INTERNAL_SUFFIXES = ['_console', '_scan_log'];

/** 扫描流 name → 其 console 流 name（`{stream}_console`）。 */
export function consoleStreamFor(streamName) {
  return `${String(streamName == null ? '' : streamName)}_console`;
}

/**
 * console 流 name → 所属扫描流 name；非 `_console` 后缀返回 null。
 * `x_scan_log` 等其它内部流不归此映射（它们不是进程 console）。
 */
export function scanStreamFromConsole(consoleStream) {
  const n = String(consoleStream == null ? '' : consoleStream);
  const suffix = '_console';
  return n.length > suffix.length && n.endsWith(suffix) ? n.slice(0, -suffix.length) : null;
}

/** 判定是否内部流（`_console` / `_scan_log` 后缀）——G-1 短路谓词。 */
export function isInternalStream(name) {
  const n = String(name == null ? '' : name);
  return INTERNAL_SUFFIXES.some((suffix) => n.length > suffix.length && n.endsWith(suffix));
}
