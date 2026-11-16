// config.load 通道纯 Node 单测：参数合成 / 结果映射 / id 演化。
// 运行：node scripts/smoke-config-load-unit.mjs（全绿退出码 0）。
import assert from 'node:assert/strict';
import {
  buildConfigLoadParams,
  mapConfigLoadResult,
  evolveManifestId,
} from '../src/se/manifest.js';

assert.deepEqual(
  buildConfigLoadParams('D:/g/计划.se.json', { dryRun: true }),
  { path: 'D:/g/计划.se.json', dry_run: true }
);
assert.deepEqual(buildConfigLoadParams('D:/g/计划.se.json'), { path: 'D:/g/计划.se.json' });
assert.deepEqual(
  buildConfigLoadParams('D:/g/计划.se.json', { skipStreams: ['a', 'b'] }),
  { path: 'D:/g/计划.se.json', skip_streams: ['a', 'b'] }
);
assert.deepEqual(
  buildConfigLoadParams('D:/g/计划.se.json', { dryRun: true, skipStreams: [] }),
  { path: 'D:/g/计划.se.json', dry_run: true }
);
// D-B：id = <图名>#<内容指纹>（内容变 → 新 id）。
assert.equal(evolveManifestId('计划', 'bbb'), '计划#bbb');
assert.equal(evolveManifestId('计划#stale', 'bbb'), '计划#stale#bbb');
assert.deepEqual(
  mapConfigLoadResult({
    loaded: [{ entity: 'inbox' }, { name: 'fallback_name' }],
    skipped: [{ entity: 'x', reason: '已在册' }],
    errors: [],
    preview: {},
  }),
  {
    created: ['inbox', 'fallback_name'],
    skipped: [{ entity: 'x', reason: '已在册' }],
    errors: [],
    preview: {},
  }
);
assert.deepEqual(mapConfigLoadResult(null), { created: [], skipped: [], errors: [], preview: {} });
console.log('smoke-config-load-unit: OK');
