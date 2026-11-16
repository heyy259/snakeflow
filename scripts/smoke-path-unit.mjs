// 纯 Node 单测：统一路径原语（流 / 工具共用）+ buildDocument 写侧归一化。
//
// 契约：
// - 三态：absolute / relative；基准 = 声明它的 manifest 所在目录（绝对）。
// - 写侧 normalize：相对保持；绝对在同根下转相对；跨盘/无基准保留绝对。
// - 读侧 resolve：绝对原样；相对按基准拼接。
// - buildDocument：先归一化再算 id；不传 baseDir 时行为与改造前逐字节一致。
//
// 运行：node scripts/smoke-path-unit.mjs（全绿退出码 0）。
import assert from 'node:assert/strict';
import {
  isAbsolutePath,
  joinBase,
  relativizePath,
  normalizeResourcePath,
  resolveResourcePath,
  portablePath,
  absolutizeToolPath,
  manifestAbsDirOf,
} from '../src/se/paths.js';
import { buildDocument } from '../src/document.js';

const BASE = 'C:/proj/graphs';

// ── 1. 绝对值判定 ────────────────────────────────────────────────────────
assert.equal(isAbsolutePath('C:/x/y'), true);
assert.equal(isAbsolutePath('c:\\x\\y'), true);
assert.equal(isAbsolutePath('//server/share/x'), true);
assert.equal(isAbsolutePath('/opt/x'), true);
assert.equal(isAbsolutePath('x/y'), false);
assert.equal(isAbsolutePath('../x/y'), false);
assert.equal(isAbsolutePath(''), false);

// ── 2. joinBase ─────────────────────────────────────────────────────────
assert.equal(joinBase(BASE, 'tools/a.py'), `${BASE}/tools/a.py`);
assert.equal(joinBase(BASE, 'D:/other/a.py'), 'D:/other/a.py');
assert.equal(joinBase('', 'tools/a.py'), 'tools/a.py');
assert.equal(joinBase(BASE, ''), '');
assert.equal(joinBase('C:\\proj\\graphs\\', 'tools\\a.py'), 'C:/proj/graphs/tools/a.py');

// ── 3. relativizePath ───────────────────────────────────────────────────
assert.deepEqual(relativizePath(`${BASE}/tools/a.py`, BASE), {
  value: 'tools/a.py',
  warning: null,
});
assert.deepEqual(relativizePath(BASE, BASE), { value: '.', warning: null });
assert.deepEqual(relativizePath('C:/proj/opencode_tools/a.py', BASE), {
  value: '../opencode_tools/a.py',
  warning: null,
});
assert.equal(relativizePath('D:/x/a.py', BASE).value, 'D:/x/a.py');
assert.match(relativizePath('D:/x/a.py', BASE).warning, /跨盘/);
assert.deepEqual(relativizePath('tools/a.py', BASE), { value: 'tools/a.py', warning: null });
assert.equal(relativizePath(`${BASE}/tools/a.py`, '').value, `${BASE}/tools/a.py`);
assert.match(relativizePath(`${BASE}/tools/a.py`, '').warning, /基准/);

// ── 4. normalize / resolve 往返 ─────────────────────────────────────────
const absTool = `${BASE}/tools/a.py`;
assert.equal(normalizeResourcePath(absTool, BASE), 'tools/a.py');
assert.equal(normalizeResourcePath('tools/a.py', BASE), 'tools/a.py');
assert.equal(normalizeResourcePath('D:/x/a.py', BASE), 'D:/x/a.py');
assert.equal(resolveResourcePath('tools/a.py', BASE), absTool);
assert.equal(resolveResourcePath(absTool, BASE), absTool);
// 往返：绝对 → 相对 → 绝对
assert.equal(resolveResourcePath(normalizeResourcePath(absTool, BASE), BASE), absTool);

