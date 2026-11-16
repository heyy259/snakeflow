// 共享路径 / 文件名 / 内容引用 helper（期 0）。
//
// 边界：纯字符串工具 + 经注入的 IO 薄封装；**零 DOM、零 node:path 内建** ⇒ 浏览器与 Node 双端可导入。
// 由 packageExport.js（文件名 / 可移植路径）与 packageImport.js（兄弟路径 / 读通道）抽出，行为不变；
// packageExport / packageImport 改为 import + 再导出，保持既有调用方（App / 测试 / 迁移脚本）零改名。
//
// 新增：
// - `sanitizeGraphName`：与 vite 服务端 `sanitizeName` 同源的图名净化（配置文件 `graphs/<名>.json`
//   与内容目录 `graphs/<名>.streams/` 必须用同一函数，否则两处会分叉）；
// - `readContentRef`：内容引用（`source = {file_path, encoding}`）的读取薄封装
//   —— 图谱文档的 `file_path` 相对项目根（服务端 resolve），SE manifest 的相对 `file_path` 用
//   `resolveSiblingPath` 兄弟解析，由是否传 `basePath` 区分。


const DEFAULT_EXT = '.md';

/** 图配置文件扩展名（唯一真源；snakeeats 侧按 manifest 目录解析 source）。 */
export const GRAPH_CONFIG_EXT = '.se.json';

const EXT_BODY_RE = /^[A-Za-z0-9]{1,8}$/;
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const ILLEGAL_CHARS_RE = /[\\/:*?"<>|\u0000-\u001f]+/g;
const CROSS_DRIVE_WARNING = '跨盘无法回写相对路径，已保留绝对路径。';
const NO_BASE_WARNING = '缺少包目录基准，已保留绝对路径。';
const BOM_RE = /^\uFEFF/;

// ---- 路径字符串 helper（不 import node:path，保证浏览器可导入） ----

/** 反斜杠 → 正斜杠。 */
export function toPosix(p) {
  return String(p == null ? '' : p).replace(/\\/g, '/');
}

/** 路径根标识：盘符 / UNC 共享 / POSIX 根 / 相对。 */
export function rootKey(p) {
  const norm = toPosix(p);
  const drive = /^([A-Za-z]):/.exec(norm);
  if (drive) return `drive:${drive[1].toLowerCase()}`;
  if (norm.startsWith('//')) {
    const parts = norm.slice(2).split('/').filter(Boolean);
    return `unc:${parts.slice(0, 2).join('/').toLowerCase()}`;
  }
  if (norm.startsWith('/')) return 'posix';
  return 'relative';
}

/** 规范化分段（去空段/`.`，折叠 `..`），剥掉盘符或 UNC 共享前缀。 */
export function segmentsOf(p) {
  const norm = toPosix(p);
  let rest = norm;
  const drive = /^([A-Za-z]):/.exec(norm);
  if (drive) rest = norm.slice(drive[0].length);
  else if (norm.startsWith('//')) {
    rest = `/${norm.slice(2).split('/').filter(Boolean).slice(2).join('/')}`;
  }
  const out = [];
  for (const seg of rest.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else out.push(seg);
    } else out.push(seg);
  }
  return out;
}

/** 同根两路径的相对路径（POSIX 风格；大小写不敏感比较，输出保留原大小写）。 */
export function relativePosix(fromDir, toPath) {
  const base = segmentsOf(fromDir);
  const target = segmentsOf(toPath);
  let i = 0;
  while (i < base.length && i < target.length && base[i].toLowerCase() === target[i].toLowerCase()) i += 1;
  const parts = base.slice(i).map(() => '..');
  for (const seg of target.slice(i)) parts.push(seg);
  return parts.join('/');
}

// ---- 统一路径原语（流 / 工具共用；唯一语义来源） ----
//
// 三态：absolute（盘符 / UNC / POSIX 根）、relative（含 `..`）。
// 写侧 normalize：相对保持；绝对在同根下转相对。
// 读侧 resolve：绝对原样；相对按基准拼接。
// 基准永远是「声明它的 manifest 所在目录」；不读进程 cwd。

/** 是否绝对路径（盘符 / UNC / POSIX 根）。 */
export function isAbsolutePath(p) {
  const raw = toPosix(p).trim();
  return /^[A-Za-z]:\//.test(raw) || raw.startsWith('//') || raw.startsWith('/');
}

/** 相对值按基准拼接；绝对原样；空基准原样返回。 */
export function joinBase(baseDir, rel) {
  const raw = toPosix(rel).trim();
  if (!raw) return '';
  if (isAbsolutePath(raw)) return raw;
  const base = toPosix(baseDir).trim().replace(/\/+$/, '');
  if (!base) return raw;
  return `${base}/${raw}`;
}

