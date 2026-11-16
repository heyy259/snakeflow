// 流删除错误策略（纯函数，零依赖）：把「目标已不存在」识别为后置条件已满足。
//
// 边界（SE 契约）：
// - `stream.delete` 缺失 → `-32002` / `data.kind === 'not-found'`
//   （snakeeats/streams/exceptions.py: StreamNotFoundError）；
// - 工具域 not-found 是 `-33001`，绝不能在流删除里复用；
// - 传输/鉴权/超时错误必须继续失败，不能把「没删掉」误判成「已删除」。
//
// 该判定只服务删除命令的本地提交：`not_found` ⇒ SE 端已满足「不存在」，
// 客户端仍须完成 tombstone / 节点移除 / 快照写盘。
//
// 纯逻辑：无 DOM / React / 网络依赖，Node 可直接 import 做单测。

/** SE 流域「不存在」错误码（errors.py: STREAM_NOT_FOUND）。 */
export const STREAM_NOT_FOUND_CODE = -32002;

/**
 * 该错误是否表示「流在 SE 中已不存在」。
 *
 * 兼容三种线上形态：
 *   1. code === -32002（当前 SE）；
 *   2. data.kind === 'not-found'（错误帧五要素）；
 *   3. message 仅为 `not_found` / `not-found` / `not found`（只回 message 的运行时）。
 *
 * @param {unknown} err client.call 的 rejection（Error 或任意值）
 * @returns {boolean}
 */
export function isStreamNotFoundError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.code === STREAM_NOT_FOUND_CODE) return true;
  if (err.data && typeof err.data === 'object' && err.data.kind === 'not-found') return true;
  return /^not[\s_-]?found$/i.test(String(err.message == null ? '' : err.message).trim());
}
