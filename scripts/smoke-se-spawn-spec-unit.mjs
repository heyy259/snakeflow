// SE spawn 规格 golden 单测：argv/cwd/env 合同（§8 必须锁定）。
// 纯 Node，不启动 Python。
import path from 'node:path';
import {
  SE_INSTANCE_LOCK_TIMEOUT_S,
  buildSeEnv,
  buildSeSpawnSpec,
} from '../server/se/runtime/seSpawnSpec.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`PASS: ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

const isWin = process.platform === 'win32';
const storageDir = isWin ? 'C:\\data\\se-systems\\SE' : '/data/se-systems/SE';
const descriptor = {
  python: isWin ? 'C:\\Python313\\python.exe' : '/usr/bin/python3',
  packageParent: isWin ? 'C:\\工作\\改造中的副本' : '/工作/改造中的副本',
};
const baseEnv = { PATH: 'x', PYTHONPATH: isWin ? 'C:\\base\\py' : '/base/py', KEEP: '1' };

const spec = buildSeSpawnSpec(descriptor, { storageDir, baseEnv });
check('argv 精确', JSON.stringify(spec.args) === JSON.stringify(['-u', '-m', 'snakeeats', 'serve', '--port', '0', '--storage', storageDir]), JSON.stringify(spec.args));
check('command = descriptor.python', spec.command === descriptor.python, spec.command);
check('cwd = packageParent', spec.cwd === descriptor.packageParent, spec.cwd);
check('stdio 固定', JSON.stringify(spec.stdio) === JSON.stringify(['ignore', 'pipe', 'pipe']), JSON.stringify(spec.stdio));
check('windowsHide = true', spec.windowsHide === true, String(spec.windowsHide));
check('argv 不含危险参数', !spec.args.some((arg) => /^--(token|system-id|manifest)$/.test(arg)), JSON.stringify(spec.args));

check(
  'PYTHONPATH = packageParent + delimiter + 继承值',
  spec.env.PYTHONPATH === [descriptor.packageParent, baseEnv.PYTHONPATH].join(path.delimiter),
  spec.env.PYTHONPATH
);
check('继承 env 保留', spec.env.PATH === baseEnv.PATH && spec.env.KEEP === '1');
check('PYTHONIOENCODING = utf-8', spec.env.PYTHONIOENCODING === 'utf-8', spec.env.PYTHONIOENCODING);
check(
  '实例锁预算 = 1s',
  spec.env.SNAKEEATS_INSTANCE_LOCK_TIMEOUT === SE_INSTANCE_LOCK_TIMEOUT_S && SE_INSTANCE_LOCK_TIMEOUT_S === '1',
  spec.env.SNAKEEATS_INSTANCE_LOCK_TIMEOUT
);
check('未传 token/systemId → 不注入', !('SNAKEEATS_ADMIN_TOKEN' in spec.env) && !('SNAKEEATS_SYSTEM_ID' in spec.env));

const emptyInherited = buildSeEnv(descriptor, { baseEnv: {} });
check(
  '继承 PYTHONPATH 为空 → 无尾部分隔符',
  emptyInherited.PYTHONPATH === descriptor.packageParent && !emptyInherited.PYTHONPATH.endsWith(path.delimiter),
  emptyInherited.PYTHONPATH
);

const token = 'tok-秘密-123';
const withSecrets = buildSeSpawnSpec(descriptor, { storageDir, baseEnv, systemId: 'SE_2', token });
check('systemId/token 有值 → 只进 env', withSecrets.env.SNAKEEATS_SYSTEM_ID === 'SE_2' && withSecrets.env.SNAKEEATS_ADMIN_TOKEN === token);
check('token 绝不进 argv', !JSON.stringify(withSecrets.args).includes(token), JSON.stringify(withSecrets.args));
check('token 不进 cwd/command', withSecrets.command !== token && withSecrets.cwd !== token);

const emptySecrets = buildSeEnv(descriptor, { baseEnv, systemId: '', token: '' });
check('空 systemId/token → 不注入', !('SNAKEEATS_SYSTEM_ID' in emptySecrets) && !('SNAKEEATS_ADMIN_TOKEN' in emptySecrets));

let relativeThrew = false;
try {
  buildSeSpawnSpec(descriptor, { storageDir: path.join('relative', 'storage'), baseEnv });
} catch (err) {
  relativeThrew = err instanceof TypeError;
}
check('相对 storageDir → TypeError', relativeThrew);

const absoluteSpec = buildSeSpawnSpec(descriptor, { storageDir, baseEnv });
check('绝对 storageDir → 正常构造', absoluteSpec.args[absoluteSpec.args.length - 1] === storageDir);

const cjkDescriptor = {
  python: isWin ? 'C:\\Python313\\python.exe' : '/usr/bin/python3',
  packageParent: isWin ? 'C:\\工作\\改造中的副本' : '/工作/改造中的副本',
};
const cjkSpec = buildSeSpawnSpec(cjkDescriptor, { storageDir, baseEnv: {} });
check('CJK 路径逐字保留', cjkSpec.cwd === cjkDescriptor.packageParent && cjkSpec.env.PYTHONPATH === cjkDescriptor.packageParent, JSON.stringify(cjkSpec));

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nspawn spec unit: all checks passed');
