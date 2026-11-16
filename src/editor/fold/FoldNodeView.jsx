// `details_fold` 的 React node-view。
//
// 结构（dom 手工搭建，仅 chrome 交给 React，contentDOM 由 ProseMirror 独占）：
//   div.md-fold.md-fold-edit
//     div.md-fold-chrome               <- React：头部 + 可编辑 summary 行 + 溶解
//     div.md-fold-body (contentDOM)    <- PM 正文
//
// 交互对齐原型 §4.4：
//   - header contentEditable=false + mousedown preventDefault + click 切换收展（不夺焦）
//   - 收起时 body display:none（CSS .collapsed），且光标在 body 内时移到块后
//   - summary 行可编辑并实时映射 node.attrs.summary
//   - 溶解：unwrap 节点，summary + 正文提升为普通块，内容零丢失
//   - 展开态与只读显示层共享同一内存 Map（key = nodeId::slug#occ）

import { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Fragment } from '@milkdown/kit/prose/model';
import { TextSelection } from '@milkdown/kit/prose/state';
import { subscribeFolds, notifyFolds, foldFirstLine, getFoldEntry, setFoldEntry, deleteFoldEntry, setFoldOpen } from '../../foldState.js';
import { viewStateKey } from '../../viewStateScope.js';
import { foldTitle, foldBodyText, computeFoldKey } from './patterns.js';

function Chrome({ node, onToggle, onSummaryInput, onDissolve }) {
  const collapsed = !!node.attrs.collapsed;
  const summary = String(node.attrs.summary || '');
  const bodyText = foldBodyText(node);
  const title = foldTitle(node);
  const preview = foldFirstLine(bodyText).slice(0, 20);
  const count = bodyText.replace(/\s+/g, '').length;
  const sumRef = useRef(null);

  // summary 受控回写：仅在不处于聚焦时覆盖，避免打断输入/重置光标。
  useEffect(() => {
    const el = sumRef.current;
    if (!el) return;
    if (el === document.activeElement || el.contains(document.activeElement)) return;
    if (el.textContent !== summary) el.textContent = summary;
  });

  return (
    <>
      <div
        className="md-fold-sum"
        contentEditable={false}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onToggle();
        }}
      >
        <span className="md-fold-caret" />
        <span className="md-fold-title">{title}</span>
        {collapsed && preview ? <span className="md-fold-preview"> · {preview}…</span> : null}
        <span className="md-fold-meta"> (约 {count} 字)</span>
        <button
          type="button"
          className="md-fold-tool"
          title="溶解：去掉折叠结构，标题与正文提升为普通块（内容零丢失）"
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDissolve();
          }}
        >
          溶解
        </button>
      </div>
      <div
        className="md-fold-summary-line"
        contentEditable
        suppressContentEditableWarning
        ref={sumRef}
        data-placeholder="折叠标题"
        onInput={onSummaryInput}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.preventDefault();
        }}
        onMouseDown={(e) => e.stopPropagation()}
      />
    </>
  );
}

