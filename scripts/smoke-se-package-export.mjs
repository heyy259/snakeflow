// 期 10（D5）契约测试：真实组装器产包 → Node 落盘 → 真实 SE 冷启动消费（防格式漂移门）。
//
// 语义（计划 §6.2 / Q3）：**不是**「SE 能读某个提交在库的 golden 文件」，而是
// 「我们（buildPackage）此刻产出的 se-package-v1 包仍被 SE 共享加载管线
// （dialect→schema→paths→execute）正确消费」：
//   1. fixture 由 `src/se/packageExport.js` 的 `buildPackage()` 进程内生成（非 golden），
//      逐文件写入 `<fixtureDir>`（兄弟文本先行、manifest 最后 = 提交点）；
//   2. `snake serve --manifest <绝对路径>` 冷启动：相对 `source.file_path` 以
//      manifest 所在目录为基准；缺失文件会「按条目剔除、不中断其余」——故所有
//      兄弟文件（含空内容流）与工具脚本必须先真实落盘；
//   3. `connectSeDirect` 直连断言：流数/中文 name（即显示名）/正文/空内容流仍在/
//      tags（canvas + edge.<目标>）/工具（tool_path 真实存在，否则 SE 静默剔除）。
//
// 环境（本机实测）：anaconda Python 3.12 + SE 包父目录（含 snakeeats 子目录）——
//   $env:SE_PACKAGE_PATH='<SnakeEats 源码父目录>'
//   node scripts/smoke-se-package-export.mjs
// helper 的本机候选目录通常已能自动解析出同一路径，SE_PACKAGE_PATH 仅作显式覆盖；
// 解释器同理可经 SE_PYTHON 覆盖。端口一律 `--port 0` + registry 发现（不占固定端口）。
//
// 清理纪律：本机 Node v24.12 的 `fs.rmSync`（含 recursive）是静默 no-op（非 ASCII 路径
// 还可能原生崩溃）——storage / fixture 包目录清理一律走 helper `cleanupSeStorage`
// （内含 unlinkSync/rmdirSync 重试 + `cmd rmdir /s /q` 兜底），并核对无本 storage 的
// python 孤儿进程。本脚本由 D7 归入 `run-se-suite.mjs` 的 REAL_SE 门。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPackage, selectPackageInput } from '../src/se/packageExport.js';
import {
  SE_SYSTEMS_DIR,
  spawnSe,
  waitRegistryAnyPort,
  connectSeDirect,
  killTree,
  cleanupSeStorage,
  anyListener,
  pythonProcesses,
  resolveSeRuntimeForTests,
} from './se-test-helper.mjs';

const RUNTIME = await resolveSeRuntimeForTests();

