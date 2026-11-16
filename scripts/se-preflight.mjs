// 期 9（Phase 9）SE 能力预检：判定本机是否具备「真实 snakeeats SE」运行条件。
//
// 仅供期 9 新增测试的 suite-runner 使用（可用 = 跑真实 SE 集成用例；不可用 = 由上层决定
// skip / fail）。既有 5 个 smoke-se-*.mjs 脚本不消费本模块。
//
// 判定统一走 shared/seRuntime.js（env → 配置文件 → 自动候选，且 probe 已通过 import + serve --help），
// 与 server 的 preflight / spawn 使用同一 descriptor，避免「测试说可用、spawn 却失败」的口径漂移。
//
// 直接运行 `node scripts/se-preflight.mjs` 时打印一行结论并 exit 0（AVAILABLE）/ 1（UNAVAILABLE）。
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveSeRuntimeForTests } from './se-test-helper.mjs';

/**
 * 预检真实 SE 可用性。
 * @returns {Promise<{available: boolean, python: string, packageParent: string, reason: string,
 *   sources?: object, version?: string, moduleFile?: string}>}
 */
export async function preflight() {
  const rt = await resolveSeRuntimeForTests();
  return {
    available: rt.ok,
    python: rt.python || '',
    packageParent: rt.packageParent || '',
    reason: rt.ok ? rt.probe.reason : rt.reason,
    sources: rt.sources,
    version: rt.ok ? rt.probe.version : undefined,
    moduleFile: rt.ok ? rt.probe.moduleFile : undefined,
  };
}

/** 直接运行本文件时（node scripts/se-preflight.mjs）：打印结论并返回退出码。 */
async function main() {
  const result = await preflight();
  console.log(`SE preflight: ${result.available ? 'AVAILABLE' : 'UNAVAILABLE'} — ${result.reason}`);
  console.log(`  python:        ${result.python}`);
  console.log(`  packageParent: ${result.packageParent || '(empty)'}`);
  if (result.sources) {
    console.log(`  sources:       python=${result.sources.python}, packageParent=${result.sources.packageParent}`);
  }
  process.exit(result.available ? 0 : 1);
}

function isDirectRun() {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return pathToFileURL(path.resolve(arg)).href === import.meta.url;
  } catch (err) {
    return false;
  }
}

if (isDirectRun()) await main();
