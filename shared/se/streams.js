// SE 流投影层（期 3 流读写主干）。
//
// 职责（SE接线方案.md §4「流 CRUD / 内容读写 / 统一文档」三行 + §3.6 重投影纪律）：
// - SE `name` 即显示名（中文原生合法，契约见 nameContract.js）；不再派生 ASCII slug；
// - `stream.list` 元数据 → 画布 nodes 投影（name↔id 稳定映射、tags→fields、坐标取本地缓存）；
// - 本模块以纯函数为主，无 DOM / React 依赖，可在 Node 侧直接 import 做单测。
//
// 事实（SE 侧已核实）：
// - `stream.list` 返回 `[{name, description, title?, tags, version}]`（**无 content**）；
// - `stream.create{name,description?,tags?}` 返回 get_metadata 同形；
// - SE 不存坐标：position 是前端私有，按 `<system> → <name> → {x,y}` 本地缓存。
//
// G6 投影映射：SE `tags` dict ↔ 节点 `data.fields[]`（复用 graph.js normalizeFields
// 的双向语义）；`name` ↔ `data.name`；`description` ↔ `data.description`；
// 内容 ↔ `data.content`。graph-architecture.md 的 `tags:string[]` 关联特性不触达。

import { normalizeFields } from '../graph.js';

/** 坐标吸附步长（与 App.jsx GRID 对齐）：新流落点对齐网格。 */
const GRID = 16;

/** 流 name → 节点 id 的稳定前缀（SE name 可为 Unicode；id 只是字符串前缀拼接，不漂）。 */
const NODE_ID_PREFIX = 's-';

/** 稳定映射：SE 流 name → 画布节点 id。 */
export function streamNodeId(name) {
  return `${NODE_ID_PREFIX}${String(name == null ? '' : name)}`;
}

/** 反向映射：画布节点 id → SE 流 name；非 SE 投影节点（本地 n-* 等）返回 null。 */
export function streamNameFromId(id) {
  const s = String(id == null ? '' : id);
  return s.startsWith(NODE_ID_PREFIX) ? s.slice(NODE_ID_PREFIX.length) : null;
}

/**
 * SE tags dict → 节点 fields[]（复用 normalizeFields 语义：trim、去空行）。
 *
 * 过滤 `edge.` 前缀键：边 = 流标签（SE接线方案.md §3.1），在画布上用连线表达，
 * 不进入节点属性行（`canvas` 保留——可见性由眼睛/右键切换）。本函数只被投影 /
 * 元数据读取使用；`fieldsToTags` 写路径不受影响（元数据对话框自行排除保留键）。
 */
export function tagsToFields(tags) {
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return [];
  return normalizeFields(
    Object.entries(tags)
      .filter(([key]) => !String(key).startsWith('edge.'))
      .map(([key, value]) => ({ key, value: value == null ? '' : value }))
  );
}

/** 节点 fields[] → SE tags dict（复用 normalizeFields 语义：trim、去空行、键唯一）。 */
export function fieldsToTags(fields) {
  const out = {};
  normalizeFields(fields).forEach((f) => {
    if (f.key) out[f.key] = f.value;
  });
  return out;
}

const snap = (p) => ({ x: Math.round(p.x / GRID) * GRID, y: Math.round(p.y / GRID) * GRID });

/**
 * 分离「prev 有、本次 list 没有」的 s-* 节点：区分**已确认删除**与**未确认缺失**。
 *
 * 核心纪律（防「其他流消失」）：`stream.list` 少返回一条**不等于**该流被删除——
 * 可能是 push 尚未完成、SE 恢复/重启后注册表不完整、或投影时序未就绪。只有
 * `confirmedRemoved`（显式删除意图）才允许移除；其余一律保留并按分歧修复。
 *
 * @param {Array<{id}>} prevNodes 当前画布 canonical nodes
 * @param {Array<{name}>} rows 本次 stream.list
 * @param {Set<string>|Array<string>|null} [confirmedRemoved] 已确认可移除的流名
 * @returns {{missingIds:string[], missingNames:string[],
 *            confirmedIds:string[], confirmedNames:string[],
 *            unexpectedIds:string[], unexpectedNames:string[]}}
 */
