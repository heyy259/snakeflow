// 期 9（Phase 9）SE 套件守门器：统一驱动 8 个既有 smoke 脚本 + 纯 Node 单测 + e2e-se。
//
// 职责（D3）：
//   1. preflight() 判定本机能否真实跑 SE（D2，见 se-preflight.mjs）；
//   2. 恒跑集合（纯内存 / 纯 Node，不需要真实 SE）：
//        smoke-se-processes / smoke-se-tools / smoke-se-scan / smoke-doc-unit /
//        smoke-package-import-unit / smoke-package-export-unit；
//   3. 真实-SE 集合（仅 available 时）：
//        smoke-se / smoke-se-streams / smoke-se-lifecycle / smoke-se-tags / smoke-se-edges / smoke-se-package-export / e2e-se（若存在）；
//   4. 跳过策略：默认无 SE → 跑恒跑集合后 SKIPPED + exit 0（保证 test:all 在无 SE 机器仍绿）；
//      strict（--require 或 SE_REQUIRE=1）→ 无 SE 直接硬门失败 exit 1。
//
// 纪律：只调用既有脚本，不改其本体；仅用 node 内置模块；顺序 spawnSync 避免资源竞争。
// 环境缺陷：本机 Node v24.12.0 下 `fs.rmSync`（含 recursive）是**静默 no-op**——递归删目录、
//   删文件都不生效也不报错；非 ASCII 路径还会 0xC0000409 崩溃。既有 5 个真实-SE 脚本的
//   finally 用 fs.rmSync 清理 storage，故它们会残留 se-systems/<id> → 二次运行互相污染。
//   守门器在开跑前用「unlinkSync/rmdirSync + cmd rmdir 兜底」清掉这些legacy 测试 storage，
//   保证 `test:se` 可重复运行。（不触碰用户真实系统：仅清已知测试 id。）
// 运行：node scripts/run-se-suite.mjs [--require]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { preflight } from './se-preflight.mjs';
import { purgeTestTabsFromWorkspace, cleanupGraphArtifacts } from './se-ui-helper.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRE = process.argv.includes('--require') || process.env.SE_REQUIRE === '1';

