// Task6 运行时边对齐（方案 §4.5）：纯逻辑抽离，零 React / 零 DOM / 零 IO，
// Node 侧可直接 import 做单测；RPC（stream.list / set_tag）与重投影留在 App.jsx。
//
// 背景：期 5 起边 = source 流上的 `edge.<目标 name>` 标签（SE接线方案.md §3.1）；
// 两端均 `s-*` 的边由 `deriveEdgesFromTags` 从 SE tags 重建。T1 迁移把历史边双写进
// `.se.json` 的 `streams[].tags["edge.*"]` 与 `edges` 数组，但运行时没有通路把文档
// `edges` 真正写进 SE（tagsToFields 过滤 `edge.*` → collectPushableContents 不产边标签）。
// 本模块只回答「文档里已有、SE 尚缺的 s-*↔s-* 边，需要补写哪些 tag」。
//
// 纪律：
// - 只处理两端 `streamNameFromId` 均非空的边（一端 pending / n-* → 交给 promote 通路）；
// - source 与 target 都必须存在于 SE stream.list（否则写入只会是悬空引用 / 无法读 tags）；
// - source 已有同名 `edge.<target>` 标签 → 幂等跳过（不比较值，键存在即视作已对齐）。

import { streamNameFromId } from './streams.js';
import { edgeTagKey } from './tagOps.js';

/**
 * 汇总文档里的边来源（**两处并集**）：canonical / v3.0 顶层 `edges` + manifest
 * `system.graph.edges`。parseDocument 后 canonical graph 的边落在顶层 `edges`
 * （见 src/document.js:356-375），此处额外读 `system.graph.edges` 以兼容直接传原始
 * 文档（未经 parseDocument）的调用方。按 `source\0target` 去重（同向重复取首条）。
 *
 * @param {{edges?:Array, system?:{graph?:{edges?:Array}}}} doc 文档 / canonical graph
 * @returns {Array<{source:string, target:string, label:string}>} source/target 为节点 id（s-*）
 */
export function collectDocumentEdges(doc) {
  const out = [];
  const seen = new Set();
  const push = (arr) => {
    (Array.isArray(arr) ? arr : []).forEach((e) => {
      if (!e || e.source == null || e.target == null) return;
      const source = String(e.source);
      const target = String(e.target);
      if (!source || !target) return;
      const dedupe = `${source}\u0000${target}`;
      if (seen.has(dedupe)) return;
      seen.add(dedupe);
      out.push({ source, target, label: e.label == null ? '' : String(e.label) });
    });
  };
  push(doc && doc.edges); // canonical graph / v3.0 顶层
  push(doc && doc.system && doc.system.graph && doc.system.graph.edges); // manifest
  return out;
}

/**
 * 「文档边 + SE stream.list → 待写 tag 操作清单」决策逻辑（纯函数）。
 *
 * 逐边：
 * - 两端 `streamNameFromId` 均非空（否则跳过：一端是 pending / 非 SE 节点）；
 * - source 流必须在 SE list 内（否则无法读其 tags，也写不进）；
 * - target 流必须在 SE list 内（否则写入只会形成悬空引用，画布不产生边）；
 * - source 已有 `edge.<target>` 键 → 幂等跳过；
 * - 产出 `{source: 流名, key: 'edge.<目标流名>', value: label}`（无 label → ''）。
 * 同一 `source + key` 只产出一条（文档双写 / 重复边去重）。
 *
 * @param {Array<{source:string, target:string, label?:string}>} edges 文档边（节点 id）
 * @param {Array<{name:string, tags?:Object}>} streams SE stream.list 结果
 * @returns {Array<{source:string, key:string, value:string}>}
 */
export function planEdgeAlignOps(edges, streams) {
  const rows = Array.isArray(streams) ? streams : [];
  const tagsByName = new Map();
  rows.forEach((s) => {
    if (!s || s.name == null || s.name === '') return;
    const tags = s.tags && typeof s.tags === 'object' && !Array.isArray(s.tags) ? s.tags : {};
    tagsByName.set(String(s.name), tags);
  });

  const ops = [];
  const seen = new Set();
  (Array.isArray(edges) ? edges : []).forEach((e) => {
    if (!e) return;
    const sName = streamNameFromId(e.source);
    const tName = streamNameFromId(e.target);
    if (!sName || !tName) return; // 非 s-*（pending / 混合）端点跳过
    const tags = tagsByName.get(sName);
    if (!tags) return; // source 流不在 SE
    if (!tagsByName.has(tName)) return; // target 流不在 SE（避免悬空边）
    const key = edgeTagKey(tName);
    if (Object.prototype.hasOwnProperty.call(tags, key)) return; // 已对齐 → 幂等跳过
    const dedupe = `${sName}\u0000${key}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    ops.push({ source: sName, key, value: e.label == null ? '' : String(e.label) });
  });
  return ops;
}
