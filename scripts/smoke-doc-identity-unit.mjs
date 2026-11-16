// 纯 Node 单测：tab 级有效工作文档解析（docPath > manifest_path > null）。
// 运行：node scripts/smoke-doc-identity-unit.mjs
import assert from 'node:assert/strict';
import { workDocPathOf, toolBasePathOf, docBaseOf, findDocOwner } from '../src/tabDoc.js';
import { rewriteSourcePrefixInDoc } from '../src/document.js';
import { canonDocPath, isGraphsDocPath } from '../src/se/paths.js';

const ROOT = 'C:/work/reactflow';

const pkgTab = {
  id: 't-pkg',
  name: '显示名可以不同',
  system: { system_id: 'pkg', manifest_path: 'D:/pkgs/demo.se.json' },
};
const docTab = { id: 't-doc', name: '外部文档', docPath: 'D:/docs/foo.se.json' };
const graphsTab = { id: 't-graphs', name: '图A', docPath: 'graphs/图A.se.json' };
const draftTab = { id: 't-draft', name: '草稿' };
const forkTab = {
  id: 't-fork',
  name: '旧副本',
  docPath: 'graphs/旧副本.se.json',
  system: { system_id: 'fork', manifest_path: 'D:/pkgs/old.se.json' },
};

assert.equal(workDocPathOf(pkgTab), 'D:/pkgs/demo.se.json');
assert.equal(workDocPathOf(docTab), 'D:/docs/foo.se.json');
assert.equal(workDocPathOf({ id: 'x', docPath: 'D:/a.se.json', system: { manifest_path: 'D:/b.se.json' } }), 'D:/a.se.json');
assert.equal(workDocPathOf(draftTab), null);
assert.equal(workDocPathOf(forkTab), 'graphs/旧副本.se.json');

assert.equal(toolBasePathOf(pkgTab), 'D:/pkgs/demo.se.json');
assert.equal(toolBasePathOf(docTab), 'D:/docs/foo.se.json');
assert.equal(toolBasePathOf({ id: 'x', docPath: 'D:/a.se.json', system: { manifest_path: 'D:/b.se.json' } }), 'D:/b.se.json');

assert.equal(docBaseOf(pkgTab, ROOT), 'demo');
assert.equal(docBaseOf(docTab, ROOT), 'foo');
assert.equal(docBaseOf(graphsTab, ROOT), '图A');
assert.equal(docBaseOf(draftTab, ROOT), '草稿');
assert.equal(docBaseOf(forkTab, ROOT), '旧副本');

assert.equal(isGraphsDocPath('graphs/x.se.json', ROOT), true);
assert.equal(isGraphsDocPath(`${ROOT}/graphs/x.se.json`, ROOT), true);
assert.equal(isGraphsDocPath('D:/other/graphs/x.se.json', ROOT), false);
assert.equal(isGraphsDocPath('D:/other/x.se.json', ROOT), false);

assert.equal(canonDocPath('graphs/x.se.json', ROOT), `${ROOT.toLowerCase()}/graphs/x.se.json`);
assert.equal(canonDocPath(`${ROOT}/graphs/X.se.json`, ROOT), `${ROOT.toLowerCase()}/graphs/x.se.json`);

const tabs = [pkgTab, docTab, graphsTab, draftTab, forkTab];
assert.equal(findDocOwner(tabs, 'D:/pkgs/demo.se.json', null, ROOT)?.id, 't-pkg');
assert.equal(findDocOwner(tabs, 'D:/docs/foo.se.json', null, ROOT)?.id, 't-doc');
assert.equal(findDocOwner(tabs, 'graphs/图A.se.json', null, ROOT)?.id, 't-graphs');
assert.equal(findDocOwner(tabs, 'D:/pkgs/demo.se.json', 't-pkg', ROOT), null);
assert.equal(findDocOwner(tabs, '', null, ROOT), null);

const renamed = {
  streams: [
    { name: 'a', source: { file_path: 'old.streams/a.md' } },
    { name: 'b', source: { file_path: 'D:/absolute/b.md' } },
    { name: 'c' },
  ],
};
assert.equal(rewriteSourcePrefixInDoc(renamed, 'old', 'new'), true);
assert.equal(renamed.streams[0].source.file_path, 'new.streams/a.md');
assert.equal(renamed.streams[1].source.file_path, 'D:/absolute/b.md');
assert.equal(rewriteSourcePrefixInDoc(renamed, 'old', 'new'), false);
assert.equal(rewriteSourcePrefixInDoc({}, 'old', 'new'), false);
assert.equal(rewriteSourcePrefixInDoc(renamed, '', 'new'), false);

console.log('smoke-doc-identity-unit: OK');
