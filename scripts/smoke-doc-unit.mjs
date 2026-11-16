// 阶段 9 纯 Node 单测冒烟：统一文档格式（src/document.js）与 SE 边派生（src/se/edges.js）。
//
// 为什么不用浏览器 / 不连 snakeeats：这两个模块都是纯逻辑（无 React / DOM / ws 依赖），
// 统一文档的构建/解析与「tag → 边」派生可在 Node 直接 import 断言格式语义，
// 比 e2e 冒烟快且稳。覆盖契约：构建↔解析往返、写端收窄（scan/processes 不落盘）、
// v1 旧文档读容错、title 优先级、边往返 + 悬空/重复 id 告警、saved_at 行为、
// v1 判定、tag 派生边（含自环/悬空/非法目标/非 edge 标签）、入边引用收集（collectInboundRefs）。
// 布局单载体（v5）：构建只写 `system.graph.layout`（含有限正数宽高），streams 条目不再带 position；
// 解析优先 layout（宽高 → node.style），回退链保留 `streams[].position` → `system.graph.positions`。
// 运行：node scripts/smoke-doc-unit.mjs（全绿退出码 0，任一断言失败退出码 1）。

import { buildDocument, parseDocument, isUnifiedDocument, DOC_SCHEMA } from '../src/document.js';
import { deriveEdgesFromTags, edgeId, collectInboundRefs } from '../src/se/edges.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 160) : ''}`);
};

