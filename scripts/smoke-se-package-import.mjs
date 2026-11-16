// 期 11（D5）契约测试：真实导入通路（loadManifestFile → fetchStreamContents → planImport → applyImport）
// 打在真实 spawn 的 snakeeats SE 上，闭合期 10 的 B1/R3 缺口（manifest 无内联 content，正文只在兄弟 .streams/ 文件）。
//
// 语义（计划 §7.2，逐条对应）：
//   ① fixture 由导出组装器 `buildPackage()` 进程内生成（2 流含 canvas + edge.*、1 工具 tool_path 指向
//      真实临时文件、layout），兄弟文本先行、manifest 最后落盘（提交点）；manifest 无内联 content；
//   ② Node 侧经注入 readFile 的 `loadManifestFile` + `fetchStreamContents` 读回兄弟原文（非内联、非空）；
//   ③ 真 SE（spawnSe + --port 0 + registry 发现）→ connectSeDirect → planImport(existing=[]) 全 new →
//      applyImport(strategy:'overwrite', confirmReserved) ；
//   ④ 直连 RPC 断言：正文 === 兄弟文件原文（B1 修复实证）、tags 含 canvas/edge.*、tool.list 含工具；
//   ⑤ 二次导入：existing 非空 + existingContents → 全 unchanged；Q9 真幂等（无 stream.write、version 不变）；
//   ⑥ 改一条兄弟文件 → 该流 updated、正文更新；
//   ⑦ finally：direct.close + killTree + python 孤儿核对 + cleanupSeStorage（含 cmd rmdir 兜底）。
//
// 期 12（D8r）追加（真实 SE 契约）：
//   ⑦ 子集导入：独立 storage 的真实 SE 上，2 流包只选 alpha 导入 → stream.list 仅 alpha、beta 未创建；
//   ⑧ 工具三路径回读：tool.list 的 tool/execution/manual 三路径 + requires 与包定义一致；
//   ⑨ 同名编辑：⑨a 同名 register → -33002/already-exists（SE 不 upsert）；⑨b 直连 unregister→register
//      改后定义 → tool.list 反映新字段；⑨c toolDriver.update 打真实 SE → 反映新字段 + 恰好一次通知。
//
// 环境：`SE_REQUIRE=1` 时 SE 不可用为硬失败（exit 1）；否则打印 `SE SUITE: SKIPPED (...)` 并 exit 0。
// 清理纪律：Node v24 的 `fs.rmSync` 是静默 no-op —— 一律走 helper `cleanupSeStorage`，本脚本不直接 fs.rmSync。
import fs from 'node:fs';
import path from 'node:path';
import { buildPackage } from '../src/se/packageExport.js';
import { toPosix } from '../src/se/paths.js';
import { loadManifestFile, fetchStreamContents, planImport, applyImport } from '../src/se/packageImport.js';
import { createToolDriver } from '../src/se/toolDriver.js';
import {
  SE_SYSTEMS_DIR,
  spawnSe,
  waitRegistryPortOrAny,
  connectSeDirect,
  killTree,
  cleanupSeStorage,
  anyListener,
  pythonProcesses,
  resolveSeRuntimeForTests,
} from './se-test-helper.mjs';

const RUNTIME = await resolveSeRuntimeForTests();

const SE_REQUIRE = process.env.SE_REQUIRE === '1';

