// SE 体系配置包（.se.json）导入器：期 2 最小导入 + 期 11 计划/应用两段式。
//
// 边界（SE接线方案.md §5.5 / SE体系配置包方案.md §4 / 期 11 计划 §3）：
// - `planImport`：纯分类器（零 IO）——new/update/unchanged、tags 差量、保留键分桶、预测悬空边；
// - `applyImport`：逐项容错执行（call 注入）——策略 overwrite/skip、Q9 幂等（内容不变跳过写、
//   不传 expected_version）、保留键差量需确认、单项失败记 errors 且继续；
// - `fetchStreamContents`：内联 content 优先，否则读兄弟 `.streams/<file>`（readFile 可注入）；
//   缺失记 `missing`，**绝不静默建空**；`source.encoding` 非 UTF-8 兼容记 warning（B1 修复核心）；
// - `loadManifestFile`：`/api/fs/read` 原始文本通道 + 去 BOM + JSON.parse（Q1 / B3）；
// - 零 DOM / 零 Node 内建（浏览器与 Node 双端可导入）；IO 全部经 `call` / `readFile` 注入。

import { diffTags, edgeTagTarget, isReservedTagKey } from './tagOps.js';
import {
  resolveSiblingPath,
  readFsText,
  stripBom,
  manifestAbsDirOf,
} from './paths.js';
import { toStreamName, isValidStreamName, isValidToolName } from './nameContract.js';
// 工具注册参数白名单：配置包内工具可能携带前端私有字段（insert_template），发往 SE 前必须裁剪。
import { buildRegisterParams } from './toolParams.js';
import { errMessage, isPlainObject } from './util.js';
import {
  replaceRegisteredTool,
  isAlreadyExistsError,
  throwIfFailure,
  absoluteToolPathError,
} from './toolReplace.js';
// 布局读取（v5 单一载体 `system.graph.layout` + 旧位回退链）在 packageExport 侧集中实现。
import { readManifestLayout } from './packageExport.js';

// 期 0：`resolveSiblingPath` / `readFsText` / BOM 剥离已抽至 `src/se/paths.js`。
// 再导出 `resolveSiblingPath`，保持既有调用方（App / 单测）零改名。
export { resolveSiblingPath };

/** 兄弟文件可安全按 UTF-8 读取的编码声明（ASCII 是 UTF-8 子集）。 */
const UTF8_COMPATIBLE_ENCODINGS = new Set(['utf-8', 'utf8', 'utf-8-sig', 'utf8-sig', 'ascii', 'us-ascii']);

/** manifest 流行 → 契约合规 SE name（name 优先；非法则规范化；缺省回退 title；全缺 → ''）。 */
function streamNameOf(rawStream) {
  if (!rawStream || typeof rawStream !== 'object') return '';
  const rawName = rawStream.name == null ? '' : String(rawStream.name);
  const rawTitle = rawStream.title == null ? '' : String(rawStream.title);
  if (rawName && isValidStreamName(rawName)) return rawName;
  if (rawTitle && isValidStreamName(rawTitle)) return rawTitle;
  const src = rawName || rawTitle;
  return src ? toStreamName(src) : '';
}

/**
 * 解析 .se.json manifest（snake-manifest-v1 超集）。
 * 非法结构抛错；返回规范化 `{ schema, id, streams, tools, layout }`。
 * `layout`：画布布局单一载体 `{ [流名]: {x,y,width?,height?} }`（非法值剔除，全缺 → null）——
 * 优先 `system.graph.layout`，回退 `system.graph.positions` + `streams[].position`（条目优先），
 * 再回退旧包顶层 `ui.positions`（纯历史兼容，只读 x/y）；不再产出/依赖 `manifest.ui`。
 *
 * B2 修复：`tools` 为 dict 时，工具体缺 `name` 以 key 注入（外部手写/精简 manifest 兼容）。
 * 对 parseManifest 的输出幂等（可重复调用）。
 */
export function parseManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('配置包不是有效 JSON 对象');
  }
  const schema = raw.$schema != null ? String(raw.$schema) : '';
  if (schema && schema !== 'snake-manifest-v1') {
    throw new Error(`不支持的配置包 schema：${schema}`);
  }
  const streams = Array.isArray(raw.streams) ? raw.streams : [];
  const toolsRaw = raw.tools;
  const tools = [];
  if (Array.isArray(toolsRaw)) {
    tools.push(...toolsRaw);
  } else if (toolsRaw && typeof toolsRaw === 'object') {
    for (const [key, def] of Object.entries(toolsRaw)) {
      if (def && typeof def === 'object' && !Array.isArray(def)) {
        const name = def.name == null ? '' : String(def.name).trim();
        tools.push(name ? def : { ...def, name: String(key) });
      } else {
        tools.push(def);
      }
    }
  }
  if (!streams.length && !tools.length) {
    throw new Error('配置包内既无 streams 也无 tools');
  }
  // 位置 schema 归一化（布局修复）：产出 `layout`（回退链见 readManifestLayout）——
  // 自动保存产出的配置（buildDocument / buildPackage）只写 `system.graph.layout`；
  // 若无此归一化，「从配置包创建」会因 hasPositions=false 丢失全部布局。
  const layout = readManifestLayout(raw);
  return {
    schema: schema || 'snake-manifest-v1',
    id: raw.id != null ? String(raw.id) : '',
    streams,
    tools,
    layout,
  };
}

