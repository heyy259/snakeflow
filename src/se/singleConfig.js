// 单边配置"导入文本 → 实体"识别（纯函数，零 IO / 零 DOM ⇒ 浏览器与 Node 双端可导入）。
//
// 统一方向（丢弃私有格式）：工具/流的单文件配置一律为 snake-manifest-v1 `.se.json`。
// 旧私有格式（`.tool.json`、frontmatter `.md`）在此被**显式拒绝**（彻底破）。
import { parseManifest } from './packageImport.js';

/**
 * 工具配置包文本 → 单个工具定义。
 * `.se.json`（含 `tools`）→ `{ ok:true, tool }`（取第一个工具，dict 缺 name 已由 parseManifest 注入键名）；
 * 旧 `.tool.json` / 无 `tools` 键 / 非 JSON → `{ ok:false, error }`。
 * @param {string} text
 * @returns {{ok:true, tool:object}|{ok:false, error:string}}
 */
export function parseToolImport(text) {
  let obj;
  try {
    obj = JSON.parse(String(text == null ? '' : text));
  } catch (err) {
    return { ok: false, error: `JSON 解析失败：${(err && err.message) || err}` };
  }
  if (obj && obj.$schema === 'reactflow/tool-file-v1') {
    return { ok: false, error: '旧 .tool.json 已废弃，请改用 .se.json 工具配置包' };
  }
  let manifest;
  try {
    manifest = parseManifest(obj);
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
  const defs = Array.isArray(manifest.tools) ? manifest.tools : [];
  if (!defs.length) return { ok: false, error: '该文件不含工具（应为含 tools 的 .se.json 配置包）' };
  return { ok: true, tool: defs[0] };
}

/**
 * 流导入文件分类（纯函数，零 IO）。
 * - `.se.json` → `{ kind:'manifest' }`（调用方需再 parseManifest + fetchStreamContents）；
 * - 旧 frontmatter `.md`（含 `reactflow/stream-file-v1`）→ `{ kind:'legacy' }`（报错）；
 * - 其余（纯 `.md`/文本）→ `{ kind:'raw', name, content }`（正文 + 文件名派生名）。
 * @param {string} filePath
 * @param {string} text
 * @returns {{kind:'manifest'}|{kind:'legacy'}|{kind:'raw', name:string, content:string}}
 */
export function classifyStreamImport(filePath, text) {
  if (/\.se\.json$/i.test(String(filePath || ''))) return { kind: 'manifest' };
  const t = String(text == null ? '' : text);
  if (/^---\s*\r?\n[\s\S]*?reactflow\/stream-file-v1/.test(t)) return { kind: 'legacy' };
  const base = String(filePath || '').split(/[\\/]/).pop() || '';
  return { kind: 'raw', name: base.replace(/\.[^.]+$/, ''), content: t };
}

/**
 * 已解析 manifest + 正文 Map → 第一个流的完整实体。
 * 返回含 `source`（流正文引用，可能为 null）：调用方用 `resolveSiblingPath(清单路径, source.file_path)`
 * 解析为绝对路径后挂到节点 `data.source`，使自动保存写回真实路径（外部文档写回改造）。
 * @param {object} manifest `parseManifest` 的产物
 * @param {Map<string,string>} [contents] `fetchStreamContents` 的产物（按 name 取正文）
 * @returns {{ok:true, name:string, content:string, description:string, tags:object, source:object|null}|{ok:false, error:string}}
 */
export function streamFromManifest(manifest, contents) {
  const streams = Array.isArray(manifest && manifest.streams) ? manifest.streams : [];
  if (!streams.length) return { ok: false, error: '该 .se.json 不含流' };
  const s = streams[0];
  const name = s.name != null ? String(s.name) : '';
  const inline = s.content != null ? String(s.content) : '';
  const fromMap = contents && typeof contents.get === 'function' ? contents.get(name) : undefined;
  const source =
    s.source && typeof s.source === 'object' && s.source.file_path
      ? {
          file_path: String(s.source.file_path).replace(/\\/g, '/'),
          encoding: s.source.encoding ? String(s.source.encoding) : 'utf-8',
        }
      : null;
  return {
    ok: true,
    name,
    content: fromMap != null ? fromMap : inline,
    description: s.description != null ? String(s.description) : '',
    tags: s.tags && typeof s.tags === 'object' && !Array.isArray(s.tags) ? s.tags : {},
    source,
  };
}
