import { memo, useCallback, useMemo, useReducer, useRef } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import {
  foldSlug,
  foldFirstLine,
  foldKeyFor,
  isFoldOpen,
  setFoldOpen,
  notifyFolds,
  clearFoldsForNode,
  getFoldDefault,
  setFoldDefault,
  getFoldKeys,
  setFoldKeys,
  hasCollapsedFold,
  setFoldsOpen,
  clearFoldStateForNode,
} from './foldState.js';
import { splitMarkdownPages } from './se/pageSplit.js';
import { PAGE_CHAR_BUDGET } from './se/terminalCaps.js';

// ---------------------------------------------------------------------------
// 插件链：raw 必须在前、sanitize 必须在后（否则内嵌 HTML 未解析 = XSS 口子）。
// schema 以默认 GitHub 口径为基础，叠加放行 details/summary/open 与 data: 图片。
// ---------------------------------------------------------------------------
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: Array.from(new Set([...(defaultSchema.tagNames || []), 'details', 'summary'])),
  attributes: {
    ...defaultSchema.attributes,
    '*': Array.from(new Set([...(defaultSchema.attributes?.['*'] || []), 'dataLine'])),
    details: Array.from(new Set([...(defaultSchema.attributes?.details || []), 'open'])),
  },
  protocols: {
    ...defaultSchema.protocols,
    src: Array.from(new Set([...(defaultSchema.protocols?.src || []), 'data'])),
  },
  strip: ['script'],
};

// 扫描条定位用：给顶层块标注起始源码行号（data-line），raw 之后、sanitize 之前执行。
// 分页时当前页文本的顶层块行号是相对本页的，需用 lineOffset 还原为全文绝对行号。
function rehypeDataLine(lineOffset = 0) {
  return (tree) => {
    if (!tree || !Array.isArray(tree.children)) return;
    tree.children.forEach((child) => {
      if (child && child.type === 'element' && child.position?.start?.line != null) {
        child.properties = child.properties || {};
        child.properties.dataLine = child.position.start.line + lineOffset;
      }
    });
  };
}

const remarkPlugins = [remarkGfm, remarkBreaks];

// react-markdown 默认 urlTransform 会把 data: 抹成空串；这里额外放行 data:（仅图片会用）。
const urlTransform = (url) => (/^data:/i.test(String(url || '')) ? url : defaultUrlTransform(url));

const IMG_SRC_OK = /^(https?:|data:)/i;
const FOLD_RE = /<details[\s>]/i;

// 递归提取 hast 节点纯文本（summary 标题、正文预览/字数统计用）
function hastText(node) {
  if (!node) return '';
  if (Array.isArray(node)) return node.map(hastText).join('');
  if (node.type === 'text') return node.value || '';
  if (node.children) return hastText(node.children);
  return '';
}

