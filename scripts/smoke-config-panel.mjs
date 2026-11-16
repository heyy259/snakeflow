// 配置面板服务端契约冒烟（配置管理与视口持久化改造方案 §1.4/§3）：
//   /api/graphs 扩展字段、/api/store/configs 登记表、/api/fs/copy、/api/fs/delete。
// 自起自停 vite dev server。copy/delete 探针放 os.tmpdir()——graphs/ 在 OneDrive 下，
// 同步引擎对新建文件持锁数秒到数分钟（rmSync 静默留残），契约断言需确定性环境。
// 运行：node scripts/smoke-config-panel.mjs（全绿退出码 0）。
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GRAPHS = path.join(ROOT, 'graphs');
const REGISTRY = path.join(GRAPHS, '.configs.json');
const REGISTRY_BAK = path.join(GRAPHS, '.configs.smoke-bak.json');
const TS = Date.now().toString(36);
const PROBE_NAME = `__cfgpanel_probe_${TS}`;
const PROBE_CFG = path.join(GRAPHS, `${PROBE_NAME}.se.json`);
const FIXTURE = path.join(os.tmpdir(), `cfgpanel-smoke-${TS}`);
const PORT = 5217;
// 用 localhost（Vite 默认可能只绑 ::1；127.0.0.1 会连接被拒）。
const BASE = `http://localhost:${PORT}`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 180) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (url, body) =>
  fetch(`${BASE}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
// 探针路径统一正斜杠（端点接受任意盘符路径，posix 分隔免转义）。
const posix = (p) => p.replace(/\\/g, '/');

let child = null;
let hadRegistry = false;

async function waitReady(timeoutMs = 40000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${BASE}/api/workspace`);
      if (res.status) return true;
    } catch (err) {
      /* not up yet */
    }
    await sleep(400);
  }
  return false;
}

