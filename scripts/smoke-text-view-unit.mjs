// 文本视图 YAML 往返纯 Node 单测：逻辑图序列化 → 解析回对象；非法输入抛错。
// 运行：node scripts/smoke-text-view-unit.mjs（全绿退出码 0）。
import assert from 'node:assert/strict';
import { serializeTextView, parseTextView } from '../src/textView.js';

const nodes = [
  { id: 'n-1', position: { x: 0, y: 0 }, data: { name: 'A', content: 'hi' } },
  { id: 'n-2', position: { x: 5, y: 5 }, data: { name: 'H', fields: [{ key: 'canvas', value: 'false' }] } },
];
const edges = [{ source: 'n-1', target: 'n-2', label: 'x' }];
const yaml = serializeTextView(nodes, edges);
assert.match(yaml, /^nodes:/m);
assert.match(yaml, /name: A/);
// 隐藏流（canvas:false）不进入文本视图，其边一并过滤。
assert.ok(!/name: H/.test(yaml), '隐藏流不应出现在文本视图');
const round = parseTextView(yaml);
assert.deepEqual(round, { nodes: [{ id: 'n-1', name: 'A', content: 'hi' }], edges: [] });

// 安全：非法输入抛错而非静默。
assert.throws(() => parseTextView('a: [1, 2'));
console.log('smoke-text-view-unit: OK');
