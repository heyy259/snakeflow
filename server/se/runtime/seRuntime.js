import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { probeSeRuntime } from './seProbe.js';

export const SE_CONFIG_ENV = 'SE_CONFIG';
export const SE_ENV_PYTHON = 'SE_PYTHON';
export const SE_ENV_PACKAGE_PATH = 'SE_PACKAGE_PATH';
export const SE_ENV_MODE = 'SE_MODE';

const CONFIG_V1_KEYS = new Set(['python', 'snakeeatsPath']);
const CONFIG_V2_KEYS = new Set([
  'schemaVersion',
  'mode',
  'python',
  'packagePath',
  'versionRange',
  'server',
  'dataRoot',
  'portable',
]);
const DEFAULT_VERSION_RANGE = '>=0.1.0 <0.2.0';
const MAX_AUTO_PROBE_ATTEMPTS = 8;

function cleanValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function isExistingFile(candidate) {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

function execLines(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }, (err, stdout) => {
      if (err) {
        resolve([]);
        return;
      }
      resolve(String(stdout)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean));
    });
  });
}

function dedupePaths(candidates, platform) {
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function platformDefaultConfigPath({ env, platform, appName }) {
  const home = os.homedir();
  if (platform === 'win32') {
    const appData = cleanValue(env.APPDATA);
    const base = appData || path.join(home, 'AppData', 'Roaming');
    return path.join(base, appName, 'se.config.json');
  }
  const xdg = cleanValue(env.XDG_CONFIG_HOME);
  const base = xdg || path.join(home, '.config');
  return path.join(base, appName, 'se.config.json');
}

export function resolveSeConfigPath({ env = process.env, platform = process.platform, configPath, configFile } = {}) {
  const explicit = cleanValue(configPath);
  if (explicit) return explicit;
  const fromEnv = cleanValue(env[SE_CONFIG_ENV]);
  if (fromEnv) return fromEnv;
  const fromApp = cleanValue(configFile);
  if (fromApp) return fromApp;
  return platformDefaultConfigPath({ env, platform, appName: 'SnakeFlow' });
}

function validateConfig(parsed, filePath) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: `配置文件顶层必须是对象：${filePath}` };
  }
  const isV2 = Object.prototype.hasOwnProperty.call(parsed, 'schemaVersion');
  const allowed = isV2 ? CONFIG_V2_KEYS : CONFIG_V1_KEYS;
  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key)) {
      return {
        ok: false,
        reason: `配置文件含未知键 "${key}"（允许：${[...allowed].join('、')}）：${filePath}`,
      };
    }
  }
  if (isV2) {
    if (parsed.schemaVersion !== 2) return { ok: false, reason: `不支持的配置 schemaVersion：${parsed.schemaVersion}` };
    if (parsed.mode !== undefined && !['auto', 'pip', 'dir'].includes(parsed.mode)) {
      return { ok: false, reason: `配置键 "mode" 必须是 auto/pip/dir：${filePath}` };
    }
    for (const key of ['python', 'packagePath', 'versionRange', 'dataRoot']) {
      if (parsed[key] !== undefined && typeof parsed[key] !== 'string') {
        return { ok: false, reason: `配置键 "${key}" 必须是字符串：${filePath}` };
      }
    }
    if (parsed.portable !== undefined && typeof parsed.portable !== 'boolean') {
      return { ok: false, reason: `配置键 "portable" 必须是布尔值：${filePath}` };
    }
    if (parsed.server !== undefined) {
      const server = parsed.server;
      if (!server || typeof server !== 'object' || Array.isArray(server)) {
        return { ok: false, reason: `配置键 "server" 必须是对象：${filePath}` };
      }
      if (server.port !== undefined && (!Number.isInteger(server.port) || server.port <= 0 || server.port >= 65536)) {
        return { ok: false, reason: `配置键 "server.port" 必须是有效端口：${filePath}` };
      }
      if (server.host !== undefined && typeof server.host !== 'string') {
        return { ok: false, reason: `配置键 "server.host" 必须是字符串：${filePath}` };
      }
    }
  } else {
    for (const key of Object.keys(parsed)) {
      if (typeof parsed[key] !== 'string') {
        return { ok: false, reason: `配置键 "${key}" 必须是字符串：${filePath}` };
      }
    }
    if ('snakeeatsPath' in parsed && !cleanValue(parsed.snakeeatsPath)) {
      return { ok: false, reason: `配置键 "snakeeatsPath" 不能为空：${filePath}` };
    }
  }
  return { ok: true, schemaVersion: isV2 ? 2 : 1 };
}

