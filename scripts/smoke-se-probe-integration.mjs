// SE 运行时探测集成测试：真实 Python + 临时 fake snakeeats 包（含 CJK 路径）。
// 无 Python 时打印 SKIP 并退出 0；有 Python 时必须真实通过。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isPathInside, probeSeRuntime } from '../server/se/runtime/seProbe.js';
import { normalizeSnakeeatsPackage } from '../server/se/runtime/seRuntime.js';
import { removeRecursiveWithRetry } from '../server/resilientFs.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`PASS: ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

function writeFile(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

function tryPython(command, args) {
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    if (result.error || result.status !== 0) return null;
    const line = String(result.stdout || '')
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
      .pop();
    return line || null;
  } catch (err) {
    return null;
  }
}

function findPython() {
  const probeArgs = ['-c', 'import sys;print(sys.executable)'];
  if (process.env.SE_PYTHON) {
    const hit = tryPython(process.env.SE_PYTHON, probeArgs);
    if (hit) return hit;
  }
  const pyHit = tryPython('py', ['-3', '-c', 'import sys;print(sys.executable)']);
  if (pyHit) return pyHit;
  for (const command of ['python', 'python3']) {
    const hit = tryPython(command, probeArgs);
    if (hit) return hit;
  }
  return null;
}

const python = findPython();
if (!python) {
  console.log('SKIP: no python');
  process.exit(0);
}
console.log(`using python: ${python}`);

const FETCH_MAIN = `import sys
if sys.argv[1:] == ['serve', '--help']:
    print('fake snakeeats serve help')
    sys.exit(0)
sys.exit(2)
`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'se-probe-蛇测试-'));
try {
  const fake = path.join(root, 'fake');
  const packageDir = path.join(fake, 'snakeeats');
  writeFile(path.join(packageDir, '__init__.py'), '');
  writeFile(path.join(packageDir, '__main__.py'), FETCH_MAIN);

  const okResult = await probeSeRuntime({ python, packageParent: fake });
  check('fake 包探测通过', okResult.ok === true, JSON.stringify(okResult));
  check('模块文件位于 packageParent 下', okResult.ok === true && isPathInside(fake, okResult.moduleFile || ''), JSON.stringify(okResult));
  check('解析出 Python 版本', okResult.ok === true && /^\d+\.\d+$/.test(okResult.pythonVersion || ''), okResult.pythonVersion);
  check('CJK 临时路径编码正确', String(okResult.moduleFile || '').includes('蛇测试-'), okResult.moduleFile);

  writeFile(path.join(packageDir, '__main__.py'), 'import sys\nsys.exit(3)\n');
  const brokenResult = await probeSeRuntime({ python, packageParent: fake });
  check(
    '入口不可用 → ok:false 且 reason 指向入口',
    brokenResult.ok === false && /入口不可用|serve --help/.test(brokenResult.reason || ''),
    JSON.stringify(brokenResult)
  );

  const noInitParent = path.join(root, 'nopkg');
  fs.mkdirSync(path.join(noInitParent, 'snakeeats'), { recursive: true });
  const noInitNormalized = await normalizeSnakeeatsPackage(noInitParent, { projectRoot: root });
  check('无 __init__.py → 规范化失败', noInitNormalized.ok === false, JSON.stringify(noInitNormalized));
  let noInitProbe = null;
  let noInitThrew = false;
  try {
    noInitProbe = await probeSeRuntime({ python, packageParent: noInitParent });
  } catch (err) {
    noInitThrew = true;
  }
  check('无 __init__.py → probe 失败但不抛异常', noInitThrew === false && noInitProbe && noInitProbe.ok === false, JSON.stringify(noInitProbe));
} finally {
  const cleaned = removeRecursiveWithRetry(root, { recursive: true, bestEffort: true, cmdFallback: true });
  check('CJK 临时目录清理删净', cleaned === true && !fs.existsSync(root), root);
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nprobe integration: all checks passed');
