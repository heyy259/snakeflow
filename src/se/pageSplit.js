// 期 15 分页：正文分页的纯逻辑核心（无 React / DOM 依赖，Node 可直接 import 单测）。
//
// 背景：长文本一次性喂给 `<ReactMarkdown>` / `<pre>` 会带来随正文线性增长的解析与渲染
// 开销，并撑高节点高度触发 React Flow 反复重测。改为把正文切成「页」，只渲染当前页。
//
// 两条切分口径：
// - `splitMarkdownPages`：用 remark 解析为 mdast（仅 AST，不走 rehype / DOM），按**顶层块**
//   的 `position.start/end.offset` 边界累积成页。普通块（自身跨度 ≤ 预算）对齐块边界，
//   天然保证代码围栏、表格、`<details>` 卡片等不被拦腰切断；**单个自身跨度 > 预算的块**
//   不再独占整页，而是把该块按行边界硬切成多个连续页：每页起点优先落在行首（切在
//   「起点+预算」窗口内最后一个 '\n' 之后），窗口内无换行时退化为字符边界硬切，故每页
//   ≤ 预算。代价是半截 code fence 可能跨页（用户显式拍板的取舍）。
// - `splitLinePages`：console 纯文本按行窗口切分，单个超长行自成原子（永不切进行内）。
//
// 页区间约定：`start`/`end` 为 0 基字符偏移、`end` 开区间；所有页**连续且恰好覆盖**
// `[0, content.length)`；`startLine` 为该页首字符在**全文**中的 1 基行号。
//
// 缓存：每个函数各持一个单槽缓存 `{ content, budget, pages }`，仅当 `content` 引用相等
// （字符串原始值为值相等，故 WeakMap 不可用）且预算一致时命中，直接返回**同一个结果数组**。
// ⚠️ 调用方**不得修改**返回的数组或其中的页对象。
//
// 依赖：`unified` + `remark-parse`（均随 react-markdown 已在依赖树内，零新增）。
// 不加载 remark-gfm：无 gfm 时表格解析为单个顶层段落块，仍是块对齐、安全的。

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { PAGE_CHAR_BUDGET, PAGE_LINE_BUDGET } from './terminalCaps.js';

/** 复用的 mdast 解析器（parser-only，务必不要在这上面挂 rehype / DOM 插件）。 */
let mdProcessor = null;
const getMdProcessor = () => {
  if (!mdProcessor) mdProcessor = unified().use(remarkParse);
  return mdProcessor;
};

/** 单槽缓存：markdown 分页。 */
let mdCache = { content: null, budget: null, pages: null };
/** 单槽缓存：行分页。 */
let lineCache = { content: null, budget: null, pages: null };

/** 统一取原始字符串（兼容 String 对象；缓存仍按原始入参引用比较）。 */
const toText = (content) => (typeof content === 'string' ? content : String(content));

/** offset 在全文中的 1 基行号（仅作为块缺 line 信息时的兜底）。 */
const lineOfOffset = (text, offset) => {
  let line = 1;
  const stop = Math.min(Math.max(offset, 0), text.length);
  for (let i = 0; i < stop; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
};

/** 内联图片 URL 是否为 `data:image/...` 形式（需要整段原子分页的图片）。 */
const isDataImageUrl = (url) => typeof url === 'string' && url.startsWith('data:image/');

/** 节点自身或后代中是否存在 `data:image/...` 的 mdast `image` 节点。 */
const hasDataImage = (node) => {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'image') return isDataImageUrl(node.url);
  if (Array.isArray(node.children)) return node.children.some(hasDataImage);
  return false;
};

/**
 * 收集节点后代里带位置信息的 `data:image/...` 图片节点，按起点升序。
 * 无 `position.offset` 的图片无法安全切分，直接忽略（回退到原有块逻辑）。
 */
const collectDataImages = (node, out = []) => {
  if (!node || typeof node !== 'object') return out;
  if (node.type === 'image' && isDataImageUrl(node.url)) {
    const pos = node.position;
    const s = pos && pos.start ? pos.start.offset : undefined;
    const e = pos && pos.end ? pos.end.offset : undefined;
    if (typeof s === 'number' && typeof e === 'number' && e > s) {
      out.push({
        start: s,
        end: e,
        startLine: (pos.start && pos.start.line) || null,
      });
    }
    return out;
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) collectDataImages(child, out);
  }
  return out;
};

/**
 * markdown 按顶层块累积成页。
 * 容错：缺 `position` 偏移的顶层块不参与计数/封页，自然落入当前页覆盖范围（绝不抛错）。
 *
 * 单块自身跨度 > 预算时，对该块做「块内按行边界的硬切」（见 splitOversizedBlock），
 * 不再让该块独占一整页。普通多块累积逻辑保持不变。
 *
 * 含 `data:image/...` 图片的顶层块例外：图片跨度（`![alt](data:...)`）作为**独立页**输出，
 * 永不切开 data URI；图片前后的文本段仍走普通预算累积。
 */
