// 期 13（Phase 0）纯 Node 单测：单飞重投影协调器 createReconcileRunner。
//
// 为什么不用浏览器 / 不连 snakeeats：reconcile.js 是纯逻辑（无 React / DOM / 网络 /
// 定时器依赖），`now` 与 `run` 均可注入，可完全确定化断言：leading 立即、单飞、
// burst 只产生一次尾随、非 active 只记 dirty、flush 绕过 active 闸门、防饿死
// reason='starvation'、run 失败不 wedge。
// 运行：node scripts/smoke-se-reconcile-unit.mjs（全绿退出码 0，任一断言失败退出码 1）。

import { createReconcileRunner } from '../src/se/reconcile.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 200) : ''}`);
};

/** 让已排队的微任务全部排干（run 的收尾在微任务里完成）。 */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * 测试夹具：可注入时钟 + 手动放行的 run（每次调用挂起到 waiters，由 settle 放行）。
 * flags.active 控制 isActive；clock.t 控制 now()。
 */
function harness({ active = true, starvationMs = 400, startTime = 0 } = {}) {
  const clock = { t: startTime };
  const flags = { active };
  const calls = [];
  const waiters = [];
  const runner = createReconcileRunner({
    run: (sid, reason) => {
      calls.push({ sid, reason });
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    isActive: () => flags.active,
    starvationMs,
    now: () => clock.t,
  });
  return {
    runner,
    calls,
    waiters,
    clock,
    flags,
    settle(ok = true) {
      const w = waiters.shift();
      if (!w) throw new Error('没有在飞 run 可放行');
      if (ok) w.resolve();
      else w.reject(new Error('boom'));
    },
  };
}

try {
  // ── 1. leading edge：invalidate 同步启动 ─────────────────────────────
  {
    const h = harness();
    h.runner.invalidate('a', 'evt');
    check(
      '1 leading：invalidate 同步立即启动 run（不等微任务）',
      h.calls.length === 1 && h.calls[0].sid === 'a' && h.calls[0].reason === 'evt' && h.runner.isRunning('a') === true,
      JSON.stringify(h.calls)
    );
    h.settle();
    await tick();
    check('1 leading：run 结束复位 isRunning / isDirty', h.runner.isRunning('a') === false && h.runner.isDirty('a') === false);
  }

  // ── 2. 单飞：并发 3 次 invalidate 只启动 1 次 run ────────────────────
  {
    const h = harness();
    h.runner.invalidate('a', 'e1');
    h.runner.invalidate('a', 'e2');
    h.runner.invalidate('a', 'e3');
    check('2 单飞：并发 3 次 invalidate 只启动 1 次 run', h.calls.length === 1, JSON.stringify(h.calls));
    h.settle();
    await tick();
    check('2 单飞：结束后恰好 1 次尾随（reason 取最后一条）', h.calls.length === 2 && h.calls[1].reason === 'e3', JSON.stringify(h.calls));
    h.settle();
    await tick();
    check('2 单飞：尾随结束彻底静止', h.calls.length === 2 && h.runner.isRunning('a') === false);
  }

  // ── 3. burst：运行中 5 条 invalidate → 恰好 1 次尾随 ─────────────────
  {
    const h = harness();
    h.runner.invalidate('a', 'lead');
    for (let i = 1; i <= 5; i += 1) h.runner.invalidate('a', `burst-${i}`);
    check('3 burst：运行中 5 条 invalidate 不新增 run（单飞硬约束）', h.calls.length === 1, JSON.stringify(h.calls));
    h.settle();
    await tick();
    check('3 burst：恰好 1 次尾随（合并为一次）', h.calls.length === 2 && h.calls[1].reason === 'burst-5', JSON.stringify(h.calls));
    h.settle();
    await tick();
    check('3 burst：全程共 2 次 run', h.calls.length === 2 && h.runner.isRunning('a') === false);
  }

  // ── 4. 非 active：只记 dirty，不跑；激活后 leading 清 dirty ──────────
  {
    const h = harness({ active: false });
    h.runner.invalidate('a', 'e1');
    check('4 非 active：invalidate 只置 dirty，不跑 run', h.calls.length === 0 && h.runner.isDirty('a') === true, JSON.stringify(h.calls));
    h.flags.active = true;
    h.runner.invalidate('a', 'e2');
    check('4 激活后：leading run 启动并清 dirty', h.calls.length === 1 && h.runner.isDirty('a') === false && h.calls[0].reason === 'e2');
    h.settle();
    await tick();
    const h2 = harness();
    h2.runner.markDirty('a', 'm');
    check('4 markDirty：不触发 run，仅 dirty 置位', h2.calls.length === 0 && h2.runner.isDirty('a') === true);
  }

  // ── 5. flush：绕过 active 闸门；在飞时并入 pending 并返回在飞 promise ─
  {
    const h = harness({ active: false });
    const p = h.runner.flush('a', 'cascade');
    check(
      '5 flush：非 active 也强制跑（reason 透传，返回 promise）',
      h.calls.length === 1 && h.calls[0].reason === 'cascade' && typeof p.then === 'function',
      JSON.stringify(h.calls)
    );
    const p2 = h.runner.flush('a', 'cascade-2');
    check('5 flush 在飞：并入 pending 并返回同一在飞 promise', h.calls.length === 1 && p2 === p, JSON.stringify(h.calls));
    const p3 = h.runner.flush('b');
    check(
      '5 flush 默认 reason=flush（不同 sid 独立状态）',
      h.calls.length === 2 && h.calls[1].reason === 'flush' && h.runner.isRunning('b') === true && typeof p3.then === 'function'
    );
    h.settle();
    await tick();
    check(
      '5 flush 在飞：尾随恰好 1 次且无视 active 闸门',
      h.calls.length === 3 && h.calls[2].sid === 'a' && h.calls[2].reason === 'cascade-2',
      JSON.stringify(h.calls)
    );
    h.settle();
    h.settle();
    await tick();
    check('5 flush：全部静止', h.runner.isRunning('a') === false && h.runner.isRunning('b') === false);
  }

  // ── 6. 防饿死：等待超 starvationMs → 专属尾随 reason='starvation' ────
  {
    const h = harness({ starvationMs: 400 });
    h.runner.invalidate('a', 'e1');
    h.runner.invalidate('a', 'e2');
    h.clock.t = 1000;
    h.settle();
    await tick();
    check(
      '6 防饿死：等待超上限 → 仍补跑且为专属尾随（reason=starvation）',
      h.calls.length === 2 && h.calls[1].reason === 'starvation',
      JSON.stringify(h.calls)
    );
    h.settle();
    await tick();

    const h2 = harness({ starvationMs: 400 });
    h2.runner.invalidate('a', 'e1');
    h2.runner.invalidate('a', 'e2');
    h2.settle();
    await tick();
    check('6 未超限：普通尾随（reason 取 pending 事件）', h2.calls.length === 2 && h2.calls[1].reason === 'e2', JSON.stringify(h2.calls));
    h2.settle();
    await tick();
  }

  // ── 7. 失败隔离：reject 不 wedge，尾随照发 ───────────────────────────
  {
    const h = harness();
    h.runner.invalidate('a', 'e1');
    h.runner.invalidate('a', 'e2');
    h.settle(false);
    await tick();
    check('7 reject 隔离：失败后照发尾随，协调器不 wedge', h.calls.length === 2 && h.runner.isRunning('a') === true, JSON.stringify(h.calls));
    h.settle();
    await tick();
    check('7 reject 隔离：尾随成功后静止', h.calls.length === 2 && h.runner.isRunning('a') === false);
    h.runner.invalidate('a', 'e3');
    check('7 reject 隔离：之后仍可正常 leading', h.calls.length === 3 && h.runner.isRunning('a') === true);
    h.settle();
    await tick();
  }

  // ── 7b. 同步抛错：invalidate 不外抛，可重复触发 ──────────────────────
  {
    let calls = 0;
    const runner = createReconcileRunner({
      run: () => {
        calls += 1;
        throw new Error('sync-boom');
      },
      isActive: () => true,
    });
    let threw = false;
    try {
      runner.invalidate('a', 'e');
    } catch (err) {
      threw = true;
    }
    await tick();
    check('7b 同步抛错：invalidate 不外抛且状态复位', !threw && calls === 1 && runner.isRunning('a') === false);
    let threw2 = false;
    try {
      runner.invalidate('a', 'e2');
    } catch (err) {
      threw2 = true;
    }
    await tick();
    check('7b 同步抛错：第二次仍可跑（不 wedge）', !threw2 && calls === 2 && runner.isRunning('a') === false);

    const gate = createReconcileRunner({
      run: () => undefined,
      isActive: () => {
        throw new Error('gate-boom');
      },
    });
    let gateThrew = false;
    try {
      gate.invalidate('a', 'e');
    } catch (err) {
      gateThrew = true;
    }
    check('7c invalidate：isActive 抛错也不外抛', !gateThrew);
  }

  // ── 8. dispose：清空状态，在飞收尾不复活尾随 ─────────────────────────
  {
    const h = harness();
    h.runner.invalidate('a', 'e1');
    h.runner.invalidate('a', 'e2');
    h.runner.markDirty('a', 'm');
    h.runner.dispose();
    check('8 dispose：isDirty / isRunning 均复位', h.runner.isDirty('a') === false && h.runner.isRunning('a') === false);
    h.settle();
    await tick();
    check('8 dispose：在飞 run 收尾不触发尾随（不复活）', h.calls.length === 1, JSON.stringify(h.calls));
  }
} catch (err) {
  check('单测执行', false, err.stack || String(err));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
