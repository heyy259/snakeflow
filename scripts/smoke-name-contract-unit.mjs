// 期 0 纯 Node 单测：`src/se/nameContract.js` 镜像 SE `snakeeats/naming.py` 的命名契约。
//
// 验收（SE中文名同步改造方案 §6.1 / §9 AC）：合法/非法矩阵（中文、假名、谚文、注音、拉丁、
// 连字符/空格/点/斜杠、西里尔、希腊、NFKC 兼容、代理、纯数字、长度边界、保留位）+
// `toStreamName` 派生与去重。零 SE、零 DOM、零浏览器。
// 运行：node scripts/smoke-name-contract-unit.mjs（全绿退出码 0）。
import {
  nameError,
  reservedError,
  streamNameError,
  toolNameError,
  derivedNameError,
  isValidStreamName,
  isValidToolName,
  toStreamName,
  toToolName,
  MAX_NAME_CP,
  MAX_NAME_BYTES,
  MAX_USER_CP,
  MAX_USER_BYTES,
} from '../src/se/nameContract.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 200) : ''}`);
};

const cpLen = (s) => [...String(s)].length;
const bytes = (s) => new TextEncoder().encode(String(s)).length;
const valid = (n) => streamNameError(n) === null;
const invalid = (n) => streamNameError(n) !== null;

