import path from 'node:path';

export const SE_INSTANCE_LOCK_TIMEOUT_S = '1';

export function buildSeEnv(descriptor, { baseEnv = process.env, systemId, token } = {}) {
  const base = baseEnv || {};
  const env = {
    ...base,
    PYTHONIOENCODING: 'utf-8',
    SNAKEEATS_INSTANCE_LOCK_TIMEOUT: SE_INSTANCE_LOCK_TIMEOUT_S,
  };
  if (descriptor.mode === 'pip') {
    delete env.PYTHONPATH;
    delete env.PYTHONHOME;
  } else {
    env.PYTHONPATH = [descriptor.packageParent, base.PYTHONPATH].filter(Boolean).join(path.delimiter);
  }
  if (systemId) env.SNAKEEATS_SYSTEM_ID = systemId;
  if (token) env.SNAKEEATS_ADMIN_TOKEN = token;
  return env;
}

export function buildSeSpawnSpec(descriptor, { storageDir, systemId, token, baseEnv = process.env } = {}) {
  if (!path.isAbsolute(storageDir)) {
    throw new TypeError(`buildSeSpawnSpec: storageDir 必须是绝对路径：${storageDir}`);
  }
  const pip = descriptor.mode === 'pip';
  const cwd = pip
    ? descriptor.dataRoot || descriptor.appRoot || process.cwd()
    : descriptor.packageParent;
  return {
    command: descriptor.python,
    args: ['-u', '-m', 'snakeeats', 'serve', '--port', '0', '--storage', storageDir],
    cwd,
    env: buildSeEnv(descriptor, { baseEnv, systemId, token }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  };
}