/** 提取 manifest 中每条流的真实 source 引用（相对 manifest 目录；绝对原样）。 */
export function collectManifestSources(manifest) {
  const out = new Map();
  for (const raw of Array.isArray(manifest?.streams) ? manifest.streams : []) {
    const name = streamNameOf(raw);
    const fp = raw?.source?.file_path;
    if (!name || !fp) continue;
    out.set(name, {
      file_path: String(fp).replace(/\\/g, '/'),
      encoding: raw.source.encoding ? String(raw.source.encoding) : 'utf-8',
    });
  }
  return out;
}

/** “已存在”类错误判定（stream.create / tool.register 幂等回灌容错）。 */
function isAlreadyExists(err) {  const code = err && err.code;
  const kind = err && err.data && err.data.kind;
  return code === -33002 || kind === 'already-exists';
}

/** 归一化为查找表（Map 原样；普通对象按字符串键转换；其余 → 空表）。 */
function asLookup(value) {
  if (value instanceof Map) return value;
  const out = new Map();
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) out.set(String(k), v);
  }
  return out;
}

/** 归一化为「字符串 → 字符串」表（null/undefined → ''；用于 contents / existingContents）。 */
function asTextMap(value) {
  const out = new Map();
  for (const [k, v] of asLookup(value)) out.set(k, v == null ? '' : String(v));
  return out;
}

/**
 * 读取 .se.json 文件（Q1 / B3）：`/api/fs/read` + 去 BOM + `JSON.parse` + `parseManifest`。
 * 返回 `{ path, manifest }`；失败抛错。`readFile` 可注入（默认走 /api/fs/read fetch）。
 *
 * @param {string} filePath manifest 绝对路径
 * @param {(path:string)=>Promise<string>} [readFile] 原始文本读取通道（测试注入）
 */
export async function loadManifestFile(filePath, readFile) {
  const read = typeof readFile === 'function' ? readFile : readFsText;
  const rawText = await read(filePath);
  const text = stripBom(rawText);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`配置包 JSON 解析失败：${errMessage(err)}`);
  }
  return { path: filePath, manifest: parseManifest(parsed) };
}

/**
 * 读取 manifest 内全部流的正文（期 11 · B1 修复核心）：
 * - 内联 `content` 优先（即使空串也为「有内容」）；
 * - 否则读 `resolveSiblingPath(manifestPath, source.file_path)`（readFile 可注入）；
 * - `file_path` 缺失/为空、或读取失败 → 记入 `missing`（**绝不静默建空**）；
 * - `source.encoding` 存在且非 UTF-8 兼容 → warning（仍按 UTF-8 尝试读取）。
 *
 * @param {{manifest:object, manifestPath:string, readFile?:(path:string)=>Promise<string>}} input
 * @returns {Promise<{contents:Map<string,string>, missing:string[], warnings:string[]}>}
 */
export async function fetchStreamContents({ manifest, manifestPath, readFile } = {}) {
  const parsed = parseManifest(manifest);
  const read = typeof readFile === 'function' ? readFile : readFsText;
  const contents = new Map();
  const missing = [];
  const warnings = [];
  const seen = new Set();

  for (const rawStream of parsed.streams) {
    if (!rawStream || typeof rawStream !== 'object') continue;
    const name = streamNameOf(rawStream);
    if (!name || seen.has(name)) continue;
    seen.add(name);

    if (rawStream.content != null) {
      contents.set(name, String(rawStream.content));
      continue;
    }

    const source = rawStream.source && typeof rawStream.source === 'object' ? rawStream.source : null;
    const relPath = source && source.file_path != null ? String(source.file_path).trim() : '';
    if (!relPath) {
      missing.push(name);
      warnings.push(`流 ${name}：manifest 未提供内联 content 与 source.file_path，正文缺失。`);
      continue;
    }
    const encoding = source.encoding != null ? String(source.encoding).trim().toLowerCase() : '';
    if (encoding && !UTF8_COMPATIBLE_ENCODINGS.has(encoding)) {
      warnings.push(`流 ${name}：source.encoding=${source.encoding} 非 UTF-8 兼容，按 UTF-8 读取可能乱码。`);
    }
    const siblingPath = resolveSiblingPath(manifestPath, relPath);
    try {
      const text = await read(siblingPath);
      contents.set(name, text == null ? '' : String(text));
    } catch (err) {
      missing.push(name);
      warnings.push(`流 ${name}：兄弟文件读取失败（${siblingPath || relPath}）：${errMessage(err)}`);
    }
  }

  return { contents, missing, warnings };
}