// ── 测试身份：storage id / system id 用 ASCII 唯一值；包显示名用中文（宽字符面）──
// 流名用 ASCII fixture（单一 name 模型下 name 即显示名；CJK name 端到端由 package-export 契约覆盖）──
const TEST_ID = 'pkg-import-s';
const PKG_ID = 'pkg-import-s-pkg'; // fixture 包目录（独立于 storage，便于分别清理）
const STORAGE = path.join(SE_SYSTEMS_DIR, TEST_ID);
const PKG_DIR = path.join(SE_SYSTEMS_DIR, PKG_ID);
const DISPLAY_NAME = '导入契约包';
const ALPHA_TEXT = '# 甲流正文\n\n导入契约测试（B1）：manifest 无内联 content，正文只在兄弟 .streams/ 文件。\n第二行含中文、ASCII 与符号 <>&。\n';
const ALPHA_TEXT_V2 = '# 甲流正文 v2\n\n增量覆盖后的新正文（该流应为 updated）。\n';
const BETA_TEXT = '# 乙流正文\n\n另一个兄弟文件。\n';
const EDGE_ALPHA_TO_BETA = '来自 alpha';
const EDGE_BETA_TO_ALPHA = '来自 beta';
const TOOL_NAME = 'grep_runner';
const TOOL_REL = 'tools/grep_runner.py';
const TOOL_FILE = path.join(PKG_DIR, TOOL_REL);
// 期 12（D8r）：工具三路径 + requires 回读所需的额外 fixture 文件。
const TOOL_EXEC_REL = 'run';
const TOOL_MANUAL_REL = 'tools/grep_runner.md';
const TOOL_REQUIRES = ['guard_root'];
const TOOL_EXEC_DIR = path.join(PKG_DIR, TOOL_EXEC_REL);
const TOOL_MANUAL_FILE = path.join(PKG_DIR, TOOL_MANUAL_REL);
// 期 12（D8r）：同名编辑契约 —— 独立工具名/文件，避免污染 fixture 工具既有断言。
const EDIT_TOOL = 'edit_probe';
const EDIT_TOOL_FILE = path.join(PKG_DIR, 'tools', 'edit_probe.py');
const EDIT_EXEC_1 = path.join(PKG_DIR, 'edit_run', 'v1');
const EDIT_EXEC_2 = path.join(PKG_DIR, 'edit_run', 'v2');
const EDIT_EXEC_3 = path.join(PKG_DIR, 'edit_run', 'v3');
const EDIT_MANUAL_1 = path.join(PKG_DIR, 'tools', 'edit_probe_v1.md');
const EDIT_MANUAL_2 = path.join(PKG_DIR, 'tools', 'edit_probe_v2.md');
const EDIT_MANUAL_3 = path.join(PKG_DIR, 'tools', 'edit_probe_v3.md');
const MANIFEST = path.join(PKG_DIR, `${DISPLAY_NAME}.se.json`);
const ALPHA_FILE = path.join(PKG_DIR, `${DISPLAY_NAME}.streams`, 'alpha.md');
const BETA_FILE = path.join(PKG_DIR, `${DISPLAY_NAME}.streams`, 'beta.md');
const SAVED_AT = '2026-09-22T00:00:00.000Z';
const SYSTEM_ID = TEST_ID;
const TOKEN = `pkg-import-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 180) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Node 侧注入读取通道（浏览器默认走 /api/fs/read；Node 进程无该端点，直接读盘）。 */
const readFile = (p) => fs.promises.readFile(p, 'utf-8');

let se = null;
let direct = null;
let skipped = null;
let writeCalls = 0;

/** applyImport 的 call：直连 RPC + 统计 stream.write 次数（Q9 幂等断言）。 */
const call = (method, params) => {
  if (method === 'stream.write') writeCalls += 1;
  return direct.call(method, params || {});
};

/** 组装 fixture 包并逐文件落盘（兄弟文本先行、manifest 最后 = 提交点）。 */
function buildAndWriteFixture() {
  fs.mkdirSync(PKG_DIR, { recursive: true });
  // 工具脚本必须真实存在：tool_path 指向真实临时文件。
  fs.mkdirSync(path.dirname(TOOL_FILE), { recursive: true });
  fs.writeFileSync(TOOL_FILE, '# smoke-se-package-import fixture tool\ndef main():\n    print("grep_runner")\n', 'utf-8');
  // D8r 工具三路径 fixture：execution_path 为真实目录、manual_path 为真实文件。
  fs.mkdirSync(TOOL_EXEC_DIR, { recursive: true });
  fs.writeFileSync(TOOL_MANUAL_FILE, '# grep_runner 手册（三路径回读 fixture）\n', 'utf-8');
  // D8r 同名编辑 fixture：tool_path 指向真实临时文件。
  fs.writeFileSync(EDIT_TOOL_FILE, '# smoke-se-package-import edit_probe fixture\ndef main():\n    print("edit_probe")\n', 'utf-8');

  const pkg = buildPackage({
    displayName: DISPLAY_NAME,
    streams: [
      {
        name: 'alpha',
        description: '含 canvas 与边标签的流',
        tags: { canvas: 'true', 'edge.beta': EDGE_ALPHA_TO_BETA },
        content: ALPHA_TEXT,
      },
      {
        name: 'beta',
        description: '',
        tags: { canvas: 'false', 'edge.alpha': EDGE_BETA_TO_ALPHA },
        content: BETA_TEXT,
      },
    ],
    tools: [
      {
        name: TOOL_NAME,
        description: '导入契约测试工具（tool_path 指向真实临时文件）',
        tool_path: TOOL_FILE,
        execution_path: TOOL_EXEC_DIR,
        manual_path: TOOL_MANUAL_FILE,
        requires: TOOL_REQUIRES,
        tags: { role: 'fixture' },
      },
    ],
    layout: { alpha: { x: 120, y: 80 }, beta: { x: 460, y: 80 } },
    baseDir: PKG_DIR,
    savedAt: SAVED_AT,
  });

  // files 顺序：兄弟文本（输入流序）在前、manifest（提交点）最后——按序落盘。
  for (const file of pkg.files) {
    const abs = path.join(PKG_DIR, file.relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, file.text, 'utf-8');
  }
  return pkg;
}

/** 逐轮短查 registry（带早退）：SE 启动失败时不必等满总超时。 */
async function waitPortOrExit(timeoutMs = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const port = await waitRegistryPortOrAny({ id: TEST_ID, timeoutMs: 2500, intervalMs: 250 });
    if (port) return port;
    if (se && se.exitCode != null) return null;
  }
  return null;
}

/**
 * 服务端现状：stream.list + tool.list + 包内已存在流的正文（Q7：existingContents 只读 包内∩已存在）。
 * @returns {Promise<{streams:Array, tools:Array, existingContents:Map<string,string>}>}
 */
async function collectServerState(streamNames) {
  const streamsRaw = await direct.call('stream.list', {}, 8000);
  const toolsRaw = await direct.call('tool.list', {}, 8000);
  const streams = Array.isArray(streamsRaw) ? streamsRaw : [];
  const existingContents = new Map();
  for (const name of streamNames) {
    if (!streams.some((s) => s && s.name === name)) continue;
    const read = await direct.call('stream.read', { name }, 8000);
    existingContents.set(name, read && read.text != null ? String(read.text) : '');
  }
  return { streams, tools: Array.isArray(toolsRaw) ? toolsRaw : [], existingContents };
}

/** Q9 断言用版本号：优先 stream.get_metadata.version，缺失回落 stream.list 行。 */
async function versionOf(name) {
  try {
    const meta = await direct.call('stream.get_metadata', { name }, 8000);
    if (meta && meta.version != null) return meta.version;
  } catch (err) {
    /* 回落 list */
  }
  const rows = await direct.call('stream.list', {}, 8000);
  const row = (Array.isArray(rows) ? rows : []).find((s) => s && s.name === name);
  return row ? row.version : null;
}

/** ⑤/⑥ 共用的服务端断言读取。 */
async function readText(name) {
  const res = await direct.call('stream.read', { name }, 8000);
  return res && res.text != null ? String(res.text) : null;
}
async function tagsOf(name) {
  const meta = await direct.call('stream.get_metadata', { name }, 8000);
  return (meta && meta.tags) || {};
}

/** ③-⑥：SE 就绪后的真实导入契约断言。 */
async function runSeContract(manifest, fetched) {
  const pkgStreamNames = manifest.streams.map((s) => s.name);

  // ── ③ 首次导入：existing=[] → 全 new → applyImport ─────────────────────
  const initial = await collectServerState(pkgStreamNames);
  check(
    '③ 初始 SE 为空：stream.list / tool.list 均为空',
    initial.streams.length === 0 && initial.tools.length === 0,
    `streams=${JSON.stringify(initial.streams.map((s) => s && s.name))} tools=${initial.tools.length}`
  );

  const plan1 = planImport({ manifest, contents: fetched.contents, existingStreams: [], existingTools: [] });
  check(
    '③ planImport(existing=[])：2 流全 new、selected、无 contentMissing',
    plan1.streams.length === 2 &&
      plan1.streams.every((r) => r.state === 'new' && r.selected && !r.contentMissing),
    JSON.stringify(plan1.streams.map((r) => ({ name: r.name, state: r.state, missing: r.contentMissing })))
  );
  check(
    '③ planImport：predictedDangling 为空（edge.* 目标均在包内）',
    Array.isArray(plan1.predictedDangling) && plan1.predictedDangling.length === 0,
    JSON.stringify(plan1.predictedDangling)
  );
  check(
    '③ planImport：工具 1 项 new',
    plan1.tools.length === 1 && plan1.tools[0].name === TOOL_NAME && plan1.tools[0].state === 'new',
    JSON.stringify(plan1.tools)
  );

  const writesBefore1 = writeCalls;
  const summary1 = await applyImport({
    plan: plan1,
    manifest,
    call,
    contents: fetched.contents,
    baseDir: PKG_DIR,
    registeredTools: [],
    strategy: 'overwrite',
    confirmReserved: true,
  });
  check(
    '③ applyImport(overwrite)：2 created + 1 tool registered、0 errors（正文非空 → 各写 1 次）',
    summary1.streams.created === 2 &&
      summary1.streams.failed === 0 &&
      summary1.tools.registered === 1 &&
      summary1.errors.length === 0 &&
      writeCalls - writesBefore1 === 2,
    JSON.stringify({ streams: summary1.streams, tools: summary1.tools, errors: summary1.errors, writes: writeCalls - writesBefore1 })
  );

  // ── ④ 直连 RPC 断言：正文 === 兄弟文件原文（B1） / tags / 工具 ─────────
  const alphaText1 = await readText('alpha');
  check(
    '④ B1 实证：stream.read alpha === 兄弟文件原文（非空）',
    alphaText1 === ALPHA_TEXT && alphaText1 !== '',
    JSON.stringify(alphaText1 == null ? alphaText1 : alphaText1.slice(0, 60))
  );
  check(
    '④ stream.read beta === 兄弟文件原文',
    (await readText('beta')) === BETA_TEXT,
    JSON.stringify((await readText('beta'))?.slice(0, 60))
  );
  const alphaTags = await tagsOf('alpha');
  check(
    "④ alpha tags 含 canvas + edge.beta（图结构随包）",
    alphaTags.canvas === 'true' && alphaTags['edge.beta'] === EDGE_ALPHA_TO_BETA,
    JSON.stringify(alphaTags)
  );
  const betaTags = await tagsOf('beta');
  check(
    '④ beta tags 含 canvas + edge.alpha',
    betaTags.canvas === 'false' && betaTags['edge.alpha'] === EDGE_BETA_TO_ALPHA,
    JSON.stringify(betaTags)
  );

  const state4 = await collectServerState(pkgStreamNames);
  const toolRow = state4.tools.find((t) => t && t.name === TOOL_NAME);
  check(
    '④ tool.list 含 grep_runner，且注册的 tool_path 是绝对路径且等于 fixture 真实文件',
    !!toolRow &&
      path.isAbsolute(String(toolRow.tool_path)) &&
      toPosix(toolRow.tool_path) === toPosix(TOOL_FILE),
    toolRow ? String(toolRow.tool_path) : JSON.stringify(state4.tools.map((t) => t && t.name))
  );

  // ── ⑤ 二次导入：existing 非空 → 全 unchanged、version 不变（Q9）────────
  const state5 = await collectServerState(pkgStreamNames);
  const versionsBefore = new Map();
  for (const name of pkgStreamNames) versionsBefore.set(name, await versionOf(name));
  check(
    '⑤ 二次导入前置：服务端已有 2 流且读到 existingContents（Q7 收窄）',
    state5.streams.length === 2 &&
      pkgStreamNames.every((n) => state5.existingContents.has(n) && state5.existingContents.get(n) !== ''),
    JSON.stringify({ streams: state5.streams.map((s) => s && s.name), contents: [...state5.existingContents.keys()] })
  );

  const plan2 = planImport({
    manifest,
    contents: fetched.contents,
    existingStreams: state5.streams,
    existingTools: state5.tools,
    existingContents: state5.existingContents,
  });
  check(
    '⑤ 二次导入：plan 2/2 全 unchanged',
    plan2.streams.length === 2 && plan2.streams.every((r) => r.state === 'unchanged'),
    JSON.stringify(plan2.streams.map((r) => ({ name: r.name, state: r.state, contentChanged: r.contentChanged })))
  );

  const writesBefore2 = writeCalls;
  const summary2 = await applyImport({
    plan: plan2,
    manifest,
    call,
    contents: fetched.contents,
    baseDir: PKG_DIR,
    registeredTools: state5.tools,
    strategy: 'overwrite',
    confirmReserved: true,
  });
  check(
    '⑤ applyImport：2 unchanged、0 created/updated、未再调 stream.write（Q9）',
    summary2.streams.unchanged === 2 &&
      summary2.streams.created === 0 &&
      summary2.streams.updated === 0 &&
      summary2.streams.failed === 0 &&
      writeCalls - writesBefore2 === 0 &&
      summary2.errors.length === 0,
    JSON.stringify({ streams: summary2.streams, writes: writeCalls - writesBefore2, errors: summary2.errors })
  );

  const versionsAfter = new Map();
  for (const name of pkgStreamNames) versionsAfter.set(name, await versionOf(name));
  check(
    '⑤ 幂等：version 不变 + 正文仍为原文',
    pkgStreamNames.every(
      (n) =>
        versionsBefore.get(n) != null &&
        versionsBefore.get(n) === versionsAfter.get(n) &&
        state5.existingContents.get(n) === (n === 'alpha' ? ALPHA_TEXT : BETA_TEXT)
    ),
    JSON.stringify({ before: [...versionsBefore], after: [...versionsAfter], read: await readText('alpha') })
  );

  // ── ⑥ 改兄弟文件 → 该流 updated、正文更新 ─────────────────────────────
  fs.writeFileSync(ALPHA_FILE, ALPHA_TEXT_V2, 'utf-8');
  const fetched2 = await fetchStreamContents({ manifest, manifestPath: MANIFEST, readFile });
  check(
    '⑥ 重读兄弟文件：alpha 内容为 v2（beta 不变）',
    fetched2.contents.get('alpha') === ALPHA_TEXT_V2 && fetched2.contents.get('beta') === BETA_TEXT,
    JSON.stringify(fetched2.contents.get('alpha')?.slice(0, 40))
  );

  const state6 = await collectServerState(pkgStreamNames);
  const plan3 = planImport({
    manifest,
    contents: fetched2.contents,
    existingStreams: state6.streams,
    existingTools: state6.tools,
    existingContents: state6.existingContents,
  });
  const alphaRow = plan3.streams.find((r) => r.name === 'alpha');
  const betaRow = plan3.streams.find((r) => r.name === 'beta');
  check(
    '⑥ 三次导入：alpha state=update + contentChanged，beta 仍 unchanged',
    !!alphaRow && alphaRow.state === 'update' && alphaRow.contentChanged === true &&
      !!betaRow && betaRow.state === 'unchanged',
    JSON.stringify(plan3.streams.map((r) => ({ name: r.name, state: r.state, contentChanged: r.contentChanged })))
  );

  const summary3 = await applyImport({
    plan: plan3,
    manifest,
    call,
    contents: fetched2.contents,
    baseDir: PKG_DIR,
    registeredTools: state6.tools,
    strategy: 'overwrite',
    confirmReserved: true,
  });
  const alphaText3 = await readText('alpha');
  check(
    '⑥ applyImport：1 updated（仅 alpha 写入）、正文更新为 v2、beta 正文不变',
    summary3.streams.updated === 1 &&
      summary3.streams.created === 0 &&
      summary3.streams.failed === 0 &&
      alphaText3 === ALPHA_TEXT_V2 &&
      (await readText('beta')) === BETA_TEXT,
    JSON.stringify({ streams: summary3.streams, alpha: alphaText3?.slice(0, 40), errors: summary3.errors })
  );

  // ── ⑧ 工具三路径 + requires 回读（真实 SE）─────────────────────────────
  const state7 = await collectServerState(pkgStreamNames);
  const tool7 = state7.tools.find((t) => t && t.name === TOOL_NAME);
  check(
    '⑧ 工具回读：tool.list 三路径（tool/execution/manual）均为绝对 + requires 与包定义一致',
    !!tool7 &&
      path.isAbsolute(String(tool7.tool_path)) &&
      path.isAbsolute(String(tool7.execution_path)) &&
      path.isAbsolute(String(tool7.manual_path)) &&
      toPosix(tool7.execution_path) === toPosix(TOOL_EXEC_DIR) &&
      toPosix(tool7.manual_path) === toPosix(TOOL_MANUAL_FILE) &&
      Array.isArray(tool7.requires) &&
      tool7.requires.length === TOOL_REQUIRES.length &&
      TOOL_REQUIRES.every((r) => tool7.requires.includes(r)),
    JSON.stringify(tool7 && { tool_path: tool7.tool_path, execution_path: tool7.execution_path, manual_path: tool7.manual_path, requires: tool7.requires })
  );

  // ── ⑨ 同名编辑（真实 SE）：SE 不 upsert → unregister→register ───────────
  // ⑨a 直接 RPC：同名 register 命中 -33002 / already-exists（P0 前提实证）。
  const editV1 = {
    name: EDIT_TOOL,
    description: '编辑契约 v1',
    tool_path: EDIT_TOOL_FILE,
    execution_path: EDIT_EXEC_1,
    manual_path: EDIT_MANUAL_1,
    requires: ['guard_root'],
  };
  await direct.call('tool.register', editV1, 8000);
  let dupErr = null;
  try {
    await direct.call('tool.register', editV1, 8000);
  } catch (err) {
    dupErr = err;
  }
  check(
    '⑨a SE tool.register 同名 → -33002 / already-exists（不 upsert）',
    !!dupErr && dupErr.code === -33002 && !!dupErr.data && dupErr.data.kind === 'already-exists',
    JSON.stringify({ code: dupErr && dupErr.code, kind: dupErr && dupErr.data && dupErr.data.kind })
  );

  // ⑧b 直接 RPC：unregister → register 改后定义 → tool.list 反映新字段。
  await direct.call('tool.unregister', { name: EDIT_TOOL }, 8000);
  const editV2 = { ...editV1, description: '编辑契约 v2', execution_path: EDIT_EXEC_2, manual_path: EDIT_MANUAL_2 };
  await direct.call('tool.register', editV2, 8000);
  const stateEdit2 = await collectServerState([]);
  const editRow2 = stateEdit2.tools.find((t) => t && t.name === EDIT_TOOL);
  check(
    '⑨b 直接 unregister→register：tool.list 反映改后 execution_path/manual_path/description',
    !!editRow2 &&
      editRow2.execution_path === EDIT_EXEC_2 &&
      editRow2.manual_path === EDIT_MANUAL_2 &&
      editRow2.description === '编辑契约 v2',
    JSON.stringify(editRow2 && { description: editRow2.description, execution_path: editRow2.execution_path, manual_path: editRow2.manual_path })
  );
  check(
    '⑨b 编辑后 requires 仍在（register 全量替换未丢字段）',
    !!editRow2 && Array.isArray(editRow2.requires) && editRow2.requires.includes('guard_root'),
    JSON.stringify(editRow2 && editRow2.requires)
  );

  // ⑧c 前端 toolDriver.update（期 12 D3）打在真实 SE 上：unregister→register + 恰好一次通知。
  // Oracle Q1：驱动为纯 RPC + 已注册名集合回报，**不写配置**（配置由 App commitTools 独占）。
  let tdStatus = null;
  const tdNotifies = [];
  const td = createToolDriver({
    call: (method, params) => direct.call(method, params || {}),
    notify: (text, kind) => tdNotifies.push({ text, kind }),
    onStatus: (snapshot) => {
      tdStatus = snapshot;
    },
  });
  const editV3 = { ...editV1, description: '编辑契约 v3', execution_path: EDIT_EXEC_3, manual_path: EDIT_MANUAL_3 };
  await td.update(EDIT_TOOL, editV3, editV2);
  const stateEdit3 = await collectServerState([]);
  const editRow3 = stateEdit3.tools.find((t) => t && t.name === EDIT_TOOL);
  check(
    '⑨c toolDriver.update（真实 SE）：tool.list 反映 v3 execution_path/manual_path/description',
    !!editRow3 &&
      editRow3.description === '编辑契约 v3' &&
      editRow3.execution_path === toPosix(EDIT_EXEC_3) &&
      editRow3.manual_path === toPosix(EDIT_MANUAL_3),
    `exec=${editRow3 && editRow3.execution_path} manual=${editRow3 && editRow3.manual_path}`
  );
  check(
    '⑨c toolDriver.update：恰好一次 ok 通知、无中间删除/注册 toast',
    tdNotifies.length === 1 && tdNotifies[0].kind === 'ok' && /已更新工具/.test(tdNotifies[0].text),
    JSON.stringify(tdNotifies)
  );
  check(
    '⑨c toolDriver.update：已注册名集合含新名（纯驱动，不写配置）',
    !!tdStatus && tdStatus.present && tdStatus.present.has(EDIT_TOOL),
    JSON.stringify(tdStatus && Array.from(tdStatus.present))
  );
}

/** 通用 registry 轮询（带子进程早退）；返回端口或 null。 */
async function waitPortFor(child, id, timeoutMs = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const port = await waitRegistryPortOrAny({ id, timeoutMs: 2500, intervalMs: 250 });
    if (port) return port;
    if (child && child.exitCode != null) return null;
  }
  return null;
}

/**
 * 期 12（D8r）：子集导入真实 SE 契约（独立 storage）。
 * 用独立 SE 实例而非在共享库 create→delete→recreate —— 后者会触发 SE W1-4 孤儿 journal
 * 守卫（删流后同名重建被 fail-closed 拒绝）。只选 alpha 导入 → stream.list 恰含 alpha、
 * beta 未创建（证明未选项零副作用）。自身 finally 全量清理（killTree + 孤儿核对 + storage）。
 * @param {object} manifest 已解析的 fixture manifest
 * @param {{contents:Map<string,string>}} fetched 兄弟文件正文
 */
async function runSubsetImportContract(manifest, fetched) {
  const SUB_ID = 'pkg-import-s-sub';
  const SUB_STORAGE = path.join(SE_SYSTEMS_DIR, SUB_ID);
  const SUB_TOKEN = `pkg-sub-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await cleanupSeStorage({ id: SUB_ID });

  const subsetPlan = planImport({
    manifest,
    contents: fetched.contents,
    existingStreams: [],
    existingTools: [],
    selection: { streamNames: ['alpha'], toolNames: [] },
  });
  check(
    '⑦ 子集导入 planImport：仅 alpha selected，beta 与工具均未选',
    subsetPlan.streams.length === 2 &&
      subsetPlan.streams.find((r) => r.name === 'alpha')?.selected === true &&
      subsetPlan.streams.find((r) => r.name === 'beta')?.selected === false &&
      subsetPlan.tools.length === 1 &&
      subsetPlan.tools[0].selected === false,
    JSON.stringify({ streams: subsetPlan.streams.map((r) => ({ name: r.name, selected: r.selected })), tools: subsetPlan.tools })
  );

  let seSub = null;
  let directSub = null;
  try {
    seSub = await spawnSe({ id: SUB_ID, token: SUB_TOKEN, storage: SUB_STORAGE, systemId: SUB_ID });
    const port = await waitPortFor(seSub, SUB_ID);
    check('⑦ 子集导入：独立 storage SE 就绪', !!port, port ? `port=${port}` : `exit=${seSub.exitCode}`);
    if (!port) throw new Error('subset import SE 未在期限内就绪');
    directSub = await connectSeDirect({ port, token: SUB_TOKEN });

    const subsetSummary = await applyImport({
      plan: subsetPlan,
      manifest,
      call: (method, params) => directSub.call(method, params || {}),
      contents: fetched.contents,
      strategy: 'overwrite',
      confirmReserved: true,
    });
    check(
      '⑦ 子集导入 applyImport：1 created、0 tool registered、0 errors',
      subsetSummary.streams.created === 1 &&
        subsetSummary.streams.failed === 0 &&
        subsetSummary.tools.registered === 0 &&
        subsetSummary.tools.failed === 0 &&
        subsetSummary.errors.length === 0,
      JSON.stringify({ streams: subsetSummary.streams, tools: subsetSummary.tools, errors: subsetSummary.errors })
    );

    const subsetRowsRaw = await directSub.call('stream.list', {}, 8000);
    const subsetRows = Array.isArray(subsetRowsRaw) ? subsetRowsRaw : [];
    check(
      '⑦ 子集导入：stream.list 含 alpha、不含 beta（未选项未创建）',
      subsetRows.length === 1 &&
        subsetRows.some((s) => s && s.name === 'alpha') &&
        !subsetRows.some((s) => s && s.name === 'beta'),
      JSON.stringify(subsetRows.map((s) => s && s.name))
    );
    const alphaRead = await directSub.call('stream.read', { name: 'alpha' }, 8000);
    const alphaMeta = await directSub.call('stream.get_metadata', { name: 'alpha' }, 8000);
    const alphaTags = (alphaMeta && alphaMeta.tags) || {};
    check(
      '⑦ 子集导入：alpha 正文 + tags 保真（canvas/edge.beta）',
      !!alphaRead &&
        alphaRead.text === ALPHA_TEXT &&
        alphaTags.canvas === 'true' &&
        alphaTags['edge.beta'] === EDGE_ALPHA_TO_BETA,
      JSON.stringify({ text: alphaRead && alphaRead.text != null ? alphaRead.text.slice(0, 30) : alphaRead, tags: alphaTags })
    );
  } finally {
    try {
      if (directSub) directSub.close();
    } catch (err) {
      /* 忽略 */
    }
    killTree(seSub);
    await sleep(1500);
    let leftovers = [];
    for (let i = 0; i < 6; i += 1) {
      leftovers = (await pythonProcesses()).filter((cmd) => cmd.includes('snakeeats') && cmd.includes(SUB_ID));
      if (!leftovers.length) break;
      await sleep(700);
    }
    check('⑦ 子集导入 finally：无本 storage 的 python 孤儿进程', leftovers.length === 0, leftovers.join(' || '));
    await cleanupSeStorage({ id: SUB_ID });
    check('⑦ 子集导入 finally：subset storage 已删除', !fs.existsSync(SUB_STORAGE), `storage=${fs.existsSync(SUB_STORAGE)}`);
  }
}

