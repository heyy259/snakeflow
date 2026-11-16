// P2 图片嵌入纯函数单测（零浏览器）：
// data URI 字节估算 / 源文件准入 / SVG 识别 / DataTransfer 文件收集与去重。
// 不测 canvas 与 createImageBitmap（Node 无 DOM），它们由浏览器手测覆盖。
// 运行：node scripts/smoke-image-embed-unit.mjs（全绿退出码 0）。
import assert from 'node:assert/strict';
import {
  estimateDataUrlBytes,
  isSupportedImageFile,
  isSvgFile,
  MAX_SOURCE_BYTES,
  SUPPORTED_IMAGE_MIME,
} from '../src/editor/imageEmbed.js';
import { collectImageFiles } from '../src/editor/imagePastePlugin.js';

let count = 0;
const ok = (cond, msg, detail = '') => {
  assert.ok(cond, `${msg}${detail ? ` | ${detail}` : ''}`);
  count += 1;
};
const eq = (actual, expected, msg) => {
  assert.deepEqual(actual, expected, msg);
  count += 1;
};

try {
  // ── 1. estimateDataUrlBytes ────────────────────────────────────────────
  eq(estimateDataUrlBytes('data:image/png;base64,AAAA'), 3, 'AAAA -> 3 bytes');
  eq(estimateDataUrlBytes('data:image/png;base64,AAA='), 2, 'AAA= -> 2 bytes（1 个 padding）');
  eq(estimateDataUrlBytes('data:image/png;base64,AA=='), 1, 'AA== -> 1 byte（2 个 padding）');
  eq(estimateDataUrlBytes('data:image/png;base64,'), 0, '空 payload -> 0');
  eq(estimateDataUrlBytes('data:image/png;base64'), 0, '缺逗号 -> 0');
  eq(estimateDataUrlBytes('not-a-data-url'), 0, '非 data URI -> 0');
  eq(estimateDataUrlBytes(''), 0, '空字符串 -> 0');
  eq(estimateDataUrlBytes(null), 0, 'null -> 0');
  eq(estimateDataUrlBytes(undefined), 0, 'undefined -> 0');
  // 换行/空白不应让估算崩掉
  eq(estimateDataUrlBytes('data:image/png;base64,AA\nAA'), 3, '含换行的 payload 仍可估算');

  // ── 2. isSupportedImageFile ────────────────────────────────────────────
  ok(SUPPORTED_IMAGE_MIME.test('image/png'), 'png 在允许 MIME 内');
  ok(SUPPORTED_IMAGE_MIME.test('image/jpeg'), 'jpeg 在允许 MIME 内');
  ok(SUPPORTED_IMAGE_MIME.test('image/jpg'), 'jpg 别名在允许 MIME 内');
  ok(!SUPPORTED_IMAGE_MIME.test('image/svg+xml'), 'svg 不在允许 MIME 内');

  ok(isSupportedImageFile({ type: 'image/png', size: 100 }), 'image/png 100B 合法');
  ok(isSupportedImageFile({ type: 'image/webp', size: 1 }), 'image/webp 合法');
  ok(!isSupportedImageFile({ type: 'image/svg+xml', size: 100 }), 'SVG 拒绝');
  ok(!isSupportedImageFile({ type: 'image/png', size: 0 }), '零字节拒绝');
  ok(!isSupportedImageFile({ type: 'text/plain', size: 100 }), '非图片 MIME 拒绝');
  ok(!isSupportedImageFile({ type: '', size: 100 }), '空 MIME 拒绝');
  ok(!isSupportedImageFile(null), 'null 拒绝');
  ok(!isSupportedImageFile(undefined), 'undefined 拒绝');
  ok(
    !isSupportedImageFile({ type: 'image/png', size: MAX_SOURCE_BYTES + 1 }),
    '超过 32MiB 拒绝（+1）'
  );
  ok(
    isSupportedImageFile({ type: 'image/png', size: MAX_SOURCE_BYTES }),
    '恰好 32MiB 允许'
  );

  // ── 3. isSvgFile ──────────────────────────────────────────────────────
  ok(isSvgFile({ type: 'image/svg+xml' }), 'type=image/svg+xml 是 SVG');
  ok(isSvgFile({ type: '', name: 'shot.SVG' }), '扩展名 .SVG 是 SVG');
  ok(!isSvgFile({ type: 'image/png', name: 'shot.png' }), 'png 不是 SVG');
  ok(!isSvgFile(null), 'null 不是 SVG');

  // ── 4. collectImageFiles ──────────────────────────────────────────────
  const pngA = { name: 'a.png', size: 10, type: 'image/png' };
  const pngADupItem = { name: 'a.png', size: 10, type: 'image/png' };
  const jpgB = { name: 'b.jpg', size: 20, type: 'image/jpeg' };
  const svgC = { name: 'c.svg', size: 30, type: 'image/svg+xml' };
  const txtD = { name: 'd.txt', size: 40, type: 'text/plain' };

  const dataTransfer = {
    files: [pngA, jpgB, svgC, txtD],
    items: [
      { kind: 'file', type: 'image/png', getAsFile: () => pngADupItem }, // 与 files 重复（name+size）
      { kind: 'file', type: 'image/jpeg', getAsFile: () => jpgB }, // 与 files 重复（引用）
      { kind: 'string', type: 'text/plain', getAsFile: () => txtD }, // 非 file 项忽略
      { kind: 'file', type: 'image/gif', getAsFile: () => ({ name: 'e.gif', size: 5, type: 'image/gif' }) },
      { kind: 'file', type: 'image/png', getAsFile: () => null }, // getAsFile 返回 null 忽略
    ],
  };
  const collected = collectImageFiles(dataTransfer);
  eq(collected.length, 3, 'files+items 合并去重后为 3');
  eq(
    collected.map((f) => f.name),
    ['a.png', 'b.jpg', 'e.gif'],
    '保留顺序、去重、过滤非图片'
  );
  ok(collected[0] === pngA || collected[0].name === 'a.png', '重复项保留首个');
  ok(!collected.includes(svgC), 'SVG 被过滤');
  ok(!collected.includes(txtD), '文本文件被过滤');
  eq(collectImageFiles(null), [], 'null DataTransfer -> []');
  eq(collectImageFiles({}), [], '空对象 DataTransfer -> []');
  eq(collectImageFiles({ files: [txtD] }), [], '只有非图片 -> []');

  console.log(`OK ${count} assertions`);
} catch (err) {
  console.error('FAIL:', (err && err.stack) || err);
  process.exit(1);
}
