import dagre from 'dagre';
import { CANVAS_TAG_KEY, EDGE_TAG_PREFIX, isReservedTagKey } from './se/tagOps.js';

/**
 * 节点默认宽度：既是画布上 agent 节点的缺省宽度（无自定义宽度时使用），
 * 也作为 dagre 排版的预估宽度。节点高度始终由内容自适应，从不固定。
 */
export const NODE_W = 220;
export const NODE_H = 44;

const toStr = (v) => (v == null ? '' : String(v));
const trimStr = (v) => toStr(v).trim();

/** 节点名称读取（单一 name 模型；旧 `title` 兼容回落一次）。 */
const nodeNameOf = (data) => {
  const d = data && typeof data === 'object' ? data : {};
  return d.name != null ? toStr(d.name) : d.title != null ? toStr(d.title) : '';
};

/**
 * 系统保留标签键前缀（期 5 预建，本期只导出备用，不接入任何 UI 过滤）：
 * - `canvas`：流可见性（精确键）；
 * - `edge.`：边/连线注释（前缀键，见 SE接线方案.md §3.1）。
 * 所有写 tag 的入口必须拒绝/隔离用户手写这些键，否则普通标签会被解释为
 * 可见性/边（Oracle 指出的前缀碰撞面）。唯一判定实现见 se/tagOps.js。
 */
export const RESERVED_TAG_PREFIXES = [CANVAS_TAG_KEY, EDGE_TAG_PREFIX];

/**
 * 判定标签键是否落入系统保留前缀（canvas 精确匹配；edge. 前缀匹配）。
 * 未接入 UI，仅作为写入口守卫的共用谓词。唯一实现见 se/tagOps.js。
 */
export { isReservedTagKey };

/**
 * 清洗 fields 数组：非数组返回 []；项非对象跳过；
 * key/value 均转字符串并 trim；两项都空的行跳过。
 */
export function normalizeFields(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  raw.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const key = trimStr(item.key);
    const value = trimStr(item.value);
    if (!key && !value) return;
    out.push({ key, value });
  });
  return out;
}

/** 取 fields 数组中某个 key 的值（缺省返回 ''）。 */
export function fieldValue(fields, key) {
  if (!Array.isArray(fields)) return '';
  const hit = fields.find((f) => f && f.key === key);
  return hit ? trimStr(hit.value) : '';
}

/**
 * 流可见性唯一判断口径：fields 中 canvas 键的值 !== 'false' 即显示（缺省显示）。
 * 兼容画布节点（data.fields）与逻辑节点（fields）两种形态。
 */
export function isStreamVisible(node) {
  const fields = node?.data?.fields ?? node?.fields;
  return fieldValue(fields, 'canvas') !== 'false';
}

/**
 * 边的 hidden 由两端点流的 canvas 标签派生：任一端点不可见 → 边 hidden。
 * 返回新数组；未变化的边保留原引用。
 */
export function deriveEdgeHidden(edges, nodes) {
  const vis = new Map((Array.isArray(nodes) ? nodes : []).map((n) => [String(n.id), isStreamVisible(n)]));
  return (Array.isArray(edges) ? edges : []).map((e) => {
    const hidden = !(vis.get(String(e.source)) ?? true) || !(vis.get(String(e.target)) ?? true);
    return e.hidden === hidden ? e : { ...e, hidden };
  });
}

/**
 * 把上一版画布节点的 React Flow 渲染态（measured）带到本版节点上。
 * 只服务“同一张图的结构重投影”：SE 是结构真源，但 measured 属于 React Flow 内部态，
 * 投影层重建对象时不得丢弃它（否则 nodesInitialized 抖动 / 可见性闪断 / fit 竞态）。
 * 规则：同 id + 同 type + prev 可见 + prev.measured 有效 + 渲染尺寸未变才携带；不改入参。
 */
