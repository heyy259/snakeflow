// 快捷文本片段（需求 8）——应用侧：四类片段 + toggle 剥离（全部走 ProseMirror transaction）。
//
// 数据/占位符解析/类型判定在 editor/snippetData.js（主包 UI 用，无编辑器依赖，保证 milkdown 只进懒加载 chunk）。
// 本文件仅被 MilkdownHost（懒加载）引用：
//   insert      光标处插入（多行拆 insertText + hardbreak 分段）
//   prefix      `前缀{sel}` → 每个 textblock 首加前缀（已知前缀做结构转换，避免序列化转义）
//   wrap-inline 选区两端标记 → 施加/移除真实 mark（toggle）；未识别标记走解析通用路径
//   wrap-block  解析 open+body+close 为块结构（折叠 details_fold / 代码块 / 引用…）替换选区
//
// 权威定义见《升级改造方案.md》§4.3 与原型 prototype/index.html:2860-3804。

import { Fragment } from '@milkdown/kit/prose/model';
import { TextSelection } from '@milkdown/kit/prose/state';
import { parserCtx, serializerCtx } from '@milkdown/kit/core';
import { resolveWrapFragment, snippetType } from './snippetData.js';

export * from './snippetData.js';

/* ------------------------------------------------------------------ *
 * 应用（PM transaction）
 * ------------------------------------------------------------------ */

function selectionText(state, from, to) {
  try {
    return state.doc.textBetween(from, to, '\n', '\n');
  } catch (err) {
    return '';
  }
}

function isThematicBreak(text) {
  return /^(-{3,}|\*{3,}|_{3,})$/.test(String(text).trim());
}

/** insert：光标处插入；多行用 hardbreak 分段（对应原型 insertLineBreak）。 */
function insertTextSnippet(view, text) {
  const state = view.state;
  const schema = state.schema;
  const { from, to } = state.selection;
  const value = String(text == null ? '' : text);
  const tr = state.tr;
  try {
    if (isThematicBreak(value) && schema.nodes.hr) {
      tr.replaceSelectionWith(schema.nodes.hr.create());
      view.dispatch(tr);
      return true;
    }
    const lines = value.split('\n');
    if (lines.length === 1) {
      tr.insertText(value, from, to);
      view.dispatch(tr);
      return true;
    }
    const hb = schema.nodes.hardbreak || schema.nodes.hard_break;
    const nodes = [];
    lines.forEach((line, i) => {
      if (i > 0 && hb) nodes.push(hb.create());
      if (line) nodes.push(schema.text(line));
    });
    const frag = Fragment.fromArray(nodes);
    if (state.doc.childCount === 0) {
      const p = schema.nodes.paragraph.create(null, frag);
      tr.insert(0, p);
    } else if (state.selection.empty) {
      tr.insert(from, frag);
    } else {
      tr.replaceSelectionWith(frag);
    }
    view.dispatch(tr);
    return true;
  } catch (err) {
    console.warn('插入片段失败', err);
    return false;
  }
}

/** 把前缀识别为结构化块类型（正文纯文本插入会被序列化器转义，故已知前缀走结构转换）。 */
function classifyPrefix(prefix) {
  let m;
  if ((m = /^(#{1,6})\s+$/.exec(prefix))) return { kind: 'heading', level: m[1].length };
  if ((m = /^([-*+])\s+\[([ xX])\]\s+$/.exec(prefix)))
    return { kind: 'task', checked: m[2].toLowerCase() === 'x' };
  if (/^([-*+])\s+$/.test(prefix)) return { kind: 'bullet' };
  if ((m = /^(\d+)[.)]\s+$/.exec(prefix))) return { kind: 'ordered', label: parseInt(m[1], 10) };
  if (/^>\s*$/.test(prefix)) return { kind: 'quote' };
  return { kind: 'text' };
}

/** 选区覆盖的 textblock（collapsed 时取光标所在块）。 */
function collectTextblocks(state, from, to) {
  const blocks = [];
  if (from === to) {
    const $from = state.doc.resolve(from);
    for (let d = $from.depth; d > 0; d -= 1) {
      const n = $from.node(d);
      if (n.isTextblock) {
        blocks.push({ node: n, pos: $from.before(d) });
        break;
      }
    }
    return blocks;
  }
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.isTextblock) {
      blocks.push({ node, pos });
      return false;
    }
    return true;
  });
  return blocks;
}

