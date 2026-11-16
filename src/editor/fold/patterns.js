// 折叠块的纯函数工具：标记正则、raw 文本 ↔ 结构字段解析、回写序列化、key 计算。
// 编辑器 remark 插件 / PM node schema / input rule / reconcile 共用，保证解析口径一致。

import { foldSlug, foldFirstLine } from '../../foldState.js';

// 整行开/闭标签（允许属性；如 <details open> / <summary id="s">）
export const DETAILS_OPEN_STRICT = /^<details(?:\s[^>]*)?>$/i;
export const DETAILS_CLOSE_STRICT = /^<\/details>$/i;
export const SUMMARY_STRICT = /^<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary>$/i;
// 单行紧凑 details（<details>x</details>）
export const DETAILS_COMPACT = /^\s*<details(?:\s[^>]*)?>([\s\S]*)<\/details>\s*$/i;

const OPEN_TAG_RE = /<details(?:\s[^>]*)?>/i;
const TOKEN_RE = /<\/?details(?:\s[^>]*)?>/gi;

// contenteditable 会插入 NBSP / 零宽字符，正则前置归一化（原型 foldMarkerText :2021-2027）
export function normalizeFoldText(text) {
  return String(text == null ? '' : text)
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200B\u2060\uFEFF\u200C\u200D]/g, '');
}

/**
 * 统计文本中 <details> 的配对深度。
 * 返回 { depth, bad }：bad=true 表示中途出现多余闭标签（交错/非法）。
 */
export function balanceDepth(text) {
  let depth = 0;
  let bad = false;
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(text))) {
    if (m[0][1] === '/') depth -= 1;
    else depth += 1;
    if (depth < 0) bad = true;
  }
  return { depth, bad };
}

function isDetailsStartValue(value) {
  const t = normalizeFoldText(value).trimStart();
  if (!OPEN_TAG_RE.test(t)) return false;
  return !/^<\/details/i.test(t);
}

export function isDetailsStartNode(node) {
  if (!node) return false;
  if (node.type === 'html') return isDetailsStartValue(node.value);
  // remarkHtmlTransformer 可能已把块级 html 包进只含一个 html 子节点的 paragraph
  if (node.type === 'paragraph' && Array.isArray(node.children) && node.children.length === 1) {
    const child = node.children[0];
    return child && child.type === 'html' && isDetailsStartValue(child.value);
  }
  return false;
}

/** 取节点承载的 html 原文（html 节点本身 / 纯 html paragraph）。 */
export function htmlValueOf(node) {
  if (!node) return '';
  if (node.type === 'html') return String(node.value || '');
  if (node.type === 'paragraph' && Array.isArray(node.children) && node.children.length === 1) {
    const child = node.children[0];
    if (child && child.type === 'html') return String(child.value || '');
  }
  return '';
}

/**
 * 把一段原始 `<details>…</details>` 文本解析为结构字段。
 * 不合法（开/闭不齐、交错）返回 null —— 调用方保持纯文本（原型降级路径）。
 *
 * 返回：{ raw, open, close, summary, summaryText, bodyRaw, compact }
 *   raw        原始全文（未编辑时回写用，保证逐字节保真）
 *   open       原始开标签行（含属性）
 *   close      原始闭标签行
 *   summary    原始 summary 整行（无则 null）
 *   summaryText summary 内文（标题）
 *   bodyRaw    正文源码（去首尾空行）
 */
