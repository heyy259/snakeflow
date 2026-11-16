// 纯 Node 单测：可移植文档路径 helper（portableDocPath / absolutizeDocPath）。
// 覆盖契约：项目内绝对 → 相对项目根；异机 graphs 残留 → `graphs/<名>`；外部 → 保持绝对；
// 相对 → 原样；空 → ''；absolutize 反向还原（绝对/空根原样）。
// 运行：node scripts/smoke-portable-docpath.mjs（全绿退出码 0，任一断言失败退出码 1）。
import assert from 'node:assert/strict';
import { portableDocPath, absolutizeDocPath } from '../src/se/paths.js';

const ROOT = 'C:/Users/demo/OneDrive/programing/tools/reactflow';

// 1) 项目内绝对路径 → 相对项目根。
assert.equal(
  portableDocPath(`${ROOT}/graphs/plan.se.json`, ROOT),
  'graphs/plan.se.json'
);
// 2) 项目根反斜杠风格 → 同结果。
assert.equal(
  portableDocPath(`${ROOT}/graphs/plan.se.json`, ROOT.replace(/\//g, '\\')),
  'graphs/plan.se.json'
);
// 3) 异机残留（同盘不同用户）→ 旧工作区迁移模式治愈为 graphs/<名>。
assert.equal(
  portableDocPath(
    'C:/Users/demo/OneDrive/programing/tools/reactflow/graphs/plan.se.json',
    ROOT,
    { repairGraphsResidue: true }
  ),
  'graphs/plan.se.json'
);
// 4) 外部绝对路径 → 原样（保持绝对）。
assert.equal(portableDocPath('D:/elsewhere/doc.se.json', ROOT), 'D:/elsewhere/doc.se.json');
// 5) 跨盘但形如 .../graphs/<文件>：默认不折叠（显式外部路径）；旧工作区迁移才折叠。
assert.equal(
  portableDocPath('D:/x/graphs/a.se.json', ROOT),
  'D:/x/graphs/a.se.json'
);
assert.equal(
  portableDocPath('D:/x/graphs/a.se.json', ROOT, { repairGraphsResidue: true }),
  'graphs/a.se.json'
);
// 6) 相对路径 → 原样透传。
assert.equal(portableDocPath('graphs/x.se.json', ROOT), 'graphs/x.se.json');
// 7) 空 / null / undefined → ''。
assert.equal(portableDocPath('', ROOT), '');
assert.equal(portableDocPath(null, ROOT), '');
assert.equal(portableDocPath(undefined, ROOT), '');
// 8) 无项目根：相对不变；外部绝对不变；graphs 残留仍治愈（根未知 = 不在根下）。
assert.equal(portableDocPath('graphs/x.se.json', ''), 'graphs/x.se.json');
assert.equal(portableDocPath('D:/elsewhere/doc.se.json', ''), 'D:/elsewhere/doc.se.json');

// 9) absolutizeDocPath：相对 + 根 → 绝对；绝对 → 原样；空 → ''；空根 → 原样。
assert.equal(absolutizeDocPath('graphs/x.se.json', ROOT), `${ROOT}/graphs/x.se.json`);
assert.equal(absolutizeDocPath('D:/outside/x.se.json', ROOT), 'D:/outside/x.se.json');
assert.equal(absolutizeDocPath('', ROOT), '');
assert.equal(absolutizeDocPath('graphs/x.se.json', ''), 'graphs/x.se.json');
// 10) 往返：项目内绝对 → 相对 → 绝对（正斜杠一致）。
assert.equal(
  absolutizeDocPath(portableDocPath(`${ROOT}/graphs/plan.se.json`, ROOT), ROOT),
  `${ROOT}/graphs/plan.se.json`
);

console.log('smoke-portable-docpath: OK');