try {
  // ── 1. v3 构建：只记 source.file_path，不写内联 content / title ────────
  const nodeAll = {
    id: 'n-all',
    position: { x: 12.5, y: -30 },
    style: { width: 320, height: 180 },
    data: {
      name: '全字段流',
      description: '描述文本',
      content: '# 内容\n正文',
      fields: [
        { key: 'k1', value: 'v1' },
        { key: 'k2', value: 'v2' },
      ],
    },
  };
  // 宽高写入收窄：仅有限正数才进 layout 条目（0/负数/非数不写键）。
  const nodeZero = {
    id: 'n-zero',
    position: { x: 0, y: 0 },
    style: { width: 0, height: -3 },
    data: { name: '零尺寸' },
  };
  const doc1 = buildDocument({ name: '系统A', nodes: [nodeAll, nodeZero], edges: [], tools: {} }, undefined);
  const s1 = doc1.streams[0] || {};
  const l1 = doc1.system?.graph?.layout || {};
  check(
    '1 构建：stream 保留 name/description/tags + source.file_path，无 title/content/position',
    doc1.$schema === DOC_SCHEMA &&
      doc1.$schema === 'snake-manifest-v1' &&
      typeof doc1.id === 'string' &&
      doc1.id.startsWith('系统A#') &&
      doc1.namespace === '系统A' &&
      Array.isArray(doc1.system?.graph?.edges) &&
      s1.name === '全字段流' &&
      typeof s1.id === 'string' &&
      !('title' in s1) &&
      s1.description === '描述文本' &&
      !('content' in s1) &&
      !('position' in s1) &&
      s1.source?.file_path === '系统A.streams/全字段流.md' &&
      s1.source?.encoding === 'utf-8' &&
      s1.tags?.k1 === 'v1' &&
      s1.tags?.k2 === 'v2',
    JSON.stringify(s1)
  );
  check(
    '1 构建：system.graph.layout 落条目（含有限正数宽高；零/负宽高不写键）',
    doc1.system?.graph?.format_version === '5.0' &&
      !('positions' in (doc1.system?.graph || {})) &&
      l1['全字段流']?.x === 12.5 &&
      l1['全字段流']?.y === -30 &&
      l1['全字段流']?.width === 320 &&
      l1['全字段流']?.height === 180 &&
      l1['零尺寸']?.x === 0 &&
      l1['零尺寸']?.y === 0 &&
      !('width' in (l1['零尺寸'] || {})) &&
      !('height' in (l1['零尺寸'] || {})),
    JSON.stringify(l1)
  );
  const p1 = parseDocument(doc1);
  const pd1 = p1.nodes[0]?.data || {};
  check(
    '1 解析：data.source 还原、contentState=unknown、tags→fields、position/style 往返',
    pd1.name === '全字段流' &&
      !('title' in pd1) &&
      pd1.description === '描述文本' &&
      !('content' in pd1) &&
      pd1.contentState === 'unknown' &&
      pd1.source?.file_path === '系统A.streams/全字段流.md' &&
      Array.isArray(pd1.fields) &&
      pd1.fields.length === 2 &&
      pd1.fields[0]?.key === 'k1' &&
      pd1.fields[0]?.value === 'v1' &&
      p1.nodes[0]?.position?.x === 12.5 &&
      p1.nodes[0]?.position?.y === -30 &&
      p1.nodes[0]?.style?.width === 320 &&
      p1.nodes[0]?.style?.height === 180 &&
      p1.nodes[1]?.position?.x === 0 &&
      p1.nodes[1]?.position?.y === 0 &&
      !('style' in (p1.nodes[1] || {})),
    JSON.stringify({ pos: p1.nodes[0]?.position, style: p1.nodes[0]?.style, zero: p1.nodes[1] })
  );

  // ── 2. 写端收窄：运行时状态 scan/processes 不落盘 ─────────────────────
  const nodeNarrow = {
    id: 'n-narrow',
    position: { x: 0, y: 0 },
    data: {
      name: '收窄流',
      scan: { state: 'scanning', position: 7, ok: 3, fail: 1 },
      processes: ['claude + 任务'],
    },
  };
  const doc2 = buildDocument({ name: 'sys', nodes: [nodeNarrow], edges: [], tools: {} }, undefined);
  const narrowKeys = Object.keys(doc2.streams[0] || {});
  check(
    '2 写端收窄：stream 无 scan/processes/content 键',
    !narrowKeys.includes('scan') && !narrowKeys.includes('processes') && !narrowKeys.includes('content'),
    narrowKeys.join(',')
  );

  // ── 3. v1 旧文档读容错：streams[0] 携带 scan/processes 不抛且忽略 ────
  const legacyDoc = {
    version: '1.0',
    streams: [
      {
        id: 's-1',
        name: '旧流',
        title: '旧流',
        tags: { canvas: 'false' },
        content: '旧内容',
        position: { x: 3, y: 4 },
        scan: { state: 'scanning', position: 9, ok: 2, fail: 1 },
        processes: ['claude + 任务'],
      },
    ],
    edges: [],
    tools: {},
  };
  let legacyOut = null;
  try {
    legacyOut = parseDocument(legacyDoc);
  } catch {
    legacyOut = null;
  }
  const legacyData = legacyOut?.nodes?.[0]?.data || {};
  check(
    '3 v1 内联读容错：content 保留 + contentState=loaded + 无 scan/processes',
    !!legacyOut &&
      legacyData.content === '旧内容' &&
      legacyData.contentState === 'loaded' &&
      !('scan' in legacyData) &&
      !('processes' in legacyData),
    `data keys=${Object.keys(legacyData).join(',')}`
  );
  // 冷启动文件权威：存在 source 时，旧内联（含空串）不得覆盖待加载状态。
  const sourcePriorityOut = parseDocument({
    streams: [
      { id: 'source-stale', name: '引用旧内联', content: '过期内容', source: { file_path: 'docs/current.md' } },
      { id: 'source-empty', name: '引用空内联', content: '', source: { file_path: 'docs/empty.md' } },
    ],
    edges: [],
    tools: {},
  });
  const sourceStaleData = sourcePriorityOut.nodes[0]?.data || {};
  const sourceEmptyData = sourcePriorityOut.nodes[1]?.data || {};
  check(
    '3 引用优先：非空内联忽略，contentState=unknown 且无 data.content',
    sourceStaleData.contentState === 'unknown' &&
      !('content' in sourceStaleData) &&
      sourceStaleData.source?.file_path === 'docs/current.md',
    JSON.stringify(sourceStaleData)
  );
  check(
    '3 引用优先：空内联同样忽略，contentState=unknown 且无 data.content',
    sourceEmptyData.contentState === 'unknown' &&
      !('content' in sourceEmptyData) &&
      sourceEmptyData.source?.file_path === 'docs/empty.md',
    JSON.stringify(sourceEmptyData)
  );
  // 回退兼容（v5 读端）：无 layout 时 streams[].position 仍可读，旧格式无 style。
  check(
    '3 回退：streams[].position 旧位可读（无 layout → 条目优先；无 style）',
    legacyOut?.nodes?.[0]?.position?.x === 3 &&
      legacyOut?.nodes?.[0]?.position?.y === 4 &&
      !('style' in (legacyOut.nodes[0] || {})),
    JSON.stringify(legacyOut?.nodes?.[0])
  );
  const legacyPosOut = parseDocument({
    $schema: 'snake-manifest-v1',
    streams: [{ id: 's-p', name: '旧位流' }],
    tools: {},
    system: { graph: { positions: { 旧位流: { x: 7, y: 8 } } } },
  });
  check(
    '3 回退：system.graph.positions[name] 旧位表可读（旧格式无 style）',
    legacyPosOut.nodes[0]?.position?.x === 7 &&
      legacyPosOut.nodes[0]?.position?.y === 8 &&
      !('style' in (legacyPosOut.nodes[0] || {})),
    JSON.stringify(legacyPosOut.nodes[0])
  );
  const layoutWins = parseDocument({
    $schema: 'snake-manifest-v1',
    streams: [{ id: 's-a', name: '甲', position: { x: 1, y: 1 } }],
    tools: {},
    system: { graph: { layout: { 甲: { x: 9, y: 9, width: 200 } }, positions: { 甲: { x: 5, y: 5 } } } },
  });
  check(
    '3 优先：layout 覆盖 streams[].position / system.graph.positions（宽高 → style）',
    layoutWins.nodes[0]?.position?.x === 9 &&
      layoutWins.nodes[0]?.position?.y === 9 &&
      layoutWins.nodes[0]?.style?.width === 200 &&
      !('height' in (layoutWins.nodes[0]?.style || {})),
    JSON.stringify(layoutWins.nodes[0])
  );

  // ── 4. name 为准：name 直接使用；旧文档缺 name 回落 title ─────────────
  const p4 = parseDocument({
    streams: [
      { id: 't1', name: 'abc' },
      { id: 't2', name: 'abc2', title: '中文标题' },
      { id: 't3', title: '仅旧title' },
    ],
    edges: [],
    tools: {},
  });
  check('4 name 为准：name 直接使用', p4.nodes[0]?.data?.name === 'abc', p4.nodes[0]?.data?.name);
  check('4 兼容：name 优先于 title', p4.nodes[1]?.data?.name === 'abc2', p4.nodes[1]?.data?.name);
  check('4 兼容：缺 name 回落旧 title', p4.nodes[2]?.data?.name === '仅旧title', p4.nodes[2]?.data?.name);
  check(
    '4 无内联无引用：contentState=missing（不置空）',
    p4.nodes[0]?.data?.contentState === 'missing' && !('content' in (p4.nodes[0]?.data || {})),
    JSON.stringify(p4.nodes[0]?.data || {})
  );

  // ── 5a. 边往返：有效边保留，悬空边丢弃并记 warnings ──────────────────
  const nodes5 = [
    { id: 'x', position: { x: 0, y: 0 }, data: { name: 'X' } },
    { id: 'y', position: { x: 0, y: 0 }, data: { name: 'Y' } },
  ];
  const doc5 = buildDocument(
    {
      name: 'sys',
      nodes: nodes5,
      edges: [
        { source: 'x', target: 'y', label: '调用' },
        { source: 'x', target: 'ghost', label: '' },
      ],
      tools: {},
    },
    undefined
  );
  const p5 = parseDocument(doc5);
  const e5 = p5.edges[0] || {};
  check(
    '5 边往返：有效边保留（id/source/target/label）',
    p5.edges.length === 1 && e5.id === 'e-1' && e5.source === 'x' && e5.target === 'y' && e5.label === '调用',
    JSON.stringify(p5.edges)
  );
  check(
    '5 悬空边：丢弃并记 warnings',
    p5.warnings.length === 1 && p5.warnings.some((w) => w.includes('edges[1]')),
    p5.warnings.join(' || ')
  );

  // ── 5b. 重复流 id：第二个改名并记 warning ─────────────────────────────
  const p5b = parseDocument({
    streams: [
      { id: 'dup', name: 'A' },
      { id: 'dup', name: 'B' },
    ],
    edges: [],
    tools: {},
  });
  check(
    '5 重复 id：第二个改名 + warning',
    p5b.nodes[0]?.id === 'dup' &&
      p5b.nodes[1]?.id === 'dup-2' &&
      p5b.warnings.some((w) => w.includes('重复')),
    `ids=${p5b.nodes.map((n) => n.id).join(',')} warnings=${p5b.warnings.join(' || ')}`
  );

  // ── 6. saved_at：undefined 自动时间戳；null 省略 ─────────────────────
  const doc6a = buildDocument({ name: 'sys', nodes: [], edges: [], tools: {} }, undefined);
  const doc6b = buildDocument({ name: 'sys', nodes: [], edges: [], tools: {} }, null);
  check(
    '6 saved_at：undefined → 自动 ISO 时间戳',
    typeof doc6a.saved_at === 'string' && !Number.isNaN(Date.parse(doc6a.saved_at)),
    doc6a.saved_at
  );
  check('6 saved_at：null → 省略', !('saved_at' in doc6b));

  // ── 6b. viewport 往返：system.graph.viewport 透传，缺省干净不落键 ──────
  const doc6c = buildDocument(
    { name: 'sys', nodes: [], edges: [], tools: {}, viewport: { x: 10, y: -20, zoom: 1.5 } },
    undefined
  );
  check(
    '6b 构建：viewport 合法 → system.graph.viewport = {x,y,zoom}',
    doc6c.system?.graph?.viewport?.x === 10 &&
      doc6c.system?.graph?.viewport?.y === -20 &&
      doc6c.system?.graph?.viewport?.zoom === 1.5,
    JSON.stringify(doc6c.system?.graph?.viewport)
  );
  const p6c = parseDocument(doc6c);
  check(
    '6b 往返：parseDocument 还原相同 viewport',
    p6c.viewport?.x === 10 && p6c.viewport?.y === -20 && p6c.viewport?.zoom === 1.5,
    JSON.stringify(p6c.viewport)
  );
  const doc6d = buildDocument({ name: 'sys', nodes: [], edges: [], tools: {} }, undefined);
  check('6b 构建：无 viewport → graph 键干净省略', !('viewport' in (doc6d.system?.graph || {})), JSON.stringify(doc6d.system?.graph));
  const p6d = parseDocument(doc6d);
  check('6b 解析：文档无 viewport → null', p6d.viewport === null, String(p6d.viewport));
  const p6e = parseDocument({
    ...doc6c,
    system: { graph: { ...doc6c.system.graph, viewport: { x: 'a', y: 0, zoom: 1 } } },
  });
  check('6b 解析：viewport 非有限数值 → null', p6e.viewport === null, String(p6e.viewport));

  // ── 7. isUnifiedDocument 判定 ────────────────────────────────────────
  check(
    '7 isUnifiedDocument：新 snake-manifest（$schema/system.graph）→ true',
    isUnifiedDocument({ $schema: 'snake-manifest-v1', streams: [], system: { graph: {} } }) === true &&
      isUnifiedDocument({ streams: [], system: { graph: { edges: [] } } }) === true
  );
  check('7 isUnifiedDocument：旧结构（顶层 streams）→ true（迁移后未重存仍可读）', isUnifiedDocument({ streams: [] }) === true);
  check(
    '7 isUnifiedDocument：v0/null/数组/非对象 → false',
    isUnifiedDocument({ nodes: [], edges: [] }) === false &&
      isUnifiedDocument(null) === false &&
      isUnifiedDocument([]) === false &&
      isUnifiedDocument(42) === false
  );

  // ── 8. deriveEdgesFromTags：tag → 边派生 ─────────────────────────────
  const seList = [
    { name: 'svc_a', tags: { 'edge.svc_b': '调用', canvas: 'false' } },
    { name: 'svc_b', tags: { 'edge.svc_a': '' } },
    { name: 'solo', tags: { 'edge.solo': '自环' } },
    { name: 'orphan', tags: { 'edge.missing': '悬空' } },
    { name: 'weird', tags: { 'edge.bad-name': '非法' } },
  ];
  const der = deriveEdgesFromTags(seList);
  const findEdge = (s, t) => der.edges.find((e) => e.source === s && e.target === t);
  const eAB = findEdge('svc_a', 'svc_b');
  check(
    '8 派生：edge.<target> → 一条边（id 稳定 se-e-…）',
    !!eAB &&
      eAB.id === `se-e-svc_a__svc_b` &&
      eAB.id === edgeId('svc_a', 'svc_b') &&
      eAB.label === '调用',
    JSON.stringify(der.edges)
  );
  const eBA = findEdge('svc_b', 'svc_a');
  check('8 派生：空字符串 label 保留为 \'\'（不丢）', !!eBA && eBA.label === '');
  check('8 派生：自环 edge.<self> 派生', !!findEdge('solo', 'solo'));
  check(
    '8 派生：edge.<missing> → dangling（不派生边）',
    der.dangling.some((d) => d.source === 'orphan' && d.target === 'missing') && !findEdge('orphan', 'missing'),
    JSON.stringify(der.dangling)
  );
  check(
    '8 派生：非 edge.* 标签（canvas）忽略',
    !der.edges.some((e) => e.target === 'canvas') && !der.dangling.some((d) => d.target === 'canvas')
  );
  // 源码行为：非法目标名（不符命名契约）未通过闸门 → 归入 dangling，绝不派生边。
  check(
    '8 派生：非法目标名（bad-name）不派生边',
    !findEdge('weird', 'bad-name') &&
      !der.edges.some((e) => e.target === 'bad-name') &&
      der.dangling.some((d) => d.source === 'weird' && d.target === 'bad-name'),
    JSON.stringify(der.dangling)
  );

  // ── 9. collectInboundRefs：入边引用收集（rename/delete 共用口径）──────
  const refList = [
    { name: 'src_a', tags: { 'edge.dst': '调用', canvas: 'false' } },
    { name: 'src_b', tags: { 'edge.dst': null } },
    { name: 'src_c', tags: {} },
    { name: 'dst', tags: { 'edge.dst': '自环' } },
    { name: 'src_near', tags: { 'edge.dstx': '近似名' } },
  ];
  const refsAll = collectInboundRefs(refList, 'dst');
  check(
    '9 collectInboundRefs：非自环入边收集 + label 保留',
    refsAll.length === 3 &&
      refsAll.some((r) => r.source === 'src_a' && r.label === '调用') &&
      refsAll.some((r) => r.source === 'src_b') &&
      refsAll.some((r) => r.source === 'dst' && r.label === '自环'),
    JSON.stringify(refsAll)
  );
  const refsNoSelf = collectInboundRefs(refList, 'dst', { excludeSelf: true });
  check(
    '9 collectInboundRefs：excludeSelf=true 排除自环',
    refsNoSelf.length === 2 && !refsNoSelf.some((r) => r.source === 'dst'),
    JSON.stringify(refsNoSelf)
  );
  check(
    '9 collectInboundRefs：edge.<target> 精确匹配（edge.x ≠ target xy）',
    collectInboundRefs([{ name: 's', tags: { 'edge.x': 'v' } }], 'xy').length === 0 &&
      collectInboundRefs([{ name: 's', tags: { 'edge.x': 'v' } }], 'x').length === 1
  );
  check(
    '9 collectInboundRefs：label null/undefined → \'\'',
    (() => {
      const r = collectInboundRefs(
        [
          { name: 's1', tags: { 'edge.dst': null } },
          { name: 's2', tags: { 'edge.dst': undefined } },
        ],
        'dst'
      );
      return r.length === 2 && r.every((x) => x.label === '');
    })()
  );
  check(
    '9 collectInboundRefs：缺失 tags / 空列表 / 非数组 → []',
    collectInboundRefs([{ name: 'n1' }, { name: 'n2', tags: null }], 'dst').length === 0 &&
      collectInboundRefs([], 'dst').length === 0 &&
      collectInboundRefs(null, 'dst').length === 0 &&
      collectInboundRefs(undefined, 'dst').length === 0
  );
  check(
    '9 collectInboundRefs：缺失 name 的行跳过',
    collectInboundRefs([{ tags: { 'edge.dst': 'x' } }, { name: '' }], 'dst').length === 0
  );
} catch (err) {
  check('单测执行', false, err.stack || String(err));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
