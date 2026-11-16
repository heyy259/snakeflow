// 期 13（Phase 0）纯 Node 单测：内部流唯一决策 isInternal + appearedInternalNames。
//
// 为什么不用浏览器 / 不连 snakeeats：internalStreams.js 是纯函数（无 React / DOM / ws
// 依赖），Node 直接 import 即可断言真值表。重点覆盖 D5 的判据复合语义：
// 后缀命中 ≠ 内部流——必须基流存在；孤儿 `_console` 是内部流、用户 `x_console`
// （x 存在）也是内部流；裸后缀 / 非后缀名不是；以及新内部流选择器的四个过滤条件。
// 运行：node scripts/smoke-se-internal-unit.mjs（全绿退出码 0，任一断言失败退出码 1）。

import {
  INTERNAL_SUFFIXES,
  CANVAS_TAG_KEY,
  baseStreamName,
  allNamesFromList,
  baseStreamExists,
  isInternal,
  appearedInternalNames,
} from '../src/se/internalStreams.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 200) : ''}`);
};

try {
  // ── 1. 常量：后缀表复用 procAssoc，不复制 ────────────────────────────
  check(
    '1 INTERNAL_SUFFIXES 复用 procAssoc 定义',
    Array.isArray(INTERNAL_SUFFIXES) && INTERNAL_SUFFIXES.includes('_console') && INTERNAL_SUFFIXES.includes('_scan_log'),
    JSON.stringify(INTERNAL_SUFFIXES)
  );
  check('1 CANVAS_TAG_KEY 常量导出', CANVAS_TAG_KEY === 'canvas', CANVAS_TAG_KEY);

  // ── 2. baseStreamName 真值表 ─────────────────────────────────────────
  const baseCases = [
    ['x', null],
    ['x_console', 'x'],
    ['x_scan_log', 'x'],
    ['_console', null],
    ['_scan_log', null],
    ['xconsole', null],
    ['x_console2', null],
    ['', null],
    [null, null],
    [undefined, null],
  ];
  for (const [input, want] of baseCases) {
    const got = baseStreamName(input);
    check(`2 baseStreamName(${JSON.stringify(input)}) → ${JSON.stringify(want)}`, got === want, `got=${JSON.stringify(got)}`);
  }

  // ── 3. allNamesFromList：跳过空 name / 畸形行 ────────────────────────
  const names = allNamesFromList([{ name: 'x' }, { name: 'x_console' }, { name: '' }, { name: null }, null, {}, { name: 'y' }]);
  check(
    '3 allNamesFromList：非空 name 进 Set（跳过空 / 畸形）',
    names instanceof Set && names.size === 3 && names.has('x') && names.has('x_console') && names.has('y'),
    JSON.stringify([...names])
  );
  check('3 allNamesFromList：非数组 → 空 Set', allNamesFromList(null).size === 0 && allNamesFromList(undefined).size === 0);

  // ── 4. baseStreamExists：Set / 数组入参 ──────────────────────────────
  check('4 baseStreamExists：Set 命中', baseStreamExists('x_console', new Set(['x'])) === true);
  check('4 baseStreamExists：数组命中', baseStreamExists('x_console', ['x', 'z']) === true);
  check('4 baseStreamExists：基流缺失 → false', baseStreamExists('x_console', new Set(['y'])) === false);
  check('4 baseStreamExists：无后缀名 → false', baseStreamExists('x', new Set(['x'])) === false);
  check('4 baseStreamExists：裸 _console → false', baseStreamExists('_console', new Set([''])) === false);
  check(
    '4 baseStreamExists：非集合入参 → false（不抛）',
    baseStreamExists('x_console', null) === false && baseStreamExists('x_console', undefined) === false
  );

  // ── 5. isInternal 真值表（D5 唯一决策）───────────────────────────────
  const ALL = new Set(['x', 'user', 'x_console']);
  check('5 isInternal：x_console 且 x 存在 → true', isInternal('x_console', ALL) === true);
  check(
    '5 isInternal：x_scan_log 且 x 存在 → true（含 base 在 list 后位）',
    isInternal('x_scan_log', ALL) === true && isInternal('x_scan_log', ['x_scan_log', 'x']) === true
  );
  check(
    '5 isInternal：孤儿内部流（基流不存在）→ false',
    isInternal('ghost_console', ALL) === false && isInternal('ghost_scan_log', ALL) === false
  );
  check(
    '5 isInternal：用户风格 user_console 且 user 存在 → true（后缀命中+基流存在）',
    isInternal('user_console', ALL) === true
  );
  check('5 isInternal：裸 _console / _scan_log → false', isInternal('_console', ALL) === false && isInternal('_scan_log', ALL) === false);
  check('5 isInternal：非后缀名 → false', isInternal('x', ALL) === false);
  check('5 isInternal：allNames 缺失 → false（无法证明基流存在）', isInternal('x_console', null) === false);

  // ── 6. appearedInternalNames：新出现的内部流选择 ─────────────────────
  const list = [
    { name: 'x', tags: {} },
    { name: 'x_console', tags: {} },
    { name: 'x_scan_log', tags: {} },
    { name: 'ghost_console', tags: {} },
    { name: 'plain', tags: {} },
    { name: '', tags: {} },
    null,
  ];
  const appeared = appearedInternalNames(list, new Set());
  check(
    '6 appearedInternalNames：只选新内部流（含 id / 保持原序 / 跳过孤儿与空名）',
    appeared.length === 2 &&
      appeared[0].name === 'x_console' &&
      appeared[0].id === 's-x_console' &&
      appeared[1].name === 'x_scan_log' &&
      appeared[1].id === 's-x_scan_log',
    JSON.stringify(appeared)
  );
  const appearedArr = appearedInternalNames(list, ['s-x_console']);
  check(
    '6 appearedInternalNames：prevIds 数组去重（已投影的不再返回）',
    appearedArr.length === 1 && appearedArr[0].name === 'x_scan_log',
    JSON.stringify(appearedArr)
  );
  const hidden = appearedInternalNames(
    [
      { name: 'x', tags: {} },
      { name: 'x_console', tags: { canvas: 'false' } },
      { name: 'x_scan_log', tags: { canvas: 'true' } },
    ],
    new Set()
  );
  check(
    '6 appearedInternalNames：canvas:false 排除，canvas:true 保留',
    hidden.length === 1 && hidden[0].name === 'x_scan_log',
    JSON.stringify(hidden)
  );
  check(
    '6 appearedInternalNames：全部命中 prevIds → 空',
    appearedInternalNames(list, new Set(['s-x_console', 's-x_scan_log'])).length === 0
  );
  check('6 appearedInternalNames：非数组 list → 空（不抛）', appearedInternalNames(null, new Set()).length === 0);
} catch (err) {
  check('单测执行', false, err.stack || String(err));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
