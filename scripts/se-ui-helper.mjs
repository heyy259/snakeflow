// 浏览器级 SE 测试共享助手（P7：去本地画布逃生舱后，每个 tab 必须绑定真实 SE）。
//
// 应用已移除「暂不绑定」本地草稿：NewTabDialog 只剩「从配置包创建 / 连接或启动系统」，
// 且 dev server 强制 spawn（仅 preflight 不可用时降级为 attach-only）。本模块把
// 「预检跳过 / 注入 SE env 起 vite / 新建并等待绑定的标签页 / 清理 storage」抽到一处，
// 供 smoke-streams / smoke-tools / smoke-scan / e2e.mjs 复用，避免各写一份易漂移。
//
// 只依赖 node 内置模块 + se-preflight / se-test-helper，不产生 import 副作用。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { preflight } from './se-preflight.mjs';
import { ROOT, seEnvForTests, SE_SYSTEMS_DIR } from './se-test-helper.mjs';

const GRAPHS_DIR = path.join(ROOT, 'graphs');

/**
 * 真实 SE 不可用 → 打印 `SKIP: SE unavailable (<reason>)` 并以 0 退出（套件在无 SE 机器仍绿）。
 * 可用 → 返回 preflight 结果。
 * @returns {Promise<{available: boolean, python: string, packageParent: string, reason: string}>}
 */
export async function sePreflightSkip() {
  const pf = await preflight();
  if (!pf.available) {
    console.log(`SKIP: SE unavailable (${pf.reason})`);
    process.exit(0);
  }
  console.log(`SE preflight: AVAILABLE — ${pf.reason}`);
  return pf;
}

/** 起 vite 子进程必须携带的 SE env（否则 dev server 无法 spawn SE）。 */
export function seEnv() {
  return seEnvForTests();
}

/**
 * 在当前页面新建一个「已绑定在线 SE」的标签页：点 ＋ → 连接或启动系统 → 输入 systemId
 * → 启动 → 等「属于该 systemId 的活动标签」状态点转 online、绑定弹窗关闭且离线横幅消失。
 * @param {import('playwright-core').Page} page
 * @param {string} systemId 纯 ASCII 唯一 id
 * @param {{timeout?: number}} [opts]
 */
