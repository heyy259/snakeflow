// 期 13（Phase 0）纯 Node 单测：classifyStreamChange 通知分类 + 结构标签判定。
//
// 为什么不用浏览器 / 不连 snakeeats：classify.js 是纯函数（无 React / DOM / ws 依赖），
// Node 直接 import 即可断言分类契约，比 e2e 冒烟快且稳。重点覆盖 BLOCKER B1：
// metadata 事件携带 `edge.*` / `canvas` 结构标签时必须判为 structural（触发重投影）；
// 普通 metadata（title / description / 普通标签）仍为缓存级 metadata；以及各正文
// 事件类型的 mode（append 增量 vs 其余全量）与方法名误报（replace_range 等 → ignore）。
// 运行：node scripts/smoke-se-classify-unit.mjs（全绿退出码 0，任一断言失败退出码 1）。

import { CANVAS_TAG_KEY, isStructuralTagKey, touchesStructuralTags, classifyStreamChange } from '../src/se/classify.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 200) : ''}`);
};

try {
  // ── 1. 结构标签键判定 ────────────────────────────────────────────────
  check(
    '1 isStructuralTagKey：canvas 精确命中（常量导出）',
    CANVAS_TAG_KEY === 'canvas' && isStructuralTagKey(CANVAS_TAG_KEY) === true,
    `CANVAS_TAG_KEY=${CANVAS_TAG_KEY}`
  );
  check('1 isStructuralTagKey：edge.* 前缀命中', isStructuralTagKey('edge.target') === true);
  check(
    '1 isStructuralTagKey：普通键 / 近似键不命中',
    isStructuralTagKey('title') === false &&
      isStructuralTagKey('edge') === false &&
      isStructuralTagKey('edgeX') === false &&
      isStructuralTagKey('Canvas') === false
  );
  check(
    '1 isStructuralTagKey：非字符串容错（String 归一）',
    isStructuralTagKey(null) === false && isStructuralTagKey(undefined) === false && isStructuralTagKey(123) === false
  );

  // ── 2. tags dict 结构判定 ────────────────────────────────────────────
  check(
    '2 touchesStructuralTags：空 / 普通标签 → false',
    touchesStructuralTags({}) === false && touchesStructuralTags({ title: 't', description: 'd' }) === false
  );
  check('2 touchesStructuralTags：canvas（含 false 值）→ true', touchesStructuralTags({ canvas: 'false' }) === true);
  check('2 touchesStructuralTags：edge.* → true', touchesStructuralTags({ 'edge.x': '' }) === true);
  check(
    '2 touchesStructuralTags：非对象 / 数组 → false',
    touchesStructuralTags(null) === false &&
      touchesStructuralTags(undefined) === false &&
      touchesStructuralTags('canvas') === false &&
      touchesStructuralTags([{ canvas: 'x' }]) === false
  );

  // ── 3. 畸形 / 未知通知 → ignore ──────────────────────────────────────
  const ignoreCases = [
    ['缺失 params', undefined],
    ['null params', null],
    ['缺失 name', { change: { type: 'append' } }],
    ['空 name', { name: '', change: { type: 'append' } }],
    ['缺失 change', { name: 'a' }],
    ['change 无 type', { name: 'a', change: {} }],
    ['未知事件类型', { name: 'a', change: { type: 'nope' } }],
    ['方法名 replace_range 误报', { name: 'a', change: { type: 'replace_range' } }],
    ['方法名 replace_lines 误报', { name: 'a', change: { type: 'replace_lines' } }],
    ['方法名 delete_lines 误报', { name: 'a', change: { type: 'delete_lines' } }],
  ];
  for (const [label, params] of ignoreCases) {
    const r = classifyStreamChange(params);
    check(`3 ${label} → ignore`, r.kind === 'ignore' && typeof r.reason === 'string' && r.reason.length > 0, JSON.stringify(r));
  }

  // ── 4. metadata：普通 → 缓存级；带结构标签 → structural（B1）────────
  const metaPlain = classifyStreamChange({
    name: 'a',
    change: { type: 'metadata', metadata: { title: '新标题', description: 'd', tags: { title: 'x', owner: 'me' } } },
  });
  check(
    '4 metadata 普通（title/description/普通 tags）→ metadata structural:false',
    metaPlain.kind === 'metadata' &&
      metaPlain.structural === false &&
      metaPlain.name === 'a' &&
      metaPlain.metadata &&
      metaPlain.metadata.title === '新标题',
    JSON.stringify(metaPlain)
  );
  const metaNoTags = classifyStreamChange({ name: 'a', change: { type: 'metadata', metadata: { title: 't' } } });
  check(
    '4 metadata 无 tags 字段 → metadata structural:false',
    metaNoTags.kind === 'metadata' && metaNoTags.structural === false && metaNoTags.metadata.title === 't',
    JSON.stringify(metaNoTags)
  );
  const metaEdge = classifyStreamChange({ name: 'a', change: { type: 'metadata', metadata: { tags: { 'edge.b': '' } } } });
  check(
    '4 metadata 带 edge.x → structural metadata-structural（B1）',
    metaEdge.kind === 'structural' && metaEdge.reason === 'metadata-structural' && metaEdge.name === 'a',
    JSON.stringify(metaEdge)
  );
  const metaCanvas = classifyStreamChange({ name: 'a', change: { type: 'metadata', metadata: { tags: { canvas: 'false' } } } });
  check(
    '4 metadata 带 canvas:false → structural metadata-structural（B1）',
    metaCanvas.kind === 'structural' && metaCanvas.reason === 'metadata-structural',
    JSON.stringify(metaCanvas)
  );
  // B1 反向陷阱：metadata 载荷恒带完整 tags，但 field=title/description 时 tags 未变，
  // 即使 tags 含 edge./canvas 也不得判结构（否则带边流改标题会白重投影）。
  const metaTitleWithEdge = classifyStreamChange({
    name: 'a',
    change: { type: 'metadata', field: 'title', metadata: { title: 't', tags: { 'edge.b': '' } } },
  });
  check(
    '4 field=title 且 tags 含 edge.* → metadata structural:false（全量 tags 陷阱）',
    metaTitleWithEdge.kind === 'metadata' && metaTitleWithEdge.structural === false,
    JSON.stringify(metaTitleWithEdge)
  );
  const metaDescWithCanvas = classifyStreamChange({
    name: 'a',
    change: { type: 'metadata', field: 'description', metadata: { description: 'd', tags: { canvas: 'false' } } },
  });
  check(
    '4 field=description 且 tags 含 canvas → metadata structural:false',
    metaDescWithCanvas.kind === 'metadata' && metaDescWithCanvas.structural === false,
    JSON.stringify(metaDescWithCanvas)
  );
  const metaTagsEdge = classifyStreamChange({
    name: 'a',
    change: { type: 'metadata', field: 'tags', metadata: { tags: { 'edge.b': '' } } },
  });
  check(
    '4 field=tags 且含 edge.* → structural（真正结构）',
    metaTagsEdge.kind === 'structural' && metaTagsEdge.reason === 'metadata-structural',
    JSON.stringify(metaTagsEdge)
  );

  // ── 5. 生命周期结构事件 ──────────────────────────────────────────────
  for (const type of ['rename', 'created', 'deleted']) {
    const r = classifyStreamChange({ name: 'a', change: { type } });
    check(`5 ${type} → structural（reason=${type}）`, r.kind === 'structural' && r.reason === type && r.name === 'a', JSON.stringify(r));
  }

  // ── 6. 正文事件 mode：append 增量；其余全量 ──────────────────────────
  const append = classifyStreamChange({ name: 'a', change: { type: 'append' } });
  check(
    '6 append → content mode:append',
    append.kind === 'content' && append.mode === 'append' && append.changeType === 'append' && append.name === 'a',
    JSON.stringify(append)
  );
  for (const type of ['set', 'insert', 'delete', 'replace', 'rollback', 'append_cancelled']) {
    const r = classifyStreamChange({ name: 'a', change: { type } });
    check(
      `6 ${type} → content mode:full`,
      r.kind === 'content' && r.mode === 'full' && r.changeType === type,
      JSON.stringify(r)
    );
  }

  // ── 7. name 归一为字符串 ─────────────────────────────────────────────
  const numName = classifyStreamChange({ name: 123, change: { type: 'append' } });
  check('7 name 非字符串 → String 归一', numName.kind === 'content' && numName.name === '123', JSON.stringify(numName));
} catch (err) {
  check('单测执行', false, err.stack || String(err));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
