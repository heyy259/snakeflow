// SE 边派生（期 5）：边 = source 流上的 `edge.<目标 name>` 标签（SE接线方案.md §3.1）。
//
// 纯函数、无 React / DOM 依赖，可在 Node 侧直接 import 做单测。
// - key 引用目标流的 **name**（契约合法字符，含 CJK），不是 title；
// - 目标 name 必须同时「存在于 stream.list」且「匹配 name 正则」，否则该边为**悬空边**；
// - 一对流之间至多一条边（同 key 覆盖）；边 id 稳定 `se-e-<source>__<target>`（重投影间不漂）。
//
// `edgeTagKey` / `edgeTagTarget` 复用期 4 的 `tagOps.js`，本模块只重导出，不重复实现。

import { edgeTagKey, edgeTagTarget } from './tagOps.js';
import { isValidStreamName } from './nameContract.js';

export { edgeTagKey, edgeTagTarget };

/**
 * 稳定边 id：`se-e-<source>__<target>`（source/target 均为流 name）。
 * 已知局限（方案指定 id 规则，登记不改）：SE name 允许连续 `_`，若 source 以 `_` 结尾且
 * target 以 `_` 开头，理论上与「source 少一个 `_` / target 多一个 `_`」的边撞 id；
 * 该碰撞仅影响 `seen` 去重与画布缓存引用，不改变 tag 真源（边仍各自持久化）。
 */
export function edgeId(source, target) {
  return `se-e-${String(source)}__${String(target)}`;
}

/**
 * 遍历 stream.list，把每流的 `edge.*` 标签派生为边；目标 name 不在 list 内或非法 → 悬空。
 *
 * @param {Array<{name:string, tags?:Object}>} list stream.list 结果
 * @returns {{edges:Array<{id:string,source:string,target:string,label:string}>,
 *            dangling:Array<{source:string,target:string,label:string}>}}
 *          source/target 为**流 name**（画布 node id 由调用方经 streamNodeId 映射）。
 */
export function deriveEdgesFromTags(list) {
  const rows = Array.isArray(list) ? list : [];
  const names = new Set();
  rows.forEach((s) => {
    if (s && s.name != null && s.name !== '') names.add(String(s.name));
  });

  const edges = [];
  const dangling = [];
  const seen = new Set();

  rows.forEach((s) => {
    if (!s || s.name == null || s.name === '') return;
    const source = String(s.name);
    if (!isValidStreamName(source)) return; // 非法 source（理论不可达）不派生
    const tags = s.tags && typeof s.tags === 'object' && !Array.isArray(s.tags) ? s.tags : {};
    Object.entries(tags).forEach(([key, value]) => {
      const target = edgeTagTarget(key);
      if (target == null || target === '') return;
      const label = value == null ? '' : String(value);
      if (names.has(target) && isValidStreamName(target)) {
        const id = edgeId(source, target);
        if (seen.has(id)) return; // 同 key 覆盖：至多一条
        seen.add(id);
        edges.push({ id, source, target, label });
      } else {
        dangling.push({ source, target, label });
      }
    });
  });

  return { edges, dangling };
}

/**
 * 收集指向 targetName 的入边引用（其它流上的 `edge.<targetName>` 标签）。
 * 复用 `edgeTagKey` 与 `hasOwnProperty` 判定，作为流 rename（含自环）/ delete（排除自环）共用口径。
 *
 * @param {Array<{name:string,tags?:Object}>} streams stream.list 结果
 * @param {string} targetName 被引用的目标流 name（ASCII）
 * @param {{excludeSelf?:boolean}} [opts] excludeSelf=true 时排除 targetName 自身（自环随流死亡，不纳入级联）
 * @returns {Array<{source:string,label:string}>} 每条入边：来源流 name + 标签值（null/undefined → ''）
 */
export function collectInboundRefs(streams, targetName, opts = {}) {
  const rows = Array.isArray(streams) ? streams : [];
  const target = String(targetName == null ? '' : targetName);
  const excludeSelf = !!(opts && opts.excludeSelf);
  const key = edgeTagKey(target);
  const out = [];
  rows.forEach((s) => {
    if (!s || typeof s !== 'object') return;
    if (s.name == null || s.name === '') return; // 缺失 name 的行跳过（无法定位来源流）
    const source = String(s.name);
    if (excludeSelf && source === target) return; // 自环：随流死亡
    const tags = s.tags && typeof s.tags === 'object' && !Array.isArray(s.tags) ? s.tags : {};
    if (Object.prototype.hasOwnProperty.call(tags, key)) {
      out.push({ source, label: tags[key] == null ? '' : String(tags[key]) });
    }
  });
  return out;
}
