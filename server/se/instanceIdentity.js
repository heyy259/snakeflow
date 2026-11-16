// 进程归属证据：E1=本 Vite spawn token + 认证端点；E2=带启动时间的己方 owner。
// 未验证结果绝不用于 kill/清账；端口/PID 单独都不是身份。
import {
  isPidAlive,
  getProcessStartTime,
  findListeningProcess,
  isNodeOrViteProcess,
} from '../util.js';
import { seRpcOnce } from './resolve.js';

function fail(status, reason, extra = {}) {
  return { ok: false, status, reason, ...extra };
}

function listenerIdentity(port, { listenerFn, startTimeFn }) {
  const listener = listenerFn(port);
  if (!listener || listener.status === 'unknown') {
    return fail('unknown', (listener && listener.reason) || 'listener-unknown');
  }
  if (listener.status === 'not-listening') {
    return fail('mismatch', 'listener-not-found');
  }
  const pid = Number(listener.pid);
  if (!Number.isInteger(pid) || pid <= 0) return fail('unknown', 'listener-invalid-pid');
  const startedAt = listener.startedAt || startTimeFn(pid);
  if (!startedAt) return fail('unknown', 'process-start-time-unavailable', { pid });
  return {
    ok: true,
    pid,
    startedAt,
    port,
    listener,
  };
}

/**
 * E1：spawn token 认证 + system.info 端口一致性 + shutdown 前抓取 listener。
 * 仅接受 spawn 时注入的每实例 token，不接受全局 env token 作为此证据。
 */
export async function verifySpawnedInstance({
  systemId,
  port,
  token,
  rpcOnce = seRpcOnce,
  rpcTimeoutMs = 3000,
  listenerFn = findListeningProcess,
  startTimeFn = getProcessStartTime,
}) {
  const expectedPort = Number(port);
  if (!Number.isInteger(expectedPort) || expectedPort <= 0 || !token) {
    return fail('unknown', 'spawn-token-or-port-unavailable');
  }
  let info;
  try {
    info = await rpcOnce(expectedPort, token, 'system.info', {}, rpcTimeoutMs);
  } catch (err) {
    return fail('unknown', 'endpoint-auth-failed', {
      detail: String((err && err.message) || err),
    });
  }
  if (!info || Number(info.port) !== expectedPort) {
    return fail('mismatch', 'endpoint-port-mismatch', { infoPort: info && info.port });
  }
  const actualSid = String((info && info.system_id) || '').trim();
  if (actualSid && actualSid !== 'main' && actualSid !== String(systemId)) {
    return fail('mismatch', 'endpoint-system-id-mismatch', { actualSid });
  }
  const listener = listenerIdentity(expectedPort, { listenerFn, startTimeFn });
  if (!listener.ok) return listener;
  return { ...listener, info };
}

/**
 * E2：新 owner 用 listenerPid + listenerStartedAt；旧 owner 仅在 listener PID 与 owner.pid
 * 一致且进程启动早于 owner 写入时迁移验证，其余一律 fail closed。
 */
export function verifyOwnedOrphan({
  owner,
  expectedPort,
  currentVitePid = process.pid,
  isAlive = isPidAlive,
  isViteProcess = isNodeOrViteProcess,
  listenerFn = findListeningProcess,
  startTimeFn = getProcessStartTime,
}) {
  if (!owner || typeof owner !== 'object') return fail('unknown', 'owner-missing');
  const ownerPort = Number(owner.port);
  const expected = Number(expectedPort);
  if (
    !Number.isInteger(ownerPort) ||
    ownerPort <= 0 ||
    (Number.isInteger(expected) && expected > 0 && ownerPort !== expected)
  ) {
    return fail('mismatch', 'owner-port-mismatch', { ownerPort, expectedPort: expected });
  }
  const ownerVitePid = Number(owner.vitePid);
  if (
    Number.isInteger(ownerVitePid) &&
    ownerVitePid > 0 &&
    ownerVitePid !== currentVitePid &&
    isAlive(ownerVitePid) &&
    isViteProcess(ownerVitePid)
  ) {
    return fail('owned-by-other-vite', 'owner-vite-alive', { vitePid: ownerVitePid });
  }

  const listenerPid = Number(owner.listenerPid);
  const listenerStartedAt = String(owner.listenerStartedAt || '').trim();
  if (Number.isInteger(listenerPid) && listenerPid > 0 && listenerStartedAt) {
    if (!isAlive(listenerPid)) return fail('mismatch', 'owner-listener-dead');
    const listener = listenerIdentity(ownerPort, { listenerFn, startTimeFn });
    if (!listener.ok) return listener;
    if (listener.pid !== listenerPid) {
      return fail('mismatch', 'owner-listener-pid-mismatch', {
        expectedPid: listenerPid,
        actualPid: listener.pid,
      });
    }
    if (listener.startedAt !== listenerStartedAt) {
      return fail('mismatch', 'owner-listener-start-time-mismatch');
    }
    return listener;
  }

  const legacyPid = Number(owner.pid);
  const atNumber = Number(owner.at);
  const ownerAt =
    Number.isFinite(atNumber) && atNumber > 0 ? atNumber : Date.parse(String(owner.at || ''));
  if (!Number.isInteger(legacyPid) || legacyPid <= 0 || !Number.isFinite(ownerAt)) {
    return fail('unknown', 'owner-identity-incomplete');
  }
  if (!isAlive(legacyPid)) return fail('mismatch', 'owner-listener-dead');
  const listener = listenerIdentity(ownerPort, { listenerFn, startTimeFn });
  if (!listener.ok) return listener;
  if (listener.pid !== legacyPid) {
    return fail('mismatch', 'legacy-owner-listener-pid-mismatch', {
      expectedPid: legacyPid,
      actualPid: listener.pid,
    });
  }
  const startedMs = Date.parse(String(listener.startedAt));
  if (!Number.isFinite(startedMs) || startedMs > ownerAt + 5000) {
    return fail('unknown', 'legacy-owner-start-after-write');
  }
  return { ...listener, legacyOwner: true };
}
