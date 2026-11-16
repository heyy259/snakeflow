// 期 4 schema 收敛纯 Node 单测：`projectStreams` 的落点优先级 + 尺寸播种。
//
// 覆盖 `opts.layout`（常驻布局表，v5 单一载体）——新流按记录落点（优先于视口中心），
// prev 命中仍以画布坐标为真源；prev 无 style 时按 layout[name] 的 width/height 播种
// out.style（只写有定义的键），prev.style 优先覆盖播种。同时回归 removedIds 与 tags→fields。
// 零 SE、零 DOM。
// 运行：node scripts/smoke-se-projection-unit.mjs（全绿退出码 0）。
import { projectStreams, splitMissing } from '../src/se/streams.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 180) : ''}`);
};

try {
  const list = [
    { name: 'alpha', tags: {} },
    { name: 'beta', tags: { canvas: 'false' } },
  ];

  // ── 1. prev 命中：画布坐标优先（不被 layout 覆盖）+ prev.style 尺寸优先 ──
  const prev = [{ id: 's-alpha', position: { x: 7, y: 9 }, data: {}, style: { width: 300 } }];
  const r1 = projectStreams(list, prev, { layout: { alpha: { x: 100, y: 100, width: 200, height: 90 } } });
  const a1 = r1.nodes.find((n) => n.id === 's-alpha');
  check(
    '1 prev 命中：保留画布坐标（layout 不覆盖）+ prev.style 优先（不重播种尺寸）',
    a1.position.x === 7 && a1.position.y === 9 && a1.style?.width === 300 && !('height' in (a1.style || {})),
    JSON.stringify({ pos: a1.position, style: a1.style })
  );

  // ── 2. layout 播种：新流按记录落点 + 宽高进 style ───────────────────────
  const r2 = projectStreams(list, [], {
    center: { x: 500, y: 500 },
    layout: {
      alpha: { x: 1, y: 2, width: 120 },
      beta: { x: -12, y: 34, width: 180, height: 70 },
    },
  });
  const b2 = r2.nodes.find((n) => n.id === 's-beta');
  const a2 = r2.nodes.find((n) => n.id === 's-alpha');
  check(
    '2 layout：新流按记录落点（非 center）+ 宽高播种 style',
    b2.position.x === -12 && b2.position.y === 34 && b2.style?.width === 180 && b2.style?.height === 70,
    JSON.stringify({ pos: b2.position, style: b2.style })
  );
  check(
    '2 layout 尺寸播种：只写有定义的键（alpha 仅 width，无 height）',
    a2.style?.width === 120 && !('height' in (a2.style || {})),
    JSON.stringify(a2.style)
  );

  // ── 2b. prev 命中但无 style：按 layout[name] 宽高播种 out.style ─────────
  const prevBeta = [{ id: 's-beta', position: { x: 5, y: 6 }, data: {} }];
  const r2b = projectStreams([{ name: 'beta', tags: {} }], prevBeta, {
    layout: { beta: { x: 999, y: 999, width: 160, height: 48 } },
  });
  const b2b = r2b.nodes.find((n) => n.id === 's-beta');
  check(
    '2b prev 无 style：保留画布坐标 + 按 layout 宽高播种 style',
    b2b.position.x === 5 && b2b.position.y === 6 && b2b.style?.width === 160 && b2b.style?.height === 48,
    JSON.stringify({ pos: b2b.position, style: b2b.style })
  );

  // ── 3. 无 layout：回落 center 附近对齐网格错开（center 取 GRID 整数倍避免 snap 抖动）─
  const r3 = projectStreams([{ name: 'solo', tags: {} }], [], { center: { x: 192, y: 320 } });
  check(
    '3 无 layout：新流落 center（对齐网格）+ 无 style',
    r3.nodes[0].position.x === 192 && r3.nodes[0].position.y === 320 && !('style' in r3.nodes[0]),
    JSON.stringify(r3.nodes[0])
  );

  // ── 4. confirmedRemoved：只有显式确认的流才移出，本地 n-* 保留 ─────────
  const r4 = projectStreams(
    [{ name: 'alpha', tags: {} }],
    [
      { id: 's-alpha', position: { x: 0, y: 0 }, data: {} },
      { id: 's-gone', position: { x: 0, y: 0 }, data: {} },
      { id: 'n-local', position: { x: 0, y: 0 }, data: {} },
    ],
    { confirmedRemoved: new Set(['gone']) }
  );
  check(
    '4 confirmedRemoved：只列确认删除的 s-*（不含 n-*）',
    r4.removedIds.length === 1 && r4.removedIds[0] === 's-gone',
    JSON.stringify(r4.removedIds)
  );

  // ── 4b. keepMissing（默认）：未确认缺失必须保留（含坐标/内容/source） ──
  const prevMissing = [{
    id: 's-missing',
    type: 'agent',
    position: { x: 12, y: 34 },
    style: { width: 280, height: 90 },
    data: {
      name: 'missing',
      content: '正文',
      contentState: 'loaded',
      source: { file_path: 'graphs/x.streams/missing.md', encoding: 'utf-8' },
      contentWindow: { absStart: 3, absEnd: 9 },
    },
  }];
  const r4b = projectStreams([{ name: 'alpha', tags: {} }], prevMissing, {});
  const kept4b = r4b.nodes.find((n) => n.id === 's-missing');
  check(
    '4b keepMissing 默认：缺失流节点保留（坐标/样式/正文/source 不丢）',
    !!kept4b &&
      kept4b.position.x === 12 && kept4b.position.y === 34 &&
      kept4b.style.width === 280 && kept4b.style.height === 90 &&
      kept4b.data.content === '正文' && kept4b.data.contentState === 'loaded' &&
      kept4b.data.source.file_path === 'graphs/x.streams/missing.md' &&
      kept4b.data.contentWindow.absStart === 3,
    JSON.stringify(kept4b)
  );
  check(
    '4b keepMissing 默认：removedIds 为空、keptMissingIds 记录缺失 id',
    r4b.removedIds.length === 0 &&
      r4b.keptMissingIds.length === 1 && r4b.keptMissingIds[0] === 's-missing' &&
      r4b.keptMissingNames[0] === 'missing',
    JSON.stringify({ removedIds: r4b.removedIds, kept: r4b.keptMissingIds })
  );

  // ── 4c. keepMissing=false（逃生舱）：退回旧语义 ─────────────────────────
  const r4c = projectStreams([{ name: 'alpha', tags: {} }], prevMissing, { keepMissing: false });
  check(
    '4c keepMissing=false：缺失流按旧语义移出',
    r4c.removedIds.length === 1 && r4c.removedIds[0] === 's-missing' && !r4c.nodes.some((n) => n.id === 's-missing'),
    JSON.stringify(r4c.removedIds)
  );

  // ── 4d. splitMissing：confirmed / unexpected 分类 ──────────────────────
  const sm = splitMissing(
    [{ id: 's-alpha' }, { id: 's-user-deleted' }, { id: 's-lost' }, { id: 'n-local' }],
    [{ name: 'alpha' }],
    new Set(['user-deleted'])
  );
  check(
    '4d splitMissing：只把 confirmed 归为已确认，其余为待修复',
    sm.missingIds.length === 2 &&
      sm.confirmedIds.length === 1 && sm.confirmedNames[0] === 'user-deleted' &&
      sm.unexpectedIds.length === 1 && sm.unexpectedNames[0] === 'lost' &&
      !sm.missingIds.includes('n-local'),
    JSON.stringify(sm)
  );

  // ── 5. tags→fields + name 即 SE name（含 canvas 标签）+ CJK name ─────────
  const b5 = r1.nodes.find((n) => n.id === 's-beta');
  const r5cn = projectStreams([{ name: '中文流', tags: {} }], [], {});
  check(
    '5 投影：data.name = SE name、tags→fields（含 canvas=false）',
    b5.data.name === 'beta' &&
      Array.isArray(b5.data.fields) &&
      b5.data.fields.some((f) => f.key === 'canvas' && String(f.value) === 'false'),
    JSON.stringify(b5.data)
  );
  check('5 投影：CJK name 原生映射（s-中文流）', r5cn.nodes[0].id === 's-中文流' && r5cn.nodes[0].data.name === '中文流', JSON.stringify(r5cn.nodes[0]));
} catch (err) {
  check('单测执行', false, err.stack || String(err));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