/** 恒跑：纯内存/纯 Node，无需真实 SE（doc-unit 也不连 SE）。 */
const ALWAYS = ['smoke-se-identity-unit.mjs', 'smoke-se-instance-identity-unit.mjs', 'smoke-process-evidence-unit.mjs', 'smoke-se-graceful-end-unit.mjs', 'smoke-se-processes.mjs', 'smoke-se-tools.mjs', 'smoke-se-scan.mjs', 'smoke-se-projection-unit.mjs', 'smoke-se-projection-queue-unit.mjs', 'smoke-se-stream-sync-unit.mjs', 'smoke-doc-unit.mjs', 'smoke-doc-identity-unit.mjs', 'smoke-graph-v2-roundtrip.mjs', 'smoke-package-import-unit.mjs', 'smoke-register-unit.mjs', 'smoke-single-config-unit.mjs', 'smoke-package-export-unit.mjs', 'smoke-se-classify-unit.mjs', 'smoke-se-internal-unit.mjs', 'smoke-se-delete-policy-unit.mjs', 'smoke-se-recovery-policy-unit.mjs', 'smoke-owned-source-unit.mjs', 'smoke-se-reconcile-unit.mjs', 'smoke-se-ensure-unit.mjs', 'smoke-call-markers-unit.mjs', 'smoke-text-view-unit.mjs', 'smoke-config-load-unit.mjs', 'smoke-se-cleanup-unit.mjs', 'smoke-se-storage-lifecycle.mjs', 'smoke-portable-docpath.mjs', 'smoke-path-unit.mjs', 'smoke-package-bundle-unit.mjs', 'smoke-package-apply-unit.mjs', 'smoke-edge-align-unit.mjs', 'smoke-promote-unit.mjs', 'smoke-migrate-local-nodes.mjs', 'smoke-se-edit-range.mjs', 'smoke-se-runtime-unit.mjs', 'smoke-se-spawn-spec-unit.mjs', 'smoke-se-probe-integration.mjs', 'smoke-dev-boot.mjs'];
/** 真实-SE：仅 preflight().available 时执行；e2e-se 不存在时跳过。 */
const REAL_SE = [
  'smoke-se.mjs',
  'smoke-se-streams.mjs',
  'smoke-se-lifecycle.mjs',
  'smoke-se-tags.mjs',
  'smoke-se-edges.mjs',
  'smoke-edge-align.mjs',
  'smoke-se-package-export.mjs',
  'smoke-se-package-import.mjs',
  'smoke-external-package-inplace.mjs',
  'smoke-promote-node.mjs',
  'smoke-entry-gating.mjs',
  'smoke-pending-badge.mjs',
  'e2e-se.mjs',
  'e2e-se-autostart.mjs',
  'e2e-se-close-reopen.mjs',
];
/** 既有真实-SE 脚本使用的 storage id（ASCII）；开跑前清理，抵消其 fs.rmSync no-op 残留。 */
const LEGACY_TEST_IDS = ['smoketest', 'streams-s', 'tags-s', 'edges-s', 'life-a', 'life-b', 'life-c'];
/** 测试脚本自己派生 / seed 的 storage 前缀（t-* 有用户数据风险，故只列确定前缀与固定 id）。 */
const TEST_STORAGE_PREFIXES = ['smoke-', 'e2e-', 'autospawn-', 'life-', 'tags-escape-', 'pkg-inplace-'];
/** 测试 tab 在 graphs/ 下留下的固定图表名（动态前缀另按 TEST_STORAGE_PREFIXES 扫）。 */
const TEST_GRAPH_NAMES = ['edges', 'streams-s', 'tags-s', 'autospawn', '待同步', '同名'];

function sweepTestStorage(systemsDir) {
  let entries = [];
  try { entries = fs.readdirSync(systemsDir, { withFileTypes: true }); } catch { return 0; }
  let n = 0;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const id = e.name;
    if (LEGACY_TEST_IDS.includes(id) || TEST_STORAGE_PREFIXES.some((p) => id.startsWith(p))) {
      rmrfCrashSafe(path.join(systemsDir, id));
      n += 1;
    }
  }
  return n;
}

function sweepTestGraphs(graphsDir) {
  let entries = [];
  try { entries = fs.readdirSync(graphsDir, { withFileTypes: true }); } catch { return 0; }
  let n = 0;
  for (const e of entries) {
    const m = /^(.*)\.(?:se\.json|streams)$/.exec(e.name);
    if (!m) continue;
    const base = m[1];
    const isTest = TEST_GRAPH_NAMES.includes(base) || TEST_STORAGE_PREFIXES.some((p) => base.startsWith(p)) || /^promote-|^edgealign-/.test(base);
    if (!isTest) continue;
    cleanupGraphArtifacts(base);
    n += 1;
  }
  return n;
}

function sweepWorkspaceTabs(graphsDir) {
  let entries = [];
  try { entries = fs.readdirSync(graphsDir); } catch { return 0; }
  let n = 0;
  for (const name of entries) {
    if (!/^\.workspace(?:-.*)?\.json$/i.test(name)) continue;
    n += purgeTestTabsFromWorkspace(path.join(graphsDir, name));
  }
  return n;
}

/** 递归删除，规避 Node v24.12.0 的 fs.rmSync no-op；失败兜底 cmd rmdir。 */
function rmrfCrashSafe(dir) {
  if (!fs.existsSync(dir)) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { /* 忽略 */ }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) rmrfCrashSafe(p);
    else { try { fs.unlinkSync(p); } catch { /* 忽略 */ } }
  }
  try { fs.rmdirSync(dir); } catch { /* 忽略 */ }
  if (process.platform === 'win32' && fs.existsSync(dir)) {
    try { spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', dir], { stdio: 'ignore' }); } catch { /* 忽略 */ }
  }
}

