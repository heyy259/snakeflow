// owned-source 改名计划纯单测：
// - 只允许当前 tab 的 <docBase>.streams 目录内的相对镜像；
// - 外部绝对路径 / `..` / 其他目录永不移动；
// - legacy `graphs/<base>.streams/...` 归一化为 manifest 相对；
// - 冲突后缀、扩展名保留、仅大小写改名。
import assert from 'node:assert/strict';
import {
  isCrossGraphSource,
  ownedStreamsDirName,
  planOwnedSourceRename,
  resolveOwnedSourcePath,
} from '../src/se/ownedSource.js';

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    throw err;
  }
};

check('owned dir name', () => {
  assert.equal(ownedStreamsDirName('图 A'), '图 A.streams');
  assert.equal(ownedStreamsDirName(''), '');
});

check('relative owned source → new basename', () => {
  const plan = planOwnedSourceRename({
    sourcePath: '图 A.streams/old.md',
    configDir: 'graphs',
    docBase: '图 A',
    newName: '新名',
  });
  assert.equal(plan.to, '图 A.streams/新名.md');
  assert.equal(plan.fromAbs, 'graphs/图 A.streams/old.md');
  assert.equal(plan.toAbs, 'graphs/图 A.streams/新名.md');
  assert.equal(plan.caseOnly, false);
});

check('legacy graphs/ prefix is normalized', () => {
  const plan = planOwnedSourceRename({
    sourcePath: 'graphs/图 A.streams/old.md',
    configDir: 'graphs',
    docBase: '图 A',
    newName: '新名',
  });
  assert.equal(plan.fromAbs, 'graphs/图 A.streams/old.md');
  assert.equal(plan.to, '图 A.streams/新名.md');
  assert.equal(plan.toAbs, 'graphs/图 A.streams/新名.md');
});

check('absolute config dir', () => {
  const plan = planOwnedSourceRename({
    sourcePath: '图 A.streams/old.md',
    configDir: 'C:/proj/graphs',
    docBase: '图 A',
    newName: '新名',
  });
  assert.equal(plan.fromAbs, 'C:/proj/graphs/图 A.streams/old.md');
  assert.equal(plan.toAbs, 'C:/proj/graphs/图 A.streams/新名.md');
});

check('external absolute source is immutable', () => {
  assert.equal(
    planOwnedSourceRename({
      sourcePath: 'D:/docs/old.md',
      configDir: 'graphs',
      docBase: '图 A',
      newName: '新名',
    }),
    null
  );
});

check('parent escape is immutable', () => {
  assert.equal(
    planOwnedSourceRename({
      sourcePath: '../docs/old.md',
      configDir: 'graphs',
      docBase: '图 A',
      newName: '新名',
    }),
    null
  );
});

check('another streams dir is immutable', () => {
  assert.equal(
    planOwnedSourceRename({
      sourcePath: '别的图.streams/old.md',
      configDir: 'graphs',
      docBase: '图 A',
      newName: '新名',
    }),
    null
  );
});

check('nested subdir is immutable', () => {
  assert.equal(
    planOwnedSourceRename({
      sourcePath: '图 A.streams/sub/old.md',
      configDir: 'graphs',
      docBase: '图 A',
      newName: '新名',
    }),
    null
  );
});

check('collision gets deterministic suffix', () => {
  const plan = planOwnedSourceRename({
    sourcePath: '图 A.streams/old.md',
    configDir: 'graphs',
    docBase: '图 A',
    newName: '新名',
    suffixTag: 's-图A',
    otherSourcePaths: ['graphs/图 A.streams/新名.md'],
    suffixIndex: 1,
  });
  assert.equal(plan.to, '图 A.streams/新名-s-图A.md');
});

check('collision index 2', () => {
  const plan = planOwnedSourceRename({
    sourcePath: '图 A.streams/old.md',
    configDir: 'graphs',
    docBase: '图 A',
    newName: '新名',
    suffixTag: 's-图A',
    otherSourcePaths: ['graphs/图 A.streams/新名.md', 'graphs/图 A.streams/新名-s-图A.md'],
    suffixIndex: 2,
  });
  assert.equal(plan.to, '图 A.streams/新名-s-图A_2.md');
});

check('extension preserved', () => {
  const plan = planOwnedSourceRename({
    sourcePath: '图 A.streams/old.txt',
    configDir: 'graphs',
    docBase: '图 A',
    newName: '新名',
  });
  assert.equal(plan.to, '图 A.streams/新名.txt');
});

check('case-only rename is flagged, not moved', () => {
  const plan = planOwnedSourceRename({
    sourcePath: '图 A.streams/old.md',
    configDir: 'graphs',
    docBase: '图 A',
    newName: 'OLD',
  });
  assert.equal(plan.caseOnly, true);
  assert.equal(plan.to, '图 A.streams/OLD.md');
});

check('empty name is a no-op', () => {
  assert.equal(
    planOwnedSourceRename({
      sourcePath: '图 A.streams/old.md',
      configDir: 'graphs',
      docBase: '图 A',
      newName: '   ',
    }),
    null
  );
});

check('internal streams are not moved', () => {
  assert.equal(
    planOwnedSourceRename({
      sourcePath: '图 A.streams/old.md',
      configDir: 'graphs',
      docBase: '图 A',
      newName: 'run_console',
    }),
    null
  );
});

check('resolve path strips legacy prefix only under graphs config', () => {
  assert.equal(
    resolveOwnedSourcePath('graphs/图 A.streams/old.md', 'graphs'),
    'graphs/图 A.streams/old.md'
  );
  assert.equal(
    resolveOwnedSourcePath('graphs/图 A.streams/old.md', 'C:/proj/graphs'),
    'C:/proj/graphs/图 A.streams/old.md'
  );
  assert.equal(
    resolveOwnedSourcePath('graphs/图 A.streams/old.md', 'C:/proj/pkg'),
    'C:/proj/pkg/graphs/图 A.streams/old.md'
  );
});

check('cross-graph source detection', () => {
  assert.equal(isCrossGraphSource('图 A.streams/old.md', '图 A'), false);
  assert.equal(isCrossGraphSource('graphs/图 A.streams/old.md', '图 A'), false);
  assert.equal(isCrossGraphSource('图 a.streams/old.md', '图 A'), false);
  assert.equal(isCrossGraphSource('图 A.streams/sub/old.md', '图 A'), false);
  assert.equal(isCrossGraphSource('别的图.streams/old.md', '图 A'), true);
  assert.equal(isCrossGraphSource('graphs/别的图.streams/old.md', '图 A'), true);
});

check('cross-graph detection ignores external/invalid paths', () => {
  assert.equal(isCrossGraphSource('D:/docs/old.md', '图 A'), false);
  assert.equal(isCrossGraphSource('../docs/old.md', '图 A'), false);
  assert.equal(isCrossGraphSource('old.md', '图 A'), false);
  assert.equal(isCrossGraphSource('', '图 A'), false);
});

console.log(`\n==== ${passed}/${passed} PASS ====`);
