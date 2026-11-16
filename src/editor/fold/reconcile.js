// 折叠块构建与原子删除（对应原型 reconcile/buildFolds/原子删除 §4.4）。
//
//  - foldInputRule : `</details>` 行尾命中 → 文本区间替换为 details_fold 节点（单段完整结构）
//  - foldReconcile : appendTransaction 兜多段输入 / 粘贴场景；只在完整配对时构建，否则保持纯文本
//  - foldKeymap    : Backspace/Delete 命中相邻 collapsed fold → 整节点原子删除
//
// 所有构建入口都用 buildFoldNode 统一解析；不完整/交错/嵌套结构返回 null（降级纯文本）。
// IME 组合中（view.composing）reconcile 不触发；input rule 由 ProseMirror 自身在组合期跳过。

import { $prose, $inputRule } from '@milkdown/kit/utils';
import { editorViewCtx, remarkCtx, schemaCtx } from '@milkdown/kit/core';
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import { InputRule } from '@milkdown/kit/prose/inputrules';
import { Fragment } from '@milkdown/kit/prose/model';
import { ParserState } from '@milkdown/kit/transformer';
import {
  DETAILS_OPEN_STRICT,
  DETAILS_CLOSE_STRICT,
  DETAILS_COMPACT,
  parseDetailsText,
} from './patterns.js';

/** 由原始 `<details>` 文本构建 PM 折叠节点；不合法返回 null。 */
function buildFoldNode(ctx, raw, collapsed) {
  const parsed = parseDetailsText(raw);
  if (!parsed) return null;
  const schema = ctx.get(schemaCtx);
  const remark = ctx.get(remarkCtx);
  const foldType = schema.nodes.details_fold;
  if (!foldType) return null;

  let content = Fragment.empty;
  if (parsed.bodyRaw) {
    try {
      const doc = ParserState.create(schema, remark)(parsed.bodyRaw);
      content = doc.content;
    } catch (err) {
      console.warn('折叠正文解析失败，降级空正文', err);
      content = Fragment.empty;
    }
  }

  const attrs = {
    raw: parsed.raw,
    open: parsed.open,
    close: parsed.close,
    summary: parsed.summaryText,
    summaryRaw: parsed.summary,
    summaryText: parsed.summaryText,
    bodyRaw: parsed.bodyRaw,
    collapsed: !!collapsed,
    edited: false,
  };
  try {
    return foldType.create(attrs, content.size ? content : null);
  } catch (err) {
    console.warn('构建折叠节点失败', err);
    return null;
  }
}

// 块的纯文本，含 inline html atom 的 value（供识别被包进 paragraph 的 html 残留）
function blockText(node) {
  if (!node) return '';
  if (node.type.name === 'html') return String(node.attrs.value || '');
  if (node.isText) return node.text || '';
  if (node.type.name === 'hardbreak') return '\n';
  if (node.isLeaf) return '';
  let s = '';
  node.forEach((child) => {
    s += blockText(child);
  });
  return s;
}

// 从 parent.child(index)（绝对位置 pos）起尝试匹配一个完整 details 段。
function tryBuildAt(parent, index, pos) {
  const first = parent.child(index);
  if (!first || first.type.name !== 'paragraph') return null;
  const firstText = blockText(first);
  const firstTrim = firstText.trim();

  // 单段紧凑 <details>x</details>
  if (DETAILS_COMPACT.test(firstTrim)) {
    const parsed = parseDetailsText(firstTrim);
    if (!parsed) return null;
    return { start: pos, end: pos + first.nodeSize, raw: firstTrim };
  }
  if (!DETAILS_OPEN_STRICT.test(firstTrim)) return null;

  const texts = [firstText];
  let end = index;
  while (end + 1 < parent.childCount) {
    end += 1;
    const next = parent.child(end);
    if (!next) return null;
    if (next.type.name === 'code_block') return null;
    const t = blockText(next);
    // 构建不支持嵌套：遇到内层开标签即放弃（保持纯文本）
    if (DETAILS_OPEN_STRICT.test(t.trim())) return null;
    texts.push(t);
    if (DETAILS_CLOSE_STRICT.test(t.trim())) {
      let endPos = pos;
      for (let k = index; k <= end; k += 1) endPos += parent.child(k).nodeSize;
      return { start: pos, end: endPos, raw: texts.join('\n') };
    }
  }
  return null;
}

function collectRuns(doc) {
  const runs = [];
  doc.descendants((node, pos, parent, index) => {
    if (node.type.name === 'details_fold') return false; // 不进已有折叠内部
    if (!parent || index == null) return true;
    const run = tryBuildAt(parent, index, pos);
    if (run) {
      runs.push(run);
      return false;
    }
    return true;
  });
  return runs;
}

