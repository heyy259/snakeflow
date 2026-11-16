// Runtime cleanup unit tests. The invariant is that SnakeEats storage is never deleted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sweepSeSystems } from './se-cleanup.mjs';
import { sweepSeRuntime } from '../server/se/cleanup.js';
import { removeRecursiveWithRetry } from '../server/resilientFs.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 200) : ''}`);
};

const PROBE_TIMEOUT = 150;
const tmpRoots = [];

function newEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'se-cleanup-unit-'));
  tmpRoots.push(root);
  const systemsDir = path.join(root, 'se-systems');
  fs.mkdirSync(systemsDir, { recursive: true });
  return { root, systemsDir, workspaceFile: path.join(root, 'graphs', '.workspace.json') };
}

function write(file, content = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function ageDir(dir, days) {
  const t = new Date(Date.now() - days * 86400000);
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else fs.utimesSync(p, t, t);
    }
  }
}

function rmrf(dir) {
  removeRecursiveWithRetry(dir, { recursive: true, bestEffort: true, cmdFallback: true });
}

const sweep = (env, dryRun) =>
  sweepSeSystems({
    dryRun,
    systemsDir: env.systemsDir,
    workspaceFile: env.workspaceFile,
    probeTimeoutMs: PROBE_TIMEOUT,
  });

const OLD_AT = new Date(Date.now() - 31 * 86400000).toISOString();

