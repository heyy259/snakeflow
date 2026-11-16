// SE 级联应用层（期 5，SE接线方案.md §3.3「捕获 → 应用 → 校验」三段式的「应用」段）。
//
// rename / delete 的边键改写/清除**非原子**（SE 无事务）：一条 RPC 失败不得阻断整批，
// 否则调用方会在拿到重投影真源前 reject，`CascadeRepairDialog` 永远不会出现（§3.3-8）。
// 本模块逐条容错执行并把失败描述**返回**给上层——失败即成为一条 diff（actual = 错误），
// 由上层与重投影差异合并后喂给修复对话框；本模块自身绝不抛（只要传入的 client 行为正常）。
//
// 纯逻辑（mergeCascadeDiffs）+ RPC 包装（只依赖传入的 SEClient.call），无 React / DOM 依赖，
// 可在 Node 侧直接 import 做单测。**不是**第二条结构写路径——结构写路径仍是 App 的
// `seApplyTagChanges`；本模块只服务 rename/delete 的显式级联。

import { edgeTagKey } from './tagOps.js';
import { edgeId } from './edges.js';

/** 失败项 → `{stream, key, expected, actual}`（actual 为错误描述，供对话框展示）。 */
function asFailure(meta, err) {
  return {
    stream: meta.stream,
    key: meta.key,
    expected: meta.expected,
    actual: `RPC 失败：${(err && err.message) || String(err)}`,
  };
}

/**
 * 逐条执行 RPC；单条失败记入 failures 并继续，绝不抛出。
 * @param {Array<{meta:{stream,key,expected}, run:()=>Promise<any>}>} steps
 * @returns {Promise<Array<{stream,key,expected,actual}>>} 失败列表（空 = 全部成功）
 */
async function runTolerant(steps) {
  const failures = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (err) {
      failures.push(asFailure(step.meta, err));
    }
  }
  return failures;
}

/**
 * rename 级联应用：把每流上的 `edge.<oldName>` 改写为 `edge.<newName>`（保留原注释）。
 * 被改名流自身的自环（source === oldName）改写到新名。逐条容错。
 *
 * @param {{call:(m:string,p:object)=>Promise<any>}} client SE 客户端
 * @param {string} oldName 旧流 name
 * @param {string} newName 新流 name
 * @param {Array<{source:string, label:string}>} refs 捕获到的引用（含自身自环）
 * @param {(stream:string)=>void} [onBeforeWrite] 每条写 RPC 前就调用的钩子
 *   （如 markSelfWrite：TTL 仅 2s，必须就近标记，不能由调用方提前批量标记）；可选，缺省为 no-op
 * @returns {Promise<Array<{stream,key,expected,actual}>>} 失败列表
 */
export async function applyRenameCascade(client, oldName, newName, refs, onBeforeWrite) {
  const steps = (Array.isArray(refs) ? refs : []).map((r) => {
    const stream = r.source === oldName ? newName : r.source;
    const label = r.label == null ? '' : String(r.label);
    return {
      meta: { stream, key: edgeTagKey(newName), expected: label },
      run: async () => {
        if (typeof onBeforeWrite === 'function') onBeforeWrite(stream);
        await client.call('stream.remove_tag', { name: stream, key: edgeTagKey(oldName) });
        await client.call('stream.set_tag', { name: stream, key: edgeTagKey(newName), value: label });
      },
    };
  });
  return runTolerant(steps);
}

/**
 * delete 级联应用：清除指向 `target` 的入边标签 `edge.<target>`。逐条容错。
 *
 * @param {{call:(m:string,p:object)=>Promise<any>}} client SE 客户端
 * @param {string} target 被删流 name
 * @param {Array<{source:string}>} refs 捕获到的入边引用
 * @param {(stream:string)=>void} [onBeforeWrite] 每条写 RPC 前就调用的钩子
 *   （如 markSelfWrite：TTL 仅 2s，必须就近标记）；可选，缺省为 no-op
 * @returns {Promise<Array<{stream,key,expected,actual}>>} 失败列表
 */
export async function applyDeleteCascade(client, target, refs, onBeforeWrite) {
  const steps = (Array.isArray(refs) ? refs : []).map((r) => ({
    meta: { stream: r.source, key: edgeTagKey(target), expected: null },
    run: async () => {
      if (typeof onBeforeWrite === 'function') onBeforeWrite(r.source);
      await client.call('stream.remove_tag', { name: r.source, key: edgeTagKey(target) });
    },
  }));
  return runTolerant(steps);
}

/**
 * 级联后校验：把重投影真源与新边期望比对，返回 `{流, 键, 期望, 实际}` 差异列表。
 * expects: `[{source, target, label}]`；label === null 表示期望该边**不存在**。
 *
 * FIX-2：`projected` 为 false / 无 `edges` 才判「投影失败」（全部期望落为差异）；
 * 只要拿到真实投影（含非活动 tab 的投影）就逐条比对，绝不把「跳过」误判为失败。
 */
export function diffEdgeRefs(projected, expects) {
  const diffs = [];
  const edges = projected && Array.isArray(projected.edges) ? projected.edges : null;
  if (!edges) {
    (Array.isArray(expects) ? expects : []).forEach((x) =>
      diffs.push({ stream: x.source, key: edgeTagKey(x.target), expected: x.label, actual: '(重投影失败)' })
    );
    return diffs;
  }
  (Array.isArray(expects) ? expects : []).forEach((x) => {
    const id = edgeId(x.source, x.target);
    const got = edges.find((e) => e.id === id);
    if (x.label == null) {
      if (got) diffs.push({ stream: x.source, key: edgeTagKey(x.target), expected: null, actual: got.label });
    } else if (!got) {
      diffs.push({ stream: x.source, key: edgeTagKey(x.target), expected: x.label, actual: null });
    } else if (String(got.label || '') !== String(x.label || '')) {
      diffs.push({ stream: x.source, key: edgeTagKey(x.target), expected: x.label, actual: got.label });
    }
  });
  return diffs;
}

/**
 * 合并「重投影差异」与「应用失败」：失败项以其错误描述覆盖同一 `stream+key` 的通用差异，
 * 保证对话框展示到真实原因，且不重复列出同一条边。
 *
 * @param {Array<{stream,key,expected,actual}>} diffs 重投影差异（diffEdgeRefs 产物）
 * @param {Array<{stream,key,expected,actual}>} failures 应用失败
 * @returns {Array<{stream,key,expected,actual}>}
 */
export function mergeCascadeDiffs(diffs, failures) {
  const failKeys = new Set((failures || []).map((f) => `${f.stream}\u0000${f.key}`));
  const kept = (diffs || []).filter((d) => !failKeys.has(`${d.stream}\u0000${d.key}`));
  return [...kept, ...(failures || [])];
}
