// 片段表单：名字 + 内容（两字段）+ 占位符提示行。
// 三种挂载：库内内联（variant='inline'）、节点工具栏 ＋ 弹层、选区浮条「存为片段」弹层
// （后两者 variant='popover'，锚定 rect 并做视口夹取，对齐原型 openSnipPopover :3571）。
// Esc 走 escStack（顶层消费）：取消当前表单而不退出编辑会话。

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { pushEsc } from './escStack.js';

const HINT =
  '内容中 {sel}=选中文本，{sel:N}=头N字；纯"前缀{sel}"=逐行前缀；含占位符即作用于选区';

export default function SnippetForm({
  variant = 'inline',
  anchorRect,
  title,
  name: initialName = '',
  content: initialContent = '',
  focusName = false,
  onSave,
  onCancel,
  onError,
}) {
  const [name, setName] = useState(initialName);
  const [content, setContent] = useState(initialContent);
  const nameRef = useRef(null);
  const rootRef = useRef(null);

  useEffect(() => pushEsc(() => onCancel?.()), [onCancel]);

  useEffect(() => {
    if (!focusName) return;
    const el = nameRef.current;
    if (el) {
      el.focus();
      try {
        el.select();
      } catch (err) {
        /* ignore */
      }
    }
  }, [focusName]);

  // 弹层定位：默认锚点下方，空间不足翻上；横向/纵向视口夹取。
  useLayoutEffect(() => {
    if (variant !== 'popover' || !anchorRect) return;
    const el = rootRef.current;
    if (!el) return;
    const margin = 8;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = anchorRect.left + anchorRect.width / 2 - w / 2;
    let top = anchorRect.bottom + 8;
    if (top + h > window.innerHeight - margin) top = Math.max(margin, anchorRect.top - h - 8);
    left = Math.max(margin, Math.min(left, window.innerWidth - w - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - h - margin));
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }, [variant, anchorRect]);

  const confirm = () => {
    const n = name.trim();
    if (!n) {
      onError?.('名字不能为空');
      nameRef.current?.focus();
      return;
    }
    if (!content.trim()) {
      onError?.('内容不能为空');
      return;
    }
    onSave?.({ name: n, content });
  };

  const className =
    variant === 'popover'
      ? 'snip-form snip-popover'
      : variant === 'inline'
        ? 'snip-form inline'
        : 'snip-form';

  const body = (
    <div
      ref={rootRef}
      className={className}
      style={variant === 'popover' ? { left: 0, top: 0 } : undefined}
      onMouseDown={(e) => {
        // 表单内部不触发外层工具栏/浮条的 preventDefault 保护，避免影响输入
        e.stopPropagation();
      }}
    >
      {title ? <div className="snip-form-title">{title}</div> : null}
      <label className="snip-field">
        <span className="snip-field-label">名字</span>
        <input
          ref={nameRef}
          type="text"
          data-snip-name="1"
          placeholder="片段名字"
          spellCheck={false}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              confirm();
            }
          }}
        />
      </label>
      <label className="snip-field">
        <span className="snip-field-label">内容</span>
        <textarea
          data-snip-content="1"
          rows={4}
          placeholder="文本内容（可多行）"
          spellCheck={false}
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
      </label>
      <div className="snip-hint">{HINT}</div>
      <div className="snip-form-row">
        <button type="button" className="primary" data-snip-ok="1" onClick={confirm}>
          确定
        </button>
        <button type="button" data-snip-cancel="1" onClick={() => onCancel?.()}>
          取消
        </button>
      </div>
    </div>
  );

  return variant === 'popover' ? createPortal(body, document.body) : body;
}
