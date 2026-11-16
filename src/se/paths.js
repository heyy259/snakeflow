// 浏览器侧路径/文本通道封装：纯函数真源在 shared/paths.js。
// 这里只补浏览器默认项目根与 fetch 读写通道，避免 server 依赖浏览器模块。
import { errMessage } from './util.js';
import { getProjectRoot } from './projectRoot.js';
import {
  isGraphsDocPath as isGraphsDocPathAt,
  canonDocPath as canonDocPathAt,
  manifestAbsDirOf as manifestAbsDirOfAt,
  resolveSiblingPath,
  stripBom,
} from '../../shared/paths.js';

export * from '../../shared/paths.js';

export function isGraphsDocPath(docPath, projectRoot = getProjectRoot()) {
  return isGraphsDocPathAt(docPath, projectRoot);
}

export function canonDocPath(p, projectRoot = getProjectRoot()) {
  return canonDocPathAt(p, projectRoot);
}

export function manifestAbsDirOf(manifestPath, projectRoot = getProjectRoot()) {
  return manifestAbsDirOfAt(manifestPath, projectRoot);
}

export async function readFsText(filePath) {
  const res = await fetch('/api/fs/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath }),
  });
  let data = null;
  try {
    data = await res.json();
  } catch (err) {
    data = null;
  }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data && data.text != null ? String(data.text) : '';
}

export async function writeFsText(filePath, text, atomic = true) {
  const res = await fetch('/api/fs/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, text: text == null ? '' : String(text), atomic: !!atomic }),
  });
  let data = null;
  try {
    data = await res.json();
  } catch (err) {
    data = null;
  }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

export async function writePackageFiles(files, manifestPath, writeFile) {
  const write = typeof writeFile === 'function' ? writeFile : writeFsText;
  const dir = String(manifestPath || '').split(/[\\/]/).slice(0, -1).join('/');
  const list = Array.isArray(files) ? files : [];
  for (const f of list) {
    if (!f || typeof f.relPath !== 'string' || f.relPath === '') continue;
    const isManifest = f.relPath.toLowerCase().endsWith('.se.json');
    const target = isManifest ? String(manifestPath) : (dir ? `${dir}/${f.relPath}` : f.relPath);
    await write(target, f.text == null ? '' : String(f.text));
  }
}

function sourceFilePath(source) {
  const fp = source && typeof source === 'object' && source.file_path != null ? String(source.file_path).trim() : '';
  return fp ? fp.replace(/\\/g, '/') : '';
}

export async function readContentRef(source, opts = {}) {
  const fp = sourceFilePath(source);
  if (!fp) return { state: 'missing', text: '', path: '' };
  const basePath = opts && opts.basePath;
  const target = basePath ? resolveSiblingPath(basePath, fp) : fp;
  const read = opts && typeof opts.readFile === 'function' ? opts.readFile : readFsText;
  try {
    const raw = await read(target);
    return { state: 'loaded', text: stripBom(raw), path: target };
  } catch (err) {
    return { state: 'missing', text: '', path: target, error: errMessage(err) };
  }
}
