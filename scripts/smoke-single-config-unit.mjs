// 纯 Node 单测：单边配置导入识别 + writePackageFiles（零网络/DOM）。
import assert from 'node:assert/strict';
import { parseToolImport, classifyStreamImport, streamFromManifest } from '../src/se/singleConfig.js';
import { writePackageFiles } from '../src/se/paths.js';

// ── parseToolImport：.se.json 工具包 ──
const toolPkg = JSON.stringify({
  $schema: 'snake-manifest-v1', id: 'x',
  streams: [], tools: { oc_server: { description: 'd', tool_path: 'p/a.py' } },
});
const t1 = parseToolImport(toolPkg);
assert.equal(t1.ok, true);
assert.equal(t1.tool.name, 'oc_server');
assert.equal(t1.tool.tool_path, 'p/a.py');

// ── parseToolImport：旧 .tool.json（schema 标记）→ 报错 ──
const legacyTool = JSON.stringify({ $schema: 'reactflow/tool-file-v1', name: 'x', tool_path: 'p' });
const t2 = parseToolImport(legacyTool);
assert.equal(t2.ok, false);
assert.match(t2.error, /废弃|不支持/);

// ── parseToolImport：裸定义（无 tools 键）→ 报错 ──
const t3 = parseToolImport(JSON.stringify({ name: 'x', description: 'd', tool_path: 'p' }));
assert.equal(t3.ok, false);

// ── classifyStreamImport ──
assert.deepEqual(classifyStreamImport('a/b/c.se.json', 'anything'), { kind: 'manifest' });
const raw = classifyStreamImport('a/b/复盘.md', '# 正文\n第二行');
assert.equal(raw.kind, 'raw');
assert.equal(raw.name, '复盘');
assert.equal(raw.content, '# 正文\n第二行');
const legacy = classifyStreamImport('a/b/x.md', '---\ngenerator: "reactflow/stream-file-v1"\nname: "x"\n---\nbody');
assert.equal(legacy.kind, 'legacy');

// ── streamFromManifest ──
const man = { streams: [{ name: 's1', description: 'dd', tags: { canvas: 'false' } }], tools: {} };
const s1 = streamFromManifest(man, new Map([['s1', 'hello']]));
assert.deepEqual(s1, { ok: true, name: 's1', content: 'hello', description: 'dd', tags: { canvas: 'false' }, source: null });
// 外部文档写回：清单内相对 source 原样带回（调用方按清单目录解析为绝对路径后登记）
const manSrc = { streams: [{ name: 's2', source: { file_path: 'pkg.streams/a.md', encoding: 'utf-8' } }], tools: {} };
const s1b = streamFromManifest(manSrc, new Map());
assert.deepEqual(s1b.source, { file_path: 'pkg.streams/a.md', encoding: 'utf-8' });
const s2 = streamFromManifest({ streams: [], tools: {} }, new Map());
assert.equal(s2.ok, false);

// ── writePackageFiles：兄弟→目录，manifest→picked ──
const writes = [];
const fakeWrite = async (p, text) => writes.push([p, text]);
await writePackageFiles(
  [
    { relPath: 's1.streams/a.md', text: 'body' },
    { relPath: 's1.se.json', text: '{}' },
  ],
  'D:/out/mypack.se.json',
  fakeWrite
);
assert.deepEqual(writes, [
  ['D:/out/s1.streams/a.md', 'body'],
  ['D:/out/mypack.se.json', '{}'],
]);

console.log('smoke-single-config-unit: OK');
