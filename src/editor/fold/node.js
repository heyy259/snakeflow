// PM 节点 `details_fold` 的 schema（不依赖 React / DOM，便于纯函数测试）。
//
// 内容模型为 `block+`（summary 不是正文，用 attr 承载；正文才是可编辑内容）。
// md 往返：attrs.raw 保存原始文本；未编辑（正文序列化 === bodyRaw 且 summary 未变）时原样回写。

import { $nodeSchema } from '@milkdown/kit/utils';
import { remarkCtx } from '@milkdown/kit/core';
import { ParserState, SerializerState } from '@milkdown/kit/transformer';
import { buildFoldMarkdown } from './patterns.js';

function parseBody(ctx, bodyRaw) {
  if (!bodyRaw) return [];
  try {
    const remark = ctx.get(remarkCtx);
    const tree = remark.runSync(remark.parse(bodyRaw), bodyRaw);
    return tree.children || [];
  } catch (err) {
    console.warn('折叠块正文解析失败，降级为空正文', err);
    return [];
  }
}

// 用同 schema/remark 序列化正文（fresh SerializerState，避免重入主序列化器）
function serializeBody(ctx, state, node) {
  try {
    const schema = state.schema;
    const docType = schema.nodes.doc;
    if (!docType) return '';
    const remark = ctx.get(remarkCtx);
    const doc = docType.create(null, node.content);
    const serialize = SerializerState.create(schema, remark);
    return String(serialize(doc) || '').replace(/\n+$/g, '');
  } catch (err) {
    console.warn('折叠块正文序列化失败，回退空正文', err);
    return '';
  }
}

export const detailsFoldSchema = $nodeSchema('details_fold', (ctx) => ({
  content: 'block+',
  group: 'block',
  defining: true,
  isolating: true,
  attrs: {
    raw: { default: '' },
    open: { default: '<details>' },
    close: { default: '</details>' },
    summary: { default: '' },
    summaryRaw: { default: null },
    summaryText: { default: '' },
    bodyRaw: { default: '' },
    collapsed: { default: true },
    edited: { default: false },
  },
  parseDOM: [
    {
      tag: 'div[data-details-fold]',
      getAttrs: () => ({}),
    },
  ],
  toDOM: () => ['div', { class: 'md-fold md-fold-edit', 'data-details-fold': '1' }, 0],
  parseMarkdown: {
    match: ({ type }) => type === 'details-fold',
    runner: (state, node, type) => {
      const bodyRaw = String(node.bodyRaw || '');
      const children = parseBody(ctx, bodyRaw);
      state.openNode(type, {
        raw: String(node.raw || ''),
        open: String(node.open || '<details>'),
        close: String(node.close || '</details>'),
        summary: String(node.summaryText || ''),
        summaryRaw: node.summaryRaw != null ? String(node.summaryRaw) : null,
        summaryText: String(node.summaryText || ''),
        bodyRaw,
        collapsed: true,
        edited: false,
      });
      if (children.length) state.next(children);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'details_fold',
    runner: (state, node) => {
      const a = node.attrs || {};
      const raw = String(a.raw || '');
      // 未编辑（正文/标题均未改动）→ 原样回写原始文本，保证逐字节保真（§9 红线）。
      // 编辑过 → 由正文序列化 + summary 重建。
      if (!a.edited && raw) {
        state.addNode('html', undefined, raw);
        return;
      }
      const bodyMd = serializeBody(ctx, state, node);
      state.addNode('html', undefined, buildFoldMarkdown(a, bodyMd));
    },
  },
}));