try {
  {
    const env = newEnv();
    const dir = path.join(env.systemsDir, 'orphan31');
    write(path.join(dir, 'snapshots', 's.json'), '{}');
    write(path.join(dir, '.owner.json'), JSON.stringify({ pid: 999999, at: OLD_AT }));
    ageDir(dir, 31);
    const dry = await sweep(env, true);
    check('legacy dry-run reports stale metadata and preserves storage', dry.cleaned.includes('orphan31') && fs.existsSync(dir));
    const real = await sweep(env, false);
    check(
      'legacy apply removes only metadata and preserves storage files',
      real.cleaned.includes('orphan31')
        && fs.existsSync(dir)
        && !fs.existsSync(path.join(dir, '.owner.json'))
        && fs.existsSync(path.join(dir, 'snapshots', 's.json'))
    );
  }

  {
    const env = newEnv();
    const byId = path.join(env.systemsDir, 'ref-by-id');
    const byDir = path.join(env.systemsDir, 'ref-by-dir');
    write(path.join(byId, '.owner.json'), JSON.stringify({ pid: 999999, at: OLD_AT }));
    write(path.join(byDir, '.owner.json'), JSON.stringify({ pid: 999999, at: OLD_AT }));
    ageDir(byId, 31);
    ageDir(byDir, 31);
    write(
      env.workspaceFile,
      JSON.stringify({
        tabs: [
          { system: { system_id: 'ref-by-id', storage_dir: 'se-systems/other' } },
          { system: { system_id: 'x', storage_dir: 'se-systems/ref-by-dir' } },
        ],
      })
    );
    const r = await sweep(env, false);
    check(
      'workspace references preserve both storage and metadata',
      fs.existsSync(path.join(byId, '.owner.json'))
        && fs.existsSync(path.join(byDir, '.owner.json'))
        && !r.cleaned.includes('ref-by-id')
        && !r.cleaned.includes('ref-by-dir')
    );
  }

  {
    const env = newEnv();
    const dir = path.join(env.systemsDir, 'orphan5');
    write(path.join(dir, '.owner.json'), JSON.stringify({ pid: 999999, at: new Date().toISOString() }));
    ageDir(dir, 5);
    const r = await sweep(env, false);
    check('young metadata is preserved', fs.existsSync(path.join(dir, '.owner.json')) && !r.cleaned.includes('orphan5'));
  }

  {
    const env = newEnv();
    const dir = path.join(env.systemsDir, 'owned31');
    write(path.join(dir, '.owner.json'), JSON.stringify({ pid: process.pid, at: OLD_AT }));
    ageDir(dir, 31);
    const r = await sweep(env, false);
    check('live owner pid preserves metadata and storage', fs.existsSync(path.join(dir, '.owner.json')) && !r.cleaned.includes('owned31'));
  }

  {
    const env = newEnv();
    const locked = path.join(env.systemsDir, 'spawnlocked');
    write(path.join(locked, '.spawn.lock'), JSON.stringify({ pid: process.pid, at: Date.now() }));
    const snakeOnly = path.join(env.systemsDir, 'snakeonly');
    write(path.join(snakeOnly, '.owner.json'), JSON.stringify({ pid: 999999, at: OLD_AT }));
    write(path.join(snakeOnly, '.snakeeats.lock'), '');
    ageDir(locked, 31);
    ageDir(snakeOnly, 31);
    const r = await sweep(env, false);
    check('live spawn lock preserves runtime metadata', fs.existsSync(path.join(locked, '.spawn.lock')) && !r.cleaned.includes('spawnlocked'));
    check(
      'snakeeats lock is not treated as a spawn lock; storage is still preserved',
      r.cleaned.includes('snakeonly')
        && !fs.existsSync(path.join(snakeOnly, '.owner.json'))
        && fs.existsSync(path.join(snakeOnly, '.snakeeats.lock'))
    );
  }

  {
    const env = newEnv();
    const dir = path.join(env.systemsDir, 'brokenws');
    write(path.join(dir, '.owner.json'), JSON.stringify({ pid: 999999, at: OLD_AT }));
    ageDir(dir, 31);
    write(env.workspaceFile, '{ this is not valid json');
    const r = await sweep(env, false);
    check('broken workspace aborts with zero deletion', r.aborted === true && r.deleted.length === 0 && r.cleaned.length === 0 && fs.existsSync(dir));
  }

  {
    const env = newEnv();
    const dir = path.join(env.systemsDir, 'regonly');
    write(path.join(dir, 'registry', '.registry.json'), '{}');
    ageDir(dir, 31);
    const r = await sweep(env, false);
    check('registry-only storage is preserved without runtime metadata', fs.existsSync(dir) && !r.cleaned.includes('regonly') && !r.deleted.includes('regonly'));
  }

  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'se-runtime-installed-'));
    tmpRoots.push(root);
    const runtimeDir = path.join(root, 'runtime');
    const storageDir = path.join(root, 'se-storage');
    const runtimePath = path.join(runtimeDir, 'orphan31');
    const storagePath = path.join(storageDir, 'orphan31');
    write(path.join(runtimePath, '.owner.json'), JSON.stringify({ pid: 999999, at: OLD_AT }));
    write(path.join(storagePath, 'snapshots', 's.json'), '{}');
    ageDir(runtimePath, 31);
    const dry = await sweepSeRuntime({ runtimeDir, storageDir, dryRun: true, probeTimeoutMs: PROBE_TIMEOUT });
    check('installed dry-run marks runtime dir for deletion and preserves it', dry.deleted.includes('orphan31') && fs.existsSync(runtimePath));
    const real = await sweepSeRuntime({ runtimeDir, storageDir, dryRun: false, probeTimeoutMs: PROBE_TIMEOUT });
    check(
      'installed apply deletes runtime dir and preserves storage',
      real.deleted.includes('orphan31')
        && !fs.existsSync(runtimePath)
        && fs.existsSync(path.join(storagePath, 'snapshots', 's.json'))
    );
  }

  {
    const env = newEnv();
    const dir = path.join(env.systemsDir, '中文-探针');
    write(path.join(dir, '快照', '深层', '叶子-中文.json'), '{}');
    write(path.join(dir, '日志-中文.jsonl'), '{}');
    const ok = removeRecursiveWithRetry(dir, { recursive: true, bestEffort: true, cmdFallback: true });
    check('CJK nested directory can be removed by the resilient primitive', ok === true && !fs.existsSync(dir));
  }
} catch (err) {
  check('test execution', false, String((err && err.stack) || err));
} finally {
  for (const root of tmpRoots) rmrf(root);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