const buildMarkdownPages = (text, charBudget) => {
  const tree = getMdProcessor().parse(text);
  const children = tree && Array.isArray(tree.children) ? tree.children : [];

  // 预算归一化：非正 / 非有限预算退化为「不内切」（整篇一页），避免切页循环不前进。
  const budget = Number.isFinite(charBudget) && charBudget >= 1 ? Math.floor(charBudget) : Infinity;

  const pages = [];
  // 用对象承载当前页状态，便于同时被普通块与图片块逻辑推进。
  const state = { curStart: 0, curStartLine: 1, curCount: 0 };

  /**
   * 追加一个非图片跨度 `[s, e)`：与改造前的顶层块累积逻辑逐行等价。
   * `spanStartLine` 为该跨度起点的全文 1 基行号。
   */
  const appendSpan = (s, e, spanStartLine) => {
    // curCount === 0 时块前可能留有未覆盖区间（文档前导空白，或上一块被内切后遗留的
    // 块间空白）→ 含可见字符时先补一页，保证所有页连续且恰好覆盖全文。
    // 纯前导空白不单独封页，否则首页渲染为整页空白（扫描体验 bug 根因之一）；
    // 不推进 curStart，让该段空白并入即将到来的页（pages[0].start 保持 0）。
    if (state.curCount === 0 && state.curStart < s && text.slice(state.curStart, s).trim() !== '') {
      pages.push({ start: state.curStart, end: s, startLine: state.curStartLine });
      state.curStart = s;
      state.curStartLine = spanStartLine;
    }

    // 单跨度自身超预算 → 块内按行边界硬切成多个 ≤ 预算的连续页。
    if (e - s > budget) {
      // 当前页非空先按原逻辑封页（超长块必须另起一页）。
      if (state.curCount > 0 && state.curStart < s) {
        pages.push({ start: state.curStart, end: s, startLine: state.curStartLine });
        state.curStart = s;
        state.curStartLine = spanStartLine;
      }
      // 从 curStart（而非 s）起切：前导纯空白被并入时 curStart 可能 < s（如 curStart === 0），
      // 保证页区间连续覆盖且 pages[0].start === 0；splitOversizedBlock 保证每页 ≤ 预算。
      splitOversizedBlock(text, state.curStart, e, budget, pages);
      state.curStart = e;
      state.curCount = 0;
      state.curStartLine = lineOfOffset(text, e);
      return;
    }

    // 加入下一跨度会超预算且当前页非空 → 在下一跨度起点封页（普通页边界落在块首）。
    if (state.curCount > 0 && e - state.curStart > budget) {
      pages.push({ start: state.curStart, end: s, startLine: state.curStartLine });
      state.curStart = s;
      state.curStartLine = spanStartLine;
      state.curCount = 0;
    }
    state.curCount += 1;
  };

  /**
   * 处理含 data 图片的顶层块 `[blockStart, blockEnd)`：
   * 文本段按普通预算累积，每张图片整段独占一页（含完整 `![alt](data:...)`）。
   */
  const appendImageBlock = (blockStart, blockEnd, blockStartLine, images) => {
    let cursor = blockStart;
    for (const img of images) {
      const imgStartLine = img.startLine || lineOfOffset(text, img.start);
      // 图片之前的文本段（块首或上一张图片之后）。
      if (img.start > cursor) {
        appendSpan(cursor, img.start, cursor === blockStart ? blockStartLine : lineOfOffset(text, cursor));
      }

      // 图片起点前若有可见内容，先封页；纯空白则并入图片页，避免产生纯空白页。
      if (state.curStart < img.start) {
        if (text.slice(state.curStart, img.start).trim() !== '') {
          pages.push({ start: state.curStart, end: img.start, startLine: state.curStartLine });
          state.curStart = img.start;
          state.curStartLine = imgStartLine;
        }
      }

      // 图片整段独占一页：起点恰为图片时用图片自身行号，否则沿用当前页起点行号。
      pages.push({
        start: state.curStart,
        end: img.end,
        startLine: state.curStart === img.start ? imgStartLine : state.curStartLine,
      });
      state.curStart = img.end;
      state.curStartLine = lineOfOffset(text, img.end);
      state.curCount = 0;
      cursor = img.end;
    }

    // 最后一张图片之后的文本段。
    if (blockEnd > cursor) {
      appendSpan(cursor, blockEnd, cursor === blockStart ? blockStartLine : lineOfOffset(text, cursor));
    }
  };

  for (const node of children) {
    const pos = node && node.position;
    const s = pos && pos.start ? pos.start.offset : undefined;
    const e = pos && pos.end ? pos.end.offset : undefined;
    if (typeof s !== 'number' || typeof e !== 'number') continue;

    // 含 data:image 图片的块：图片原子分页，文本段正常累积。
    if (hasDataImage(node)) {
      const images = collectDataImages(node);
      if (images.length > 0) {
        const startLine = (pos.start && pos.start.line) || lineOfOffset(text, s);
        images.sort((a, b) => a.start - b.start);
        appendImageBlock(s, e, startLine, images);
        continue;
      }
    }

    appendSpan(s, e, (pos.start && pos.start.line) || lineOfOffset(text, s));
  }

  const curStart = state.curStart;
  const curCount = state.curCount;
  const curStartLine = state.curStartLine;

  if (curCount === 0 && pages.length === 0) {
    // 无带位置的顶层块（纯空白 / 空文档）：整篇一页；空串已在入口返回 []。
    return text.length > 0 ? [{ start: 0, end: text.length, startLine: 1 }] : [];
  }

  // 收尾页：覆盖最后一块/内切块之后的剩余区间（curStart === text.length 时无尾页）。
  if (curStart < text.length) {
    pages.push({ start: curStart, end: text.length, startLine: curStartLine });
  }
  return pages;
};