export async function createBoundTab(page, systemId, opts = {}) {
  const timeout = opts.timeout || 90000;
  await page.click('.tab-add');
  await page.waitForSelector('.newtab-dialog', { timeout: 10000 });
  await page.click('.newtab-choice-system');
  await page.waitForSelector('.newtab-dialog input[type="text"]', { timeout: 10000 });
  await page.fill('.newtab-dialog input[type="text"]', systemId);
  await page.click('.newtab-dialog .dlg-actions .primary');
  // 精确 tab 身份契约（产品 DOM）：.tab 的 title = `${name} · SE ${system_id}`。
  // 只匹配该 title 的 **完整后缀** `· SE <sid>`：既不会被 `sid` 只是别的 id 子串时误命中，
  // 也不要求 tab 名字本身等于 sid（配置包路径可给 displayName）。
  // 不能只看 `.tab.active`：绑定后 active 可能被其它流程（恢复/切换）短暂占住，
  // 新 tab 已在线但并非 active 时旧写法会等到 90s 超时。先找到「属于本 systemId 的在线 tab」，
  // 再主动切换过去，避免旧 tab 提前满足或新 tab 永远等不到 active。
  // 绑定对话框用 `.newtab-dialog` 判定（busy/error 两态都在该节点内）；不能把任意
  // `.modal-overlay` 当成绑定中——其它无关弹窗不应阻塞本等待。
  let outcome;
  try {
    const handle = await page.waitForFunction(
      (sid) => {
        const errEl = document.querySelector('.newtab-dialog .dlg-err');
        if (errEl) return { error: (errEl.textContent || '').trim() || '绑定失败' };
        const suffix = ` · SE ${sid}`;
        const target = [...document.querySelectorAll('.tab')].find((t) =>
          String(t.getAttribute('title') || '').endsWith(suffix)
        );
        if (!target) return false;
        if (!target.querySelector('.tab-se-dot.se-dot-online')) return false;
        if (document.querySelector('.newtab-dialog')) return false;
        return { ok: true };
      },
      systemId,
      { timeout }
    );
    outcome = await handle.jsonValue();
  } catch (err) {
    // 超时诊断：把 tab 身份/状态点/弹窗/SE systems 实况并入错误，避免只报 90s 无上下文。
    let state = null;
    try {
      state = await page.evaluate(async (sid) => {
        const suffix = ` · SE ${sid}`;
        const tabs = [...document.querySelectorAll('.tab')].map((t) => ({
          name: t.querySelector('.tab-name')?.textContent || '',
          title: t.getAttribute('title') || '',
          active: t.classList.contains('active'),
          dot: t.querySelector('.tab-se-dot')?.className || null,
          matchesExactSystem: String(t.getAttribute('title') || '').endsWith(suffix),
        }));
        let systems = null;
        try {
          const res = await fetch('/api/se/systems');
          systems = res.ok ? await res.json() : { http: res.status };
        } catch (e) {
          systems = { error: String((e && e.message) || e) };
        }
        return {
          active: tabs.find((t) => t.active) || null,
          tabs,
          newtabDialog: !!document.querySelector('.newtab-dialog'),
          modalOverlay: !!document.querySelector('.modal-overlay'),
          offlineBanner: !!document.querySelector('.se-offline-banner'),
          systems,
        };
      }, systemId);
    } catch (e) {
      state = { evaluateError: String((e && e.message) || e) };
    }
    const detail = JSON.stringify(state);
    throw new Error(
      `createBoundTab(${systemId}) timeout after ${timeout}ms: ${err && err.message ? err.message : err}\nSTATE: ${detail}`
    );
  }
  if (outcome && outcome.error) {
    // 绑定失败：立刻抛出真实原因（而不是继续等满 90s）。
    throw new Error(`createBoundTab(${systemId}) failed: ${outcome.error}`);
  }
  // 确保「属于本 systemId 的 tab」成为 active（绑定流程通常会，但非强制契约）。
  const alreadyActive = await page.evaluate((sid) => {
    const suffix = ` · SE ${sid}`;
    const target = [...document.querySelectorAll('.tab')].find((t) =>
      String(t.getAttribute('title') || '').endsWith(suffix)
    );
    if (!target) return false;
    if (target.classList.contains('active')) return true;
    target.click();
    return false;
  }, systemId);
  if (!alreadyActive) {
    await page.waitForFunction(
      (sid) => {
        const suffix = ` · SE ${sid}`;
        const active = document.querySelector('.tab.active');
        return !!active && String(active.getAttribute('title') || '').endsWith(suffix);
      },
      systemId,
      { timeout: 15000 }
    );
  }
  await page
    .waitForFunction(() => !document.querySelector('.se-offline-banner'), null, { timeout: 15000 })
    .catch(() => {});
  // 刚 spawn 的 SE 其浏览器 WS 可能先 open 再被代理瞬断：留出稳定窗口，避免绑定后首个 RPC 撞上瞬断。
  await page.waitForTimeout(2000);
}

/** 递归删除（Node v24.12 的 fs.rmSync 在本机可能静默 no-op，故逐文件 unlink + rmdir + cmd 兜底）。 */
function rmrfCrashSafe(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    /* 忽略 */
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) rmrfCrashSafe(p);
    else {
      try {
        fs.unlinkSync(p);
      } catch (err) {
        /* 忽略 */
      }
    }
  }
  try {
    fs.rmdirSync(dir);
  } catch (err) {
    /* 忽略 */
  }
  if (process.platform === 'win32' && fs.existsSync(dir)) {
    try {
      spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', dir], { stdio: 'ignore' });
    } catch (err) {
      /* 忽略 */
    }
  }
}

/**
 * best-effort 删除 se-systems/<systemId>（应在 kill 掉 vite 进程树之后调用）。
 * 多轮重试覆盖 Windows 下刚被杀进程短暂持有目录句柄的场景。
 */
