// 统一配置文档（snake-manifest-v1 超集，**正文走文件、配置只记路径**）。
// 顶层 `{$schema, id, namespace, saved_at?, streams, tools, system}`：
// - `streams[]`：snakeeats 核心字段（name/description/tags/source）+ 前端扩展位（id，SE 静默丢弃；
//   旧文档 `position` 仅读端回退）；
// - `system.graph`：图数据扩展位（format_version/edges/layout/viewport，SE 整段透传）；
// - 字段名对齐 SE（stream: name/description/tags/source；tool: ToolDefinition 字段族），接 SE 零改名。
//
// v3 与 v2 的差异（SE中文名同步改造方案 §3）：
// - `streams[]` 去 `title`：`name` 即显示名（中文原生合法），与 SE name 单一真源；
// - 读端把旧 `title` 当 `name` 的**回落**接受一次（D7），写端不再产出。
//
// 统一配置改造（2026-09-25）：
// - 配置文件扩展名 `.se.json`（`GRAPH_CONFIG_EXT`）；
// - `source.file_path` 相对 **manifest 同级目录**（`<图名>.streams/...`，无 `graphs/` 前缀），
//   snakeeats `resolveSiblingPath` 可直接解析；App 读写时补 `graphs/` 项目根前缀；
// - `system.graph` 承载 edges/layout/viewport；`streams[].id` 为扩展位（旧 `position` 读端兼容）。
//
// 布局单载体改造（2026-10-16）：
// - 画布布局（节点位置 + 可选宽高）统一落 `system.graph.layout`（`{[流名]:{x,y,width?,height?}}`），
//   `format_version` 升 '5.0'；写端不再产出 `streams[].position` / `system.graph.positions`；
// - 读端回退链保留：layout 缺失 → `streams[].position`（条目优先）→ `system.graph.positions`（旧格式无尺寸）。
//
// 兼容：旧 `{nodes, edges}` 逻辑格式（v0）不再支持加载（读取入口在 graph.js）。
// 迁移后尚未重存的旧结构（顶层 `streams` + 顶层 `edges` + `graphs/` 前缀 source）仍可读。
import { normalizeTools } from './tools.js';
import {
  sanitizeGraphName,
  sanitizeStreamFilename,
  graphConfigFileName,
  normalizeResourcePath,
} from './paths.js';
import { fieldsToTags } from './se/streams.js';

export const DOC_VERSION = '3.0';
/** 统一配置文档 schema 标识（snake-manifest-v1 超集；snakeeats 可直接 config.load）。 */
export const DOC_SCHEMA = 'snake-manifest-v1';

