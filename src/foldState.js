// 折叠展开态：只读显示层（MarkdownView）与编辑态（fold node-view）共享的模块级内存 Map，不持久化。
//
// **归属**：SE 节点 id 是 `s-<streamName>`，不含系统身份；两个标签页的同名流若只按 nodeId
// 建键会串折叠态。因此所有键都以 `viewStateKey(scope, nodeId)`（`<tabId>\0<nodeId>`）为
// owner，scope 取节点渲染态 `data.viewScope`（活动 tab id），不进入文档/快照。所有 API 都
// 强制 scope + nodeId，没有未归属兜底。
//
// 键规则（原型 index.html:1145-1152 / §4.4 映射表）：
//   foldState key = `${owner}::${slug}#${occurrence}`，owner = scoped node key，slug 由标题
//   （summary 正文首行）派生。computeFoldKey 的格式语义保持不变，只要求传入已归属的 owner。
//
// - foldState      : foldKey -> boolean（true=展开；显式记录用户选择）
// - foldDefault    : owner -> 该节点「全部展开/收起」兜底默认（收起后才渲染出的嵌套折叠也跟随）
// - foldKeysByNode : owner -> 当前已渲染/登记的折叠 key 集合（只读层「全部展开/收起」枚举）
//
// 变更后 notifyFolds() 通知订阅者（编辑态 node-view 用它同步刷新）；只读层自身走 useReducer 重渲染。

import { viewStateKey, viewStateScopePrefix } from './viewStateScope.js';

const foldState = new Map();
const foldDefault = new Map();
const foldKeysByNode = new Map();

const listeners = new Set();

/** 通知折叠态变化（编辑态 node-view 订阅后重渲染）。 */
export function notifyFolds() {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch (err) {
      /* 单个订阅者异常不影响其余 */
    }
  });
}

/** 订阅折叠态变化，返回取消订阅函数。 */
export function subscribeFolds(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// 原型 foldSlug（index.html:1145-1147）
export function foldSlug(title) {
  return (
    String(title || '')
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^\w\u4e00-\u9fa5-]/g, '') || 'fold'
  );
}

