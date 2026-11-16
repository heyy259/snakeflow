// 期 11（D1u）纯 Node 单测：packageImport 计划器/应用器（无 SE、无网络、无 DOM）。
//
// 覆盖计划 §7.1：planImport new/update/unchanged 分类、diffTags 朝向、保留键分桶、
// B2 dict 工具 name 注入、B3 BOM 剥离（注入 readFile）、fetchStreamContents
// 内联优先/兄弟读取/缺失不建空、Q9 内容不变不调 stream.write（call 桩计数）、预测悬空边。
// 期 12（D6）追加：reservedDeltaSummary / filterPredictedDangling 选择一致性过滤、
// applyImport 尊重 row.selected（未选行零调用）。
// 布局单载体（v5）追加：parseManifest 产出 manifest.layout（system.graph.layout 优先 →
// positions + streams[].position 派生 → 旧包顶层 ui.positions 回退 → null；不再产出 ui）。
// IO 全部注入：loadManifestFile 的 readFile、fetchStreamContents 的 readFile、applyImport 的 call。
import {
  parseManifest,
  loadManifestFile,
  fetchStreamContents,
  resolveSiblingPath,
  planImport,
  applyImport,
  reservedDeltaSummary,
  filterPredictedDangling,
} from '../src/se/packageImport.js';
import { diffTags } from '../src/se/tagOps.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 220) : ''}`);
};

const SIBLING_TEXT = '# alpha 正文\n第二行含中文。';
const PKG_BASE = 'C:\\pkg\\demo.se.json';

