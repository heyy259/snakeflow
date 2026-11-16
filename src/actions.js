// App 每次渲染时把最新回调挂进来，避免把函数写进可序列化的 node/edge data。
export const nodeActions = {
  onEditText: null,
  onEditField: null,
  onAddField: null,
  onRemoveField: null,
  onResetSize: null,
  onResize: null,
  onDelete: null,
  // 编辑器骨架（阶段 5）
  onEditContent: null, // (id) 进入节点内容就地编辑
  onExitEdit: null, // (commit) 退出当前编辑会话
  onEditContentText: null, // (id, text) 直写 data.content（不 trim / 不 pushHistory）
  onEditorReady: null, // (api) 编辑器挂载后把命令出口交给 App
  // 片段体系（阶段 7 / 需求 8）
  onSnippetsChange: null, // (next[]) 覆盖片段数组（拖序 / 显隐 / 编辑）
  onAddSnippet: null, // (name, text, flash) 新增用户片段
  onDeleteSnippet: null, // (index) 删除用户片段（内置受保护）
  onOpenSnippetLib: null, // () 打开片段库弹窗
  onNotify: null, // (text, kind) Toast/状态栏提示
  // 期 6：扫描动作（start/pause/resume/stop/setpos/rescan）
  onScanAction: null, // (id, action, payload)
  // 期 7：进程动作（绑定在线 → 真实 RPC；未绑定禁用）
  onSendInput: null, // (nodeId, processName, text) 真实 tool.send_input
  onStopProcess: null, // (nodeId, processName) 真实 tool.stop_process
};

export const edgeActions = {
  onEdit: null,
  onEditLabel: null,
  onEditCancel: null,
  onDelete: null,
};
