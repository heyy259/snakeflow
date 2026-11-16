// 选区浮条（需求 8）：非空选区上方的包裹/前缀片段气泡。
//
// 逻辑参照原型 positionSelBubble（:3410-3531）：
//   - 自写 PM plugin 判定非空选区（view.update / DOM focus·blur）
//   - view.coordsAtPos 定位（选区首尾并集）+ 视口夹取 + 上方不足翻下方
//   - 100ms 防抖；应用后 500ms 抑制弹回
//   - 编辑/自定义两簇各 ≤4 + 组「⋯」；尾部「＋ 存为片段」（名字预填选区前 2 字）

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { bubbleSnippetGroups, snippetTypeLabel } from './snippetData.js';
import { pushEsc } from '../escStack.js';
import { SnippetMoreMenu, SnippetContextMenu } from '../SnippetChips.jsx';
import SnippetForm from '../SnippetForm.jsx';

const BUBBLE_GROUP_CAP = 4;

export default function SelBubble({ editorApi, snippets, selInfo, onApply, onDelete, onAddSnippet, onNotify }) {
  const bubbleRef = useRef(null);
  const timerRef = useRef(null);
  const suppressRef = useRef(0);
  const [visible, setVisible] = useState(false);
  const [rect, setRect] = useState(null);
  const [pos, setPos] = useState(null);
  const [more, setMore] = useState(null);
  const [ctx, setCtx] = useState(null);
  const [saveAnchor, setSaveAnchor] = useState(null);

  // 100ms 防抖 + 500ms 抑制（对齐原型 scheduleSelBubble / selBubbleSuppressUntil）。
  useEffect(() => {
    clearTimeout(timerRef.current);
    if (!editorApi || !selInfo || selInfo.empty) {
      setVisible(false);
      return undefined;
    }
    timerRef.current = setTimeout(() => {
      if (Date.now() < suppressRef.current) return;
      const r = editorApi.selectionRect?.();
      if (!r) return;
      setRect(r);
      setVisible(true);
    }, 100);
    return () => clearTimeout(timerRef.current);
  }, [selInfo, editorApi]);

  // 定位：上方放不下翻下方 + 视口夹取（原型 positionSelBubble :3476）。
  useLayoutEffect(() => {
    if (!visible || !rect) {
      setPos(null);
      return;
    }
    const el = bubbleRef.current;
    if (!el) return;
    const margin = 8;
    const bw = el.offsetWidth;
    const bh = el.offsetHeight;
    let below = false;
    let top = rect.top - bh - margin;
    if (top < margin) {
      top = rect.bottom + margin;
      below = true;
    }
    let left = rect.left + rect.width / 2 - bw / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - bw - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - bh - margin));
    setPos({ left, top, below });
  }, [visible, rect, snippets]);

  const hide = () => {
    setVisible(false);
    setMore(null);
    setCtx(null);
  };

  // Esc：浮条可见时注册（⋯/右键内层菜单会注册更晚 → 优先消费）。不可见时不占栈。
  useEffect(() => {
    if (!visible) return undefined;
    return pushEsc(hide);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // 外部点击 / 滚动隐藏（菜单与弹层挂 body，不算外部）。
  useEffect(() => {
    if (!visible) return undefined;
    const onDown = (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (bubbleRef.current?.contains(t)) return;
      if (t.closest('.snip-more-menu, .context-menu, .snip-popover')) return;
      hide();
    };
    const onScroll = () => hide();
    const onResize = () => {
      const r = editorApi?.selectionRect?.();
      if (r) setRect(r);
      else hide();
    };
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, editorApi]);

  const applyIndex = (i) => {
    suppressRef.current = Date.now() + 500;
    hide();
    onApply(i);
  };

  const groups = bubbleSnippetGroups(snippets);

  const chipHTML = (arr) =>
    arr.map((w) => (
      <span
        key={w.i}
        className="snip-chip"
        data-bsnip={w.i}
        title={snippetTypeLabel(w.s.text) + '：' + String(w.s.text).replace(/\n/g, '⏎')}
        onClick={() => applyIndex(w.i)}
      >
        {w.s.name}
      </span>
    ));

  const groupMore = (arr, group) => {
    const n = arr.length - BUBBLE_GROUP_CAP;
    if (n <= 0) return null;
    return (
      <button
        type="button"
        className={'sel-bubble-more' + (more && more.group === group ? ' is-open' : '')}
        data-bsnip-more={group}
        title={'该组还有 ' + n + ' 个（双击展开项应用）'}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation();
          if (more && more.group === group) {
            setMore(null);
            return;
          }
          setMore({ group, el: e.currentTarget, indices: arr.slice(BUBBLE_GROUP_CAP).map((x) => x.i) });
        }}
      >
        ⋯
      </button>
    );
  };

  const openSave = () => {
    const text = editorApi?.getSelectionText?.() || '';
    const firstTwo = Array.from(text.trim()).slice(0, 2).join('') || '片段';
    suppressRef.current = Date.now() + 500;
    const anchor = bubbleRef.current?.getBoundingClientRect();
    hide();
    setSaveAnchor({ rect: anchor, name: firstTwo, content: text });
  };

  return (
    <>
      {createPortal(
        <div
          className={'sel-bubble' + (visible && pos ? ' show' : '') + (pos?.below ? ' below' : '')}
          ref={bubbleRef}
          style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0 }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {groups.builtin.length > 0 && (
            <>
              <span className="snip-label">编辑</span>
              {chipHTML(groups.builtin.slice(0, BUBBLE_GROUP_CAP))}
              {groupMore(groups.builtin, 'builtin')}
            </>
          )}
          {groups.user.length > 0 && (
            <>
              {groups.builtin.length > 0 && <span className="snip-bubble-sep" />}
              <span className="snip-label">自定义</span>
              {chipHTML(groups.user.slice(0, BUBBLE_GROUP_CAP))}
              {groupMore(groups.user, 'user')}
            </>
          )}
          <span className="snip-chip snip-save" data-bsave="1" title="把选中文本存为片段" onClick={openSave}>
            ＋ 存为片段
          </span>
        </div>,
        document.body
      )}

      {more && (
        <SnippetMoreMenu
          anchorEl={more.el}
          snippets={snippets}
          indices={more.indices}
          onApply={(i) => {
            setMore(null);
            applyIndex(i);
          }}
          onDelete={onDelete}
          onNotify={(act) => {
            if (act === 'close') setMore(null);
          }}
        />
      )}

      {ctx && (
        <SnippetContextMenu
          x={ctx.x}
          y={ctx.y}
          snippets={snippets}
          index={ctx.index}
          onDelete={onDelete}
          onClose={() => setCtx(null)}
          onNotify={onNotify}
        />
      )}

      {saveAnchor && (
        <SnippetForm
          variant="popover"
          anchorRect={saveAnchor.rect}
          title="存为片段"
          name={saveAnchor.name}
          content={saveAnchor.content}
          focusName
          onError={(msg) => onNotify?.(msg, 'warn')}
          onCancel={() => {
            setSaveAnchor(null);
            editorApi?.restoreSelection?.();
          }}
          onSave={(v) => {
            setSaveAnchor(null);
            onAddSnippet?.(v.name, v.content, true);
            editorApi?.restoreSelection?.();
          }}
        />
      )}
    </>
  );
}