/**
 * 绝对 → 相对基准：同根才转（同目录返回 `.`）；跨盘 / 无基准保留绝对 + warning。
 * @returns {{value:string, warning:string|null}}
 */
export function relativizePath(p, baseDir) {
  const raw = toPosix(p).trim();
  if (!raw) return { value: '', warning: null };
  if (!isAbsolutePath(raw)) return { value: raw, warning: null };
  const base = toPosix(baseDir).trim().replace(/\/+$/, '');
  if (!base) return { value: raw, warning: NO_BASE_WARNING };
  if (rootKey(raw) !== rootKey(base)) return { value: raw, warning: CROSS_DRIVE_WARNING };
  const rel = relativePosix(base, raw);
  return { value: rel || '.', warning: null };
}

/** 写侧归一：相对保持；绝对在同根下转相对；否则保留绝对。 */
export function normalizeResourcePath(p, baseDir) {
  const raw = toPosix(p).trim();
  if (!raw) return '';
  if (!isAbsolutePath(raw)) return raw;
  return relativizePath(raw, baseDir).value;
}

/** 读侧解析：绝对原样；相对按基准拼接。 */
export function resolveResourcePath(p, baseDir) {
  const raw = toPosix(p).trim();
  if (!raw) return '';
  if (isAbsolutePath(raw)) return raw;
  return joinBase(baseDir, raw);
}

// ---- 文件名 helper ----

/** 扩展名规范化：补前导点；主体须 [A-Za-z0-9]{1,8}，否则回落 .md。 */
export function normalizeExt(ext) {
  const raw = ext == null ? '' : String(ext).trim();
  if (!raw) return DEFAULT_EXT;
  const e = raw.startsWith('.') ? raw : `.${raw}`;
  return EXT_BODY_RE.test(e.slice(1)) ? e : DEFAULT_EXT;
}

/**
 * 流名 → 文件名（含 Windows 守卫）。
 * SE 流名已满足 [A-Za-z0-9_]+（净化实为 no-op）；此处仅：禁分隔符/控制符（→ `_`）、
 * 去尾部点/空格、设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）前缀 `_`、禁 `.se.json` 结尾；
 * 基为空 → `stream`；扩展名非法 → `.md`。
 */
export function sanitizeStreamFilename(name, ext = DEFAULT_EXT) {
  const suffix = normalizeExt(ext);
  let base = String(name == null ? '' : name).replace(ILLEGAL_CHARS_RE, '_');
  base = base.replace(/[. ]+$/g, '');
  if (!base) base = 'stream';
  const stem = base.toLowerCase().replace(/\.[^.]*$/, '');
  if (WINDOWS_RESERVED_RE.test(stem)) base = `_${base}`;
  if (suffix.toLowerCase() === '.json' && /\.se$/i.test(base)) {
    base = base.replace(/\.se$/i, '') || 'stream';
  }
  return `${base}${suffix}`;
}

/**
 * 流集合 → 文件名映射（确定性 + 幂等）。
 * 按流 name 升序；Sanitize 后按小写去重，冲突时在基名后（扩展名前）补 `_2`/`_3`…
 */
export function assignFilenames(streams, ext = DEFAULT_EXT) {
  const suffix = normalizeExt(ext);
  const names = [];
  const seen = new Set();
  for (const row of Array.isArray(streams) ? streams : []) {
    const raw = row && typeof row === 'object' ? row.name : row;
    const name = raw == null ? '' : String(raw);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  names.sort();
  const entries = names.map((name) => {
    const full = sanitizeStreamFilename(name, suffix);
    return { name, full, stem: full.slice(0, full.length - suffix.length) || 'stream' };
  });
  // 全部基名先占位：补号时避让他流基名，避免 `foo` 抢走名为 `foo_2` 的流的文件名。
  const claimed = new Set(entries.map((e) => e.full.toLowerCase()));
  const used = new Set();
  const out = new Map();
  for (const entry of entries) {
    const own = entry.full.toLowerCase();
    let candidate = entry.full;
    let n = 2;
    while (used.has(candidate.toLowerCase())
      || (candidate.toLowerCase() !== own && claimed.has(candidate.toLowerCase()))) {
      candidate = `${entry.stem}_${n}${suffix}`;
      n += 1;
    }
    used.add(candidate.toLowerCase());
    out.set(entry.name, candidate);
  }
  return out;
}

// ---- 图名净化（与 vite 服务端同源） ----

/**
 * 图名 / tab 名 → 文件名安全基名。与 `vite.config.js` 的 `sanitizeName` 保持**逐字符一致**：
 * 去掉控制符（charCode ≤ 31）与禁字符 `<>:"/\|?*`，再 trim。空结果原样返回 ''（调用方决定回退）。
 * 配置文件 `graphs/<基名>.json` 与内容目录 `graphs/<基名>.streams/` 必须都用它派生，避免分叉。
 */
export function sanitizeGraphName(name) {
  return String(name == null ? '' : name)
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '')
    .trim();
}

