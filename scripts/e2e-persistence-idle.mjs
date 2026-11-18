// Idle persistence regression: one settled load/normalization must make a second cold
// reload write NOTHING. Browser-side /api/se/** is stubbed unavailable so no SE is spawned.
//
// Isolation invariants (must stay exact):
// - .workspace.json / .ui.json / .snippets.json are snapshotted before ANY app boot and
//   restored byte-for-byte in finally; files absent before the run are removed again.
// - The probe tab/config/streams dir is uniquely timestamped and only its own artifacts
//   are deleted; real graph configs/content are never read or mutated by this script.
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PORT = 5196;
const BASE = `http://localhost:${PORT}`;
const GRAPHS = path.join(ROOT, 'graphs');
const WS_FILE = path.join(GRAPHS, '.workspace.json');
const UI_FILE = path.join(GRAPHS, '.ui.json');
const SNIPPETS_FILE = path.join(GRAPHS, '.snippets.json');

const TS = Date.now().toString(36);
const PROBE = `__idleprobe_${TS}`;
const PROBE_CFG = path.join(GRAPHS, `${PROBE}.se.json`);
const PROBE_DIR = path.join(GRAPHS, `${PROBE}.streams`);
const PROBE_MD = path.join(PROBE_DIR, 'NodeA.md');
const PROBE_TEXT = 'idle-probe-line-1\nidle-probe-line-2';
const BACKUP_SUFFIX = `.persistence-idle-${TS}.bak`;
const TRACKED_FILES = [WS_FILE, UI_FILE, SNIPPETS_FILE, PROBE_CFG, PROBE_MD];
const WRITE_PATHS = new Set([
  '/api/document/save',
  '/api/workspace',
  '/api/store/ui',
  '/api/store/snippets',
]);
const SE_REASON = 'persistence-idle-test';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 240) : ''}`);
};
const info = (name, detail = '') => console.log(`INFO  ${name}${detail ? '  | ' + String(detail) : ''}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeUnlink = (p) => { try { fs.unlinkSync(p); } catch { /* best effort */ } };

/** Original existence/timestamps are captured before startup; failed setup can never delete a real file. */
const originals = new Map(
  TRACKED_FILES.slice(0, 3).map((f) => {
    try {
      const st = fs.statSync(f);
      return [f, { existed: true, atimeMs: st.atimeMs, mtimeMs: st.mtimeMs }];
    } catch {
      return [f, { existed: false }];
    }
  })
);

function restoreBackups() {
  for (const [file, meta] of originals) {
    const bak = file + BACKUP_SUFFIX;
    try {
      if (meta.existed && fs.existsSync(bak)) {
        // Unchanged files are left untouched so even their sub-millisecond mtime survives.
        if (!fs.readFileSync(file).equals(fs.readFileSync(bak))) {
          fs.copyFileSync(bak, file);
          fs.utimesSync(file, meta.atimeMs / 1000, meta.mtimeMs / 1000);
        }
      } else if (!meta.existed) {
        safeUnlink(file);
      }
    } catch { /* best effort */ }
    safeUnlink(bak);
  }
}

function removeProbeArtifacts() {
  safeUnlink(PROBE_CFG);
  safeUnlink(PROBE_MD);
  try {
    for (const name of fs.readdirSync(PROBE_DIR)) safeUnlink(path.join(PROBE_DIR, name));
  } catch { /* missing dir */ }
  try { fs.rmdirSync(PROBE_DIR); } catch { /* missing dir */ }
}

function waitForServer(url, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      http.get(url, (res) => { res.resume(); resolve(); }).on('error', () => {
        if (Date.now() - t0 > timeout) reject(new Error('server timeout'));
        else setTimeout(tick, 400);
      });
    };
    tick();
  });
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { socket.destroy(); resolve(v); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(800, () => done(false));
  });
}

function recorder() {
  const counts = new Map();
  return {
    counts,
    record(request) {
      const name = new URL(request.url()).pathname;
      counts.set(name, (counts.get(name) || 0) + 1);
    },
  };
}

/** Installed before navigation: SE is permanently unavailable for this browser page. */
async function guardApi(page, writeRecorder) {
  await page.route('**/api/**', (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/se/preflight') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ available: false, reason: SE_REASON }),
      });
    }
    if (pathname === '/api/se' || pathname.startsWith('/api/se/')) {
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ available: false, reason: SE_REASON, error: `SE unavailable (${SE_REASON})` }),
      });
    }
    if (writeRecorder && request.method() === 'POST' && WRITE_PATHS.has(pathname)) {
      writeRecorder.record(request);
    }
    return route.continue();
  });
}

