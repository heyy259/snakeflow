// SE 身份层单元测试：真实目录名解析 / casefold / 原子占位 / create 分配 / 锁冲突文案。
// 纯本地临时目录，不启动 Python、不触碰项目 se-systems。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listStorageIds,
  resolveStorageId,
  claimStorageDir,
  removeEmptyClaim,
  allocateAndClaim,
  foldSystemId,
} from '../server/se/identity.js';
import { parseStorageRootBusy } from '../server/se/process.js';
import { sameSystemId } from '../src/se/nameContract.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`ok - ${name}`);
  } else {
    failed += 1;
    console.error(`NOT OK - ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'se-identity-'));
try {
  for (const name of ['SE', 'SE_2', 'se_tools', '10-11']) {
    fs.mkdirSync(path.join(root, name));
  }
  fs.mkdirSync(path.join(root, 'bad name'));

  const ids = listStorageIds(root).sort();
  check('listStorageIds 保留磁盘真实大小写并过滤非法名', ids.join('|') === '10-11|SE|SE_2|se_tools', ids.join('|'));

  check('resolve 精确命中', resolveStorageId('SE', root).kind === 'exact');
  const alias = resolveStorageId('se', root);
  check('resolve 唯一 casefold 命中 → alias + 真实名', alias.kind === 'alias' && alias.dirName === 'SE', JSON.stringify(alias));
  check('resolve 不存在 → absent', resolveStorageId('brand-new', root).kind === 'absent');
  check('resolve 非法 → invalid', resolveStorageId('../x', root).kind === 'invalid');

  const claimed = claimStorageDir('fresh', root);
  check('claim 新目录成功', claimed.ok === true && fs.existsSync(path.join(root, 'fresh')));
  const collided = claimStorageDir('fresh', root);
  check('claim 已存在 → EEXIST（不递归/不复用）', collided.ok === false && collided.code === 'EEXIST');
  check('removeEmptyClaim 只回收空占位', removeEmptyClaim('fresh', root) === true && !fs.existsSync(path.join(root, 'fresh')));
  fs.mkdirSync(path.join(root, 'not-empty'));
  fs.writeFileSync(path.join(root, 'not-empty', 'x'), '1');
  check('removeEmptyClaim 不删有内容目录', removeEmptyClaim('not-empty', root) === false && fs.existsSync(path.join(root, 'not-empty')));

  const alloc = allocateAndClaim('se_发布材料', ['opencode'], root);
  check(
    'create 分配跳过 SE/SE_2/se_tools → se_3',
    alloc.ok === true && alloc.systemId === 'se_3',
    JSON.stringify(alloc)
  );
  const alloc2 = allocateAndClaim('', [], root);
  check('空 base → se_<8hex>', alloc2.ok === true && /^se_[0-9a-f]{8}$/.test(alloc2.systemId), JSON.stringify(alloc2));

  check('foldSystemId 大小写折叠', foldSystemId('SE') === 'se' && foldSystemId('se_tools') === 'se_tools');
  check('sameSystemId 大小写不敏感', sameSystemId('SE', 'se') === true && sameSystemId('SE', 'SE_2') === false);

  const busyRoot = process.platform === 'win32' ? 'C:\\x\\se-systems\\se' : '/x/se-systems/se';
  const busyLock = process.platform === 'win32' ? 'C:\\x\\se-systems\\se\\.snakeeats.lock' : '/x/se-systems/se/.snakeeats.lock';
  const busy = parseStorageRootBusy(
    `Traceback (most recent call last):\nRuntimeError: storage root already owned by pid 23684: ${busyRoot} (lock=${busyLock})\n`
  );
  check(
    '解析锁冲突文案（pid/root/lock）',
    busy && busy.holderPid === 23684 && busy.root === busyRoot && busy.lock === busyLock,
    JSON.stringify(busy)
  );
  const busyUnknown = parseStorageRootBusy('RuntimeError: storage root already owned by pid unknown: /tmp/x (lock=/tmp/x/.snakeeats.lock)');
  check('解析锁冲突文案（pid unknown）', busyUnknown && busyUnknown.holderPid === null);
  check('非锁冲突文案不误判', parseStorageRootBusy('SE 进程退出 code=2：other') === null);

  if (process.platform === 'linux') {
    fs.mkdirSync(path.join(root, 'caseA'));
    fs.mkdirSync(path.join(root, 'casea'));
    const ambiguous = resolveStorageId('caseA', root);
    check('Linux 精确优先（两个大小写目录并存）', ambiguous.kind === 'exact' && ambiguous.dirName === 'caseA');
    const ambiguous2 = resolveStorageId('caseaa', root);
    check('Linux 无精确且多 casefold 命中 → ambiguous', ambiguous2.kind === 'ambiguous' && ambiguous2.dirNames.length === 2, JSON.stringify(ambiguous2));
  }
} finally {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch (err) {
    /* 临时目录清理失败不影响断言 */
  }
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nidentity unit: all checks passed');
