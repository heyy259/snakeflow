// 期 13（Phase 0）纯逻辑单飞重投影协调器（重投影纪律）。
//
// 问题：`stream.on_change` 通知是**突发**的——一次扫描 / 一次级联会连续推多条
// 事件，每条都立刻全量重投影会把 RPC 打爆；且重投影自身会引发新通知，必须严格
// 单飞（single-flight）防重入风暴。
//
// ── 精确语义（本模块的唯一契约）────────────────────────────────────────
// 每 sid 一份状态 `{ running, pending, dirty, dirtyReason, firstQueuedAt, promise }`
// （另有内部扩展字段 pendingReason / starved / disposed，见实现）。
//
// 1. leading edge：空闲且 `isActive(sid)` 为真时，`invalidate` **同步**启动一次
//    run（run 是同步函数时在 invalidate 返回前已执行；异步则立刻在飞）。
// 2. 单飞：run 在飞期间再 `invalidate` 只置 `pending`（合并 burst），绝不并发
//    启动第二次 run——状态翻转是同步的，故不存在竞态窗口。
// 3. trailing edge：run 结束（**含同步抛错 / Promise reject**）时若 `pending`
//    为真 → 恰好补跑一次。一次 run 期间 N 条 invalidate ⇒ 恰好 1 次尾随运行；
//    尾随 run 期间到达的事件开启下一轮（每轮各 1 次尾随）。
// 4. 非 active：`invalidate` 只置 `dirty`（不跑），等待激活后的 invalidate 或
//    `flush`；run 真正启动时清 dirty（本次 run 以服务端为真源，覆盖旧脏标记）。
//    `markDirty` 无论 active / 在飞与否都置 dirty（外部写入路径记账用）。
// 5. flush：无视 active 闸门强制跑（级联校验场景）；run 在飞时并入 pending 并
//    返回在飞 promise（尾随运行同样无视闸门——pending 一旦记录必须被消费）。
// 6. 防饿死：pending 首次入队时刻记入 `firstQueuedAt`，run 结束时若
//    `now() - firstQueuedAt >= starvationMs`（含在 invalidate 时已逾期），该尾随
//    运行标记为「专属」并把 reason 改写为 `'starvation'`——保证一条等待超过上限
//    的事件在慢 run 结束后仍得到**独立**的一轮重投影，而不是被后续 burst 语义
//    无声吞掉。硬约束：run 永不结束时无法抢占（单飞优先于饿死），本轮保证
//    「结束即补跑」。
// 7. 失败隔离：run 的同步抛错 / rejection 全部吞掉（错误由 run 自身记录），
//    协调器状态照常复位并触发尾随，绝不 wedge；`invalidate` 本身永不外抛。
// 8. dispose：标记并清空全部 sid 状态；在飞 run 的收尾不再触发尾随（不复活）。
// 9. drop：撤销单个 sid（标记 disposed 并从 states 移除，无该 sid 则 no-op）；在飞 run
//    的收尾不再触发尾随——关 tab 后该 sid 不得被重投影/尾随重新拉起。
//
// 纯逻辑：无 React / DOM / 网络 / 定时器依赖；`now` 可注入，单测可完全确定化。

