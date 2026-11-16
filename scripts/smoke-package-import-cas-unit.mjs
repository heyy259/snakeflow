// Tier-1 单测（Node 直跑）：applyImport 的 CAS（casVersions）与空正文禁覆盖（protectNonempty）。
// 契约：
// - casVersions 提供时，update 分支写带 expected_version；无版本记录则不带；
// - protectNonempty=true 时，包内空正文绝不写 SE（防陈旧包清空实存内容），记 warning；
// - protectNonempty 缺省/false 保持旧行为（空正文照写），pushFileStreams 等 file-master 路径不受影响；
// - CAS 冲突（-32010）不算 failed：记 warning（保留 SE 版本），继续其余；不重试（有界）。
import { applyImport } from '../src/se/packageImport.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 220) : ''}`);
};

const MANIFEST = {
  $schema: 'snake-manifest-v1',
  streams: [
    { name: 'alpha', description: '', tags: {} },
    { name: 'beta', description: '', tags: {} },
    { name: 'gamma', description: '', tags: {} },
  ],
  tools: [],
};

function makePlan() {
  const row = (name) => ({
    name, state: 'update', selected: true, contentChanged: true,
    descriptionChanged: false, tagDiff: { set: {}, remove: [] },
  });
  return { streams: [row('alpha'), row('beta'), row('gamma')], tools: [], predictedDangling: [], warnings: [] };
}

