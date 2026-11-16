// 纯 Node 单测：单边清单构造 + 结果归一（零 IO/网络/DOM）。
import assert from 'node:assert/strict';
import {
  buildToolsOnlyManifest,
  buildStreamsOnlyManifest,
  summarizeManifestResult,
} from '../src/se/manifest.js';

// 工具单边清单
const tm = buildToolsOnlyManifest(
  { beta: { name: 'beta', description: 'b', tool_path: 'p/b.py' },
    alpha: { name: 'alpha', description: 'a', tool_path: 'p/a.py' } },
  'sys1'
);
assert.equal(tm.$schema, 'snake-manifest-v1');
assert.deepEqual(tm.streams, []);
assert.deepEqual(Object.keys(tm.tools).sort(), ['alpha', 'beta']);
assert.equal(tm.tools.alpha.tool_path, 'p/a.py');
assert.match(tm.id, /^sys1#/);

// 流单边清单
const sm = buildStreamsOnlyManifest([{ name: 's1', tags: {} }], 'sys1');
assert.deepEqual(sm.tools, {});
assert.equal(sm.streams[0].name, 's1');
assert.match(sm.id, /^sys1#/);

// 空输入容错
assert.deepEqual(buildToolsOnlyManifest(null).tools, {});
assert.deepEqual(buildToolsOnlyManifest([]).tools, {});
assert.deepEqual(buildStreamsOnlyManifest(undefined).streams, []);

// 结果归一：versions 与既有字段原样保留，缺省补 0
const sum = summarizeManifestResult({
  streams: { created: 1, updated: 0, skipped: 0, unchanged: 0, failed: 0, versions: { s1: 7 } },
  tools: { registered: 2, updated: 0, skipped: 0, failed: 1 },
  errors: ['x'], warnings: [],
});
assert.equal(sum.streams.created, 1);
assert.equal(sum.streams.versions.s1, 7);
assert.equal(sum.tools.registered, 2);
assert.deepEqual(sum.errors, ['x']);
const empty = summarizeManifestResult(undefined);
assert.equal(empty.streams.created, 0);
assert.equal(empty.tools.failed, 0);
assert.deepEqual(empty.errors, []);

console.log('smoke-register-unit: OK');
