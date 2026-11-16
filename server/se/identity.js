// SE 存储身份层（唯一实现）：系统 id ↔ 真实 storage 目录名。
//
// 契约（详见 docs / 设计结论）：
// - system_id 保留大小写；ReactFlow 管理的系统必须满足
//   `system_id === se-systems 下的真实目录名`。Python 的 registry key、
//   registry/<sid>.pid、snapshots/<sid>、SNAKEEATS_SYSTEM_ID 都以它为身份。
// - Windows/macOS 文件系统大小写不敏感：`se` 与 `SE` 指向同一物理目录。
//   因此**分配**必须以 casefold 后的磁盘命名空间为准，**解析**必须先精确、
//   再唯一 casefold 命中；多命中 = ambiguity，禁止猜测。
// - create 用非递归 mkdir 做原子占位：EEXIST 即已存在（含大小写别名），
//   绝不读取/复用已有目录；这是“创建永不写入旧 storage”的 OS 级保证。
// - 本模块只做文件系统事实判定，不做 attach/reclaim/kill —— 存活权归
//   snakeeats 的 InstanceLock（见 process.js）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { seSystemsDir } from '../paths.js';
import { foldSystemId, sanitizeSystemId } from '../../shared/nameContract.js';
import { sanitizeSeSystemId } from './resolve.js';
import { withFsRetry } from '../resilientFs.js';

export { foldSystemId };

/**
 * 列出 storage 命名空间里的真实目录名（保留磁盘大小写）。
 * 读取失败（除 ENOENT）→ 抛 ENAMESPACE：调用方必须 fail closed，
 * 绝不能回退成“只看打开标签页”（那正是本 bug 的成因）。
 */
export function listStorageIds(dir = seSystemsDir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw Object.assign(new Error(`SE storage namespace unavailable: ${dir}`), {
      code: 'ENAMESPACE',
      cause: err,
    });
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => sanitizeSeSystemId(name) === name);
}

/**
 * 把请求 id 解析到真实目录：
 * - exact    : 精确命中（保留请求大小写）
 * - alias    : 唯一 casefold 命中，dirName 为磁盘真实大小写
 * - absent   : 命名空间内不存在
 * - ambiguous: 多个仅大小写不同的目录（Linux 可能；win/mac 不会）
 * - invalid  : 非法 id
 */
export function resolveStorageId(requested, dir = seSystemsDir) {
  const id = sanitizeSeSystemId(requested);
  if (!id) return { kind: 'invalid' };
  const ids = listStorageIds(dir);
  if (ids.includes(id)) return { kind: 'exact', dirName: id };
  const folded = foldSystemId(id);
  const matches = ids.filter((name) => foldSystemId(name) === folded);
  if (matches.length === 0) return { kind: 'absent' };
  if (matches.length > 1) return { kind: 'ambiguous', dirNames: matches };
  return { kind: 'alias', dirName: matches[0] };
}

/**
 * 原子占位：非递归 mkdir。
 * - 成功 = 该 id 在物理命名空间中由本次调用创建；
 * - EEXIST = 已存在（含大小写别名/空壳目录），调用方必须换候选或 fail closed。
 * 不读取、不清理、不判断内容——内容判定不属于 create 契约。
 */
export function claimStorageDir(systemId, dir = seSystemsDir) {
  const id = sanitizeSeSystemId(systemId);
  if (!id) return { ok: false, code: 'EINVAL' };
  const target = path.join(dir, id);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw Object.assign(new Error(`SE storage root unavailable: ${dir}`), {
      code: 'ENAMESPACE',
      cause: err,
    });
  }
  try {
    withFsRetry(() => fs.mkdirSync(target));
    return { ok: true, dir: target };
  } catch (err) {
    if (err && err.code === 'EEXIST') return { ok: false, code: 'EEXIST', dir: target };
    throw err;
  }
}

/** 回收本次 create/start 失败留下的空占位目录（仅当仍为空；best-effort）。 */
export function removeEmptyClaim(systemId, dir = seSystemsDir) {
  const id = sanitizeSeSystemId(systemId);
  if (!id) return false;
  const target = path.join(dir, id);
  try {
    if (fs.readdirSync(target).length !== 0) return false;
    withFsRetry(() => fs.rmdirSync(target));
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * create 专用：在磁盘命名空间内选一个 casefold 唯一的 id 并原子占位。
 * avoid 为前端打开标签页的 id（建议值，非权威；权威仍是 mkdir 的 EEXIST）。
 * 返回 { ok:true, systemId, dir } 或 { ok:false, code:'EEXIST' }。
 */
export function allocateAndClaim(base, avoid = [], dir = seSystemsDir) {
  const ids = listStorageIds(dir);
  const taken = new Set(
    [...ids, ...(Array.isArray(avoid) ? avoid : [])].map((id) => foldSystemId(id))
  );
  let stem = sanitizeSystemId(base) || '';
  if (!stem || stem === '.' || stem === '..') {
    stem = `se_${crypto.randomBytes(4).toString('hex')}`;
  }
  stem = stem.slice(0, 100);
  for (let n = 0; n < 1000; n += 1) {
    const candidate = n === 0 ? stem : `${stem}_${n + 1}`;
    if (taken.has(foldSystemId(candidate))) continue;
    const claimed = claimStorageDir(candidate, dir);
    if (claimed.ok) return { ok: true, systemId: candidate, dir: claimed.dir };
    // 竞态/别名：加入 taken 后继续下一候选（同一进程内同步执行，无回绕）。
    taken.add(foldSystemId(candidate));
  }
  return { ok: false, code: 'EEXIST' };
}
