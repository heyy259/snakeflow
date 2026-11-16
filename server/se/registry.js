// SE storage 布局与 registry/owner/token 文件 IO（<项目根>/se-systems/<system_id>/）。
import fs from 'node:fs';
import path from 'node:path';
import { seSystemsDir, runtimeDir } from '../paths.js';
import { removeFileBestEffort } from '../resilientFs.js';
import { SE_OWNER_NAME, SE_TOKEN_NAME } from './state.js';

/** 某系统 storage 目录：<项目根>/se-systems/<system_id>/（前端统一指定 --storage）。 */
export function seStorageDirOf(systemId) {
  return path.join(seSystemsDir, systemId);
}

export function seRuntimeDirOf(systemId) {
  return path.join(runtimeDir, systemId);
}

export function seOwnerFileOf(systemId) {
  return path.join(seRuntimeDirOf(systemId), SE_OWNER_NAME);
}

export function seTokenFileOf(systemId) {
  return path.join(seRuntimeDirOf(systemId), SE_TOKEN_NAME);
}

/**
 * 成功 spawn 后记录归属（best-effort）。`pid` 是 Node 直接子进程，
 * `listenerPid/listenerStartedAt` 是实际监听者及其防 PID 复用启动时间；
 * `vitePid` 区分己方残留与另一活 Vite 持有的实例。
 */
export function writeSeOwner(systemId, {
  pid,
  port,
  listenerPid,
  listenerStartedAt,
  vitePid = process.pid,
  instanceId,
  startedAt,
  mode,
  version,
  protocolVersion,
}) {
  try {
    fs.mkdirSync(seRuntimeDirOf(systemId), { recursive: true });
    const record = { pid, vitePid, port, at: Date.now() };
    if (Number.isInteger(Number(listenerPid)) && Number(listenerPid) > 0) {
      record.listenerPid = Number(listenerPid);
    }
    if (listenerStartedAt) record.listenerStartedAt = String(listenerStartedAt);
    if (instanceId) record.instanceId = String(instanceId);
    if (startedAt != null) record.startedAt = startedAt;
    if (mode) record.mode = String(mode);
    if (version) record.version = String(version);
    if (protocolVersion != null) record.protocolVersion = Number(protocolVersion);
    fs.writeFileSync(seOwnerFileOf(systemId), JSON.stringify(record));
  } catch (err) {
    /* 归属记录失败：视为无主，绝不误杀 */
  }
}

export function readSeOwner(systemId) {
  try {
    const raw = JSON.parse(fs.readFileSync(seOwnerFileOf(systemId), 'utf-8'));
    if (raw && typeof raw === 'object') return raw;
  } catch (err) {
    /* 无 owner / 半写：视为无主 */
  }
  return null;
}

export function removeSeOwner(systemId) {
  removeFileBestEffort(seOwnerFileOf(systemId));
}

export function removeSeToken(systemId) {
  removeFileBestEffort(seTokenFileOf(systemId));
}

/** 读 <storage>/registry/.registry.json，取 system_id 对应端口；无则 null。 */
export function readSeRegistry(systemId) {
  const file = path.join(seSystemsDir, systemId, 'registry', '.registry.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const entry = parsed && typeof parsed === 'object' ? parsed[systemId] : null;
    const port = entry ? Number(entry.port) : NaN;
    if (Number.isInteger(port) && port > 0 && port < 65536) return { port };
  } catch (err) {
    /* 目录缺失 / 半写文件：视为未注册 */
  }
  return null;
}

/** 删除某系统的 registry 条目（best-effort；该文件按系统独立存放）。 */
export function removeSeRegistryEntry(systemId) {
  const file = path.join(seSystemsDir, systemId, 'registry', '.registry.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (parsed && typeof parsed === 'object') {
      delete parsed[systemId];
      fs.writeFileSync(file, JSON.stringify(parsed));
      return;
    }
  } catch (err) {
    /* 读失败：退回直接删除 */
  }
  removeFileBestEffort(file);
}