export const foldInputRule = $inputRule(
  (ctx) =>
    new InputRule(
      /(<details(?:\s[^>]*)?>[\s\S]*?<\/details>)$/i,
      (state, match, start, end) => {
        const raw = match[1] || match[0];
        const foldNode = buildFoldNode(ctx, raw, false);
        if (!foldNode) return null;
        const $from = state.doc.resolve(start);
        const parent = $from.parent;
        if (!parent || parent.type.name !== 'paragraph') return null;
        const depth = $from.depth;
        const pStart = $from.before(depth);
        const pEnd = $from.after(depth);
        const preTo = start - pStart - 1;
        const postFrom = end - pStart - 1;
        const postTo = parent.content.size;
        if (preTo < 0 || postFrom < 0 || postFrom > postTo) return null;
        const preText = parent.textBetween(0, preTo, undefined, '\n');
        const postText = parent.textBetween(postFrom, postTo, undefined, '\n');
        const schema = state.schema;
        const blocks = [];
        if (preText) blocks.push(schema.nodes.paragraph.create(null, schema.text(preText)));
        blocks.push(foldNode);
        if (postText) blocks.push(schema.nodes.paragraph.create(null, schema.text(postText)));
        try {
          return state.tr.replaceWith(pStart, pEnd, Fragment.fromArray(blocks));
        } catch (err) {
          return null;
        }
      }
    )
);

const reconcileKey = new PluginKey('details-fold-reconcile');

export const foldReconcile = $prose(
  (ctx) =>
    new Plugin({
      key: reconcileKey,
      appendTransaction(trs, _oldState, newState) {
        if (!trs.some((tr) => tr.docChanged)) return null;
        // IME 组合期不构建（对齐原型 isComposing 之外触发的口径）
        try {
          const view = ctx.get(editorViewCtx);
          if (view && view.composing) return null;
        } catch (err) {
          /* editorView 尚未就绪则跳过 */
        }
        const runs = collectRuns(newState.doc);
        if (!runs.length) return null;
        const tr = newState.tr;
        let changed = false;
        runs
          .slice()
          .sort((a, b) => b.start - a.start)
          .forEach((run) => {
            const foldNode = buildFoldNode(ctx, run.raw, false);
            if (!foldNode) return;
            try {
              tr.replaceWith(run.start, run.end, foldNode);
              changed = true;
            } catch (err) {
              /* 单个替换失败不阻断其余 */
            }
          });
        return changed ? tr : null;
      },
    })
);

const keymapKey = new PluginKey('details-fold-keymap');

function findAdjacentCollapsedFold(state, dir) {
  const sel = state.selection;
  if (!sel || !sel.empty) return null;
  const $from = sel.$from;
  const pos = sel.from;
  const isFold = (n) => n && n.type.name === 'details_fold' && n.attrs.collapsed;
  if (dir === 'before') {
    const nb = $from.nodeBefore;
    if (isFold(nb)) return { start: pos - nb.nodeSize, node: nb };
    if ($from.parentOffset === 0) {
      const bp = $from.before($from.depth);
      const n = bp > 0 ? state.doc.resolve(bp).nodeBefore : null;
      if (isFold(n)) return { start: bp - n.nodeSize, node: n };
    }
  } else {
    const na = $from.nodeAfter;
    if (isFold(na)) return { start: pos, node: na };
    if ($from.parentOffset === $from.parent.content.size) {
      const ap = $from.after($from.depth);
      const n = ap < state.doc.content.size ? state.doc.resolve(ap).nodeAfter : null;
      if (isFold(n)) return { start: ap, node: n };
    }
  }
  return null;
}

export const foldKeymap = $prose(
  () =>
    new Plugin({
      key: keymapKey,
      props: {
        handleKeyDown(view, event) {
          if (event.key !== 'Backspace' && event.key !== 'Delete') return false;
          const dir = event.key === 'Backspace' ? 'before' : 'after';
          const hit = findAdjacentCollapsedFold(view.state, dir);
          if (!hit) return false;
          event.preventDefault();
          const tr = view.state.tr.delete(hit.start, hit.start + hit.node.nodeSize);
          try {
            tr.setSelection(
              TextSelection.near(tr.doc.resolve(hit.start), dir === 'before' ? -1 : 1)
            );
          } catch (err) {
            /* 光标设置失败不阻断删除 */
          }
          view.dispatch(tr);
          return true;
        },
      },
    })
);