// ── 测试身份：storage id / system id 用 ASCII 唯一值；包显示名用中文（manifest id 宽字符面）──
const TEST_ID = 'pkg-export-s';
const PKG_ID = 'pkg-export-s-pkg'; // fixture 包目录（独立于 storage，便于分别清理）
const STORAGE = path.join(SE_SYSTEMS_DIR, TEST_ID);
const PKG_DIR = path.join(SE_SYSTEMS_DIR, PKG_ID);
const DISPLAY_NAME = '导出契约包';
// 单一中文 name（即显示名；契约合法字符集：字母/数字/下划线，含 CJK）。
const ALPHA_NAME = '甲流非平凡';
const BETA_NAME = '乙流空内容';
const ALPHA_TEXT = '# 甲流正文\n\n导出契约测试：非平凡多行内容。\n第二行含中文、ASCII 与符号 <>&。\n';
const EDGE_LABEL = '来自 alpha';
const TOOL_NAME = 'grep_runner';
const TOOL_REL = 'tools/grep_runner.py';
const TOOL_FILE = path.join(PKG_DIR, TOOL_REL);
const MANIFEST = path.join(PKG_DIR, `${DISPLAY_NAME}.se.json`);
const ALPHA_FILE = path.join(PKG_DIR, `${DISPLAY_NAME}.streams`, `${ALPHA_NAME}.md`);
const BETA_FILE = path.join(PKG_DIR, `${DISPLAY_NAME}.streams`, `${BETA_NAME}.md`);
const SAVED_AT = '2026-09-22T00:00:00.000Z';
const SYSTEM_ID = TEST_ID;
const TOKEN = `pkg-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 180) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let se = null;
let direct = null;

/** 真实组装器产 fixture 包并逐文件落盘（recursive mkdir + utf-8 无 BOM）。 */
function buildAndWriteFixture() {
  fs.mkdirSync(PKG_DIR, { recursive: true });
  // 工具脚本必须真实存在：SE resolve_manifest_paths(check_existence=True) 会静默剔除缺失 tool_path 的工具。
  fs.mkdirSync(path.dirname(TOOL_FILE), { recursive: true });
  fs.writeFileSync(TOOL_FILE, '# smoke-se-package-export fixture tool\ndef main():\n    print("grep_runner")\n', 'utf-8');

  const pkg = buildPackage({
    displayName: DISPLAY_NAME,
    streams: [
      {
        name: ALPHA_NAME,
        description: '含图结构标签的流',
        tags: { canvas: 'false', [`edge.${BETA_NAME}`]: EDGE_LABEL },
        content: ALPHA_TEXT,
      },
      { name: BETA_NAME, description: '', tags: {}, content: '' },
    ],
    tools: [
      {
        name: TOOL_NAME,
        description: '导出契约测试工具（tool_path 指向真实文件）',
        tool_path: TOOL_FILE,
        tags: { role: 'fixture' },
        input_schema: {},
      },
    ],
    layout: { [ALPHA_NAME]: { x: 120, y: 80 }, [BETA_NAME]: { x: 460, y: 80 } },
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
    const port = await waitRegistryAnyPort({ id: TEST_ID, timeoutMs: 2500, intervalMs: 250 });
    if (port) return port;
    if (se && se.exitCode != null) return null;
  }
  return null;
}

/**
 * 轮询直到「manifest 加载完成」的可观测面齐备：2 流 + 工具都在。
 * serve 先绑端口落 registry、后跑 manifest loader（cli.py:241-247），故必然存在
 * 「端口已可连、loader 未跑完」的窗口——以消费面（流+工具）为准而非端口。
 */
async function waitConsumption(timeoutMs = 30000) {
  const t0 = Date.now();
  let streams = null;
  let tools = null;
  while (Date.now() - t0 < timeoutMs) {
    if (se && se.exitCode != null) return { streams, tools, reason: `SE 提前退出 exit=${se.exitCode}` };
    try {
      streams = await direct.call('stream.list', {}, 4000);
      tools = await direct.call('tool.list', {}, 4000);
    } catch (err) {
      /* 连接尚未就绪 / 瞬态错误：继续轮询 */
    }
    const rows = Array.isArray(streams) ? streams : [];
    const tls = Array.isArray(tools) ? tools : [];
    if (
      rows.some((s) => s && s.name === ALPHA_NAME) &&
      rows.some((s) => s && s.name === BETA_NAME) &&
      tls.some((t) => t && t.name === TOOL_NAME)
    ) {
      return { streams: rows, tools: tls, reason: '' };
    }
    await sleep(300);
  }
  return { streams, tools, reason: '轮询超时' };
}

/** 通用 registry 轮询（带子进程早退）；返回端口或 null。 */
async function waitPortFor(child, id, timeoutMs = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const port = await waitRegistryAnyPort({ id, timeoutMs: 2500, intervalMs: 250 });
    if (port) return port;
    if (child && child.exitCode != null) return null;
  }
  return null;
}

/** 轮询直到 stream.list 恰含指定流集合（乱序匹配）；超时/早退返回 {rows, reason}。 */
async function waitStreamsFor(directClient, child, names, timeoutMs = 30000) {
  const t0 = Date.now();
  let rows = null;
  while (Date.now() - t0 < timeoutMs) {
    if (child && child.exitCode != null) return { rows, reason: `SE 提前退出 exit=${child.exitCode}` };
    try {
      rows = await directClient.call('stream.list', {}, 4000);
    } catch (err) {
      /* 连接尚未就绪 / 瞬态错误：继续轮询 */
    }
    const arr = Array.isArray(rows) ? rows : [];
    if (arr.length === names.length && names.every((n) => arr.some((s) => s && s.name === n))) {
      return { rows: arr, reason: '' };
    }
    await sleep(300);
  }
  return { rows, reason: '轮询超时' };
}

/**
 * 期 12（D8r）：单项导出真实 SE 契约。
 * 经 `selectPackageInput` 从全量 fixture 只挑 1 流（alpha=ALPHA_NAME，另带 1 工具）→ buildPackage →
 * 落盘 → 独立 SE 冷启动 `--manifest` 消费 → 断言 stream.list 恰含 alpha、stream.read 正文一致。
 * 使用独立 storage / 包目录（含主 TEST_ID 子串，便于孤儿核对覆盖），自身 finally 全量清理。
 */
async function runSubsetExportContract() {
  const SUB_ID = 'pkg-export-s-sub';
  const SUB_PKG_ID = 'pkg-export-s-sub-pkg';
  const SUB_STORAGE = path.join(SE_SYSTEMS_DIR, SUB_ID);
  const SUB_PKG_DIR = path.join(SE_SYSTEMS_DIR, SUB_PKG_ID);
  const SUB_NAME = '单项导出契约包';
  const SUB_MANIFEST = path.join(SUB_PKG_DIR, `${SUB_NAME}.se.json`);
  const SUB_ALPHA_REL = `${SUB_NAME}.streams/${ALPHA_NAME}.md`;
  const SUB_ALPHA_FILE = path.join(SUB_PKG_DIR, `${SUB_NAME}.streams`, `${ALPHA_NAME}.md`);
  const SUB_TOOL_FILE = path.join(SUB_PKG_DIR, 'tools', 'grep_runner.py');
  const SUB_TOKEN = `pkg-sub-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  await cleanupSeStorage({ id: SUB_ID });
  await cleanupSeStorage({ id: SUB_PKG_ID });

  // 全量 fixture（与主包同源）→ selectPackageInput 只挑 1 流 + 1 工具。
  const allStreams = [
    {
      name: ALPHA_NAME,
      description: '含图结构标签的流',
      tags: { canvas: 'false', [`edge.${BETA_NAME}`]: EDGE_LABEL },
      content: ALPHA_TEXT,
    },
    { name: BETA_NAME, description: '', tags: {}, content: '' },
  ];
  const allTools = [
    {
      name: TOOL_NAME,
      description: '单项导出工具（tool_path 指向真实文件）',
      tool_path: SUB_TOOL_FILE,
      tags: { role: 'fixture' },
      input_schema: {},
    },
  ];
  const picked = selectPackageInput({ streams: allStreams, tools: allTools, streamNames: [ALPHA_NAME], toolNames: [TOOL_NAME] });
  check(
    'D8r 单项导出：selectPackageInput 仅挑出 alpha（1 流）+ 1 工具',
    picked.streams.length === 1 &&
      picked.streams[0].name === ALPHA_NAME &&
      picked.tools.length === 1 &&
      picked.tools[0].name === TOOL_NAME,
    JSON.stringify({ streams: picked.streams.map((s) => s.name), tools: picked.tools.map((t) => t.name) })
  );

  fs.mkdirSync(SUB_PKG_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(SUB_TOOL_FILE), { recursive: true });
  fs.writeFileSync(SUB_TOOL_FILE, '# smoke-se-package-export subset tool\ndef main():\n    print("grep_runner")\n', 'utf-8');

  const subPkg = buildPackage({
    displayName: SUB_NAME,
    streams: picked.streams,
    tools: picked.tools,
    layout: { [ALPHA_NAME]: { x: 120, y: 80 } },
    baseDir: SUB_PKG_DIR,
    savedAt: SAVED_AT,
  });
  check(
    'D8r 单项导出：files = 1 兄弟流文件 + manifest（无 beta 文件）',
    Array.isArray(subPkg.files) &&
      subPkg.files.length === 2 &&
      subPkg.files[0].relPath === SUB_ALPHA_REL &&
      subPkg.files[1].relPath === `${SUB_NAME}.se.json` &&
      !subPkg.files.some((f) => f.relPath.includes(`${BETA_NAME}.md`)),
    JSON.stringify(subPkg.files.map((f) => f.relPath))
  );
  check(
    'D8r 单项导出：manifest.streams 恒为 1 项 alpha（source.file_path 指向唯一兄弟文件）',
    subPkg.manifest.streams.length === 1 &&
      subPkg.manifest.streams[0].name === ALPHA_NAME &&
      subPkg.manifest.streams[0].source.file_path === SUB_ALPHA_REL,
    JSON.stringify(subPkg.manifest.streams.map((s) => ({ name: s.name, src: s.source.file_path })))
  );

  for (const file of subPkg.files) {
    const abs = path.join(SUB_PKG_DIR, file.relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, file.text, 'utf-8');
  }
  check(
    'D8r 单项导出落盘：manifest + alpha 兄弟文件存在，beta 文件不存在',
    fs.existsSync(SUB_MANIFEST) &&
      fs.existsSync(SUB_ALPHA_FILE) &&
      !fs.existsSync(path.join(SUB_PKG_DIR, `${SUB_NAME}.streams`, `${BETA_NAME}.md`)),
    `manifest=${fs.existsSync(SUB_MANIFEST)} alpha=${fs.existsSync(SUB_ALPHA_FILE)}`
  );

  let seSub = null;
  let directSub = null;
  try {
    seSub = await spawnSe({ id: SUB_ID, token: SUB_TOKEN, storage: SUB_STORAGE, systemId: SUB_ID, manifest: SUB_MANIFEST });
    const port = await waitPortFor(seSub, SUB_ID);
    check(
      'D8r 单项导出：SE 冷启动 serve --manifest 就绪',
      !!port,
      port ? `port=${port}` : `exit=${seSub.exitCode} stderr=${seSub.getStderr()}`
    );
    if (!port) throw new Error('subset SE 未在期限内就绪');
    directSub = await connectSeDirect({ port, token: SUB_TOKEN });

    const consumed = await waitStreamsFor(directSub, seSub, [ALPHA_NAME]);
    const subRows = Array.isArray(consumed.rows) ? consumed.rows : [];
    check(
      'D8r 单项导出消费：stream.list 恰含 alpha（length 1，未含 beta）',
      subRows.length === 1 && subRows[0].name === ALPHA_NAME,
      `${consumed.reason ? consumed.reason + ' ' : ''}${JSON.stringify(subRows.map((s) => s && s.name))}`
    );
    const subRead = await directSub.call('stream.read', { name: ALPHA_NAME }, 8000);
    check(
      'D8r 单项导出消费：stream.read alpha === 包内原文',
      !!subRead && subRead.text === ALPHA_TEXT,
      JSON.stringify(subRead && subRead.text != null ? subRead.text.slice(0, 60) : subRead)
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
    check('D8r 单项导出 finally：无本 storage 的 python 孤儿进程', leftovers.length === 0, leftovers.join(' || '));

    await cleanupSeStorage({ id: SUB_ID });
    await cleanupSeStorage({ id: SUB_PKG_ID });
    check(
      'D8r 单项导出 finally：subset storage 与包目录已删除',
      !fs.existsSync(SUB_STORAGE) && !fs.existsSync(SUB_PKG_DIR),
      `storage=${fs.existsSync(SUB_STORAGE)} pkg=${fs.existsSync(SUB_PKG_DIR)}`
    );
  }
}

