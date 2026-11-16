// 投影串行队列纯 Node 单测（零 SE / 零 DOM）。
// 覆盖：同 sid 串行、后入队返回自己的结果、前一轮失败不阻断、whenIdle、clear。
// 运行：node scripts/smoke-se-projection-queue-unit.mjs（全绿退出码 0）。
import { createProjectionQueue } from '../src/se/projectionQueue.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 180) : ''}`);
};

const tick = () => new Promise((r) => setTimeout(r, 0));

try {
  // ── 1. 同 sid 严格串行 + 后入队拿到自己的结果 ─────────────────────────
  {
    const q = createProjectionQueue();
    const order = [];
    const p1 = q.run('a', async () => {
      order.push('start1');
      await tick();
      order.push('end1');
      return 'r1';
    });
    const p2 = q.run('a', async () => {
      order.push('start2');
      await tick();
      order.push('end2');
      return 'r2';
    });
    const [r1, r2] = await Promise.all([p1, p2]);
    check(
      '1 同 sid 串行且各返回自己的结果',
      JSON.stringify(order) === JSON.stringify(['start1', 'end1', 'start2', 'end2']) && r1 === 'r1' && r2 === 'r2',
      JSON.stringify({ order, r1, r2 })
    );
  }

  // ── 2. 不同 sid 互不阻塞 ───────────────────────────────────────────────
  {
    const q = createProjectionQueue();
    const order = [];
    const pa = q.run('a', async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 5));
      order.push('a-end');
    });
    const pb = q.run('b', async () => {
      order.push('b');
    });
    await Promise.all([pa, pb]);
    check('2 不同 sid 可并行（b 不被 a 阻塞）', order.indexOf('b') < order.indexOf('a-end'), JSON.stringify(order));
  }

  // ── 3. 前一轮失败不阻断下一轮；失败回传给自己的调用方 ─────────────────
  {
    const q = createProjectionQueue();
    const p1 = q.run('x', async () => {
      throw new Error('boom');
    });
    const p2 = q.run('x', async () => 'ok');
    let err = null;
    try {
      await p1;
    } catch (e) {
      err = e;
    }
    const r2 = await p2;
    check('3 失败隔离：p1 reject、p2 正常', !!err && err.message === 'boom' && r2 === 'ok', JSON.stringify({ err: err && err.message, r2 }));
  }

  // ── 4. whenIdle 等待链尾；空闲时立即 resolve ──────────────────────────
  {
    const q = createProjectionQueue();
    let done = false;
    const p = q.run('idle', async () => {
      await new Promise((r) => setTimeout(r, 10));
      done = true;
    });
    await q.whenIdle('idle');
    check('4 whenIdle 等待在飞投影结束', done === true);
    await p;
    let immediate = false;
    await Promise.race([q.whenIdle('idle').then(() => { immediate = true; }), new Promise((r) => setTimeout(r, 20))]);
    check('4b 空闲 whenIdle 立即 resolve', immediate === true);
  }

  // ── 5. clear 丢弃链（在飞任务不复活队列） ────────────────────────────
  {
    const q = createProjectionQueue();
    let resolveFirst;
    const first = q.run('c', () => new Promise((r) => { resolveFirst = r; }));
    await tick(); // 让队列的前缘任务真正启动
    q.clear('c');
    check('5 clear 后在飞不再被视为忙', q.isBusy('c') === false);
    const second = q.run('c', async () => 'second');
    resolveFirst('first');
    await first;
    const r = await second;
    check('5b clear 后新链可立即启动', r === 'second');
  }
} catch (err) {
  check('单测执行', false, err.stack || String(err));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