async function waitForProbeNode(page) {
  await page.waitForSelector('.react-flow', { timeout: 20000 });
  await page.waitForSelector('.react-flow__node', { timeout: 60000 });
  await page.waitForFunction(
    (text) => [...document.querySelectorAll('.react-flow__node')].some((el) => (el.textContent || '').includes(text)),
    'idle-probe-line-1',
    { timeout: 60000 }
  );
}

function snapshotMtimes() {
  return TRACKED_FILES.map((file) => {
    try { return { file, exists: true, mtimeMs: fs.statSync(file).mtimeMs }; }
    catch { return { file, exists: false }; }
  });
}

let server = null;
let browser = null;
let watchdog = null;
let finished = false;

async function finish(explicitCode) {
  if (finished) return;
  finished = true;
  if (watchdog) clearTimeout(watchdog);
  try { if (browser) await browser.close(); } catch { /* best effort */ }
  try {
    if (server && server.pid) {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        spawnSync('pkill', ['-TERM', '-P', String(server.pid)], { stdio: 'ignore' });
        server.kill('SIGTERM');
      }
    }
  } catch { /* best effort */ }
  restoreBackups();
  removeProbeArtifacts();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
  process.exit(explicitCode === undefined ? (failed.length ? 1 : 0) : explicitCode);
}

try {
  if (await portInUse(PORT)) throw new Error(`port ${PORT} already in use`);

  for (const [file, meta] of originals) {
    if (!meta.existed) continue;
    fs.copyFileSync(file, file + BACKUP_SUFFIX);
  }

  const seed = {
    workspaceVersion: 2,
    activeId: 't-idle',
    tabs: [{ id: 't-idle', name: PROBE, docPath: `graphs/${PROBE}.se.json` }],
  };
  fs.writeFileSync(WS_FILE, JSON.stringify(seed), 'utf-8');
  fs.mkdirSync(PROBE_DIR, { recursive: true });
  fs.writeFileSync(PROBE_MD, PROBE_TEXT, 'utf-8');
  const probeDoc = {
    version: '3.0',
    system: { name: PROBE },
    streams: [
      {
        id: 'n-1', name: 'NodeA', description: '', tags: {}, position: { x: 80, y: 80 },
        source: { file_path: `${PROBE}.streams/NodeA.md`, encoding: 'utf-8' },
      },
    ],
    edges: [],
    tools: {},
  };
  fs.writeFileSync(PROBE_CFG, JSON.stringify(probeDoc, null, 2), 'utf-8');

  server = spawn((process.platform === 'win32' ? 'npx.cmd' : 'npx'), ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  watchdog = setTimeout(() => {
    check('watchdog: forced exit after timeout', false);
    void finish(2);
  }, 180000);

  await waitForServer(BASE);
  browser = await chromium.launch({ channel: 'chrome', headless: true });

  // Page 1: settle one load/normalization. Its write counts are informational only.
  const firstWrites = recorder();
  const firstPage = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  await guardApi(firstPage, firstWrites);
  await firstPage.goto(BASE, { waitUntil: 'networkidle' });
  await waitForProbeNode(firstPage);
  await sleep(3500); // document 600ms + workspace/ui 500ms + margin
  info(
    'first-load write POSTs (informational)',
    [...firstWrites.counts.entries()].map(([name, n]) => `${name}=${n}`).join(' ') || '(none)'
  );
  await firstPage.close();

  // Let pagehide keepalive and any final server write settle before taking the baseline.
  await sleep(1500);
  const baseline = snapshotMtimes();
  info(
    'baseline files (exists/mtime)',
    baseline.map((s) => `${path.basename(s.file)}=${s.exists ? s.mtimeMs : 'absent'}`).join(' ')
  );

  // Page 2: cold reload in the same context, no interaction. Count only its writes.
  const secondWrites = recorder();
  const secondPage = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  await guardApi(secondPage, secondWrites);
  await secondPage.goto(BASE, { waitUntil: 'networkidle' });
  await waitForProbeNode(secondPage);
  await sleep(3000);

  for (const endpoint of WRITE_PATHS) {
    const n = secondWrites.counts.get(endpoint) || 0;
    check(`second load: zero POST ${endpoint}`, n === 0, `count=${n}`);
  }

  const after = snapshotMtimes();
  for (let i = 0; i < baseline.length; i += 1) {
    const before = baseline[i];
    const now = after[i];
    const label = path.relative(ROOT, before.file);
    if (before.exists) {
      check(
        `idle: ${label} mtime unchanged`,
        now.exists && now.mtimeMs === before.mtimeMs,
        `before=${before.mtimeMs} after=${now.exists ? now.mtimeMs : 'absent'}`
      );
    } else {
      check(`idle: ${label} remains absent`, !now.exists);
    }
  }
} catch (err) {
  check('e2e execution', false, err && err.stack ? err.stack : String(err));
} finally {
  await finish();
}