// ── 5. 兼容旧 helper ────────────────────────────────────────────────────
assert.equal(portablePath(absTool, BASE).value, 'tools/a.py');
assert.equal(portablePath('tools/a.py', BASE).value, 'tools/a.py');
assert.equal(portablePath('D:/x/a.py', BASE).value, 'D:/x/a.py');
assert.equal(absolutizeToolPath('tools/a.py', BASE), absTool);
assert.equal(absolutizeToolPath(absTool, BASE), absTool);

// ── 5b. manifestAbsDirOf：注册基准必须绝对；根未知 → ''（fail-closed） ──
assert.equal(manifestAbsDirOf('graphs/X.se.json', 'C:/proj'), 'C:/proj/graphs');
assert.equal(manifestAbsDirOf('C:/proj/graphs/X.se.json', 'C:/proj'), 'C:/proj/graphs');
assert.equal(manifestAbsDirOf('X.se.json', 'C:/proj'), 'C:/proj');
assert.equal(manifestAbsDirOf('graphs\\X.se.json', 'C:/proj'), 'C:/proj/graphs');
assert.equal(manifestAbsDirOf('graphs/X.se.json', ''), '', '根未知 → 不猜相对基准');
assert.equal(manifestAbsDirOf('', 'C:/proj'), '');
assert.equal(manifestAbsDirOf('C:/X.se.json', ''), 'C:/');

// ── 6. buildDocument：工具三路径与流 source 同一套语义 ──────────────────
function makeNodes(sourcePath) {
  return [
    {
      id: 's-1',
      position: { x: 0, y: 0 },
      data: { name: 'A', source: { file_path: sourcePath, encoding: 'utf-8' } },
    },
  ];
}
const nodesAbs = makeNodes(`${BASE}/X.streams/A.md`);
const toolsAbs = {
  t: {
    name: 't',
    description: 'd',
    tool_path: 'C:/proj/opencode_tools/t.py',
    execution_path: 'C:/proj/opencode_tools',
    manual_path: 'C:/proj/opencode_tools/t.md',
  },
  foreign: {
    name: 'foreign',
    description: 'd',
    tool_path: 'D:/foreign/f.py',
    execution_path: 'D:/foreign',
  },
};

const doc = buildDocument(
  { name: 'X', nodes: nodesAbs, edges: [], tools: toolsAbs, baseDir: BASE },
  null
);
assert.equal(doc.streams[0].source.file_path, 'X.streams/A.md');
assert.equal(doc.tools.t.tool_path, '../opencode_tools/t.py');
assert.equal(doc.tools.t.execution_path, '../opencode_tools');
assert.equal(doc.tools.t.manual_path, '../opencode_tools/t.md');
assert.equal(doc.tools.foreign.tool_path, 'D:/foreign/f.py', '跨盘保留绝对');
assert.equal(doc.tools.foreign.execution_path, 'D:/foreign');

// 同一内容：绝对形式 vs 相对形式 → id 相同（指纹在归一化之后）。
const toolsRel = {
  t: {
    name: 't',
    description: 'd',
    tool_path: '../opencode_tools/t.py',
    execution_path: '../opencode_tools',
    manual_path: '../opencode_tools/t.md',
  },
  foreign: {
    name: 'foreign',
    description: 'd',
    tool_path: 'D:/foreign/f.py',
    execution_path: 'D:/foreign',
  },
};
const docRel = buildDocument(
  {
    name: 'X',
    nodes: makeNodes('X.streams/A.md'),
    edges: [],
    tools: toolsRel,
    baseDir: BASE,
  },
  null
);
assert.equal(doc.id, docRel.id);
assert.deepEqual(doc.tools, docRel.tools);

// 不传 baseDir：保持原样（旧调用零变化）。
const docRaw = buildDocument(
  { name: 'X', nodes: nodesAbs, edges: [], tools: toolsAbs },
  null
);
assert.equal(docRaw.streams[0].source.file_path, `${BASE}/X.streams/A.md`);
assert.equal(docRaw.tools.t.tool_path, 'C:/proj/opencode_tools/t.py');

console.log('smoke-path-unit: OK');
