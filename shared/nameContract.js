// SE 命名契约镜像（期 0，SE中文名同步改造方案 §5）。
//
// 目的：把 SE 侧真源 `snakeeats/naming.py` 的分层 Unicode 契约在前端做**近似**镜像，
// 用于即时 UX 预检与「从文件名/旧 title 派生」。**SE 仍是最终门禁**——本模块允许略宽、
// 绝不略严；前端预检放行的名字由 SE 最终裁决（D2）。
//
// 边界：纯函数，零 DOM / 零 React / 零 node:path / 零 fetch ⇒ 浏览器与 Node 双端可导入
// （与 paths.js 同约束）。UTF-8 字节数用 `TextEncoder`；NFKC 用 `String.prototype.normalize`。
//
// 与 Python 的近似口径（登记见方案 §5）：
//   `unicodedata.name(ch).startswith(prefixes)` ↔ `\p{Script=…}`（JS 无 unicodedata.name）；
//   结果可能略宽（如 `\p{Script=Han}` 含少数 Python 会拒的字符），方向安全。

// ── 长度契约（分层，与 naming.py 对齐）──────────────────────────────────
export const MAX_NAME_CP = 64; // 硬上限（码点）
export const MAX_NAME_BYTES = 128; // 硬上限（UTF-8 字节）
const LONGEST_DERIVED_SUFFIX = '_scan_log'; // 9：派生名预留量基准
export const MAX_USER_CP = MAX_NAME_CP - LONGEST_DERIVED_SUFFIX.length; // 55
export const MAX_USER_BYTES = MAX_NAME_BYTES - LONGEST_DERIVED_SUFFIX.length; // 119

const RESERVED_SUFFIXES = ['_console', '_scan_log'];
const RESERVED_PREFIXES = ['_scan_end_', '_control_'];

// 允许的脚本（近似 Python 的 name 前缀白名单）。
const LETTER = /^\p{L}$/u;
const SCRIPT_RE =
  /[\p{Script=Latin}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u;

/** 是否「允许的字母」：Unicode 广义分类以 L 开头，且脚本在白名单内。 */
function isAllowedLetter(ch) {
  return LETTER.test(ch) && SCRIPT_RE.test(ch);
}

const isDigit = (ch) => ch >= '0' && ch <= '9';

/** 码点迭代（`for (const ch of name)` 即为码点迭代，非 UTF-16 单元）。 */
const cpLen = (s) => [...String(s)].length;
const cpSlice = (s, n) => [...String(s)].slice(0, n).join('');
const hasLetter = (s) => [...String(s)].some(isAllowedLetter);

/** UTF-8 字节数。 */
function utf8Length(s) {
  return new TextEncoder().encode(String(s)).length;
}

// ── 门禁（只校验，从不改写）────────────────────────────────────────────

/**
 * 字符集 / NFKC / 分类 / 长度契约（默认硬上限，安全缺省）。
 * @param {unknown} name
 * @param {{maxCp?:number, maxBytes?:number}} [opts]
 * @returns {string|null} 错误描述；合法返回 null。
 */
export function nameError(name, { maxCp = MAX_NAME_CP, maxBytes = MAX_NAME_BYTES } = {}) {
  if (typeof name !== 'string') return 'name must be a string';
  if (!name) return 'name must be non-empty';
  let codePoints;
  try {
    codePoints = [...name];
  } catch (err) {
    codePoints = null;
  }
  if (!codePoints) return 'name contains surrogate code points';
  // 单代理码位（未配对）——合法增补字符是成对代理，码点 > 0xFFFF，不在此范围。
  for (const ch of codePoints) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xd800 && cp <= 0xdfff) return 'name contains surrogate code points';
  }
  if (codePoints.length > maxCp) return `name too long (>${maxCp} code points)`;
  if (utf8Length(name) > maxBytes) return `name too long (>${maxBytes} UTF-8 bytes)`;
  if (name.normalize('NFKC') !== name) return 'name contains compatibility characters (not NFKC-stable)';
  const first = codePoints[0];
  if (first !== '_' && !isAllowedLetter(first)) return 'name must start with a letter or underscore';
  let seenLetter = false;
  for (const ch of codePoints) {
    if (ch === '_' || isDigit(ch)) continue;
    if (isAllowedLetter(ch)) {
      seenLetter = true;
      continue;
    }
    return `character ${ch} not allowed`;
  }
  return seenLetter ? null : 'name must contain at least one letter';
}

