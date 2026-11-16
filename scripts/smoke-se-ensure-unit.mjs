// 纯 Node 单测：SE ensure 决策策略 planEnsure / planSpawnOutcome（src/se/ensurePolicy.js）。
//
// 为什么不用浏览器 / 不连 snakeeats：决策是纯逻辑（无 React / DOM / 网络 / 定时器），
// 「是否允许自动拉起 → 动作」与「spawn 返回 → 后续动作」两张矩阵可完全确定化断言。
// 覆盖「启动/切换自动 ensure」的关键安全不变量（生命周期收口，需求 A–E）：
//   - 允许拉起 → spawn（不再 attach 到已运行实例；Node 侧先回收残留再全新起）；
//   - 关闭自动拉起 → attach（用户明确不自动起，只能挂接）；
//   - D 收口：alive-unauthed 已取消——存活但无 token 的残留由 Node 侧回收重拉，前端无特殊分支；
//   - 开关关闭（allowSpawn=false）任何状态都不 spawn；
//   - spawn 排他锁命中（locked）走 lazy-attach 而非报错；
//   - E：owned-by-other-vite / port-unverifiable 一律映射为 error（诚实报错，不弹 token）。
// 运行：node scripts/smoke-se-ensure-unit.mjs（全绿退出码 0，任一断言失败退出码 1）。

import { planEnsure, planSpawnOutcome } from '../src/se/ensurePolicy.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 200) : ''}`);
};

try {
  // ── 1. planEnsure：只看 allowSpawn ──────────────────────────────────
  check('planEnsure(true) → spawn（不再 attach，强制全新拉起）', planEnsure(true) === 'spawn');
  check('planEnsure(false) → attach（关闭自动拉起只挂接）', planEnsure(false) === 'attach');

  // ── 2. planSpawnOutcome：attachOrSpawn 返回 → 后续动作 ────────────────
  check(
    "planSpawnOutcome({ok:true,status:'online'}) → attach",
    planSpawnOutcome({ ok: true, status: 'online' }) === 'attach'
  );
  check(
    "planSpawnOutcome({ok:false,status:'locked'}) → lazy-attach（另一实例在拉起，不报错）",
    planSpawnOutcome({ ok: false, status: 'locked', error: 'spawn already in progress' }) === 'lazy-attach'
  );
  // E：并发/占用类错误一律 error（诚实报错，绝不弹 token）。
  check(
    "planSpawnOutcome({ok:false,status:'owned-by-other-vite'}) → error",
    planSpawnOutcome({ ok: false, status: 'owned-by-other-vite', error: 'owned by another vite' }) === 'error'
  );
  check(
    "planSpawnOutcome({ok:false,status:'port-unverifiable'}) → error",
    planSpawnOutcome({ ok: false, status: 'port-unverifiable', error: 'port held by non-se' }) === 'error'
  );
  check(
    "planSpawnOutcome({ok:false,error}) → error",
    planSpawnOutcome({ ok: false, error: '未找到 Python 解释器' }) === 'error'
  );
  check('planSpawnOutcome(null) → error', planSpawnOutcome(null) === 'error');
  check('planSpawnOutcome(undefined) → error', planSpawnOutcome(undefined) === 'error');
  // not ok 时即便 status='online' 也视为 error（防御非法组合）。
  check(
    "planSpawnOutcome({ok:false,status:'online'}) → error（非法组合防御）",
    planSpawnOutcome({ ok: false, status: 'online' }) === 'error'
  );
  // alive-unauthed 不再特殊：按 error 处理。
  check(
    "planSpawnOutcome({ok:false,status:'alive-unauthed'}) → error（不再特殊分支）",
    planSpawnOutcome({ ok: false, status: 'alive-unauthed' }) === 'error'
  );

  // ── 3. 端到端合成：开关开 → spawn → online → attach ────────────────
  {
    const first = planEnsure(true);
    const afterSpawn = planSpawnOutcome({ ok: true, status: 'online' });
    check('合成：开 → spawn 成功后 attach', first === 'spawn' && afterSpawn === 'attach');
  }
  {
    const first = planEnsure(false);
    check('合成：关 → 只 attach（不 spawn）', first === 'attach');
  }
} catch (err) {
  check('单测执行', false, String((err && err.stack) || err));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