export function carryNodeMeasurements(prevNodes, nextNodes) {
  const prevList = Array.isArray(prevNodes) ? prevNodes : [];
  const nextList = Array.isArray(nextNodes) ? nextNodes : [];
  const prevById = new Map(prevList.map((n) => [String(n.id), n]));
  let changed = false;
  const out = nextList.map((next) => {
    const prev = prevById.get(String(next.id));
    if (!prev) return next;
    const mw = Number(prev.measured?.width);
    const mh = Number(prev.measured?.height);
    if (!(mw > 0) || !(mh > 0)) return next;
    if (String(prev.type || '') !== String(next.type || '')) return next;
    if (!isStreamVisible(prev)) return next;
    const prevW = prev.style?.width;
    const nextW = next.style?.width;
    if (Number.isFinite(prevW) && Number.isFinite(nextW) && prevW !== nextW) return next;
    const prevH = prev.style?.height;
    const nextH = next.style?.height;
    if (Number.isFinite(prevH) && Number.isFinite(nextH) && prevH !== nextH) return next;
    changed = true;
    return { ...next, measured: { width: mw, height: mh } };
  });
  return changed ? out : nextList;
}

/**
 * 把上一版画布节点的选中态带到本版**仍可见**的同 id 节点上。
 * 重投影以 SE 真源重建结构，selected 属于用户交互态而非结构真源；若投影层不携带，
 * 扫描/内容事件触发的重投影会静默取消选中并卸载控制行（ScanBar 暂停按钮竞态）。
 * 规则：同 id + prev.selected + prev/next 均可见；不改入参。隐藏节点（canvas=false）
 * 绝不因旧 selected 重新获得选中。
 */
export function carryNodeSelection(prevNodes, nextNodes) {
  const prevList = Array.isArray(prevNodes) ? prevNodes : [];
  const nextList = Array.isArray(nextNodes) ? nextNodes : [];
  const prevById = new Map(prevList.map((n) => [String(n.id), n]));
  let changed = false;
  const out = nextList.map((next) => {
    const prev = prevById.get(String(next.id));
    if (!prev || prev.selected !== true || next.selected === true) return next;
    if (!isStreamVisible(prev) || !isStreamVisible(next)) return next;
    changed = true;
    return { ...next, selected: true };
  });
  return changed ? out : nextList;
}

/**
 * 画布图 → 纯逻辑图（供文件保存 / 文本视图使用）。
 * 剥离 position / type / animated / edge id 等一切渲染信息，
 * content 与 edge.label 仅在非空时输出。
 */
export function toLogicGraph(nodes, edges) {
  const list = Array.isArray(nodes) ? nodes : [];
  const lcNodes = list
    .filter((n) => n && n.id != null)
    .map((n) => {
      const data = n.data || {};
      const out = { id: toStr(n.id), name: nodeNameOf(data) };
      const content = trimStr(data.content);
      if (content) out.content = content;
      const description = trimStr(data.description);
      if (description) out.description = description;
      const fields = normalizeFields(data.fields);
      if (fields.length) out.fields = fields;
      return out;
    });
  const elist = Array.isArray(edges) ? edges : [];
  const lcEdges = elist
    .filter((e) => e && e.source != null && e.target != null)
    .map((e) => {
      const out = { source: toStr(e.source), target: toStr(e.target) };
      const label = trimStr(e.label);
      if (label) out.label = label;
      return out;
    });
  return { nodes: lcNodes, edges: lcEdges };
}

/**
 * 纯逻辑图（或旧的 React Flow 文件格式）→ 画布图。
 * 宽容地忽略 position / type / animated / edge id 等多余字段，
 * 只提取 id/name/content/source/target/label，并用 dagre 重新排版。
 * 硬错误（非对象、缺 nodes、节点缺 id/name）直接 throw 中文错误；
 * 悬空连线等软问题记录到 warnings。
 */
