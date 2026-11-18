// pending → SE 流自动提升（方案 §4.2）：纯逻辑抽离，零 React / 零 DOM / 零 IO，
// Node 侧可直接 import 做单测；RPC 与画布落地全部留在 App.jsx（promoteLocalNode）。
//
// 定位：画布节点分 `s-<流名>`（SE stream.list 投影，唯一结构真源）与 pending 节点
// （`streamNameFromId(id) === null`，含 `n-*` 本地草稿）。本模块只回答「提升一个 pending
// 节点需要哪些派生值」：新流名（含去重后缀）、要写入的 tags（fields + 边标签集合）、
// 以及换 id 后本地边的重写结果。全部为幂等纯函数，便于把最容易出错的名字/边推导钉死在单测里。
//
// 纪律（与 App 接线同口径，见方案 §4.2）：
// - 名字推导复用 `toStreamName`（nameContract 真源镜像），taken = 画布全部 s-* 名 ∪
//   SE stream.list 名 ∪ 本次批量已分配名；冲突加 `_2` 后缀（允许，但调用方须 notify 改名）；
// - 边标签只在**两端都已提升为 s-***（或另一端已存在）时生成；目标尚未提升则跳过，
//   待目标提升时由其 incidentEdgeTagOps 补写（source 侧），绝不留悬空边。

import { streamNodeId, streamNameFromId } from './streams.js';
import { toStreamName } from './nameContract.js';
import { edgeTagKey } from './tagOps.js';

/** 节点是否为 pending（非 `s-` 投影节点）。 */
export function isPendingNode(node) {
  return !!node && streamNameFromId(node && node.id) === null;
}

/** 过滤出画布上的全部 pending 节点（保持原顺序，串行提升用）。 */
export function pendingNodes(nodes) {
  return (Array.isArray(nodes) ? nodes : []).filter(isPendingNode);
}

/**
 * 节点显示名：`data.name` 优先，空则回落 `data.title`（与 toCanvasGraph 口径一致）。
 * @returns {string}
 */
export function displayNameOf(node) {
  const d = node && node.data ? node.data : {};
  const name = d.name != null ? String(d.name) : '';
  if (name !== '') return name;
  const title = d.title != null ? String(d.title) : '';
  return title;
}

/**
 * 组装 taken 名集合：画布全部 `s-*` 流名 ∪ extra（SE stream.list 名 / 本次批量已分配名）。
 * @param {Array} nodes 画布节点
 * @param {Iterable<string>|Array<string>} [extra]
 * @returns {Set<string>}
 */
export function collectTakenNames(nodes, extra = []) {
  const set = new Set();
  (Array.isArray(nodes) ? nodes : []).forEach((n) => {
    const nm = streamNameFromId(n && n.id);
    if (nm !== null && nm !== '') set.add(nm);
  });
  const list = extra instanceof Set ? extra : Array.isArray(extra) ? extra : Array.from(extra || []);
  list.forEach((x) => {
    if (x != null && String(x) !== '') set.add(String(x));
  });
  return set;
}

/**
 * 派生提升后的流名。`renamed` 为 true 表示原始显示名经推导发生变化（非法字符折叠 / 空名
 * 回退 / 冲突加 `_2` 后缀）——调用方须在 notify 中说明改名。
 * @param {{id?:string,data?:object}} node pending 节点
 * @param {Iterable<string>|Array<string>|Set<string>} [taken]
 * @returns {{name:string, raw:string, renamed:boolean}}
 */
export function derivePromoteName(node, taken = []) {
  const raw = displayNameOf(node);
  const name = toStreamName(raw, taken);
  return { name, raw, renamed: name !== raw };
}

/**
 * 换 id 后重写本地边：把 source/target === oldId 的端点替换为 newId。
 * 仅改端点（`e-<seq>` 边 id 不含节点 id，无需重建；SE 派生边在随后重投影时按
 * `edgeId(source,target)` 重建）。纯函数，返回新数组（无命中时原样返回）。
 */