try {
  console.log(`[env] python=${RUNTIME.ok ? RUNTIME.python : ''}`);
  console.log(`[env] packageParent=${RUNTIME.ok ? RUNTIME.packageParent : ''}`);
  console.log(`[env] SE_REQUIRE=${SE_REQUIRE ? '1' : '0'}`);

  // 上轮失败残留预清理（storage advisory 锁由 OS 随进程死亡释放，此处只管目录卫生）。
  await cleanupSeStorage({ id: TEST_ID });
  await cleanupSeStorage({ id: PKG_ID });

  // ── ① 真实组装器产 fixture 包 + Node 落盘（无需 SE）────────────────────
  const pkg = buildAndWriteFixture();
  const manifest = pkg.manifest;
  check(
    '① 组装：files = 2 流文件 + manifest（manifest 最后 = 提交点）',
    Array.isArray(pkg.files) &&
      pkg.files.length === 3 &&
      pkg.files[0].relPath === `${DISPLAY_NAME}.streams/alpha.md` &&
      pkg.files[1].relPath === `${DISPLAY_NAME}.streams/beta.md` &&
      pkg.files[2].relPath === `${DISPLAY_NAME}.se.json`,
    JSON.stringify(pkg.files.map((f) => f.relPath))
  );
  check(
    "① 组装：manifest 流为 source.file_path 且无内联 content（B1 场景）",
    manifest.streams.length === 2 &&
      manifest.streams.every(
        (s) => !('content' in s) && s.source && s.source.file_path === `${DISPLAY_NAME}.streams/${s.name}.md`
      ),
    JSON.stringify(manifest.streams.map((s) => ({ name: s.name, content: 'content' in s, src: s.source?.file_path })))
  );
  check(
    '① 组装：单一 name（无 title 通道），tags 含 canvas + edge.*（双流各一对）',
    manifest.streams[0].name === 'alpha' &&
      !('title' in manifest.streams[0]) &&
      manifest.streams[0].tags.canvas === 'true' &&
      manifest.streams[0].tags['edge.beta'] === EDGE_ALPHA_TO_BETA &&
      manifest.streams[1].name === 'beta' &&
      !('title' in manifest.streams[1]) &&
      manifest.streams[1].tags.canvas === 'false' &&
      manifest.streams[1].tags['edge.alpha'] === EDGE_BETA_TO_ALPHA,
    JSON.stringify(manifest.streams.map((s) => ({ name: s.name, tags: s.tags })))
  );
  check(
    '① 落盘：兄弟文件/工具脚本/manifest 存在；工具 tool_path 已相对化且指向真实文件',
    fs.existsSync(MANIFEST) &&
      fs.existsSync(ALPHA_FILE) &&
      fs.existsSync(BETA_FILE) &&
      fs.existsSync(TOOL_FILE) &&
      fs.statSync(TOOL_FILE).size > 0 &&
      manifest.tools[TOOL_NAME] &&
      manifest.tools[TOOL_NAME].tool_path === TOOL_REL &&
      JSON.parse(fs.readFileSync(MANIFEST, 'utf-8')).id === DISPLAY_NAME,
    `manifest=${fs.existsSync(MANIFEST)} tool_path=${manifest.tools[TOOL_NAME]?.tool_path}`
  );

  // ── ② 读回：loadManifestFile + fetchStreamContents（注入 Node 读盘通道）──
  const loaded = await loadManifestFile(MANIFEST, readFile);
  check(
    '② loadManifestFile：读回并解析 manifest（id/流数/工具数）',
    loaded.path === MANIFEST &&
      loaded.manifest.id === DISPLAY_NAME &&
      loaded.manifest.streams.length === 2 &&
      loaded.manifest.tools.length === 1,
    JSON.stringify({ id: loaded.manifest.id, streams: loaded.manifest.streams.length, tools: loaded.manifest.tools.length })
  );

  const fetched = await fetchStreamContents({ manifest: loaded.manifest, manifestPath: MANIFEST, readFile });
  check(
    '② fetchStreamContents：正文来自兄弟文件且非空（B1 修复输入）',
    fetched.contents.get('alpha') === ALPHA_TEXT &&
      fetched.contents.get('alpha') !== '' &&
      fetched.contents.get('beta') === BETA_TEXT &&
      fetched.missing.length === 0 &&
      fetched.warnings.length === 0,
    JSON.stringify({
      alpha: fetched.contents.get('alpha')?.slice(0, 40),
      beta: fetched.contents.get('beta')?.slice(0, 40),
      missing: fetched.missing,
      warnings: fetched.warnings,
    })
  );

  // ── ③-⑥ 真实 SE 契约（不可用 → SKIPPED，不伪装通过）──────────────────
  if (!RUNTIME.ok) {
    skipped = '未解析出 SE 包父目录（SE_PACKAGE_PATH 未设置且本机候选均不可用）';
  } else {
    se = await spawnSe({ id: TEST_ID, token: TOKEN, storage: STORAGE, systemId: SYSTEM_ID });
    const port = await waitPortOrExit();
    if (!port) {
      skipped = `SE 未在期限内就绪（exit=${se.exitCode}）：${String(se.getStderr() || '').slice(-300)}`;
    } else {
      check('SE 就绪：registry 端口已落盘且可连接', await anyListener(port), `port=${port}`);
      direct = await connectSeDirect({ port, token: TOKEN });
      await runSeContract(manifest, fetched);
      // ⑦ 子集导入（独立 storage 的真实 SE；与主库解耦，避免孤儿 journal 守卫）。
      await runSubsetImportContract(manifest, fetched);
    }
  }
} catch (err) {
  check('冒烟执行', false, String((err && err.stack) || err));
} finally {
  try {
    if (direct) direct.close();
  } catch (err) {
    /* 忽略 */
  }
  killTree(se);
  await sleep(1500);

  // 环境核对：本 storage 无 python 孤儿（taskkill 收尸有延迟 → 轮询数轮）。
  let leftovers = [];
  for (let i = 0; i < 6; i += 1) {
    leftovers = (await pythonProcesses()).filter((cmd) => cmd.includes('snakeeats') && cmd.includes(TEST_ID));
    if (!leftovers.length) break;
    await sleep(700);
  }
  check('finally：无本 storage 的 python 孤儿进程', leftovers.length === 0, leftovers.join(' || '));

  // 清理：storage + fixture 包目录（helper 内含 unlink/rmdir + cmd rmdir 兜底）。
  await cleanupSeStorage({ id: TEST_ID });
  await cleanupSeStorage({ id: PKG_ID });
  check(
    'finally：storage 与 fixture 包目录已删除',
    !fs.existsSync(STORAGE) && !fs.existsSync(PKG_DIR),
    `storage=${fs.existsSync(STORAGE)} pkg=${fs.existsSync(PKG_DIR)}`
  );
}

const failed = results.filter((r) => !r.ok);
if (skipped && failed.length === 0) {
  if (SE_REQUIRE) {
    console.log(`\nSE SUITE: HARD FAIL — SE 不可用但 SE_REQUIRE=1（${skipped}）`);
    process.exit(1);
  }
  console.log(`\nSE SUITE: SKIPPED (${skipped})`);
  process.exit(0);
}
if (skipped) console.log(`\n[skip 说明] SE 不可用（${skipped}），但纯 Node 段已有 FAIL。`);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
