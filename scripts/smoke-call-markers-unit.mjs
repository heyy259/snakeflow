// 阶段 A2（原文保真写入）纯 Node 单测：`splitCallMarkers` 切分 + remark 序列化往返。
//
// 验收（去Mock与原文写入改造方案 §4.4）：完整 `@{name|params}` 经 parse→serialize 逐字节不变
// 且不出现 `\_`；非标记正文的字面下划线转义行为与默认序列化器完全一致。
// 往返方案：unified + remark-parse + remark-stringify（均在 node_modules 顶层、与 Milkdown 同源），
// handlers.text 覆写与 MilkdownHost.jsx `remarkStringifyOptionsCtx` 内的实现同构。
// 零 SE、零 DOM、零浏览器。
// 运行：node scripts/smoke-call-markers-unit.mjs（全绿退出码 0）。
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { splitCallMarkers } from '../src/editor/callMarkers.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 180) : ''}`);
};

// 与 MilkdownHost.jsx 内 handlers.text 相同的覆写：标记片段原文输出，其余委托 state.safe。
const textHandler = (node, parent, state, info) => {
  const value = String(node.value == null ? '' : node.value);
  const parts = splitCallMarkers(value);
  if (!parts.some((p) => p.raw)) return state.safe(value, info);
  let out = '';
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i];
    if (p.raw) {
      out += p.text;
      continue;
    }
    const next = parts[i + 1];
    const before = out ? out.charAt(out.length - 1) : info.before;
    const after = next ? next.text.charAt(0) : info.after;
    out += state.safe(p.text, { ...info, before, after });
  }
  return out;
};

// 默认序列化器 / 标记感知序列化器（remark-stringify 会把 handlers 合并进默认集）。
const stringifyDefault = unified().use(remarkParse).use(remarkStringify);
const stringifyMarkers = unified().use(remarkParse).use(remarkStringify, { handlers: { text: textHandler } });

const serialize = (processor, md) => processor.processSync(md).value;
const concat = (parts) => parts.map((p) => p.text).join('');

try {
  // ── a. 单个完整标记：整串即一个 raw 片段 ─────────────────────────────
  const a = splitCallMarkers('@{script_manager_gui|{}}');
  check('a 单个标记 → 一个 raw 片段且等于全串', a.length === 1 && a[0].raw === true && a[0].text === '@{script_manager_gui|{}}', JSON.stringify(a));

  // ── b. 嵌套 JSON：按深度配平取到最外层 `}` ───────────────────────────
  const b = splitCallMarkers('@{t|{"a":{"b":1}}}');
  check('b 嵌套 JSON → raw 整串', b.length === 1 && b[0].raw === true && b[0].text === '@{t|{"a":{"b":1}}}', JSON.stringify(b));

  // ── c. JSON 字符串内含 `}`：不参与配平、不提前截断 ────────────────────
  const c = splitCallMarkers('@{t|{"s":"a}b"}}');
  check('c 字符串内 `}` → raw 整串', c.length === 1 && c[0].raw === true && c[0].text === '@{t|{"s":"a}b"}}', JSON.stringify(c));

  // ── d. JSON 字符串内转义引号：`\"` 不结束字符串 ──────────────────────
  const d = splitCallMarkers('@{t|{"s":"a\\"b"}}');
  check('d 转义引号 → raw 整串', d.length === 1 && d[0].raw === true && d[0].text === '@{t|{"s":"a\\"b"}}', JSON.stringify(d));

  // ── e. 畸形/未闭合：绝不 raw，无损降级为普通文本 ─────────────────────
  const e = splitCallMarkers('@{t|{');
  check('e 未闭合 → 无 raw 且无损', e.every((p) => !p.raw) && concat(e) === '@{t|{', JSON.stringify(e));

  // ── f. 混合散文：前正文 + 标记 + 后正文，无损且标记段 raw ────────────
  const f = splitCallMarkers('前 @{t|{}} 后');
  check('f 混合散文 → 标记段 raw 且无损', concat(f) === '前 @{t|{}} 后' && f.some((p) => p.raw && p.text === '@{t|{}}'), JSON.stringify(f));

  // ── g. 一条文本内多个标记：全部 raw ──────────────────────────────────
  const g = splitCallMarkers('@{a|{}} mid @{b|{"x":1}}');
  check('g 多标记 → 两个 raw 且无损', concat(g) === '@{a|{}} mid @{b|{"x":1}}' && g.filter((p) => p.raw).length === 2, JSON.stringify(g));

  // ── h. 纯文本无标记：无 raw ──────────────────────────────────────────
  const h = splitCallMarkers('foo_bar baz');
  check('h 无标记文本 → 无 raw', h.every((p) => !p.raw), JSON.stringify(h));

  // ── i. 往返（关键验收）：含特殊字符参数的标记逐字节不变、无 `\_` ──────
  // fixture 的反斜杠后跟非标点字符（`\s`/`\x`），是 CommonMark 下 parse→serialize 稳定的
  // 写法；`_ * [ ] ` < & #` 全部位于 raw 标记内，应零转义。
  const roundTripSrc = '@{script_manager_gui|{"path":"E:\\seafile\\x","note":"a_b * c [d] `e < f &g #h"}}';
  const roundTripDefault = serialize(stringifyDefault, roundTripSrc).replace(/\n$/, '');
  const roundTripOut = serialize(stringifyMarkers, roundTripSrc).replace(/\n$/, '');
  check('i 往返：标记逐字节不变', roundTripOut === roundTripSrc, JSON.stringify(roundTripOut));
  check('i 往返：无 `\\_`', !roundTripOut.includes('\\_'), JSON.stringify(roundTripOut));
  check('i 对照：默认序列化确实转义（证明修复点真实存在）', roundTripDefault.includes('\\_'), JSON.stringify(roundTripDefault));

  // ── j. 非标记正文行为不变：与默认序列化逐字节一致，下划线仍被转义 ────
  const proseSrc = 'foo_bar baz *em*';
  const proseDefault = serialize(stringifyDefault, proseSrc);
  const proseOut = serialize(stringifyMarkers, proseSrc);
  check('j 非标记正文：与默认序列化一致', proseOut === proseDefault, JSON.stringify({ default: proseDefault, markers: proseOut }));
  check('j 非标记正文：下划线仍被转义', proseOut.includes('\\_'), JSON.stringify(proseOut));
  // ── k. CJK 工具名：`@{中文工具|{}}` 可识别（对齐 SE 扫描器 `\w+` 的 Unicode 语义）──
  const k = splitCallMarkers('@{中文工具|{}}');
  check('k CJK 工具名 → raw 整串', k.length === 1 && k[0].raw === true && k[0].text === '@{中文工具|{}}', JSON.stringify(k));
  const k2 = splitCallMarkers('前 @{我的工具|{"a":1}} 后');
  check(
    'k CJK 工具名混合散文 → 标记段 raw 且无损',
    concat(k2) === '前 @{我的工具|{"a":1}} 后' && k2.some((p) => p.raw && p.text === '@{我的工具|{"a":1}}'),
    JSON.stringify(k2)
  );
  const k3 = splitCallMarkers('@{ab-cd|{}}');
  check('k 连字符仍不合法（name 段截断为 ab）→ 非完整标记', !k3.some((p) => p.raw), JSON.stringify(k3));
} catch (err) {
  check('单测执行', false, err.stack || String(err));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