function MarkdownView({ content, nodeId, page, viewScope }) {
  const [, bump] = useReducer((x) => x + 1, 0);
  // 每次渲染重置 occurrence 计数（按渲染顺序深度优先，等价原型的 ctx.occ 递归计数）。
  const occRef = useRef({});
  const contentRef = useRef(null);
  const componentsRef = useRef(null);

  occRef.current = {};

  // 内容变化时清理该节点残留的折叠态，避免旧 key 污染。
  if (contentRef.current !== content) {
    contentRef.current = content;
    clearFoldsForNode(viewScope, nodeId);
  }

  // 分页：仅当 page 为 number 时按顶层块边界取当前页文本；否则整篇透传（零行为变化）。
  // splitMarkdownPages 按 content 引用缓存，内容未变时重复调用零成本。
  // lineOffset 把本页块行号还原为全文绝对行号（pageStartLine 为 1 基，故 -1）。
  const { pageText, lineOffset } = useMemo(() => {
    if (typeof page !== 'number') return { pageText: content || '', lineOffset: 0 };
    const pages = splitMarkdownPages(content || '', { charBudget: PAGE_CHAR_BUDGET });
    if (pages.length <= 1) return { pageText: content || '', lineOffset: 0 };
    const p = Math.max(0, Math.min(page, pages.length - 1));
    const pg = pages[p];
    return { pageText: (content || '').slice(pg.start, pg.end), lineOffset: pg.startLine - 1 };
  }, [content, page]);

  // 插件链每页重建（offset 随页变化）；raw 前、sanitize 后。
  const rehypePlugins = useMemo(
    () => [rehypeRaw, rehypeDataLine(lineOffset), [rehypeSanitize, sanitizeSchema]],
    [lineOffset]
  );

  // 本轮渲染该节点的折叠 key 集合（由 detail 卡片在渲染时填充）。
  setFoldKeys(viewScope, nodeId, new Set());

  const toggle = useCallback(
    (key) => {
      setFoldOpen(viewScope, nodeId, key, !isFoldOpen(viewScope, nodeId, key));
      bump();
    },
    [nodeId, viewScope]
  );

  const toggleAll = useCallback(() => {
    const keys = getFoldKeys(viewScope, nodeId) || new Set();
    let allExpanded;
    if (getFoldDefault(viewScope, nodeId) === true) {
      allExpanded = !hasCollapsedFold(viewScope, nodeId);
    } else {
      allExpanded = keys.size > 0 && Array.from(keys).every((k) => isFoldOpen(viewScope, nodeId, k));
    }
    const expand = !allExpanded;
    setFoldDefault(viewScope, nodeId, expand);
    if (expand) {
      setFoldsOpen(viewScope, nodeId, keys, true);
    } else {
      clearFoldStateForNode(viewScope, nodeId);
    }
    notifyFolds();
    bump();
  }, [nodeId, viewScope]);

  const components = useMemo(() => {
    // 折叠卡片：只读展示 + 内存展开态；收起时不渲染正文 DOM。
    const FoldCard = ({ node }) => {
      const kids = node?.children || [];
      const summaryNode = kids.find((c) => c.tagName === 'summary');
      const bodyNodes = kids.filter((c) => c !== summaryNode);
      const bodyText = hastText(bodyNodes).trim();
      const summaryText = summaryNode ? hastText(summaryNode).trim() : '';

      let title = summaryText;
      if (!title) title = foldFirstLine(bodyText).slice(0, 24) || '折叠内容';
      const preview = foldFirstLine(bodyText).slice(0, 20);
      const slug = foldSlug(title);
      const occ = (occRef.current[slug] = (occRef.current[slug] || 0) + 1);
      const key = foldKeyFor(viewScope, nodeId, slug, occ);

      const keySet = getFoldKeys(viewScope, nodeId) || new Set();
      keySet.add(key);
      setFoldKeys(viewScope, nodeId, keySet);

      const open = isFoldOpen(viewScope, nodeId, key);
      const charCount = bodyText.replace(/\s+/g, '').length;

      return (
        <details className="md-fold" open={open}>
          <summary
            className="md-fold-sum"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              toggle(key);
            }}
          >
            <span className="md-fold-caret" />
            <span className="md-fold-title">{title}</span>
            {preview ? <span className="md-fold-preview"> · {preview}…</span> : null}
            <span className="md-fold-meta"> (约 {charCount} 字)</span>
          </summary>
          {open ? (
            <div className="md-fold-body">
              <ReactMarkdown
                remarkPlugins={remarkPlugins}
                rehypePlugins={rehypePlugins}
                urlTransform={urlTransform}
                components={componentsRef.current}
              >
                {bodyText}
              </ReactMarkdown>
            </div>
          ) : null}
        </details>
      );
    };

    const MarkdownImage = ({ node, src, alt, ...rest }) => {
      if (typeof src === 'string' && IMG_SRC_OK.test(src)) {
        return <img src={src} alt={alt || ''} loading="lazy" decoding="async" {...rest} />;
      }
      return (
        <span className="md-img-ph" title={typeof src === 'string' ? src : ''}>
          🖼 {alt || '图片'}
        </span>
      );
    };

    const MarkdownLink = ({ node, ...rest }) => (
      <a {...rest} target="_blank" rel="noreferrer noopener" />
    );

    return { details: FoldCard, img: MarkdownImage, a: MarkdownLink };
  }, [nodeId, viewScope, toggle, rehypePlugins]);

  componentsRef.current = components;

  const hasFolds = useMemo(() => FOLD_RE.test(pageText), [pageText]);

  return (
    <>
      {hasFolds ? (
        <button
          type="button"
          className="fold-all-btn nodrag nopan"
          title="全部展开 / 全部收起"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleAll();
          }}
        >
          ⇕
        </button>
      ) : null}
      <div className="md-body">
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          urlTransform={urlTransform}
          components={components}
        >
          {pageText}
        </ReactMarkdown>
      </div>
    </>
  );
}

export default memo(MarkdownView);