export function rewriteEdgesForIdSwap(edges, oldId, newId) {
  const from = String(oldId);
  const to = String(newId);
  const list = Array.isArray(edges) ? edges : [];
  let changed = false;
  const out = list.map((e) => {
    if (!e) return e;
    const s = String(e.source);
    const t = String(e.target);
    if (s !== from && t !== from) return e;
    changed = true;
    return { ...e, source: s === from ? to : e.source, target: t === from ? to : e.target };
  });
  return changed ? out : list;
}

/**
 * 换节点 id，并把已经由并发重投影落地的新 id 合并成唯一节点。
 *
 * 创建流会触发 stream.on_change，重投影可能先于 promote 的本地换 id 落地：
 * 此时画布同时存在 `n-*` 草稿与 `s-<name>` 投影。若再机械替换旧 id，就会产生
 * 两颗同 id 节点并触发 React 重复 key 警告。这里以新 id 的原位置为准，保留旧
 * 草稿的顺序；无旧节点时返回原数组，保证重复调用幂等。
 *
 * @param {Array} nodes 画布节点
 * @param {string} oldId pending 节点 id
 * @param {string} newId SE 流节点 id
 * @param {object} [dataPatch] 提升成功后要覆盖的数据
 * @returns {Array} 节点 id 唯一的新数组；无需替换时原样返回
 */
export function mergePromotedNode(nodes, oldId, newId, dataPatch = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  const from = String(oldId);
  const to = String(newId);
  const pending = list.find((n) => n && String(n.id) === from);
  if (!pending) return list;
  const projected = list.find((n) => n && String(n.id) === to);
  const merged = {
    // 投影可能先落地，但本地草稿仍是最新交互态；保留其坐标/尺寸/选中态，
    // 同时继承投影独有的运行时字段（如 fresh/measured）。
    ...(projected || {}),
    ...pending,
    id: to,
    data: {
      ...((projected && projected.data) || {}),
      ...(pending.data || {}),
      ...(dataPatch && typeof dataPatch === 'object' ? dataPatch : {}),
    },
  };
  const out = [];
  let inserted = false;
  for (const node of list) {
    if (!node) continue;
    const id = String(node.id);
    if (id === from || id === to) {
      if (!inserted) {
        out.push(merged);
        inserted = true;
      }
      continue;
    }
    out.push(node);
  }
  return out;
}

/**
 * 计算与刚提升节点相关的边标签写操作（换 id + 重投影之间调用）。
 *
 * 规则（边 = source 流的 `edge.<目标 name>` 标签）：
 * - source === nodeId：目标已解析为流名 → 写到**本节点**新流（含自环：target===nodeId 时
 *   resolveName(nodeId) 即自身 name）；
 * - target === nodeId：source 已解析为流名 → 写到**该 source 流**（补写「先提升的 source
 *   → 后提升的本节点」这条边）；
 * - 另一端仍为 pending（resolveName 返回 null）→ 跳过，待其提升时补齐。
 *
 * @param {{nodeId:string, name:string, edges:Array,
 *          resolveName:(nodeId:string)=>string|null}} p
 * @returns {{selfTags:Object<string,string>, remote:Array<{source:string,key:string,value:string}>}}
 */
export function incidentEdgeTagOps({ nodeId, name, edges, resolveName }) {
  const id = String(nodeId);
  const selfTags = {};
  const remote = [];
  const resolve = typeof resolveName === 'function' ? resolveName : (n) => streamNameFromId(n);
  (Array.isArray(edges) ? edges : []).forEach((e) => {
    if (!e) return;
    const s = String(e.source);
    const t = String(e.target);
    const label = e.label == null ? '' : String(e.label);
    if (s === id) {
      const tn = resolve(t);
      if (tn) selfTags[edgeTagKey(tn)] = label;
    } else if (t === id) {
      const sn = resolve(s);
      if (sn) remote.push({ source: sn, key: edgeTagKey(name), value: label });
    }
  });
  return { selfTags, remote };
}

/** 便于测试与调用方复用：SE name → 画布节点 id（重导出，避免多处 import）。 */
export { streamNodeId };