export function parseDetailsText(raw) {
  const text = normalizeFoldText(raw);
  const trimmed = text.trim();
  if (!trimmed) return null;

  // 单行紧凑：<details>x</details>
  if (!trimmed.includes('\n')) {
    const compact = trimmed.match(DETAILS_COMPACT);
    if (compact) {
      const openM = trimmed.match(OPEN_TAG_RE);
      return {
        raw: text,
        open: openM ? openM[0] : '<details>',
        close: '</details>',
        summary: null,
        summaryText: '',
        bodyRaw: compact[1],
        compact: true,
        rest: '',
      };
    }
  }

  const lines = text.split('\n');
  let openIdx = 0;
  while (openIdx < lines.length && !lines[openIdx].trim()) openIdx += 1;
  if (openIdx >= lines.length) return null;
  const openLine = lines[openIdx].trim();
  if (!DETAILS_OPEN_STRICT.test(openLine)) return null;

  // 找第一个配对闭合行（depth 归零）；其后的文本作为 rest 单独成为 html 节点，
  // 以正确处理「一个 html 块里 details 之后还有正文」的情形。
  let depth = 0;
  let closeIdx = -1;
  const tagRe = /<\/?details(?:\s[^>]*)?>/gi;
  for (let i = openIdx; i < lines.length; i += 1) {
    tagRe.lastIndex = 0;
    let m;
    while ((m = tagRe.exec(lines[i]))) {
      if (m[0][1] === '/') depth -= 1;
      else depth += 1;
    }
    if (depth <= 0) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx < 0) return null;
  const closeLine = lines[closeIdx].trim();
  if (!DETAILS_CLOSE_STRICT.test(closeLine)) return null;

  const middle = lines.slice(openIdx + 1, closeIdx);
  let summary = null;
  let summaryText = '';
  let bodyLines = middle;
  const sIdx = middle.findIndex((l) => l.trim() && SUMMARY_STRICT.test(l.trim()));
  if (sIdx >= 0) {
    summary = middle[sIdx].trim();
    const m = summary.match(SUMMARY_STRICT);
    summaryText = m ? m[1].trim() : '';
    bodyLines = middle.slice(sIdx + 1);
  }

  const prefix = lines.slice(0, closeIdx + 1).join('\n');
  const rest = lines
    .slice(closeIdx + 1)
    .join('\n')
    .replace(/^\n+/, '');
  // 正文保留内部空行，仅去掉首尾空行（比较/回写口径一致）
  const bodyRaw = bodyLines.join('\n').replace(/^\n+|\n+$/g, '');
  return {
    raw: prefix,
    open: openLine,
    close: closeLine,
    summary,
    summaryText,
    bodyRaw,
    compact: false,
    rest,
  };
}

/**
 * 由节点 attrs + 序列化后的正文 md 拼回 `<details>` 原文（编辑后回写用）。
 * summary 未被编辑且原始行存在时沿用原文；否则重建。
 */
export function buildFoldMarkdown(attrs, bodyMd) {
  const a = attrs || {};
  const summary = String(a.summary == null ? '' : a.summary).trim();
  const summaryText = String(a.summaryText == null ? '' : a.summaryText).trim();
  let summaryLine = null;
  if (summary) {
    if (a.summaryRaw && summary === summaryText) summaryLine = String(a.summaryRaw);
    else summaryLine = `<summary>${summary}</summary>`;
  }
  const parts = [String(a.open || '<details>')];
  if (summaryLine) parts.push(summaryLine);
  if (bodyMd) parts.push(bodyMd);
  parts.push(String(a.close || '</details>'));
  return parts.join('\n');
}

/** 折叠块正文纯文本（保留块间换行，供标题/预览/字数）。 */
export function foldBodyText(node) {
  if (!node) return '';
  if (typeof node.textBetween === 'function' && node.content) {
    try {
      return node.textBetween(0, node.content.size, '\n', '');
    } catch (err) {
      /* fall through */
    }
  }
  return String(node.textContent || '');
}

/** 折叠块显示标题：summary 优先，否则正文首行 24 字，最后兜底。 */
export function foldTitle(node) {
  const s = String(node?.attrs?.summary || '').trim();
  return s || foldFirstLine(foldBodyText(node)).slice(0, 24) || '折叠内容';
}

/** 计算共享 key：`${nodeId}::${slug}#${occ}`（nodeId 必须是 viewStateKey 归属键；occ 为文档序同 slug 折叠计数）。 */
export function computeFoldKey(doc, pos, node, nodeId) {
  const slug = foldSlug(foldTitle(node));
  let occ = 0;
  if (doc && typeof pos === 'number' && pos >= 0) {
    doc.nodesBetween(0, pos, (n) => {
      if (n.type && n.type.name === 'details_fold' && foldSlug(foldTitle(n)) === slug) occ += 1;
    });
  }
  return `${nodeId}::${slug}#${occ + 1}`;
}
