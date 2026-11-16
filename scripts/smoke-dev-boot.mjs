// Dev boot 冒烟：证明 Vite 配置打包后项目根未漂移，且 HTTP 端点契约成立。
//
// 为什么独立起 vite：`/api/project/info`（项目根权威）与 `/api/se/preflight`
//（共享运行时 descriptor）只有在真实 dev server 里才会跑到 Vite 的配置加载/中间件链路；
// 纯单测无法覆盖「配置打包后 __dirname 漂移」这一高风险陷阱。
// 不要求真实 SE：preflight 可用或不可用都必须通过（只校验响应形状与一致性）。
// 端口固定 5399；若已被占用直接失败并提示（spawnViteSe 使用 --strictPort）。
// 运行：node scripts/smoke-dev-boot.mjs（全绿退出码 0）。
import { ROOT, anyListener, spawnViteSe, waitForServer, killTree } from './se-test-helper.mjs';

const PORT = 5399;
const BASE = `http://localhost:${PORT}`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 200) : ''}`);
};
const normalizePath = (value) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');

let child = null;
try {
  if (await anyListener(PORT)) {
    throw new Error(`端口 ${PORT} 已被占用：请先关闭占用该端口的进程（本测试使用 --strictPort，不会复用旧服务）`);
  }

  child = await spawnViteSe({ port: PORT });
  await waitForServer(`${BASE}/`, 30000);
  check(`dev server ready（${BASE}）`, true);

  // ── GET /api/project/info：项目根（posix，去尾斜杠）必须等于仓库根 ──────────
  const infoRes = await fetch(`${BASE}/api/project/info`);
  const infoJson = await infoRes.json().catch(() => null);
  const expectedRoot = normalizePath(ROOT);
  check('GET /api/project/info → 200', infoRes.ok, `HTTP ${infoRes.status}`);
  check(
    'projectRoot 规范化后 = 仓库根（防 Vite 配置打包根漂移）',
    Boolean(infoJson) && normalizePath(infoJson.projectRoot) === expectedRoot,
    `expected=${expectedRoot} actual=${infoJson && infoJson.projectRoot}`
  );

  // ── GET /api/se/preflight：形状与运行时一致性（可用/不可用都必须自洽） ──────
  const pfRes = await fetch(`${BASE}/api/se/preflight`);
  const pf = await pfRes.json().catch(() => null);
  const isObject = Boolean(pf) && typeof pf === 'object' && !Array.isArray(pf);
  check('GET /api/se/preflight → 200 + JSON 对象', pfRes.ok && isObject, `HTTP ${pfRes.status}`);
  check('preflight.available 是布尔值', isObject && typeof pf.available === 'boolean', isObject ? String(pf.available) : 'no body');
  if (isObject && pf.available === true) {
    check('preflight 可用 → python 非空字符串', typeof pf.python === 'string' && pf.python.trim().length > 0, String(pf.python));
    check(
      'preflight 可用 → packageParent 非空字符串',
      typeof pf.packageParent === 'string' && pf.packageParent.trim().length > 0,
      String(pf.packageParent)
    );
    check(
      'preflight 可用 → sources 是对象',
      Boolean(pf.sources) && typeof pf.sources === 'object' && !Array.isArray(pf.sources),
      JSON.stringify(pf.sources)
    );
  } else if (isObject && pf.available === false) {
    check(
      'preflight 不可用 → reason 非空字符串',
      typeof pf.reason === 'string' && pf.reason.trim().length > 0,
      String(pf.reason)
    );
  }
} catch (err) {
  check('dev boot smoke', false, err && err.stack ? err.stack : String(err));
} finally {
  if (child) {
    killTree(child);
    if (child.exitCode == null) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
