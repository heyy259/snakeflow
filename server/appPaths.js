import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export function resolveAppRoot() {
  const candidates = [
    import.meta.dirname || '',
    moduleDir,
    path.resolve(moduleDir, '..'),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'package.json'))) || process.cwd();
}

export function defaultDataRoot() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return path.join(base, 'SnakeFlow');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'SnakeFlow');
  }
  const base = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(base, 'SnakeFlow');
}

export function createAppPaths(options = {}) {
  const appRoot = options.appRoot || resolveAppRoot();
  const mode = options.mode || process.env.RF_MODE || 'legacy';
  const installed = mode === 'installed';
  const dataRoot = options.dataRoot || (installed ? defaultDataRoot() : appRoot);
  const workspaceRoot = options.workspaceRoot || (installed ? path.join(dataRoot, 'workspace') : path.join(appRoot, 'graphs'));
  const configRoot = options.configRoot || path.join(dataRoot, 'config');
  const seSystemsDir = options.seSystemsDir || (installed ? path.join(dataRoot, 'se-storage') : path.join(appRoot, 'se-systems'));
  const runtimeDir = options.runtimeDir || (installed ? path.join(dataRoot, 'runtime') : seSystemsDir);
  return {
    mode: installed ? 'installed' : 'legacy',
    appRoot,
    dataRoot,
    workspaceRoot,
    configRoot,
    graphsDir: workspaceRoot,
    legacyFlowsDir: path.join(appRoot, 'flows'),
    historyFile: path.join(workspaceRoot, 'history.json'),
    workspaceFile: path.join(workspaceRoot, '.workspace.json'),
    frecencyFile: path.join(workspaceRoot, '.frecency.json'),
    seSystemsDir,
    runtimeDir,
    logsDir: path.join(dataRoot, 'logs'),
    configFile: path.join(configRoot, 'app.config.json'),
  };
}

let current = null;

export function getAppPaths() {
  if (!current) current = createAppPaths();
  return current;
}

export function setAppPaths(paths) {
  current = paths;
  return current;
}
