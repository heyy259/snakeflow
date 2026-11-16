// P2 单测（零 SE、零 DOM）：码点多 hunk 差分 + commitContent 最小 range RPC 提交。
// 运行：node scripts/smoke-se-edit-range.mjs（全绿退出码 0）。
import {
  diffCodePoints,
  MAX_DIFF_CODE_POINTS,
  MAX_DIFF_EDIT_DISTANCE,
} from '../src/se/textDiff.js';
import { createSeOrchestrator } from '../src/se/orchestrator.js';
import { sePool, SE_STATUS } from '../src/se/pool.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 220) : ''}`);
};

const hunkStr = (h) => `${h.type}[${h.start},${h.end})${JSON.stringify(h.text)}`;

// ── 1. 纯差分 ────────────────────────────────────────────────────────────────
{
  check('no-op → []', JSON.stringify(diffCodePoints('abc', 'abc')) === '[]');
  check('empty→empty → []', JSON.stringify(diffCodePoints('', '')) === '[]');

  const ins = diffCodePoints('abc', 'abXc');
  check(
    'insert → start=end（码点）',
    ins && ins.length === 1 && ins[0].type === 'insert' && ins[0].start === 2 && ins[0].end === 2 && ins[0].text === 'X',
    JSON.stringify(ins)
  );

  const del = diffCodePoints('abcXYZdef', 'abcdef');
  check(
    'delete → delete_range [3,6) text=""',
    del && del.length === 1 && del[0].type === 'delete' && del[0].start === 3 && del[0].end === 6 && del[0].text === '',
    JSON.stringify(del)
  );

  const rep = diffCodePoints('abcDEFghi', 'abcXYZghi');
  check(
    'replace → [3,6) "XYZ"',
    rep && rep.length === 1 && rep[0].type === 'replace' && rep[0].start === 3 && rep[0].end === 6 && rep[0].text === 'XYZ',
    JSON.stringify(rep)
  );

  const merged = diffCodePoints('ab', 'xy');
  check(
    '整段替换合并为单 hunk',
    merged && merged.length === 1 && merged[0].type === 'replace' && merged[0].start === 0 && merged[0].end === 2 && merged[0].text === 'xy',
    JSON.stringify(merged)
  );

  const multi = diffCodePoints('one A two B three', 'one X two Y three');
  const middle = ' two ';
  const middleStart = 'one A two B three'.indexOf(middle);
  const middleEnd = middleStart + middle.length;
  const spansMiddle = (h) =>
    (h.type === 'insert' ? h.start > middleStart && h.start < middleEnd : h.start < middleEnd && h.end > middleStart);
  check(
    '分散编辑 → 2 个独立 hunk',
    multi && multi.length === 2 && multi[0].start === 4 && multi[1].start === 10,
    JSON.stringify(multi)
  );
  check('hunk 不跨过未改动的中间文本', multi && !multi.some(spansMiddle), JSON.stringify(multi));
}

// ── 2. emoji / 非 BMP：码点偏移而非 UTF-16 ───────────────────────────────────
{
  const before = diffCodePoints('a😀', 'aX😀');
  check(
    'emoji 前插入 → pos=1（UTF-16 会是 2）',
    before && before.length === 1 && before[0].type === 'insert' && before[0].start === 1 && before[0].text === 'X',
    JSON.stringify(before)
  );
  const after = diffCodePoints('😀b', '😀Xb');
  check(
    'emoji 后插入 → pos=1（UTF-16 会是 2）',
    after && after.length === 1 && after[0].type === 'insert' && after[0].start === 1 && after[0].text === 'X',
    JSON.stringify(after)
  );
  const middleEmoji = diffCodePoints('a😀b', 'a😀Xb');
  check(
    '非 BMP 之后插入 → pos=2 码点',
    middleEmoji && middleEmoji.length === 1 && middleEmoji[0].start === 2 && middleEmoji[0].text === 'X',
    JSON.stringify(middleEmoji)
  );
}

// ── 3. 规模/距离守卫 → null（调用方整篇写）──────────────────────────────────
{
  const tooLong = 'a'.repeat(MAX_DIFF_CODE_POINTS + 1);
  check('长度 > 200000 码点 → null', diffCodePoints(tooLong, `${tooLong}b`) === null);
  const far = 'a'.repeat(MAX_DIFF_EDIT_DISTANCE + 1000);
  const far2 = 'b'.repeat(MAX_DIFF_EDIT_DISTANCE + 1000);
  check('编辑距离 > 2000 → null', diffCodePoints(far, far2) === null);
}

// ── 4. commitContent：mock client.call（不启动 SE）────────────────────────────
const originalGet = sePool.get;

function makeOrchestrator({ baseline, version, localText, call }) {
  const calls = [];
  const fake = {
    status: SE_STATUS.ONLINE,
    call: async (method, params) => {
      calls.push({ method, params });
      return call(method, params);
    },
  };
  sePool.get = () => fake;
  const port = {
    getActiveSystemId: () => 'sid-test',
    isOffline: () => false,
    getNodes: () => [{ id: 's-doc', type: 'agent', data: { content: localText } }],
    notify: () => {},
    setStatus: () => {},
    getEditingNodeId: () => null,
  };
  const se = createSeOrchestrator(() => port);
  se.subscribeStatuses(['sid-test']); // 显式生命周期建会话（普通写不再隐式创建）
  se.baselineSet('sid-test', 'doc', version, baseline);
  return { se, calls };
}