try {
  console.log(`[env] python=${RUNTIME.ok ? RUNTIME.python : ''}`);
  console.log(`[env] packageParent=${RUNTIME.ok ? RUNTIME.packageParent : ''}`);

  // 上轮失败残留预清理（storage advisory 锁由 OS 随进程死亡释放，此处只管目录卫生）。
  await cleanupSeStorage({ id: TEST_ID });
  await cleanupSeStorage({ id: PKG_ID });

  // ── Part 1：真实组装器产包 + Node 落盘（无需 SE）──────────────────────
  const pkg = buildAndWriteFixture();
  const manifest = pkg.manifest;
  check(
    '组装：files = 2 流文件 + manifest（manifest 最后 = 提交点）',
    Array.isArray(pkg.files) &&
      pkg.files.length === 3 &&
      pkg.files[0].relPath === `${DISPLAY_NAME}.streams/${ALPHA_NAME}.md` &&
      pkg.files[1].relPath === `${DISPLAY_NAME}.streams/${BETA_NAME}.md` &&
      pkg.files[2].relPath === `${DISPLAY_NAME}.se.json`,
    JSON.stringify(pkg.files.map((f) => f.relPath))
  );
  check(
    '组装：manifest $schema/id/generator/version 正确',
    manifest.$schema === 'snake-manifest-v1' &&
      manifest.id === DISPLAY_NAME &&
      manifest.namespace === DISPLAY_NAME &&
      manifest.generator === 'reactflow/se-package-v1' &&
      manifest.package_version === '1.0' &&
      manifest.version === '1.0' &&
      manifest.saved_at === SAVED_AT,
    JSON.stringify({ $schema: manifest.$schema, id: manifest.id, generator: manifest.generator })
  );
  check(
    '组装：单一中文 name 保真（无 title 双通道）',
    manifest.streams.length === 2 &&
      manifest.streams[0].name === ALPHA_NAME &&
      !('title' in manifest.streams[0]) &&
      manifest.streams[1].name === BETA_NAME &&
      !('title' in manifest.streams[1]),
    JSON.stringify(manifest.streams.map((s) => ({ name: s.name })))
  );
  check(
    `组装：alpha.tags 含 canvas + edge.${BETA_NAME}（图结构随包）`,
    manifest.streams[0].tags.canvas === 'false' && manifest.streams[0].tags[`edge.${BETA_NAME}`] === EDGE_LABEL,
    JSON.stringify(manifest.streams[0].tags)
  );
  check(
    '组装：工具 tool_path 已可移植化（相对 baseDir、正斜杠）',
    !!(manifest.tools[TOOL_NAME] && manifest.tools[TOOL_NAME].tool_path === TOOL_REL),
    JSON.stringify(manifest.tools[TOOL_NAME] && manifest.tools[TOOL_NAME].tool_path)
  );
  check(
    '落盘：manifest/兄弟文件/工具脚本存在；beta 为 0 字节；manifest 可解析',
    fs.existsSync(MANIFEST) &&
      fs.existsSync(ALPHA_FILE) &&
      fs.existsSync(BETA_FILE) &&
      fs.existsSync(TOOL_FILE) &&
      fs.statSync(ALPHA_FILE).size === Buffer.byteLength(ALPHA_TEXT, 'utf-8') &&
      fs.statSync(BETA_FILE).size === 0 &&
      JSON.parse(fs.readFileSync(MANIFEST, 'utf-8')).id === DISPLAY_NAME,
    `manifest=${fs.existsSync(MANIFEST)} alpha=${fs.existsSync(ALPHA_FILE)} beta=${fs.existsSync(BETA_FILE)} tool=${fs.existsSync(TOOL_FILE)}`
  );

  // ── Part 2：真实 SE 冷启动消费包（snake serve --manifest）────────────
  se = await spawnSe({ id: TEST_ID, token: TOKEN, storage: STORAGE, systemId: SYSTEM_ID, manifest: MANIFEST });
  const port = await waitPortOrExit();
  check(
    'SE 冷启动：serve --manifest 落盘 registry 端口',
    !!port,
    port ? `port=${port}` : `exit=${se.exitCode} stderr=${se.getStderr()}`
  );
  if (!port) {
    console.log(`[se stderr]\n${se.getStderr()}`);
    throw new Error('SE 未在期限内就绪');
  }
  check('SE 冷启动：registry 端口可连接', await anyListener(port), `port=${port}`);

  direct = await connectSeDirect({ port, token: TOKEN });
  const consumed = await waitConsumption();
  const rows = Array.isArray(consumed.streams) ? consumed.streams : [];
  const byName = new Map(rows.map((s) => [s && s.name, s]));

  check(
    'SE 消费：stream.list 恰含 fixture 两流，name 匹配',
    rows.length === 2 && byName.has(ALPHA_NAME) && byName.has(BETA_NAME),
    `${consumed.reason ? consumed.reason + ' ' : ''}${JSON.stringify(rows.map((s) => s && s.name))}`
  );
  const alphaRow = byName.get(ALPHA_NAME);
  const betaRow = byName.get(BETA_NAME);
  check(
    'SE 消费：中文 name 即显示名保真（name 承载显示名；旧 title 不再被使用）',
    alphaRow?.name === ALPHA_NAME &&
      betaRow?.name === BETA_NAME &&
      !alphaRow?.title &&
      !betaRow?.title,
    JSON.stringify([alphaRow?.name, alphaRow?.title, betaRow?.name, betaRow?.title])
  );

  const readAlpha = await direct.call('stream.read', { name: ALPHA_NAME });
  check(
    'SE 消费：alpha 正文 === 包内原文（兄弟文件被真实加载）',
    !!readAlpha && readAlpha.text === ALPHA_TEXT,
    JSON.stringify(readAlpha && readAlpha.text != null ? readAlpha.text.slice(0, 60) : readAlpha)
  );
  const readBeta = await direct.call('stream.read', { name: BETA_NAME });
  check(
    'SE 消费：beta 空内容流仍在（0 字节文件未被 not-found 剔除）',
    !!readBeta && readBeta.text === '',
    JSON.stringify(readBeta)
  );

  const meta = await direct.call('stream.get_metadata', { name: ALPHA_NAME });
  const tags = (meta && meta.tags) || {};
  check("SE 消费：tags.canvas === 'false'（画布标记随包）", tags.canvas === 'false', JSON.stringify(tags));
  check(
    `SE 消费：tags['edge.${BETA_NAME}'] === '${EDGE_LABEL}'（边标签随包）`,
    tags[`edge.${BETA_NAME}`] === EDGE_LABEL,
    JSON.stringify(tags)
  );

  const tools = Array.isArray(consumed.tools) ? consumed.tools : [];
  const toolRow = tools.find((t) => t && t.name === TOOL_NAME);
  check(
    'SE 消费：tool.list 含 grep_runner',
    !!toolRow,
    JSON.stringify(tools.map((t) => t && t.name))
  );
  check(
    'SE 消费：grep_runner.tool_path 解析回 fixture 真实文件',
    !!toolRow && path.resolve(String(toolRow.tool_path)).toLowerCase() === TOOL_FILE.toLowerCase(),
    toolRow ? String(toolRow.tool_path) : ''
  );

  // ── Part 3（期 12 · D8r）：经 selectPackageInput 的单项导出门 ───────────
  await runSubsetExportContract();
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
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