/**
 * 纯导入计划器（期 11 · Q10）：逐流分类 `new/update/unchanged`，算 tags 差量 / 保留键分桶 /
 * 元数据变更标记 / 预测悬空边；逐工具分类 + `pathMissing`。零 IO、无副作用。
 *
 * 约定：
 * - 「不变」仅在提供 `existingContents`（服务端正文）时精确；否则已存在项一律 `update`（§3.2）；
 * - `tagDiff` 朝向 = `diffTags(manifestTags, serverTags)`（把服务端变成包）；
 * - `reservedRemovals`/`reservedAdds` 仅对已存在流计算（新建流的 tags 由 create 一次性写入）；
 * - `statResults` 按**工具名**索引（值 bool 或 `{exists}`），驱动 `pathMissing`；
 * - `selection` 缺省/非数组 → 全选；显式空数组 → 全不选（对话框传来的即最终选择）。
 *
 * @param {{manifest:object, contents?:Map|object, existingStreams?:Array, existingTools?:Array,
 *          existingContents?:Map|object, statResults?:Map|object, selection?:{streamNames?:string[],toolNames?:string[]}}} input
 * @returns {{streams:Array, tools:Array, predictedDangling:Array, warnings:string[]}}
 */
export function planImport({
  manifest,
  contents,
  existingStreams,
  existingTools,
  existingContents,
  statResults,
  selection,
} = {}) {
  const parsed = parseManifest(manifest);
  const contentMap = asTextMap(contents);
  const existingContentMap = asTextMap(existingContents);
  const statMap = asLookup(statResults);

  const existingStreamMap = new Map();
  for (const row of Array.isArray(existingStreams) ? existingStreams : []) {
    if (row && row.name != null && row.name !== '') existingStreamMap.set(String(row.name), row);
  }
  const existingToolSet = new Set();
  for (const row of Array.isArray(existingTools) ? existingTools : []) {
    const n = row && typeof row === 'object' ? row.name : row;
    if (n != null && n !== '') existingToolSet.add(String(n));
  }
  const streamSelection = selection && Array.isArray(selection.streamNames)
    ? new Set(selection.streamNames.map(String))
    : null;
  const toolSelection = selection && Array.isArray(selection.toolNames)
    ? new Set(selection.toolNames.map(String))
    : null;

  const warnings = [];
  const streams = [];
  const tagsByName = new Map();
  const selectedStreamNames = new Set();
  const packageStreamNames = new Set();

  for (const rawStream of parsed.streams) {
    if (!rawStream || typeof rawStream !== 'object') continue;
    const name = streamNameOf(rawStream);
    if (!name) {
      warnings.push(`流缺少合法 name/title，已跳过：${JSON.stringify(rawStream).slice(0, 80)}`);
      continue;
    }
    if (packageStreamNames.has(name)) {
      warnings.push(`流 ${name} 在包内重复，已跳过后者。`);
      continue;
    }
    packageStreamNames.add(name);

    const description = rawStream.description == null ? '' : String(rawStream.description);
    const tags = rawStream.tags && typeof rawStream.tags === 'object' && !Array.isArray(rawStream.tags)
      ? rawStream.tags
      : {};
    tagsByName.set(name, tags);

    const existing = existingStreamMap.get(name) || null;
    const selected = streamSelection ? streamSelection.has(name) : true;
    if (selected) selectedStreamNames.add(name);

    const hasContent = contentMap.has(name);
    const content = hasContent ? contentMap.get(name) : '';
    const contentMissing = !hasContent;
    const existingContent = existingContentMap.has(name) ? existingContentMap.get(name) : null;

    const tagDiff = existing ? diffTags(tags, existing.tags) : diffTags(tags, {});
    const setKeys = Object.keys(tagDiff.set);
    const reservedRemovals = existing ? tagDiff.remove.filter(isReservedTagKey) : [];
    const reservedAdds = existing ? setKeys.filter(isReservedTagKey) : [];

    // v3：单一 name（显示名 = SE name）；不再有 title 变更通道。
    const descriptionChanged = !!existing
      && String(existing.description == null ? '' : existing.description) !== description;

    let contentChanged;
    if (!existing) contentChanged = hasContent;
    else if (!hasContent) contentChanged = false; // 正文缺失：无可写内容（不静默清空）
    else if (existingContent != null) contentChanged = existingContent !== content;
    else contentChanged = true; // 未提供服务端正文：保守视为变更（§3.2）

    const tagUnchanged = setKeys.length === 0 && tagDiff.remove.length === 0;
    const state = !existing
      ? 'new'
      : (existingContent != null && !contentChanged && !descriptionChanged && tagUnchanged)
        ? 'unchanged'
        : 'update';

    if (contentMissing) {
      warnings.push(`流 ${name}：正文缺失（内联 content 与兄弟文件均不可得），导入时不会创建空正文。`);
    }

    streams.push({
      name,
      state,
      selected,
      contentMissing,
      contentChanged,
      descriptionChanged,
      tagDiff,
      reservedRemovals,
      reservedAdds,
    });
  }

  const tools = [];
  for (const rawDef of parsed.tools) {
    if (!rawDef || typeof rawDef !== 'object') {
      warnings.push(`工具条目非法，已跳过：${JSON.stringify(rawDef).slice(0, 80)}`);
      continue;
    }
    const name = String(rawDef.name == null ? '' : rawDef.name).trim();
    if (!name) {
      warnings.push(`工具缺少合法 name，已跳过：${JSON.stringify(rawDef).slice(0, 80)}`);
      continue;
    }
    if (!isValidToolName(name)) {
      warnings.push(`工具名非法（须字母/数字/下划线，含中文，不得以数字开头），已跳过：${name}`);
      continue;
    }
    const state = existingToolSet.has(name) ? 'update' : 'new'; // 工具无内容可比 → 不存在 unchanged
    const selected = toolSelection ? toolSelection.has(name) : true;
    let pathMissing = false;
    if (statMap.has(name)) {
      const st = statMap.get(name);
      pathMissing = st === false || (st != null && typeof st === 'object' && st.exists === false);
    }
    // 与流同一套缺失语义：包内相对路径缺失 = 坏包（默认跳过）；
    // 外部绝对路径缺失 = 允许（接收方自带），仅提示。
    const declaredPath = typeof rawDef.tool_path === 'string' ? rawDef.tool_path.trim() : '';
    const declaredAbs =
      /^[A-Za-z]:[\\/]/.test(declaredPath) || declaredPath.startsWith('//') || declaredPath.startsWith('/');
    tools.push({
      name,
      state,
      selected,
      pathMissing,
      pathMissingKind: pathMissing ? (declaredAbs ? 'absolute' : 'relative') : null,
    });
  }

  // 预测悬空边（Q8）：目标 ∉（已存在流名 ∪ 选中包内流名），或目标名非法。
  const availableTargets = new Set(existingStreamMap.keys());
  for (const n of selectedStreamNames) availableTargets.add(n);
  const predictedDangling = [];
  const seenDangling = new Set();
  for (const row of streams) {
    if (!row.selected) continue;
    const tags = tagsByName.get(row.name) || {};
    for (const [key, value] of Object.entries(tags)) {
      const target = edgeTagTarget(key);
      if (target == null || target === '') continue;
      if (availableTargets.has(target) && isValidStreamName(target)) continue;
      const id = `${row.name}__${target}`;
      if (seenDangling.has(id)) continue;
      seenDangling.add(id);
      predictedDangling.push({ source: row.name, target, label: value == null ? '' : String(value) });
    }
  }

  return { streams, tools, predictedDangling, warnings };
}

