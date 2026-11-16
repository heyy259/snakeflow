// 外部配置登记表（配置管理与视口持久化改造方案 §3.1）：
// graphs/ 目录扫描管"默认位置"，本登记表管"自定义路径"（从外部打开的 .se.json 配置包）。
// 持久化在 graphs/.configs.json（/api/store/configs，点前缀天然被 /api/graphs 列表隐藏）。
// 纯函数 + 两个 store IO 封装；条目结构 { path, addedAt, lastOpenedAt }。
// path 契约：项目内 → 相对项目根 POSIX（`portableDocPath`），外部 → 绝对 POSIX。
import { portableDocPath } from './se/paths.js';
import { getProjectRoot } from './se/projectRoot.js';

/** 路径规范化比较键：正斜杠 + 去尾斜杠 + 小写（win32 大小写不敏感），与 App 的 canonDocPath 同口径。
 *  传入 projectRoot 时，相对路径先与项目根拼接，使「绝对 vs 相对」混合比较也能去重（缺省 '' = 旧行为）。 */
export function canonConfigPath(p, projectRoot = '') {
  let s = String(p || '').trim().replace(/\\/g, '/');
  const root = String(projectRoot || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  const isAbs = /^[A-Za-z]:\//.test(s) || s.startsWith('//') || s.startsWith('/');
  if (root && s && !isAbs) s = `${root}/${s}`;
  return s.replace(/\/+$/, '').toLowerCase();
}

/** 读登记表；404 / 解析失败 / 结构非法 → []（登记表缺失是正常态）。
 *  读入即在内存中把项目内条目相对化（`portableDocPath`），写端 `saveConfigRegistry` 不动物。 */
export async function loadConfigRegistry() {
  try {
    const res = await fetch('/api/store/configs');
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    const list = data && Array.isArray(data.entries) ? data.entries : [];
    const root = getProjectRoot();
    return list
      .filter((e) => e && typeof e === 'object' && String(e.path || '').trim())
      .map((e) => ({
        path: portableDocPath(String(e.path).replace(/\\/g, '/'), root),
        addedAt: Number(e.addedAt) || 0,
        lastOpenedAt: Number(e.lastOpenedAt) || 0,
      }));
  } catch (err) {
    return [];
  }
}

/** 写登记表（整体替换）；失败抛错由调用方反馈。 */
export async function saveConfigRegistry(entries) {
  const res = await fetch('/api/store/configs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: Array.isArray(entries) ? entries : [] }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error((data && data.error) || `HTTP ${res.status}`);
  }
}

/** 登记（去重）：已存在 → 保留 addedAt、刷新 lastOpenedAt；新路径 → 追加。返回新数组。
 *  `projectRoot` 仅用于去重比较（相对/绝对混合），不改变写入的 `path` 形态（由调用方 portableDocPath）。 */
export function registerEntry(entries, path, projectRoot = '') {
  const posix = String(path || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!posix.trim()) return Array.isArray(entries) ? entries.slice() : [];
  const canon = canonConfigPath(posix, projectRoot);
  const list = Array.isArray(entries) ? entries.slice() : [];
  const idx = list.findIndex((e) => canonConfigPath(e.path, projectRoot) === canon);
  const now = Date.now();
  if (idx >= 0) {
    list[idx] = { ...list[idx], path: posix, lastOpenedAt: now };
    return list;
  }
  list.push({ path: posix, addedAt: now, lastOpenedAt: now });
  return list;
}

/** 移除登记项（仅从列表移除语义，不动物理文件）。返回新数组。 */
export function removeEntry(entries, path, projectRoot = '') {
  const canon = canonConfigPath(path, projectRoot);
  return (Array.isArray(entries) ? entries : []).filter(
    (e) => canonConfigPath(e && e.path, projectRoot) !== canon
  );
}

/** 刷新最近打开时间（打开外部配置时调用）。返回新数组。 */
export function touchEntry(entries, path, projectRoot = '') {
  const canon = canonConfigPath(path, projectRoot);
  const now = Date.now();
  return (Array.isArray(entries) ? entries : []).map((e) =>
    canonConfigPath(e && e.path, projectRoot) === canon ? { ...e, lastOpenedAt: now } : e
  );
}
