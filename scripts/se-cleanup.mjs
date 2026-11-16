// Operator CLI for SnakeFlow runtime metadata cleanup. Storage is never deleted.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sweepSeRuntime } from '../server/se/cleanup.js';
import { getAppPaths } from '../server/paths.js';

export async function sweepSeSystems({
  systemsDir,
  storageDir = systemsDir,
  workspaceFile,
  maxAgeDays = 30,
  dryRun = true,
  log = () => {},
  probeTimeoutMs = 800,
} = {}) {
  return sweepSeRuntime({
    runtimeDir: systemsDir,
    storageDir,
    workspaceFile,
    maxAgeDays,
    dryRun,
    log,
    probeTimeoutMs,
  });
}

async function main() {
  const apply = process.argv.includes('--apply');
  const paths = getAppPaths();
  const result = await sweepSeRuntime({
    runtimeDir: paths.runtimeDir,
    storageDir: paths.seSystemsDir,
    workspaceFile: paths.workspaceFile,
    maxAgeDays: Number(process.env.SE_CLEANUP_DAYS) || 30,
    dryRun: !apply,
    log: (message) => console.log(message),
  });
  if (!apply && (result.deleted.length || result.cleaned.length)) {
    console.log('（dry-run；加 --apply 执行清理。storage 永远不会被删除。）');
  }
  if (result.aborted) process.exitCode = 1;
}

function isDirectRun() {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return pathToFileURL(path.resolve(arg)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectRun()) await main();