/** prefix：每块首加前缀；已知前缀做结构转换，其余插入纯文本。 */
function applyPrefix(view, prefix) {
  const state = view.state;
  const schema = state.schema;
  const blocks = collectTextblocks(state, state.selection.from, state.selection.to);
  if (!blocks.length) return false;
  const cls = classifyPrefix(prefix);
  const tr = state.tr;
  blocks
    .slice()
    .sort((a, b) => b.pos - a.pos)
    .forEach(({ node, pos }) => {
      try {
        if (cls.kind === 'text') {
          // 块内软换行（hardbreak）各视作一行：逐行行首插前缀（倒序避免位移影响）。
          const contentStart = pos + 1;
          const starts = [contentStart];
          let off = 0;
          node.forEach((child) => {
            if (child.type.name === 'hardbreak') starts.push(contentStart + off + child.nodeSize);
            off += child.nodeSize;
          });
          starts
            .sort((a, b) => b - a)
            .forEach((p) => {
              try {
                tr.insertText(prefix, p);
              } catch (err) {
                /* 单行插入失败不阻断其余 */
              }
            });
        } else if (cls.kind === 'heading') {
          tr.setNodeMarkup(pos, schema.nodes.heading, { level: cls.level });
        } else if (cls.kind === 'quote') {
          const para = schema.nodes.paragraph.create(null, node.content);
          tr.replaceWith(pos, pos + node.nodeSize, schema.nodes.blockquote.create(null, para));
        } else if (cls.kind === 'bullet' || cls.kind === 'task') {
          const attrs =
            cls.kind === 'task'
              ? { checked: !!cls.checked, listType: 'bullet', label: '?', spread: true }
              : undefined;
          const li = schema.nodes.list_item.create(
            attrs,
            schema.nodes.paragraph.create(null, node.content)
          );
          tr.replaceWith(pos, pos + node.nodeSize, schema.nodes.bullet_list.create(null, li));
        } else if (cls.kind === 'ordered') {
          const li = schema.nodes.list_item.create(
            { label: `${cls.label}.`, listType: 'ordered', spread: true },
            schema.nodes.paragraph.create(null, node.content)
          );
          tr.replaceWith(pos, pos + node.nodeSize, schema.nodes.ordered_list.create(null, li));
        }
      } catch (err) {
        console.warn('前缀应用失败', err);
      }
    });
  view.dispatch(tr);
  return true;
}

/* ---- wrap-inline：标记 → 真实 mark（避免序列化转义） ---- */

// 标记对 → mark 候选名（按 schema.marks 实际存在的做容错查找）。长标记在前，避免前缀误配。
const INLINE_MARK_DEFS = [
  { open: '**', close: '**', candidates: ['strong'] },
  { open: '__', close: '__', candidates: ['strong'] },
  { open: '~~', close: '~~', candidates: ['strike_through', 'strikethrough'] },
  { open: '*', close: '*', candidates: ['emphasis', 'em'] },
  { open: '_', close: '_', candidates: ['emphasis', 'em'] },
  { open: '`', close: '`', candidates: ['inlineCode', 'code_inline'] },
];

function findMark(schema, candidates) {
  if (!schema || !schema.marks) return null;
  for (const name of candidates) {
    if (schema.marks[name]) return schema.marks[name];
  }
  return null;
}

/** 标记对 → { type, attrs }；未识别返回 null。链接由 `[` + `](url)` 识别。 */
function matchInlineMark(schema, openText, closeText) {
  for (const def of INLINE_MARK_DEFS) {
    if (openText === def.open && closeText === def.close) {
      const type = findMark(schema, def.candidates);
      if (type) return { type, attrs: null };
    }
  }
  if (
    openText === '[' &&
    /^\]\([\s\S]*\)$/.test(closeText) &&
    schema &&
    schema.marks &&
    schema.marks.link
  ) {
    const href = closeText.slice(2, -1).trim();
    return { type: schema.marks.link, attrs: { href: href || 'url' } };
  }
  return null;
}