/** 图配置文件文件名（无目录）；空名 → ''（调用方跳过持久化）。 */
export function graphConfigFileName(name) {
  const base = sanitizeGraphName(name);
  return base ? `${base}${GRAPH_CONFIG_EXT}` : '';
}

// ---- 路径可移植化 / 身份 helper ----

/**
 * 工具路径可移植化（对齐 snakeeats config/paths.py:46 to_portable_path 语义）：
 * 同盘 → 相对 baseDir（正斜杠）；跨盘 → 保留绝对路径 + warning；空/相对路径 → 原样静默。
 */
export function portablePath(p, baseDir) {
  return relativizePath(p == null ? '' : String(p), baseDir);
}

/**
 * 工具路径绝对化（`portablePath` 的逆向，供 `tool.register`）：
 * SE 把相对 `tool_path` 按自身进程 CWD 解析，故必须以 manifest 所在目录为基准先绝对化。
 * 空/空白 → ''；绝对（盘符 / UNC / POSIX 根）→ 归一化正斜杠原样；
 * 相对 + 非空 `baseDir` → `${baseDir}/${p}`（均正斜杠，baseDir 去尾斜杠）；相对 + 无 baseDir → 原样静默。
 */
export function absolutizeToolPath(p, baseDir) {
  return resolveResourcePath(p == null ? '' : p, baseDir);
}

/** 项目根归一化：正斜杠 + 去首尾空白 + 去尾斜杠（空/缺省 → ''）。 */
function normalizeDocRoot(projectRoot) {
  return toPosix(projectRoot).trim().replace(/\/+$/, '');
}

/** 是否位于 root 之下：同根 + 分段大小写不敏感前缀，且须比 root 更深一层。 */
function isUnderDocRoot(p, root) {
  if (rootKey(p) !== rootKey(root)) return false;
  const pSeg = segmentsOf(p);
  const rSeg = segmentsOf(root);
  if (!rSeg.length || pSeg.length <= rSeg.length) return false;
  for (let i = 0; i < rSeg.length; i += 1) {
    if (pSeg[i].toLowerCase() !== rSeg[i].toLowerCase()) return false;
  }
  return true;
}

/**
 * 持久化文档路径可移植化（`tab.docPath` / `tab.system.manifest_path` / `.configs.json` 登记契约）：
 * 1. 空 → `''`；
 * 2. 相对 → 原样（服务端按项目根解析）；
 * 3. 绝对且在项目根下 → 相对项目根（`relativePosix`，大小写不敏感比较，输出保留原大小写）；
 * 4. 绝对、形如 `.../graphs/<文件>` 但不在项目根下 → 仅当 `repairGraphsResidue` 为 true 时
 *    折叠为 `graphs/<文件>`（**仅用于旧工作区一次性迁移**；显式用户路径绝不折叠）；
 * 5. 其余绝对 → 原样（外部文件保持绝对路径，行为同改造前）。
 * 项目根本身已归一化（任一斜杠风格均可）。
 * @param {string} p 待持久化路径（任一斜杠风格）
 * @param {string} projectRoot 项目根（任一斜杠风格；空 = 不相对化，行为同改造前）
 * @param {{repairGraphsResidue?: boolean}} [opts] 旧工作区迁移开关（默认 false）
 * @returns {string} 正斜杠风格的可移植路径
 */
export function portableDocPath(p, projectRoot, opts = {}) {
  const raw = toPosix(p == null ? '' : p).trim();
  if (!raw) return '';
  if (rootKey(raw) === 'relative') return raw;
  const root = normalizeDocRoot(projectRoot);
  if (root && isUnderDocRoot(raw, root)) return relativePosix(root, raw);
  if (opts && opts.repairGraphsResidue && /\/graphs\/[^/]+$/i.test(raw)) {
    return `graphs/${raw.split('/').pop()}`;
  }
  return raw;
}

/**
 * 可移植文档路径还原为绝对路径（供不经 vite `resolveUserPath` 的通道，如 SE `config.load`）：
 * 相对 + 非空项目根 → `${root}/${p}`；已绝对 / 空根 → 正斜杠原样。
 * @param {string} p 可移植路径
 * @param {string} projectRoot 项目根（任一斜杠风格）
 * @returns {string} 正斜杠绝对路径（无法还原时原样）
 */
export function absolutizeDocPath(p, projectRoot) {
  const raw = toPosix(p == null ? '' : p).trim();
  if (!raw) return '';
  if (rootKey(raw) !== 'relative') return raw;
  return joinBase(normalizeDocRoot(projectRoot), raw);
}

