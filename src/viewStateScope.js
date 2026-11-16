// 视图态归属（owner scope）的共享键助手。
//
// pageState / foldState / historyCache 都是模块级内存 Map，但**不是全局唯一**：同一个 SE 流节点
// id（`s-<streamName>`）不带系统身份，两个标签页可以同时渲染同名流。若只按 nodeId 建键，两个
// tab 的页码 / 折叠态 / 历史页会互相覆盖。因此所有键统一为 `<scope>\0<nodeId>`：
// - scope  = 渲染该节点的标签页 id（tab-owned），不持久化；
// - nodeId = 画布节点 id；
// - `\0`   = NUL，不会出现在 tab id / 节点 id / 折叠 slug 中，避免分隔符碰撞。
//
// 该模块必须保持纯 Node 可导入（无 React / DOM），供 src/pageState.js、src/foldState.js 与
// Node 单测直接复用。所有 API 都要求显式 scope，缺省即抛错，绝不静默回退到未归属键。

/** scope 与 nodeId 之间的分隔符。NUL 不可能出现在正常 id 中。 */
export const VIEW_STATE_SEPARATOR = '\u0000';

const required = (value, label) => {
  if (value == null) throw new TypeError(`${label} is required for view-scoped state`);
  const str = String(value);
  if (str === '') throw new TypeError(`${label} must be non-empty for view-scoped state`);
  return str;
};

/** 归属键：`<scope>\0<nodeId>`。scope / nodeId 任一缺失都抛 TypeError。 */
export function viewStateKey(scope, nodeId) {
  return `${required(scope, 'view scope')}${VIEW_STATE_SEPARATOR}${required(nodeId, 'nodeId')}`;
}

/** 某个 scope 的全部键前缀：`<scope>\0`（用于关闭标签页时按 tab 清理）。 */
export function viewStateScopePrefix(scope) {
  return `${required(scope, 'view scope')}${VIEW_STATE_SEPARATOR}`;
}
