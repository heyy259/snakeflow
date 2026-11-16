// Esc 层级栈：供片段库 / ⋯菜单 / 右键菜单 / 选区浮条注册「Esc 关闭」处理器。
// App 的全局 Esc（捕获阶段）优先调用栈顶处理器；无人消费时才退出编辑会话。
// 对齐升级改造方案 §4.2/§4.3 的 Esc 级联：
//   片段库 → ⋯菜单 → 右键菜单 → 选区浮条 → 退出编辑

const handlers = [];

/** 注册处理器，返回取消函数。 */
export function pushEsc(fn) {
  if (typeof fn !== 'function') return () => {};
  handlers.push(fn);
  return () => popEsc(fn);
}

/** 移除指定处理器（重复注册时移除最后一个）。 */
export function popEsc(fn) {
  const i = handlers.lastIndexOf(fn);
  if (i >= 0) handlers.splice(i, 1);
}

/** 调用栈顶处理器；消费返回 true，栈空返回 false。 */
export function runTopEsc() {
  if (!handlers.length) return false;
  const fn = handlers[handlers.length - 1];
  try {
    fn();
  } catch (err) {
    console.warn('Esc 处理器异常', err);
  }
  return true;
}
