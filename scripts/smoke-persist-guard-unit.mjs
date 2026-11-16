// 写盘/重投影空值守卫纯 Node 单测（B3/B4 根因护栏）。
//
// 覆盖：
// - `shouldSkipEmptyPersist`：识别「上一份持久化含流、本次却变空」的异常清空，阻止覆盖磁盘；
//   显式清空（重置）放行；首次写盘（prev 缺失）放行。
// - `isSuspiciousEmptyProjection`：识别「SE 返回空列表但画布仍有 s-* 投影节点」的异常空投影。
// 零 SE、零 DOM、零 React。运行：node scripts/smoke-persist-guard-unit.mjs（全绿退出码 0）。
import { shouldSkipEmptyPersist } from '../src/se/persistGuard.js';
import { isSuspiciousEmptyProjection } from '../src/se/streams.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 180) : ''}`);
};

try {
  // ── 1. shouldSkipEmptyPersist：6 个分支 ──────────────────────────────────
  check(
    '1a prev 缺失放行（首次写盘必写）',
    shouldSkipEmptyPersist(undefined, 0, false) === false,
    'prev=undefined'
  );

  check(
    '1b prev.streamCount=0 放行（合法空图仍可写）',
    shouldSkipEmptyPersist({ streamCount: 0 }, 0, false) === false,
    'prev.streamCount=0'
  );

  check(
    '1c 下次非空放行',
    shouldSkipEmptyPersist({ streamCount: 3 }, 2, false) === false,
    'next=2'
  );

  check(
    '1d explicitEmpty=true 放行（用户主动重置）',
    shouldSkipEmptyPersist({ streamCount: 3 }, 0, true) === false,
    'explicitEmpty=true'
  );

  check(
    '1e 触发跳过（prev 含流 → 本次 0 → 拦截）',
    shouldSkipEmptyPersist({ streamCount: 2 }, 0, false) === true,
    'prev.streamCount=2, next=0'
  );

  // 触发后记录值：写盘成功后 nextSync 记录 {name,json,streamCount}。含流记录拦空、合法空记录放行。
  const recordedAfterPersist = { name: 'g', json: '{}', streamCount: 0 };
  const recordedWithStreams = { name: 'g', json: '{}', streamCount: 4 };
  check(
    '1f 触发后记录 streamCount 参与判定（0 放行 / >0 拦截）',
    shouldSkipEmptyPersist(recordedAfterPersist, 0, false) === false &&
      shouldSkipEmptyPersist(recordedWithStreams, 0, false) === true,
    'recorded streamCount 0 vs 4'
  );

  // ── 2. isSuspiciousEmptyProjection：4 个分支 ─────────────────────────────
  check(
    '2a rows 非空 → 不拦截',
    isSuspiciousEmptyProjection([{ name: 'a' }], [{ id: 's-a' }]) === false,
    'rows.length=1'
  );

  check(
    '2b prev 无 s-* 节点 → 不拦截（纯本地画布）',
    isSuspiciousEmptyProjection([], [{ id: 'n-local' }]) === false,
    'prev 无 s-*'
  );

  check(
    '2c rows 空且 prev 有 s-* → 触发拦截',
    isSuspiciousEmptyProjection([], [{ id: 'n-local' }, { id: 's-alpha' }]) === true,
    'rows=[] + prev 有 s-*'
  );

  check(
    '2d 防御非法入参（null/null）→ 不抛、返回 false',
    isSuspiciousEmptyProjection(null, null) === false,
    'null 入参'
  );
} catch (err) {
  check('单测执行', false, err.stack || String(err));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