const DEFAULT_ENCODING = 'utf-8';
const ILLEGAL_FILE_CHARS_RE = /[\\/:*?"<>|\u0000-\u001f]+/g;

const VALID_SCAN_STATES = ['idle', 'scanning', 'paused'];

/** viewport 合法性：对象为真且 x/y/zoom 均为有限数值且 zoom > 0（不做区间钳制）。 */
function isFiniteViewport(v) {
  return (
    !!v &&
    typeof v === 'object' &&
    Number.isFinite(Number(v.x)) &&
    Number.isFinite(Number(v.y)) &&
    Number.isFinite(Number(v.zoom)) &&
    Number(v.zoom) > 0
  );
}

export function normalizeScan(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const scan = {
    state: VALID_SCAN_STATES.includes(raw.state) ? raw.state : 'idle',
    position: Number(raw.position) || 0,
    ok: Number(raw.ok) || 0,
    fail: Number(raw.fail) || 0,
  };
  return scan.state !== 'idle' || scan.position || scan.ok || scan.fail ? scan : null;
}

/**
 * 规范化终端进程清单。接受对象数组 {id, tool, name, waiting}
 * 或原型字符串格式 "tool + name" / "tool + name (等待输入)"，返回对象数组。
 */
export function normalizeProcesses(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  raw.forEach((p, i) => {
    if (p && typeof p === 'object') {
      const tool = String(p.tool || '').trim();
      const name = String(p.name || '').trim();
      if (!tool && !name) return;
      out.push({
        id: String(p.id || `p-${i + 1}`),
        tool,
        name,
        waiting: !!p.waiting,
      });
      return;
    }
    if (typeof p === 'string') {
      const waiting = /\(等待输入\)\s*$/.test(p);
      const bare = p.replace(/\s*\(等待输入\)\s*$/, '');
      const [tool = '', name = ''] = bare.split(/\s+\+\s+/);
      if (!tool && !name) return;
      out.push({ id: `p-${i + 1}`, tool: tool.trim(), name: name.trim(), waiting });
    }
  });
  return out;
}

// ── v2 路径 helper ────────────────────────────────────────────────────────

/** 图名 → 内容目录（相对项目根，正斜杠）；空名 → ''。 */
export function documentDirOf(name) {
  const base = sanitizeGraphName(name);
  return base ? `graphs/${base}.streams` : '';
}

/** 图名 → 内容目录名（manifest **同级相对**，无 `graphs/` 前缀）；空名 → ''。 */
export function documentStreamsDirName(name) {
  const base = sanitizeGraphName(name);
  return base ? `${base}.streams` : '';
}

/** 图名 → 配置文件名（`<净化名>.se.json`，与 `/api/graphs/file?name=` 同源）；空名 → ''。 */
export function documentFileNameOf(name) {
  return graphConfigFileName(name);
}

/** 读节点（或 data）上的 source 引用并规范化；无效/缺失 → null。 */
export function sourceOf(nodeOrData) {
  const data = nodeOrData && nodeOrData.data && typeof nodeOrData.data === 'object'
    ? nodeOrData.data
    : nodeOrData;
  const raw = data && typeof data === 'object' ? data.source : null;
  if (!raw || typeof raw !== 'object') return null;
  const fp = raw.file_path == null ? '' : String(raw.file_path).trim();
  if (!fp) return null;
  return {
    file_path: fp.replace(/\\/g, '/'),
    encoding: raw.encoding ? String(raw.encoding) : DEFAULT_ENCODING,
  };
}

/** 路径 → 小写基名（跨 `\` `/`）。 */
function basenameLower(p) {
  return String(p).replace(/\\/g, '/').split('/').pop().toLowerCase();
}

/**
 * 为缺 `source` 的节点分配内容文件路径（确定性 + 幂等；**不覆盖已有引用**）。
 * 返回 Map<nodeId, {file_path, encoding} | null>（空图名 → null）。
 *
 * 命名口径与迁移脚本 `filenamesFor` 对齐：唯一标题 → `<净化名>.md`；
 * 重名 → `<stem>-<id>.md`（再冲突补 `_2`/`_3`…）；已有引用的文件名先行占位，避免抢名。
 * `file_path` 相对 **manifest 所在目录**（`<图名>.streams/...`，无 `graphs/` 前缀）。
 */
export function planDocumentSources(name, nodes) {
  const dir = documentStreamsDirName(name);
  const list = Array.isArray(nodes) ? nodes : [];
  const claimed = new Set();
  for (const n of list) {
    const existing = sourceOf(n);
    if (existing) claimed.add(basenameLower(existing.file_path));
  }
  const out = new Map();
  for (const n of list) {
    const id = String(n && n.id != null ? n.id : '');
    const existing = sourceOf(n);
    if (existing) {
      out.set(id, existing);
      continue;
    }
    if (!dir) {
      out.set(id, null);
      continue;
    }
    const name = String((n && n.data && (n.data.name ?? n.data.title)) || '').trim();
    const base = sanitizeStreamFilename(name || 'stream', '.md');
    const stem = base.slice(0, base.length - 3) || 'stream';
    let cand = base;
    if (claimed.has(cand.toLowerCase())) {
      const tag = (id || 'x').replace(ILLEGAL_FILE_CHARS_RE, '_');
      cand = `${stem}-${tag}.md`;
      let i = 2;
      while (claimed.has(cand.toLowerCase())) {
        cand = `${stem}-${tag}_${i}.md`;
        i += 1;
      }
    }
    claimed.add(cand.toLowerCase());
    out.set(id, { file_path: `${dir}/${cand}`, encoding: DEFAULT_ENCODING });
  }
  return out;
}

/**
 * 把一组节点的 `source.file_path` 前缀从 `oldDir` 迁到 `newDir`（tab 重命名，D11）。
 * 纯函数：返回新数组（不改原对象；无 source / 前缀不匹配的节点原样返回）。
 */
export function remapSourcePrefix(nodes, oldDir, newDir) {
  const from = String(oldDir || '').replace(/\/+$/, '');
  const to = String(newDir || '').replace(/\/+$/, '');
  const list = Array.isArray(nodes) ? nodes : [];
  if (!from || !to || from === to) return list;
  return list.map((n) => {
    const src = sourceOf(n);
    if (!src) return n;
    if (src.file_path !== from && !src.file_path.startsWith(`${from}/`)) return n;
    const rel = src.file_path.slice(from.length);
    return {
      ...n,
      data: { ...(n.data || {}), source: { ...src, file_path: `${to}${rel}` } },
    };
  });
}

/**
 * 保存时回写 source（G1）：把 buildDocument 产出 doc 的 `streams[i].source` 补回缺引用的节点，
 * 消除「加载有回灌（parseDocument→data.source）、保存无回写」的不对称——会话内新建流此前
 * 永远没有 data.source，删除时 purgeStreamArtifacts 因 fp='' 整体空转导致正文文件残留。
 *
 * 纯函数：只补 `data.source`，绝不动 content/contentState/其他任何字段；
 * 仅当节点当前缺 `data.source.file_path` 且同 id 的 streams 条目有 source 时才补；
 * 规范化口径与 parseDocument 一致（反斜杠→正斜杠，encoding 缺省补 DEFAULT_ENCODING）。
 * 无变化返回原数组引用（让 React setState 的 Object.is bail-out 生效，防保存循环）。
 */
export function applyPlannedSources(nodes, doc) {
  const list = Array.isArray(nodes) ? nodes : [];
  const streams = doc && Array.isArray(doc.streams) ? doc.streams : [];
  if (!list.length || !streams.length) return list;
  const planned = new Map();
  for (const s of streams) {
    if (!s || typeof s !== 'object') continue;
    const src = s.source;
    if (!src || typeof src !== 'object' || !src.file_path) continue;
    planned.set(String(s.id), src);
  }
  if (!planned.size) return list;
  let changed = false;
  const next = list.map((n) => {
    const src = planned.get(String(n && n.id != null ? n.id : ''));
    if (!src) return n;
    if (n.data && n.data.source && n.data.source.file_path) return n;
    changed = true;
    return {
      ...n,
      data: {
        ...(n.data || {}),
        source: {
          file_path: String(src.file_path).replace(/\\/g, '/'),
          encoding: src.encoding ? String(src.encoding) : DEFAULT_ENCODING,
        },
      },
    };
  });
  return changed ? next : list;
}

/**
 * 原地绑定配置包时，把 manifest 里的真实 source 引用灌回投影后的节点
 * （按流名匹配；**绝不覆盖已有 source**）。SE 不知道 source，重投影会丢，
 * 不回灌则首次保存会按 `<docBase>.streams/<名>.md` 另建一套副本。
 *
 * @param {Array} nodes canonical nodes
 * @param {Map<string,{file_path:string,encoding?:string}>|object} sourcesByStream
 * @returns {Array} 有变化返回新数组，否则原引用
 */
export function applyImportedSources(nodes, sourcesByStream) {
  const list = Array.isArray(nodes) ? nodes : [];
  if (!list.length || !sourcesByStream) return list;
  const lookup = sourcesByStream instanceof Map ? sourcesByStream : new Map(Object.entries(sourcesByStream));
  if (!lookup.size) return list;
  let changed = false;
  const next = list.map((n) => {
    const name = n && n.data && n.data.name != null ? String(n.data.name) : '';
    const src = lookup.get(name);
    if (!src || !src.file_path) return n;
    if (n.data && n.data.source && n.data.source.file_path) return n;
    changed = true;
    return {
      ...n,
      data: {
        ...(n.data || {}),
        source: {
          file_path: String(src.file_path).replace(/\\/g, '/'),
          encoding: src.encoding ? String(src.encoding) : DEFAULT_ENCODING,
        },
      },
    };
  });
  return changed ? next : list;
}

/**
 * 配置改名/复制后改写流正文引用：`<oldBase>.streams/` → `<newBase>.streams/`。
 * 仅改相对路径；绝对 source 原样保留（调用方负责提示）。返回是否有改动。
 */
export function rewriteSourcePrefixInDoc(doc, oldBase, newBase) {
  const from = oldBase ? `${oldBase}.streams/` : '';
  const to = newBase ? `${newBase}.streams/` : '';
  if (!doc || !Array.isArray(doc.streams) || !from || !to || from === to) return false;
  let changed = false;
  for (const s of doc.streams) {
    const fp = s && s.source && s.source.file_path;
    if (typeof fp !== 'string') continue;
    const norm = fp.replace(/\\/g, '/');
    if (!norm.startsWith(from)) continue;
    s.source.file_path = `${to}${norm.slice(from.length)}`;
    changed = true;
  }
  return changed;
}

// ── 构建 / 解析 ───────────────────────────────────────────────────────────

/** 内容指纹（稳定、无依赖）：FNV-1a 32bit → 8 hex。用于 `id = <图名>#<指纹>`。 */
function contentFingerprint(streams, tools) {
  const payload = JSON.stringify({
    s: (streams || []).map((x) => [x.name, x.source?.file_path || '', x.tags || {}]),
    t: Object.keys(tools || {}).sort(),
  });
  let h = 0x811c9dc5;
  for (let i = 0; i < payload.length; i += 1) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 工具三路径统一按映射改写（流/工具共用同一写侧语义）。 */
function mapToolPaths(tools, mapper) {
  const out = {};
  for (const [name, def] of Object.entries(tools || {})) {
    const next = { ...def };
    for (const key of ['tool_path', 'execution_path', 'manual_path']) {
      const value = next[key];
      if (typeof value === 'string' && value !== '') {
        const mapped = mapper(value, { entity: 'tool', field: key, name });
        if (mapped) next[key] = mapped;
      }
    }
    out[name] = next;
  }
  return out;
}

/**
 * 当前标签页全量 → 统一配置文档（snake-manifest-v1 超集）。
 * `savedAt === null` 时省略 `saved_at`（供同步镜像去重）。
 * 结构：`{$schema, id, namespace, streams[].{id,...}, tools, system.graph}`；
 * `system.graph` 承载图数据（format_version '5.0' + edges + layout + 可选 viewport，snakeeats 整段透传）：
 * `layout` 为画布布局唯一载体（`{[流名]:{x,y,width?,height?}}`；width/height 仅有限正数才写），
 * `streams[].id` 为 snakeeats 静默丢弃的前端扩展位（v5 起 streams 条目不再写 `position`）。
 * 节点缺 source 时由 `planDocumentSources` 分配 `<docBase 或图名>.streams/<净化名>.md`（manifest 同级）；
 * **不写 `content`**（正文由调用方按 `stream.source.file_path` 落盘）。
 * `docBase`：文档身份基名（外部/配置包文档取文件名；应用内 graphs 图省略 = 沿用 tab 名）。
 */
export function buildDocument(
  {
    name,
    docBase,
    nodes,
    edges,
    tools,
    viewport,
    baseDir = '',
    profile = 'live',
    pathMapper = null,
  },
  savedAt
) {
  const stamp = savedAt === undefined ? new Date().toISOString() : savedAt;
  const baseName = String(docBase == null ? '' : docBase).trim() || String(name || '');
  const cfgName = sanitizeGraphName(baseName);
  const list = Array.isArray(nodes) ? nodes : [];
  const srcMap = planDocumentSources(baseName, list);
  // 写侧唯一归一化入口：显式 pathMapper（导出 bundle）优先；否则按 baseDir 归一。
  // 基准 = manifest 所在目录（绝对）；未传 baseDir 时保持原样（单测/旧调用零变化）。
  const mapper =
    typeof pathMapper === 'function'
      ? pathMapper
      : (value) => (baseDir ? normalizeResourcePath(value, baseDir) : String(value));
  const layout = {};
  const streams = list.map((n) => {
    const rawName = n.data?.name != null
      ? String(n.data.name)
      : n.data?.title != null
        ? String(n.data.title)
        : '';
    // v3：单一 name（显示名 = SE name）；不再产出 title。
    // v5：不再写 position（画布布局统一走 system.graph.layout，见下）。
    const out = {
      name: rawName,
      description: n.data?.description != null ? String(n.data.description) : '',
      tags: fieldsToTags(n.data?.fields || []),
      id: String(n.id),
    };
    const source = srcMap.get(String(n.id));
    if (source) {
      const filePath = mapper(source.file_path, {
        entity: 'stream',
        field: 'source.file_path',
        name: rawName,
      });
      if (filePath) out.source = { file_path: filePath, encoding: source.encoding };
    }
    // 布局条目：key 沿用旧 positions 的流名口径（无 id 的节点不入表）。
    if (String(n.id)) {
      const entry = {
        x: Number(n.position?.x) || 0,
        y: Number(n.position?.y) || 0,
      };
      const w = Number(n.style?.width);
      const h = Number(n.style?.height);
      if (Number.isFinite(w) && w > 0) entry.width = w;
      if (Number.isFinite(h) && h > 0) entry.height = h;
      layout[rawName] = entry;
    }
    return out;
  });
  // 期 5：edges 已**降级为导出快照**（人可读 / 可 diff）；对已绑定 SE 的 tab，
  // 边的唯一真源是各流上的 `edge.<目标 name>` 标签，加载时以 SE 派生结果为准。
  // 扩展位统一落 `system.graph`（snakeeats 整段透传、零告警）：v5 起布局（位置+宽高）
  // 也收拢于此（`layout`），不再双写 `streams[].position` / `system.graph.positions`。
  const edgeList = (Array.isArray(edges) ? edges : []).map((e) => ({
    source: String(e.source),
    target: String(e.target),
    label: e.label ? String(e.label) : '',
  }));
  // 先归一化再算指纹：落盘内容与 id 一致；相对形式使同一包在不同机器上 id 稳定。
  const mappedTools = mapToolPaths(normalizeTools(tools), mapper);
  const doc = {
    $schema: DOC_SCHEMA,
    id: `${cfgName}#${contentFingerprint(streams, mappedTools)}`,
    namespace: cfgName,
    streams,
    tools: mappedTools,
    system: {
      name: String(name || ''),
      graph: {
        format_version: '5.0',
        edges: edgeList,
        layout,
        ...(isFiniteViewport(viewport)
          ? { viewport: { x: Number(viewport.x), y: Number(viewport.y), zoom: Number(viewport.zoom) } }
          : {}),
      },
    },
  };
  if (stamp) doc.saved_at = String(stamp);
  return doc;
}

/**
 * 判定是否为统一配置文档。
 * 新 snake-manifest 配置（`$schema` / `system.graph`）→ true；
 * 兼容迁移后尚未重存的旧结构（顶层 `streams`）→ 仍 true（否则旧 `.se.json` 无法加载）；
 * 纯逻辑图 / 旧 `{nodes,edges}` → false（走 `fromLogicGraph`）。
 */
export function isUnifiedDocument(parsed) {
  return !!(
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    (parsed.$schema === DOC_SCHEMA || !!parsed.system?.graph || Array.isArray(parsed.streams))
  );
}

/**
 * 统一配置文档（新结构 / 旧 v2 路径引用 / v1 内联）→ canonical `{ name, nodes, edges, tools, viewport, warnings }`。
 * nodes 为画布就绪形态：
 *   `{id, position, data:{name, content?, contentState, source?, description?, fields?}, style?}`。
 * - 位置：优先 `system.graph.layout[name]`（`{x,y,width?,height?}`；width/height 有限正数 → 节点 `style`）；
 *   layout 缺失时回落旧位——`streams[].position`（条目优先）→ `system.graph.positions[name]`（旧格式无尺寸，style 不写）；
 * - 边：优先 `system.graph.edges`，回落顶层 `edges`（兼容旧文档）；
 * - 引用：`source.file_path` → `data.source`；`contentState:'unknown'`（待按引用懒加载）；
 *   缺失引用 → `'missing'`（**不置空、不覆盖**）。
 * - v1 内联：`content` 存在（含空串）→ `data.content` + `'loaded'`。
 * - viewport：`system.graph.viewport`（x/y/zoom 均为有限数值）→ 原样返回，否则 `null`。
 * tags dict → fields 数组；软问题记入 warnings，不 throw。
 */
export function parseDocument(parsed) {
  const warnings = [];
  const nodes = [];
  const seen = new Set();
  const graph = parsed?.system?.graph || null;
  const layoutMap = graph && graph.layout && typeof graph.layout === 'object' && !Array.isArray(graph.layout)
    ? graph.layout
    : null;
  const positionMap = graph?.positions;
  (Array.isArray(parsed.streams) ? parsed.streams : []).forEach((s, i) => {
    if (!s || typeof s !== 'object') {
      warnings.push(`streams[${i}] 无效，已忽略`);
      return;
    }
    let id = String(s.id != null && s.id !== '' ? s.id : `s-${i + 1}`);
    if (seen.has(id)) {
      id = `${id}-${i + 1}`;
      warnings.push(`流 id「${s.id}」重复，已改为「${id}」`);
    }
    seen.add(id);
    const fields = Object.entries(s.tags && typeof s.tags === 'object' && !Array.isArray(s.tags) ? s.tags : {}).map(
      ([key, v]) => ({ key: String(key), value: v == null ? '' : String(v) })
    );
    // v3：name 为准（SE 单一真源）；旧文档仅有 title → 回落一次（D7）。
    const name = s.name != null && String(s.name) !== '' ? String(s.name) : s.title != null ? String(s.title) : '';
    const hasInline = Object.prototype.hasOwnProperty.call(s, 'content') && s.content != null;
    const source = s.source && typeof s.source === 'object' && s.source.file_path
      ? {
        file_path: String(s.source.file_path).replace(/\\/g, '/'),
        encoding: s.source.encoding ? String(s.source.encoding) : DEFAULT_ENCODING,
      }
      : null;
    const data = {
      name,
      ...(s.description ? { description: String(s.description) } : {}),
      ...(fields.length ? { fields } : {}),
    };
    if (source) data.source = source;
    if (source) {
      data.contentState = 'unknown';
    } else if (hasInline) {
      data.content = String(s.content);
      data.contentState = 'loaded';
    } else {
      data.contentState = 'missing';
    }
    // 位置（v5）：优先 system.graph.layout[name]；width/height 有限正数 → node.style。
    const layoutEntry = layoutMap ? layoutMap[name] : null;
    const hasLayout = !!layoutEntry && typeof layoutEntry === 'object' && !Array.isArray(layoutEntry)
      && Number.isFinite(Number(layoutEntry.x)) && Number.isFinite(Number(layoutEntry.y));
    let pos;
    const style = {};
    if (hasLayout) {
      pos = { x: Number(layoutEntry.x), y: Number(layoutEntry.y) };
      const w = Number(layoutEntry.width);
      const h = Number(layoutEntry.height);
      if (Number.isFinite(w) && w > 0) style.width = w;
      if (Number.isFinite(h) && h > 0) style.height = h;
    } else {
      // 回退链（旧格式，无尺寸）：条目内优先，回落 system.graph.positions[name]。
      const entryPos = s.position && typeof s.position === 'object' ? s.position : null;
      const fallbackPos = !entryPos && positionMap && typeof positionMap === 'object'
        ? positionMap[name]
        : null;
      const old = entryPos || fallbackPos || {};
      pos = { x: Number(old.x) || 0, y: Number(old.y) || 0 };
    }
    // 读端兼容：旧文档的 scan/processes 字段一律忽略，不进 node data（G5/风险 7）。
    nodes.push({
      id,
      position: pos,
      data,
      ...(Object.keys(style).length ? { style } : {}),
    });
  });
  const rawEdges = Array.isArray(parsed.system?.graph?.edges)
    ? parsed.system.graph.edges
    : Array.isArray(parsed.edges)
      ? parsed.edges
      : [];
  const edges = [];
  rawEdges.forEach((e, i) => {
    const source = String(e?.source || '');
    const target = String(e?.target || '');
    if (!source || !target || !seen.has(source) || !seen.has(target)) {
      warnings.push(`edges[${i}] 无效或引用了不存在的流，已忽略`);
      return;
    }
    edges.push({
      id: `e-${edges.length + 1}`,
      source,
      target,
      ...(e.label ? { label: String(e.label) } : {}),
    });
  });
  const rawViewport = parsed?.system?.graph?.viewport;
  return {
    name: parsed?.system?.name != null ? String(parsed.system.name) : '',
    nodes,
    edges,
    tools: normalizeTools(parsed.tools),
    viewport: isFiniteViewport(rawViewport)
      ? { x: Number(rawViewport.x), y: Number(rawViewport.y), zoom: Number(rawViewport.zoom) }
      : null,
    warnings,
  };
}