/** 选区是否被该 mark 完全覆盖（用于 toggle 还原）。 */
function rangeFullyMarked(state, from, to, markType) {
  if (from >= to) return false;
  let found = false;
  let all = true;
  state.doc.nodesBetween(from, to, (node) => {
    if (!all) return false;
    if (node.isText) {
      found = true;
      if (!markType.isInSet(node.marks)) all = false;
    }
    return true;
  });
  return found && all;
}

/**
 * 对选区施加/移除真实 mark；无选区时改操作 storedMarks（让后续输入带/去格式），
 * 绝不插入字面 `**`。返回 { toggled }。
 */
function applyInlineMark(view, def) {
  const state = view.state;
  const { from, to } = state.selection;
  const tr = state.tr;
  const mark = def.type.create(def.attrs || null);

  if (from === to) {
    // 无选区：切换 storedMarks（后续输入即带/去该格式）
    const current = state.storedMarks || state.selection.$from.marks();
    const active = !!def.type.isInSet(current);
    if (active) tr.removeStoredMark(def.type);
    else tr.addStoredMark(mark);
    view.dispatch(tr);
    return { toggled: active };
  }

  const active = rangeFullyMarked(state, from, to, def.type);
  if (active) tr.removeMark(from, to, def.type);
  else tr.addMark(from, to, mark);
  view.dispatch(tr);
  return { toggled: active };
}

/** 未识别标记的通用路径：拼成 md 经 parserCtx 解析，取首个 textblock 的 inline 内容替换选区。 */
function applyInlineViaParser(ctx, view, full) {
  const state = view.state;
  const { from, to } = state.selection;
  let parsed;
  try {
    parsed = ctx.get(parserCtx)(full);
  } catch (err) {
    console.warn('行内包裹解析失败，降级插入纯文本', err);
    view.dispatch(state.tr.insertText(full, from, to));
    return { toggled: false };
  }
  let frag = null;
  parsed.descendants((node) => {
    if (!frag && node.isTextblock) {
      frag = node.content;
      return false;
    }
    return true;
  });
  if (!frag || frag.size === 0) {
    if (full) view.dispatch(state.tr.insertText(full, from, to));
    return { toggled: false };
  }
  const tr = state.tr.replaceWith(from, to, frag);
  try {
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(from + frag.size, tr.doc.content.size)), 1));
  } catch (err) {
    /* 光标设置失败不阻断替换 */
  }
  view.dispatch(tr);
  return { toggled: false };
}

/** wrap-inline：标记施加为真实 mark；不能识别为 mark 的走解析通用路径。 */
function applyWrapInline(ctx, view, rawOpen, rawClose, selText, hasSel) {
  const state = view.state;
  const openText = resolveWrapFragment(rawOpen, selText, hasSel);
  const closeText = resolveWrapFragment(rawClose, selText, hasSel);
  const def = matchInlineMark(state.schema, openText, closeText);
  if (def) return applyInlineMark(view, def);

  // 链接无选区时也应落在 storedMarks 上（识别为 link mark），不会走到这里；
  // 其余未识别标记（如图片）拼 md 解析。
  const bodyText = hasSel ? selText : '内容';
  return applyInlineViaParser(ctx, view, openText + bodyText + closeText);
}

function serializeBlockRange(ctx, schema, doc, from, to) {
  try {
    const fragment = doc.slice(from, to, false).content;
    const tmp = schema.nodes.doc.create(null, fragment);
    const serializer = ctx.get(serializerCtx);
    return String(serializer(tmp) || '').replace(/\n+$/g, '');
  } catch (err) {
    return '';
  }
}

function focusFoldSummary(view, pos) {
  requestAnimationFrame(() => {
    try {
      const dom = view.nodeDOM(pos);
      const line = dom && dom.querySelector ? dom.querySelector('.md-fold-summary-line') : null;
      if (!line || typeof line.focus !== 'function') return;
      line.focus();
      const sel = window.getSelection();
      if (sel && line.firstChild) {
        const r = document.createRange();
        r.selectNodeContents(line);
        sel.removeAllRanges();
        sel.addRange(r);
      }
    } catch (err) {
      /* ignore */
    }
  });
}

