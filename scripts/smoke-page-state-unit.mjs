// 期 15（Phase 15-A）纯 Node 单测：src/pageState.js 页码 + 历史页缓存，以及 src/foldState.js 折叠态。
//
// 为什么不用浏览器 / 不连 snakeeats：这些模块是模块级内存 Map（无 React / DOM 依赖），
// Node 直接 import 即可断言。重点覆盖：scope + nodeId 显式归属、get/set/clear 往返、未知节点
// getPage → undefined、订阅触发/退订、历史页 LRU 淘汰、clearPage 同步清空历史、fold 归属键
// 与 computeFoldKey 格式一致，以及**同一 nodeId 在两个 scope 下完全隔离**——清一个 tab 不影响
// 另一个 tab 的同名 SE 流。
// 运行：node scripts/smoke-page-state-unit.mjs（全绿退出码 0，任一断言失败退出码 1）。

import {
  getPage,
  setPage,
  clearPage,
  clearPageScope,
  rekeyNodeState,
  subscribePages,
  notifyPages,
  getHistoryPage,
  setHistoryPage,
  deleteHistoryPage,
  clearHistoryForNode,
} from '../src/pageState.js';
import {
  foldKeyFor,
  foldPrefixFor,
  isFoldOpen,
  setFoldOpen,
  getFoldDefault,
  setFoldDefault,
  getFoldKeys,
  setFoldKeys,
  hasCollapsedFold,
  setFoldsOpen,
  clearFoldStateForNode,
  rekeyFoldsForNode,
  clearFoldScope,
} from '../src/foldState.js';
import { computeFoldKey } from '../src/editor/fold/patterns.js';
import { viewStateKey, VIEW_STATE_SEPARATOR } from '../src/viewStateScope.js';
import { HISTORY_PAGE_CACHE_MAX } from '../src/se/terminalCaps.js';

