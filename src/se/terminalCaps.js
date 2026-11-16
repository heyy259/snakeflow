// 期 14 加固：内部流（`_console` / `_scan_log`）正文的硬上限集中定义。
//
// 背景：后端 `{stream}_console` 只增不减，`stream.read` 返回全文；前端若把全文
// 累加进 `data.content`、每次更新再 `split()` 成 `termBody` / 逐行渲染，代价随
// 正文线性增长（字符串拼接 + 渲染合计近似 O(n²)），最终冻结主线程。
//
// 本模块是这些上限的**唯一**定义处（App 内容通路、AgentNode 渲染、NodeTerminal
// 终端行共享），避免散落的魔法数字与口径分裂。
//
// 纯常量：无 React / DOM / 网络依赖，Node 侧可直接 import。
// 后缀判定复用 `procAssoc.isInternalStream`（`_console` / `_scan_log` 唯一后缀源）。

/** 内部流本地滚动尾缓冲最大字符数（App.readStreamContent / runContentRead）。 */
export const CONSOLE_TAIL_MAX_CHARS = 200000;

/** 派生给父节点 `data.termBody` 的最大行数（App.applyConsoleDerivation）。 */
export const TERM_BODY_MAX_LINES = 1000;

/** NodeTerminal 单次渲染的最大日志行数（termBody + termLog 合并后）。 */
export const TERM_RENDER_MAX_LINES = 1000;

/** markdown 页字符预算（渲染分页用，替代渲染截尾；优先按顶层块边界对齐，超预算单块按行边界内切）。 */
export const PAGE_CHAR_BUDGET = 15000;

/** console 纯文本流行窗口页预算（AgentNode 只读分页渲染）。 */
export const PAGE_LINE_BUDGET = 500;

/** 内部流历史页缓存每节点上限（LRU，按插入序淘汰最旧一页）。 */
export const HISTORY_PAGE_CACHE_MAX = 20;
