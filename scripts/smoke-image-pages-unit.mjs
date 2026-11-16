// P1 图片分页回归单测（零浏览器、零 SE）：
// `splitMarkdownPages` 对含内联 `data:image/...` 图片的顶层块必须「图片原子」——
// 绝不把 data URI 拦腰切断；文本段仍按原预算累积。
// 运行：node scripts/smoke-image-pages-unit.mjs（全绿退出码 0）。
import assert from 'node:assert/strict';
import { splitMarkdownPages } from '../src/se/pageSplit.js';

let count = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  count += 1;
};
const eq = (actual, expected, msg) => {
  assert.deepEqual(actual, expected, msg);
  count += 1;
};

const BUDGET = 15000;
const uri = 'data:image/png;base64,' + 'A'.repeat(340000);
const imageMd = `![](${uri})`;
const uriB = 'data:image/png;base64,' + 'B'.repeat(340000);
const imageB = `![](${uriB})`;

const lineOfOffset = (content, offset) => 1 + (content.slice(0, offset).match(/\n/g) || []).length;

const isContiguousCover = (content, pages) => {
  if (pages.length === 0) return content.length === 0;
  if (pages[0].start !== 0) return false;
  if (pages[pages.length - 1].end !== content.length) return false;
  for (let i = 1; i < pages.length; i += 1) {
    if (pages[i].start !== pages[i - 1].end) return false;
  }
  return pages.map((p) => content.slice(p.start, p.end)).join('') === content;
};

const startLinesOk = (content, pages) => pages.every((p) => p.startLine === lineOfOffset(content, p.start));

// 页内每个 `data:image/` 起点都必须紧跟某个完整 URI ⇒ 否则就是被切断的半截 data URI。
const partialDataUriPages = (content, pages, fullUris) => {
  const uris = Array.isArray(fullUris) ? fullUris : [fullUris];
  return pages.filter((p) => {
    const slice = content.slice(p.start, p.end);
    let idx = slice.indexOf('data:image/');
    while (idx !== -1) {
      if (!uris.some((u) => slice.startsWith(u, idx))) return true;
      idx = slice.indexOf('data:image/', idx + 1);
    }
    return false;
  });
};

try {
  // ── 1. 块级图片：before / image / after ───────────────────────────────
  {
    const text = `before\n\n${imageMd}\n\nafter`;
    const pages = splitMarkdownPages(text, { charBudget: BUDGET });
    ok(isContiguousCover(text, pages), '1 页区间连续且恰好覆盖全文');
    ok(startLinesOk(text, pages), '1 startLine 为全文绝对行号');
    eq(partialDataUriPages(text, pages, uri).length, 0, '1 无半截 data URI');
    const fullImagePages = pages.filter((p) => text.slice(p.start, p.end).includes(imageMd));
    eq(fullImagePages.length, 1, '1 恰好一页含完整图片');
    ok(pages.length <= 10, `1 页数很少（实际 ${pages.length}，旧行为约 25）`);
    console.log(`  case1 pages=${pages.length} lengths=${JSON.stringify(pages.map((p) => p.end - p.start))}`);
  }

  // ── 2. 行内图片：hello ![](uri) world ────────────────────────────────
  {
    const text = `hello ${imageMd} world`;
    const pages = splitMarkdownPages(text, { charBudget: BUDGET });
    ok(isContiguousCover(text, pages), '2 页区间连续且恰好覆盖全文');
    ok(startLinesOk(text, pages), '2 startLine 正确');
    eq(partialDataUriPages(text, pages, uri).length, 0, '2 无半截 data URI');
    const imagePage = pages.find((p) => text.slice(p.start, p.end).includes(imageMd));
    ok(!!imagePage, '2 存在含完整图片的页');
    ok(pages.some((p) => text.slice(p.start, p.end) === 'hello '), '2 图片前文本独立成页');
    ok(pages.some((p) => text.slice(p.start, p.end) === ' world'), '2 图片后文本独立成页');
    console.log(`  case2 pages=${pages.length} lengths=${JSON.stringify(pages.map((p) => p.end - p.start))}`);
  }

  // ── 3. 同一段两张图片：每张整段独占一页 ──────────────────────────────
  {
    const text = `one ${imageMd} two ${imageB} three`;
    const pages = splitMarkdownPages(text, { charBudget: BUDGET });
    ok(isContiguousCover(text, pages), '3 页区间连续且恰好覆盖全文');
    ok(startLinesOk(text, pages), '3 startLine 正确');
    eq(partialDataUriPages(text, pages, [uri, uriB]).length, 0, '3 图片 A/B 均无半截');
    const aPages = pages.filter((p) => text.slice(p.start, p.end).includes(imageMd));
    const bPages = pages.filter((p) => text.slice(p.start, p.end).includes(imageB));
    eq(aPages.length, 1, '3 图片 A 独占一页');
    eq(bPages.length, 1, '3 图片 B 独占一页');
    ok(aPages[0] !== bPages[0], '3 两张图片不在同一页');
    console.log(`  case3 pages=${pages.length} lengths=${JSON.stringify(pages.map((p) => p.end - p.start))}`);
  }

  // ── 4. 围栏代码块内的长 data URI：保持旧超长块行为 ────────────────────
  {
    const text = '```\n' + 'data:image/png;base64,' + 'A'.repeat(340000) + '\n```';
    const pages = splitMarkdownPages(text, { charBudget: BUDGET });
    ok(pages.length > 1, '4 超长代码块被切成多页（旧行为）');
    ok(isContiguousCover(text, pages), '4 页区间连续且恰好覆盖全文');
    ok(
      pages.every((p) => p.end - p.start <= BUDGET),
      '4 每页长度 ≤ 预算（旧超长块硬切语义）'
    );
    console.log(`  case4 pages=${pages.length} lengths=${JSON.stringify(pages.map((p) => p.end - p.start))}`);
  }

  // ── 5. 普通文本分页不变：与旧累积逻辑的精确页边界一致 ────────────────
  {
    const text = 'aaa\n\nbbb\n\nccc\n\nddd\n\neee\n\nfff';
    const pages = splitMarkdownPages(text, { charBudget: 8 });
    eq(
      pages,
      [
        { start: 0, end: 10, startLine: 1 },
        { start: 10, end: 20, startLine: 5 },
        { start: 20, end: 28, startLine: 9 },
      ],
      '5 普通文本页边界与旧行为完全一致'
    );
    ok(isContiguousCover(text, pages), '5 普通文本连续覆盖');
    console.log(`  case5 pages=${pages.length}`);
  }
} catch (err) {
  console.error('FAIL', err && err.message ? err.message : err);
  console.error(err && err.stack ? err.stack : '');
  process.exit(1);
}

console.log(`OK ${count} assertions`);