export function splitMissing(prevNodes, rows, confirmedRemoved) {
  const prev = Array.isArray(prevNodes) ? prevNodes : [];
  const list = Array.isArray(rows) ? rows : [];
  const confirmed =
    confirmedRemoved instanceof Set
      ? confirmedRemoved
      : new Set(Array.isArray(confirmedRemoved) ? confirmedRemoved.map(String) : []);
  const rowIds = new Set();
  list.forEach((s) => {
    if (!s || s.name == null || s.name === '') return;
    rowIds.add(streamNodeId(String(s.name)));
  });
  const missingIds = [];
  const missingNames = [];
  const confirmedIds = [];
  const confirmedNames = [];
  const unexpectedIds = [];
  const unexpectedNames = [];
  prev.forEach((n) => {
    const id = String(n && n.id != null ? n.id : '');
    if (!id.startsWith(NODE_ID_PREFIX) || rowIds.has(id)) return;
    const name = streamNameFromId(id);
    missingIds.push(id);
    missingNames.push(name == null ? '' : name);
    if (name != null && confirmed.has(name)) {
      confirmedIds.push(id);
      confirmedNames.push(name);
    } else {
      unexpectedIds.push(id);
      unexpectedNames.push(name == null ? '' : name);
    }
  });
  return { missingIds, missingNames, confirmedIds, confirmedNames, unexpectedIds, unexpectedNames };
}

/**
 * `stream.list` 元数据 → 画布 canonical nodes 投影。
 *
 * 纪律（§3.6）：结构变更后全量重投影，**不信任本地增量**——本函数以服务端
 * list 为唯一结构真源；本地 nodes 只作为「坐标 + 内容 + 渲染尺寸」的缓存。
 *
 * - node id = `s-<name>`（重连/重投影间稳定，工作区缓存 edges 引用不漂）；
 * - `name` 即 SE name（显示名，中文原生）；`description`/`tags`↔fields 同步；
 * - `content` 无 list 字段：保留 prev 节点缓存内容（新流留空，待 read 填充）；
 * - `source`（外部文档真实路径绑定）同为 prev 缓存回灌：丢失会被自动保存改配 graphs 副本；
 * - position：prev 命中按 id 保留；新流优先取常驻布局表 layout[name] 的记录落点，
 *   未记录才在 opts.center 附近错开落点（对齐网格）；
 * - style（渲染尺寸）：prev.style 原样透传（优先）；prev 无 style 时按 layout[name] 的
 *   width?/height? 播种（只写有定义的键）；
 * - 可见性 `canvas` 与普通标签一样直接取 SE `tags`（期 4 起 SE 为唯一真源，不再合并 prev）；
 * - `scan`/`processes` 运行时缓存同样保留（本期不写回统一文档）。
 *
 * @param {Array<{name,description?,tags?,version?}>} list stream.list 结果
 * @param {Array<{id,position,data,style?}>} prevNodes 当前画布 canonical nodes
 * @param {{center?:{x:number,y:number},
 *          layout?:Object<string,{x:number,y:number,width?:number,height?:number}>,
 *          confirmedRemoved?:Set<string>|Array<string>|null,
 *          keepMissing?:boolean}} [opts]
 *   layout：常驻布局表（name → {x,y,width?,height?}；App 侧持久化、永不消费），新流按记录落点
 *   （优先于视口中心），prev 无 style 时按记录尺寸播种；缺失/无效值回退中心网格。
 *   confirmedRemoved：已确认可移除的流名（显式删除/外部用户删除）；只有它们进入 `removedIds`。
 *   keepMissing：默认 true——未确认缺失的 prev `s-*` 节点**原样保留**（坐标/样式/data 缓存），
 *   避免把「push 未完成 / SE 恢复 / 投影时序」误判为删除。
 * @returns {{nodes:Array, removedIds:string[], versions:Object<string,number>,
 *            keptMissingIds:string[], keptMissingNames:string[]}}
 */
