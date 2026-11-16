// 期 2 服务端契约冒烟：`.workspace.json` 纯指针 + `/api/document/save` 提交点不变量。
//
// 为什么独立起 vite：这两条都是**服务端行为**（POST /api/workspace 的载荷校验、/api/document/save
// 的"正文先行、配置最后"写序），需真实 dev server。脚本自起自停，并**备份/还原** graphs 工作区，
// 不污染真实数据（本仓库在 OneDrive 下，避免误写）。
// 运行：node scripts/smoke-workspace-pointer.mjs（全绿退出码 0）。
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOC_VERSION } from '../src/document.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GRAPHS = path.join(ROOT, 'graphs');
const WS = path.join(GRAPHS, '.workspace.json');
const WS_BAK = path.join(GRAPHS, '.workspace.pointer-smoke.bak');
const NAME = '__pointer_probe';
const CONFIG = path.join(GRAPHS, `${NAME}.se.json`);
const STREAMS_DIR = path.join(GRAPHS, `${NAME}.streams`);
// 相对 configPath 探针：验证服务端按项目根解析相对路径并落盘 graphs/。
const REL_NAME = `${NAME}_relcfg`;
const REL_CONFIG = path.join(GRAPHS, `${REL_NAME}.se.json`);
const REL_CONFIG_REL = `graphs/${REL_NAME}.se.json`;
const PORT = 5211;
// 用 localhost（Vite 默认可能只绑 ::1；127.0.0.1 会连接被拒）。
const BASE = `http://localhost:${PORT}`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 180) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child = null;
let wsBackup = null;

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