async function main() {
  // ── diffTags 朝向（基准）──────────────────────────────────────────────
  const d1 = diffTags({ canvas: 'false', role: 'a' }, { canvas: 'true', role: 'a', 'edge.x': 'l' });
  check(
    'diffTags 朝向：把服务端 current 变成包 before（set 取包值；current 独有进 remove）',
    d1.set.canvas === 'false' && !('role' in d1.set) && d1.remove.length === 1 && d1.remove[0] === 'edge.x',
    JSON.stringify(d1)
  );

  // ── resolveSiblingPath ────────────────────────────────────────────────
  check(
    'resolveSiblingPath：manifest 目录 + 相对 file_path（反斜杠归一）',
    resolveSiblingPath(PKG_BASE, 'demo.streams\\a.md') === 'C:/pkg/demo.streams/a.md',
    resolveSiblingPath(PKG_BASE, 'demo.streams\\a.md')
  );
  check(
    'resolveSiblingPath：绝对 file_path 原样（跨盘回退）',
    resolveSiblingPath(PKG_BASE, 'D:/abs/z.md') === 'D:/abs/z.md'
  );
  check(
    'resolveSiblingPath：manifest 无目录段 → 保留相对路径',
    resolveSiblingPath('demo.se.json', 'demo.streams/a.md') === 'demo.streams/a.md'
  );

  // ── B2：dict 工具 name 注入 ───────────────────────────────────────────
  const dictTools = parseManifest({
    $schema: 'snake-manifest-v1',
    streams: [{ name: 'alpha' }],
    tools: {
      grep_runner: { description: 'x', tool_path: 'tools/grep.py' },
      named_one: { name: 'explicit' },
    },
  });
  check(
    'B2：dict 工具缺 name → 注入 key（tool_path 保真；显式 name 不覆盖）',
    dictTools.tools.length === 2 &&
      dictTools.tools[0].name === 'grep_runner' &&
      dictTools.tools[0].tool_path === 'tools/grep.py' &&
      dictTools.tools[1].name === 'explicit',
    JSON.stringify(dictTools.tools.map((t) => t.name))
  );

  // ── 布局：parseManifest 产出 manifest.layout（v5 单一载体 + 旧位回退链）─
  const layoutWins = parseManifest({
    $schema: 'snake-manifest-v1',
    streams: [
      { name: 'alpha', position: { x: 10, y: 20 } },
      { name: 'beta' },
    ],
    tools: {},
    system: {
      graph: {
        layout: { alpha: { x: 11, y: 21, width: 120, height: 60 }, beta: { x: 0, y: 0 } },
        positions: { alpha: { x: 1, y: 1 }, gamma: { x: '3', y: 4 }, bad: { x: 'x' } },
      },
    },
  });
  check(
    'parseManifest：system.graph.layout 优先于 positions/streams[].position（宽高保留、无 ui 键）',
    layoutWins.layout.alpha.x === 11 &&
      layoutWins.layout.alpha.y === 21 &&
      layoutWins.layout.alpha.width === 120 &&
      layoutWins.layout.alpha.height === 60 &&
      layoutWins.layout.beta.x === 0 &&
      layoutWins.layout.beta.y === 0 &&
      layoutWins.layout.gamma === undefined &&
      !('ui' in layoutWins),
    JSON.stringify({ layout: layoutWins.layout, keys: Object.keys(layoutWins) })
  );
  check(
    'parseManifest 幂等：对自身产物再解析 layout 不变（顶层 layout 直读）',
    parseManifest(layoutWins).layout.alpha.x === 11 && parseManifest(layoutWins).layout.alpha.width === 120,
    JSON.stringify(parseManifest(layoutWins).layout)
  );
  const uiNorm = parseManifest({
    $schema: 'snake-manifest-v1',
    streams: [
      { name: 'alpha', position: { x: 10, y: 20 } },
      { name: 'beta' },
    ],
    tools: {},
    system: { graph: { positions: { alpha: { x: 1, y: 1 }, gamma: { x: '3', y: 4 }, bad: { x: 'x' } } } },
  });
  check(
    'parseManifest：无 layout 时从 system.graph.positions + streams[].position 派生（条目优先、非法剔除）',
    uiNorm.layout &&
      uiNorm.layout.alpha.x === 10 &&
      uiNorm.layout.alpha.y === 20 &&
      uiNorm.layout.gamma.x === 3 &&
      uiNorm.layout.gamma.y === 4 &&
      uiNorm.layout.bad === undefined,
    JSON.stringify(uiNorm.layout)
  );
  const uiExplicit = parseManifest({
    $schema: 'snake-manifest-v1',
    streams: [{ name: 'alpha' }],
    tools: {},
    ui: { positions: { alpha: { x: 99, y: 99 } } },
  });
  check(
    'parseManifest：仅旧包顶层 ui.positions 时仍可读（纯历史兼容回退，仅 x/y）',
    uiExplicit.layout?.alpha?.x === 99 && uiExplicit.layout?.alpha?.y === 99,
    JSON.stringify(uiExplicit.layout)
  );
  const uiNone = parseManifest({ $schema: 'snake-manifest-v1', streams: [{ name: 'alpha' }], tools: {} });
  check('parseManifest：无任何布局信息 ⇒ layout 为 null', uiNone.layout === null, JSON.stringify(uiNone.layout));

  // ── B3：loadManifestFile 去 BOM（readFile 注入）────────────────────────
  const manifestObj = {
    $schema: 'snake-manifest-v1',
    id: 'demo',
    streams: [
      { name: 'alpha', title: '甲', tags: {}, source: { file_path: 'demo.streams/alpha.md', encoding: 'utf-8' } },
    ],
    tools: {},
  };
  const readPaths = [];
  const loaded = await loadManifestFile(PKG_BASE, async (p) => {
    readPaths.push(p);
    return '\uFEFF' + JSON.stringify(manifestObj, null, 2);
  });
  check(
    'B3：loadManifestFile 注入 readFile + 去 BOM + JSON.parse + parseManifest',
    readPaths.length === 1 &&
      readPaths[0] === PKG_BASE &&
      loaded.path === PKG_BASE &&
      loaded.manifest.id === 'demo' &&
      loaded.manifest.streams[0].name === 'alpha',
    JSON.stringify({ reads: readPaths, id: loaded.manifest.id })
  );
  let bomWouldThrow = false;
  try {
    JSON.parse('\uFEFF{}');
  } catch (err) {
    bomWouldThrow = true;
  }
  check('B3：不去 BOM 时 JSON.parse 抛错（证明剥离必要）', bomWouldThrow);

  // ── fetchStreamContents：内联优先 / 兄弟读取 / 缺失不建空 ─────────────
  const siblingManifest = {
    $schema: 'snake-manifest-v1',
    streams: [
      { name: 'alpha', tags: {}, content: 'inline 优先', source: { file_path: 'demo.streams/alpha.md', encoding: 'utf-8' } },
      { name: 'beta', tags: {}, source: { file_path: 'demo.streams/beta.md', encoding: 'utf-8' } },
      { name: 'gamma', tags: {} },
      { name: 'delta', tags: {}, source: { file_path: 'demo.streams/delta.md', encoding: 'utf-8' } },
      { name: 'epsilon', tags: {}, source: { file_path: 'demo.streams/epsilon.md', encoding: 'gbk' } },
    ],
  };
  const reads = [];
  const readStub = async (p) => {
    reads.push(p);
    if (p.endsWith('/beta.md')) return SIBLING_TEXT;
    if (p.endsWith('/epsilon.md')) return 'GBK 解码内容';
    throw new Error('ENOENT: no such file');
  };
  const fetched = await fetchStreamContents({ manifest: siblingManifest, manifestPath: PKG_BASE, readFile: readStub });
  check(
    'fetchStreamContents：内联 content 优先（不读兄弟文件）',
    fetched.contents.get('alpha') === 'inline 优先' && !reads.some((p) => p.endsWith('/alpha.md')),
    JSON.stringify(reads)
  );
  check(
    'fetchStreamContents：读兄弟文件（resolveSiblingPath → 绝对路径）',
    fetched.contents.get('beta') === SIBLING_TEXT && reads.includes('C:/pkg/demo.streams/beta.md'),
    JSON.stringify(fetched.contents.get('beta'))
  );
  check(
    'fetchStreamContents：缺 file_path → missing 且不建空',
    fetched.missing.includes('gamma') && !fetched.contents.has('gamma'),
    JSON.stringify({ missing: fetched.missing })
  );
  check(
    'fetchStreamContents：兄弟文件不存在 → missing 且不建空',
    fetched.missing.includes('delta') && !fetched.contents.has('delta')
  );
  check(
    'fetchStreamContents：encoding 非 UTF-8 兼容 → warning（仍读取）',
    fetched.contents.get('epsilon') === 'GBK 解码内容' &&
      fetched.warnings.some((w) => w.includes('epsilon') && w.includes('gbk')),
    JSON.stringify(fetched.warnings)
  );

  // ── planImport：分类 / diff 朝向 / 保留键分桶 / 悬空预测 ───────────────
  const planManifest = {
    $schema: 'snake-manifest-v1',
    id: 'demo',
    streams: [
      {
        name: 'alpha',
        title: 'Alpha2',
        description: '新描述',
        tags: { role: 'a2', canvas: 'false', 'edge.beta': '来自 alpha', 'edge.ghost': '幽灵' },
        content: 'A2',
      },
      { name: 'beta', title: 'Beta', description: '', tags: {}, content: 'B1' },
      { name: 'gamma', title: 'Gamma', description: '', tags: { canvas: 'true' }, content: 'G' },
    ],
    tools: {
      grep_runner: { tool_path: 'tools/grep.py' },
      // 绝对路径 → 外部引用：缺失时允许注册（与“包内相对路径缺失=坏包”区分）。
      fresh_tool: { name: 'fresh_tool', tool_path: 'C:/missing/fresh.py' },
    },
  };
  const existingStreams = [
    { name: 'alpha', title: 'Alpha', description: '旧描述', tags: { canvas: 'true', 'edge.delta': '旧边', role: 'a' }, version: 3 },
    { name: 'beta', title: 'Beta', description: '', tags: {}, version: 1 },
    { name: 'delta', title: 'Delta', description: '', tags: {}, version: 2 },
  ];
  const existingTools = [{ name: 'grep_runner' }];
  // 实况 tool.list 的完整旧定义（回滚/替换前置）；仅 name 的 existingTools 不足以安全替换。
  const registeredToolDefs = [{ name: 'grep_runner', description: '旧', tool_path: 'tools/grep.py' }];
  const contents = { alpha: 'A2', beta: 'B1', gamma: 'G' };
  const plan = planImport({
    manifest: planManifest,
    contents,
    existingStreams,
    existingTools,
    existingContents: { alpha: 'A2', beta: 'B1' },
    statResults: { grep_runner: { exists: true }, fresh_tool: { exists: false } },
  });
  const byName = new Map(plan.streams.map((r) => [r.name, r]));

  check(
    'planImport：new/update/unchanged 分类（gamma=new / alpha=update / beta=unchanged）',
    byName.get('gamma')?.state === 'new' && byName.get('alpha')?.state === 'update' && byName.get('beta')?.state === 'unchanged',
    JSON.stringify(plan.streams.map((r) => [r.name, r.state]))
  );
  check(
    'planImport：diffTags 朝向 = 服务端→包（alpha.set.role=a2；edge.delta 仅在 remove）',
    byName.get('alpha')?.tagDiff.set.role === 'a2' &&
      byName.get('alpha')?.tagDiff.remove.includes('edge.delta') &&
      !('edge.delta' in byName.get('alpha').tagDiff.set),
    JSON.stringify(byName.get('alpha')?.tagDiff)
  );
  check(
    'planImport：保留键分桶（removals=[edge.delta]；adds 含 canvas/edge.ghost，不含 role）',
    JSON.stringify(byName.get('alpha')?.reservedRemovals) === JSON.stringify(['edge.delta']) &&
      byName.get('alpha')?.reservedAdds.includes('canvas') &&
      byName.get('alpha')?.reservedAdds.includes('edge.ghost') &&
      !byName.get('alpha')?.reservedAdds.includes('role'),
    JSON.stringify({ rm: byName.get('alpha')?.reservedRemovals, add: byName.get('alpha')?.reservedAdds })
  );
  check(
    'planImport：v3 无 title 通道（行不含 title/titleChanged）',
    !('title' in byName.get('alpha')) && !('titleChanged' in byName.get('alpha'))
  );
  check(
    'planImport：contentChanged（不变=false；new 有内容=true）',
    byName.get('alpha')?.contentChanged === false &&
      byName.get('beta')?.contentChanged === false &&
      byName.get('gamma')?.contentChanged === true
  );
  check(
    'planImport：descriptionChanged（仅已存在流比较）',
    byName.get('alpha')?.descriptionChanged === true && byName.get('beta')?.descriptionChanged === false
  );
  check(
    'planImport：predictedDangling（edge.ghost 悬空；edge.beta/edge.delta 有目标）',
    plan.predictedDangling.length === 1 &&
      plan.predictedDangling[0].source === 'alpha' &&
      plan.predictedDangling[0].target === 'ghost' &&
      plan.predictedDangling[0].label === '幽灵',
    JSON.stringify(plan.predictedDangling)
  );
  check(
    'planImport：工具状态 + statResults → pathMissing（B2 注入名参与分类）',
    plan.tools.length === 2 &&
      plan.tools[0].name === 'grep_runner' &&
      plan.tools[0].state === 'update' &&
      plan.tools[0].pathMissing === false &&
      plan.tools[1].name === 'fresh_tool' &&
      plan.tools[1].state === 'new' &&
      plan.tools[1].pathMissing === true,
    JSON.stringify(plan.tools)
  );

  const planNoExistingContent = planImport({
    manifest: planManifest,
    contents: new Map(Object.entries(contents)),
    existingStreams,
    existingTools,
  });
  check(
    'planImport：无 existingContents 时已存在项一律 update 且 contentChanged=true（Map 输入容错）',
    planNoExistingContent.streams.find((r) => r.name === 'beta')?.state === 'update' &&
      planNoExistingContent.streams.find((r) => r.name === 'beta')?.contentChanged === true
  );

  const planMissingContent = planImport({
    manifest: planManifest,
    contents: { beta: 'B1' },
    existingStreams,
    existingTools,
  });
  const alphaMissing = planMissingContent.streams.find((r) => r.name === 'alpha');
  check(
    'planImport：正文缺失 → contentMissing=true / contentChanged=false + warning',
    alphaMissing?.contentMissing === true &&
      alphaMissing?.contentChanged === false &&
      planMissingContent.warnings.some((w) => w.includes('alpha')),
    JSON.stringify(planMissingContent.warnings)
  );

  const planSelected = planImport({
    manifest: planManifest,
    contents,
    existingStreams,
    existingTools,
    selection: { streamNames: ['alpha', 'gamma'], toolNames: ['fresh_tool'] },
  });
  check(
    'planImport：selection 过滤 selected（流与工具）',
    planSelected.streams.find((r) => r.name === 'beta')?.selected === false &&
      planSelected.streams.find((r) => r.name === 'alpha')?.selected === true &&
      planSelected.tools.find((t) => t.name === 'grep_runner')?.selected === false &&
      planSelected.tools.find((t) => t.name === 'fresh_tool')?.selected === true
  );

  // ── applyImport：Q9 幂等 + 覆盖语义 + 保留键确认 ──────────────────────
  const calls = [];
  let callVersion = 0;
  const callSpy = async (method, params) => {
    calls.push({ method, params });
    if (method === 'stream.create' || method === 'stream.write') return { version: ++callVersion };
    return {};
  };
  const summary = await applyImport({
    plan,
    manifest: planManifest,
    call: callSpy,
    contents,
    baseDir: 'C:/pkg',
    registeredTools: registeredToolDefs,
    strategy: 'overwrite',
    confirmReserved: false,
  });
  const callFor = (method, pred) => calls.some((c) => c.method === method && (!pred || pred(c.params)));
  const streamWrites = calls.filter((c) => c.method === 'stream.write');

  check(
    'Q9：内容不变（alpha/beta）⇒ 不调 stream.write；仅 new 的 gamma 写正文',
    !streamWrites.some((c) => c.params.name === 'alpha') &&
      !streamWrites.some((c) => c.params.name === 'beta') &&
      streamWrites.length === 1 &&
      streamWrites[0].params.name === 'gamma' &&
      streamWrites[0].params.text === 'G',
    JSON.stringify(streamWrites)
  );
  check(
    'create 初始化：stream.write 复用 created.version（CAS）',
    streamWrites.length === 1 && streamWrites[0].params.expected_version === 1,
    JSON.stringify(streamWrites)
  );
  check(
    'applyImport：new ⇒ stream.create{name,tags}（无 title）+ 非空正文 write',
    callFor('stream.create', (p) => p.name === 'gamma' && !('title' in p) && p.tags && p.tags.canvas === 'true'),
    JSON.stringify(calls.filter((c) => c.method === 'stream.create'))
  );
  check(
    'applyImport：update ⇒ update_description + 非保留 set_tag（无 update_title）',
    !callFor('stream.update_title') &&
      callFor('stream.update_description', (p) => p.name === 'alpha' && p.text === '新描述') &&
      callFor('stream.set_tag', (p) => p.name === 'alpha' && p.key === 'role' && p.value === 'a2')
  );
  check(
    'applyImport：confirmReserved=false ⇒ 保留键差量跳过 + warning（canvas/edge.delta）',
    !callFor('stream.set_tag', (p) => p.key === 'canvas') &&
      !callFor('stream.remove_tag', (p) => p.key === 'edge.delta') &&
      summary.warnings.some((w) => w.includes('alpha')),
    JSON.stringify(summary.warnings)
  );
  check('applyImport：unchanged 的 beta 零调用', !calls.some((c) => c.params && c.params.name === 'beta'));
  check(
    'applyImport：工具 update = unregister→register；new = register（B2 名）',
    callFor('tool.unregister', (p) => p.name === 'grep_runner') &&
      callFor('tool.register', (p) => p.name === 'grep_runner') &&
      callFor('tool.register', (p) => p.name === 'fresh_tool')
  );
  // 风险 #5：applyImport 发往 SE 的 tool.register 必须经白名单裁剪（insert_template 不下发）。
  {
    const tplManifest = {
      $schema: 'snake-manifest-v1',
      streams: [],
      tools: {
        templated: {
          name: 'templated',
          description: 'd',
          tool_path: '/t.py',
          insert_template: '@{templated|{}}',
        },
      },
    };
    const tplPlan = planImport({ manifest: tplManifest, contents: {}, existingStreams: [], existingTools: [] });
    const tplCalls = [];
    await applyImport({
      plan: tplPlan,
      manifest: tplManifest,
      call: async (m, p) => {
        tplCalls.push({ method: m, params: p });
        return {};
      },
      contents: {},
    });
    const reg = tplCalls.find((c) => c.method === 'tool.register');
    check(
      '风险#5：applyImport 的 tool.register 经白名单裁剪（insert_template 不下发）',
      !!reg && reg.params.name === 'templated' && !('insert_template' in reg.params),
      JSON.stringify(reg && reg.params)
    );
  }

  check(
    'applyImport：summary 计数（created/updated/unchanged + tools）+ 无 errors',
    summary.streams.created === 1 &&
      summary.streams.updated === 1 &&
      summary.streams.unchanged === 1 &&
      summary.streams.failed === 0 &&
      summary.tools.registered === 1 &&
      summary.tools.updated === 1 &&
      summary.errors.length === 0,
    JSON.stringify({ streams: summary.streams, tools: summary.tools, errors: summary.errors })
  );

  // 流/工具同一缺失语义：包内相对路径缺失 → 跳过注册；外部绝对路径缺失 → 注册 + warning。
  {
    const symmetryManifest = {
      $schema: 'snake-manifest-v1',
      streams: [],
      tools: {
        rel_missing: { name: 'rel_missing', description: 'd', tool_path: 'tools/nope.py' },
        abs_missing: { name: 'abs_missing', description: 'd', tool_path: 'C:/missing/tool.py' },
      },
    };
    const symmetryPlan = planImport({
      manifest: symmetryManifest,
      contents: {},
      existingStreams: [],
      existingTools: [],
      statResults: { rel_missing: { exists: false }, abs_missing: { exists: false } },
    });
    const symmetryCalls = [];
    const symmetrySummary = await applyImport({
      plan: symmetryPlan,
      manifest: symmetryManifest,
      call: async (m, p) => {
        symmetryCalls.push({ method: m, params: p });
        return {};
      },
      contents: {},
      baseDir: 'C:/pkg',
    });
    check(
      'applyImport：流/工具同一缺失语义（包内相对→跳过；外部绝对→注册+warning）',
      symmetryPlan.tools[0]?.pathMissingKind === 'relative' &&
        symmetryPlan.tools[1]?.pathMissingKind === 'absolute' &&
        !symmetryCalls.some((c) => c.method === 'tool.register' && c.params.name === 'rel_missing') &&
        symmetryCalls.some((c) => c.method === 'tool.register' && c.params.name === 'abs_missing') &&
        symmetrySummary.tools.failed === 1 &&
        symmetrySummary.tools.registered === 1 &&
        symmetrySummary.warnings.length === 1,
      JSON.stringify({ plan: symmetryPlan.tools, summary: symmetrySummary })
    );
  }

  const callsConfirmed = [];
  const summaryConfirmed = await applyImport({
    plan,
    manifest: planManifest,
    call: async (m, p) => {
      callsConfirmed.push({ method: m, params: p });
      return {};
    },
    contents,
    strategy: 'overwrite',
    confirmReserved: true,
  });
  const confirmedFor = (method, pred) => callsConfirmed.some((c) => c.method === method && (!pred || pred(c.params)));
  check(
    'applyImport：confirmReserved=true ⇒ 应用 canvas set 与 edge.delta remove（无保留键 warning）',
    confirmedFor('stream.set_tag', (p) => p.name === 'alpha' && p.key === 'canvas' && p.value === 'false') &&
      confirmedFor('stream.remove_tag', (p) => p.name === 'alpha' && p.key === 'edge.delta') &&
      !summaryConfirmed.warnings.some((w) => w.includes('保留键')),
    JSON.stringify(summaryConfirmed.warnings)
  );

  const callsSkip = [];
  const summarySkip = await applyImport({
    plan,
    manifest: planManifest,
    call: async (m, p) => {
      callsSkip.push({ method: m, params: p });
      return {};
    },
    contents,
    strategy: 'skip',
    confirmReserved: true,
  });
  check(
    'applyImport：strategy=skip ⇒ 冲突项不动、包内新项仍创建（C2）',
    !callsSkip.some((c) => c.params && c.params.name === 'alpha') &&
      callsSkip.some((c) => c.method === 'stream.create' && c.params.name === 'gamma') &&
      summarySkip.streams.skipped === 1 &&
      summarySkip.streams.created === 1 &&
      summarySkip.streams.unchanged === 1,
    JSON.stringify(summarySkip.streams)
  );

  const failManifest = {
    $schema: 'snake-manifest-v1',
    streams: [
      { name: 'bad', title: 'Bad', tags: {}, content: 'x' },
      { name: 'good', title: 'Good', tags: {}, content: 'y' },
    ],
    tools: {},
  };
  const failPlan = planImport({
    manifest: failManifest,
    contents: { bad: 'x', good: 'y' },
    existingStreams: [],
    existingTools: [],
  });
  const failCalls = [];
  const summaryFail = await applyImport({
    plan: failPlan,
    manifest: failManifest,
    call: async (method, params) => {
      failCalls.push({ method, params });
      if (method === 'stream.create' && params.name === 'bad') throw new Error('boom');
      return {};
    },
    contents: { bad: 'x', good: 'y' },
  });
  check(
    'applyImport：单项失败记 errors 且继续其余（bad 失败 / good 仍创建）',
    summaryFail.errors.length === 1 &&
      summaryFail.streams.failed === 1 &&
      summaryFail.streams.created === 1 &&
      failCalls.some((c) => c.method === 'stream.create' && c.params.name === 'good'),
    JSON.stringify({ errors: summaryFail.errors, streams: summaryFail.streams })
  );

  const dupManifest = {
    $schema: 'snake-manifest-v1',
    streams: [{ name: 'dup', title: 'Dup', tags: {}, content: 'z' }],
    tools: {},
  };
  const dupPlan = planImport({ manifest: dupManifest, contents: { dup: 'z' }, existingStreams: [], existingTools: [] });
  const dupCall = (mode, calls) => async (method) => {
    if (calls) calls.push(method);
    if (method === 'stream.create') {
      const err = new Error('already exists');
      if (mode === 'code') err.code = -33002;
      else err.data = { kind: 'already-exists' };
      throw err;
    }
    return {};
  };
  // 残留存储修复：overwrite 且包内有正文 → already-exists 退化为 update（写入正文）；
  // skip → 维持静默跳过（幂等回灌契约）。
  const dupCalls1 = [];
  const dupSummary1 = await applyImport({ plan: dupPlan, manifest: dupManifest, call: dupCall('code', dupCalls1), contents: { dup: 'z' } });
  const dupCalls2 = [];
  const dupSummary2 = await applyImport({ plan: dupPlan, manifest: dupManifest, call: dupCall('kind', dupCalls2), contents: { dup: 'z' } });
  check(
    'applyImport：already-exists + overwrite + 有正文 ⇒ 退化 update（stream.write 以包为真源）',
    dupSummary1.streams.updated === 1 &&
      dupSummary1.streams.skipped === 0 &&
      dupSummary1.streams.failed === 0 &&
      dupCalls1.includes('stream.write') &&
      dupSummary2.streams.updated === 1 &&
      dupCalls2.includes('stream.write'),
    JSON.stringify([dupSummary1.streams, dupSummary2.streams])
  );
  const dupCallsSkip = [];
  const dupSummarySkip = await applyImport({
    plan: dupPlan,
    manifest: dupManifest,
    call: dupCall('code', dupCallsSkip),
    contents: { dup: 'z' },
    strategy: 'skip',
  });
  check(
    'applyImport：already-exists + strategy=skip ⇒ skipped（不写正文，幂等回灌兼容）',
    dupSummarySkip.streams.skipped === 1 &&
      dupSummarySkip.streams.failed === 0 &&
      !dupCallsSkip.includes('stream.write'),
    JSON.stringify(dupSummarySkip.streams)
  );

  // ── applyImport：正文缺失 ⇒ 不创建空流（期 13 修复）──────────────────
  const missingManifest = {
    $schema: 'snake-manifest-v1',
    streams: [
      { name: 'ghost', title: 'Ghost', tags: {}, source: { file_path: 'demo.streams/ghost.md', encoding: 'utf-8' } },
      { name: 'real', title: 'Real', tags: {}, content: 'R' },
    ],
    tools: {},
  };
  const fetchedMissing = await fetchStreamContents({
    manifest: missingManifest,
    manifestPath: PKG_BASE,
    readFile: async () => {
      throw new Error('ENOENT: no such file');
    },
  });
  const missingPlan = planImport({
    manifest: missingManifest,
    contents: fetchedMissing.contents,
    existingStreams: [],
    existingTools: [],
  });
  const ghostRow = missingPlan.streams.find((r) => r.name === 'ghost');
  const missingCalls = [];
  const missingSummary = await applyImport({
    plan: missingPlan,
    manifest: missingManifest,
    call: async (method, params) => {
      missingCalls.push({ method, params });
      return {};
    },
    contents: fetchedMissing.contents,
    strategy: 'overwrite',
  });
  check(
    'applyImport：contentMissing=true ⇒ 不调 stream.create（记 failed + error），有正文的行仍创建',
    ghostRow?.contentMissing === true &&
      ghostRow?.state === 'new' &&
      !missingCalls.some((c) => c.params && String(c.params.name) === 'ghost') &&
      missingSummary.streams.failed === 1 &&
      missingSummary.errors.length === 1 &&
      missingSummary.errors.some((e) => e.includes('ghost') && e.includes('正文缺失')) &&
      missingCalls.some((c) => c.method === 'stream.create' && c.params.name === 'real') &&
      missingSummary.streams.created === 1,
    JSON.stringify({
      streams: missingSummary.streams,
      errors: missingSummary.errors,
      calls: missingCalls.map((c) => [c.method, c.params && c.params.name]),
    })
  );

  const emptyManifest = {
    $schema: 'snake-manifest-v1',
    streams: [{ name: 'empty_ok', title: 'EmptyOK', tags: {}, content: '' }],
    tools: {},
  };
  const emptyContents = new Map([['empty_ok', '']]);
  const emptyPlan = planImport({
    manifest: emptyManifest,
    contents: emptyContents,
    existingStreams: [],
    existingTools: [],
  });
  const emptyRow = emptyPlan.streams.find((r) => r.name === 'empty_ok');
  const emptyCalls = [];
  const emptySummary = await applyImport({
    plan: emptyPlan,
    manifest: emptyManifest,
    call: async (method, params) => {
      emptyCalls.push({ method, params });
      return {};
    },
    contents: emptyContents,
  });
  check(
    "applyImport：显式空正文（contents.has(name) 且 ''）仍创建、不写 body、不计失败",
    emptyRow?.contentMissing === false &&
      emptyCalls.some((c) => c.method === 'stream.create' && c.params.name === 'empty_ok') &&
      !emptyCalls.some((c) => c.method === 'stream.write') &&
      emptySummary.streams.created === 1 &&
      emptySummary.streams.failed === 0 &&
      emptySummary.errors.length === 0 &&
      !('empty_ok' in emptySummary.streams.versions) &&
      emptySummary.streams.conflicts.some((c) => c.name === 'empty_ok' && c.reason === 'missing-version'),
    JSON.stringify({
      streams: emptySummary.streams,
      calls: emptyCalls.map((c) => [c.method, c.params && c.params.name]),
    })
  );

  // ── 期 12（D6）：单项导入选择一致性（过滤，不重算）────────────────────
  const rdRows = [
    { name: 'alpha', reservedRemovals: ['edge.x', 'canvas'], reservedAdds: ['edge.y'] },
    { name: 'beta', reservedRemovals: ['edge.dead'], reservedAdds: ['canvas'] },
  ];
  const rdSel = reservedDeltaSummary(rdRows, ['alpha']);
  check(
    'D6：reservedDeltaSummary 仅含已选行（未选 beta 的保留键差量被排除）',
    JSON.stringify(rdSel.removals) === JSON.stringify([{ stream: 'alpha', key: 'edge.x' }, { stream: 'alpha', key: 'canvas' }]) &&
      JSON.stringify(rdSel.adds) === JSON.stringify([{ stream: 'alpha', key: 'edge.y' }]),
    JSON.stringify(rdSel)
  );
  const rdEmpty = reservedDeltaSummary(undefined, undefined);
  const rdNoKeys = reservedDeltaSummary([{ name: 'alpha' }], ['alpha']);
  check(
    'D6：reservedDeltaSummary 容错非数组/缺失输入（空差量）',
    Array.isArray(rdEmpty.removals) &&
      rdEmpty.removals.length === 0 &&
      rdEmpty.adds.length === 0 &&
      rdNoKeys.removals.length === 0 &&
      rdNoKeys.adds.length === 0,
    JSON.stringify({ rdEmpty, rdNoKeys })
  );

  const danAll = [
    { source: 'alpha', target: 'ghost', label: '幽灵' },
    { source: 'gamma', target: 'ghost', label: '未选源' },
    { source: 'alpha', target: 'beta', label: '目标已选' },
  ];
  const danSel = filterPredictedDangling(danAll, ['alpha', 'beta']);
  check(
    'D6：filterPredictedDangling 丢弃未选源 / 目标已选，保留有效项',
    danSel.length === 1 &&
      danSel[0].source === 'alpha' &&
      danSel[0].target === 'ghost' &&
      danSel[0].label === '幽灵',
    JSON.stringify(danSel)
  );
  const danEmpty = filterPredictedDangling(null, ['alpha']);
  check(
    'D6：filterPredictedDangling 容错非数组输入（空数组）',
    Array.isArray(danEmpty) && danEmpty.length === 0
  );

  const selPlan = planImport({
    manifest: planManifest,
    contents,
    existingStreams,
    existingTools,
    selection: { streamNames: ['alpha'], toolNames: ['grep_runner'] },
  });
  const selCalls = [];
  const selSummary = await applyImport({
    plan: selPlan,
    manifest: planManifest,
    call: async (method, params) => {
      selCalls.push({ method, params });
      return {};
    },
    contents,
    baseDir: 'C:/pkg',
    registeredTools: registeredToolDefs,
    strategy: 'overwrite',
    confirmReserved: true,
  });
  const selCalled = (name) => selCalls.some((c) => c.params && String(c.params.name) === name);
  check(
    'D6/applyImport：未选行零调用（beta/gamma/fresh_tool），已选行照常应用（alpha/grep_runner）',
    !selCalled('beta') &&
      !selCalled('gamma') &&
      !selCalled('fresh_tool') &&
      selCalls.some((c) => c.method === 'stream.update_description' && c.params.name === 'alpha') &&
      selCalls.some((c) => c.method === 'tool.unregister' && c.params.name === 'grep_runner') &&
      selSummary.streams.updated === 1 &&
      selSummary.tools.updated === 1 &&
      selSummary.errors.length === 0,
    JSON.stringify({
      calls: selCalls.map((c) => [c.method, c.params && c.params.name]),
      streams: selSummary.streams,
      tools: selSummary.tools,
    })
  );

  // ── createOnly：仅新建；既有/竞态一律失败且零覆盖（createStream/promote seam）──
  {
    const coManifest = {
      $schema: 'snake-manifest-v1',
      streams: [{ name: 'alpha', description: '新', tags: { role: 'x' }, content: 'A' }],
      tools: { t: { name: 't', tool_path: 'C:/pkg/t.py' } },
    };
    const updatePlan = {
      streams: [{
        name: 'alpha', state: 'update', selected: true, contentChanged: true,
        descriptionChanged: true, tagDiff: { set: { role: 'x' }, remove: [] },
      }],
      tools: [{
        name: 't', state: 'update', selected: true, pathMissing: false, pathMissingKind: null,
      }],
      predictedDangling: [],
      warnings: [],
    };
    const coCalls = [];
    const coSummary = await applyImport({
      plan: updatePlan,
      manifest: coManifest,
      call: async (method, params) => {
        coCalls.push({ method, params });
        return {};
      },
      contents: { alpha: 'A' },
      baseDir: 'C:/pkg',
      registeredTools: [{ name: 't', tool_path: 'C:/pkg/t.py' }],
      strategy: 'overwrite',
      createOnly: true,
    });
    check(
      'createOnly：stream update 行失败且零写入（无 write/description/set_tag）',
      coSummary.streams.failed === 1 &&
        coSummary.streams.updated === 0 &&
        !coCalls.some((c) => c.method === 'stream.write' || c.method === 'stream.update_description' || c.method === 'stream.set_tag') &&
        coSummary.errors.some((e) => e.includes('alpha') && e.includes('createOnly')),
      JSON.stringify({ streams: coSummary.streams, calls: coCalls.map((c) => c.method) })
    );
    check(
      'createOnly：tool update 行失败且零替换（无 unregister/register）',
      coSummary.tools.failed === 1 &&
        coSummary.tools.updated === 0 &&
        !coCalls.some((c) => c.method === 'tool.unregister' || c.method === 'tool.register') &&
        coSummary.errors.some((e) => e.includes('工具 t') && e.includes('createOnly')),
      JSON.stringify({ tools: coSummary.tools, calls: coCalls.map((c) => c.method) })
    );

    const racePlan = {
      streams: [{
        name: 'alpha', state: 'new', selected: true, contentChanged: true,
        descriptionChanged: false, tagDiff: { set: {}, remove: [] },
      }],
      tools: [{ name: 't', state: 'new', selected: true, pathMissing: false, pathMissingKind: null }],
      predictedDangling: [],
      warnings: [],
    };
    const raceCalls = [];
    const raceSummary = await applyImport({
      plan: racePlan,
      manifest: coManifest,
      call: async (method) => {
        raceCalls.push(method);
        const err = new Error('already exists');
        if (method === 'stream.create' || method === 'tool.register') {
          err.code = -33002;
          err.data = { kind: 'already-exists' };
          throw err;
        }
        return {};
      },
      contents: { alpha: 'A' },
      baseDir: 'C:/pkg',
      registeredTools: [{ name: 't', tool_path: 'C:/pkg/t.py' }],
      strategy: 'skip',
      createOnly: true,
    });
    check(
      'createOnly：stream already-exists 竞态失败（skip 策略也不得 skipped/写正文/播种版本）',
      raceSummary.streams.failed === 1 &&
        raceSummary.streams.skipped === 0 &&
        raceSummary.streams.created === 0 &&
        !raceCalls.includes('stream.write') &&
        !('alpha' in raceSummary.streams.versions),
      JSON.stringify({ streams: raceSummary.streams, calls: raceCalls })
    );
    check(
      'createOnly：tool 计划 new 但实况已存在 → 失败且零 unregister/register',
      raceSummary.tools.failed === 1 &&
        raceSummary.tools.skipped === 0 &&
        !raceCalls.includes('tool.unregister') &&
        !raceCalls.includes('tool.register'),
      JSON.stringify({ tools: raceSummary.tools, calls: raceCalls })
    );

    const opaquePriorCalls = [];
    const opaquePriorSummary = await applyImport({
      plan: { streams: [], tools: [racePlan.tools[0]], predictedDangling: [], warnings: [] },
      manifest: coManifest,
      call: async (method) => {
        opaquePriorCalls.push(method);
        return {};
      },
      contents: {},
      baseDir: 'C:/pkg',
      registeredTools: [{ name: 't' }],
      createOnly: true,
    });
    check(
      'createOnly：实况已存在但旧定义不可读 → 仍失败且零 register',
      opaquePriorSummary.tools.failed === 1 &&
        opaquePriorCalls.length === 0 &&
        opaquePriorSummary.errors.some((e) => e.includes('createOnly')),
      JSON.stringify({ tools: opaquePriorSummary.tools, calls: opaquePriorCalls })
    );

    const regRaceCalls = [];
    const regRaceSummary = await applyImport({
      plan: { ...racePlan, tools: [racePlan.tools[0]] },
      manifest: coManifest,
      call: async (method) => {
        regRaceCalls.push(method);
        if (method === 'tool.register') {
          throw Object.assign(new Error('already'), { code: -33002, data: { kind: 'already-exists' } });
        }
        return {};
      },
      contents: { alpha: 'A' },
      baseDir: 'C:/pkg',
      registeredTools: [],
      createOnly: true,
    });
    check(
      'createOnly：tool.register 撞 already-exists 失败且绝不 unregister',
      regRaceSummary.tools.failed === 1 &&
        !regRaceCalls.includes('tool.unregister') &&
        regRaceSummary.errors.some((e) => e.includes('createOnly')),
      JSON.stringify({ tools: regRaceSummary.tools, calls: regRaceCalls })
    );
  }

  // ── applyImport：捕获新建流的版本（供 createStream 播种）──────────────
  {
    const call = async (m, p) => {
      if (m === 'stream.create') return { version: 7 };
      if (m === 'stream.write') return { version: 8 };
      return {};
    };
    const manifest = {
      $schema: 'snake-manifest-v1',
      id: 'ver',
      streams: [{ name: 'alpha', description: '', tags: {} }],
      tools: {},
    };
    const plan = planImport({
      manifest,
      contents: new Map([['alpha', 'body']]),
      existingStreams: [],
      existingTools: [],
    });
    const summary = await applyImport({
      plan,
      manifest,
      call,
      contents: new Map([['alpha', 'body']]),
      strategy: 'overwrite',
    });
    check(
      'applyImport：新建流写入后捕获 version（create=7 → write=8）',
      summary.streams.versions && summary.streams.versions.alpha === 8,
      JSON.stringify(summary.streams.versions)
    );
  }

  // ── P0 回归：绝对路径守卫 / 同名覆盖 / 无 prior 的安全失败 ──────────────
  {
    const manifest = {
      $schema: 'snake-manifest-v1',
      id: 'p0-tools',
      streams: [],
      tools: {
        rel: { name: 'rel', description: 'd', tool_path: 'tools/rel.py' },
      },
    };
    const prior = { name: 'rel', description: 'old', tool_path: 'tools/rel.py' };

    // (a) 相对 baseDir + 相对 tool_path：必须在 unregister 之前失败。
    const relCalls = [];
    const relPlan = planImport({
      manifest,
      contents: {},
      existingStreams: [],
      existingTools: [{ name: 'rel' }],
    });
    const relSummary = await applyImport({
      plan: relPlan,
      manifest,
      contents: {},
      call: async (m, p) => {
        relCalls.push({ method: m, params: p });
        return {};
      },
      baseDir: 'graphs',
      registeredTools: [prior],
      strategy: 'overwrite',
    });
    check(
      'P0：相对 base 的相对 tool_path 在 unregister 之前失败',
      relSummary.tools.failed === 1 &&
        !relCalls.some((c) => c.method === 'tool.unregister') &&
        relSummary.errors.some((e) => e.includes('不是绝对路径')),
      JSON.stringify({ summary: relSummary.tools, calls: relCalls.map((c) => c.method) })
    );

    // (b) 计划误判 new、实况已存在、覆盖：按更新替换，不静默 skip。
    const replCalls = [];
    const replPlan = planImport({
      manifest,
      contents: {},
      existingStreams: [],
      existingTools: [],
    });
    const replSummary = await applyImport({
      plan: replPlan,
      manifest,
      contents: {},
      call: async (m, p) => {
        replCalls.push({ method: m, params: p });
        return {};
      },
      baseDir: 'C:/pkg',
      registeredTools: [prior],
      strategy: 'overwrite',
    });
    const replReg = replCalls.find((c) => c.method === 'tool.register');
    check(
      'P0：new + already-exists + overwrite + prior → 替换并计 updated',
      replSummary.tools.updated === 1 &&
        replSummary.tools.skipped === 0 &&
        replCalls.some((c) => c.method === 'tool.unregister') &&
        !!replReg &&
        replReg.params.tool_path === 'C:/pkg/tools/rel.py',
      JSON.stringify({ summary: replSummary.tools, calls: replCalls })
    );

    // (c) 计划 new、无 prior、register 撞 already-exists：失败且不 unregister。
    const noPriorCalls = [];
    const noPriorSummary = await applyImport({
      plan: replPlan,
      manifest,
      contents: {},
      call: async (m, p) => {
        noPriorCalls.push({ method: m, params: p });
        if (m === 'tool.register') {
          throw Object.assign(new Error('already'), { code: -33002, data: { kind: 'already-exists' } });
        }
        return {};
      },
      baseDir: 'C:/pkg',
      registeredTools: [],
      strategy: 'overwrite',
    });
    check(
      'P0：new + already-exists 且无 prior → 失败且不盲目 unregister',
      noPriorSummary.tools.failed === 1 &&
        !noPriorCalls.some((c) => c.method === 'tool.unregister') &&
        noPriorSummary.errors.some((e) => e.includes('无法读取旧定义')),
      JSON.stringify({ summary: noPriorSummary.tools, calls: noPriorCalls.map((c) => c.method) })
    );

    // (d) update：register 失败 → 回滚 prior（unregister, register-new, register-prior）。
    const rbCalls = [];
    let firstReg = true;
    const rbSummary = await applyImport({
      plan: relPlan,
      manifest,
      contents: {},
      call: async (m, p) => {
        rbCalls.push({ method: m, params: p });
        if (m === 'tool.register' && firstReg) {
          firstReg = false;
          throw new Error('boom');
        }
        return { success: true };
      },
      baseDir: 'C:/pkg',
      registeredTools: [prior],
      strategy: 'overwrite',
    });
    check(
      'P0：update register 失败 → 回滚 prior 并计 failed',
      rbSummary.tools.failed === 1 &&
        rbCalls.filter((c) => c.method === 'tool.register').length === 2 &&
        rbSummary.errors.some((e) => e.includes('已回滚旧定义')),
      JSON.stringify({ summary: rbSummary.tools, calls: rbCalls.map((c) => c.method) })
    );
  }
}

try {
  await main();
} catch (err) {
  check('单测执行', false, String((err && err.stack) || err));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