/**
 * 保留位（仅流用户面）：不得以 `_console`/`_scan_log` 结尾，不得以 `_scan_end_`/`_control_` 开头。
 * （调用方须先经 `nameError` 的字符串检查。）
 */
export function reservedError(name) {
  if (typeof name !== 'string') return 'name must be a string';
  if (RESERVED_SUFFIXES.some((s) => name.endsWith(s))) {
    return 'name must not end with a reserved suffix (_console/_scan_log)';
  }
  if (RESERVED_PREFIXES.some((p) => name.startsWith(p))) {
    return 'name must not start with a reserved prefix (_scan_end_/_control_)';
  }
  return null;
}

/** 用户面（流）：用户上限 55/119 + 保留位。 */
export function streamNameError(name) {
  return (
    nameError(name, { maxCp: MAX_USER_CP, maxBytes: MAX_USER_BYTES }) || reservedError(name)
  );
}

/** 工具名：字符集 + 用户上限；**无保留位**（工具不派生内部流）。 */
export function toolNameError(name) {
  return nameError(name, { maxCp: MAX_USER_CP, maxBytes: MAX_USER_BYTES });
}

/** 内部/派生名：字符集 + 硬上限（跳过保留位与用户上限）。 */
export function derivedNameError(name) {
  return nameError(name);
}

export const isValidStreamName = (n) => streamNameError(n) === null;
export const isValidToolName = (n) => toolNameError(n) === null;
export const isValidDerivedName = (n) => derivedNameError(n) === null;

// ── 派生（仅在「从文件名/旧 title 派生」时改写；用户直接输入走校验）──────

/** 8 位随机 hex（全非法回退）。 */
function randomHex8() {
  let s = '';
  while (s.length < 8) s += Math.floor(Math.random() * 16).toString(16);
  return s.slice(0, 8);
}

/** 修保留位：结尾命中保留后缀 → 追加 `_`；开头命中保留前缀 → 前置 `_`。 */
function fixReserved(name) {
  let out = name;
  while (RESERVED_SUFFIXES.some((s) => out.endsWith(s))) out += '_';
  while (RESERVED_PREFIXES.some((p) => out.startsWith(p))) out = `_${out}`;
  return out;
}

/** 收敛到用户上限（按码点/字节双约束，从尾部裁剪，去掉裁剪后的尾随 `_`）。 */
function fitUserLimits(name) {
  let s = String(name);
  let guard = 0;
  while (s && (cpLen(s) > MAX_USER_CP || utf8Length(s) > MAX_USER_BYTES) && guard < 4096) {
    s = cpSlice(s, cpLen(s) - 1).replace(/_+$/, '');
    guard += 1;
  }
  return s;
}

/**
 * 任意文本 → 合规流名：保留契约合法字符（含 CJK）、非法字符折叠 `_`、折叠连续 `_`、
 * 去首尾 `_`、去前导数字（首字符须字母或 `_`）；空/无字母 → `stream_<8hex>`；
 * 命中保留位 → 修正；与 taken 去重追加 `_2`/`_3`…。
 *
 * 取代旧 `deriveStreamName`（仅用于「从文件名/旧 title 派生」场景）。
 *
 * @param {unknown} raw 原始文本
 * @param {Iterable<string>|Array<string>} [taken] 已占用的 name 集合
 * @returns {string} 合规且唯一的流 name
 */
export function toStreamName(raw, taken = []) {
  const takenSet = taken instanceof Set
    ? taken
    : new Set(
        (Array.isArray(taken) ? taken : Array.from(taken || [])).map((x) =>
          String(x == null ? '' : x)
        )
      );

  const src = String(raw == null ? '' : raw);
  let out = '';
  for (const ch of src) {
    if (ch === '_' || isDigit(ch) || isAllowedLetter(ch)) out += ch;
    else out += '_';
  }
  out = out.replace(/_{2,}/g, '_');
  out = out.replace(/^_+/, '').replace(/_+$/, '');
  out = out.replace(/^[0-9]+/, ''); // 首字符须字母或 `_`（`_` 已去）
  if (!out || !hasLetter(out)) out = `stream_${randomHex8()}`;
  out = fitUserLimits(fixReserved(out));

  let candidate = out;
  let n = 2;
  while (takenSet.has(candidate)) {
    const suffix = `_${n}`;
    const room = MAX_USER_CP - cpLen(suffix);
    const base = cpLen(out) > room ? cpSlice(out, room) : out;
    candidate = fitUserLimits(`${base}${suffix}`);
    n += 1;
  }
  return candidate;
}

