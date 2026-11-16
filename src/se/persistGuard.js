// 写盘空值护栏（B3，纯函数模块，零依赖 —— Node 可直接 import 做单测）。
//
// 根因：懒加载失败被标 hydrated-empty → 600ms 自动保存把空文档覆盖
// graphs/<名>.se.json（唯一护栏是 hydratedRef，首次保存 prev 未定义必写）。
// 本守卫识别「上一份成功写盘记录含流、本次却变空」的异常清空，阻止覆盖磁盘
// （旧数据保留），除非调用方显式声明为用户主动清空（"重置"）。
//
// 约定：调用方持久化成功后把 `{ name, json, streamCount }` 记入 nextSync；
// 本函数只读 prevEntry.streamCount，不关心 content/json 细节。

/**
 * 是否应阻止本次空持久化（跳过写盘以保留磁盘旧内容）。
 *
 * @param {{streamCount?: number|string}|null|undefined} prevEntry 上一次成功写盘记录
 * @param {number} nextStreamCount 本次待写盘的可持久化节点数
 * @param {boolean} explicitEmpty 用户是否显式请求清空（"重置"等）
 * @returns {boolean} true = 跳过写盘（保留磁盘旧内容）
 */
export function shouldSkipEmptyPersist(prevEntry, nextStreamCount, explicitEmpty) {
  if (explicitEmpty) return false;
  if (!prevEntry) return false;
  if (!(Number(prevEntry.streamCount) > 0)) return false;
  return Number(nextStreamCount) === 0;
}