export function projectStreams(list, prevNodes = [], opts = {}) {
  const prevById = new Map((Array.isArray(prevNodes) ? prevNodes : []).map((n) => [String(n.id), n]));
  const center = opts.center && Number.isFinite(opts.center.x) && Number.isFinite(opts.center.y)
    ? opts.center
    : { x: 100, y: 100 };
  const layout = opts.layout && typeof opts.layout === 'object' && !Array.isArray(opts.layout)
    ? opts.layout
    : null;
  const confirmed =
    opts.confirmedRemoved instanceof Set
      ? opts.confirmedRemoved
      : new Set(Array.isArray(opts.confirmedRemoved) ? opts.confirmedRemoved.map(String) : []);
  const keepMissing = opts.keepMissing !== false;
  const rows = Array.isArray(list) ? list : [];
  const seen = new Set();
  const nodes = [];
  const versions = {};
  const keptMissingIds = [];
  const keptMissingNames = [];
  let newIndex = 0;

  rows.forEach((s) => {
    if (!s || s.name == null || s.name === '') return;
    const name = String(s.name);
    const id = streamNodeId(name);
    if (seen.has(id)) return;
    seen.add(id);

    const prev = prevById.get(id);
    const prevData = (prev && prev.data) || {};
    const entry = layout ? layout[name] : null;
    let position;
    if (prev && prev.position && Number.isFinite(prev.position.x) && Number.isFinite(prev.position.y)) {
      position = { x: Number(prev.position.x), y: Number(prev.position.y) };
    } else if (entry && Number.isFinite(Number(entry.x)) && Number.isFinite(Number(entry.y))) {
      // 常驻布局表：已有记录的流按 layout[name] 落点（永不消费，重启/重投影后仍可复用）。
      position = { x: Number(entry.x), y: Number(entry.y) };
    } else {
      // 新流：视口中心附近错开落点（每行 3 个，行内 +40、行间 +40），对齐网格。
      const col = newIndex % 3;
      const row = Math.floor(newIndex / 3);
      position = snap({ x: center.x + col * 40, y: center.y + row * 40 });
      newIndex += 1;
    }

    // 可见性 canvas 与普通标签同源：直接来自 SE `tags`（`tagsToFields` 已含 canvas）。
    const fields = tagsToFields(s.tags);

    const data = { name };
    if (s.description != null && String(s.description) !== '') {
      data.description = String(s.description);
    }
    if (prevData.content != null && String(prevData.content) !== '') {
      data.content = String(prevData.content);
      data.contentState = 'loaded';
    } else if (prevData.contentState === 'loaded') {
      data.contentState = 'loaded'; // 已知空文件：保留“已加载”语义
    } else {
      data.contentState = 'unknown'; // 未加载：guard 不会写空
    }
    if (fields.length) data.fields = fields;
    if (prevData.scan) data.scan = prevData.scan;
    if (prevData.processes) data.processes = prevData.processes;
    // 外部文档来源（file_path 指向真实路径）是前端私有绑定，SE 不知情：
    // 必须随重投影回灌，否则 source 丢失后自动保存会按 graphs 惯例分配
    // `<图名>.streams/<名>.md` 副本，真实文件不再被写（planDocumentSources「已有 source 即保留」前提）。
    if (prevData.source && prevData.source.file_path) {
      data.source = {
        file_path: String(prevData.source.file_path),
        encoding: prevData.source.encoding ? String(prevData.source.encoding) : 'utf-8',
      };
    }
    // 期 15（B1a）：内部流的服务端绝对窗口元数据不是持久化真源，重投影时须从 prevData 带回，
    // 否则空闲 console 节点会退化为 absStart=0（历史分页失效）。仅在存在时透传。
    if (prevData.contentWindow) data.contentWindow = prevData.contentWindow;

    const out = { id, position, data };
    if (prev && prev.style) out.style = prev.style;
    else if (entry && (entry.width != null || entry.height != null)) {
      // 常驻布局表尺寸播种：prev 无 style 时按 layout[name] 播种渲染尺寸（只写有定义的键）。
      const style = {};
      if (entry.width != null && Number.isFinite(Number(entry.width))) style.width = Number(entry.width);
      if (entry.height != null && Number.isFinite(Number(entry.height))) style.height = Number(entry.height);
      if (Object.keys(style).length) out.style = style;
    }
    nodes.push(out);

    if (s.version != null) versions[name] = Number(s.version);
  });

  // 未确认缺失的 s-*：保留 prev 节点（含坐标/样式/data 缓存），等待对账/修复。
  // 只有显式 confirmedRemoved 才允许真正移出投影；本地 n-* 节点始终保留。
  if (keepMissing) {
    const prevList = Array.isArray(prevNodes) ? prevNodes : [];
    prevList.forEach((n) => {
      const id = String(n && n.id != null ? n.id : '');
      if (!id.startsWith(NODE_ID_PREFIX) || seen.has(id)) return;
      const name = streamNameFromId(id);
      if (name == null || confirmed.has(name)) return; // 已确认删除：不保留
      nodes.push(n);
      keptMissingIds.push(id);
      keptMissingNames.push(name);
    });
  }
  const kept = new Set(keptMissingIds);
  // 被确认删除的流：其 s-* 节点移出投影（本地 n-* 节点保留）。
  const removedIds = (Array.isArray(prevNodes) ? prevNodes : [])
    .map((n) => String(n.id))
    .filter((id) => id.startsWith(NODE_ID_PREFIX) && !seen.has(id) && !kept.has(id));

  return { nodes, removedIds, versions, keptMissingIds, keptMissingNames };
}

