// 光标桥（Caret Bridge）：模块级单例。
// 注册表记录当前「插入目标」——正在就地编辑的文本位置（节点编辑器 / 名称 / 字段）。
// 侧栏的「+」/「插入路径」等动作通过 caretBridge.insert(text) 把文本送到光标处，
// 图片走 caretBridge.insertImage({ src, alt })（仅节点编辑器支持）。
//
// target 形如：{ kind: 'node' | 'name' | 'field', label, insert(text), insertImage?(spec) }
// - kind 'node'：编辑态节点编辑器（阶段 5 挂载时调用 registerNodeEditor 注册）
// - kind 'name' / 'field'：AgentNode 的 inline 输入（focus 注册 / 失焦·提交注销）
//
// 图片插入器：MilkdownHost 挂载时用 setImageInserter(fn) 登记「编辑器级」插入能力；
// 这样即便 AgentNode 用 legacy 的 registerNodeEditor(label, insertFn) 重新注册 target
// （inline 输入失焦后会重建 target），target 上依然带 insertImage。
//
// 订阅：App 状态栏需要跟随 target 变化，用 subscribe(fn) 获取通知。

const listeners = new Set();

function emit() {
  listeners.forEach((fn) => {
    try {
      fn(caretBridge.target);
    } catch (err) {
      /* 单个订阅者异常不影响其余 */
    }
  });
}

export const caretBridge = {
  /** 当前插入目标（null 表示无） */
  target: null,

  /** 当前编辑会话的图片插入器（由 MilkdownHost 挂载/卸载时设置） */
  _imageInserter: null,

  /**
   * 登记/清除「当前编辑会话」的图片插入器（MilkdownHost 挂载时登记、卸载时清空）。
   * 之后用 registerNodeEditor 注册的节点目标都会自动带上 insertImage；
   * 但源码模式 textarea 等「伪 node」目标（registerInputTarget）不会 —— 它们没有
   * image 节点语义，插进去也会被源码回写覆盖。
   */
  setImageInserter(fn) {
    this._imageInserter = typeof fn === 'function' ? fn : null;
    // 编辑器卸载后，旧 target 上的 insertImage 已经指向被销毁的 view；
    // 立即摘掉，避免侧栏在下次挂载前误插到死编辑器。
    if (!this._imageInserter && this.target && this.target.kind === 'node') {
      try {
        delete this.target.insertImage;
      } catch (err) {
        /* ignore */
      }
    }
  },

  /** 注册/替换插入目标，并通知订阅者（insert 必需） */
  set(t) {
    this.target = t && typeof t.insert === 'function' ? t : null;
    emit();
  },

  /** 注销插入目标（仅在当前存在时通知，避免无谓渲染） */
  clear() {
    if (this.target === null) return;
    this.target = null;
    emit();
  },

  /** 把文本插入当前目标；无目标返回 false（由调用方给出提示） */
  insert(text) {
    if (!this.target || typeof this.target.insert !== 'function') return false;
    this.target.insert(String(text == null ? '' : text));
    return true;
  },

  /**
   * 把图片（内联 data URI）插入当前目标。
   * 目标缺失或目标不支持图片（inline 输入框 / 源码 textarea）返回 false，由调用方给提示。
   */
  insertImage(spec) {
    const t = this.target;
    if (!t || typeof t.insertImage !== 'function') return false;
    t.insertImage(spec);
    return true;
  },

  /** 订阅 target 变化，返回取消订阅函数 */
  subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

/**
 * 用 input/textarea 的 native value setter 写入值，再派发 input 事件，
 * 让 React 受控组件感知到这次程序化修改（绕过 value tracker 的“无变化”判定）。
 */
function setNativeValue(el, value) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) desc.set.call(el, value);
  else el.value = value;
}

/**
 * 在输入框光标处插入文本（替换选中区），保持光标在插入内容之后。
 * 与原型 insertIntoInput 行为一致。
 */
export function insertIntoInput(el, text) {
  if (!el) return;
  el.focus();
  const v = typeof el.value === 'string' ? el.value : '';
  let start = typeof el.selectionStart === 'number' ? el.selectionStart : v.length;
  let end = typeof el.selectionEnd === 'number' ? el.selectionEnd : start;
  if (start > v.length) start = v.length;
  if (end > v.length) end = v.length;
  setNativeValue(el, v.slice(0, start) + text + v.slice(end));
  const pos = start + text.length;
  try {
    el.setSelectionRange(pos, pos);
  } catch (err) {
    /* 某些 input 不支持 selectionRange */
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** 为 inline 输入构造并设置 target（focus 时调用）。 */
export function registerInputTarget(el, kind, label) {
  caretBridge.set({
    kind,
    label,
    insert: (text) => insertIntoInput(el, text),
  });
}

/**
 * kind:'node' 的编辑器注册接口。
 * 阶段 5 的 MilkdownHost 挂载编辑会话时调用：
 *   const unregister = registerNodeEditor('节点「X」内容', { insert: (t) => ..., insertImage: (spec) => ... });
 * 也兼容 legacy 形式：
 *   const unregister = registerNodeEditor('节点「X」内容', (text) => editor.insert(text));
 * 退出编辑会话时调用返回的 unregister。
 */
export function registerNodeEditor(label, apiOrInsert) {
  const spec = apiOrInsert && typeof apiOrInsert === 'object' ? apiOrInsert : null;
  const insert = spec ? spec.insert : apiOrInsert;
  const target = { kind: 'node', label, insert };
  const insertImage =
    spec && typeof spec.insertImage === 'function' ? spec.insertImage : caretBridge._imageInserter;
  if (typeof insertImage === 'function') target.insertImage = insertImage;
  caretBridge.set(target);
  return () => {
    if (caretBridge.target === target) caretBridge.clear();
  };
}
