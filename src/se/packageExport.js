// SE 体系配置包（.se.json）纯组装器（期 10 · D2）。
//
// 边界（SE体系配置包方案.md §2 / 期 10 计划 §3）：
// - 纯字符串组装：零 DOM / 零 fetch / 零 Node 内建（不 import node:path），浏览器与 Node 双端可导入；
// - 只产出 { manifest, files, warnings }，不落盘、不做并发控制（写序/互斥由 App 接线负责）；
// - 每个流恒产出兄弟文件（空内容也写 0 字节：SE check_existence 会剔除缺失 file_path 的流）；
// - tags 原样全带（含 canvas / edge.*，不过滤）；工具三路径经 portablePath 改写并记 warning；
// - 画布布局统一落 `system.graph.layout`（v5 单一载体）；旧包顶层 `ui.positions` 仅读端历史兼容。
//
// 期 0：路径 / 文件名 helper 已抽至 `src/se/paths.js`；本模块 import 后再导出，保持既有调用方零改名。

import { sanitizeStreamFilename, assignFilenames, portablePath } from './paths.js';
import { toStreamName, isValidStreamName, isValidToolName } from './nameContract.js';

export {
  sanitizeStreamFilename,
  assignFilenames,
  portablePath,
  manifestDirOf,
  packageNameFromPath,
} from './paths.js';

const MANIFEST_SCHEMA = 'snake-manifest-v1';
const GENERATOR = 'reactflow/se-package-v1';
const PACKAGE_VERSION = '1.0';
const TOOL_PATH_KEYS = ['tool_path', 'execution_path', 'manual_path'];

// ---- 组装 ----

/** tags 浅拷贝（原样全带，含 canvas / edge.*；非法结构 → {}）。 */
function cloneTags(tags) {
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return {};
  return { ...tags };
}

// ---- 画布布局（v5 单一载体 `system.graph.layout`）----

/** 合法坐标条目：x/y 均为有限数值。 */
function hasFiniteXy(v) {
  return (
    !!v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Number.isFinite(Number(v.x)) &&
    Number.isFinite(Number(v.y))
  );
}

/** manifest 流行 → 契约合规 SE name（与 packageImport.streamNameOf 同口径；本模块独立实现，避免循环依赖）。 */
function manifestStreamNameOf(rawStream) {
  if (!rawStream || typeof rawStream !== 'object') return '';
  const rawName = rawStream.name == null ? '' : String(rawStream.name);
  const rawTitle = rawStream.title == null ? '' : String(rawStream.title);
  if (rawName && isValidStreamName(rawName)) return rawName;
  if (rawTitle && isValidStreamName(rawTitle)) return rawTitle;
  const src = rawName || rawTitle;
  return src ? toStreamName(src) : '';
}