/** wrap-block：解析 open+body+close 为块结构（折叠 / 代码块 / 引用…）替换选区。 */
function applyWrapBlock(ctx, view, rawOpen, rawClose, selText, hasSel) {
  const state = view.state;
  const schema = state.schema;
  const openText = resolveWrapFragment(rawOpen, selText, hasSel).replace(/\n+$/, '');
  const closeText = resolveWrapFragment(rawClose, selText, hasSel).replace(/^\n+/, '');
  const { from, to } = state.selection;

  let startPos = from;
  let endPos = to;
  let body = '';
  if (from === to) {
    const $from = state.doc.resolve(from);
    if ($from.depth >= 1) {
      startPos = $from.after(1);
      endPos = startPos;
    }
    body = '内容';
  } else {
    const $from = state.doc.resolve(from);
    const $to = state.doc.resolve(to);
    startPos = $from.depth >= 1 ? $from.before(1) : 0;
    endPos = $to.depth >= 1 ? $to.after(1) : state.doc.content.size;
    body = serializeBlockRange(ctx, schema, state.doc, startPos, endPos) || selText;
  }

  let full = openText;
  if (full) full += '\n';
  full += body || '内容';
  if (closeText) full += '\n' + closeText;

  let parsed;
  try {
    parsed = ctx.get(parserCtx)(full);
  } catch (err) {
    console.warn('块级包裹解析失败，降级插入纯文本', err);
    insertTextSnippet(view, full);
    return { fold: false };
  }
  const content = parsed.content;
  const tr = state.tr;
  try {
    tr.replaceWith(startPos, endPos, content);
  } catch (err) {
    console.warn('块级包裹替换失败', err);
    return { fold: false };
  }

  let foldPos = -1;
  let off = startPos;
  content.forEach((child) => {
    if (foldPos < 0 && child.type.name === 'details_fold') foldPos = off;
    off += child.nodeSize;
  });
  try {
    tr.setSelection(
      TextSelection.near(tr.doc.resolve(Math.min(startPos + content.size, tr.doc.content.size)), -1)
    );
  } catch (err) {
    /* ignore */
  }
  view.dispatch(tr);

  if (foldPos >= 0 && /\{sel:\d{1,2}\}/.test(rawOpen)) focusFoldSummary(view, foldPos);
  return { fold: foldPos >= 0 };
}

/**
 * 应用片段。ctx = milkdown Ctx（取 parser/serializer），view = EditorView。
 * 返回 { type, hasSel, toggled?, fold? }。
 */
export function applySnippetToView(ctx, view, snippet) {
  const text = String(snippet && snippet.text != null ? snippet.text : '');
  const type = snippetType(text);
  const state = view.state;
  const { from, to } = state.selection;
  const hasSel = from !== to;
  const selText = hasSel ? selectionText(state, from, to) : '';

  if (type === 'prefix') {
    applyPrefix(view, text.slice(0, text.indexOf('{sel}')));
    return { type, hasSel };
  }

  if (type === 'wrap') {
    const at = text.indexOf('{sel}');
    if (at !== -1) {
      const rawOpen = text.slice(0, at);
      const rawClose = text.slice(at + 5);
      const inline =
        rawOpen.indexOf('\n') === -1 &&
        rawClose.indexOf('\n') === -1 &&
        rawOpen.indexOf('<') === -1 &&
        rawClose.indexOf('<') === -1;
      if (inline) {
        const r = applyWrapInline(ctx, view, rawOpen, rawClose, selText, hasSel);
        return { type, hasSel, ...r };
      }
      applyWrapBlock(ctx, view, rawOpen, rawClose, selText, hasSel);
      return { type, hasSel };
    }
    // 仅含 {sel:N}：解析为纯文本插入
    insertTextSnippet(view, resolveWrapFragment(text, selText, hasSel));
    return { type, hasSel };
  }

  insertTextSnippet(view, text);
  return { type: 'insert', hasSel };
}
