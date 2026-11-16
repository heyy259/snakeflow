// 期 13（Phase 0）SE 通知分类纯函数：`stream.on_change` params → 处置意图。
//
// 职责：把一条 on_change 通知归一为四类之一（永远返回带 `kind` 的对象）：
// - ignore     ：畸形 / 未知通知，直接丢弃；
// - metadata   ：仅 title / description / 普通标签变化 → 缓存级更新（免全量重投影）；
// - structural ：结构变化（建流 / 删流 / 改名 / 结构标签变化）→ 触发全量重投影；
// - content    ：正文变化（append 走增量读；其余已知正文事件走全量读）。
//
// BLOCKER B1 修复（本模块存在的核心理由）：
//   SE 的 `set_tag/remove_tag` **会**推送 `change.type === 'metadata'` 事件
//   （`edge.*` 建边与 `canvas` 可见性切换皆然）。若把 metadata 一律当缓存级，
//   则这两类**结构标签**变更不会触发重投影，画布与 SE 真源脱节。故：metadata
//   事件只要触及结构标签，必须判为 structural（reason 'metadata-structural'）。
//
// 事件类型口径（与 SE 源码/方案核对）：
// - `metadata`：`{ metadata:{name,title,description,tags,version} }`；
// - `append`：正文追加（唯一增量模式）；
// - `set / insert / delete / replace / rollback / append_cancelled`：正文全量语义；
// - `rename / created / deleted`：流生命周期结构事件；
// - `replace_range / replace_lines / delete_lines` 等是**方法名**不是事件类型，
//   真到达时按 unknown → ignore（不得误判为正文全量）。
//
// 纯逻辑：无 React / DOM / SEClient / 网络依赖，可在 Node 侧直接 import 单测。

import { CANVAS_TAG_KEY, isReservedTagKey } from './tagOps.js';

export { CANVAS_TAG_KEY };

/**
 * 结构标签键判定：`canvas` 精确命中，或 `edge.` 前缀命中；其余（普通用户标签）否。
 * 与保留键同义——唯一实现见 tagOps.isReservedTagKey。
 */
export const isStructuralTagKey = isReservedTagKey;

/**
 * tag dict 是否触及结构标签：非对象 / 数组 → false；任一键命中即 true。
 * 只看键不看值——`canvas:'false'`（隐藏）同样是结构操作，必须重投影。
 */
export function touchesStructuralTags(tags) {
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return false;
  return Object.keys(tags).some((key) => isStructuralTagKey(key));
}

/** 正文全量语义的事件类型（append 之外的已知正文事件 + 取消追加）。 */
const FULL_CONTENT_TYPES = ['set', 'insert', 'delete', 'replace', 'rollback', 'append_cancelled'];

/**
 * 分类单条 `stream.on_change` 通知。
 *
 * @param {any} params 通知参数，形如 `{ name, change:{ type, metadata?, ... } }`
 * @returns {{kind:string, reason?:string, mode?:string, structural?:boolean,
 *            name?:string, metadata?:any, changeType?:string}}
 *   - `{kind:'ignore', reason}`：params 缺失 / name 为空 / change.type 缺失或未知；
 *   - `{kind:'metadata', structural:false, name, metadata}`：普通元数据变化；
 *   - `{kind:'structural', reason:'metadata-structural', name}`：metadata 触结构标签；
 *   - `{kind:'structural', reason:'rename'|'created'|'deleted', name}`：生命周期；
 *   - `{kind:'content', mode:'append'|'full', name, changeType}`：正文变化。
 */
export function classifyStreamChange(params) {
  if (!params || typeof params !== 'object') {
    return { kind: 'ignore', reason: 'missing-params' };
  }
  if (!params.name) {
    return { kind: 'ignore', reason: 'missing-name' };
  }
  const name = String(params.name);
  const change = params.change;
  if (!change || typeof change !== 'object' || change.type == null) {
    return { kind: 'ignore', reason: 'missing-change' };
  }
  const changeType = String(change.type);

  if (changeType === 'metadata') {
    // SE 的 metadata 载荷恒带**完整** tags dict（改 title/description 亦然，见
    // domain.py `_meta_fields`）。故不能只看 tags 是否含结构键，否则任何带边/隐身的
    // 流改标题都会被误判为结构变更。先用 change.field 缩窄：title/description 必非
    // 结构标签变更；field=tags（或缺失）时才据 tags 内容判结构。
    const field = change.field == null ? '' : String(change.field);
    if (field !== 'title' && field !== 'description' && touchesStructuralTags(change.metadata?.tags)) {
      return { kind: 'structural', reason: 'metadata-structural', name };
    }
    return { kind: 'metadata', structural: false, name, metadata: change.metadata };
  }

  if (changeType === 'rename' || changeType === 'created' || changeType === 'deleted') {
    return { kind: 'structural', reason: changeType, name };
  }

  if (changeType === 'append') {
    return { kind: 'content', mode: 'append', name, changeType };
  }
  if (FULL_CONTENT_TYPES.includes(changeType)) {
    return { kind: 'content', mode: 'full', name, changeType };
  }

  // 未知类型（含 replace_range 等方法名误报）→ 交给上层忽略。
  return { kind: 'ignore', reason: `unknown-change-type:${changeType}` };
}