/**
 * 空投影可疑判定（B4 守卫，纯函数、零依赖）：rows 为空数组**且**当前画布仍存在
 * `s-*` 投影节点。用于识别「SE 重启后注册表为空 / 返回空列表」导致的异常清空——
 * 此时绝不能用空投影覆盖并删光既有 SE 投影节点（否则纯 SE 画布全空）。
 *
 * @param {Array} rows `stream.list`（或重试后）结果
 * @param {Array<{id}>} prevNodes 当前画布 canonical nodes
 * @returns {boolean} true = 疑似异常空列表，应拒绝落地
 */
export function isSuspiciousEmptyProjection(rows, prevNodes) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length !== 0) return false;
  const prev = Array.isArray(prevNodes) ? prevNodes : [];
  return prev.some((n) => n && String(n.id).startsWith(NODE_ID_PREFIX));
}

/**
 * file → SE 上推清单（纯函数，无副作用）：只纳入 `s-*` 流节点且**正文已知**
 * （`contentState === 'loaded'`）者，避免把 SE 投影节点（未加载、空正文）覆盖真实内容。
 * 返回 `{name,description,tags,content}` 数组；`tags` 由 `fields` 经 normalizeFields 派生。
 *
 * @param {Array<{id,data?}>} nodes 画布 canonical nodes
 * @returns {Array<{name:string,description:string,tags:Object,content:string}>}
 */
export function collectPushableContents(nodes) {
  const out = [];
  for (const n of Array.isArray(nodes) ? nodes : []) {
    const name = streamNameFromId(n.id);
    if (!name) continue;
    if (n.data?.contentState !== 'loaded') continue;
    const tags = {};
    normalizeFields(n.data?.fields).forEach((f) => {
      if (f.key) tags[f.key] = f.value;
    });
    out.push({
      name,
      description: n.data?.description == null ? '' : String(n.data.description),
      tags,
      content: n.data?.content == null ? '' : String(n.data.content),
    });
  }
  return out;
}
