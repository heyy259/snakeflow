// P1 图片差分回归单测（零浏览器、零 SE）：
// 含超大内联 data URI 的文档在末尾小改动后必须仍能走多 hunk 差分，而不是回退整篇写。
// 运行：node scripts/smoke-image-diff-unit.mjs（全绿退出码 0）。
import assert from 'node:assert/strict';
import { diffCodePoints, MAX_DIFF_CODE_POINTS, MAX_DIFF_EDIT_DISTANCE, MAX_DIFF_WORK } from '../src/se/textDiff.js';

let count = 0;
const ok = (cond, msg, detail = '') => {
  assert.ok(cond, `${msg}${detail ? ` | ${detail}` : ''}`);
  count += 1;
};
const eq = (actual, expected, msg) => {
  assert.deepEqual(actual, expected, msg);
  count += 1;
};

const uri = 'data:image/png;base64,' + 'A'.repeat(340000);
const uriB = 'data:image/png;base64,' + 'B'.repeat(340000);
const prefix = 'x'.repeat(100000);
const oldText = prefix + uri;
const newText = oldText + 'edit';

try {
  ok(MAX_DIFF_CODE_POINTS === 2_000_000, 'MAX_DIFF_CODE_POINTS 已提升到 2,000,000');
  ok(MAX_DIFF_WORK === 20_000_000, 'MAX_DIFF_WORK === 20,000,000');
  ok(MAX_DIFF_EDIT_DISTANCE === 2000, 'MAX_DIFF_EDIT_DISTANCE 保持 2000');

  // ── 1. 340k 图片 + 末尾小编辑 → 单个 insert hunk ───────────────────────
  const small = diffCodePoints(oldText, newText);
  ok(small !== null, '末尾小编辑不再返回 null');
  eq(small.length, 1, '末尾小编辑恰好 1 个 hunk');
  eq(small[0].type, 'insert', 'hunk 类型为 insert');
  eq(small[0].text, 'edit', 'hunk 文本为 edit');
  eq(small[0].start, oldText.length, 'hunk 位置在文末（码点偏移）');
  ok(small[0].start > prefix.length, 'hunk 不跨越图片（位置在图片之后）');
  console.log(`  small-edit hunk=${JSON.stringify(small)}`);

  // ── 2. 完全相同的图片文档 → [] ─────────────────────────────────────────
  eq(diffCodePoints(oldText, oldText), [], '相同文本返回 []');

  // ── 3. 整张图片替换：超出工作量预算 → null（或返回覆盖整段旧图片的 hunk）──
  const replacedText = prefix + uriB;
  const replaced = diffCodePoints(oldText, replacedText);
  if (replaced === null) {
    console.log('  replace-image diff: null（超出编辑距离/工作量预算，回退整篇写）');
    ok(true, '整图替换返回 null');
  } else {
    console.log(`  replace-image diff: ${JSON.stringify(replaced)}`);
    ok(Array.isArray(replaced), '整图替换返回 hunk 数组');
    const coversImage = replaced.some((h) => h.start <= prefix.length && h.end >= oldText.length);
    ok(coversImage, '返回 hunk 时 start/end 覆盖整段旧图片');
  }

  // ── 4. 普通小文档差分不变 ─────────────────────────────────────────────
  const normal = diffCodePoints('abc', 'abXc');
  eq(
    normal,
    [{ type: 'insert', start: 2, end: 2, text: 'X' }],
    '普通小文档 insert 差分保持原行为'
  );
  eq(diffCodePoints('abc', 'abc'), [], '普通小文档 no-op 返回 []');
} catch (err) {
  console.error('FAIL', err && err.message ? err.message : err);
  console.error(err && err.stack ? err.stack : '');
  process.exit(1);
}

console.log(`OK ${count} assertions`);
