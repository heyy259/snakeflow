// 纯 Node 单测：`carryNodeMeasurements` 在结构重投影时携带 React Flow 渲染态（measured）。
//
// 背景：toCanvasGraph / projectStreams 每次结构动作都重建节点对象，若不显式携带 measured，
// @xyflow/react 的 adoptUserNodes 会把 measured 重置为 {undefined} 并清空 handleBounds，
// 造成 nodesInitialized 抖动 / 可见性闪断 / fit 竞态。此单测锁定携带规则与不变量。
// 零 SE、零 DOM。
// 运行：node scripts/smoke-node-measure-unit.mjs（全绿退出码 0）。
import { carryNodeMeasurements, carryNodeSelection } from '../src/graph.js';
import { buildDocument } from '../src/document.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 180) : ''}`);
};

const agent = (over = {}) => ({
  id: 's-a',
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { name: 'a', fields: [] },
  ...over,
});
const measuredOf = (n) => n?.measured;
const validMeasured = (n) =>
  !!n?.measured && Number(n.measured.width) === 220 && Number(n.measured.height) === 80;

try {
  // ── 1. 同 id + 同 type + 可见 + measured 有效 → 携带（数值） ─────────────
  const prev1 = [
    agent({
      measured: { width: 220, height: 80 },
      selected: true,
      hidden: true,
      dragging: true,
      resizing: true,
      internals: { handleBounds: { source: [] } },
    }),
  ];
  const next1 = [agent()];
  const r1 = carryNodeMeasurements(prev1, next1);
  check(
    '1 同 id/type/可见/measured 有效 → 携带宽高（数值）',
    validMeasured(r1[0]) &&
      typeof r1[0].measured.width === 'number' &&
      typeof r1[0].measured.height === 'number',
    JSON.stringify(measuredOf(r1[0]))
  );
  check(
    '1 只携带 measured，不带 selected/hidden/dragging/resizing/internals',
    !('selected' in r1[0]) &&
      !('hidden' in r1[0]) &&
      !('dragging' in r1[0]) &&
      !('resizing' in r1[0]) &&
      !('internals' in r1[0]),
    JSON.stringify(r1[0])
  );

  // ── 2. prev 隐藏（canvas=false）→ 不携带 ────────────────────────────────
  const prev2 = [
    agent({
      measured: { width: 220, height: 80 },
      data: { name: 'a', fields: [{ key: 'canvas', value: 'false' }] },
    }),
  ];
  const r2 = carryNodeMeasurements(prev2, [agent()]);
  check('2 prev 隐藏（canvas=false）→ 不携带 measured', !('measured' in r2[0]), JSON.stringify(r2[0]));

  // ── 3. type 不一致 → 不携带 ─────────────────────────────────────────────
  const prev3 = [agent({ measured: { width: 220, height: 80 } })];
  const r3 = carryNodeMeasurements(prev3, [agent({ type: 'note' })]);
  check('3 type 不一致 → 不携带 measured', !('measured' in r3[0]), JSON.stringify(r3[0]));

  // ── 4. prev 无 measured / measured 为 0 → 不携带 ────────────────────────
  const r4a = carryNodeMeasurements([agent()], [agent()]);
  check('4 prev 无 measured → 不携带', !('measured' in r4a[0]), JSON.stringify(r4a[0]));
  const r4b = carryNodeMeasurements(
    [agent({ measured: { width: 0, height: 80 } })],
    [agent()]
  );
  check('4 measured.width 为 0 → 不携带', !('measured' in r4b[0]), JSON.stringify(r4b[0]));
  const r4c = carryNodeMeasurements(
    [agent({ measured: { width: 220, height: 0 } })],
    [agent()]
  );
  check('4 measured.height 为 0 → 不携带', !('measured' in r4c[0]), JSON.stringify(r4c[0]));

  // ── 5. 渲染尺寸（style）变化 → 不携带；未变 → 携带 ──────────────────────
  const prev5 = [agent({ measured: { width: 220, height: 80 }, style: { width: 300, height: 120 } })];
  const r5w = carryNodeMeasurements(prev5, [agent({ style: { width: 200, height: 120 } })]);
  check('5 style.width 变化 → 不携带', !('measured' in r5w[0]), JSON.stringify(r5w[0]));
  const r5h = carryNodeMeasurements(prev5, [agent({ style: { width: 300, height: 90 } })]);
  check('5 style.height 变化 → 不携带', !('measured' in r5h[0]), JSON.stringify(r5h[0]));
  const r5same = carryNodeMeasurements(prev5, [agent({ style: { width: 300, height: 120 } })]);
  check('5 style 尺寸未变 → 携带', validMeasured(r5same[0]), JSON.stringify(r5same[0]));

  // ── 6. 新 id（prev 中不存在）→ 原样保留，不新增 measured ────────────────
  const next6 = [agent({ id: 's-new' })];
  const r6 = carryNodeMeasurements([agent()], next6);
  check(
    '6 新节点 id → 不携带、不新增 measured',
    r6[0] === next6[0] && !('measured' in r6[0]),
    JSON.stringify(r6[0])
  );

  // ── 7. 不修改入参（序列化前后一致） ─────────────────────────────────────
  const prev7 = [agent({ measured: { width: 220, height: 80 } })];
  const next7 = [agent()];
  const before = JSON.stringify({ prev7, next7 });
  carryNodeMeasurements(prev7, next7);
  const after = JSON.stringify({ prev7, next7 });
  check('7 入参 prev/next 未被修改', before === after, after.slice(0, 160));

  // ── 8. 无变化返回原数组引用；有变化返回新数组且保持顺序/id ──────────────
  const next8same = [agent({ id: 's-x' })];
  const r8same = carryNodeMeasurements([], next8same);
  check('8 无任何携带 → 返回同一数组引用', r8same === next8same);
  const prev8 = [
    agent({ id: 's-b', measured: { width: 10, height: 20 } }),
    agent({ id: 's-a', measured: { width: 220, height: 80 } }),
  ];
  const next8 = [agent({ id: 's-b' }), agent({ id: 's-a' })];
  const r8 = carryNodeMeasurements(prev8, next8);
  check(
    '8 有携带 → 新数组且顺序/ids 保持',
    r8 !== next8 &&
      r8.length === 2 &&
      r8[0].id === 's-b' &&
      r8[1].id === 's-a' &&
      r8[0].measured.width === 10 &&
      r8[1].measured.width === 220,
    JSON.stringify(r8.map((n) => ({ id: n.id, m: n.measured })))
  );

  // ── 9. 选中态携带：同 id + 仍可见才携带；隐藏节点不得因旧选中重新获得选中 ──
  const selPrev = [
    agent({ id: 's-keep', selected: true }),
    agent({
      id: 's-hidden',
      selected: true,
      data: { name: 'hidden', fields: [] },
    }),
    agent({ id: 's-unselected', selected: false }),
  ];
  const selNext = [
    agent({ id: 's-keep' }),
    agent({
      id: 's-hidden',
      data: { name: 'hidden', fields: [{ key: 'canvas', value: 'false' }] },
    }),
    agent({ id: 's-unselected' }),
    agent({ id: 's-new', selected: true }),
  ];
  const sel = carryNodeSelection(selPrev, selNext);
  check(
    '9 选中态：可见同 id 携带 selected',
    sel.find((n) => n.id === 's-keep')?.selected === true,
    JSON.stringify(sel)
  );
  check(
    '9 选中态：隐藏节点不恢复 selected',
    !sel.find((n) => n.id === 's-hidden')?.selected,
    JSON.stringify(sel.find((n) => n.id === 's-hidden'))
  );
  check(
    '9 选中态：未选中的同 id 不被改成选中',
    !sel.find((n) => n.id === 's-unselected')?.selected,
    JSON.stringify(sel.find((n) => n.id === 's-unselected'))
  );
  check(
    '9 选中态：新 id 保持自身 selected 且无 prev 影响',
    sel.find((n) => n.id === 's-new')?.selected === true,
    JSON.stringify(sel.find((n) => n.id === 's-new'))
  );
  const selPrevBefore = JSON.stringify(selPrev);
  const selNextBefore = JSON.stringify(selNext);
  carryNodeSelection(selPrev, selNext);
  check(
    '9 选中态：入参未被修改',
    JSON.stringify(selPrev) === selPrevBefore && JSON.stringify(selNext) === selNextBefore,
    JSON.stringify({ selPrev, selNext })
  );
  const selSame = [agent({ id: 's-none' })];
  check('9 选中态：无携带时返回同一数组引用', carryNodeSelection([], selSame) === selSame);

  // ── 10. 序列化守卫：buildDocument 不写 measured（strict whitelist） ──────
  const doc = buildDocument({
    name: 'a',
    nodes: [
      {
        id: 's-a',
        type: 'agent',
        position: { x: 0, y: 0 },
        measured: { width: 220, height: 80 },
        data: { name: 'a', content: 'x', contentState: 'loaded' },
      },
    ],
    edges: [],
    tools: {},
    baseDir: '',
  });
  check('10 buildDocument 序列化结果不含 measured', !JSON.stringify(doc).includes('measured'), JSON.stringify(doc).slice(0, 160));
} catch (err) {
  check('单测执行', false, err.stack || String(err));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