function cleanup() {
  try {
    if (fs.existsSync(FIXTURE)) fs.rmSync(FIXTURE, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    console.warn('清理 tmp 探针失败', err.message);
  }
  // graphs/ 探针在 OneDrive 下：cmd del 经实证比 node rmSync 可靠（rmSync 对已同步文件静默留残）。
  try {
    if (fs.existsSync(PROBE_CFG)) {
      execFileSync('cmd', ['/c', 'del', '/f', '/q', PROBE_CFG], { stdio: 'ignore' });
    }
  } catch (err) {
    try {
      fs.rmSync(PROBE_CFG, { force: true });
    } catch (err2) {
      console.warn('清理 graphs 探针失败', err2.message);
    }
  }
}

try {
  // 备份真实登记表：即便断言失败也必须原样还原（绝不污染真实数据）。
  hadRegistry = fs.existsSync(REGISTRY);
  if (hadRegistry) fs.copyFileSync(REGISTRY, REGISTRY_BAK);

  child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
    windowsHide: true,
  });
  const ready = await waitReady();
  check('dev server ready', ready, BASE);
  if (!ready) throw new Error('server not ready');

  // ── 1. /api/graphs 扩展字段：name/path/mtime/size ─────────────────────────
  fs.writeFileSync(PROBE_CFG, JSON.stringify({ system: { name: PROBE_NAME }, streams: [] }), 'utf-8');
  const graphs = await (await fetch(`${BASE}/api/graphs`)).json();
  const probe = Array.isArray(graphs) ? graphs.find((g) => g.name === `${PROBE_NAME}.se.json`) : null;
  check(
    'GET /api/graphs：返回 {name, path, mtime, size}',
    !!probe &&
      probe.path === `graphs/${PROBE_NAME}.se.json` &&
      Number.isFinite(probe.mtime) &&
      Number.isFinite(probe.size),
    JSON.stringify(probe).slice(0, 160)
  );
  check(
    'GET /api/graphs：点前缀文件（.configs.json 等）不混入',
    Array.isArray(graphs) && graphs.every((g) => !String(g.name).startsWith('.')),
    ''
  );

  // ── 2. /api/store/configs：404 → POST → GET 回环 ──────────────────────────
  // OneDrive 下删除已同步的 .configs.json 不可靠 → 仅当移除确认后才断言 404。
  let registryAbsent = true;
  if (fs.existsSync(REGISTRY)) {
    try {
      fs.rmSync(REGISTRY, { force: true });
    } catch (err) {
      /* ignore */
    }
    registryAbsent = !fs.existsSync(REGISTRY);
  }
  if (registryAbsent) {
    const miss = await fetch(`${BASE}/api/store/configs`);
    check('GET /api/store/configs：未登记 → 404', miss.status === 404, `HTTP ${miss.status}`);
  } else {
    check('GET /api/store/configs：未登记 → 404（OneDrive 占用，跳过断言）', true, 'skipped');
  }
  const entry = { path: 'D:/ext/pkg.se.json', addedAt: 1, lastOpenedAt: 2 };
  const saveRes = await post('/api/store/configs', { entries: [entry] });
  check('POST /api/store/configs → 200', saveRes.ok, `HTTP ${saveRes.status}`);
  const got = await (await fetch(`${BASE}/api/store/configs`)).json();
  check(
    'GET /api/store/configs：登记项回环一致',
    got && Array.isArray(got.entries) && got.entries.length === 1 && got.entries[0].path === entry.path,
    JSON.stringify(got).slice(0, 160)
  );

  // ── 3. /api/fs/copy：文件/目录树复制 + 409/404 ────────────────────────────
  const srcCfg = path.join(FIXTURE, 'pkg.se.json');
  const srcDir = path.join(FIXTURE, 'pkg.streams');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(srcCfg, '{"system":{"name":"pkg"},"streams":[]}', 'utf-8');
  fs.writeFileSync(path.join(srcDir, 'a.md'), '正文甲', 'utf-8');

  const copyRes = await post('/api/fs/copy', { from: posix(srcCfg), to: posix(path.join(FIXTURE, 'pkg-copy.se.json')) });
  check('POST /api/fs/copy 文件 → 200', copyRes.ok, `HTTP ${copyRes.status}`);
  const copyDirRes = await post('/api/fs/copy', { from: posix(srcDir), to: posix(path.join(FIXTURE, 'pkg-copy.streams')) });
  const copiedContent = fs.existsSync(path.join(FIXTURE, 'pkg-copy.streams', 'a.md'))
    ? fs.readFileSync(path.join(FIXTURE, 'pkg-copy.streams', 'a.md'), 'utf-8')
    : null;
  check(
    'POST /api/fs/copy 目录递归 → 内容一致',
    copyDirRes.ok && copiedContent === '正文甲',
    `HTTP ${copyDirRes.status}`
  );
  const dupRes = await post('/api/fs/copy', { from: posix(srcCfg), to: posix(path.join(FIXTURE, 'pkg-copy.se.json')) });
  check('POST /api/fs/copy 目标已存在 → 409', dupRes.status === 409, `HTTP ${dupRes.status}`);
  const noSrcRes = await post('/api/fs/copy', { from: posix(path.join(FIXTURE, 'none.se.json')), to: posix(path.join(FIXTURE, 'x.se.json')) });
  check('POST /api/fs/copy 源缺失 → 404', noSrcRes.status === 404, `HTTP ${noSrcRes.status}`);

  // ── 4. /api/fs/delete：缺失常态 / 目录递归守卫 / 真删 ─────────────────────
  const missDel = await post('/api/fs/delete', { path: posix(path.join(FIXTURE, 'gone.se.json')) });
  const missDelJson = await missDel.json();
  check(
    'POST /api/fs/delete 目标缺失 → 200 {deleted:false}',
    missDel.ok && missDelJson.deleted === false,
    JSON.stringify(missDelJson)
  );
  const dirNoRec = await post('/api/fs/delete', { path: posix(srcDir) });
  check('POST /api/fs/delete 目录无 recursive → 400', dirNoRec.status === 400, `HTTP ${dirNoRec.status}`);
  const dirDel = await post('/api/fs/delete', { path: posix(srcDir), recursive: true });
  const dirDelJson = await dirDel.json();
  check(
    'POST /api/fs/delete 目录 recursive → 真删',
    dirDel.ok && dirDelJson.deleted === true && !fs.existsSync(srcDir),
    JSON.stringify(dirDelJson)
  );
  const fileDel = await post('/api/fs/delete', { path: posix(path.join(FIXTURE, 'pkg-copy.se.json')) });
  const fileDelJson = await fileDel.json();
  check(
    'POST /api/fs/delete 文件 → 真删',
    fileDel.ok && fileDelJson.deleted === true && !fs.existsSync(path.join(FIXTURE, 'pkg-copy.se.json')),
    JSON.stringify(fileDelJson)
  );
} catch (err) {
  check('冒烟执行', false, err.stack || String(err));
} finally {
  // 还原真实登记表（备份在则回写；原本没有则尽力删除探针版）。
  try {
    if (hadRegistry && fs.existsSync(REGISTRY_BAK)) {
      fs.copyFileSync(REGISTRY_BAK, REGISTRY);
    } else if (!hadRegistry && fs.existsSync(REGISTRY)) {
      execFileSync('cmd', ['/c', 'del', '/f', '/q', REGISTRY], { stdio: 'ignore' });
    }
    if (fs.existsSync(REGISTRY_BAK)) fs.rmSync(REGISTRY_BAK, { force: true });
  } catch (err) {
    console.warn('还原登记表失败', err);
  }
  cleanup();
  // 用 taskkill 杀进程树：child.kill() 在 Windows + stdio ignore 下会触发 libuv 断言崩溃。
  if (child && child.pid) {
    child.unref();
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch (err) {
      /* 进程可能已退出 */
    }
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
