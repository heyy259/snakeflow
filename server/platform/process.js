import { execFileSync } from 'node:child_process';

export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return !!(err && err.code === 'EPERM');
  }
}

export function waitForProcessDead(pid, timeoutMs = 2000) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return true;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!isPidAlive(n)) return true;
    const until = Date.now() + 50;
    while (Date.now() < until) {
      // synchronous grace wait, matching the previous lifecycle contract
    }
  }
  return !isPidAlive(n);
}

export function killProcessTree(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(n), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (err) {
      // already exited or access denied: best effort
    }
    return;
  }
  // POSIX: the SE child is spawned detached, so it leads its own process group.
  try {
    process.kill(-n, 'SIGTERM');
  } catch (err) {
    // group may not exist for externally attached processes
  }
  try {
    process.kill(n, 'SIGTERM');
  } catch (err) {
    // best effort
  }
  if (waitForProcessDead(n, 1500)) return;
  try {
    process.kill(-n, 'SIGKILL');
  } catch (err) {
    // best effort
  }
  try {
    process.kill(n, 'SIGKILL');
  } catch (err) {
    // best effort
  }
}

export function seSpawnPlatformOptions() {
  return process.platform === 'win32'
    ? { detached: false, windowsHide: true }
    : { detached: true, windowsHide: true };
}
