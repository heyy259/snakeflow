// 期 12（D7）纯 Node 单测：packageExport 的单项/多项选择器 selectPackageInput
// 与单项导出组装契约（无 SE、无网络、无 DOM）。
//
// 为什么不用浏览器 / 不连 snakeeats：selectPackageInput 与 buildPackage 都是纯函数
// （无 React / DOM / ws 依赖），可在 Node 直接 import 断言选择语义与包结构，
// 比 e2e 冒烟快且稳。覆盖契约：单项精确命中、子集保持原序并排除未选、
// 空/缺失/非数组入参容错（不抛）、单项导出组装=1 兄弟文件 + manifest 且 streams 长度 1。
// 布局单载体（v5）：normalizeLayout 归一（宽高仅有限正数）、readManifestLayout 回退链、
// buildPackage 只写 `system.graph.layout`（无顶层 ui；layout 空则不写 system）。
// 运行：node scripts/smoke-package-export-unit.mjs（全绿退出码 0，任一断言失败退出码 1）。

import {
  selectPackageInput,
  buildPackage,
  normalizeLayout,
  readManifestLayout,
} from '../src/se/packageExport.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 200) : ''}`);
};

try {
  // ── 夹具：全量流 / 工具（顺序即断言基准）──────────────────────────────
  const STREAMS = [
    { name: 'alpha', title: '甲', content: 'A', tags: {} },
    { name: 'beta', title: '乙', content: 'B', tags: {} },
    { name: 'gamma', title: '丙', content: 'C', tags: {} },
  ];
  const TOOLS = [
    { name: 'grep_runner', description: 'g' },
    { name: 'lint_runner', description: 'l' },
  ];

  // ── 1. 单项精确命中：只返回选中的那一条 ───────────────────────────────
  const one = selectPackageInput({
    streams: STREAMS,
    tools: TOOLS,
    streamNames: ['beta'],
    toolNames: ['lint_runner'],
  });
  check(
    '1 单项：只返回选中的 1 流 + 1 工具',
    one.streams.length === 1 &&
      one.streams[0].name === 'beta' &&
      one.tools.length === 1 &&
      one.tools[0].name === 'lint_runner',
    JSON.stringify({ streams: one.streams.map((s) => s.name), tools: one.tools.map((t) => t.name) })
  );

  // ── 2. 子集：保持输入原序并排除未选 ───────────────────────────────────
  const subset = selectPackageInput({
    streams: STREAMS,
    tools: TOOLS,
    streamNames: ['gamma', 'alpha'],
    toolNames: ['grep_runner'],
  });
  check(
    '2 子集：按输入顺序（alpha→gamma）返回，排除未选的 beta',
    subset.streams.length === 2 &&
      subset.streams[0].name === 'alpha' &&
      subset.streams[1].name === 'gamma' &&
      !subset.streams.some((s) => s.name === 'beta') &&
      subset.tools.length === 1 &&
      subset.tools[0].name === 'grep_runner',
    JSON.stringify({ streams: subset.streams.map((s) => s.name), tools: subset.tools.map((t) => t.name) })
  );

  // ── 3. 空选择集：空数组（不是全量）────────────────────────────────────
  const emptySel = selectPackageInput({ streams: STREAMS, tools: TOOLS, streamNames: [], toolNames: [] });
  check(
    '3 空选择集：streamNames/toolNames 为空 → 空数组',
    Array.isArray(emptySel.streams) &&
      emptySel.streams.length === 0 &&
      Array.isArray(emptySel.tools) &&
      emptySel.tools.length === 0,
    JSON.stringify(emptySel)
  );

  // ── 4. 缺失/畸形入参：容错不抛，空数组 ────────────────────────────────
  let missingOut = null;
  let missingThrew = false;
  try {
    missingOut = selectPackageInput({});
  } catch (err) {
    missingThrew = true;
    missingOut = String(err);
  }
  let nullArgsOut = null;
  let nullArgThrew = false;
  try {
    nullArgsOut = selectPackageInput({ streams: null, tools: undefined, streamNames: null, toolNames: undefined });
  } catch (err) {
    nullArgThrew = true;
    nullArgsOut = String(err);
  }
  check(
    '4 缺失/畸形入参：不抛且返回空数组',
    !missingThrew &&
      missingOut &&
      missingOut.streams.length === 0 &&
      missingOut.tools.length === 0 &&
      !nullArgThrew &&
      nullArgsOut &&
      nullArgsOut.streams.length === 0 &&
      nullArgsOut.tools.length === 0,
    JSON.stringify({ missingThrew, missingOut, nullArgThrew, nullArgsOut })
  );

  // ── 5. 组装层：单项选择 → buildPackage 产出 1 兄弟文件 + manifest ──────
  const selected = selectPackageInput({
    streams: STREAMS,
    tools: TOOLS,
    streamNames: ['beta'],
    toolNames: ['lint_runner'],
  });
  const pkg = buildPackage({ displayName: '单项系统', streams: selected.streams, tools: selected.tools });
  const streamFiles = pkg.files.filter((f) => !f.relPath.endsWith('.se.json'));
  const manifestFile = pkg.files[pkg.files.length - 1];
  check(
    '5 单项导出：files 恰好 2（1 兄弟文件 + manifest），streams 长度 1',
    pkg.files.length === 2 &&
      streamFiles.length === 1 &&
      streamFiles[0].relPath.endsWith('.md') &&
      manifestFile.relPath === '单项系统.se.json' &&
      Array.isArray(pkg.manifest.streams) &&
      pkg.manifest.streams.length === 1 &&
      pkg.manifest.streams[0].name === 'beta' &&
      pkg.manifest.streams[0].source.file_path === streamFiles[0].relPath,
    JSON.stringify({ files: pkg.files.map((f) => f.relPath), streams: pkg.manifest.streams.map((s) => s.name) })
  );

  // ── 6. normalizeLayout：归一（宽高仅有限正数）+ 非法剔除 + 空 → null ────
  const layoutIn = {
    alpha: { x: 12, y: -4, width: 120, height: 60 },
    beta: { x: 0, y: 0, width: 0, height: -5 },
    bad: { x: 'nope', y: 1 },
    bad2: { x: 1, y: 'nope' },
    arr: [],
  };
  const norm = normalizeLayout(layoutIn);
  check(
    '6 normalizeLayout：x/y 有限保留；宽高仅有限正数；非法整条剔除',
    norm.alpha.x === 12 &&
      norm.alpha.y === -4 &&
      norm.alpha.width === 120 &&
      norm.alpha.height === 60 &&
      norm.beta.x === 0 &&
      norm.beta.y === 0 &&
      !('width' in norm.beta) &&
      !('height' in norm.beta) &&
      !('bad' in norm) &&
      !('bad2' in norm) &&
      !('arr' in norm),
    JSON.stringify(norm)
  );
  check(
    '6 normalizeLayout：空/非对象/全非法 → null（不抛）',
    normalizeLayout({}) === null &&
      normalizeLayout({ bad: { x: 'x', y: 'y' } }) === null &&
      normalizeLayout(null) === null &&
      normalizeLayout(undefined) === null &&
      normalizeLayout([]) === null &&
      normalizeLayout('nope') === null,
    JSON.stringify({ empty: normalizeLayout({}), bad: normalizeLayout({ bad: { x: 'x', y: 'y' } }) })
  );

  // ── 6b. readManifestLayout：raw / parse 产物双通道 + 旧位回退链 ─────────
  const readRaw = readManifestLayout({ system: { graph: { layout: { alpha: { x: 1, y: 2, width: 60 } } } } });
  check(
    '6b readManifestLayout：raw manifest 的 system.graph.layout 可读（宽高保留）',
    readRaw?.alpha?.x === 1 && readRaw?.alpha?.y === 2 && readRaw?.alpha?.width === 60,
    JSON.stringify(readRaw)
  );
  const readProduct = readManifestLayout({ layout: { alpha: { x: 3, y: 4 } } });
  check(
    '6b readManifestLayout：parseManifest 产物（顶层 layout）可读',
    readProduct?.alpha?.x === 3 && readProduct?.alpha?.y === 4,
    JSON.stringify(readProduct)
  );
  const readPositions = readManifestLayout({ system: { graph: { positions: { alpha: { x: 5, y: 6, width: 99 } } } } });
  check(
    '6b readManifestLayout：旧位 system.graph.positions 回退（仅 x/y，不带宽高）',
    readPositions?.alpha?.x === 5 && readPositions?.alpha?.y === 6 && !('width' in (readPositions.alpha || {})),
    JSON.stringify(readPositions)
  );
  const readStreamPos = readManifestLayout({
    streams: [{ name: 'alpha', position: { x: 15, y: 16 } }],
    system: { graph: { positions: { alpha: { x: 5, y: 6 } } } },
  });
  check(
    '6b readManifestLayout：streams[].position 条目覆盖 system.graph.positions',
    readStreamPos?.alpha?.x === 15 && readStreamPos?.alpha?.y === 16,
    JSON.stringify(readStreamPos)
  );
  const readUi = readManifestLayout({ ui: { positions: { alpha: { x: 7, y: 8 } } } });
  check(
    '6b readManifestLayout：旧包顶层 ui.positions 回退仍可读（仅 x/y）',
    readUi?.alpha?.x === 7 && readUi?.alpha?.y === 8,
    JSON.stringify(readUi)
  );
  check(
    '6b readManifestLayout：全缺/非对象 → null',
    readManifestLayout({}) === null &&
      readManifestLayout(null) === null &&
      readManifestLayout([]) === null &&
      readManifestLayout({ streams: [] }) === null,
    JSON.stringify({
      empty: readManifestLayout({}),
      arr: readManifestLayout([]),
      streams: readManifestLayout({ streams: [] }),
    })
  );

  // ── 7. buildPackage 写出 system.graph.layout（无顶层 ui），可回读 ───────
  const pkgPos = buildPackage({
    displayName: '坐标系统',
    streams: [{ name: 'alpha', title: '甲', content: 'A', tags: {} }],
    tools: [],
    layout: { alpha: { x: 40, y: 80, width: 220 } },
  });
  const readBack = readManifestLayout(pkgPos.manifest);
  const graphOut = pkgPos.manifest.system?.graph;
  check(
    '7 buildPackage：system.graph.layout 落盘（format_version 5.0 / 无顶层 ui）且可回读',
    graphOut?.format_version === '5.0' &&
      graphOut?.layout?.alpha?.x === 40 &&
      graphOut?.layout?.alpha?.y === 80 &&
      graphOut?.layout?.alpha?.width === 220 &&
      !('ui' in pkgPos.manifest) &&
      !('layout' in pkgPos.manifest) &&
      readBack.alpha?.x === 40 &&
      readBack.alpha?.y === 80 &&
      readBack.alpha?.width === 220,
    JSON.stringify({ system: pkgPos.manifest.system, hasUi: 'ui' in pkgPos.manifest })
  );

  // ── 7b. 旧调用名 positions 兼容；空 layout 不写 system ──────────────────
  const pkgAlias = buildPackage({
    displayName: '别名系统',
    streams: [{ name: 'alpha', title: '甲', content: 'A', tags: {} }],
    tools: [],
    positions: { alpha: { x: 1, y: 2 } },
  });
  check(
    '7b buildPackage：旧入参名 positions 仍兼容（写入 system.graph.layout）',
    pkgAlias.manifest.system?.graph?.layout?.alpha?.x === 1 &&
      pkgAlias.manifest.system?.graph?.layout?.alpha?.y === 2,
    JSON.stringify(pkgAlias.manifest.system)
  );
  const pkgEmpty = buildPackage({
    displayName: '空布局',
    streams: [{ name: 'alpha', title: '甲', content: 'A', tags: {} }],
    tools: [],
    layout: {},
  });
  const pkgBadOnly = buildPackage({
    displayName: '非法布局',
    streams: [{ name: 'alpha', title: '甲', content: 'A', tags: {} }],
    tools: [],
    layout: { alpha: { x: 'nope', y: 1 } },
  });
  check(
    '7b buildPackage：layout 空/全非法 → 不写 system',
    !('system' in pkgEmpty.manifest) &&
      pkgEmpty.manifest.streams.length === 1 &&
      !('system' in pkgBadOnly.manifest),
    JSON.stringify({ empty: pkgEmpty.manifest.system, bad: pkgBadOnly.manifest.system })
  );
} catch (err) {
  check('单测执行', false, err.stack || String(err));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