/** 绝对路径是否落在本项目 graphs/ 下（外部 .../graphs/ 不误判；根未知时回退后缀判断）。 */
export function isGraphsDocPath(docPath, projectRoot = '') {
  const p = toPosix(docPath == null ? '' : docPath).trim();
  if (!p) return false;
  if (rootKey(p) === 'relative') return p.startsWith('graphs/');
  const root = normalizeDocRoot(projectRoot);
  if (!root) return /\/graphs\/[^/]+$/i.test(p);
  const graphsRoot = `${root}/graphs`.toLowerCase();
  const lower = p.toLowerCase();
  return lower === graphsRoot || lower.startsWith(`${graphsRoot}/`);
}

/** 路径规范化比较键（正斜杠 + 小写 + 去尾斜杠）：同一物理文件查重用。
 *  相对输入先与项目根拼接（仅当根非空），使「绝对 vs 相对」混合比较也能去重。 */
export function canonDocPath(p, projectRoot = '') {
  let s = String(p || '').replace(/\\/g, '/');
  const root = String(projectRoot || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const isAbs = /^[A-Za-z]:\//.test(s) || s.startsWith('//') || s.startsWith('/');
  if (root && s && !isAbs) s = `${root}/${s}`;
  return s.replace(/\/+$/, '').toLowerCase();
}

/**
 * manifest 路径 → **绝对**目录（工具/配置注册基准的唯一来源）。
 * 相对 manifestPath 先按项目根绝对化；项目根未知/无法绝对化 → 返回 `''`。
 * 调用方必须 fail-closed（绝不退回相对基准，否则 SE 会按自身 CWD 解析）。
 * @param {string} manifestPath
 * @param {string} [projectRoot] 缺省取已缓存的项目根
 * @returns {string} 正斜杠绝对目录；不可得 → ''
 */
export function manifestAbsDirOf(manifestPath, projectRoot = '') {
  const p = String(manifestPath == null ? '' : manifestPath).trim();
  if (!p) return '';
  const abs = absolutizeDocPath(p, projectRoot);
  if (!abs || rootKey(abs) === 'relative') return '';
  const dir = manifestDirOf(abs);
  return dir === '.' ? '' : dir;
}

/** manifest 路径 → 所在目录（兼容 `\` 与 `/`；无目录段 → `.`）。 */
export function manifestDirOf(manifestPath) {
  const p = String(manifestPath == null ? '' : manifestPath);
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (!p || idx < 0) return '.';
  const head = p.slice(0, idx);
  const sep = p[idx];
  if (!head) return sep;
  if (/^[A-Za-z]:$/.test(head)) return `${head}${sep}`;
  return head;
}

/** manifest 路径 → 包名（去 `.se.json` / `.json` 后缀，大小写不敏感）。 */
export function packageNameFromPath(manifestPath) {
  const base = String(manifestPath == null ? '' : manifestPath).split(/[\\/]/).pop() || '';
  return base.replace(/\.se\.json$/i, '').replace(/\.json$/i, '');
}

/**
 * manifest 路径 + 相对 `file_path` → 绝对/可读路径（字符串拼接，零 node:path）。
 * - `file_path` 绝对（盘符 / UNC / POSIX 根）→ 归一化正斜杠后原样返回（跨盘回退兼容）；
 * - 相对 → manifest 所在目录（`manifestDirOf` 语义）+ 归一化相对路径；
 * - 目录为空/`.` → 返回归一化相对路径本身。
 */
export function resolveSiblingPath(manifestPath, filePath) {
  const raw = String(filePath == null ? '' : filePath).trim();
  if (!raw) return '';
  const normalized = raw.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//') || normalized.startsWith('/')) {
    return normalized;
  }
  const dir = manifestDirOf(manifestPath).replace(/\\/g, '/');
  if (!dir || dir === '.') return normalized;
  const base = dir.endsWith('/') ? dir : `${dir}/`;
  return `${base}${normalized}`;
}

// ---- 文本与包含判定（纯函数，浏览器/Node 双端） ----

/** 去 BOM（U+FEFF 前缀）。 */
export function stripBom(text) {
  return String(text == null ? '' : text).replace(/^\uFEFF/, '');
}

/** child 是否位于 parent 之下（不含相等）：同根 + 分段前缀，大小写不敏感。 */
export function isInside(parent, child) {
  if (!parent || !child) return false;
  if (rootKey(parent) !== rootKey(child)) return false;
  const p = segmentsOf(parent);
  const c = segmentsOf(child);
  if (!p.length || c.length <= p.length) return false;
  for (let i = 0; i < p.length; i += 1) {
    if (p[i].toLowerCase() !== c[i].toLowerCase()) return false;
  }
  return true;
}