/**
 * 任意文本 → 合规工具名：与 `toStreamName` 同源字符判定，但**不做保留位修正**
 * （工具名无保留位），且不做前导数字剥离以外的额外处理。
 * 空/无字母 → `tool_<8hex>`；与 taken 去重追加 `_2`/`_3`…。
 */
export function toToolName(raw, taken = []) {
  const takenSet = taken instanceof Set
    ? taken
    : new Set(
        (Array.isArray(taken) ? taken : Array.from(taken || [])).map((x) =>
          String(x == null ? '' : x)
        )
      );

  const src = String(raw == null ? '' : raw);
  let out = '';
  for (const ch of src) {
    if (ch === '_' || isDigit(ch) || isAllowedLetter(ch)) out += ch;
    else out += '_';
  }
  out = out.replace(/_{2,}/g, '_');
  out = out.replace(/^_+/, '').replace(/_+$/, '');
  out = out.replace(/^[0-9]+/, '');
  if (!out || !hasLetter(out)) out = `tool_${randomHex8()}`;
  out = fitUserLimits(out);

  let candidate = out;
  let n = 2;
  while (takenSet.has(candidate)) {
    const suffix = `_${n}`;
    const room = MAX_USER_CP - cpLen(suffix);
    const base = cpLen(out) > room ? cpSlice(out, room) : out;
    candidate = fitUserLimits(`${base}${suffix}`);
    n += 1;
  }
  return candidate;
}

// ── 系统 / 配置包命名（system_id 与显示名；与流/工具名的契约字符集不同）──────

/** 身份比较用 casefold（NFC + 小写；system_id 已被 sanitize 成 ASCII）。 */
export function foldSystemId(raw) {
  return String(raw == null ? '' : raw).normalize('NFC').toLowerCase();
}

/** 同一系统判定（大小写不敏感；用于 tab 去重/关闭归属/storage 身份比较）。 */
export function sameSystemId(a, b) {
  return foldSystemId(a) === foldSystemId(b);
}

/** 从派生值取安全 system_id（对齐 vite 侧 sanitizeSeSystemId 字符集）。 */
export function sanitizeSystemId(raw) {
  const cleaned = String(raw == null ? '' : raw)
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[_.-]+|[_.-]+$/g, '');
  return cleaned;
}

/**
 * 派生 system_id：非法字符→_、折叠、去首尾；结果空或保留名 → se_<8 随机>。
 * taken 命中则追加 _2/_3…（同名包并存场景）。
 */
export function deriveSystemId(displayName, taken = new Set()) {
  let base = sanitizeSystemId(displayName);
  if (!base || base === '.' || base === '..') {
    base = `se_${Math.random().toString(16).slice(2, 10)}`;
  }
  base = base.slice(0, 100);
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${base}_${n}`;
    n += 1;
  }
  return candidate;
}

/** 配置包文件名 → 显示名（去 .se.json / .json 后缀）。 */
/**
 * Strict system_id validation (does not rewrite input): trimmed 1..128 chars,
 * not . or .., ASCII [A-Za-z0-9_.-] only. Unlike deriveSystemId/sanitizeSystemId,
 * this validates an existing identity rather than deriving a safe one.
 */
export function validateSystemId(raw) {
  const id = String(raw == null ? '' : raw).trim();
  if (!id || id.length > 128 || id === '.' || id === '..') return null;
  return /^[A-Za-z0-9_.-]+$/.test(id) ? id : null;
}

export function displayNameFromPath(filePath) {
  const base = String(filePath || '').split(/[\\/]/).pop() || '';
  return base.replace(/\.se\.json$/i, '').replace(/\.json$/i, '');
}

/** 显示名查重：命中则加「_copy」，再命中按「_copy_2」「_copy_3」…递增（入名已带 _copy 后缀时在原词干上递增）。 */
export function uniqueDisplayName(name, existingNames = []) {
  const taken = new Set(existingNames.map((x) => String(x || '')));
  const base = String(name || '').trim() || '未命名系统';
  if (!taken.has(base)) return base;
  const m = base.match(/^(.*?)_copy(?:_(\d+))?$/);
  const stem = m ? m[1] : base;
  let n = m ? (m[2] ? Number(m[2]) + 1 : 2) : 1;
  let candidate = n === 1 ? `${stem}_copy` : `${stem}_copy_${n}`;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `${stem}_copy_${n}`;
  }
  return candidate;
}
