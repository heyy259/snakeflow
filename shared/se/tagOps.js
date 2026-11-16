// SE tag 快照 / 差分 / 还原（期 4，SE接线方案.md §3.4 快照-差分还原模型）。
//
// 目的：结构操作（可见性 / 节点 fields / 期 5 的边）在 SE 侧以 tag 承载；撤销时
// **不补发逆操作**（对多步级联不可靠），而是「操作前捕获受影响流的完整 tag dict →
// undo 时重读服务端当前 tags → 算最小差量 set/remove → 还原」。
//
// 纯逻辑（diffTags / edgeTagKey / edgeTagTarget）无 React / DOM 依赖，可在 Node 侧
// 直接 import 做单测；RPC 包装只依赖传入的 SEClient（call(method, params)）。
//
// 事实（SE 侧已核实）：
// - `stream.get_metadata{name}` → `{name,title,description,tags,version}`；
// - `stream.set_tag{name,key,value}` / `stream.remove_tag{name,key}` 零校验、非版本化；
// - `set_tag/remove_tag` **会推送** `stream.on_change` 的 `change.type='metadata'` 事件
//   （`change.field='tags'`，**不推进 version**）。该 metadata 事件按字段细分处理：
//   触及 `canvas`/`edge.*` 结构标签即结构对账，普通标签仅更新缓存——见 src/se/classify.js。
//   （原注释"不触发 on_change"已被 2026-09-23 逐行核实证伪，详见
//    `.sisyphus/plans/se-newstream-governance-v2.md` §0.6。）

/** 边标签键前缀（`edge.<目标流 name>`，期 5 边 = 流标签的编码）。 */
export const EDGE_TAG_PREFIX = 'edge.';

/** 流 name → 边标签键（`edge.<name>`）。引用的是 name（契约合法字符，含 CJK），不是 title。 */
export function edgeTagKey(name) {
  return `${EDGE_TAG_PREFIX}${String(name == null ? '' : name)}`;
}

/** 边标签键 → 目标流 name；非 `edge.` 前缀返回 null。 */
export function edgeTagTarget(key) {
  const k = String(key == null ? '' : key);
  return k.startsWith(EDGE_TAG_PREFIX) ? k.slice(EDGE_TAG_PREFIX.length) : null;
}

/** 画布可见性保留键（精确匹配）。 */
export const CANVAS_TAG_KEY = 'canvas';

/**
 * 系统保留标签键判定（唯一真源）：`canvas` 精确命中，或 `edge.` 前缀命中。
 * 所有写 tag 的入口必须拒绝/隔离用户手写这些键，否则普通标签会被解释为
 * 可见性/边（前缀碰撞面）。classify 的结构标签判定、graph.js 的写入口守卫、
 * packageImport 的保留键分桶统一走本函数。
 */
export function isReservedTagKey(key) {
  const k = String(key == null ? '' : key);
  return k === CANVAS_TAG_KEY || k.startsWith(EDGE_TAG_PREFIX);
}

/** 归一化 tag dict：非对象按空 dict（SE 缺失字段 / 非法输入容错）。 */
function asTagDict(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw;
}

/**
 * 捕获若干流的完整 tag dict（结构操作前快照）。
 *
 * @param {{call:(m:string,p:object)=>Promise<any>}} client SE 客户端
 * @param {Iterable<string>|string} names 目标流 name 集合
 * @returns {Promise<Object<string, Object<string,string>|null>>} name → tags dict；读取失败/流不存在记 null
 */
export async function captureStreamTags(client, names) {
  const list = Array.isArray(names)
    ? names
    : names == null
      ? []
      : [names];
  const out = {};
  for (const raw of list) {
    const name = String(raw == null ? '' : raw);
    if (!name) continue;
    try {
      const meta = await client.call('stream.get_metadata', { name });
      out[name] = meta && meta.tags != null ? asTagDict(meta.tags) : {};
    } catch (err) {
      out[name] = null; // 流不存在 / RPC 失败：无法还原其 tag 态
    }
  }
  return out;
}

/**
 * 纯差分：算出「把 current 还原到 before」所需的最小 tag 变更（不做逆操作补发）。
 * - before 有而 current 缺 / 值不同 → set；
 * - current 有而 before 无 → remove；
 * - 值相同 → 不动。
 *
 * @param {Object<string,string>|null} before 目标快照 tag dict
 * @param {Object<string,string>|null} current 服务端当前 tag dict
 * @returns {{set:Object<string,string>, remove:string[]}}
 */
export function diffTags(before, current) {
  const b = asTagDict(before);
  const c = asTagDict(current);
  const set = {};
  const remove = [];
  for (const k of Object.keys(b)) {
    const v = b[k] == null ? '' : String(b[k]);
    if (!(k in c) || String(c[k] == null ? '' : c[k]) !== v) set[k] = v;
  }
  for (const k of Object.keys(c)) {
    if (!(k in b)) remove.push(k);
  }
  return { set, remove };
}

/**
 * 快照-差分还原：对 before 里每个流重读当前 tags、算差量、逐条 `set_tag`/`remove_tag`。
 * 逐流独立容错——单流失败不阻断其余流；返回逐流结果供上层提示。
 *
 * @param {{call:(m:string,p:object)=>Promise<any>}} client SE 客户端
 * @param {Object<string, Object<string,string>|null>} before captureStreamTags 的产物
 * @returns {Promise<Array<{name:string, changed:boolean, error?:string}>>}
 */
export async function applyTagSnapshot(client, before) {
  const snapshot = asTagDict(before);
  const out = [];
  for (const name of Object.keys(snapshot)) {
    const target = snapshot[name];
    try {
      let current = {};
      try {
        const meta = await client.call('stream.get_metadata', { name });
        current = meta && meta.tags != null ? asTagDict(meta.tags) : {};
      } catch (err) {
        // 流现已不存在：无法「还原到不存在」，跳过（changed=false，非错误）。
        out.push({ name, changed: false, error: 'missing' });
        continue;
      }
      if (target == null) {
        // 捕获时流不存在（null）：无法删除流来还原「缺失」态，跳过。
        out.push({ name, changed: false });
        continue;
      }
      const { set, remove } = diffTags(target, current);
      let changed = false;
      for (const [k, v] of Object.entries(set)) {
        await client.call('stream.set_tag', { name, key: k, value: v });
        changed = true;
      }
      for (const k of remove) {
        await client.call('stream.remove_tag', { name, key: k });
        changed = true;
      }
      out.push({ name, changed });
    } catch (err) {
      out.push({ name, changed: false, error: (err && err.message) || String(err) });
    }
  }
  return out;
}