// 原型 foldFirstLine（index.html:1148-1152）
export function foldFirstLine(text) {
  const line =
    String(text || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)[0] || '';
  return line
    .replace(/^[#>*\-\s`|]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 该 owner 下折叠 key 的前缀：`<scope>\0<nodeId>::`。 */
export function foldPrefixFor(scope, nodeId) {
  return `${viewStateKey(scope, nodeId)}::`;
}

/** 只读层直接构造折叠 key（occurrence 已是 1 基计数）；格式与 computeFoldKey 一致。 */
export function foldKeyFor(scope, nodeId, slug, occurrence) {
  return `${foldPrefixFor(scope, nodeId)}${slug}#${occurrence}`;
}

const assertFoldKey = (scope, nodeId, key) => {
  const prefix = foldPrefixFor(scope, nodeId);
  if (typeof key !== 'string' || !key.startsWith(prefix)) {
    throw new TypeError('fold key does not belong to the given view scope + nodeId');
  }
  return key;
};

/** 读取显式折叠条目：显式存在时返回 boolean，否则 undefined。 */
export function getFoldEntry(scope, nodeId, key) {
  return foldState.get(assertFoldKey(scope, nodeId, key));
}

/** 写入显式折叠条目（不广播；调用方按批/按需 notifyFolds）。 */
export function setFoldEntry(scope, nodeId, key, open) {
  foldState.set(assertFoldKey(scope, nodeId, key), !!open);
}

/** 删除显式折叠条目（不广播）；返回是否实际删除。 */
export function deleteFoldEntry(scope, nodeId, key) {
  return foldState.delete(assertFoldKey(scope, nodeId, key));
}

/** 读取折叠展开态：显式态优先，其次节点级兜底默认（只读层默认收起）。 */
export function isFoldOpen(scope, nodeId, key) {
  const owner = viewStateKey(scope, nodeId);
  const entryKey = assertFoldKey(scope, nodeId, key);
  if (foldState.has(entryKey)) return foldState.get(entryKey) === true;
  return foldDefault.get(owner) === true;
}

/** 写入折叠展开态并广播。 */
export function setFoldOpen(scope, nodeId, key, open) {
  setFoldEntry(scope, nodeId, key, open);
  notifyFolds();
}

/** 读取节点级「全部展开/收起」兜底默认：未记录 → undefined。 */
export function getFoldDefault(scope, nodeId) {
  return foldDefault.get(viewStateKey(scope, nodeId));
}

/** 写入节点级「全部展开/收起」兜底默认（不广播）。 */
export function setFoldDefault(scope, nodeId, open) {
  foldDefault.set(viewStateKey(scope, nodeId), !!open);
}

/** 读取该节点本轮已登记的折叠 key 集合：未登记 → undefined。 */
export function getFoldKeys(scope, nodeId) {
  return foldKeysByNode.get(viewStateKey(scope, nodeId));
}

/** 登记该节点本轮已渲染的折叠 key 集合（不广播）。 */
export function setFoldKeys(scope, nodeId, keys) {
  foldKeysByNode.set(viewStateKey(scope, nodeId), keys);
}

/** 该 owner 是否还有显式收起（false）的折叠条目。 */
export function hasCollapsedFold(scope, nodeId) {
  const prefix = foldPrefixFor(scope, nodeId);
  for (const [key, value] of foldState) {
    if (key.startsWith(prefix) && value === false) return true;
  }
  return false;
}

/** 批量写入显式折叠条目（不广播；用于编辑态「全部展开/收起」）。 */
export function setFoldsOpen(scope, nodeId, keys, open) {
  viewStateKey(scope, nodeId);
  for (const key of keys) foldState.set(assertFoldKey(scope, nodeId, key), !!open);
}

/** 清除该 owner 的显式折叠条目（保留节点级默认与登记集合；不广播）。 */
export function clearFoldStateForNode(scope, nodeId) {
  const prefix = foldPrefixFor(scope, nodeId);
  Array.from(foldState.keys()).forEach((key) => {
    if (key.startsWith(prefix)) foldState.delete(key);
  });
}

/** 节点身份迁移（改名/提升）：同一 scope 内折叠键、默认态、已登记键集合跟随 nodeId。 */
export function rekeyFoldsForNode(scope, oldNodeId, newNodeId) {
  const fromOwner = viewStateKey(scope, oldNodeId);
  const toOwner = viewStateKey(scope, newNodeId);
  if (fromOwner === toOwner) return;
  const fromPrefix = `${fromOwner}::`;
  const toPrefix = `${toOwner}::`;
  Array.from(foldState.keys()).forEach((key) => {
    if (!key.startsWith(fromPrefix)) return;
    const next = `${toPrefix}${key.slice(fromPrefix.length)}`;
    foldState.set(next, foldState.get(key));
    foldState.delete(key);
  });
  if (foldDefault.has(fromOwner)) {
    foldDefault.set(toOwner, foldDefault.get(fromOwner));
    foldDefault.delete(fromOwner);
  }
  if (foldKeysByNode.has(fromOwner)) {
    const keys = foldKeysByNode.get(fromOwner);
    const nextKeys = new Set(
      Array.from(keys || []).map((key) =>
        typeof key === 'string' && key.startsWith(fromPrefix)
          ? `${toPrefix}${key.slice(fromPrefix.length)}`
          : key
      )
    );
    foldKeysByNode.set(toOwner, nextKeys);
    foldKeysByNode.delete(fromOwner);
  }
  notifyFolds();
}

/** 清理某节点残留的折叠态（内容变化/节点重建时调用）。 */
export function clearFoldsForNode(scope, nodeId) {
  const owner = viewStateKey(scope, nodeId);
  clearFoldStateForNode(scope, nodeId);
  foldDefault.delete(owner);
  foldKeysByNode.delete(owner);
}

/**
 * 关闭标签页时清理该 tab 的全部折叠态；其它 tab 的同名 nodeId 不受影响。
 * 仅按 `<scope>\0` 前缀删除，绝不按裸 nodeId 删除。
 */
export function clearFoldScope(scope) {
  const prefix = viewStateScopePrefix(scope);
  let changed = false;
  const wipe = (map) => {
    Array.from(map.keys()).forEach((key) => {
      if (!key.startsWith(prefix)) return;
      map.delete(key);
      changed = true;
    });
  };
  wipe(foldState);
  wipe(foldDefault);
  wipe(foldKeysByNode);
  if (changed) notifyFolds();
}