/** 旧位表（`system.graph.positions` / `ui.positions`）→ `{ [name]: {x,y} }`（仅 x/y；非法剔除，空 → null）。 */
function xyOnlyPositions(positions) {
  if (!positions || typeof positions !== 'object' || Array.isArray(positions)) return null;
  const out = {};
  for (const [key, v] of Object.entries(positions)) {
    if (hasFiniteXy(v)) out[String(key)] = { x: Number(v.x), y: Number(v.y) };
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 布局归一化：`{ [streamName]: {x,y,width?,height?} }`（非法项剔除，空 → null）。
 * x/y 必须为有限数值，否则整条剔除；width/height 仅保留有限正数（缺省即不写该键）。
 */
export function normalizeLayout(layout) {
  if (!layout || typeof layout !== 'object' || Array.isArray(layout)) return null;
  const out = {};
  for (const [key, v] of Object.entries(layout)) {
    if (!hasFiniteXy(v)) continue;
    const entry = { x: Number(v.x), y: Number(v.y) };
    const w = Number(v.width);
    const h = Number(v.height);
    if (Number.isFinite(w) && w > 0) entry.width = w;
    if (Number.isFinite(h) && h > 0) entry.height = h;
    out[String(key)] = entry;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 从 manifest 读画布布局（原始文本对象或 `parseManifest` 产物均可）。回退链：
 * 1. 新载体：`manifest.layout`（`parseManifest` 产物）或 `system.graph.layout`（含可选宽高）；
 * 2. 旧位：`system.graph.positions` 打底、`streams[].position` 条目覆盖（仅 x/y）；
 * 3. 旧包顶层 `ui.positions`（纯历史兼容，仅 x/y）。
 * 全缺/非法 → null。
 */
export function readManifestLayout(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
  const graph = manifest.system && typeof manifest.system === 'object' ? manifest.system.graph : null;
  const direct = normalizeLayout(manifest.layout) || normalizeLayout(graph && graph.layout);
  if (direct) return direct;
  const derived = xyOnlyPositions(graph && graph.positions) || {};
  for (const s of Array.isArray(manifest.streams) ? manifest.streams : []) {
    if (!s || typeof s !== 'object' || !hasFiniteXy(s.position)) continue;
    const name = manifestStreamNameOf(s);
    if (name) derived[name] = { x: Number(s.position.x), y: Number(s.position.y) };
  }
  if (Object.keys(derived).length) return derived;
  return xyOnlyPositions(manifest.ui && manifest.ui.positions);
}

/**
 * 组装 se-package-v1 配置包（不落盘）。
 *
 * @param {{displayName:string, streams?:Array, tools?:Array, layout?:object, positions?:object,
 *          baseDir?:string, savedAt?:string}} input
 *   streams 行：`{name,description,tags,content}`（stream.list + stream.read，name 为契约合法流名，含 CJK）；
 *   tools：ToolDefinition[]；layout：`{ [streamName]: {x,y,width?,height?} }`（`positions` 为旧调用名兼容）；
 *   savedAt：ISO 串（假值省略）。
 * @returns {{manifest:object, files:{relPath:string,text:string}[], warnings:string[]}}
 *   files 顺序：兄弟文本文件（输入流序）在前，manifest（提交点）最后；
 *   relPath 相对 manifest 所在目录、正斜杠；单条畸形流/工具 → 记 warning 跳过，不抛错。
 */
export function buildPackage(input = {}) {
  const {
    displayName,
    streams,
    tools,
    layout,
    positions,
    baseDir,
    savedAt,
    toolRewrites,
    copies,
  } = input || {};
  const name = String(displayName == null ? '' : displayName).trim() || '未命名系统';

  const warnings = [];
  const warningSeen = new Set();
  const pushWarning = (w) => {
    if (!w || warningSeen.has(w)) return;
    warningSeen.add(w);
    warnings.push(w);
  };

  const files = [];
  const streamRows = Array.isArray(streams) ? streams : [];
  const filenames = assignFilenames(streamRows);
  const manifestStreams = [];
  const seenStreams = new Set();
  for (const row of streamRows) {
    const streamName = row && typeof row === 'object' && row.name != null ? String(row.name) : '';
    if (!isValidStreamName(streamName)) {
      pushWarning(`流名缺失或非法（须字母/数字/下划线，含中文，不得以数字开头），已跳过：${streamName || '（空）'}`);
      continue;
    }
    if (seenStreams.has(streamName)) {
      pushWarning(`流 ${streamName} 重复，已跳过后者。`);
      continue;
    }
    seenStreams.add(streamName);
    const filename = filenames.get(streamName) || sanitizeStreamFilename(streamName);
    const relPath = `${name}.streams/${filename}`;
    manifestStreams.push({
      name: streamName,
      description: row.description == null ? '' : String(row.description),
      tags: cloneTags(row.tags),
      source: { file_path: relPath, encoding: 'utf-8' },
    });
    files.push({ relPath, text: row.content == null ? '' : String(row.content) });
  }

  const manifestTools = {};
  for (const def of Array.isArray(tools) ? tools : []) {
    const toolName = def && typeof def === 'object' && def.name != null ? String(def.name) : '';
    if (!isValidToolName(toolName)) {
      pushWarning(`工具名缺失或非法（须字母/数字/下划线，含中文，不得以数字开头），已跳过：${toolName || '（空）'}`);
      continue;
    }
    const entry = { ...def };
    const rewrite = toolRewrites && typeof toolRewrites === 'object' ? toolRewrites[toolName] : null;
    for (const key of TOOL_PATH_KEYS) {
      if (rewrite && Object.prototype.hasOwnProperty.call(rewrite, key)) {
        const value = rewrite[key];
        if (value == null || value === '') delete entry[key];
        else entry[key] = String(value);
        continue;
      }
      if (typeof def[key] !== 'string') continue;
      const ported = portablePath(def[key], baseDir);
      entry[key] = ported.value;
      pushWarning(ported.warning);
    }
    if (manifestTools[toolName]) pushWarning(`工具 ${toolName} 重复，后者覆盖前者。`);
    manifestTools[toolName] = entry;
  }

  const manifest = {
    $schema: MANIFEST_SCHEMA,
    id: name,
    namespace: name,
    generator: GENERATOR,
    package_version: PACKAGE_VERSION,
    version: PACKAGE_VERSION,
  };
  if (savedAt) manifest.saved_at = String(savedAt);
  manifest.streams = manifestStreams;
  manifest.tools = manifestTools;
  // 画布布局：单一载体 system.graph.layout（旧调用名 positions 兼容同一形状；空则不写）。
  const resolvedLayout = normalizeLayout(layout !== undefined ? layout : positions);
  if (resolvedLayout) {
    manifest.system = { graph: { format_version: '5.0', layout: resolvedLayout } };
  }

  // manifest 最后入列：调用方顺序写入时，兄弟文件先行、manifest 即提交点（对齐 Q5）。
  files.push({ relPath: `${name}.se.json`, text: JSON.stringify(manifest, null, 2) });
  return {
    manifest,
    files,
    warnings,
    copies: Array.isArray(copies) ? copies : [],
  };
}

/**
 * 从全量 stream/tool 中挑出选中子集（供单项/多项导出；纯函数）。
 * 缺省/空选择集 → 空数组；缺省/非数组输入 → 空数组；保持输入原序。
 *
 * @param {{streams?:Array, tools?:Array, streamNames?:Array, toolNames?:Array}} input
 * @returns {{streams:Array, tools:Array}}
 */
export function selectPackageInput({ streams, tools, streamNames, toolNames }) {
  const sSet = new Set((Array.isArray(streamNames) ? streamNames : []).map(String));
  const tSet = new Set((Array.isArray(toolNames) ? toolNames : []).map(String));
  return {
    streams: (Array.isArray(streams) ? streams : []).filter((s) => sSet.has(String(s && s.name))),
    tools: (Array.isArray(tools) ? tools : []).filter((t) => tSet.has(String(t && t.name))),
  };
}
