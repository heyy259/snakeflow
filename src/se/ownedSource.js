// 应用拥有的镜像文件（owned source）判定 + 改名计划。
//
// 背景（见 docs 与 App.jsx 注释）：
// - `source.file_path` 相对 manifest 所在目录；应用为流分配的镜像是
//   `<manifest base>.streams/<sanitize(name)>.md`。
// - 外部文档（绝对路径 / `..` 逃逸 / 不在本 tab 的 .streams 目录内）是用户私有绑定，
//   永远不能移动。
// - 旧的文档可能把 source 写成 `graphs/<base>.streams/...`（项目根相对）。
//   这里统一归一化到 manifest 相对形式，避免 `resolveAgainstConfigDir` 双前缀。
//
// 纯函数：无 DOM / node:path 依赖，浏览器与 Node 单测可共用。

import { sanitizeGraphName, sanitizeStreamFilename } from './paths.js';
import { isInternalStream } from './procAssoc.js';

const ILLEGAL_TAG_RE = /[\\/:*?"<>|\u0000-\u001f]+/g;
const ABS_RE = /^(?:[A-Za-z]:\/|\/\/|\/)/;

export function toPosix(p) {
  return String(p == null ? '' : p).replace(/\\/g, '/');
}

export function isAbsoluteSource(p) {
  return ABS_RE.test(toPosix(p));
}

function hasParentEscape(p) {
  return toPosix(p)
    .split('/')
    .some((seg) => seg === '..');
}

function trimSlashes(p) {
  return toPosix(p).replace(/\/+/g, '/').replace(/\/+$/, '');
}

function joinPath(base, rel) {
  const b = trimSlashes(base);
  const r = toPosix(rel).replace(/^\/+/, '');
  if (!b) return r;
  return `${b}/${r}`;
}

/** manifest base → owned streams 目录名（manifest 同级相对）。 */
export function ownedStreamsDirName(docBase) {
  const base = sanitizeGraphName(docBase);
  return base ? `${base}.streams` : '';
}

/**
 * 相对 `source.file_path` 是否指向**另一个图谱**的 `.streams/` 目录。
 *
 * 背景：`source.file_path` 相对 manifest 所在目录；每个图谱拥有自己的
 * `<docBase>.streams/`（`findDocOwner` 保证同一物理文档只有一个 tab）。
 * 因此 `<其他图名>.streams/...` 不可能是本文档的 owned source，而是跨图引用
 * （历史合并/手工拷贝产物）。它只应在**破坏性/创造性**边界被拦截：
 *   - 删除正文文件（`purgeStreamArtifacts`）：保留他图文件；
 *   - 自动建流（`repairRegistryFromDocument` / `pushFileStreams`）：不物化到 SE。
 * 读取/投影本身不拦截，避免误伤已有数据。
 *
 * 判定范围：
 *   - 只认相对路径（`graphs/` 前缀会先归一化掉）；
 *   - 绝对路径 / `..` 逃逸 / 非 `*.streams` 首段 → false（外部文档或无效路径）；
 *   - 本图 `.streams/` → false；其他 `<name>.streams/` → true（大小写不敏感）。
 *
 * @param {string} sourcePath `source.file_path` 原始值
 * @param {string} docBase 当前文档 base（`docBaseOf(tab)`）
 * @returns {boolean}
 */
export function isCrossGraphSource(sourcePath, docBase) {
  const raw = toPosix(sourcePath).trim().replace(/^\.\/+/, '');
  if (!raw || isAbsoluteSource(raw) || hasParentEscape(raw)) return false;
  const p = raw.replace(/^graphs\//i, '');
  const first = p.split('/')[0] || '';
  if (!/\.streams$/i.test(first)) return false;
  const own = ownedStreamsDirName(docBase);
  if (!own) return false;
  return first.toLowerCase() !== own.toLowerCase();
}

/**
 * source 路径 → 可参与 FS 操作的路径（保留绝对/相对语义）。
 * - 拒绝 `..`。
 * - 若 configDir 本身已是 `graphs` / `.../graphs`，去掉 source 的旧 `graphs/` 前缀。
 */
export function resolveOwnedSourcePath(sourcePath, configDir) {
  const raw = toPosix(sourcePath).trim();
  if (!raw || hasParentEscape(raw)) return null;
  const cfg = trimSlashes(configDir) || 'graphs';
  let rel = raw.replace(/^\.\/+/, '');
  const cfgLower = cfg.toLowerCase();
  if (
    rel.toLowerCase().startsWith('graphs/') &&
    (cfgLower === 'graphs' || cfgLower.endsWith('/graphs'))
  ) {
    rel = rel.slice('graphs/'.length);
  }
  if (isAbsoluteSource(rel)) return rel;
  return joinPath(cfg, rel);
}

/**
 * 计算 owned source 的改名计划。
 *
 * @param {object} p
 * @param {string} p.sourcePath      当前 source.file_path（原始文本）
 * @param {string} p.configDir       manifest 所在目录（绝对或项目相对）
 * @param {string} p.docBase         manifest base（docBaseOf(tab)）
 * @param {string} p.newName         新 data.name
 * @param {string} [p.suffixTag]     冲突后缀 tag（一般用 node id）
 * @param {string[]} [p.otherSourcePaths] 其他节点已解析的 source 路径（绝对/相对）
 * @param {number} [p.suffixIndex]   0=原名，1=-tag，2=-tag_2 ...
 * @returns {null | {from:string,to:string,fromAbs:string,toAbs:string,caseOnly:boolean,noop:boolean}}
 */
export function planOwnedSourceRename({
  sourcePath,
  configDir,
  docBase,
  newName,
  suffixTag = 'x',
  otherSourcePaths = [],
  suffixIndex = 0,
} = {}) {
  const name = String(newName == null ? '' : newName).trim();
  if (!name || isInternalStream(name)) return null;
  const dirName = ownedStreamsDirName(docBase);
  if (!dirName) return null;

  const raw = toPosix(sourcePath).trim();
  if (!raw || isAbsoluteSource(raw) || hasParentEscape(raw)) return null;

  const cfg = trimSlashes(configDir) || 'graphs';
  const fromAbs = resolveOwnedSourcePath(raw, cfg);
  if (!fromAbs) return null;

  const expectedDir = joinPath(cfg, dirName);
  const fromDir = fromAbs.slice(0, Math.max(0, fromAbs.lastIndexOf('/')));
  if (fromDir.toLowerCase() !== expectedDir.toLowerCase()) return null;

  const extMatch = raw.match(/\.[^./]+$/);
  const ext = extMatch ? extMatch[0] : '.md';
  const desiredBase = sanitizeStreamFilename(name || 'stream', ext);
  const stem = desiredBase.slice(0, desiredBase.length - ext.length) || 'stream';
  const tag = String(suffixTag == null ? '' : suffixTag).replace(ILLEGAL_TAG_RE, '_') || 'x';

  const taken = new Set(
    (Array.isArray(otherSourcePaths) ? otherSourcePaths : [])
      .filter(Boolean)
      .map((p) => toPosix(p).toLowerCase())
  );

  let base = desiredBase;
  if (suffixIndex > 0) {
    const i = Number(suffixIndex);
    base = i === 1 ? `${stem}-${tag}${ext}` : `${stem}-${tag}_${i}${ext}`;
  }
  // 防御：即使调用方给的 suffixIndex 仍撞已有引用，继续递增到空位。
  let guard = 0;
  while (taken.has(joinPath(expectedDir, base).toLowerCase()) && guard < 50) {
    guard += 1;
    const i = suffixIndex + guard;
    base = i === 1 ? `${stem}-${tag}${ext}` : `${stem}-${tag}_${i}${ext}`;
  }

  const to = `${dirName}/${base}`;
  const toAbs = joinPath(cfg, to);
  const caseOnly =
    fromAbs !== toAbs && fromAbs.toLowerCase() === toAbs.toLowerCase();
  return {
    from: raw,
    to,
    fromAbs,
    toAbs,
    caseOnly,
    noop: fromAbs === toAbs,
    ext,
  };
}