/**
 * 把单个超预算顶层块 `[blockStart, blockEnd)` 按行边界硬切成多个 ≤ budget 的连续页，
 * 结果按序 push 进 `pages`。
 *
 * 每页终点：在 `(pageStart, pageStart + budget)` 内取最后一个 '\n' 的下一个位置
 * （即切在换行后，页尾含换行符，让下一页以整行开头）；窗口内无换行时退化为
 * `pageStart + budget` 字符边界硬切。故每页长度恒 ≤ budget。
 */
const splitOversizedBlock = (text, blockStart, blockEnd, budget, pages) => {
  let pageStart = blockStart;
  while (blockEnd - pageStart > budget) {
    const limit = pageStart + budget; // 页终点上限（开区间），保证长度 ≤ budget
    let cut = -1;
    for (let i = limit - 1; i > pageStart; i--) {
      if (text.charCodeAt(i) === 10) {
        cut = i;
        break;
      }
    }
    const pageEnd = cut > pageStart ? cut + 1 : limit;
    pages.push({ start: pageStart, end: pageEnd, startLine: lineOfOffset(text, pageStart) });
    pageStart = pageEnd;
  }
  // 剩余部分（长度 ∈ (0, budget]）作为该块最后一页。
  pages.push({ start: pageStart, end: blockEnd, startLine: lineOfOffset(text, pageStart) });
};

/** 纯文本按行窗口累积成页（页边界落在行首，页尾包含行尾换行符以保证连续覆盖）。 */
const buildLinePages = (text, lineBudget) => {
  const budget = Number.isFinite(lineBudget) && lineBudget >= 1 ? Math.floor(lineBudget) : 1;

  // 扫描每行起始偏移（含首行 0；以 '\n' 为界，天然兼容 CRLF）。
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }

  const pages = [];
  let pageStartIdx = 0;
  let count = 0;
  for (let i = 0; i < lineStarts.length; i++) {
    if (count > 0 && count >= budget) {
      pages.push({ start: lineStarts[pageStartIdx], end: lineStarts[i], startLine: pageStartIdx + 1 });
      pageStartIdx = i;
      count = 0;
    }
    count++;
  }
  // 文本以换行结尾时末尾会多出一个空段（start === end），不产出空尾页。
  if (lineStarts[pageStartIdx] < text.length || pages.length === 0) {
    pages.push({ start: lineStarts[pageStartIdx], end: text.length, startLine: pageStartIdx + 1 });
  }
  return pages;
};

/**
 * markdown 分页：按顶层块边界切分，`end` 开区间。
 * @param {string} content
 * @param {{ charBudget?: number }} [options]
 * @returns {Array<{ start: number, end: number, startLine: number }>}
 */
export function splitMarkdownPages(content, { charBudget = PAGE_CHAR_BUDGET } = {}) {
  if (content == null) return [];
  const text = toText(content);
  if (text.length === 0) return [];

  if (mdCache.content === content && mdCache.budget === charBudget) return mdCache.pages;

  let pages;
  try {
    pages = buildMarkdownPages(text, charBudget);
  } catch (err) {
    // 解析失败 → 退化为整篇一页，保证下游永不崩。
    pages = [{ start: 0, end: text.length, startLine: 1 }];
  }
  mdCache = { content, budget: charBudget, pages };
  return pages;
}

/**
 * 纯文本行分页：按行窗口切分，`end` 开区间。
 * @param {string} content
 * @param {{ lineBudget?: number }} [options]
 * @returns {Array<{ start: number, end: number, startLine: number }>}
 */
export function splitLinePages(content, { lineBudget = PAGE_LINE_BUDGET } = {}) {
  if (content == null) return [];
  const text = toText(content);
  if (text.length === 0) return [];

  if (lineCache.content === content && lineCache.budget === lineBudget) return lineCache.pages;

  const pages = buildLinePages(text, lineBudget);
  lineCache = { content, budget: lineBudget, pages };
  return pages;
}