export async function loadSeConfig({ env = process.env, platform = process.platform, configPath, configFile } = {}) {
  let filePath = resolveSeConfigPath({ env, platform, configPath, configFile });
  let exists = false;
  try {
    exists = await isExistingFile(filePath);
  } catch {
    exists = false;
  }
  if (!exists && !cleanValue(configPath) && !cleanValue(env[SE_CONFIG_ENV]) && !cleanValue(configFile)) {
    const legacy = platformDefaultConfigPath({ env, platform, appName: 'reactflow' });
    if (await isExistingFile(legacy)) {
      filePath = legacy;
      exists = true;
    }
  }
  if (!exists) return { ok: true, path: filePath, exists: false, config: {}, schemaVersion: 2 };
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    if (!text.trim()) return { ok: false, path: filePath, exists: true, reason: `配置文件为空：${filePath}` };
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return { ok: false, path: filePath, exists: true, reason: `配置文件不是合法 JSON：${filePath}（${err.message}）` };
    }
    const validated = validateConfig(parsed, filePath);
    if (!validated.ok) return { ...validated, path: filePath, exists: true };
    return { ok: true, path: filePath, exists: true, config: parsed, schemaVersion: validated.schemaVersion };
  } catch (err) {
    return { ok: false, path: filePath, exists: true, reason: `读取配置文件失败：${filePath}（${err.message}）` };
  }
}

export async function normalizeSnakeeatsPackage(input, { projectRoot } = {}) {
  try {
    const value = cleanValue(input);
    if (!value) return { ok: false, reason: 'snakeeats 路径为空' };
    const target = path.isAbsolute(value)
      ? path.resolve(value)
      : path.resolve(cleanValue(projectRoot), value);
    if (await isExistingFile(path.join(target, 'snakeeats', '__init__.py'))) {
      return { ok: true, packageParent: target };
    }
    if (path.basename(target) === 'snakeeats' && await isExistingFile(path.join(target, '__init__.py'))) {
      return { ok: true, packageParent: path.dirname(target) };
    }
    return { ok: false, reason: `目录不含 snakeeats/__init__.py，也不是 snakeeats 包目录：${target}` };
  } catch (err) {
    return { ok: false, reason: `解析 snakeeats 路径失败：${err && err.message ? err.message : String(err)}` };
  }
}

export async function buildPythonCandidates({ projectRoot, env = process.env, platform = process.platform } = {}) {
  const candidates = [];
  const root = cleanValue(projectRoot);
  if (root) {
    candidates.push(platform === 'win32'
      ? path.join(root, '.venv', 'Scripts', 'python.exe')
      : path.join(root, '.venv', 'bin', 'python'));
  }
  if (platform === 'win32') {
    candidates.push(...await execLines('py', ['-3', '-c', 'import sys;print(sys.executable)']));
    for (const command of ['python', 'python3']) {
      for (const line of await execLines('where', [command])) {
        if (!/WindowsApps/i.test(line)) candidates.push(line);
      }
    }
  } else {
    for (const command of ['python3', 'python']) {
      candidates.push(...await execLines('which', [command]));
    }
  }
  const existing = [];
  for (const candidate of candidates) {
    if (await isExistingFile(candidate)) existing.push(candidate);
  }
  return dedupePaths(existing, platform);
}

export async function buildPackageCandidates({ projectRoot, platform = process.platform } = {}) {
  const root = cleanValue(projectRoot);
  if (!root) return [];
  const candidates = [path.resolve(root, '..', 'snakeeats')];
  const verified = [];
  for (const candidate of candidates) {
    const normalized = await normalizeSnakeeatsPackage(candidate, { projectRoot: root });
    if (normalized.ok) verified.push(normalized.packageParent);
  }
  return dedupePaths(verified, platform);
}

function pipVersionSpec(range) {
  return cleanValue(range).replace(/\s+/g, ',');
}

function parseVersion(version) {
  const match = String(version || '').trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] || 0)];
}

