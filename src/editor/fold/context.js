// 编辑态折叠上下文的模块级单例。
// 同一时刻至多一个编辑会话（App 的 editingNodeId 保证），故用模块级变量把 nodeId
// 传给 fold node-view，避免为纯展示信息引入一套 ctx slice。

let current = { nodeId: '', viewScope: '' };

export function setFoldContext(next) {
  current = { ...current, ...(next || {}) };
}

export function getFoldContext() {
  return current;
}

export function resetFoldContext() {
  current = { nodeId: '', viewScope: '' };
}
