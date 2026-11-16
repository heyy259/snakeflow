// SE 运行时配置单元测试：配置定位/校验、优先级、规范化、相对路径、自动候选。
// 纯 Node，不启动 Python；probe 全部注入假实现。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SE_CONFIG_ENV,
  SE_ENV_PACKAGE_PATH,
  buildPackageCandidates,
  loadSeConfig,
  normalizeSnakeeatsPackage,
  resolveSeConfigPath,
  resolveSeRuntime,
} from '../server/se/runtime/seRuntime.js';

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

function makePython(filePath) {
  writeFile(filePath, 'fake-python');
  return filePath;
}

function makePackage(packageParent) {
  writeFile(path.join(packageParent, 'snakeeats', '__init__.py'), '');
  return packageParent;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-se-runtime-'));
try {
  // ── 缺失配置 → 自动候选 ─────────────────────────────────────────────────
  const projectRoot = path.join(root, 'tools', 'reactflow');
  fs.mkdirSync(projectRoot, { recursive: true });
  const autoPackage = makePackage(path.join(root, 'tools', 'snakeeats'));
  const venvPython = makePython(
    process.platform === 'win32'
      ? path.join(projectRoot, '.venv', 'Scripts', 'python.exe')
      : path.join(projectRoot, '.venv', 'bin', 'python')
  );
  const missingConfig = path.join(root, 'missing.config.json');
  const autoCalls = [];
  const autoProbe = (descriptor) => {
    autoCalls.push(descriptor);
    return {
      ok: descriptor.packageParent === autoPackage,
      reason: 'fake probe',
      version: '0.1.0', pythonVersion: '3.13',
      moduleFile: path.join(autoPackage, 'snakeeats', '__init__.py'),
    };
  };
  const autoRt = await resolveSeRuntime({
    env: {},
    projectRoot,
    platform: process.platform,
    configPath: missingConfig,
    probe: autoProbe,
  });
  check('缺失配置 → 自动探测成功', autoRt.ok === true, JSON.stringify(autoRt));
  check(
    '缺失配置 → sources 全为 auto',
    autoRt.ok && autoRt.sources.python === 'auto' && autoRt.sources.packageParent === 'auto',
    JSON.stringify(autoRt.sources)
  );
  check('缺失配置 → venv 候选优先且 probe 被调用', autoCalls.length > 0 && autoCalls[0].python === venvPython, JSON.stringify(autoCalls[0]));

  const missingLoaded = await loadSeConfig({ env: {}, platform: process.platform, configPath: missingConfig });
  check(
    '缺失配置 → loadSeConfig ok + config 空对象',
    missingLoaded.ok === true && missingLoaded.exists === false && Object.keys(missingLoaded.config).length === 0,
    JSON.stringify(missingLoaded)
  );

  // ── 合法配置（显式 configPath / SE_CONFIG）──────────────────────────────
  const cfgPython = makePython(path.join(root, 'py-config', 'python.exe'));
  const cfgPackage = makePackage(path.join(root, 'cfg-pkg'));
  const cfgFile = path.join(root, 'se.config.json');
  writeFile(cfgFile, JSON.stringify({ python: cfgPython, snakeeatsPath: cfgPackage }));
  const cfgProbeCalls = [];
  const cfgProbe = (descriptor) => {
    cfgProbeCalls.push(descriptor);
    return { ok: true, reason: 'fake probe', version: '0.1.0', pythonVersion: '3.13', moduleFile: path.join(cfgPackage, 'snakeeats', '__init__.py') };
  };
  const cfgRt = await resolveSeRuntime({
    env: {},
    projectRoot,
    platform: process.platform,
    configPath: cfgFile,
    probe: cfgProbe,
  });
  check('显式 configPath → sources config/config', cfgRt.ok && cfgRt.sources.python === 'config' && cfgRt.sources.packageParent === 'config', JSON.stringify(cfgRt));
  check('显式 configPath → python/packageParent 来自配置', cfgRt.ok && cfgRt.python === cfgPython && cfgRt.packageParent === cfgPackage, JSON.stringify(cfgRt));
  check('显式 configPath → probe 只调用一次', cfgProbeCalls.length === 1, String(cfgProbeCalls.length));

  const envConfigRt = await resolveSeRuntime({
    env: { [SE_CONFIG_ENV]: cfgFile },
    projectRoot,
    platform: process.platform,
    probe: cfgProbe,
  });
  check(
    'SE_CONFIG 指定配置 → sources config/config',
    envConfigRt.ok && envConfigRt.sources.python === 'config' && envConfigRt.sources.packageParent === 'config',
    JSON.stringify(envConfigRt)
  );

  // ── env 覆盖 config；空 env = 未设置 ─────────────────────────────────────
  const envPython = makePython(path.join(root, 'py-env', 'python.exe'));
  const envPackage = makePackage(path.join(root, 'env-pkg'));
  const envProbe = () => ({ ok: true, reason: 'fake probe', version: '0.1.0', pythonVersion: '3.13' });
  const envRt = await resolveSeRuntime({
    env: { [SE_CONFIG_ENV]: cfgFile, SE_PYTHON: envPython, SE_PACKAGE_PATH: envPackage },
    projectRoot,
    platform: process.platform,
    probe: envProbe,
  });
  check(
    'env 覆盖 config → 值与 sources 均为 env',
    envRt.ok && envRt.python === envPython && envRt.packageParent === envPackage && envRt.sources.python === 'env' && envRt.sources.packageParent === 'env',
    JSON.stringify(envRt)
  );

  const emptyEnvRt = await resolveSeRuntime({
    env: { [SE_CONFIG_ENV]: cfgFile, SE_PYTHON: '', SE_PACKAGE_PATH: '' },
    projectRoot,
    platform: process.platform,
    probe: envProbe,
  });
  check(
    '空 env = 未设置 → 回落到 config',
    emptyEnvRt.ok && emptyEnvRt.python === cfgPython && emptyEnvRt.packageParent === cfgPackage && emptyEnvRt.sources.python === 'config',
    JSON.stringify(emptyEnvRt)
  );

  // ── 显式无效 → ok:false 且不回退 ────────────────────────────────────────
  const badPython = path.join(root, 'nope-python.exe');
  let fallbackProbeCalls = 0;
  const badEnvRt = await resolveSeRuntime({
    env: { [SE_CONFIG_ENV]: cfgFile, SE_PYTHON: badPython, SE_PACKAGE_PATH: envPackage },
    projectRoot,
    platform: process.platform,
    probe: () => {
      fallbackProbeCalls += 1;
      return { ok: true, reason: 'should not run' };
    },
  });
  check('无效显式 SE_PYTHON → ok:false', badEnvRt.ok === false, JSON.stringify(badEnvRt));
  check('无效显式 SE_PYTHON → 不调用 probe 回退', fallbackProbeCalls === 0, String(fallbackProbeCalls));
  check(
    '无效显式 SE_PYTHON → reason 含来源与值',
    badEnvRt.ok === false && badEnvRt.reason.includes('SE_PYTHON') && badEnvRt.reason.includes(badPython),
    badEnvRt.reason
  );

  const badPackage = path.join(root, 'not-a-package');
  fs.mkdirSync(badPackage, { recursive: true });
  const badPkgRt = await resolveSeRuntime({
    env: { [SE_ENV_PACKAGE_PATH]: badPackage, SE_PYTHON: cfgPython },
    projectRoot,
    platform: process.platform,
    probe: () => {
      fallbackProbeCalls += 1;
      return { ok: true, reason: 'should not run' };
    },
  });
  check('无效显式 SE_PACKAGE_PATH → ok:false 且不回退', badPkgRt.ok === false && fallbackProbeCalls === 0, JSON.stringify(badPkgRt));
  check(
    '无效显式 SE_PACKAGE_PATH → reason 含来源与值',
    badPkgRt.ok === false && badPkgRt.reason.includes('SE_PACKAGE_PATH') && badPkgRt.reason.includes(badPackage),
    badPkgRt.reason
  );

  // ── 配置错误 ────────────────────────────────────────────────────────────
  const invalidCases = [
    ['非法 JSON', '{oops', (reason) => reason.includes('JSON')],
    ['零字节配置', '', (reason) => reason.includes('为空')],
    ['顶层不是对象', '[]', (reason) => reason.includes('对象')],
    ['未知键', JSON.stringify({ python: '', nope: 'x' }), (reason) => reason.includes('未知键') && reason.includes('nope')],
    ['非字符串值', JSON.stringify({ snakeeatsPath: 123 }), (reason) => reason.includes('字符串')],
    ['空 snakeeatsPath', JSON.stringify({ snakeeatsPath: '' }), (reason) => reason.includes('snakeeatsPath') && reason.includes('不能为空')],
  ];
  for (const [name, content, predicate] of invalidCases) {
    const filePath = path.join(root, `invalid-${name}.json`);
    writeFile(filePath, content);
    let calls = 0;
    const result = await resolveSeRuntime({
      env: {},
      projectRoot,
      platform: process.platform,
      configPath: filePath,
      probe: () => {
        calls += 1;
        return { ok: true, reason: 'should not run' };
      },
    });
    check(`配置错误（${name}）→ ok:false 且不探测`, result.ok === false && calls === 0 && predicate(result.reason || ''), JSON.stringify(result));
  }

  // ── 包目录 / 父目录规范化 ───────────────────────────────────────────────
  const repo = path.join(root, 'repo');
  makePackage(repo);
  const normalizedParent = await normalizeSnakeeatsPackage(repo, { projectRoot: root });
  const normalizedDir = await normalizeSnakeeatsPackage(path.join(repo, 'snakeeats'), { projectRoot: root });
  check('父目录规范化 → 保持自身', normalizedParent.ok && normalizedParent.packageParent === path.resolve(repo), JSON.stringify(normalizedParent));
  check(
    '包目录规范化 → dirname',
    normalizedDir.ok && normalizedDir.packageParent === path.resolve(repo),
    JSON.stringify(normalizedDir)
  );
  check('非包目录 → ok:false', (await normalizeSnakeeatsPackage(badPackage, { projectRoot: root })).ok === false);

  // ── 相对 snakeeatsPath 按 projectRoot 解析，不受 chdir 影响 ──────────────
  const relProject = path.join(root, 'proj');
  fs.mkdirSync(relProject, { recursive: true });
  const relPackage = makePackage(path.join(root, 'rel-pkg'));
  const relPython = makePython(path.join(root, 'rel-py', 'python.exe'));
  const relConfigFile = path.join(root, 'rel.config.json');
  writeFile(
    relConfigFile,
    JSON.stringify({ python: relPython, snakeeatsPath: path.relative(relProject, relPackage) })
  );
  const relProbe = (descriptor) => ({ ok: descriptor.packageParent === relPackage, reason: 'fake probe', version: '0.1.0', pythonVersion: '3.13' });
  const relOptions = { env: {}, projectRoot: relProject, platform: process.platform, configPath: relConfigFile, probe: relProbe };
  const relBefore = await resolveSeRuntime(relOptions);
  const previousCwd = process.cwd();
  let relAfter = null;
  try {
    process.chdir(os.tmpdir());
    relAfter = await resolveSeRuntime(relOptions);
  } finally {
    process.chdir(previousCwd);
  }
  check('相对 snakeeatsPath 按 projectRoot 解析', relBefore.ok && relBefore.packageParent === relPackage, JSON.stringify(relBefore));
  check('process.chdir 后相对路径结果不变', relAfter && relAfter.ok && relAfter.packageParent === relPackage, JSON.stringify(relAfter));

  // ── 配置路径解析 ────────────────────────────────────────────────────────
  check(
    'SE_CONFIG 优先于平台默认',
    resolveSeConfigPath({ env: { [SE_CONFIG_ENV]: 'C:/cfg.json' }, platform: 'win32' }) === 'C:/cfg.json'
  );
  check(
    '显式 configPath 优先于 SE_CONFIG',
    resolveSeConfigPath({ env: { [SE_CONFIG_ENV]: 'C:/env.json' }, platform: 'win32', configPath: 'C:/arg.json' }) === 'C:/arg.json'
  );
  if (process.platform === 'win32') {
    const defaultPath = resolveSeConfigPath({ env: { APPDATA: 'C:\\Users\\X\\AppData\\Roaming' }, platform: 'win32' });
    check(
      'win32 默认配置位于 APPDATA',
      defaultPath === path.join('C:\\Users\\X\\AppData\\Roaming', 'SnakeFlow', 'se.config.json'),
      defaultPath
    );
    const emptyConfigEnvPath = resolveSeConfigPath({ env: { [SE_CONFIG_ENV]: '', APPDATA: 'C:\\A' }, platform: 'win32' });
    check(
      '空 SE_CONFIG = 未设置',
      emptyConfigEnvPath === path.join('C:\\A', 'SnakeFlow', 'se.config.json'),
      emptyConfigEnvPath
    );
  }
  const xdgPath = resolveSeConfigPath({ env: { XDG_CONFIG_HOME: '/x' }, platform: 'linux' });
  check('XDG_CONFIG_HOME 优先（POSIX）', xdgPath === path.join('/x', 'SnakeFlow', 'se.config.json'), xdgPath);

  // ── 固定候选列表：只含真实存在的包父目录，且去重 ────────────────────────
  const packageCandidates = await buildPackageCandidates({ projectRoot, env: {}, platform: process.platform });
  check('包候选包含当前相对布局', packageCandidates.includes(autoPackage), JSON.stringify(packageCandidates));
  check('包候选无重复', new Set(packageCandidates.map((p) => (process.platform === 'win32' ? p.toLowerCase() : p))).size === packageCandidates.length, JSON.stringify(packageCandidates));
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
console.log('\nruntime unit: all checks passed');
