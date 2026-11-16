// Windows/OneDrive 韧性 FS 原语（纯函数，零 __dirname 依赖 ⇒ scripts/ 可直接 import，
// 替代 migrate-local-nodes.mjs / se-reclaim.mjs / se-cleanup.mjs 中的镜像复制）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** renameSync + Windows/OneDrive 偶发 EPERM/EBUSY 短重试。 */
export function renameSyncWithRetry(src, dst) {
  let lastErr = null;
  for (let i = 0; i < 5; i += 1) {
    try {
      fs.renameSync(src, dst);
      return;
    } catch (err) {
      lastErr = err;
      if (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES') throw err;
      const until = Date.now() + 20 * (i + 1);
      while (Date.now() < until) { /* 短暂退避重试 */ }
    }
  }
  throw lastErr;
}

// OneDrive 对新建文件短暂持锁（扫描上传），EIO 不在 rmSync/cpSync 内建重试码内；
// 锁窗长达数秒（renameSyncWithRetry 的毫秒级预算不够）→ copy/delete 用带验证的长退避重试。
const FS_LOCK_RETRY_CODES = new Set(['EIO', 'EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);

/** 带退避的同步 fs 重试：仅对 OneDrive 锁类错误码重试，其余原样抛。 */
export function withFsRetry(fn, tries = 8) {
  let lastErr = null;
  for (let i = 0; i < tries; i += 1) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      if (!FS_LOCK_RETRY_CODES.has(err && err.code)) throw err;
      const until = Date.now() + 150 * (i + 1);
      while (Date.now() < until) { /* 退避 */ }
    }
  }
  throw lastErr;
}

/** 递归复制（文件/目录）：手工遍历 + 逐层重试（fs.cpSync 在 OneDrive 上 mkdir 目标即 EIO）。 */
export function copyRecursiveWithRetry(src, dst) {
  if (fs.statSync(src).isDirectory()) {
    withFsRetry(() => fs.mkdirSync(dst, { recursive: true }));
    for (const name of fs.readdirSync(src)) {
      copyRecursiveWithRetry(path.join(src, name), path.join(dst, name));
    }
    return;
  }
  withFsRetry(() => fs.copyFileSync(src, dst));
}

/** 同步退避（不阻塞事件循环之外的东西；scripts/ 与 server 共用）。 */
function sleepSync(ms) {
  if (!(ms > 0)) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (err) {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* 无 SharedArrayBuffer 时的自旋兜底 */ }
  }
}

/** 路径存在性：existsSync 是主判据；lstat 兜底悬空符号链接（existsSync 会跟随而误报不存在）。 */
function pathPresent(target) {
  if (fs.existsSync(target)) return true;
  try {
    fs.lstatSync(target);
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * 单次手工删除：lstat + dirent 遍历，绝不跟随目录符号链接。
 * 目标本身是符号链接 → 直接 unlink（不进入链接目标）。
 */
function removeEntryOnce(target, recursive) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
  if (!stat.isDirectory()) {
    fs.unlinkSync(target);
    return;
  }
  if (!recursive) throw Object.assign(new Error('recursive required'), { code: 'ERRDIR' });

  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
  for (const ent of entries) {
    const child = path.join(target, ent.name);
    if (ent.isSymbolicLink()) {
      // 目录链接 / junction 一律当文件删，绝不递归进入链接目标。
      fs.unlinkSync(child);
    } else if (ent.isDirectory()) {
      removeEntryOnce(child, true);
    } else if (ent.isFile()) {
      fs.unlinkSync(child);
    } else {
      // 文件系统未提供 d_type 时按 lstat 再判一次。
      removeEntryOnce(child, true);
    }
  }
  fs.rmdirSync(target);
}

/**
 * 递归删除（唯一安全删除原语）。
 *
 * 背景：本机 Node v24.12 的 fs.rmSync 对非 ASCII 祖先静默 no-op，对非 ASCII basename
 * 甚至可能 0xC0000409 崩溃；unlinkSync/rmdirSync 正常。OneDrive 持锁还会"返回成功却留残"，
 * 故每次删除后都用 existsSync（+ lstat 兜底）验证。
 *
 * @param {string} target 文件或目录
 * @param {boolean|object} [options]
 *   - boolean：兼容旧签名，等价 `{ recursive: boolean }`
 *   - recursive   默认 true；false 时目录抛 ERRDIR（/api/fs/delete 严格语义）
 *   - bestEffort  默认 false；true 时绝不抛错，返回是否删净
 *   - tries       默认 8；对 EIO/EPERM/EBUSY/EACCES/ENOTEMPTY 退避重试
 *   - cmdFallback 默认 false；win32 残留时额外尝试 `cmd /c rmdir /s /q`
 * @returns {boolean} 是否确认删净（严格模式失败会抛错）
 */
export function removeRecursiveWithRetry(target, options) {
  const opts = typeof options === 'boolean' ? { recursive: options } : (options && typeof options === 'object' ? options : {});
  const recursive = opts.recursive !== false;
  const bestEffort = !!opts.bestEffort;
  const tries = Number.isInteger(opts.tries) && opts.tries > 0 ? opts.tries : 8;
  const cmdFallback = !!opts.cmdFallback;

  for (let i = 0; i < tries; i += 1) {
    try {
      removeEntryOnce(target, recursive);
    } catch (err) {
      if (!FS_LOCK_RETRY_CODES.has(err && err.code)) {
        if (!bestEffort) throw err;
        break;
      }
    }
    if (!pathPresent(target)) return true;
    if (i < tries - 1) sleepSync(150 * (i + 1));
  }

  if (cmdFallback && recursive && process.platform === 'win32' && pathPresent(target)) {
    try {
      spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', target], { stdio: 'ignore', windowsHide: true });
    } catch (err) {
      /* best-effort 兜底；结果仍由下方 postcondition 决定 */
    }
  }

  if (!pathPresent(target)) return true;
  if (bestEffort) return false;
  throw Object.assign(new Error('delete incomplete (file locked by sync client)'), { code: 'EBUSY' });
}

/**
 * 原子写文本（tmp + rename）；Windows/OneDrive 偶发 EPERM/EBUSY 时短重试，最终回退直接写。
 * 回退牺牲原子性但保证写入落地（配置=提交点，宁可非原子也不能丢写）。
 */
export function atomicWriteFileSync(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, 'utf-8');
  try {
    renameSyncWithRetry(tmp, file);
  } catch (err) {
    try {
      fs.writeFileSync(file, text, 'utf-8');
      removeFileBestEffort(tmp);
    } catch (err2) {
      throw err || err2;
    }
  }
}

/**
 * 删文件（best-effort）。复用唯一安全删除原语，绝不调用 fs.rmSync
 * （本机 Node v24.12 对文件 rmSync 是静默 no-op，见 run-se-suite.mjs 环境缺陷说明）。
 */
export function removeFileBestEffort(file) {
  try {
    removeRecursiveWithRetry(file, { recursive: false, bestEffort: true });
  } catch (err) {
    /* 清理路径绝不能影响主流程 */
  }
}