try {
  // ── a. 合法流名矩阵 ────────────────────────────────────────────────
  const legal = [
    'workflow',
    '_hidden',
    '工作流',
    'てすと',            // Hiragana
    'テスト',            // Katakana
    '한글',              // Hangul
    'ㄅㄆㄇ',            // Bopomofo
    'café',              // Latin + 组合字符（é 为单码点，NFKC 稳定）
    '流A_1',
    'a',
    '_a',
  ];
  legal.forEach((n) => check(`a 合法流名：${JSON.stringify(n)}`, valid(n), streamNameError(n)));

  // ── b. 非法流名矩阵 ────────────────────────────────────────────────
  const illegal = [
    ['has-dash', '连字符'],
    ['has space', '空格'],
    ['has.dot', '点'],
    ['has/slash', '斜杠'],
    ['Привет', '西里尔'],
    ['Ελληνικά', '希腊'],
    ['１ＡＢ', '全角 NFKC 兼容'],
    ['ﬁle', '连字 NFKC 兼容'],
    ['Ⅻ', '罗马数字 NFKC 兼容'],
    ['a\u0301', '组合标记'],
    ['\u200D', 'ZWJ'],
    ['\uD800', '孤立代理'],
    ['123', '纯数字'],
    ['1abc', '数字开头'],
    ['', '空串'],
    ['_', '仅下划线（无字母）'],
  ];
  illegal.forEach(([n, why]) => check(`b 非法流名（${why}）：${JSON.stringify(n)}`, invalid(n), streamNameError(n)));
  check('b 非字符串 → 非法', streamNameError(123) !== null && streamNameError(null) !== null);

  // ── c. 保留位（仅流用户面）─────────────────────────────────────────
  check('c 流不得以 _console 结尾', invalid('foo_console'), streamNameError('foo_console'));
  check('c 流不得以 _scan_log 结尾', invalid('foo_scan_log'), streamNameError('foo_scan_log'));
  check('c 流不得以 _scan_end_ 开头', invalid('_scan_end_x'), streamNameError('_scan_end_x'));
  check('c 流不得以 _control_ 开头', invalid('_control_x'), streamNameError('_control_x'));
  check('c 工具名无保留位（echo_console 合法）', isValidToolName('echo_console'), toolNameError('echo_console'));
  check('c 工具名无保留位（x_scan_log 合法）', isValidToolName('x_scan_log'), toolNameError('x_scan_log'));

  // ── d. 长度边界 ────────────────────────────────────────────────────
  check(`d 用户面 ${MAX_USER_CP} ASCII 字母合法`, valid('a'.repeat(MAX_USER_CP)), streamNameError('a'.repeat(MAX_USER_CP)));
  check(`d 用户面 ${MAX_USER_CP + 1} ASCII 字母非法（码点超限）`, invalid('a'.repeat(MAX_USER_CP + 1)));
  // CJK 每字 3 字节：39 字 = 117B ≤ 119 合法；40 字 = 120B 超字节上限非法（即便码点 40 < 55）。
  check('d 39 个 CJK 合法（字节 117≤119）', valid('中'.repeat(39)), `bytes=${bytes('中'.repeat(39))}`);
  check('d 40 个 CJK 非法（字节 120>119）', invalid('中'.repeat(40)), `bytes=${bytes('中'.repeat(40))}`);
  check(`d 硬上限 ${MAX_NAME_CP}（derived）合法`, derivedNameError('a'.repeat(MAX_NAME_CP)) === null);
  check(`d 硬上限 ${MAX_NAME_CP + 1}（derived）非法`, derivedNameError('a'.repeat(MAX_NAME_CP + 1)) !== null);

  // ── e. 常量与 naming.py 对齐 ───────────────────────────────────────
  check('e 常量对齐', MAX_NAME_CP === 64 && MAX_NAME_BYTES === 128 && MAX_USER_CP === 55 && MAX_USER_BYTES === 119,
    `${MAX_NAME_CP}/${MAX_NAME_BYTES}/${MAX_USER_CP}/${MAX_USER_BYTES}`);

  // ── f. toStreamName 派生 ───────────────────────────────────────────
  const t1 = toStreamName('工作流');
  check('f toStreamName 保留 CJK', t1 === '工作流', t1);
  const t2 = toStreamName('my stream!');
  check('f toStreamName 非法字符折叠 + 去尾', t2 === 'my_stream', t2);
  const t3 = toStreamName('a-b.c/d');
  check('f toStreamName 分隔符折叠', t3 === 'a_b_c_d', t3);
  const t4 = toStreamName('123');
  check('f toStreamName 纯数字 → stream_<hex> 且合法', /^stream_[0-9a-f]{8}$/.test(t4) && valid(t4), t4);
  const t5 = toStreamName('2023年复盘');
  check('f toStreamName 去前导数字保留 CJK', t5 === '年复盘', t5);
  const t6 = toStreamName('foo_console');
  check('f toStreamName 修保留后缀', t6 === 'foo_console_' && valid(t6), t6);
  const t7 = toStreamName('');
  check('f toStreamName 空 → stream_<hex>', /^stream_[0-9a-f]{8}$/.test(t7) && valid(t7), t7);
  const t8 = toStreamName('あ'.repeat(60));
  check('f toStreamName 长度收敛（码点/字节）', cpLen(t8) <= MAX_USER_CP && bytes(t8) <= MAX_USER_BYTES && valid(t8),
    `cp=${cpLen(t8)} bytes=${bytes(t8)}`);
  check('f toStreamName 输出恒 NFKC 稳定', [t1, t2, t3, t4, t5, t6, t7, t8].every((x) => x.normalize('NFKC') === x));

  // ── g. toStreamName 去重 ───────────────────────────────────────────
  check('g 去重 _2', toStreamName('工作流', ['工作流']) === '工作流_2');
  check('g 去重 _3', toStreamName('工作流', ['工作流', '工作流_2']) === '工作流_3');
  check('g Set 入参', toStreamName('工作流', new Set(['工作流'])) === '工作流_2');

  // ── h. toToolName ──────────────────────────────────────────────────
  const k1 = toToolName('我的工具');
  check('h toToolName 保留 CJK', k1 === '我的工具' && isValidToolName(k1), k1);
  const k2 = toToolName('echo_console');
  check('h toToolName 不修保留后缀', k2 === 'echo_console' && isValidToolName(k2), k2);
  const k3 = toToolName('read file!');
  check('h toToolName 净化', k3 === 'read_file', k3);

  // ── i. reservedError 直接调用 ──────────────────────────────────────
  check('i reservedError 合法', reservedError('workflow') === null);
  check('i reservedError 命中后缀', reservedError('a_console') !== null);
} catch (err) {
  check('单测执行', false, err.stack || String(err));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