export function createReconcileRunner({ run, isActive, starvationMs = 400, now = Date.now } = {}) {
  const runFn = typeof run === 'function' ? run : () => undefined;
  const activeFn = typeof isActive === 'function' ? isActive : () => true;
  const clock = typeof now === 'function' ? now : Date.now;
  const starveMs = Number.isFinite(starvationMs) && starvationMs >= 0 ? starvationMs : 400;

  /** sid → state。 */
  const states = new Map();

  const keyOf = (sid) => String(sid == null ? '' : sid);

  /** 取 / 建 sid 状态。 */
  function stateFor(sid) {
    const key = keyOf(sid);
    let st = states.get(key);
    if (!st) {
      st = {
        running: false,
        pending: false,
        pendingReason: '',
        dirty: false,
        dirtyReason: '',
        firstQueuedAt: null,
        starved: false,
        promise: null,
        disposed: false,
      };
      states.set(key, st);
    }
    return st;
  }

  /** 事件并入 pending（运行中 invalidate 与在飞 flush 共用）；首刻记 firstQueuedAt。 */
  function queuePending(st, reason) {
    st.pending = true;
    st.pendingReason = reason;
    if (st.firstQueuedAt == null) st.firstQueuedAt = clock();
    if (clock() - st.firstQueuedAt >= starveMs) st.starved = true;
  }

  /**
   * 启动一次 run（leading / trailing / flush 三处唯一出口）。
   * - runFn 的同步抛错与 rejection 全在此吞掉，协调器不 wedge；
   * - 结束（成功或失败）后进入 finish：pending → 恰好补跑一次。
   * 返回本次 run 的完成 promise（永不 reject）。
   */
  function start(sid, st, reason) {
    st.running = true;
    st.pending = false;
    st.pendingReason = '';
    st.starved = false;
    st.firstQueuedAt = null;
    // 本次 run 读服务端真源，覆盖此前「非 active 期间」的脏标记。
    st.dirty = false;
    st.dirtyReason = '';

    const promise = (async () => {
      try {
        await runFn(sid, reason);
      } catch (err) {
        // 单次 run 失败由 run 自己记录；协调器只保证复位 + 尾随照发。
      } finally {
        st.running = false;
        st.promise = null;
        if (!st.disposed) finish(sid, st);
      }
    })();
    st.promise = promise;
    return promise;
  }

  /** run 结束：pending → 恰好补跑一次；等待超 starvationMs 标记专属 'starvation'。 */
  function finish(sid, st) {
    if (!st.pending) return;
    const starved = st.starved
      || (st.firstQueuedAt != null && clock() - st.firstQueuedAt >= starveMs);
    const reason = starved ? 'starvation' : st.pendingReason || 'trailing';
    st.pending = false;
    st.pendingReason = '';
    st.starved = false;
    st.firstQueuedAt = null;
    start(sid, st, reason);
  }

  /**
   * 通知入口：active 且空闲 → 立即 leading run；运行中 → 并入 pending；
   * 非 active → 只记 dirty。契约：永不外抛（run 错误由 start 隔离）。
   */
  function invalidate(sid, reason = 'invalidate') {
    try {
      const st = stateFor(sid);
      const r = String(reason == null ? '' : reason);
      if (!activeFn(sid)) {
        st.dirty = true;
        st.dirtyReason = r;
        return;
      }
      if (st.running) {
        queuePending(st, r);
        return;
      }
      start(sid, st, r);
    } catch (err) {
      // 契约：invalidate 永不外抛。
    }
  }

  /** 外部写入路径记账：无论 active / 在飞都置 dirty（不触发 run）。 */
  function markDirty(sid, reason = 'dirty') {
    const st = stateFor(sid);
    st.dirty = true;
    st.dirtyReason = String(reason == null ? '' : reason);
  }

  /**
   * 强制重投影（无视 active 闸门）：run 在飞 → 并入 pending 并返回在飞 promise；
   * 空闲 → 立即（同步）启动，返回本次完成 promise。
   */
  function flush(sid, reason = 'flush') {
    const st = stateFor(sid);
    const r = String(reason == null ? '' : reason);
    if (st.running) {
      queuePending(st, r);
      return st.promise;
    }
    return start(sid, st, r);
  }

  /** 是否有未消费的脏标记（非 active 期间累积 / 外部写入记账）。 */
  function isDirty(sid) {
    const st = states.get(keyOf(sid));
    return !!(st && !st.disposed && st.dirty);
  }

  /** 是否有在飞 run。 */
  function isRunning(sid) {
    const st = states.get(keyOf(sid));
    return !!(st && !st.disposed && st.running);
  }

  /** 清空全部状态；在飞 run 的收尾不再补跑（不复活）。 */
  function dispose() {
    for (const st of states.values()) st.disposed = true;
    states.clear();
  }

  /** 撤销单个 sid：标记 disposed 并从 states 移除（无该 sid 则 no-op）；在飞 run 收尾不补跑。 */
  function drop(sid) {
    const key = keyOf(sid);
    const st = states.get(key);
    if (!st) return;
    st.disposed = true;
    states.delete(key);
  }

  return { invalidate, markDirty, flush, isDirty, isRunning, drop, dispose };
}
