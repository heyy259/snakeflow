// 清单域：config.load 参数合成 / 结果映射 / id 演化 + 单边清单构造 / 结果归一。
// （合并原 configLoad.js 与 register.js；纯函数，零 IO / 零 DOM / 零 React ⇒ 双端可导入。）
//
// 边界：
// - snakeeats 的 `config.load` 接受 `{path, dry_run?, skip_streams?}`，返回
//   `{loaded, skipped, errors, preview}` 四键；loaded 压成 entity 名单、其余原样透传；
// - 工具/流"新建、导入、批量投影"统一走 单边清单 → planImport → applyImport；
//   本模块只做"清单构造 + 结果归一"，不选通道、不发 RPC；
// - 清单 id 仅供 config.load 消费；applyImport 不读取/不消费 manifest.id。

const SCHEMA = 'snake-manifest-v1';

// ── config.load 通道 ─────────────────────────────────────────────────────

/**
 * 合成 `config.load` 参数。
 * @param {string} filePath manifest（`.se.json`）路径
 * @param {{dryRun?:boolean, skipStreams?:string[]}} [opts]
 * @returns {{path:string, dry_run?:true, skip_streams?:string[]}}
 */
export function buildConfigLoadParams(filePath, { dryRun = false, skipStreams } = {}) {
  const params = { path: String(filePath) };
  if (dryRun) params.dry_run = true;
  if (skipStreams && skipStreams.length) params.skip_streams = [...skipStreams];
  return params;
}

/**
 * 4 键结果 → UI 桶；`preview.will_create/skips/conflicts/warnings` 原样透传。
 * @param {{loaded?:Array, skipped?:Array, errors?:Array, preview?:object}} result
 * @returns {{created:string[], skipped:Array, errors:Array, preview:object}}
 */
export function mapConfigLoadResult(result) {
  const r = result || {};
  return {
    created: (r.loaded || []).map((x) => (x && (x.entity ?? x.name)) || ''),
    skipped: r.skipped || [],
    errors: r.errors || [],
    preview: r.preview || {},
  };
}

/**
 * D-B：id 随内容演化（内容变 → 新 id → config.load 重新求值）。
 * 调用方传入文档里将写入的新 id（document.js 已含指纹），此处只做兜底生成。
 * @param {string} baseName 图名（namespace）
 * @param {string} fingerprint 内容指纹
 * @returns {string} `<图名>#<指纹>`
 */
export function evolveManifestId(baseName, fingerprint) {
  return `${baseName}#${fingerprint}`;
}

// ── 单边清单构造 + 结果归一 ───────────────────────────────────────────────

/** FNV-1a 32bit → 8 hex（稳定、无依赖；仅用于清单 id，不参与幂等判定）。 */
function fingerprint(payload) {
  const s = JSON.stringify(payload);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * 工具单边清单：`{ $schema, id, streams: [], tools }`。
 * @param {Object<string, object>} tools 以 name 为键的工具定义表
 * @param {string} [baseName='tools'] id 基名（通常传 systemId）
 * @returns {object}
 */
export function buildToolsOnlyManifest(tools, baseName = 'tools') {
  const table =
    tools && typeof tools === 'object' && !Array.isArray(tools) ? tools : {};
  const names = Object.keys(table).sort();
  return {
    $schema: SCHEMA,
    id: evolveManifestId(String(baseName || 'tools'), fingerprint({ t: names })),
    streams: [],
    tools: table,
  };
}

/**
 * 流单边清单：`{ $schema, id, streams, tools: {} }`。
 * @param {Array<object>} streams 流条目（name/description/tags/source…）
 * @param {string} [baseName='streams'] id 基名（通常传 systemId）
 * @returns {object}
 */
export function buildStreamsOnlyManifest(streams, baseName = 'streams') {
  const list = Array.isArray(streams) ? streams : [];
  const fp = fingerprint({
    s: list.map((x) => [x?.name, x?.source?.file_path || '', x?.tags || {}]),
  });
  return {
    $schema: SCHEMA,
    id: evolveManifestId(String(baseName || 'streams'), fp),
    streams: list,
    tools: {},
  };
}

/**
 * applyImport 结果 → 统一 summary。`streams` / `tools` 原样保留（含 `versions`），
 * streams/tools 整体缺失时补默认对象；errors/warnings 保证为数组。
 * @param {object} [summary]
 * @returns {{streams:object, tools:object, errors:Array, warnings:Array}}
 */
export function summarizeManifestResult(summary) {
  const s = summary || {};
  return {
    streams: s.streams || { created: 0, updated: 0, skipped: 0, unchanged: 0, failed: 0, versions: {} },
    tools: s.tools || { registered: 0, updated: 0, skipped: 0, failed: 0 },
    errors: Array.isArray(s.errors) ? s.errors : [],
    warnings: Array.isArray(s.warnings) ? s.warnings : [],
  };
}