/**
 * 保留键差量汇总（期 12 · D6/Q6）：仅统计**当前已选**流上的 `reservedRemovals`/`reservedAdds`。
 * 未选行的保留键差量不应触发确认门——`applyImport` 只作用于 `row.selected`，否则确认框会
 * 误报（未选流逼出 `confirmReserved` 勾选）。纯函数、零 IO；缺失/非数组输入一律容错为空。
 *
 * @param {Array<{name:string, reservedRemovals?:string[], reservedAdds?:string[]}>} streamRows `planImport` 的 `plan.streams`
 * @param {string[]} selectedNames 当前勾选的流 name
 * @returns {{removals:Array<{stream:string,key:string}>, adds:Array<{stream:string,key:string}>}}
 */
export function reservedDeltaSummary(streamRows, selectedNames) {
  const selected = new Set((Array.isArray(selectedNames) ? selectedNames : []).map(String));
  const removals = [];
  const adds = [];
  for (const row of Array.isArray(streamRows) ? streamRows : []) {
    if (!row || !selected.has(String(row.name))) continue;
    for (const key of Array.isArray(row.reservedRemovals) ? row.reservedRemovals : []) {
      removals.push({ stream: row.name, key });
    }
    for (const key of Array.isArray(row.reservedAdds) ? row.reservedAdds : []) {
      adds.push({ stream: row.name, key });
    }
  }
  return { removals, adds };
}

/**
 * 悬空边预警过滤（期 12 · D6/Q6）：只保留「源已选且目标未选」的预测悬空边。
 * - 源未选 → 该边不会被导入，不算预警；
 * - 目标已选 → 随包内新建而存在，不再悬空。
 * 与 `planImport` 的初始 `predictedDangling` 配合，随选区实时收窄（纯展示，不 gate）。
 *
 * @param {Array<{source:string,target:string,label?:string}>} dangling
 * @param {string[]} selectedNames 当前勾选的流 name
 * @returns {Array<{source:string,target:string,label?:string}>}
 */
export function filterPredictedDangling(dangling, selectedNames) {
  const selected = new Set((Array.isArray(selectedNames) ? selectedNames : []).map(String));
  return (Array.isArray(dangling) ? dangling : []).filter(
    (d) => d && selected.has(String(d.source)) && !selected.has(String(d.target))
  );
}

