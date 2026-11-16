// 服务端路径常量与路径类守卫：AppPaths 为唯一根真源，本文件只提供兼容导出与纯函数。
import path from 'node:path';
import { sanitizeGraphName, GRAPH_CONFIG_EXT } from '../shared/paths.js';
import { listDrives } from './util.js';
import {
  createAppPaths,
  getAppPaths,
  readAppConfig,
  setAppPaths as setCurrentAppPaths,
  resolveAppRoot,
} from './appPaths.js';

export const projectRoot = resolveAppRoot();

export let dataRoot;
export let workspaceRoot;
export let configRoot;
export let graphsDir;
export let legacyFlowsDir;
export let historyFile;
export let workspaceFile;
export let frecencyFile;
export let seSystemsDir;
export let runtimeDir;
export let logsDir;
export let configFile;

function applyPaths(paths) {
  dataRoot = paths.dataRoot;
  workspaceRoot = paths.workspaceRoot;
  configRoot = paths.configRoot;
  graphsDir = paths.graphsDir;
  legacyFlowsDir = paths.legacyFlowsDir;
  historyFile = paths.historyFile;
  workspaceFile = paths.workspaceFile;
  frecencyFile = paths.frecencyFile;
  seSystemsDir = paths.seSystemsDir;
  runtimeDir = paths.runtimeDir;
  logsDir = paths.logsDir;
  configFile = paths.configFile;
}

applyPaths(getAppPaths());

export function setAppPaths(paths) {
  const current = setCurrentAppPaths(paths);
  applyPaths(current);
  return current;
}

export { createAppPaths, getAppPaths, readAppConfig };

export const STORE_WHITELIST = new Set(['snippets', 'ui', 'configs']);
export { EXEC_EXTS } from './platform/paths.js';
export const MAX_DEPTH = 8;
export const MAX_VISIT = 20000;

export function sanitizeName(name) {
  const cleaned = sanitizeGraphName(name);
  return cleaned || `flow-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
}

export function resolveUserPath(input) {
  const raw = String(input == null ? '' : input);
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(projectRoot, raw);
}

export function graphContentResolve(fp, baseDir) {
  const p = String(fp == null ? '' : fp).replace(/\\/g, '/').trim();
  if (!p) return '';
  if (/^[A-Za-z]:\//.test(p) || p.startsWith('//') || p.startsWith('/')) return p;
  const base = baseDir || graphsDir;
  if (base === graphsDir && p.startsWith('graphs/')) return path.resolve(projectRoot, p);
  return path.resolve(base, p);
}

export function isWithinDrives(input) {
  let resolved;
  try {
    resolved = resolveUserPath(input);
  } catch (err) {
    return false;
  }
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const target = fold(resolved);
  for (const drive of listDrives()) {
    const root = fold(path.resolve(drive.path));
    const rel = path.relative(root, target);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true;
  }
  return false;
}

export { GRAPH_CONFIG_EXT };
