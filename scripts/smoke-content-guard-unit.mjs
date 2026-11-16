// 正文保真守卫纯 Node 单测：`collectPushableContents` 的推送谓词 + `projectStreams` 的
// contentState 诚实性。覆盖「未加载/缺失不写空」「已知空文件保留 loaded 语义」。
// 零 SE、零 DOM。运行：node scripts/smoke-content-guard-unit.mjs（全绿退出码 0）。
import { collectPushableContents, projectStreams } from '../src/se/streams.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 180) : ''}`);
};

try {
  // ── 1. collectPushableContents：仅 s-* 且 contentState==='loaded' ────────
  const nodes = [
    {
      id: 's-alpha',
      data: {
        contentState: 'loaded',
        content: '正文',
        description: '描述',
        fields: [{ key: 'role', value: 'a' }, { key: '', value: '忽略' }],
      },
    },
    { id: 's-beta', data: { content: '' } }, // contentState undefined → 排除
    { id: 's-missing', data: { contentState: 'missing', content: 'x' } }, // missing → 排除
    { id: 'n-local', data: { contentState: 'loaded', content: '本地' } }, // 非 s-* → 排除
  ];
  const pushable = collectPushableContents(nodes);
  check(
    '1a collectPushableContents：只保留 loaded 的 s-*',
    pushable.length === 1 && pushable[0].name === 'alpha',
    JSON.stringify(pushable.map((p) => p.name))
  );
  check(
    '1b collectPushableContents：字段映射正确（name/description/tags/content，无 title）',
    pushable[0].description === '描述' &&
      pushable[0].content === '正文' &&
      pushable[0].tags.role === 'a' &&
      Object.keys(pushable[0].tags).length === 1 &&
      !('title' in pushable[0]),
    JSON.stringify(pushable[0])
  );

  const emptyLoaded = collectPushableContents([
    { id: 's-empty', data: { contentState: 'loaded', content: '' } },
  ]);
  check(
    '1c collectPushableContents：loaded 的空文件仍可推送（content 空串）',
    emptyLoaded.length === 1 && emptyLoaded[0].content === '',
    JSON.stringify(emptyLoaded)
  );

  const nonArray = collectPushableContents(null);
  check('1d collectPushableContents：非数组输入 → 空数组', Array.isArray(nonArray) && nonArray.length === 0);

  // ── 2. projectStreams：contentState 诚实性 ───────────────────────────────
  const r1 = projectStreams(
    [{ name: 'alpha', tags: {} }],
    [{ id: 's-alpha', position: { x: 0, y: 0 }, data: { content: '正文' } }]
  );
  const a1 = r1.nodes.find((n) => n.id === 's-alpha');
  check(
    '2a prev 有内容 → content 保留 + contentState=loaded',
    a1.data.content === '正文' && a1.data.contentState === 'loaded',
    JSON.stringify(a1.data)
  );

  const r2 = projectStreams(
    [{ name: 'empty', tags: {} }],
    [{ id: 's-empty', position: { x: 0, y: 0 }, data: { contentState: 'loaded' } }]
  );
  const a2 = r2.nodes.find((n) => n.id === 's-empty');
  check(
    '2b prev 已知空（loaded，无 content）→ contentState=loaded（保守留）',
    a2.data.content === undefined && a2.data.contentState === 'loaded',
    JSON.stringify(a2.data)
  );

  const r3 = projectStreams([{ name: 'fresh', tags: {} }], []);
  const a3 = r3.nodes.find((n) => n.id === 's-fresh');
  check(
    '2c 无 prev → contentState=unknown（guard 不写空）',
    a3.data.content === undefined && a3.data.contentState === 'unknown',
    JSON.stringify(a3.data)
  );

  const r4 = projectStreams(
    [{ name: 'srv', tags: {} }],
    [{ id: 's-srv', position: { x: 0, y: 0 }, data: { contentState: 'unknown', content: '仅内存' } }]
  );
  const a4 = r4.nodes.find((n) => n.id === 's-srv');
  check(
    '2d prev 有内容但状态 unknown → 内容保留且升级为 loaded',
    a4.data.content === '仅内存' && a4.data.contentState === 'loaded',
    JSON.stringify(a4.data)
  );
} catch (err) {
  check('单测执行', false, err.stack || String(err));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