function compareVersion(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function versionSatisfies(version, range) {
  const parsed = parseVersion(version);
  if (!parsed) return true;
  const text = cleanValue(range);
  if (!text) return true;
  for (const token of text.split(/\s+/).filter(Boolean)) {
    const match = token.match(/^(>=|<=|>|<|=|\^|~)?\s*(\d+\.\d+(?:\.\d+)?)$/);
    if (!match) continue;
    const op = match[1] || '=';
    const target = parseVersion(match[2]);
    if (!target) continue;
    const cmp = compareVersion(parsed, target);
    if (op === '>=' && cmp < 0) return false;
    if (op === '>' && cmp <= 0) return false;
    if (op === '<=' && cmp > 0) return false;
    if (op === '<' && cmp >= 0) return false;
    if (op === '=' && cmp !== 0) return false;
    if (op === '^' || op === '~') {
      if (cmp < 0) return false;
      const upper = op === '^'
        ? target[0] === 0
          ? [0, target[1] + 1, 0]
          : [target[0] + 1, 0, 0]
        : [target[0], target[1] + 1, 0];
      if (compareVersion(parsed, upper) >= 0) return false;
    }
  }
  return true;
}

async function safeProbe(probe, descriptor) {
  try {
    const result = await probe(descriptor);
    if (!result || typeof result !== 'object') return { ok: false, reason: '探测未返回结果' };
    return result;
  } catch (err) {
    return { ok: false, reason: `探测异常：${err && err.message ? err.message : String(err)}` };
  }
}

export async function resolveSeRuntime({
  env = process.env,
  projectRoot,
  dataRoot,
  platform = process.platform,
  configPath,
  configFile,
  probe = probeSeRuntime,
} = {}) {
  const sources = { python: 'auto', packageParent: 'auto', mode: 'auto' };
  try {
    const loaded = await loadSeConfig({ env, platform, configPath, configFile });
    if (!loaded.ok) return { ok: false, reason: loaded.reason, sources };
    const config = loaded.config || {};
    const versionRange = cleanValue(config.versionRange) || DEFAULT_VERSION_RANGE;

    const envMode = cleanValue(env[SE_ENV_MODE]).toLowerCase();
    const mode = envMode || cleanValue(config.mode) || 'auto';
    if (!['auto', 'pip', 'dir'].includes(mode)) {
      return { ok: false, reason: `无效 SE 模式：${mode}（允许 auto/pip/dir）`, sources };
    }
    if (envMode) sources.mode = 'env';
    else if (cleanValue(config.mode)) sources.mode = 'config';

    const envPython = cleanValue(env[SE_ENV_PYTHON]);
    const envPackage = cleanValue(env[SE_ENV_PACKAGE_PATH]);
    const configPython = typeof config.python === 'string' ? config.python : '';
    const configPackage = cleanValue(config.packagePath) || cleanValue(config.snakeeatsPath);

    let pythonValue = '';
    if (envPython) {
      pythonValue = envPython;
      sources.python = 'env';
    } else if (cleanValue(configPython) && cleanValue(configPython).toLowerCase() !== 'auto') {
      pythonValue = configPython;
      sources.python = 'config';
    }

    let packageValue = '';
    if (envPackage) {
      packageValue = envPackage;
      sources.packageParent = 'env';
    } else if (configPackage) {
      packageValue = configPackage;
      sources.packageParent = 'config';
    }

    let explicitPython = '';
    if (sources.python !== 'auto') {
      if (!await isExistingFile(pythonValue)) {
        const sourceName = sources.python === 'env' ? SE_ENV_PYTHON : 'config.python';
        return {
          ok: false,
          reason: `显式 ${sourceName} 无效：${pythonValue} 不存在或不是文件（来源 ${sources.python}；修复：改正该值，或将其置空/改为 "auto" 以启用自动探测）`,
          sources,
        };
      }
      explicitPython = pythonValue;
    }

    let explicitPackage = '';
    if (sources.packageParent !== 'auto') {
      const normalized = await normalizeSnakeeatsPackage(packageValue, { projectRoot });
      if (!normalized.ok) {
        const sourceName = sources.packageParent === 'env' ? SE_ENV_PACKAGE_PATH : 'config.packagePath';
        return {
          ok: false,
          reason: `显式 ${sourceName} 无效：${packageValue}（来源 ${sources.packageParent}；${normalized.reason}；修复：指向含 snakeeats/__init__.py 的父目录或 snakeeats 包目录，或置空以启用自动探测）`,
          sources,
        };
      }
      explicitPackage = normalized.packageParent;
    }

    if (mode === 'pip' && explicitPackage) {
      return { ok: false, reason: 'pip 模式不接受 packagePath；请改为 auto/dir，或清空 packagePath', sources };
    }

    let attempts = 0;
    let lastFailure = '';
    const success = (resolvedMode, python, packageParent, result) => {
      if (!versionSatisfies(result.version, versionRange)) {
        return {
          ok: false,
          reason: `SnakeEats 版本不兼容：当前 ${result.version || '(未知)'}，要求 ${versionRange}。请执行 python -m pip install "snakeeats${pipVersionSpec(versionRange)}" 或调整 versionRange`,
          sources,
        };
      }
      return {
        ok: true,
        mode: resolvedMode,
        python,
        packageParent: packageParent || null,
        sources,
        versionRange,
        probe: result,
      };
    };
    const attempt = async (resolvedMode, python, packageParent) => {
      attempts += 1;
      const descriptor = resolvedMode === 'pip'
        ? { python, mode: 'pip', appRoot: projectRoot, dataRoot }
        : { python, packageParent, mode: 'dir', appRoot: projectRoot, dataRoot };
      const result = await safeProbe(probe, descriptor);
      if (!result.ok && result.reason) lastFailure = result.reason;
      return result;
    };
    const capSuffix = () => (attempts >= MAX_AUTO_PROBE_ATTEMPTS ? `，达到 ${MAX_AUTO_PROBE_ATTEMPTS} 次探测上限` : '');

    const pythonCandidates = sources.python === 'auto'
      ? await buildPythonCandidates({ projectRoot, env, platform })
      : [];
    const packageCandidates = sources.packageParent === 'auto' && mode !== 'pip'
      ? await buildPackageCandidates({ projectRoot, platform })
      : [];
    const pythons = explicitPython ? [explicitPython] : pythonCandidates;

    if (mode === 'dir' && explicitPackage) {
      if (!pythons.length) {
        return { ok: false, reason: '未找到 Python 解释器（请安装 Python 3.10+ 或配置 python）', sources };
      }
      for (const python of pythons) {
        if (attempts >= MAX_AUTO_PROBE_ATTEMPTS) break;
        const result = await attempt('dir', python, explicitPackage);
        if (result.ok) return success('dir', python, explicitPackage, result);
      }
      return { ok: false, reason: `指定 SnakeEats 目录不可用：${lastFailure || '(未知原因)'}`, sources };
    }

    if (mode === 'pip') {
      if (!pythons.length) {
        return { ok: false, reason: '未找到 Python 解释器（请安装 Python 3.10+ 或配置 python）', sources };
      }
      for (const python of pythons) {
        if (attempts >= MAX_AUTO_PROBE_ATTEMPTS) break;
        const result = await attempt('pip', python, null);
        if (result.ok) return success('pip', python, null, result);
      }
      return { ok: false, reason: `未找到已安装的 SnakeEats（请执行 python -m pip install "snakeeats${pipVersionSpec(versionRange)}"）：${lastFailure || '(无)'}`, sources };
    }

    if (explicitPackage) {
      if (!pythons.length) {
        return { ok: false, reason: '未找到 Python 解释器（请安装 Python 3.10+ 或配置 python）', sources };
      }
      for (const python of pythons) {
        if (attempts >= MAX_AUTO_PROBE_ATTEMPTS) break;
        const result = await attempt('dir', python, explicitPackage);
        if (result.ok) return success('dir', python, explicitPackage, result);
      }
      return { ok: false, reason: `指定 SnakeEats 目录不可用：${lastFailure || '(未知原因)'}`, sources };
    }

    let pipFailure = '';
    if (pythons.length) {
      for (const python of pythons) {
        if (attempts >= MAX_AUTO_PROBE_ATTEMPTS) break;
        const result = await attempt('pip', python, null);
        if (result.ok) return success('pip', python, null, result);
        pipFailure = lastFailure;
      }
    }

    if (packageCandidates.length && pythons.length) {
      for (const packageParent of packageCandidates) {
        for (const python of pythons) {
          if (attempts >= MAX_AUTO_PROBE_ATTEMPTS) break;
          const result = await attempt('dir', python, packageParent);
          if (result.ok) return success('dir', python, packageParent, result);
        }
        if (attempts >= MAX_AUTO_PROBE_ATTEMPTS) break;
      }
    }

    return {
      ok: false,
      reason: `未找到可用 SnakeEats 运行时（已探测 ${attempts} 次${capSuffix()}）。请安装 Python 3.10+ 并执行 python -m pip install "snakeeats${pipVersionSpec(versionRange)}"，或配置 packagePath 指向 SnakeEats 源码目录。pip 失败：${pipFailure || '(未尝试)'}；dir 失败：${lastFailure || '(未尝试)'}`,
      sources,
    };
  } catch (err) {
    return {
      ok: false,
      reason: `SE 运行时解析异常：${err && err.message ? err.message : String(err)}`,
      sources,
    };
  }
}