let hadWorkspace = false;
try {
  // 先备份真实工作区再做任何事：即便 server 起不来也必须原样还原（绝不删除真实文件）。
  hadWorkspace = fs.existsSync(WS);
  if (hadWorkspace) {
    wsBackup = fs.readFileSync(WS, 'utf-8');
    fs.writeFileSync(WS_BAK, wsBackup, 'utf-8');
  }

  child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
    windowsHide: true,
  });
  const ready = await waitReady();
  check('dev server ready', ready, BASE);
  if (!ready) throw new Error('server not ready');

  // ── 0. GET /api/project/info：项目根（posix）契约 ──────────────────────────
  const infoRes = await fetch(`${BASE}/api/project/info`);
  const infoJson = await infoRes.json().catch(() => null);
  const expectedRoot = ROOT.replace(/\\/g, '/').replace(/\/+$/, '');
  check(
    'GET /api/project/info → 200 + projectRoot = ROOT（posix）',
    infoRes.ok && infoJson?.projectRoot === expectedRoot,
    `HTTP ${infoRes.status} root=${infoJson?.projectRoot}`
  );

  // ── 1. 纯指针工作区：POST {activeId,tabs} 无 store；GET 回读无 store ─────────
  const pointer = { activeId: 't-probe', tabs: [{ id: 't-probe', name: NAME }] };
  const post = await fetch(`${BASE}/api/workspace`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pointer),
  });
  check('POST /api/workspace 纯指针（无 store）→ 200', post.ok, `HTTP ${post.status}`);
  const got = await (await fetch(`${BASE}/api/workspace`)).json();
  check(
    'GET /api/workspace：保留 tabs/activeId 且**不含 store**（正文不内联）',
    Array.isArray(got.tabs) && got.tabs[0]?.name === NAME && !('store' in got),
    JSON.stringify(got).slice(0, 160)
  );

  // ── 2. /api/document/save：正文先行、配置最后；配置只记引用、不写 content ────
  const rel = `graphs/${NAME}.streams/${'hi'}.md`;
  const crlfText = 'line1\r\n  indented  \r\n';
  const doc = {
    version: DOC_VERSION,
    system: { name: NAME },
    streams: [
      {
        id: 'n-1',
        name: 'hi',
        description: '',
        tags: {},
        position: { x: 0, y: 0 },
        source: { file_path: rel, encoding: 'utf-8' },
      },
    ],
    edges: [],
    tools: {},
  };
  const saveRes = await fetch(`${BASE}/api/document/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: NAME, doc, files: [{ path: rel, text: crlfText }] }),
  });
  const saveJson = await saveRes.json().catch(() => null);
  check('POST /api/document/save → 200 + 返回配置路径', saveRes.ok, JSON.stringify(saveJson).slice(0, 160));

  const cfgText = fs.readFileSync(CONFIG, 'utf-8');
  let cfg = null;
  try {
    cfg = JSON.parse(cfgText);
  } catch (err) {
    cfg = null;
  }
  check(
    '配置 v3：只记 source.file_path、不写 content',
    cfg?.version === DOC_VERSION &&
      cfg.streams?.[0]?.source?.file_path === rel &&
      !('content' in (cfg.streams?.[0] || {})),
    JSON.stringify(cfg?.streams?.[0] || {}).slice(0, 160)
  );
  const contentPath = path.join(ROOT, rel);
  const contentText = fs.existsSync(contentPath) ? fs.readFileSync(contentPath, 'utf-8') : null;
  check(
    '正文文件 byte 保真：CRLF + 首尾空白保留',
    contentText === crlfText,
    JSON.stringify(contentText)
  );

  // ── 2b. configPath 相对项目根：服务端按项目根解析并落盘 graphs/<名> ────────
  const relSaveRes = await fetch(`${BASE}/api/document/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: REL_NAME,
      doc: { version: DOC_VERSION, system: { name: REL_NAME }, streams: [], edges: [], tools: {} },
      configPath: REL_CONFIG_REL,
      files: [],
    }),
  });
  const relSaveJson = await relSaveRes.json().catch(() => null);
  check(
    'POST /api/document/save 相对 configPath → 200 且落盘 ROOT/graphs',
    relSaveRes.ok && fs.existsSync(REL_CONFIG),
    `HTTP ${relSaveRes.status} path=${relSaveJson?.path} exists=${fs.existsSync(REL_CONFIG)}`
  );

  // ── 3. /api/graphs/file 回读：路径引用可加载 ────────────────────────────────
  const fileRes = await fetch(`${BASE}/api/graphs/file?name=${encodeURIComponent(NAME)}`);
  const fileParsed = fileRes.ok ? await fileRes.json() : null;
  check(
    'GET /api/graphs/file：路径引用可加载（source.file_path 一致）',
    fileRes.ok && fileParsed?.streams?.[0]?.source?.file_path === rel,
    `HTTP ${fileRes.status}`
  );

  // ── 4. 正文写失败 → 不提交配置（配置=提交点） ──────────────────────────────
  const badName = `${NAME}_bad`;
  const badConfig = path.join(GRAPHS, `${badName}.se.json`);
  const badRes = await fetch(`${BASE}/api/document/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: badName,
      doc: { ...doc, system: { name: badName } },
      files: [{ path: 'graphs/../..//?<invalid>', text: 'x' }],
    }),
  });
  check(
    '正文写失败 → 返回错误且**不写配置**（提交点不变量）',
    !badRes.ok && !fs.existsSync(badConfig),
    `HTTP ${badRes.status} exists=${fs.existsSync(badConfig)}`
  );
  if (fs.existsSync(badConfig)) fs.rmSync(badConfig, { force: true });
} catch (err) {
  check('冒烟执行', false, err.stack || String(err));
} finally {
  // 还原真实工作区 + 清理探针产物（hadWorkspace 判定，绝不误删真实文件）。
  try {
    if (hadWorkspace && fs.existsSync(WS_BAK)) {
      fs.copyFileSync(WS_BAK, WS);
    } else if (!hadWorkspace && fs.existsSync(WS)) {
      fs.rmSync(WS, { force: true });
    }
    if (fs.existsSync(WS_BAK)) fs.rmSync(WS_BAK, { force: true });
  } catch (err) {
    console.warn('还原工作区失败', err);
  }
  try {
    if (fs.existsSync(CONFIG)) fs.rmSync(CONFIG, { force: true });
    if (fs.existsSync(REL_CONFIG)) fs.rmSync(REL_CONFIG, { force: true });
    if (fs.existsSync(STREAMS_DIR)) fs.rmSync(STREAMS_DIR, { recursive: true, force: true });
  } catch (err) {
    console.warn('清理探针产物失败', err);
  }
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
