// remark 插件：把 mdast 中匹配 details 模式的 html 块节点转换为 `details-fold` 自定义节点。
//
// 解析方向：拆出 open / summary / bodyRaw（正文递归交给 node schema 的 parseMarkdown 再按 md 解析）。
// 嵌套折叠：html 块天然含完整文本，按 depth 配对拆分；不闭合 / 交错 → 保持 html 原文节点（降级纯文本）。
//
// 注册顺序须先于 commonmark 的 remarkHtmlTransformer（见 MilkdownHost .use 顺序），
// 这样看到的是块级 html 原文；插件同时兼容已被包进 paragraph 的纯 html 形态。

import { $remark } from '@milkdown/kit/utils';
import {
  balanceDepth,
  htmlValueOf,
  isDetailsStartNode,
  parseDetailsText,
} from './patterns.js';

function sliceOf(node, source) {
  const pos = node && node.position;
  if (
    source != null &&
    pos &&
    pos.start &&
    pos.end &&
    typeof pos.start.offset === 'number' &&
    typeof pos.end.offset === 'number'
  ) {
    return source.slice(pos.start.offset, pos.end.offset);
  }
  return null;
}

function textOf(node) {
  if (!node) return '';
  if (node.type === 'html') return String(node.value || '');
  if (Array.isArray(node.children)) return node.children.map(textOf).join('\n');
  if (typeof node.value === 'string') return node.value;
  return '';
}

function toFoldNode(parsed) {
  return {
    type: 'details-fold',
    raw: parsed.raw,
    open: parsed.open,
    close: parsed.close,
    summaryRaw: parsed.summary,
    summaryText: parsed.summaryText,
    bodyRaw: parsed.bodyRaw,
  };
}

// details 之后的残留文本单独成为 html 节点（保持原文），供后续 remarkHtmlTransformer 包装
function restNodes(parsed) {
  const rest = String(parsed.rest || '').replace(/^\n+/, '');
  if (!rest.trim()) return [];
  return [{ type: 'html', value: rest }];
}

// 从 kids[i] 起尝试构建折叠块；返回 { nodes, consumed } 或 null（保持纯文本）。
function buildRun(kids, i, source) {
  const first = kids[i];
  const firstRaw = sliceOf(first, source) || htmlValueOf(first);
  const firstBalance = balanceDepth(firstRaw);
  if (firstBalance.bad) return null;
  if (firstBalance.depth === 0) {
    const parsed = parseDetailsText(firstRaw);
    if (!parsed) return null;
    return { nodes: [toFoldNode(parsed), ...restNodes(parsed)], consumed: 1 };
  }
  // 开标签未在自身闭合：向后找配对闭标签（允许中间夹任意块，但不跨代码块）
  let acc = firstRaw;
  let j = i;
  while (j + 1 < kids.length) {
    j += 1;
    const next = kids[j];
    if (!next) return null;
    if (next.type === 'code' || next.type === 'yaml' || next.type === 'toml') return null;
    acc += '\n' + (sliceOf(next, source) || textOf(next));
    const b = balanceDepth(acc);
    if (b.bad) return null;
    if (b.depth === 0) {
      const start = first.position?.start?.offset;
      const end = next.position?.end?.offset;
      const raw =
        source != null && typeof start === 'number' && typeof end === 'number'
          ? source.slice(start, end)
          : acc;
      const parsed = parseDetailsText(raw);
      if (!parsed) return null;
      return { nodes: [toFoldNode(parsed), ...restNodes(parsed)], consumed: j - i + 1 };
    }
  }
  return null; // 未闭合 → 保持原文
}

function processChildren(parent, source) {
  const kids = parent && parent.children;
  if (!Array.isArray(kids)) return;
  for (let i = 0; i < kids.length; i += 1) {
    const node = kids[i];
    if (isDetailsStartNode(node)) {
      const built = buildRun(kids, i, source);
      if (built) {
        kids.splice(i, built.consumed, ...built.nodes);
        i -= 1; // 重新处理插入的节点（rest 可能又是 details）
        continue;
      }
    }
    if (node && Array.isArray(node.children)) processChildren(node, source);
  }
}

/** 原始 unified transformer（独立导出，便于 Node 层做纯解析测试）。 */
export function detailsFoldTransformer(tree, file) {
  const source = file && typeof file.value === 'string' ? file.value : null;
  processChildren(tree, source);
}

export const remarkFold = $remark(
  'remark-details-fold',
  () => () => detailsFoldTransformer
);