/**
 * 逐项容错执行导入计划（期 11 · §3.3 / Q4 / Q5 / Q9）：
 * - new：`stream.create{name,description?,tags?}` + 正文非空才 `stream.write`（有 create.version 时传 expected_version）；
 * - update + overwrite：`contentChanged` 才 `stream.write`（全量，不传 expected_version）；
 *   `descriptionChanged` → `stream.update_description{name,text}`；
 *   tagDiff 逐条 `set_tag`/`remove_tag`（直调，绕开 updateStreamMeta 的保留键过滤）；
 * - casVersions（可选）：update 分支 stream.write 携带 expected_version；冲突（-32010）
 *   不算 failed——记 warning 并保留 SE 版本（不重试，有界）；
 * - protectNonempty（可选，bindSystem 重建导入专用）：包内空正文绝不写 SE
 *   （0 字节 sibling 是合法包内容，但用它覆盖 SE 实存内容 = 正文丢失事故）。
 * - createOnly（可选）：仅允许“新建”。流/工具的 update 行直接失败且零写入/零替换；
 *   create/register 撞 already-exists 也失败（不退化 update、不 unregister、不替换）；
 *   缺省 false 完全保持显式导入/覆盖语义。
 * - update + skip：不动；unchanged：不动（Q9 真幂等）；
 * - 保留键差量仅在 `confirmReserved` 为 true 时应用，否则跳过并记 `warnings`；
 * - 工具：new → `tool.register(def)`；update → `tool.unregister{name}` + `tool.register(def)`；
 * - 单项失败记 `errors`，**继续其余**（不假装原子）；顺序：流 → 工具。
 * - 新建初始化：`versions[name]` 仅在目标内容状态确立（写成功或有意空流 + 已知版本）时暴露；
 *   -32010 / 写失败 / create 缺 version → 抑制 version，写入 `streams.conflicts` 并计
 *   `createdWithWarning`，调用方应跳过本地播种、以读回为准；`created` 仍如实计数。
 *
 * @param {{plan:object, manifest:object, call:(m:string,p?:object)=>Promise<any>, contents?:Map|object,
 *          baseDir?:string, registeredTools?:Array|object|null, strategy?:'overwrite'|'skip',
 *          confirmReserved?:boolean, onProgress?:(p:object)=>void,
 *          casVersions?:Map<string,number>|null, protectNonempty?:boolean,
 *          isScanActive?:(name:string)=>boolean, createOnly?:boolean}} input
 * @returns {Promise<{streams:{created,updated,skipped,unchanged,failed,written,createdWithWarning,
 *                    versions:object,conflicts:Array},
 *                    tools:{registered,updated,skipped,failed}, toolResults:Array,
 *                    errors:string[], warnings:string[]}>}
 */
