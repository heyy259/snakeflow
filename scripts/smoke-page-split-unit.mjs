// 期 15（Phase 15-A）纯 Node 单测：src/se/pageSplit.js 的 markdown 块分页与纯文本行分页。
//
// 为什么不用浏览器 / 不连 snakeeats：pageSplit.js 是纯函数（无 React / DOM 依赖），
// Node 直接 import 即可断言。重点覆盖：顶层块边界对齐（围栏代码 / 表格 / <details> 卡
// 永不拦腰切断）、页区间连续且恰好覆盖全文、startLine 为全文绝对行号、超长单块按行边界
// 内切成多页且每页 ≤ 预算、按内容字符串引用 + 预算的单槽缓存，以及行分页的整倍数 /
// 余数 / 超长单行 / CRLF。
// 运行：node scripts/smoke-page-split-unit.mjs（全绿退出码 0，任一断言失败退出码 1）。

import { splitMarkdownPages, splitLinePages } from '../src/se/pageSplit.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 200) : ''}`);
};

// 独立计算：offset 在全文中的 1 基行号。
const lineOfOffset = (content, offset) => 1 + (content.slice(0, offset).match(/\n/g) || []).length;

// 独立验证页区间连续且恰好覆盖全文。
const isContiguousCover = (content, pages) => {
  if (pages.length === 0) return content.length === 0;
  if (pages[0].start !== 0) return false;
  if (pages[pages.length - 1].end !== content.length) return false;
  for (let i = 1; i < pages.length; i++) {
    if (pages[i].start !== pages[i - 1].end) return false;
  }
  return pages.map((p) => content.slice(p.start, p.end)).join('') === content;
};