export function cleanupSeSystem(systemId, { retries = 6, delayMs = 400 } = {}) {
  const dir = path.join(SE_SYSTEMS_DIR, systemId);
  for (let i = 0; i < retries; i += 1) {
    if (!fs.existsSync(dir)) return;
    rmrfCrashSafe(dir);
    if (!fs.existsSync(dir)) return;
    const until = Date.now() + delayMs;
    while (Date.now() < until) {
      /* 同步退避，供 finally 中不使用 await 的调用者 */
    }
  }
}

/**
 * 删除测试图表产物：`graphs/<name>.se.json` + `graphs/<name>.streams/`。
 * 测试用 `createBoundTab` / seed workspace 会在真实 graphs/ 下生成这些文件；不清理会越积越多。
 * `name` 是 tab 名 / system id（可能是中文），只拒绝路径分隔符与 ..，防止越界删除。
 */
export function cleanupGraphArtifacts(name) {
  const safe = String(name == null ? '' : name).trim();
  if (!safe || safe === '.' || safe === '..' || /[\\/]/.test(safe)) return;
  const cfg = path.join(GRAPHS_DIR, `${safe}.se.json`);
  try {
    fs.unlinkSync(cfg);
  } catch (err) {
    /* 不存在 / 被占用：best effort */
  }
  rmrfCrashSafe(path.join(GRAPHS_DIR, `${safe}.streams`));
}

/** 读取 workspace 中所有 tab 的 system id（测试自己 seed 的 workspace 里全是测试系统）。 */
export function workspaceSystemIds(workspaceFile = path.join(GRAPHS_DIR, '.workspace.json')) {
  const ids = new Set();
  try {
    const ws = JSON.parse(fs.readFileSync(workspaceFile, 'utf-8'));
    for (const t of Array.isArray(ws && ws.tabs) ? ws.tabs : []) {
      const sid = t && t.system && t.system.system_id;
      if (sid) ids.add(String(sid));
    }
  } catch (err) {
    /* 缺失 / 读坏：没有可清理的 id */
  }
  return ids;
}

/** 测试 tab 的 id / system_id / 名称白名单模式（各 smoke/e2e 脚本固定前缀）。 */
const TEST_TAB_RE = /^(?:t-(?:promote|pending|align|edges|smoke|e2e|seed|auto|v2e2e|sd|s-seed)(?:$|-)|(?:smoke|promote|edgealign|tags-escape|e2e|autospawn|life-[a-f])(?:$|-)|(?:tags-s|streams-s|edges-s|smoketest)$)/;

function isTestTab(tab) {
  if (!tab) return false;
  const sid = tab.system && tab.system.system_id ? String(tab.system.system_id) : '';
  const name = tab.name ? String(tab.name) : '';
  return TEST_TAB_RE.test(sid) || TEST_TAB_RE.test(name);
}

/**
 * 从 workspace 快照中剔除测试 tab（同时删掉其 store 草稿）。
 * 历史遗留：测试恢复的是「上一次已被测试污染的备份」，导致测试 tab 逐次累积，必须主动净化。
 * @returns {number} 被剔除的 tab 数
 */
export function purgeTestTabsFromWorkspace(workspaceFile = path.join(GRAPHS_DIR, '.workspace.json')) {
  let raw = null;
  try {
    raw = fs.readFileSync(workspaceFile, 'utf-8');
  } catch (err) {
    return 0;
  }
  let ws = null;
  try {
    ws = JSON.parse(raw);
  } catch (err) {
    return 0;
  }
  const tabs = Array.isArray(ws && ws.tabs) ? ws.tabs : [];
  const keep = tabs.filter((t) => !isTestTab(t));
  if (keep.length === tabs.length) return 0;
  if (ws.store && typeof ws.store === 'object') {
    for (const t of tabs) {
      if (!keep.includes(t) && t && t.id) delete ws.store[t.id];
    }
  }
  ws.tabs = keep;
  if (ws.activeId && !keep.some((t) => t.id === ws.activeId)) ws.activeId = keep[0] ? keep[0].id : '';
  const text = JSON.stringify(ws);
  for (let i = 0; i < 5; i += 1) {
    try {
      fs.writeFileSync(workspaceFile, text);
      break;
    } catch (err) {
      const until = Date.now() + 200;
      while (Date.now() < until) {
        /* OneDrive/杀软短暂占用：同步退避后重试 */
      }
    }
  }
  return tabs.length - keep.length;
}