export async function applyImport({
  plan,
  manifest,
  call,
  contents,
  baseDir = '',
  strategy = 'overwrite',
  confirmReserved = false,
  onProgress,
  casVersions = null,      // Map<name, version>：提供时 update 分支写带 expected_version（CAS）
  protectNonempty = false, // true：包内空正文绝不覆盖写入（防陈旧包清空 SE 实存内容）
  isScanActive = null,     // (name)=>boolean：扫描活动流禁止导入覆盖（fail-closed）
  registeredTools = null,  // 实况 tool.list：工具 update/回滚/已存在替换的权威前置
  createOnly = false,      // true：仅新建；已有对象/竞态 already-exists 一律失败且零覆盖
} = {}) {
  const skipConflicts = strategy === 'skip';
  const parsed = manifest ? parseManifest(manifest) : null;
  const contentMap = asTextMap(contents);
  const rawByName = new Map();
  const defByName = new Map();
  if (parsed) {
    for (const rawStream of parsed.streams) {
      if (!rawStream || typeof rawStream !== 'object') continue;
      const n = streamNameOf(rawStream);
      if (n && !rawByName.has(n)) rawByName.set(n, rawStream);
    }
    for (const def of parsed.tools) {
      if (!def || typeof def !== 'object') continue;
      const n = String(def.name == null ? '' : def.name).trim();
      if (n && !defByName.has(n)) defByName.set(n, def);
    }
  }
  const progress = typeof onProgress === 'function' ? onProgress : null;
  const summary = {
    streams: {
      created: 0,
      updated: 0,
      skipped: 0,
      unchanged: 0,
      failed: 0,
      // 新建结果的可信度分层：written = 目标内容状态已确立；createdWithWarning = create 成功但
      // 初始化未确认（冲突/写失败/缺版本），调用方必须跳过本地播种并依赖读回。
      written: 0,
      createdWithWarning: 0,
      versions: {},
      // 明确的冲突/失败信号：{ name, reason: 'version-conflict'|'initialization-failed'|
      // 'missing-version'|'missing-write-version', error? }
      conflicts: [],
    },
    tools: { registered: 0, updated: 0, skipped: 0, failed: 0 },
    // 逐工具结果：{name, state:'registered'|'updated'|'skipped'|'failed', params?, error?}
    // 调用方据此只提交成功项，并写入“实际发给 SE 的绝对路径”。
    toolResults: [],
    errors: [],
    warnings: [],
  };
  const fail = (msg) => summary.errors.push(msg);

  for (const row of Array.isArray(plan && plan.streams) ? plan.streams : []) {
    if (!row || !row.selected) continue;
    const name = String(row.name == null ? '' : row.name);
    if (!name) continue;

    if (row.state === 'unchanged') {
      summary.streams.unchanged += 1;
      if (progress) progress({ kind: 'stream', name, state: 'unchanged' });
      continue;
    }
    if (createOnly && row.state !== 'new') {
      summary.streams.failed += 1;
      fail(`流 ${name}：createOnly 模式仅允许新建，已拒绝更新已有流（不改正文/描述/tags）。`);
      if (progress) progress({ kind: 'stream', name, state: 'failed' });
      continue;
    }
    if (row.state === 'update' && skipConflicts) {
      summary.streams.skipped += 1;
      if (progress) progress({ kind: 'stream', name, state: 'skipped' });
      continue;
    }
    if (typeof isScanActive === 'function' && isScanActive(name)) {
      summary.streams.failed += 1;
      fail(`流 ${name}：扫描活动期间禁止导入覆盖；请先停止扫描或显式 rescan。`);
      if (progress) progress({ kind: 'stream', name, state: 'failed' });
      continue;
    }

    const raw = rawByName.get(name) || null;
    const hasText = contentMap.has(name);
    const text = hasText ? contentMap.get(name) : '';

    if (row.state !== 'update') {
      if (!hasText) {
        summary.streams.failed += 1;
        fail(`stream.create ${name}：正文缺失（内联 content 与兄弟文件均不可得），已跳过创建以避免产生空流。`);
        if (progress) progress({ kind: 'stream', name, state: 'failed' });
        continue;
      }
      const params = { name };
      const description = raw && raw.description != null ? String(raw.description) : '';
      if (description) params.description = description;
      if (raw && raw.tags && typeof raw.tags === 'object' && !Array.isArray(raw.tags) && Object.keys(raw.tags).length) {
        params.tags = raw.tags;
      }
      let created = null;
      try {
        created = await call('stream.create', params);
      } catch (err) {
        if (isAlreadyExists(err)) {
          if (createOnly) {
            summary.streams.failed += 1;
            fail(`stream.create ${name}：已存在同名流；createOnly 模式拒绝回退到更新/覆盖。`);
            if (progress) progress({ kind: 'stream', name, state: 'failed' });
            continue;
          }
          // 残留存储修复：overwrite 且包内有正文 → 退化为 update 写入正文（旧 SE 存储目录
          // 复用时流已存在，正文以包为真源，否则出现「标题在、正文丢」）；
          // skip / 无正文 → 维持静默跳过（silentRefill 幂等回灌契约：不覆盖既有正文）。
          if (!skipConflicts && hasText && text !== '') {
            try {
              const written = await call('stream.write', { name, text });
              if (written && written.version != null) summary.streams.versions[name] = Number(written.version);
              summary.streams.updated += 1;
              if (progress) progress({ kind: 'stream', name, state: 'updated' });
            } catch (werr) {
              summary.streams.failed += 1;
              fail(`stream.write ${name}：${errMessage(werr)}`);
              if (progress) progress({ kind: 'stream', name, state: 'failed' });
            }
            continue;
          }
          summary.streams.skipped += 1;
          if (progress) progress({ kind: 'stream', name, state: 'skipped' });
          continue;
        }
        summary.streams.failed += 1;
        fail(`stream.create ${name}：${errMessage(err)}`);
        if (progress) progress({ kind: 'stream', name, state: 'failed' });
        continue;
      }
      const createdVersion =
        created && created.version != null && Number.isFinite(Number(created.version))
          ? Number(created.version)
          : undefined;
      const noteCreateConflict = (reason, message, error) => {
        summary.streams.conflicts.push({ name, reason, ...(error ? { error } : {}) });
        summary.streams.createdWithWarning += 1;
        summary.warnings.push(message);
        if (error) fail(error);
      };
      if (createdVersion === undefined) {
        // fail-closed：无有效 created.version 时既不能安全 CAS 初始化，也不得播种假版本。
        noteCreateConflict(
          'missing-version',
          `流 ${name}：stream.create 未返回有效 version，已跳过正文初始化与本地版本播种（以读回为准）。`
        );
      }
      if (text !== '') {
        if (createdVersion === undefined) {
          // 无版本 → 不写正文（避免无 CAS 的 create 后覆盖）。
        } else {
          try {
            const written = await call('stream.write', { name, text, expected_version: createdVersion });
            if (written && written.version != null && Number.isFinite(Number(written.version))) {
              summary.streams.versions[name] = Number(written.version);
              summary.streams.written += 1;
            } else {
              summary.streams.written += 1;
              noteCreateConflict(
                'missing-write-version',
                `流 ${name}：stream.write 未返回有效 version，已抑制本地版本播种（以读回为准）。`
              );
            }
          } catch (err) {
            if (err && err.code === -32010) {
              noteCreateConflict(
                'version-conflict',
                `流 ${name}：新建正文初始化版本冲突（SE 已变更），已保留 SE 内容，未播种本地版本。`
              );
            } else {
              noteCreateConflict(
                'initialization-failed',
                `stream.write ${name}：${errMessage(err)}`,
                `stream.write ${name}：${errMessage(err)}`
              );
            }
          }
        }
      } else if (createdVersion !== undefined) {
        summary.streams.versions[name] = createdVersion;
        summary.streams.written += 1;
      } else {
        // 有意空流：内容状态已成立，但版本不可知 → 不暴露 versions（已记 missing-version）。
        summary.streams.written += 1;
      }
      summary.streams.created += 1;
      if (progress) progress({ kind: 'stream', name, state: 'created' });
      continue;
    }

    let failed = false;
    let changed = false;
    if (row.contentChanged) {
      if (hasText) {
        if (protectNonempty && text === '') {
          // Tier-1（P0-1）：包内空正文绝不覆盖 SE 实存内容。
          summary.warnings.push(`流 ${name}：包内正文为空，已跳过覆盖写入（防清空 SE 实存内容）。`);
        } else {
          try {
            const params = { name, text };
            const v = casVersions ? casVersions.get(name) : undefined;
            if (v != null) params.expected_version = v;
            const written = await call('stream.write', params);
            if (written && written.version != null) summary.streams.versions[name] = Number(written.version);
            changed = true;
          } catch (err) {
            if (err && err.code === -32010) {
              // CAS 冲突：导入期间 SE 端被改写 → 保留 SE 版本，记 warning，不重试（有界）。
              summary.warnings.push(`流 ${name}：导入写入版本冲突（SE 已变更），已保留 SE 内容。`);
            } else {
              failed = true;
              fail(`stream.write ${name}：${errMessage(err)}`);
            }
          }
        }
      } else {
        summary.warnings.push(`流 ${name}：计划标记内容变更但未提供正文，已跳过写入。`);
      }
    }
    if (row.descriptionChanged && raw) {
      try {
        await call('stream.update_description', { name, text: raw.description == null ? '' : String(raw.description) });
        changed = true;
      } catch (err) {
        failed = true;
        fail(`stream.update_description ${name}：${errMessage(err)}`);
      }
    }
    const tagDiff = row.tagDiff && typeof row.tagDiff === 'object' ? row.tagDiff : {};
    const tagSets = Object.entries(
      tagDiff.set && typeof tagDiff.set === 'object' && !Array.isArray(tagDiff.set) ? tagDiff.set : {}
    );
    const tagRemoves = Array.isArray(tagDiff.remove) ? tagDiff.remove.map(String) : [];
    const skippedReserved = [];
    for (const [key, value] of tagSets) {
      if (!confirmReserved && isReservedTagKey(key)) {
        skippedReserved.push(key);
        continue;
      }
      try {
        await call('stream.set_tag', { name, key, value: value == null ? '' : String(value) });
        changed = true;
      } catch (err) {
        failed = true;
        fail(`stream.set_tag ${name}.${key}：${errMessage(err)}`);
      }
    }
    for (const key of tagRemoves) {
      if (!confirmReserved && isReservedTagKey(key)) {
        skippedReserved.push(key);
        continue;
      }
      try {
        await call('stream.remove_tag', { name, key });
        changed = true;
      } catch (err) {
        failed = true;
        fail(`stream.remove_tag ${name}.${key}：${errMessage(err)}`);
      }
    }
    if (skippedReserved.length) {
      summary.warnings.push(
        `流 ${name}：未确认保留键（canvas/edge.*）差量，已跳过 ${skippedReserved.length} 项：${skippedReserved.join(', ')}`
      );
    }
    if (failed) summary.streams.failed += 1;
    else if (changed) summary.streams.updated += 1;
    else summary.streams.unchanged += 1;
    if (progress) progress({ kind: 'stream', name, state: failed ? 'failed' : changed ? 'updated' : 'unchanged' });
  }

  // ── 工具：实况前置（prior）→ 绝对路径守卫 → 替换/注册 → 逐项结果 ──────────
  const registeredList = Array.isArray(registeredTools)
    ? registeredTools
    : registeredTools && typeof registeredTools === 'object'
      ? Object.values(registeredTools)
      : [];
  const priorByName = new Map();
  for (const row of registeredList) {
    const n = row && typeof row === 'object' ? String(row.name == null ? '' : row.name).trim() : '';
    if (n) priorByName.set(n, row);
  }
  /** 旧注册参数：按“原注册值”构造（baseDir=''，保留相对/绝对原样），仅用于回滚。 */
  const priorParamsOf = (name) => {
    const prior = priorByName.get(name);
    if (!isPlainObject(prior)) return null;
    const p = buildRegisterParams(prior, '');
    return p.tool_path ? p : null;
  };
  for (const row of Array.isArray(plan && plan.tools) ? plan.tools : []) {
    if (!row || !row.selected) continue;
    const name = String(row.name == null ? '' : row.name);
    if (!name) continue;
    if (row.state === 'unchanged') {
      summary.tools.skipped += 1;
      summary.toolResults.push({ name, state: 'skipped' });
      if (progress) progress({ kind: 'tool', name, state: 'skipped' });
      continue;
    }
    if (createOnly && row.state === 'update') {
      summary.tools.failed += 1;
      const msg = `工具 ${name}：createOnly 模式仅允许新建，已拒绝更新/替换已注册工具。`;
      fail(msg);
      summary.toolResults.push({ name, state: 'failed', error: msg });
      if (progress) progress({ kind: 'tool', name, state: 'failed', error: msg });
      continue;
    }
    if (row.state === 'update' && skipConflicts) {
      summary.tools.skipped += 1;
      summary.toolResults.push({ name, state: 'skipped' });
      if (progress) progress({ kind: 'tool', name, state: 'skipped' });
      continue;
    }
    const def = defByName.get(name);
    if (!def) {
      summary.tools.failed += 1;
      const msg = `工具 ${name}：manifest 中缺少定义，未注册。`;
      fail(msg);
      summary.toolResults.push({ name, state: 'failed', error: msg });
      if (progress) progress({ kind: 'tool', name, state: 'failed', error: msg });
      continue;
    }
    // 流：相对路径正文缺失 → 不创建；工具同规则（包内脚本缺失 = 坏包）。
    // 外部绝对路径缺失 → 仍注册（接收方自带），只记 warning。
    if (row.pathMissing && row.pathMissingKind === 'relative') {
      summary.tools.failed += 1;
      const msg = `工具 ${name}：包内脚本缺失（${String(def.tool_path || '')}），已跳过注册。`;
      fail(msg);
      summary.toolResults.push({ name, state: 'failed', error: msg });
      if (progress) progress({ kind: 'tool', name, state: 'failed', error: msg });
      continue;
    }
    if (row.pathMissing && row.pathMissingKind === 'absolute') {
      summary.warnings.push(
        `工具 ${name}：外部路径不存在（${String(def.tool_path || '')}），按外部引用注册。`
      );
    }
    // 白名单裁剪：前端私有字段（如 insert_template）绝不下发 SE（风险 #5）。
    const seDef = buildRegisterParams(def, baseDir);
    const pathErr = absoluteToolPathError(seDef);
    if (pathErr) {
      summary.tools.failed += 1;
      const msg = `工具 ${name}：${pathErr}，未注册。`;
      fail(msg);
      summary.toolResults.push({ name, state: 'failed', error: msg });
      if (progress) progress({ kind: 'tool', name, state: 'failed', error: msg });
      continue;
    }
    const priorParams = priorParamsOf(name);

    const markFailed = (msg) => {
      summary.tools.failed += 1;
      fail(msg);
      summary.toolResults.push({ name, state: 'failed', error: msg });
      if (progress) progress({ kind: 'tool', name, state: 'failed', error: msg });
    };
    const markOk = (state) => {
      summary.tools[state === 'updated' ? 'updated' : 'registered'] += 1;
      summary.toolResults.push({ name, state, params: seDef });
      if (progress) progress({ kind: 'tool', name, state });
    };

    // createOnly：即使旧定义不可读（priorParams=null），实况存在也不得继续 register。
    if (createOnly && row.state === 'new' && priorByName.has(name)) {
      markFailed(`工具 ${name}：已存在同名注册；createOnly 模式拒绝替换。`);
      continue;
    }
    // 计划为新增、但实况已存在：覆盖策略下按“更新”替换（不静默 skip）。
    if (row.state === 'new' && priorParams) {
      if (skipConflicts) {
        summary.tools.skipped += 1;
        summary.toolResults.push({ name, state: 'skipped' });
        if (progress) progress({ kind: 'tool', name, state: 'skipped' });
        continue;
      }
      summary.warnings.push(`工具 ${name}：计划为新增但实况已注册，已按覆盖更新。`);
      const r = await replaceRegisteredTool({ call, name, params: seDef, priorParams });
      if (r.ok) markOk('updated');
      else markFailed(`${r.error || '替换失败'}${r.rolledBack ? '（已回滚旧定义）' : ''}`);
      continue;
    }

    if (row.state === 'update') {
      if (!priorParams) {
        markFailed(`工具 ${name}：无法读取已注册定义，未替换（避免注册失败后工具丢失）。`);
        continue;
      }
      const r = await replaceRegisteredTool({ call, name, params: seDef, priorParams });
      if (r.ok) markOk('updated');
      else markFailed(`${r.error || '替换失败'}${r.rolledBack ? '（已回滚旧定义）' : ''}`);
      continue;
    }

    // 真正新增：直接注册；若撞 already-exists 且没有 prior，保留现状并明确失败，
    // 绝不盲目 unregister（那会让工具直接消失）。
    try {
      const res = await call('tool.register', seDef);
      throwIfFailure(res);
      markOk('registered');
    } catch (err) {
      if (isAlreadyExistsError(err)) {
        markFailed(
          createOnly
            ? `工具 ${name}：已存在同名注册；createOnly 模式拒绝替换。`
            : `工具 ${name}：已存在但无法读取旧定义，未替换；请用覆盖并确保可读取注册表。`
        );
      } else {
        markFailed(`tool.register ${name}：${errMessage(err)}`);
      }
    }
  }

  return summary;
}