try {
  // ── 1. 空内容 / 短内容 ────────────────────────────────────────────────
  check('1 空串 → 0 页', splitMarkdownPages('', { charBudget: 100 }).length === 0);
  check('1 null → 0 页', splitMarkdownPages(null, { charBudget: 100 }).length === 0);
  check('1 undefined → 0 页', splitMarkdownPages(undefined, { charBudget: 100 }).length === 0);
  {
    const short = '# 标题';
    const pages = splitMarkdownPages(short, { charBudget: 100 });
    check(
      '1 短内容 → 恰好 1 页且覆盖全文',
      pages.length === 1 && pages[0].start === 0 && pages[0].end === short.length && pages[0].startLine === 1,
      JSON.stringify(pages)
    );
  }

  // ── 2. markdown：块边界永不拦腰切断（围栏代码 / 表格 / <details>）─────
  {
    const md = [
      'intro paragraph',
      '',
      '```js',
      'const a = 1;',
      'const b = 2;',
      '```',
      '',
      '| 列A | 列B |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '<details>',
      '<summary>更多</summary>',
      '隐藏正文',
      '</details>',
      '',
      'tail paragraph',
    ].join('\n');

    const c0 = md.indexOf('```');
    const c1 = md.indexOf('```', c0 + 3);
    const codeRegion = [c0, c1 + 3];
    const t0 = md.indexOf('| 列A');
    const tRow = md.indexOf('| 1 | 2 |');
    const tableRegion = [t0, tRow + '| 1 | 2 |'.length];
    const d0 = md.indexOf('<details>');
    const d1 = md.indexOf('</details>');
    const detailsRegion = [d0, d1 + '</details>'.length];

    const pages = splitMarkdownPages(md, { charBudget: 80 });
    check('2 多块内容 → 多于一页', pages.length > 1, `pages=${pages.length}`);
    check('2 页区间连续且恰好覆盖全文', isContiguousCover(md, pages), JSON.stringify(pages));

    const regions = [
      ['围栏代码', codeRegion],
      ['表格', tableRegion],
      ['details', detailsRegion],
    ];
    for (const [label, [rs, re]] of regions) {
      // 边界不得落在块内部
      let splitInside = false;
      for (let i = 0; i < pages.length - 1; i++) {
        const b = pages[i].end;
        if (b > rs && b < re) splitInside = true;
      }
      // 且块必须完整落在某一页内
      const home = pages.find((p) => p.start <= rs && re <= p.end);
      check(`2 ${label} 不被拦腰切断且完整落在单页内`, !splitInside && !!home, JSON.stringify({ codeRegion, pages }));
    }
  }

  // ── 3. startLine 为全文 1 基绝对行号 ─────────────────────────────────
  {
    const md = '# A\n\npara a\n\n# B\n\npara b';
    const pages = splitMarkdownPages(md, { charBudget: 12 });
    check('3 第 2 页存在', pages.length >= 2, JSON.stringify(pages));
    let allOk = true;
    for (const p of pages) {
      if (p.startLine !== lineOfOffset(md, p.start)) allOk = false;
    }
    check('3 每页 startLine == 全文绝对行号', allOk, JSON.stringify(pages));
    check('3 第 2 页 startLine === 5（# B 所在行）', pages[1] && pages[1].startLine === 5, JSON.stringify(pages));
  }

  // ── 4. 连续性：逐页 slice 拼接 === 原文 ──────────────────────────────
  {
    const md = 'aaa\n\nbbb\n\nccc\n\nddd\n\neee\n\nfff';
    const pages = splitMarkdownPages(md, { charBudget: 8 });
    check('4 markdown 逐页拼接还原全文', isContiguousCover(md, pages), JSON.stringify(pages));

    const text = 'l1\nl2\nl3\nl4\nl5\nl6\nl7';
    const lpages = splitLinePages(text, { lineBudget: 3 });
    check('4 行分页逐页拼接还原全文', isContiguousCover(text, lpages), JSON.stringify(lpages));
  }

  // ── 5. 超长单块 → 块内按行边界硬切成多页（不再独占一页）───────────────
  {
    const bigCode = '```\n' + 'x'.repeat(300) + '\n```';
    const md = 'small one\n\n' + bigCode + '\n\nsmall two';
    const codeStart = md.indexOf('```');
    const smallTwoStart = md.indexOf('small two');
    const pages = splitMarkdownPages(md, { charBudget: 50 });
    check('5 超长块 → 多于 3 页（不再独占一页）', pages.length > 3, JSON.stringify(pages));
    check(
      '5 每页长度 ≤ 预算',
      pages.every((p) => p.end - p.start <= 50),
      JSON.stringify(pages.map((p) => p.end - p.start))
    );

    const blockPages = pages.filter((p) => p.start >= codeStart && p.end <= smallTwoStart);
    check('5 超长块被切成多页', blockPages.length > 1, JSON.stringify(blockPages));
    check(
      '5 块内切分优先落在行边界（首切页尾为换行符）',
      blockPages.length > 0 && md.slice(blockPages[0].start, blockPages[0].end).endsWith('\n'),
      JSON.stringify(blockPages[0] && md.slice(blockPages[0].start, blockPages[0].end))
    );
    check('5 超长块页区间连续覆盖', isContiguousCover(md, pages), JSON.stringify(pages));
  }

  // ── 5b. 块内切分优先落在行边界（多行短内容超预算块）────────────────────
  {
    const linesCode = '```\n' + Array.from({ length: 40 }, (_, i) => 'line-' + i).join('\n') + '\n```';
    const pages = splitMarkdownPages(linesCode, { charBudget: 40 });
    check('5b 单个超预算代码块 → 多页', pages.length > 1, JSON.stringify(pages.map((p) => p.end - p.start)));
    check('5b 每页 ≤ 预算', pages.every((p) => p.end - p.start <= 40), JSON.stringify(pages));
    // 除最后一页外：每页以换行结尾，下一页起点紧跟其后且落在整行开头。
    let boundaryOk = true;
    for (let i = 0; i < pages.length - 1; i++) {
      if (!linesCode.slice(pages[i].start, pages[i].end).endsWith('\n')) boundaryOk = false;
      if (pages[i + 1].start !== pages[i].end) boundaryOk = false;
      if (pages[i + 1].start > 0 && linesCode[pages[i + 1].start - 1] !== '\n') boundaryOk = false;
    }
    check('5b 块内切分优先落在行边界（切在换行后）', boundaryOk, JSON.stringify(pages));
    check('5b 逐页拼接还原全文', isContiguousCover(linesCode, pages));
  }

  // ── 6. 单槽缓存：内容引用 + 预算 ─────────────────────────────────────
  {
    const prim = 'cache me\n\nsecond para';
    const a1 = splitMarkdownPages(prim, { charBudget: 1000 });
    const a2 = splitMarkdownPages(prim, { charBudget: 1000 });
    check('6 同一原始字符串 + 同预算 → 返回同一数组引用', a1 === a2);

    // 字符串原始值 === 是值相等，故用 String 对象构造「不同引用、内容相等」。
    const o1 = new String(prim);
    const p1 = splitMarkdownPages(o1, { charBudget: 1000 });
    const p2 = splitMarkdownPages(o1, { charBudget: 1000 });
    check('6 同一 String 对象引用 → 命中缓存', p1 === p2);
    const o2 = new String(prim);
    const p3 = splitMarkdownPages(o2, { charBudget: 1000 });
    check('6 不同引用（内容相等）→ 重算（不同数组引用）', p3 !== p1 && JSON.stringify(p3) === JSON.stringify(p1));

    const p4 = splitMarkdownPages(o1, { charBudget: 5 });
    check('6 同引用但预算不同 → 重算', p4 !== p1, JSON.stringify({ p1, p4 }));
  }

  // ── 7. splitLinePages：整倍数 / 余数 / 超长单行 / CRLF / startLine ────
  {
    // 整倍数（页尾含行尾换行符以保证连续覆盖）
    const exact = 'l1\nl2\nl3\nl4';
    const pe = splitLinePages(exact, { lineBudget: 2 });
    check('7 整倍数 → 2 页', pe.length === 2 && pe[0].start === 0 && pe[0].end === 6 && pe[1].start === 6 && pe[1].end === 11, JSON.stringify(pe));
    check('7 整倍数 startLine = [1, 3]', pe[0].startLine === 1 && pe[1].startLine === 3, JSON.stringify(pe));

    // 余数
    const rem = 'a\nb\nc';
    const pr = splitLinePages(rem, { lineBudget: 2 });
    check('7 余数 → 2 页（末页不满）', pr.length === 2 && pr[0].end === 4 && pr[1].start === 4 && pr[1].end === 5, JSON.stringify(pr));

    // 超长单行独占一页（lineBudget=1；页尾含换行符，去掉后应等于原行）
    const longLine = 'X'.repeat(50);
    const over = 'short\n' + longLine + '\nend';
    const po = splitLinePages(over, { lineBudget: 1 });
    check(
      '7 超长单行不被切断且独占一页',
      po.length === 3 && po[1].start === 6 && po[1].end === 57 && over.slice(po[1].start, po[1].end).replace(/\n$/, '') === longLine,
      JSON.stringify(po)
    );

    // CRLF
    const crlf = 'a\r\nb\r\nc';
    const pc = splitLinePages(crlf, { lineBudget: 1 });
    check('7 CRLF 逐页拼接还原全文', isContiguousCover(crlf, pc), JSON.stringify(pc));
    check('7 CRLF 三页且 startLine = [1,2,3]', pc.length === 3 && pc[0].startLine === 1 && pc[1].startLine === 2 && pc[2].startLine === 3, JSON.stringify(pc));
    check('7 CRLF 页切片保留各自换行', crlf.slice(0, 3) === 'a\r\n' && crlf.slice(3, 6) === 'b\r\n' && crlf.slice(6, 7) === 'c', JSON.stringify(pc));

    // 换行结尾不产生空尾页（console 流几乎总是 \n 结尾）
    const trailing = 'a\nb\n';
    const pt = splitLinePages(trailing, { lineBudget: 1 });
    check('7 换行结尾 → 无空尾页（2 页而非 3 页）', pt.length === 2 && pt[1].end === 4, JSON.stringify(pt));
    check('7 换行结尾仍连续覆盖全文', isContiguousCover(trailing, pt), JSON.stringify(pt));

    // 行分页缓存
    const lc = 'p\nq\nr';
    const b1 = splitLinePages(lc, { lineBudget: 2 });
    const b2 = splitLinePages(lc, { lineBudget: 2 });
    check('7 行分页同一字符串 + 同预算 → 命中缓存', b1 === b2);
  }

  // ── 8. 前导纯空白不单独成页（回归：扫描时空白首页 + 手动翻页被拉回）────────
  {
    const md = '\n\n# Title\n\nbody';
    const pages = splitMarkdownPages(md, { charBudget: 15000 });
    check('8 前导空白短文档 → 恰好 1 页（无空白首页）', pages.length === 1, JSON.stringify(pages));
    check('8 前导空白 → 连续覆盖全文', isContiguousCover(md, pages), JSON.stringify(pages));
  }
  {
    const md = '\n\n# A\n\npara a\n\n# B\n\npara b';
    const pages = splitMarkdownPages(md, { charBudget: 12 });
    check('8 前导空白多页 → 无纯空白页', pages.every((p) => md.slice(p.start, p.end).trim() !== ''), JSON.stringify(pages));
    check('8 前导空白多页 → 连续覆盖全文', isContiguousCover(md, pages), JSON.stringify(pages));
  }
  {
    // 前导空白 + 超长首块：空白并入首切页，覆盖不变量与页长上限均保持。
    const md = '\n\n' + '```\n' + 'x'.repeat(300) + '\n```';
    const pages = splitMarkdownPages(md, { charBudget: 50 });
    check('8 前导空白+超长首块 → 首页从 0 开始', pages[0].start === 0, JSON.stringify(pages));
    check('8 前导空白+超长首块 → 无纯空白页', pages.every((p) => md.slice(p.start, p.end).trim() !== ''), JSON.stringify(pages));
    check('8 前导空白+超长首块 → 每页 ≤ 预算', pages.every((p) => p.end - p.start <= 50), JSON.stringify(pages.map((p) => p.end - p.start)));
    check('8 前导空白+超长首块 → 连续覆盖全文', isContiguousCover(md, pages), JSON.stringify(pages));
  }
} catch (err) {
  check('单测执行', false, err.stack || String(err));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
