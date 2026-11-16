// 配置包原子落盘：流正文 → 工具复刻（文件/目录） → manifest 最后写（提交点）。
//
// 设计约束：
// - 目标路径由调用方解析为绝对；本模块只做 IO，不做项目根解析。
// - 目录复刻默认排除构建/缓存/依赖目录；有文件数与字节上限（防把 venv/node_modules 搬进包）。
// - 符号链接一律跳过（不跟随出包，也不把链接本身复制成坏链）。
// - manifest 最后写：中途失败最多留下无 manifest 的残缺目录，不会产生“看起来完整”的坏包。
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync, withFsRetry } from './resilientFs.js';

const EXCLUDE_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.venv',
  'venv',
  'env',
  '.idea',
  '.vs',
  'dist',
  'build',
]);

const EXCLUDE_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const EXCLUDE_FILE_RE = /\.(pyc|pyo|tmp|log)$/i;

/** 目标是否在源目录内部（防“复制进自己”）。 */
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * @param {{files:Array<{path:string,text:string}>, copies:Array<{from:string,to:string,unit:'file'|'dir'}>,
 *          manifest:{path:string,text:string}, options?:{overwrite?:boolean,maxBytes?:number,maxFiles?:number}}} plan
 * @returns {{written:string[], copied:string[], skipped:string[], files:number, bytes:number}}
 */
export function applyPackagePlan(plan) {
  const opts = plan.options && typeof plan.options === 'object' ? plan.options : {};
  const overwrite = opts.overwrite !== false;
  const maxBytes = Number.isFinite(Number(opts.maxBytes)) && Number(opts.maxBytes) > 0
    ? Number(opts.maxBytes)
    : 200 * 1024 * 1024;
  const maxFiles = Number.isFinite(Number(opts.maxFiles)) && Number(opts.maxFiles) > 0
    ? Number(opts.maxFiles)
    : 5000;

  const out = { written: [], copied: [], skipped: [], files: 0, bytes: 0 };
  const budget = (size) => {
    out.files += 1;
    out.bytes += size;
    if (out.files > maxFiles) {
      throw Object.assign(new Error(`package too large: >${maxFiles} files`), { code: 'EPLANLIMIT' });
    }
    if (out.bytes > maxBytes) {
      throw Object.assign(new Error(`package too large: >${maxBytes} bytes`), { code: 'EPLANLIMIT' });
    }
  };

  const copyOne = (src, dst) => {
    const st = fs.lstatSync(src);
    if (st.isSymbolicLink()) {
      out.skipped.push(src);
      return;
    }
    if (st.isDirectory()) {
      if (isInside(src, dst)) {
        throw Object.assign(new Error(`refuse to copy directory into itself: ${src}`), { code: 'EPLANLIMIT' });
      }
      if (fs.existsSync(dst) && !overwrite) {
        throw Object.assign(new Error(`target exists: ${dst}`), { code: 'EEXIST' });
      }
      withFsRetry(() => fs.mkdirSync(dst, { recursive: true }));
      for (const name of fs.readdirSync(src)) {
        if (EXCLUDE_DIRS.has(name) || EXCLUDE_FILES.has(name) || EXCLUDE_FILE_RE.test(name)) {
          out.skipped.push(path.join(src, name));
          continue;
        }
        copyOne(path.join(src, name), path.join(dst, name));
      }
      return;
    }
    if (!st.isFile()) {
      out.skipped.push(src);
      return;
    }
    budget(st.size);
    if (fs.existsSync(dst) && !overwrite) {
      throw Object.assign(new Error(`target exists: ${dst}`), { code: 'EEXIST' });
    }
    withFsRetry(() => {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    });
  };

  // 1) 流正文（可覆盖；文本写入是幂等的）
  for (const f of Array.isArray(plan.files) ? plan.files : []) {
    if (!f || typeof f.path !== 'string' || !f.path) continue;
    atomicWriteFileSync(f.path, f.text == null ? '' : String(f.text));
    out.written.push(f.path);
  }

  // 2) 工具复刻
  for (const c of Array.isArray(plan.copies) ? plan.copies : []) {
    if (!c || typeof c.from !== 'string' || typeof c.to !== 'string') continue;
    if (!fs.existsSync(c.from)) {
      out.skipped.push(c.from);
      continue;
    }
    if (c.unit === 'dir') copyOne(c.from, c.to);
    else copyOne(c.from, c.to);
    out.copied.push(c.to);
  }

  // 3) manifest 最后写（提交点）
  const manifest = plan.manifest;
  if (!manifest || typeof manifest.path !== 'string' || !manifest.path) {
    throw Object.assign(new Error('manifest path required'), { code: 'EINVAL' });
  }
  atomicWriteFileSync(manifest.path, manifest.text == null ? '' : String(manifest.text));
  out.written.push(manifest.path);
  return out;
}