export function createFoldNodeView({ nodeId, viewScope }) {
  return function foldNodeView(initialNode, view, getPos) {
    const owner = viewStateKey(viewScope, nodeId);
    const dom = document.createElement('div');
    dom.className = 'md-fold md-fold-edit';
    const chrome = document.createElement('div');
    chrome.className = 'md-fold-chrome';
    const contentDOM = document.createElement('div');
    contentDOM.className = 'md-fold-body';
    dom.append(chrome, contentDOM);

    const root = createRoot(chrome);
    let currentNode = initialNode;
    let currentKey = computeFoldKey(view.state.doc, safePos(), initialNode, owner);
    let destroyed = false;

    function safePos() {
      try {
        return getPos();
      } catch (err) {
        return null;
      }
    }

    function isOpen() {
      const explicit = getFoldEntry(viewScope, nodeId, currentKey);
      if (explicit !== undefined) return explicit === true;
      return !currentNode.attrs.collapsed;
    }

    function apply() {
      if (destroyed) return;
      const open = isOpen();
      dom.classList.toggle('collapsed', !open);
      dom.setAttribute('data-fold-key', currentKey.replace(/^.*?::/, ''));
      root.render(
        <Chrome
          node={currentNode}
          onToggle={handleToggle}
          onSummaryInput={handleSummaryInput}
          onDissolve={handleDissolve}
        />
      );
    }

    function handleToggle() {
      const pos = safePos();
      const open = !isOpen();
      // 收起且光标在正文内 → 移到块后（原型 setEditFoldCollapsed :1946-1951）
      if (!open && pos != null && view.state) {
        const sel = view.state.selection;
        const from = pos + 1;
        const to = pos + currentNode.nodeSize - 1;
        if (sel.from >= from && sel.to <= to) {
          try {
            const after = pos + currentNode.nodeSize;
            view.dispatch(
              view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(after), 1))
            );
          } catch (err) {
            /* 光标迁移失败不影响收展 */
          }
        }
      }
      setFoldOpen(viewScope, nodeId, currentKey, open);
    }

    function handleSummaryInput(e) {
      const pos = safePos();
      if (pos == null) return;
      const text = String(e.currentTarget.textContent || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\n+/g, ' ');
      const node = view.state.doc.nodeAt(pos);
      if (!node || node.type.name !== 'details_fold') return;
      if (String(node.attrs.summary || '') === text) return;
      view.dispatch(
        view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, summary: text, edited: true })
      );
    }

    function handleDissolve() {
      const pos = safePos();
      if (pos == null) return;
      const node = view.state.doc.nodeAt(pos);
      if (!node || node.type.name !== 'details_fold') return;
      const schema = view.state.schema;
      const blocks = [];
      const summary = String(node.attrs.summary || '').trim();
      if (summary) {
        blocks.push(schema.nodes.paragraph.create(null, schema.text(summary)));
      }
      node.content.forEach((child) => blocks.push(child));
      if (!blocks.length) blocks.push(schema.nodes.paragraph.create());
      try {
        view.dispatch(
          view.state.tr.replaceWith(pos, pos + node.nodeSize, Fragment.fromArray(blocks))
        );
      } catch (err) {
        console.warn('溶解折叠块失败', err);
        return;
      }
      deleteFoldEntry(viewScope, nodeId, currentKey);
      notifyFolds();
    }

    const unsubscribe = subscribeFolds(apply);
    apply();

    return {
      dom,
      contentDOM,
      update(updatedNode) {
        if (!updatedNode || updatedNode.type !== currentNode.type) return false;
        const contentChanged = !updatedNode.content.eq(currentNode.content);
        currentNode = updatedNode;
        const nextKey = computeFoldKey(view.state.doc, safePos(), updatedNode, owner);
        if (nextKey !== currentKey) {
          const value = getFoldEntry(viewScope, nodeId, currentKey);
          if (value !== undefined) {
            deleteFoldEntry(viewScope, nodeId, currentKey);
            setFoldEntry(viewScope, nodeId, nextKey, value);
          }
          currentKey = nextKey;
        }
        // 正文被改动 → 打 edited 标记（序列化改走重建路径）。微任务延后，避开视图更新周期。
        if (contentChanged && !updatedNode.attrs.edited) {
          queueMicrotask(() => {
            if (destroyed) return;
            const p = safePos();
            if (p == null) return;
            const cur = view.state.doc.nodeAt(p);
            if (cur && cur.type.name === 'details_fold' && !cur.attrs.edited) {
              view.dispatch(
                view.state.tr.setNodeMarkup(p, undefined, { ...cur.attrs, edited: true })
              );
            }
          });
        }
        apply();
        return true;
      },
      stopEvent(event) {
        return !contentDOM.contains(event.target);
      },
      ignoreMutation(mutation) {
        return !contentDOM.contains(mutation.target);
      },
      destroy() {
        destroyed = true;
        unsubscribe();
        try {
          root.unmount();
        } catch (err) {
          /* ignore */
        }
        dom.remove();
      },
    };
  };
}
