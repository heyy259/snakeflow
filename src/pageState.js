// 期 15 分页：只读显示层（MarkdownView / AgentNode）共享的模块级页码状态 + 内部流历史页缓存，不持久化。
//
// 镜像 `foldState.js` 的形态：模块级 Map + listener Set（通知时 try/catch 隔离单个订阅者异常）。
//
// - pageState    : scopedKey -> number（显式页码；缺省/夹紧策略由调用方负责，这里只存整数 ≥ 0）
// - historyCache : scopedKey -> Map<pageIndex, string>（内部流经服务端取回的历史页，
//                  按插入序 LRU，超过 HISTORY_PAGE_CACHE_MAX 淘汰最旧一页）
//
// **归属**：所有键都是 `viewStateKey(scope, nodeId)`（`<tabId>\0<nodeId>`）。SE 节点 id 是
// `s-<streamName>`，不含系统身份；两个标签页的同名流若只按 nodeId 建键会串页。每个 API 都
// 强制传入 scope + nodeId，没有未归属的兜底路径。scope 由调用方取节点渲染态 `data.viewScope`
// （活动 tab id），不进入文档/快照。
//
// nodeId 可能是非字符串（数字 / null），一律 `String(nodeId)` 归一化后拼入归属键。
// `getPage` 只返回**显式**记录，不替调用方兜底默认页；未记录的节点返回 undefined。

import { HISTORY_PAGE_CACHE_MAX } from './se/terminalCaps.js';
import { viewStateKey, viewStateScopePrefix } from './viewStateScope.js';

/** 显式页码：scopedKey -> number（整数 ≥ 0）。 */
const pageState = new Map();
/** 内部流历史页缓存：scopedKey -> Map<pageIndex, string>（LRU）。 */
const historyCache = new Map();

const listeners = new Set();

/** 通知页码/历史页变化（订阅者异常不影响其余）。 */
export function notifyPages() {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch (err) {
      /* 单个订阅者异常不影响其余 */
    }
  });
}

/** 订阅页码变化，返回取消订阅函数。 */
export function subscribePages(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 读取显式页码：未记录 → undefined（默认页由调用方决定）。 */
export function getPage(scope, nodeId) {
  return pageState.get(viewStateKey(scope, nodeId));
}

/** 写入显式页码（向下取整并夹紧 ≥ 0），随后广播。 */
export function setPage(scope, nodeId, page) {
  const n = Number(page);
  const safe = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  pageState.set(viewStateKey(scope, nodeId), safe);
  notifyPages();
}

/** 节点身份迁移（改名/提升）：同一 scope 内页码与历史页缓存跟随 nodeId，随后广播。 */
export function rekeyNodeState(scope, oldNodeId, newNodeId) {
  const from = viewStateKey(scope, oldNodeId);
  const to = viewStateKey(scope, newNodeId);
  if (from === to) return;
  if (pageState.has(from)) {
    pageState.set(to, pageState.get(from));
    pageState.delete(from);
  }
  if (historyCache.has(from)) {
    historyCache.set(to, historyCache.get(from));
    historyCache.delete(from);
  }
  notifyPages();
}

/** 清除某 scope 下某节点页码，并同步清空其历史页缓存，随后广播。 */
export function clearPage(scope, nodeId) {
  const key = viewStateKey(scope, nodeId);
  pageState.delete(key);
  historyCache.delete(key);
  notifyPages();
}

/** 读取内部流历史页：未命中 → undefined。 */
export function getHistoryPage(scope, nodeId, pageIndex) {
  const map = historyCache.get(viewStateKey(scope, nodeId));
  return map ? map.get(pageIndex) : undefined;
}

/** 写入内部流历史页（按插入序 LRU 淘汰最旧一页），随后广播。 */
export function setHistoryPage(scope, nodeId, pageIndex, text) {
  const key = viewStateKey(scope, nodeId);
  let map = historyCache.get(key);
  if (!map) {
    map = new Map();
    historyCache.set(key, map);
  }
  // 覆盖已有页时先删后插，刷新其在 LRU 中的位置。
  if (map.has(pageIndex)) map.delete(pageIndex);
  map.set(pageIndex, text);
  while (map.size > HISTORY_PAGE_CACHE_MAX) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
  notifyPages();
}

/** 删除某 scope 下某节点的单个历史页缓存（append 增长使边界页陈旧时按需失效），随后广播。 */
export function deleteHistoryPage(scope, nodeId, pageIndex) {
  const map = historyCache.get(viewStateKey(scope, nodeId));
  // 仅在实际删除了条目时广播，避免每次 append 都触发无谓的通知风暴。
  if (map && map.delete(pageIndex)) notifyPages();
}

/** 清空某 scope 下某节点的全部历史页缓存（不单独广播；调用方按需 notifyPages）。 */
export function clearHistoryForNode(scope, nodeId) {
  historyCache.delete(viewStateKey(scope, nodeId));
}

/**
 * 关闭标签页时清理该 tab 的全部页码 + 历史页缓存；其它 tab 的同名 nodeId 不受影响。
 * 仅按 `<scope>\0` 前缀删除，绝不按裸 nodeId 删除。
 */
export function clearPageScope(scope) {
  const prefix = viewStateScopePrefix(scope);
  let changed = false;
  Array.from(pageState.keys()).forEach((key) => {
    if (!key.startsWith(prefix)) return;
    pageState.delete(key);
    changed = true;
  });
  Array.from(historyCache.keys()).forEach((key) => {
    if (!key.startsWith(prefix)) return;
    historyCache.delete(key);
    changed = true;
  });
  if (changed) notifyPages();
}
