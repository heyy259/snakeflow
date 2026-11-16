// SE 优雅停机：认证 RPC 只表示受理；终态必须是同一 PID + 启动时间退出。
// 端口先于终态快照/journal/实例锁关闭，不能作为进程退出证明。
import { isPidAlive, getProcessStartTime } from '../util.js';
import { SE_CLOSE_TOKEN_UNAVAILABLE } from './state.js';

export const SE_GRACEFUL_TIMEOUT_MS = 12000;
export const SE_SHUTDOWN_ACK_TIMEOUT_MS = 3000;
const POLL_MS = 250;
const RPC_FAILURE_GRACE_MS = 2000;

export async function waitSameProcessExit({
  pid,
  startedAt,
  isAlive = isPidAlive,
  startTime = getProcessStartTime,
  timeoutMs = SE_GRACEFUL_TIMEOUT_MS,
  pollMs = POLL_MS,
}) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  const expected = String(startedAt || '').trim();
  while (Date.now() < deadline) {
    let alive = true;
    try {
      alive = !!isAlive(pid);
    } catch {
      alive = true;
    }
    if (!alive) return true;
    let current = null;
    try {
      current = startTime(pid);
    } catch {
      current = null;
    }
    if (!expected || current !== expected) return true;
    await new Promise((r) => setTimeout(r, Math.max(10, pollMs)));
  }
  try {
    if (!isAlive(pid)) return true;
    return startTime(pid) !== expected;
  } catch {
    return false;
  }
}

/**
 * 返回 exited=true 才是同一进程终态。
 * graceful=true 同时要求 shutdown 被受理；RPC 失败但进程随后退出时 exited=true、graceful=false。
 */
export async function tryGracefulSeShutdown({
  port,
  token,
  rpcOnce,
  pid,
  startedAt,
  isAlive = isPidAlive,
  startTime = getProcessStartTime,
  timeoutMs = SE_GRACEFUL_TIMEOUT_MS,
  rpcTimeoutMs = SE_SHUTDOWN_ACK_TIMEOUT_MS,
}) {
  const nPort = Number(port);
  const nPid = Number(pid);
  const expected = String(startedAt || '').trim();
  if (
    !Number.isInteger(nPort) ||
    nPort <= 0 ||
    !token ||
    !Number.isInteger(nPid) ||
    nPid <= 0 ||
    !expected
  ) {
    return {
      attempted: false,
      graceful: false,
      exited: false,
      reason: 'no-port-token-or-verified-process',
    };
  }

  let acked = false;
  let rpcFailure = '';
  let rpcAuthFailed = false;
  try {
    await rpcOnce(nPort, token, 'system.shutdown', {}, rpcTimeoutMs);
    acked = true;
  } catch (err) {
    rpcFailure = String((err && err.message) || err);
    rpcAuthFailed =
      Number(err && err.seCode) === SE_CLOSE_TOKEN_UNAVAILABLE || /auth/i.test(rpcFailure);
  }

  const fullWait = Math.max(0, Number(timeoutMs) || 0);
  const waitMs = acked
    ? fullWait
    : rpcAuthFailed
      ? Math.min(fullWait, RPC_FAILURE_GRACE_MS)
      : fullWait;
  const exited = await waitSameProcessExit({
    pid: nPid,
    startedAt: expected,
    isAlive,
    startTime,
    timeoutMs: waitMs,
  });
  if (exited) {
    return {
      attempted: true,
      graceful: acked,
      exited: true,
      acked,
      reason: acked ? undefined : `rpc-failed: ${rpcFailure || 'unknown'}`,
    };
  }
  return {
    attempted: true,
    graceful: false,
    exited: false,
    acked,
    reason: acked
      ? `timeout-process>${timeoutMs}ms`
      : `rpc-failed: ${rpcFailure || 'unknown'}`,
  };
}
