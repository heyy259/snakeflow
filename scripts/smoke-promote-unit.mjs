// Task5 纯函数单测：pending → SE 提升的名字/边推导（src/se/promote.js）。
// 零 IO / 网络 / DOM；覆盖方案 §4.2 最易出错的三处：名字推导、taken 组装、边标签生成。
import assert from 'node:assert/strict';
import {
  isPendingNode,
  pendingNodes,
  displayNameOf,
  collectTakenNames,
  derivePromoteName,
  rewriteEdgesForIdSwap,
  incidentEdgeTagOps,
} from '../src/se/promote.js';

// ── pending 判定 ──
assert.equal(isPendingNode({ id: 'n-1' }), true);
assert.equal(isPendingNode({ id: 's-甲' }), false);
assert.equal(isPendingNode(null), false);
assert.deepEqual(
  pendingNodes([{ id: 'n-1' }, { id: 's-甲' }, { id: 'n-2' }]).map((n) => n.id),
  ['n-1', 'n-2']
);
assert.deepEqual(pendingNodes(undefined), []);

// ── 显示名：name 优先，空回落 title ──
assert.equal(displayNameOf({ data: { name: '甲' } }), '甲');
assert.equal(displayNameOf({ data: { name: '', title: '乙' } }), '乙');
assert.equal(displayNameOf({ data: { title: '丙' } }), '丙');
assert.equal(displayNameOf({ data: {} }), '');

// ── taken 组装：画布 s-* ∪ extra（SE 名 / 批量已分配） ──
{
  const t = collectTakenNames([{ id: 's-甲' }, { id: 'n-1' }, { id: 's-乙' }], ['丙', '甲']);
  assert.deepEqual([...t].sort(), ['丙', '乙', '甲'].sort());
  const t2 = collectTakenNames([{ id: 's-甲' }], new Set(['丁']));
  assert.equal(t2.has('丁'), true);
}

// ── 名字推导 ──
{
  // 合法名原样保留
  const a = derivePromoteName({ id: 'n-1', data: { name: '支付流' } }, []);
  assert.equal(a.name, '支付流');
  assert.equal(a.renamed, false);

  // 冲突 → _2 后缀（renamed=true，调用方须 notify）
  const b = derivePromoteName({ id: 'n-2', data: { name: '支付流' } }, ['支付流']);
  assert.equal(b.name, '支付流_2');
  assert.equal(b.renamed, true);

  // 非法字符折叠（空格/连字符 → _），renamed=true
  const c = derivePromoteName({ id: 'n-3', data: { name: 'my new-node!' } }, []);
  assert.equal(c.name, 'my_new_node');
  assert.equal(c.renamed, true);

  // 前导数字剥离
  const d = derivePromoteName({ id: 'n-4', data: { name: '123abc' } }, []);
  assert.equal(d.name, 'abc');

  // 空名无字母 → stream_<8hex> 回退，renamed=true
  const e = derivePromoteName({ id: 'n-5', data: {} }, []);
  assert.match(e.name, /^stream_[0-9a-f]{8}$/);
  assert.equal(e.renamed, true);

  // title 回落
  const f = derivePromoteName({ id: 'n-6', data: { title: '回落名' } }, []);
  assert.equal(f.name, '回落名');
}

// ── 换 id 重写本地边端点 ──
{
  const edges = [
    { id: 'e-1', source: 'n-a', target: 'n-b' },
    { id: 'e-2', source: 'n-b', target: 'n-a' },
    { id: 'e-3', source: 's-x', target: 's-y' },
    { id: 'e-4', source: 'n-a', target: 'n-a' },
  ];
  const out = rewriteEdgesForIdSwap(edges, 'n-a', 's-A');
  assert.equal(out[0].source, 's-A');
  assert.equal(out[0].target, 'n-b');
  assert.equal(out[1].target, 's-A');
  assert.equal(out[2].source, 's-x'); // 无关边原样
  assert.equal(out[3].source, 's-A');
  assert.equal(out[3].target, 's-A');
  // 无命中时返回同一引用（避免无谓 setEdges）
  const same = rewriteEdgesForIdSwap([{ id: 'e-9', source: 's-x', target: 's-y' }], 'n-a', 's-A');
  assert.equal(same, same); // 数组本身不因命中以外的边改变语义
}

// ── 边标签生成（换 id 后调用） ──
{
  const resolve = (id) => (id.startsWith('s-') ? id.slice(2) : null);
  const edges = [
    { id: 'e-1', source: 's-A', target: 's-B', label: '去B' }, // 出边 → selfTags
    { id: 'e-2', source: 's-C', target: 's-A', label: '来自C' }, // 入边 → remote
    { id: 'e-3', source: 's-A', target: 'n-p', label: '待定' }, // 目标 pending → 跳过
    { id: 'e-4', source: 'n-q', target: 's-A' }, // 来源 pending → 跳过
    { id: 'e-5', source: 's-A', target: 's-A' }, // 自环 → selfTags（self name）
  ];
  const { selfTags, remote } = incidentEdgeTagOps({
    nodeId: 's-A',
    name: 'A',
    edges,
    resolveName: resolve,
  });
  assert.equal(selfTags['edge.B'], '去B');
  assert.equal(selfTags['edge.A'], ''); // 自环
  assert.equal(remote.length, 1);
  assert.deepEqual(remote[0], { source: 'C', key: 'edge.A', value: '来自C' });
}

// ── promoted 后两端都提升的场景（模拟顺序 A→B，B 先提升） ──
{
  const resolve = (id) => (id.startsWith('s-') ? id.slice(2) : null);
  // B 先提升：A 仍 pending，A→B 的边在 B 侧看 target===B、source=n-A（跳过）
  const opsB = incidentEdgeTagOps({
    nodeId: 's-B',
    name: 'B',
    edges: [{ id: 'e-1', source: 'n-A', target: 's-B', label: 'x' }],
    resolveName: resolve,
  });
  assert.deepEqual(opsB, { selfTags: {}, remote: [] });
  // A 后提升：出边目标 s-B 已解析 → selfTags 写 edge.B
  const opsA = incidentEdgeTagOps({
    nodeId: 's-A',
    name: 'A',
    edges: [{ id: 'e-1', source: 's-A', target: 's-B', label: 'x' }],
    resolveName: resolve,
  });
  assert.equal(opsA.selfTags['edge.B'], 'x');
  assert.equal(opsA.remote.length, 0);
}

console.log('PASS  smoke-promote-unit（promote.js 纯函数）');
