// 每系统投影串行队列（纯逻辑，零 React / 零网络依赖，Node 可直接单测）。
//
// 背景：`reproject` 会被事件协调器、显式删除级联、改名、工具对齐等多处调用。
// 协调器只保证**事件驱动**的投影单飞；直连调用仍可与在飞投影并发，导致
// `setNodes(projection)` 乱序落地、写后校验拿到旧投影。本模块把所有投影
// 统一到每 sid 一条 Promise 链：
//
// - 同 sid 的 run 严格串行，后入队者一定在上一轮结束后才开始；
// - 每次 run 返回**自己**的结果（不是在飞旧 promise），调用方可安全做写后校验；
// - run 失败不 wedge：链继续，错误由调用方自己的 catch 处理；
// - `whenIdle` 返回当前链尾（用于删除落盘前等待投影尘埃落定）；
// - `clear` 用于关系统时丢弃链，防止关 tab 后继续跑。
//
// 队列不负责合并/去重（那是 reconcile 协调器的职责）；这里只保证顺序与结果归属。

export function createProjectionQueue() {
  /** sid → 当前链尾（永不 reject 的守门 promise）。 */
  const chains = new Map();

  const keyOf = (sid) => String(sid == null ? '' : sid);

  /**
   * 入队一次投影。
   * @param {string} sid system_id
   * @param {() => Promise<any>|any} fn 实际投影函数
   * @returns {Promise<any>} 本次投影自己的结果（失败时 reject 给调用方）
   */
  function run(sid, fn) {
    const key = keyOf(sid);
    const prev = chains.get(key) || Promise.resolve();
    const task = typeof fn === 'function' ? fn : () => undefined;
    // 前一轮失败不得阻断本轮；本轮失败也不得阻断下一轮。
    const result = prev.catch(() => {}).then(task);
    const guard = result.catch(() => {});
    chains.set(key, guard);
    // 只有链尾仍是本轮时才回收（若已排入下一轮，保留新链尾）。
    guard.then(() => {
      if (chains.get(key) === guard) chains.delete(key);
    });
    return result;
  }

  /** 当前链尾（无在飞投影时为已 resolve 的 Promise）。调用方自行 catch。 */
  function whenIdle(sid) {
    return chains.get(keyOf(sid)) || Promise.resolve();
  }

  /** 是否仍有投影在飞/排队。 */
  function isBusy(sid) {
    return chains.has(keyOf(sid));
  }

  /** 丢弃某 sid 的链（关系统/卸载）。在飞任务仍会跑完，但不再阻塞新链。 */
  function clear(sid) {
    chains.delete(keyOf(sid));
  }

  return { run, whenIdle, isBusy, clear };
}
