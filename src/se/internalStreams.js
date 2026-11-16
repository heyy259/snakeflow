// 期 13（Phase 0）内部流判定纯函数（方案 D5：唯一内部流决策函数）。
//
// 背景：扫描任务启动时会派生两条**普通流** `{stream}_console`（进程 console 增量）
// 与 `{stream}_scan_log`（扫描正文记账）。期 14（方案 D4/§P0「内部流等价原则」）起，
// 它们与其他流一样**进入全量重投影**（不再从投影剔除），仅额外在首次出现时由
// `appearedInternalNames` 触发一次本地 `canvas:'false'` 注入（画布隐藏，流仍在列表）。
// 本函数的产出**只服务两点**：① 首次打标；② 导出默认不勾（见 App.jsx）。但「后缀命中」≠
// 「内部流」：
// 用户完全可能自建名为 `user_console` 的真实流——只要基流 `user` 存在，它就是
// 用户流，必须正常投影。故决策收敛为唯一函数：
//
//   isInternal(name, allNames) = 后缀命中 AND 基流存在
//
// 唯一性纪律（D5）：所有调用方只准用本函数，不得各自写后缀判断，避免出现
// 「这里判内部、那里不判」的口径分裂。`procAssoc.isInternalStream` 只是底层
// 后缀谓词（被本模块复用），不是完整决策。
//
// 纯逻辑：无 React / DOM / SEClient / 网络依赖，可在 Node 侧直接 import 单测。
// （internalStreams → streams → graph → dagre 均为纯 JS，Node 可安全加载。）

import { INTERNAL_SUFFIXES, isInternalStream } from './procAssoc.js';
import { streamNodeId } from './streams.js';

// 后缀表单一真源在 procAssoc：此处仅再导出，禁止复制/扩展列表。
export { INTERNAL_SUFFIXES } from './procAssoc.js';

/** 画布可见性保留键：唯一真源在 tagOps，此处仅再导出。 */
export { CANVAS_TAG_KEY } from './tagOps.js';

/**
 * name → 基流 name：去掉末尾一个内部后缀；无后缀返回 null。
 * 裸后缀（`_console` / `_scan_log` 本身）不算派生名——要求 `name.length > suffix.length`，
 * 与 `procAssoc.isInternalStream` 的边界口径一致（否则空基流会被误判存在）。
 */
export function baseStreamName(name) {
  const n = String(name == null ? '' : name);
  for (const suffix of INTERNAL_SUFFIXES) {
    if (n.length > suffix.length && n.endsWith(suffix)) return n.slice(0, -suffix.length);
  }
  return null;
}

/** `stream.list` 行数组 → 非空 name 的 Set（跳过畸形行 / 空 name）。 */
export function allNamesFromList(list) {
  const rows = Array.isArray(list) ? list : [];
  const out = new Set();
  for (const row of rows) {
    if (!row || row.name == null || row.name === '') continue;
    out.add(String(row.name));
  }
  return out;
}

/** 归一 allNames 入参：Set 直用；数组 / 可迭代 → 字符串 Set；其余空 Set。 */
function asNameSet(allNames) {
  if (allNames instanceof Set) return allNames;
  if (Array.isArray(allNames)) return new Set(allNames.map((x) => String(x == null ? '' : x)));
  if (allNames && typeof allNames[Symbol.iterator] === 'function') {
    return new Set(Array.from(allNames, (x) => String(x == null ? '' : x)));
  }
  return new Set();
}

/** 基流存在性：name 有内部后缀且基流在 allNames（Set 或数组）中。 */
export function baseStreamExists(name, allNames) {
  const base = baseStreamName(name);
  if (base == null) return false;
  return asNameSet(allNames).has(base);
}

/** D5 唯一决策：后缀命中 AND 基流存在 ⇒ 内部流（不进重投影）。 */
export function isInternal(name, allNames) {
  return isInternalStream(name) && baseStreamExists(name, allNames);
}

/**
 * 「新出现的内部流」选择器（重投影后调用，用于把新内部流标 `canvas:'false'`）。
 *
 * 命中条件（全部满足）：
 *   1. `isInternal(name, allNames)` —— 后缀 + 基流存在（同一 list 内取 allNames）；
 *   2. `s-<name>` 不在 prevIds（Set 或数组）—— 已投影过的节点不重复处理；
 *   3. `String(tags?.canvas) !== 'false'` —— 已显式隐藏的不再重复写。
 *
 * @param {Array<{name, tags?}>} list `stream.list` 行
 * @param {Set<string>|Array<string>} prevIds 当前画布已有节点 id
 * @returns {Array<{name:string, id:string}>} 保持 list 原序
 */
export function appearedInternalNames(list, prevIds) {
  const rows = Array.isArray(list) ? list : [];
  const allNames = allNamesFromList(rows);
  const prev = prevIds instanceof Set
    ? prevIds
    : new Set((Array.isArray(prevIds) ? prevIds : []).map((x) => String(x == null ? '' : x)));
  const out = [];
  for (const row of rows) {
    if (!row || row.name == null || row.name === '') continue;
    const name = String(row.name);
    if (!isInternal(name, allNames)) continue;
    const id = streamNodeId(name);
    if (prev.has(id)) continue;
    if (String(row.tags?.canvas) === 'false') continue;
    out.push({ name, id });
  }
  return out;
}