async function main() {
  // 1. casVersions：有版本记录的写带 expected_version，无记录的不带
  {
    const writes = [];
    const contents = new Map([['alpha', 'A'], ['beta', 'B'], ['gamma', 'C']]);
    const summary = await applyImport({
      plan: makePlan(), manifest: MANIFEST,
      call: async (m, p) => {
        if (m === 'stream.write') { writes.push(p); return { version: (p.expected_version || 0) + 1 }; }
        return {};
      },
      contents,
      casVersions: new Map([['alpha', 7], ['beta', 3]]),
      protectNonempty: true,
    });
    const a = writes.find((w) => w.name === 'alpha');
    const g = writes.find((w) => w.name === 'gamma');
    check('casVersions：有版本 → 写带 expected_version', !!a && a.expected_version === 7, JSON.stringify(a));
    check('casVersions：无版本 → 不带 expected_version', !!g && !('expected_version' in g), JSON.stringify(g));
    check('全部更新成功', summary.streams.failed === 0 && summary.streams.updated === 3, JSON.stringify(summary.streams));
  }
  // 2. protectNonempty：空正文跳过写入 + 记 warning；非空照写
  {
    const writes = [];
    const contents = new Map([['alpha', ''], ['beta', 'B2'], ['gamma', '']]);
    const summary = await applyImport({
      plan: makePlan(), manifest: MANIFEST,
      call: async (m, p) => { if (m === 'stream.write') writes.push(p); return {}; },
      contents,
      casVersions: new Map(),
      protectNonempty: true,
    });
    check('protectNonempty：空正文不写', !writes.some((w) => w.name === 'alpha') && !writes.some((w) => w.name === 'gamma'), JSON.stringify(writes));
    check('protectNonempty：非空照写', writes.some((w) => w.name === 'beta' && w.text === 'B2'));
    check('protectNonempty：跳过有 warning', summary.warnings.some((w) => String(w).includes('alpha')), JSON.stringify(summary.warnings));
  }
  // 3. protectNonempty 缺省：空正文照写（旧行为兼容）
  {
    const writes = [];
    const contents = new Map([['alpha', ''], ['beta', 'B'], ['gamma', 'C']]);
    await applyImport({
      plan: makePlan(), manifest: MANIFEST,
      call: async (m, p) => { if (m === 'stream.write') writes.push(p); return {}; },
      contents,
    });
    check('默认（无 protectNonempty）：空正文仍写', writes.some((w) => w.name === 'alpha' && w.text === ''));
  }
  // 4. CAS 冲突（-32010）：不算 failed、记 warning、其余继续
  {
    const contents = new Map([['alpha', 'A'], ['beta', 'B'], ['gamma', 'C']]);
    const summary = await applyImport({
      plan: makePlan(), manifest: MANIFEST,
      call: async (m, p) => {
        if (m === 'stream.write' && p.name === 'beta') {
          const err = new Error('version mismatch');
          err.code = -32010;
          throw err;
        }
        return {};
      },
      contents,
      casVersions: new Map([['beta', 1]]),
      protectNonempty: true,
    });
    check('CAS 冲突不算 failed', summary.streams.failed === 0, JSON.stringify(summary.streams));
    check('CAS 冲突记 warning（保留 SE 版本）', summary.warnings.some((w) => String(w).includes('beta') && String(w).includes('冲突')), JSON.stringify(summary.warnings));
  }
  // 5. 非 CAS 写错误仍计 failed
  {
    const contents = new Map([['alpha', 'A'], ['beta', 'B'], ['gamma', 'C']]);
    const summary = await applyImport({
      plan: makePlan(), manifest: MANIFEST,
      call: async (m, p) => { if (m === 'stream.write' && p.name === 'beta') throw new Error('io'); return {}; },
      contents,
    });
    check('普通写错误计 failed', summary.streams.failed === 1, JSON.stringify(summary.streams));
  }
  // 6. create 后他端抢先写入：初始化必须带 create.version CAS，冲突保留远端且有界
  {
    const plan = {
      streams: [{ name: 'alpha', state: 'new', selected: true, contentChanged: true, descriptionChanged: false, tagDiff: { set: {}, remove: [] } }],
      tools: [], predictedDangling: [], warnings: [],
    };
    const writes = [];
    const remote = { text: '', version: 7 };
    let concurrentWrite = true;
    const summary = await applyImport({
      plan, manifest: MANIFEST,
      call: async (m, p) => {
        if (m === 'stream.create') return { version: 7 };
        if (m === 'stream.write') {
          writes.push(p);
          if (concurrentWrite) {
            concurrentWrite = false;
            remote.text = 'concurrent remote';
            remote.version = 8;
          }
          if (p.expected_version != null && p.expected_version !== remote.version) {
            const err = new Error('version mismatch');
            err.code = -32010;
            throw err;
          }
          remote.text = p.text;
          remote.version += 1;
          return { version: remote.version };
        }
        return {};
      },
      contents: new Map([['alpha', 'initialization']]),
    });
    check('create 初始化写复用 created.version', writes.length === 1 && writes[0].expected_version === 7, JSON.stringify(writes));
    check('create→remote write→初始化冲突：远端内容保留且仅尝试一次', writes.length === 1 && remote.text === 'concurrent remote' && remote.version === 8, JSON.stringify({ writes, remote }));
    check(
      'create 初始化 CAS 冲突：created 如实保留、零 failed、记 warning',
      summary.streams.created === 1 && summary.streams.updated === 0 && summary.streams.failed === 0 && summary.errors.length === 0 &&
        summary.warnings.some((w) => String(w).includes('alpha') && String(w).includes('冲突')),
      JSON.stringify(summary)
    );
    check(
      'create 初始化 CAS 冲突：不暴露 versions、conflicts 明确、createdWithWarning 分层',
      !('alpha' in summary.streams.versions) &&
        summary.streams.written === 0 &&
        summary.streams.createdWithWarning === 1 &&
        summary.streams.conflicts.some((c) => c.name === 'alpha' && c.reason === 'version-conflict'),
      JSON.stringify({ streams: summary.streams })
    );
  }
  // 7. create 缺 version：fail-closed（不写正文、不暴露版本、明确冲突信号）
  {
    const calls = [];
    const plan = {
      streams: [{ name: 'alpha', state: 'new', selected: true, contentChanged: true, descriptionChanged: false, tagDiff: { set: {}, remove: [] } }],
      tools: [], predictedDangling: [], warnings: [],
    };
    const summary = await applyImport({
      plan, manifest: MANIFEST,
      call: async (m, p) => {
        calls.push({ method: m, params: p });
        if (m === 'stream.create') return {};
        if (m === 'stream.write') return { version: 9 };
        return {};
      },
      contents: new Map([['alpha', 'body']]),
      createOnly: true,
    });
    check(
      'create 缺 created.version：不写正文、不播种版本（fail-closed）',
      summary.streams.created === 1 && summary.streams.failed === 0 &&
        !calls.some((c) => c.method === 'stream.write') &&
        !('alpha' in summary.streams.versions),
      JSON.stringify({ streams: summary.streams, calls })
    );
    check(
      'create 缺 created.version：conflicts=missing-version + createdWithWarning',
      summary.streams.written === 0 &&
        summary.streams.createdWithWarning === 1 &&
        summary.streams.conflicts.some((c) => c.name === 'alpha' && c.reason === 'missing-version') &&
        summary.warnings.some((w) => String(w).includes('alpha') && String(w).includes('version')),
      JSON.stringify({ streams: summary.streams, warnings: summary.warnings })
    );
  }
  // 8. create 后初始化写普通失败：created 如实、版本抑制、错误+冲突信号
  {
    const plan = {
      streams: [{ name: 'alpha', state: 'new', selected: true, contentChanged: true, descriptionChanged: false, tagDiff: { set: {}, remove: [] } }],
      tools: [], predictedDangling: [], warnings: [],
    };
    const summary = await applyImport({
      plan, manifest: MANIFEST,
      call: async (m) => {
        if (m === 'stream.create') return { version: 3 };
        if (m === 'stream.write') throw new Error('io');
        return {};
      },
      contents: new Map([['alpha', 'body']]),
    });
    check(
      'create 初始化写失败：created=1、版本抑制、errors+conflicts 明确',
      summary.streams.created === 1 && summary.streams.written === 0 &&
        summary.streams.createdWithWarning === 1 &&
        summary.errors.length === 1 &&
        !('alpha' in summary.streams.versions) &&
        summary.streams.conflicts.some((c) => c.name === 'alpha' && c.reason === 'initialization-failed'),
      JSON.stringify({ streams: summary.streams, errors: summary.errors })
    );
  }
  // 9. 有意空流：create.version 直接作为已确立版本，不写正文
  {
    const writes = [];
    const plan = {
      streams: [{ name: 'alpha', state: 'new', selected: true, contentChanged: false, descriptionChanged: false, tagDiff: { set: {}, remove: [] } }],
      tools: [], predictedDangling: [], warnings: [],
    };
    const summary = await applyImport({
      plan, manifest: MANIFEST,
      call: async (m, p) => {
        if (m === 'stream.create') return { version: 5 };
        if (m === 'stream.write') writes.push(p);
        return {};
      },
      contents: new Map([['alpha', '']]),
    });
    check(
      'create 有意空流：versions=created.version、written=1、零 write/零 warning',
      writes.length === 0 &&
        summary.streams.versions.alpha === 5 &&
        summary.streams.written === 1 &&
        summary.streams.createdWithWarning === 0 &&
        summary.streams.conflicts.length === 0,
      JSON.stringify({ streams: summary.streams, writes })
    );
  }
  // 10. create 后初始化写成功：采用 write.version（而非 create.version）
  {
    const plan = {
      streams: [{ name: 'alpha', state: 'new', selected: true, contentChanged: true, descriptionChanged: false, tagDiff: { set: {}, remove: [] } }],
      tools: [], predictedDangling: [], warnings: [],
    };
    const summary = await applyImport({
      plan, manifest: MANIFEST,
      call: async (m) => {
        if (m === 'stream.create') return { version: 4 };
        if (m === 'stream.write') return { version: 5 };
        return {};
      },
      contents: new Map([['alpha', 'body']]),
    });
    check(
      'create 初始化写成功：versions=write.version、written=1、无冲突',
      summary.streams.versions.alpha === 5 &&
        summary.streams.written === 1 &&
        summary.streams.createdWithWarning === 0 &&
        summary.streams.conflicts.length === 0,
      JSON.stringify(summary.streams)
    );
  }
  // 11. 写成功但缺 write.version：不伪造 create.version，抑制版本并标冲突
  {
    const plan = {
      streams: [{ name: 'alpha', state: 'new', selected: true, contentChanged: true, descriptionChanged: false, tagDiff: { set: {}, remove: [] } }],
      tools: [], predictedDangling: [], warnings: [],
    };
    const summary = await applyImport({
      plan, manifest: MANIFEST,
      call: async (m) => {
        if (m === 'stream.create') return { version: 4 };
        if (m === 'stream.write') return {};
        return {};
      },
      contents: new Map([['alpha', 'body']]),
    });
    check(
      'create 写成功但缺 write.version：内容已写、版本抑制、conflicts=missing-write-version',
      !('alpha' in summary.streams.versions) &&
        summary.streams.written === 1 &&
        summary.streams.createdWithWarning === 1 &&
        summary.streams.conflicts.some((c) => c.name === 'alpha' && c.reason === 'missing-write-version'),
      JSON.stringify(summary.streams)
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `\nFAIL ${failed.length}/${results.length}` : `\nALL PASS ${results.length}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