const A = 'tab-a';
const B = 'tab-b';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 200) : ''}`);
};

try {
  // ── 1. 常量与归属键 ──────────────────────────────────────────────────
  check('1 HISTORY_PAGE_CACHE_MAX === 20', HISTORY_PAGE_CACHE_MAX === 20, String(HISTORY_PAGE_CACHE_MAX));
  check(
    '1 viewStateKey 使用 NUL 分隔且无裸 nodeId 前缀',
    viewStateKey(A, 's-dup') === `${A}${VIEW_STATE_SEPARATOR}s-dup` && !viewStateKey(A, 's-dup').startsWith('s-dup')
  );
  {
    let missingScope = false;
    let missingNode = false;
    try {
      getPage(undefined, 's-dup');
    } catch (err) {
      missingScope = err instanceof TypeError;
    }
    try {
      getPage(A, null);
    } catch (err) {
      missingNode = err instanceof TypeError;
    }
    check('1 缺少 scope 抛 TypeError（无未归属兜底）', missingScope);
    check('1 缺少 nodeId 抛 TypeError（无未归属兜底）', missingNode);
  }

  // ── 2. get/set/clear 往返 + 未知节点 ────────────────────────────────
  check('2 未知节点 getPage → undefined', getPage(A, 'no-such-node') === undefined);
  setPage(A, 'rt', 3);
  check('2 setPage 后 getPage === 3', getPage(A, 'rt') === 3, String(getPage(A, 'rt')));
  clearPage(A, 'rt');
  check('2 clearPage 后 getPage → undefined', getPage(A, 'rt') === undefined);

  // ── 3. 整数化：向下取整且不小于 0；Node id 归一化 String ────────────
  setPage(A, 'n-floor', 2.9);
  check('3 非整数向下取整 → 2', getPage(A, 'n-floor') === 2, String(getPage(A, 'n-floor')));
  setPage(A, 'n-neg', -5);
  check('3 负数夹紧为 0', getPage(A, 'n-neg') === 0, String(getPage(A, 'n-neg')));
  setPage(A, 'n-strnum', '4');
  check('3 字符串数字 → 4', getPage(A, 'n-strnum') === 4, String(getPage(A, 'n-strnum')));
  setPage(A, 123, 2);
  check(
    '3 非字符串 nodeId 归一化：getPage(123) 与 getPage("123") 一致',
    getPage(A, 123) === 2 && getPage(A, '123') === 2
  );

  // ── 4. 订阅：setPage / clearPage / setHistoryPage 触发，退订后停止 ───
  {
    let hits = 0;
    const unsub = subscribePages(() => {
      hits++;
    });
    setPage(A, 'sub', 1);
    clearPage(A, 'sub');
    setHistoryPage(A, 'sub', 0, 'abc');
    check('4 setPage/clearPage/setHistoryPage 各触发一次', hits === 3, `hits=${hits}`);
    unsub();
    setPage(A, 'sub', 2);
    setHistoryPage(A, 'sub', 1, 'def');
    check('4 退订后不再触发', hits === 3, `hits=${hits}`);
    check(
      '4 订阅者异常不影响其余（try/catch）',
      (() => {
        const bad = subscribePages(() => {
          throw new Error('boom');
        });
        let ok = true;
        const good = subscribePages(() => {});
        try {
          notifyPages();
        } catch (e) {
          ok = false;
        }
        bad();
        good();
        return ok;
      })()
    );
  }

  // ── 5. 历史页缓存 get/set ───────────────────────────────────────────
  check('5 未知节点历史页 → undefined', getHistoryPage(A, 'hist-none', 0) === undefined);
  setHistoryPage(A, 'hist', 0, 'page0');
  setHistoryPage(A, 'hist', 1, 'page1');
  check('5 历史页写入后可读回', getHistoryPage(A, 'hist', 0) === 'page0' && getHistoryPage(A, 'hist', 1) === 'page1');
  clearHistoryForNode(A, 'hist');
  check('5 clearHistoryForNode 清空该节点历史', getHistoryPage(A, 'hist', 0) === undefined && getHistoryPage(A, 'hist', 1) === undefined);

  // ── 6. 历史页 LRU：插入 MAX+1 页 → 最旧被淘汰 ────────────────────────
  {
    const node = 'lru';
    for (let i = 0; i <= HISTORY_PAGE_CACHE_MAX; i++) {
      setHistoryPage(A, node, i, `p${i}`);
    }
    check('6 最旧一页（index 0）被淘汰 → undefined', getHistoryPage(A, node, 0) === undefined);
    check(
      '6 其余页仍可读回',
      getHistoryPage(A, node, 1) === 'p1' && getHistoryPage(A, node, HISTORY_PAGE_CACHE_MAX) === `p${HISTORY_PAGE_CACHE_MAX}`
    );
    let present = 0;
    for (let i = 0; i <= HISTORY_PAGE_CACHE_MAX; i++) {
      if (getHistoryPage(A, node, i) !== undefined) present++;
    }
    check('6 缓存页数不超过上限', present === HISTORY_PAGE_CACHE_MAX, `present=${present}`);
  }

  // ── 7. clearPage 同时清空该节点历史页缓存 ───────────────────────────
  {
    setPage(A, 'cp', 1);
    setHistoryPage(A, 'cp', 0, 'x');
    setHistoryPage(A, 'cp', 1, 'y');
    clearPage(A, 'cp');
    check('7 clearPage 后页码消失', getPage(A, 'cp') === undefined);
    check('7 clearPage 后历史页消失', getHistoryPage(A, 'cp', 0) === undefined && getHistoryPage(A, 'cp', 1) === undefined);
  }

  // ── 8. deleteHistoryPage：单条目失效 + 精准广播 ─────────────────────
  {
    setHistoryPage(A, 'del', 0, 'a');
    setHistoryPage(A, 'del', 1, 'b');
    setHistoryPage(A, 'del', 2, 'c');

    let hits = 0;
    const unsub = subscribePages(() => {
      hits++;
    });

    deleteHistoryPage(A, 'del', 1);
    check('8 删除已存在条目 → 不可读', getHistoryPage(A, 'del', 1) === undefined);
    check('8 删除已存在条目 → 广播一次', hits === 1, `hits=${hits}`);
    check('8 删除不影响其余缓存页', getHistoryPage(A, 'del', 0) === 'a' && getHistoryPage(A, 'del', 2) === 'c');

    deleteHistoryPage(A, 'del', 1);
    check('8 删除已不存在条目 → 静默不广播', hits === 1, `hits=${hits}`);
    deleteHistoryPage(A, 'del', 99);
    check('8 删除越界条目 → 静默不广播', hits === 1, `hits=${hits}`);
    deleteHistoryPage(A, 'del-none', 0);
    check('8 未知节点 → 静默不广播', hits === 1, `hits=${hits}`);

    unsub();
  }

  // ── 9. deleteHistoryPage 不打乱剩余条目的 LRU 插入序 ────────────────
  {
    const node = 'del-order';
    for (let i = 0; i < HISTORY_PAGE_CACHE_MAX; i++) setHistoryPage(A, node, i, `p${i}`);
    deleteHistoryPage(A, node, 5);
    setHistoryPage(A, node, HISTORY_PAGE_CACHE_MAX, 'pNew');
    check('9 删除后填入新页不误淘汰最旧页', getHistoryPage(A, node, 0) === 'p0', `get0=${getHistoryPage(A, node, 0)}`);
    setHistoryPage(A, node, HISTORY_PAGE_CACHE_MAX + 1, 'pNew2');
    check('9 超限后淘汰的仍是最旧页（index 0）', getHistoryPage(A, node, 0) === undefined);
    check('9 已手动删除的 index 5 仍不可读', getHistoryPage(A, node, 5) === undefined);
    check(
      '9 次旧页与最新页均可读',
      getHistoryPage(A, node, 1) === 'p1' && getHistoryPage(A, node, HISTORY_PAGE_CACHE_MAX + 1) === 'pNew2'
    );
  }

  // ── 10. fold key 格式：computeFoldKey(nodeId=归属键) 与 foldKeyFor 一致 ──
  {
    const computeKey = computeFoldKey(null, 0, { attrs: { summary: 'Dup' } }, viewStateKey(A, 's-dup'));
    const directKey = foldKeyFor(A, 's-dup', 'dup', 1);
    check('10 computeFoldKey 保持 `${owner}::slug#occ` 格式', computeKey === directKey, computeKey);
    check('10 折叠前缀带 scope 且非裸 nodeId', foldPrefixFor(A, 's-dup').startsWith(viewStateKey(A, 's-dup')));
    const bulk = [foldKeyFor(A, 'fold-all', 'a', 1), foldKeyFor(A, 'fold-all', 'b', 1)];
    setFoldsOpen(A, 'fold-all', bulk, true);
    check('10 setFoldsOpen 批量写入归属键', bulk.every((key) => isFoldOpen(A, 'fold-all', key) === true));
    clearFoldStateForNode(A, 'fold-all');
    check('10 clearFoldStateForNode 只清显式条目', bulk.every((key) => isFoldOpen(A, 'fold-all', key) === false));
  }

  // ── 11. 隔离：同一 nodeId 在两个 scope 下页码/历史/折叠互不影响 ──────
  {
    const node = 's-shared_name';
    const keyA = foldKeyFor(A, node, 'shared', 1);
    const keyB = foldKeyFor(B, node, 'shared', 1);

    setPage(A, node, 1);
    setPage(B, node, 7);
    setHistoryPage(A, node, 0, 'page-A');
    setHistoryPage(B, node, 0, 'page-B');
    setFoldOpen(A, node, keyA, true);
    setFoldOpen(B, node, keyB, false);
    setFoldDefault(A, node, true);
    setFoldDefault(B, node, false);
    setFoldKeys(A, node, new Set([keyA]));
    setFoldKeys(B, node, new Set([keyB]));

    check('11 同 nodeId 两 scope 页码独立', getPage(A, node) === 1 && getPage(B, node) === 7);
    check(
      '11 同 nodeId 两 scope 历史页独立',
      getHistoryPage(A, node, 0) === 'page-A' && getHistoryPage(B, node, 0) === 'page-B'
    );
    check(
      '11 同 nodeId 两 scope 折叠态独立',
      isFoldOpen(A, node, keyA) === true && isFoldOpen(B, node, keyB) === false
    );
    check('11 收起扫描按 scope 隔离', hasCollapsedFold(A, node) === false && hasCollapsedFold(B, node) === true);
    check('11 同 nodeId 两 scope foldDefault 独立', getFoldDefault(A, node) === true && getFoldDefault(B, node) === false);
    check(
      '11 同 nodeId 两 scope 登记键集合独立',
      getFoldKeys(A, node)?.has(keyA) === true && getFoldKeys(B, node)?.has(keyB) === true
    );

    clearPageScope(A);
    clearFoldScope(A);

    check('11 清除 tab A 后其页码/历史消失', getPage(A, node) === undefined && getHistoryPage(A, node, 0) === undefined);
    check('11 清除 tab A 不影响 tab B 页码/历史', getPage(B, node) === 7 && getHistoryPage(B, node, 0) === 'page-B');
    check(
      '11 清除 tab A 不影响 tab B 折叠态',
      isFoldOpen(B, node, keyB) === false && getFoldDefault(B, node) === false && getFoldKeys(B, node)?.has(keyB) === true
    );
    check('11 清除 tab A 后其折叠态消失', getFoldKeys(A, node) === undefined && getFoldDefault(A, node) === undefined);
  }

  // ── 12. 身份迁移只影响本 scope；同 nodeId 另一 scope 保持原样 ────────
  {
    const oldId = 's-old_name';
    const newId = 's-new_name';
    const oldA = foldKeyFor(A, oldId, 'x', 1);
    const newA = foldKeyFor(A, newId, 'x', 1);
    const oldB = foldKeyFor(B, oldId, 'x', 1);

    setPage(A, oldId, 4);
    setHistoryPage(A, oldId, 0, 'old-A');
    setPage(B, oldId, 9);
    setFoldOpen(A, oldId, oldA, true);
    setFoldDefault(A, oldId, true);
    setFoldKeys(A, oldId, new Set([oldA]));
    setFoldOpen(B, oldId, oldB, false);

    rekeyNodeState(A, oldId, newId);
    rekeyFoldsForNode(A, oldId, newId);
    check('12 rekey 后本 scope 页码/历史迁移', getPage(A, newId) === 4 && getHistoryPage(A, newId, 0) === 'old-A');
    check('12 rekey 不改另一 scope 的同 nodeId 页码', getPage(B, oldId) === 9 && getPage(B, newId) === undefined);
    check('12 rekey 后本 scope 折叠键迁移', isFoldOpen(A, newId, newA) === true);
    check('12 rekey 后本 scope 旧折叠键消失', getFoldKeys(A, oldId) === undefined);
    check('12 rekey 不改另一 scope 的同 nodeId 折叠态', isFoldOpen(B, oldId, oldB) === false);
  }
} catch (err) {
  check('单测执行', false, err.stack || String(err));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
