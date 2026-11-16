// Task6 纯函数单测：运行时边对齐决策（src/se/edgeAlign.js）。
// 零 IO / 网络 / DOM；覆盖：双 schema 边来源、幂等跳过、label 传递、pending 端点跳过、
// 源/目标不在 SE 的悬空保护、自环、同键去重。
import assert from 'node:assert/strict';
import { collectDocumentEdges, planEdgeAlignOps } from '../src/se/edgeAlign.js';

// ── collectDocumentEdges：两处并集（顶层 edges + system.graph.edges） ──
{
  const doc = {
    edges: [
      { source: 's-甲', target: 's-乙', label: '去乙' },
      { source: 's-甲', target: 's-乙', label: '重复应去重' }, // 同向重复 → 取首条
      { source: '', target: 's-乙' }, // 空 source → 丢
      { source: 's-丙' }, // 缺 target → 丢
    ],
    system: { graph: { edges: [{ source: 's-乙', target: 's-甲', label: '回来' }] } },
  };
  const edges = collectDocumentEdges(doc);
  assert.equal(edges.length, 2, JSON.stringify(edges));
  assert.deepEqual(edges[0], { source: 's-甲', target: 's-乙', label: '去乙' });
  assert.deepEqual(edges[1], { source: 's-乙', target: 's-甲', label: '回来' });
  // 无 label → ''；缺字段容错
  const bare = collectDocumentEdges({ edges: [{ source: 's-甲', target: 's-乙' }] });
  assert.equal(bare[0].label, '');
  assert.deepEqual(collectDocumentEdges(null), []);
  assert.deepEqual(collectDocumentEdges({}), []);
}

// ── planEdgeAlignOps：核心决策 ──
{
  const streams = [
    { name: '甲', tags: {} },
    { name: '乙', tags: {} },
    { name: '丙', tags: { 'edge.甲': '已有' } },
  ];
  const edges = [
    { source: 's-甲', target: 's-乙', label: '去乙' }, // 缺 → 写入
    { source: 's-乙', target: 's-甲' }, // 缺、无 label → value ''
    { source: 's-丙', target: 's-甲', label: '已有' }, // source 已有 edge.甲 → 幂等跳过
    { source: 's-甲', target: 'n-9', label: 'x' }, // target pending → 跳过
    { source: 'n-8', target: 's-甲', label: 'y' }, // source pending → 跳过
    { source: 's-缺失', target: 's-甲' }, // source 不在 SE → 跳过
    { source: 's-甲', target: 's-不存在' }, // target 不在 SE → 跳过（悬空保护）
  ];
  const ops = planEdgeAlignOps(edges, streams);
  assert.equal(ops.length, 2, JSON.stringify(ops));
  assert.deepEqual(ops[0], { source: '甲', key: 'edge.乙', value: '去乙' });
  assert.deepEqual(ops[1], { source: '乙', key: 'edge.甲', value: '' });
}

// ── 幂等：source 已有键 → 空清单（再次运行静默） ──
{
  const streams = [{ name: '甲', tags: { 'edge.乙': '旧值' } }, { name: '乙', tags: {} }];
  const ops = planEdgeAlignOps([{ source: 's-甲', target: 's-乙', label: '新值' }], streams);
  assert.deepEqual(ops, []); // 键存在即跳过，不比较值
}

// ── 自环：s-甲 → s-甲 ──
{
  const streams = [{ name: '甲', tags: {} }];
  const ops = planEdgeAlignOps([{ source: 's-甲', target: 's-甲', label: '自环' }], streams);
  assert.deepEqual(ops, [{ source: '甲', key: 'edge.甲', value: '自环' }]);
}

// ── 同键去重：文档双写同一 source+target（不同 label）→ 仅一条 ──
{
  const streams = [{ name: '甲', tags: {} }, { name: '乙', tags: {} }];
  const ops = planEdgeAlignOps(
    [
      { source: 's-甲', target: 's-乙', label: 'first' },
      { source: 's-甲', target: 's-乙', label: 'second' },
    ],
    streams
  );
  assert.equal(ops.length, 1);
  assert.equal(ops[0].value, 'first'); // 首条胜出
}

// ── 容错：非数组 / tags 缺失 ──
{
  assert.deepEqual(planEdgeAlignOps(null, null), []);
  assert.deepEqual(planEdgeAlignOps([{ source: 's-甲', target: 's-乙' }], [{ name: '甲' }, { name: '乙' }]), [
    { source: '甲', key: 'edge.乙', value: '' },
  ]);
}

console.log('PASS  smoke-edge-align-unit（edgeAlign.js 纯函数）');
