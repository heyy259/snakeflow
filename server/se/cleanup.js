import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { validateSystemId } from '../../shared/nameContract.js';
import { isPidAlive } from '../platform/process.js';
import { removeRecursiveWithRetry, removeFileBestEffort } from '../resilientFs.js';

function probeTcp(port, timeout = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function readJson(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

function collectRefs(workspaceFile) {
  if (!fs.existsSync(workspaceFile)) return { refs: new Set(), broken: false };
  try {
    const ws = JSON.parse(fs.readFileSync(workspaceFile, 'utf-8'));
    const refs = new Set();
    for (const tab of Array.isArray(ws && ws.tabs) ? ws.tabs : []) {
      const system = tab && tab.system;
      if (!system) continue;
      if (system.system_id) refs.add(String(system.system_id).trim());
      if (system.storage_dir) {
        const seg = String(system.storage_dir).replace(/\\/g, '/').split('/').filter(Boolean).pop();
        if (seg) refs.add(seg);
      }
    }
    return { refs, broken: false };
  } catch {
    return { refs: new Set(), broken: true };
  }
}

function readRegistryPort(storageDir, id) {
  const parsed = readJson(path.join(storageDir, id, 'registry', '.registry.json'));
  const entry = parsed && typeof parsed === 'object' ? parsed[id] : null;
  const port = entry ? Number(entry.port) : NaN;
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

function lastActiveMs(runtimeDir, storageDir, id) {
  const candidates = [];
  const owner = readJson(path.join(runtimeDir, id, '.owner.json'));
  if (owner && owner.at != null) {
    const at = Number(owner.at) || Date.parse(String(owner.at));
    if (Number.isFinite(at)) candidates.push(at);
  }
  for (const file of [
    path.join(runtimeDir, id, '.spawn.lock'),
    path.join(storageDir, id, 'registry', '.registry.json'),
  ]) {
    try {
      candidates.push(fs.statSync(file).mtimeMs);
    } catch {
      // missing marker
    }
  }
  return candidates.length ? Math.max(...candidates) : null;
}

/**
 * Clean only SnakeFlow-owned runtime metadata. SnakeEats storage is never deleted.
 * Legacy layout (runtimeDir === storageDir): remove stale .spawn.lock/.owner.json only.
 * Installed layout (runtimeDir !== storageDir): remove stale runtime directories.
 */
export async function sweepSeRuntime({
  runtimeDir,
  storageDir = runtimeDir,
  workspaceFile,
  maxAgeDays = 30,
  dryRun = true,
  log = () => {},
  probeTimeoutMs = 800,
} = {}) {
  const result = { aborted: false, deleted: [], cleaned: [], skipped: [] };
  if (!runtimeDir) return result;
  const legacy = path.resolve(runtimeDir) === path.resolve(storageDir);
  const skip = (id, reason) => {
    result.skipped.push({ id, reason });
    log(`SKIP ${id}: ${reason}`);
  };

  let entries;
  try {
    entries = fs.readdirSync(runtimeDir, { withFileTypes: true });
  } catch {
    return result;
  }

  const { refs, broken } = collectRefs(workspaceFile || path.join(runtimeDir, '.workspace.json'));
  if (broken) {
    result.aborted = true;
    log('ABORT: workspace 解析失败，跳过全部清理');
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = validateSystemId(entry.name);
    if (!id) continue;
    if (refs.has(id)) {
      skip(id, 'referenced by workspace');
      continue;
    }

    const runtimePath = path.join(runtimeDir, id);
    const lockPath = path.join(runtimePath, '.spawn.lock');
    const owner = readJson(path.join(runtimePath, '.owner.json'));
    const lock = readJson(lockPath);
    const ownerPid = owner && Number(owner.pid);
    const lockPid = lock && Number(lock.pid);
    if ((ownerPid && isPidAlive(ownerPid)) || (lockPid && isPidAlive(lockPid))) {
      skip(id, 'owner/spawn pid alive');
      continue;
    }
    const port = readRegistryPort(storageDir, id);
    if (port && (await probeTcp(port, probeTimeoutMs))) {
      skip(id, `port ${port} reachable`);
      continue;
    }

    const lastActive = lastActiveMs(runtimeDir, storageDir, id);
    if (lastActive == null) {
      skip(id, 'no activity marker');
      continue;
    }
    const ageDays = (Date.now() - lastActive) / 86400000;
    if (ageDays <= maxAgeDays) {
      skip(id, `last active ${new Date(lastActive).toISOString()}`);
      continue;
    }

    if (legacy) {
      const files = [lockPath, path.join(runtimePath, '.owner.json')].filter((file) => fs.existsSync(file));
      if (!files.length) {
        skip(id, 'stale but no runtime metadata; storage preserved');
        continue;
      }
      if (!dryRun) {
        for (const file of files) removeFileBestEffort(file);
      }
      result.cleaned.push(id);
      log(`CLEAN ${id}: stale runtime metadata removed; storage preserved`);
      continue;
    }

    if (!dryRun) {
      removeRecursiveWithRetry(runtimePath, { recursive: true, bestEffort: true, cmdFallback: true });
    }
    result.deleted.push(id);
    log(`DELETE ${id}: stale runtime directory removed; storage preserved`);
  }
  return result;
}