/** 工具注册表是否为空（触发静默回灌的判据：只补空缺，不覆盖已注册项）。 */
export async function isToolRegistryEmpty(call) {
  try {
    const list = await call('tool.list', {});
    const items = Array.isArray(list) ? list : list && typeof list === 'object' ? Object.values(list) : [];
    return items.length === 0;
  } catch (err) {
    return false;
  }
}

/** 静默回灌去重：同一 manifest_path 并发连接时只回灌一次。 */
const refillInFlight = new Set();

/**
 * 注册表静默回灌（期 11 · B1 修复）：tool.list 为空且绑定含 manifest_path 时，
 * 读包 + 兄弟文件内容 → `planImport(existing=[])` → `applyImport(strategy:'skip')`。
 * 免确认；已存在流 `stream.create` 抛 already-exists → skipped（不覆盖既有正文）。返回 summary 或 null。
 */
export async function silentRefillFromManifest(call, manifestPath) {
  if (!manifestPath) return null;
  if (refillInFlight.has(manifestPath)) return null;
  refillInFlight.add(manifestPath);
  try {
    if (!(await isToolRegistryEmpty(call))) return null;
    const { manifest } = await loadManifestFile(manifestPath);
    const fetched = await fetchStreamContents({ manifest, manifestPath });
    const plan = planImport({ manifest, contents: fetched.contents, existingStreams: [], existingTools: [] });
    const summary = await applyImport({
      plan,
      manifest,
      call,
      contents: fetched.contents,
      baseDir: manifestAbsDirOf(manifestPath),
      registeredTools: [],
      strategy: 'skip',
    });
    if (fetched.warnings.length) summary.warnings.push(...fetched.warnings);
    return summary;
  } catch (err) {
    return { error: errMessage(err) };
  } finally {
    refillInFlight.delete(manifestPath);
  }
}