/** 顺序执行单个脚本；缺失 → skipped；非零退出 → failed。 */
function runScript(name, extraEnv = {}) {
  const scriptPath = path.join(ROOT, 'scripts', name);
  if (!fs.existsSync(scriptPath)) {
    console.log(`SKIP  <${name}>（文件不存在）`);
    return { name, status: 'skipped' };
  }
  console.log(`\n---- RUN ${name} ----`);
  const res = spawnSync(process.execPath, [scriptPath], {
    stdio: 'inherit',
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
  });
  if (res.error) {
    console.log(`FAIL  <${name}>（无法启动：${res.error.code || res.error.message}）`);
    return { name, status: 'failed' };
  }
  const code = typeof res.status === 'number' ? res.status : 1;
  if (code === 0) {
    console.log(`PASS  <${name}>`);
    return { name, status: 'passed' };
  }
  console.log(`FAIL  <${name}> (exit ${code})`);
  return { name, status: 'failed' };
}

async function main() {
  const info = await preflight();
  console.log('==== SE suite runner ====');
  console.log(`  preflight:     ${info.available ? 'AVAILABLE' : 'UNAVAILABLE'}`);
  console.log(`  reason:        ${info.reason}`);
  console.log(`  python:        ${info.python}`);
  console.log(`  packageParent: ${info.packageParent || '(empty)'}`);
  if (info.sources) {
    console.log(`  sources:       python=${info.sources.python}, packageParent=${info.sources.packageParent}`);
  }
  console.log(`  mode:          ${REQUIRE ? 'strict (--require / SE_REQUIRE=1)' : 'default (skip allowed)'}`);

  if (!info.available && REQUIRE) {
    console.error('\nSE SUITE: HARD FAIL — 真实 SE 不可用但处于 strict 模式（--require / SE_REQUIRE=1）');
    console.error(`  reason:        ${info.reason}`);
    console.error(`  python:        ${info.python}`);
    console.error(`  packageParent: ${info.packageParent || '(empty)'}`);
    process.exit(1);
  }

  // 既有 5 个真实-SE 脚本体内硬编码了过期默认值（开发机 Python / 项目路径），
  // 它们只认 env 覆盖。preflight 已实证解析值可 import snakeeats，这里注入给子进程，
  // 避免「可用却全部 ENOENT」的假阴性；不修改脚本本体（Q4）。
  const childEnv = info.available ? { SE_PYTHON: info.python, SE_PACKAGE_PATH: info.packageParent } : {};
  if (info.available) {
    console.log(`  child env:     SE_PYTHON=${childEnv.SE_PYTHON} SE_PACKAGE_PATH=${childEnv.SE_PACKAGE_PATH}`);
    // 开跑前清掉历史测试残留：storage / graphs 图表产物 / workspace 里的测试 tab。
    const cleanedSystems = sweepTestStorage(path.join(ROOT, 'se-systems'));
    const cleanedGraphs = sweepTestGraphs(path.join(ROOT, 'graphs'));
    const cleanedTabs = sweepWorkspaceTabs(path.join(ROOT, 'graphs'));
    console.log(`  pre-clean:     storage ${cleanedSystems} 个, 图表 ${cleanedGraphs} 个, workspace 测试 tab ${cleanedTabs} 个`);
  }

  const scripts = [...ALWAYS, ...(info.available ? REAL_SE : [])];
  const results = [];
  for (const name of scripts) results.push(runScript(name, childEnv));

  const passed = results.filter((r) => r.status === 'passed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const failed = results.filter((r) => r.status === 'failed').length;

  if (!info.available) console.log(`\nSE SUITE: SKIPPED (${info.reason})`);
  console.log(
    `\n==== SE suite: ${passed}/${results.length} scripts passed` +
      `${skipped ? `, ${skipped} skipped` : ''}${failed ? `, ${failed} FAILED` : ''} ====`
  );
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('SE suite runner crashed:', err?.stack || String(err));
  process.exit(1);
});
