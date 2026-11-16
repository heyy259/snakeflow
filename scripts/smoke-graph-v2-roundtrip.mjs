// 图谱配置 v2 纯 Node 单测（期 1，方案 §4/§8/§9）：路径归属、source 分配、v2 往返、v1 回退、byte 保真。
//
// 为什么不用浏览器：document.js 是纯逻辑（无 React/DOM/fetch），可在 Node 直接断言 v2 语义。
// 覆盖契约：documentDirOf/documentFileNameOf 与服务端 sanitizeName 同源；planDocumentSources
// 确定性 + 不覆盖已有引用 + 重名消歧；buildDocument 只记 source 不写 content；parseDocument
// 三态（unknown/missing/loaded）+ v1 内联回退；CRLF/首尾空白不 trim（byte 保真）。
// 运行：node scripts/smoke-graph-v2-roundtrip.mjs（全绿退出码 0，任一断言失败退出码 1）。

import {
  buildDocument,
  parseDocument,
  DOC_SCHEMA,
  documentDirOf,
  documentFileNameOf,
  documentStreamsDirName,
  planDocumentSources,
  remapSourcePrefix,
} from '../src/document.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 160) : ''}`);
};

try {
  // ── 1. 图名净化：配置文件名与内容目录同源（与服务端 sanitizeName 同字符集） ──
  check(
    '1 documentDirOf：禁字符剥离 + 相对项目根',
    documentDirOf('计划/2026:Q1') === 'graphs/计划2026Q1.streams',
    documentDirOf('计划/2026:Q1')
  );
  check(
    '1 documentFileNameOf：与目录同基名 + .se.json',
    documentFileNameOf('计划/2026:Q1') === '计划2026Q1.se.json',
    documentFileNameOf('计划/2026:Q1')
  );
  check(
    '1 空图名：目录/文件名为空串（调用方跳过持久化）',
    documentDirOf('') === '' && documentDirOf('   ') === '' && documentFileNameOf('') === ''
  );

  // ── 2. planDocumentSources：确定性 + 不覆盖已有引用 + 重名消歧 ───────────
  const nodes2 = [
    { id: 'a', data: { name: '唯一' } },
    { id: 'b', data: { name: '重名' } },
    { id: 'c', data: { name: '重名' } },
    { id: 'd', data: { name: '已有引用', source: { file_path: 'graphs/S.streams/kept.md', encoding: 'utf-8' } } },
    { id: 'e', data: { name: 'kept' } }, // 与已有引用基名冲突 → 必须避让
  ];
  const plan2 = planDocumentSources('S', nodes2);
  check(
    '2 唯一名称 → <净化名>.md',
    plan2.get('a')?.file_path === 'S.streams/唯一.md',
    plan2.get('a')?.file_path
  );
  check(
    '2 重名消歧：首现 <名>.md、次现 <名>-<id>.md',
    plan2.get('b')?.file_path === 'S.streams/重名.md' &&
      plan2.get('c')?.file_path === 'S.streams/重名-c.md',
    JSON.stringify([plan2.get('b'), plan2.get('c')])
  );
  check(
    '2 已有引用原样保留（不重分配）',
    plan2.get('d')?.file_path === 'graphs/S.streams/kept.md',
    JSON.stringify(plan2.get('d'))
  );
  check(
    '2 避让已有引用基名：kept 冲突 → kept-<id>.md',
    plan2.get('e')?.file_path === 'S.streams/kept-e.md',
    plan2.get('e')?.file_path
  );
  check(
    '2 documentStreamsDirName：同级相对目录（无 graphs/ 前缀）',
    documentStreamsDirName('S') === 'S.streams' && documentStreamsDirName('') === ''
  );
  check(
    '2 空图名 → 全部 null',
    planDocumentSources('', [{ id: 'z', data: { name: 'x' } }]).get('z') === null
  );

  // ── 3. buildDocument 使用节点已有 source（不重分配） ─────────────────────
  const nodeRef = {
    id: 'n-1',
    position: { x: 1, y: 2 },
    data: { name: '名称不重要', source: { file_path: 'graphs/G.streams/custom.md', encoding: 'utf-8' }, content: '正文' },
  };
  const doc3 = buildDocument({ name: 'G', nodes: [nodeRef], edges: [], tools: {} }, null);
  check(
    '3 buildDocument：已有 source 原样写入，且不写 content',
    doc3.streams[0]?.source?.file_path === 'graphs/G.streams/custom.md' &&
      !('content' in (doc3.streams[0] || {})),
    JSON.stringify(doc3.streams[0])
  );

  // ── 4. v2 构建 → 解析往返：source 保留、contentState=unknown ─────────────
  const doc4 = buildDocument(
    { name: '往返', nodes: [{ id: 'x', position: { x: 0, y: 0 }, data: { name: '流X', content: 'CRLF\r\n  前后空白  ' } }], edges: [], tools: {} },
    null
  );
  const p4 = parseDocument(doc4);
  check(
    '4 新结构往返：$schema + system.graph.edges + source 同级相对 + contentState=unknown（不内联）',
    doc4.$schema === DOC_SCHEMA &&
      Array.isArray(doc4.system?.graph?.edges) &&
      p4.nodes[0]?.data?.source?.file_path === '往返.streams/流X.md' &&
      p4.nodes[0]?.data?.contentState === 'unknown' &&
      !('content' in (p4.nodes[0]?.data || {})),
    JSON.stringify(p4.nodes[0]?.data)
  );

  // ── 5. v1 内联回退：content 保真（CRLF + 首尾空白不 trim）+ loaded ──────
  const rawText = '第一行\r\n   缩进前导  \r\n末行带空格   ';
  const p5 = parseDocument({
    version: '1.0',
    streams: [{ id: 's1', name: '旧', title: '旧', content: rawText }],
    edges: [],
    tools: {},
  });
  check(
    '5 v1 内联：content 逐字节保留（不 trim、保 CRLF）',
    p5.nodes[0]?.data?.content === rawText,
    JSON.stringify(p5.nodes[0]?.data?.content)
  );
  check('5 v1 内联：contentState=loaded', p5.nodes[0]?.data?.contentState === 'loaded');

  // ── 6. 空内联 vs 缺失：空串是 loaded（0 字节文件可解析），非 missing ────
  const p6 = parseDocument({ streams: [{ id: 'e', title: '空', content: '' }], edges: [], tools: {} });
  check(
    '6 空内联：content==\'\' 且 loaded（与缺失可区分）',
    p6.nodes[0]?.data?.content === '' && p6.nodes[0]?.data?.contentState === 'loaded',
    JSON.stringify(p6.nodes[0]?.data)
  );
  const p6b = parseDocument({ streams: [{ id: 'm', title: '缺' }], edges: [], tools: {} });
  check(
    '6 无内联无引用：missing（不置空）',
    p6b.nodes[0]?.data?.contentState === 'missing' && !('content' in (p6b.nodes[0]?.data || {}))
  );

  // ── 7. remapSourcePrefix：tab 重命名迁移 source 前缀（D11） ───────────────
  const remapNodes = [
    { id: 'a', data: { name: 'A', source: { file_path: 'graphs/旧名.streams/A.md', encoding: 'utf-8' } } },
    { id: 'b', data: { name: 'B', source: { file_path: 'D:/external/B.md', encoding: 'utf-8' } } },
    { id: 'c', data: { name: 'C' } },
  ];
  const remapped = remapSourcePrefix(remapNodes, 'graphs/旧名.streams', 'graphs/新名.streams');
  check(
    '7 remapSourcePrefix：同目录前缀迁移、外部/无引用不动、原对象不变',
    remapped[0]?.data?.source?.file_path === 'graphs/新名.streams/A.md' &&
      remapped[1]?.data?.source?.file_path === 'D:/external/B.md' &&
      !remapped[2]?.data?.source &&
      remapNodes[0].data.source.file_path === 'graphs/旧名.streams/A.md' &&
      remapped !== remapNodes,
    JSON.stringify(remapped.map((n) => n.data?.source?.file_path || null))
  );

  // ── 8. v2 绝对路径引用 + 反斜杠归一 ──────────────────────────────────────
  const p7 = parseDocument({
    streams: [{ id: 'a', title: '绝对', source: { file_path: 'D:\\docs\\x.md', encoding: 'utf-8' } }],
    edges: [],
    tools: {},
  });
  check(
    '7 v2 绝对引用：反斜杠归一为正斜杠、contentState=unknown',
    p7.nodes[0]?.data?.source?.file_path === 'D:/docs/x.md' &&
      p7.nodes[0]?.data?.contentState === 'unknown',
    JSON.stringify(p7.nodes[0]?.data?.source)
  );

  // ── 9. 需求1/2：统一文档 tools 台账往返（含前端私有 insert_template）─────────
  {
    const doc = buildDocument({
      name: '工具台账',
      nodes: [],
      edges: [],
      tools: {
        grep_runner: {
          name: 'grep_runner',
          description: 'grep',
          tool_path: '/tools/grep.py',
          input_schema: { type: 'object' },
          insert_template: '@{grep_runner|{"pattern":"TODO"}}',
        },
      },
    });
    const back = parseDocument(doc);
    const t = back.tools.grep_runner;
    check(
      '9 台账往返：tools 及 insert_template 经统一文档保真（配置=唯一真源）',
      !!t &&
        t.name === 'grep_runner' &&
        t.tool_path === '/tools/grep.py' &&
        t.insert_template === '@{grep_runner|{"pattern":"TODO"}}',
      JSON.stringify(t)
    );
  }
} catch (err) {
  check('单测执行', false, err.stack || String(err));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