export function fromLogicGraph(parsed) {
  const warnings = [];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('数据格式无效：顶层必须是 JSON 对象，例如 {"nodes":[...],"edges":[...]}');
  }
  if (!Array.isArray(parsed.nodes)) {
    throw new Error('数据格式无效：缺少 nodes 数组');
  }

  const nodes = [];
  const seenIds = new Set();
  parsed.nodes.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`数据格式无效：nodes[${i}] 不是有效对象`);
    }
    const id = trimStr(raw.id);
    if (!id) {
      throw new Error(`数据格式无效：nodes[${i}] 缺少 id`);
    }
    if (seenIds.has(id)) {
      warnings.push(`节点 ${id} 重复出现，已忽略后一个`);
      return;
    }
    seenIds.add(id);
    const data = raw.data || {};
    // 单一 name 模型：`name` 优先，旧 `title` 兼容回落一次。
    const nameRaw = raw.name ?? raw.title ?? data.name ?? data.title;
    if (nameRaw == null) {
      throw new Error(`节点 ${id} 缺少 name（请提供节点名称）`);
    }
    const content = trimStr(raw.content ?? data.content);
    const description = trimStr(raw.description ?? data.description);
    const fields = normalizeFields(raw.fields ?? data.fields);
    nodes.push({ id, name: toStr(nameRaw), content, description, fields });
  });

  const edges = [];
  if (parsed.edges != null) {
    if (!Array.isArray(parsed.edges)) {
      throw new Error('数据格式无效：edges 必须是数组');
    }
    parsed.edges.forEach((e, i) => {
      if (!e || typeof e !== 'object') {
        warnings.push(`edges[${i}] 无效，已忽略`);
        return;
      }
      const source = trimStr(e.source);
      const target = trimStr(e.target);
      if (!source || !target) {
        warnings.push(`edges[${i}] 缺少 source 或 target，已忽略`);
        return;
      }
      if (!seenIds.has(source) || !seenIds.has(target)) {
        warnings.push(`连线 ${source} → ${target} 引用了不存在的节点，已忽略`);
        return;
      }
      const label = trimStr(e.label);
      edges.push({ source, target, label });
    });
  }

  const rfNodes = nodes.map((n) => ({
    id: n.id,
    type: 'agent',
    data: {
      name: n.name,
      ...(n.content ? { content: n.content } : {}),
      ...(n.description ? { description: n.description } : {}),
      ...(n.fields.length ? { fields: n.fields } : {}),
    },
  }));
  const rfEdges = edges.map((e, i) => ({
    id: `e-${i + 1}`,
    type: 'agent',
    source: e.source,
    target: e.target,
    ...(e.label ? { label: e.label } : {}),
  }));
  const graph = { nodes: layoutGraph(rfNodes, rfEdges), edges: rfEdges };
  return { graph, warnings };
}

/**
 * 用 dagre 自上而下排版：nodesep 60 / ranksep 80，节点约 172x40。
 * 会整体平移到 (padding, padding) 起点，返回带 position 的新节点数组。
 */
export function layoutGraph(nodes, edges) {
  const nlist = Array.isArray(nodes) ? nodes : [];
  const elist = Array.isArray(edges) ? edges : [];
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 60, ranksep: 80, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  nlist.forEach((n) => g.setNode(n.id, { width: NODE_W, height: NODE_H }));
  const seen = new Set();
  elist.forEach((e) => {
    if (!e || e.source == null || e.target == null) return;
    const key = `${e.source}\u0000${e.target}`;
    if (!seen.has(key)) {
      seen.add(key);
      g.setEdge(e.source, e.target);
    }
  });
  dagre.layout(g);

  const placed = nlist.map((n) => {
    const pos = g.node(n.id);
    const position = pos
      ? { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 }
      : { x: 0, y: 0 };
    return { ...n, position };
  });
  if (placed.length > 0) {
    const minX = Math.min(...placed.map((n) => n.position.x));
    const minY = Math.min(...placed.map((n) => n.position.y));
    const dx = 24 - minX;
    const dy = 24 - minY;
    if (dx || dy) {
      placed.forEach((n) => {
        n.position = { x: n.position.x + dx, y: n.position.y + dy };
      });
    }
  }
  return placed;
}