async function commitCase(name, spec, assert) {
  const { se, calls } = makeOrchestrator(spec);
  const res = await se.commitContent('s-doc', spec.localText);
  check(name, assert(res, calls), JSON.stringify({ res, calls }));
}

async function main() {
  await commitCase(
    'commit insert → stream.insert + expected_version',
    {
      baseline: 'abc',
      version: 10,
      localText: 'abXc',
      call: async () => ({ version: 11 }),
    },
    (res, calls) => {
      const c = calls[0];
      return (
        res.ok === true &&
        res.version === 11 &&
        calls.length === 1 &&
        c.method === 'stream.insert' &&
        c.params.pos === 2 &&
        c.params.text === 'X' &&
        c.params.expected_version === 10
      );
    }
  );

  await commitCase(
    'commit delete → stream.delete_range',
    {
      baseline: 'abcXYZdef',
      version: 4,
      localText: 'abcdef',
      call: async () => ({ version: 5 }),
    },
    (res, calls) => {
      const c = calls[0];
      return (
        res.ok === true &&
        calls.length === 1 &&
        c.method === 'stream.delete_range' &&
        c.params.start === 3 &&
        c.params.end === 6 &&
        c.params.expected_version === 4
      );
    }
  );

  await commitCase(
    'commit replace → stream.replace_range',
    {
      baseline: 'abcDEFghi',
      version: 7,
      localText: 'abcXYZghi',
      call: async () => ({ version: 8 }),
    },
    (res, calls) => {
      const c = calls[0];
      return (
        res.ok === true &&
        calls.length === 1 &&
        c.method === 'stream.replace_range' &&
        c.params.start === 3 &&
        c.params.end === 6 &&
        c.params.text === 'XYZ' &&
        c.params.expected_version === 7
      );
    }
  );

  await commitCase(
    'commit 多 hunk：降序应用 + version 链式推进',
    {
      baseline: 'one A two B three',
      version: 1,
      localText: 'one X two Y three',
      call: async (m, p) => ({ version: Number(p.expected_version) + 1 }),
    },
    (res, calls) => {
      const rangeCalls = calls.filter((c) => c.method.startsWith('stream.') && !c.method.includes('read') && !c.method.includes('metadata'));
      return (
        res.ok === true &&
        rangeCalls.length === 2 &&
        rangeCalls[0].method === 'stream.replace_range' &&
        rangeCalls[0].params.start === 10 &&
        rangeCalls[0].params.expected_version === 1 &&
        rangeCalls[1].params.start === 4 &&
        rangeCalls[1].params.expected_version === 2 &&
        res.version === 3
      );
    }
  );

  await commitCase(
    'commit CAS(-32010) → 重读重算后重试成功',
    {
      baseline: 'abc',
      version: 1,
      localText: 'abcX',
      call: async (m, p) => {
        if (m === 'stream.read') return { text: 'Zabc' };
        if (m === 'stream.get_metadata') return { version: 20 };
        if (m === 'stream.write') return { version: 99 };
        if (p && p.expected_version === 1) {
          const err = new Error('version mismatch');
          err.code = -32010;
          throw err;
        }
        return { version: 21 };
      },
    },
    (res, calls) => {
      const retried = calls.find(
        (c) => c.method.startsWith('stream.') && c.method !== 'stream.read' && c.method !== 'stream.get_metadata' && c.params.expected_version === 20
      );
      return res.ok === true && res.version === 21 && !!retried;
    }
  );

  await commitCase(
    'commit CAS 重试耗尽 → 整篇 write + rescanRequired',
    {
      baseline: 'abc',
      version: 1,
      localText: 'abcX',
      call: async (m) => {
        if (m === 'stream.read') return { text: 'Zabc' };
        if (m === 'stream.get_metadata') return { version: 20 };
        if (m === 'stream.write') return { version: 30 };
        const err = new Error('version mismatch');
        err.code = -32010;
        throw err;
      },
    },
    (res, calls) => {
      const write = calls.find((c) => c.method === 'stream.write');
      return (
        res.ok === true &&
        res.rescanRequired === true &&
        res.version === 30 &&
        !!write &&
        write.params.text === 'abcX'
      );
    }
  );

  await commitCase(
    'commit diff 超限 → 整篇 write + rescanRequired',
    {
      baseline: 'a'.repeat(MAX_DIFF_CODE_POINTS + 1),
      version: 2,
      localText: `${'a'.repeat(MAX_DIFF_CODE_POINTS + 1)}b`,
      call: async () => ({ version: 3 }),
    },
    (res, calls) => {
      return (
        res.ok === true &&
        res.rescanRequired === true &&
        calls.length === 1 &&
        calls[0].method === 'stream.write' &&
        calls[0].params.expected_version === 2
      );
    }
  );

  await commitCase(
    'commit no-op → unchanged，无 RPC',
    {
      baseline: 'same',
      version: 5,
      localText: 'same',
      call: async () => {
        throw new Error('should not call RPC');
      },
    },
    (res, calls) => res.ok === false && res.reason === 'unchanged' && calls.length === 0
  );
}

main()
  .catch((err) => {
    check('测试执行', false, err.stack || String(err));
  })
  .finally(() => {
    sePool.get = originalGet;
    const failed = results.filter((r) => !r.ok);
    console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
    process.exit(failed.length ? 1 : 0);
  });
