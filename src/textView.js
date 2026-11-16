// 文本视图：纯逻辑图 ↔ 规范化 YAML（Y1 精简逻辑图）。
//
// 边界：零 DOM / 零 React / 零 fetch，仅依赖 `yaml` 与 `graph.js`（后者仅用纯排版/投影），
// 可被 App（浏览器）与脚本/端点（Node）复用。序列化走 `stringify`（不保注释）；
// 解析走 `parseDocument`（core schema、1.2、禁 merge、限别名）——非法/超限抛错而非静默。
import { stringify, parseDocument } from 'yaml';
import { toLogicGraph, isStreamVisible } from './graph.js';

const MAX_BYTES = 1_000_000; // 输入硬上限（防超限解析）

/** 画布节点/边 → 规范化 YAML 文本（逻辑图；仅可见流）。 */
export function serializeTextView(nodes, edges) {
  const list = Array.isArray(nodes) ? nodes : [];
  const elist = Array.isArray(edges) ? edges : [];
  const vis = list.filter((n) => isStreamVisible(n));
  const ids = new Set(vis.map((n) => String(n.id)));
  const visEdges = elist.filter((e) => ids.has(String(e.source)) && ids.has(String(e.target)));
  return stringify(toLogicGraph(vis, visEdges), { version: '1.2', aliasDuplicateObjects: false });
}

/** YAML 文本 → 对象（供 fromLogicGraph 校验）。非法/超限抛错。 */
export function parseTextView(text) {
  const s = String(text ?? '');
  if (new TextEncoder().encode(s).length > MAX_BYTES) throw new Error('文本视图内容超过 1MB 上限');
  const doc = parseDocument(s, { version: '1.2', schema: 'core', maxAliasCount: 100, merge: false });
  if (doc.errors.length) throw new Error(doc.errors[0].message);
  return doc.toJS();
}
