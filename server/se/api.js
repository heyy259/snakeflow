// SE 接线插件（期 1/2/5）：/api/se/* HTTP 端点 + /api/se/ws 代理 upgrade。
// 全部入口走 Host/Origin 白名单（代理唯一安全闸门）。
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { sendJson, readBody, isPidAlive, isNodeOrViteProcess } from '../util.js';
import {
  SE_CLOSE_OFFLINE,
  seSpawnedSystems,
  seSpawnInflight,
  seUpstreams,
} from './state.js';
import {
  sanitizeSeSystemId,
  isAllowedSeRequest,
  resolveSeToken,
  probeTcp,
  resolveSeRuntimeForServer,
  seRpcOnce,
} from './resolve.js';
import { tryGracefulSeShutdown } from './gracefulEnd.js';
import {
  readSeRegistry,
  removeSeRegistryEntry,
  readSeOwner,
  removeSeOwner,
  removeSeToken,
} from './registry.js';
import { killSameProcess } from './process.js';
import { createSeSupervisor } from './supervisor.js';
import { verifySpawnedInstance, verifyOwnedOrphan } from './instanceIdentity.js';
import { allocateAndClaim, removeEmptyClaim, resolveStorageId } from './identity.js';
import { finalizeSeUpstream, attachSeBrowser } from './proxy.js';

/**
 * spawn/create 的统一错误出口：把 typed status 映射为 HTTP 409/503。
 * 前端按 status 走可执行文案，绝不把 Python traceback 原样透出。
 */
function sendSpawnError(res, systemId, err) {
  const status = err && err.status;
  const message = String((err && err.message) || err);
  if (status === 'identity-mismatch') {
    return sendJson(res, 409, {
      error: message,
      status,
      canonical: err.canonical || null,
      system_id: systemId,
    });
  }
  if (status === 'identity-conflict' || status === 'identity-invalid') {
    return sendJson(res, 409, {
      error: message,
      status,
      candidates: err.candidates || [],
      system_id: systemId,
    });
  }
  if (status === 'storage-root-busy') {
    return sendJson(res, 409, {
      error: message,
      status,
      holder_pid: err.holderPid ?? null,
      holder_alive: !!err.holderAlive,
      root: err.root || null,
      system_id: systemId,
    });
  }
  if (status === 'port-unverifiable') {
    return sendJson(res, 409, {
      error: message,
      status,
      code: 'process-identity-unknown',
      reason: err.reason || 'identity-unknown',
      retryable: true,
      port: err.port || null,
      system_id: systemId,
    });
  }
  if (status === 'owned-by-other-vite') {
    return sendJson(res, 409, {
      error: message,
      status,
      code: 'owned-by-other-vite',
      port: err.port || null,
      system_id: systemId,
    });
  }
  if (status === 'locked') {
    return sendJson(res, 409, { error: message, status, system_id: systemId });
  }
  if (err && err.code === 'ENAMESPACE') {
    return sendJson(res, 503, { error: message, status: 'storage-namespace-unavailable', system_id: systemId });
  }
  return sendJson(res, 500, { error: message, system_id: systemId });
}

function sendEndFailure(res, { code, phase = 'identity', reason, retryable = true }) {
  return sendJson(res, 200, {
    ok: false,
    error: 'port-unverifiable',
    code,
    phase,
    reason: reason || code,
    retryable,
  });
}

function clearEndedState(systemId, canonicalId) {
  removeSeRegistryEntry(canonicalId);
  removeSeOwner(canonicalId);
  removeSeToken(canonicalId);
  seSpawnedSystems.delete(systemId);
  seSpawnedSystems.delete(canonicalId);
  const up = seUpstreams.get(systemId);
  if (up) finalizeSeUpstream(up, SE_CLOSE_OFFLINE, 'se ended');
}

async function terminateVerifiedInstance({ systemId, canonicalId, identity, token, source }) {
  let graceful = { attempted: false, exited: false, graceful: false, reason: 'no-token' };
  if (token) {
    graceful = await tryGracefulSeShutdown({
      port: identity.port,
      token,
      rpcOnce: seRpcOnce,
      pid: identity.pid,
      startedAt: identity.startedAt,
    });
  }
  if (graceful.exited) {
    clearEndedState(systemId, canonicalId);
    return { ok: true, killed: true, graceful: !!graceful.graceful };
  }
  console.error(
    `[se][ungraceful-shutdown] system=${systemId} pid=${identity.pid} source=${source} reason=${
      graceful.reason || 'timeout'
    }`
  );
  const killed = killSameProcess(canonicalId, identity.pid, identity.startedAt);
  if (!killed) {
    return {
      ok: false,
      error: 'kill-unconfirmed',
      code: 'process-exit-unconfirmed',
      phase: 'terminate',
      reason: 'same-process-kill-unconfirmed',
      retryable: true,
    };
  }
  clearEndedState(systemId, canonicalId);
  return { ok: true, killed: true, graceful: false };
}

/**
 * SE 接线插件（期 1）：
 * - GET /api/se/endpoint      状态（never token）；
 * - GET /api/se/systems       枚举已知系统 + 存活探测；
 * - WS  /api/se/ws            代理（代发 auth、id 重映射、notification 广播）。
 * 全部入口走 Host/Origin 白名单（代理唯一安全闸门）。
 */
export function createSeApiMiddleware(options = {}) {
  const supervisor = options.supervisor || createSeSupervisor(options);
  const isAllowed = (options.security && options.security.isAllowedHttp) || isAllowedSeRequest;
  return async (req, res, next) => {
        let url;
        try {
          url = new URL(req.url, 'http://localhost');
        } catch (err) {
          return next();
        }
        if (url.pathname !== '/api/se' && !url.pathname.startsWith('/api/se/')) return next();
        if (!isAllowed(req)) return sendJson(res, 403, { error: 'forbidden' });

        try {
          if (req.method === 'GET' && url.pathname === '/api/se/endpoint') {
            const systemId = sanitizeSeSystemId(url.searchParams.get('system_id'));
            if (!systemId) return sendJson(res, 400, { error: 'invalid system_id' });
            const reg = readSeRegistry(systemId);
            if (!reg) {
              return sendJson(res, 200, {
                system_id: systemId,
                alive: false,
                port: null,
                status: 'offline',
              });
            }
            const alive = await probeTcp(reg.port);
            const token = resolveSeToken(systemId);
            // D：状态收敛为 online/offline（删 alive-unauthed）。存活但本进程无 token
            // （无归属孤儿/退出杀失败残留/另一 vite 持有）一律报 'offline' → 前端 planEnsure
            // 走 spawn，Node 侧按归属回收后全新拉起。绝不返回 token。`owned` 仅供诊断。
            const owner = readSeOwner(systemId);
            const status = alive && token ? 'online' : 'offline';
            return sendJson(res, 200, {
              system_id: systemId,
              alive,
              port: reg.port,
              status,
              owned: !!owner,
            });
          }

          // GET /api/se/preflight：SE 能力预检（本端点是预检横幅的唯一事实来源，
          // 前端只读此接口；判定来自 shared 运行时描述符——与 spawn 同一 probe/环境口径）。
          if (req.method === 'GET' && url.pathname === '/api/se/preflight') {
            const runtime = await resolveSeRuntimeForServer();
            if (!runtime.ok) {
              return sendJson(res, 200, {
                available: false,
                python: runtime.python || null,
                packageParent: runtime.packageParent || null,
                reason: runtime.reason,
                sources: runtime.sources,
              });
            }
            return sendJson(res, 200, {
              available: true,
              mode: runtime.mode,
              python: runtime.python,
              packageParent: runtime.packageParent,
              reason: runtime.probe.reason,
              sources: runtime.sources,
              version: runtime.probe.version || null,
              pythonVersion: runtime.probe.pythonVersion || null,
              versionRange: runtime.versionRange || null,
            });
          }

          if (req.method === 'GET' && url.pathname === '/api/se/systems') {
            return sendJson(res, 200, await supervisor.listSeSystems());
          }

          // POST /api/se/create：从名字创建**全新独立**系统。
          // 服务端在磁盘命名空间内原子分配 + 非递归 mkdir 占位（EEXIST 即已存在，
          // 含大小写别名），绝不读取/复用/回收任何已有 storage。创建后立即 spawn。
          if (req.method === 'POST' && url.pathname === '/api/se/create') {
            let body;
            try {
              body = JSON.parse((await readBody(req)) || '{}');
            } catch (err) {
              return sendJson(res, 400, { error: 'invalid json' });
            }
            const base = String(body.base == null ? '' : body.base).trim();
            const avoid = Array.isArray(body.avoid) ? body.avoid : [];
            if (!base) return sendJson(res, 400, { error: 'base required' });
            let allocation;
            try {
              allocation = allocateAndClaim(base, avoid);
            } catch (err) {
              return sendJson(res, 503, {
                error: String((err && err.message) || err),
                status: 'storage-namespace-unavailable',
              });
            }
            if (!allocation.ok) {
              return sendJson(res, 409, {
                error: 'no available system id',
                status: 'storage-root-exists',
              });
            }
            try {
              return sendJson(
                res,
                200,
                await supervisor.spawnSeSystem(allocation.systemId, { intent: 'create', claimed: true })
              );
            } catch (err) {
              // 仅在 Python 起来前仍为空时才回收占位目录（有内容则保留给清理器）。
              removeEmptyClaim(allocation.systemId);
              return sendSpawnError(res, allocation.systemId, err);
            }
          }

          // POST /api/se/spawn：connect/start（既有调用方全部走这里，语义不变）。
          // 大小写别名在 spawn 前失败（identity-mismatch）；目录不存在则原子占位后启动；
          // exact 已存在才进入归属回收/attach 状态机（存活由 Python 实例锁仲裁）。
          if (req.method === 'POST' && url.pathname === '/api/se/spawn') {
            let body;
            try {
              body = JSON.parse((await readBody(req)) || '{}');
            } catch (err) {
              return sendJson(res, 400, { error: 'invalid json' });
            }
            const systemId = sanitizeSeSystemId(body.system_id);
            if (!systemId) return sendJson(res, 400, { error: 'invalid system_id' });
            try {
              return sendJson(res, 200, await supervisor.spawnSeSystem(systemId));
            } catch (err) {
              return sendSpawnError(res, systemId, err);
            }
          }

          // POST /api/se/end：显式终止某系统的 SE。
          // E1=本 Vite spawn token+认证端点；E2=带 listener 启动时间的己方 owner。
          // 无法证明归属时绝不 kill/清账；端口反查与命令行为都不是授权依据。
          if (req.method === 'POST' && url.pathname === '/api/se/end') {
            let body;
            try {
              body = JSON.parse((await readBody(req)) || '{}');
            } catch (err) {
              return sendJson(res, 400, { error: 'invalid json' });
            }
            const systemId = sanitizeSeSystemId(body.system_id);
            if (!systemId) return sendJson(res, 400, { error: 'invalid system_id' });
            // 破坏性操作的身份闸门：大小写别名 → 用磁盘真实名做 storage/registry/owner
            // 读取（同一物理根）；多命中 → 不猜、不动。绝不因大小写误杀别的系统。
            let resolved;
            try {
              resolved = resolveStorageId(systemId);
            } catch (err) {
              return sendJson(res, 503, { error: 'SE storage namespace unavailable' });
            }
            if (resolved.kind === 'ambiguous') {
              return sendJson(res, 200, { ok: false, error: 'identity-conflict' });
            }
            const canonicalId = resolved.kind === 'alias' ? resolved.dirName : systemId;
            const inflight =
              seSpawnInflight.get(systemId) || seSpawnInflight.get(canonicalId);
            if (inflight) {
              return sendJson(res, 200, {
                ok: false,
                error: 'spawn-in-flight',
                code: 'spawn-in-flight',
                phase: 'spawn',
                retryable: true,
              });
            }

            const owner = readSeOwner(canonicalId);
            const ownerVitePid = Number(owner && owner.vitePid);
            if (
              owner &&
              Number.isInteger(ownerVitePid) &&
              ownerVitePid > 0 &&
              ownerVitePid !== process.pid &&
              isPidAlive(ownerVitePid) &&
              isNodeOrViteProcess(ownerVitePid)
            ) {
              return sendJson(res, 200, {
                ok: false,
                error: 'owned-by-other-vite',
                code: 'owned-by-other-vite',
                phase: 'ownership',
                retryable: false,
              });
            }

            const reg = readSeRegistry(canonicalId);
            const regPort = reg ? Number(reg.port) : NaN;
            const ownerPort = owner ? Number(owner.port) : NaN;
            const expectedPort =
              Number.isInteger(regPort) && regPort > 0
                ? regPort
                : Number.isInteger(ownerPort) && ownerPort > 0
                  ? ownerPort
                  : NaN;
            const tracked =
              seSpawnedSystems.get(systemId) || seSpawnedSystems.get(canonicalId);
            const trackedPort =
              tracked && Number.isInteger(Number(tracked.port)) && Number(tracked.port) > 0
                ? Number(tracked.port)
                : NaN;
            const spawnToken =
              tracked && tracked.child && tracked.token ? String(tracked.token) : '';

            let identityFailure = null;
            if (spawnToken && Number.isInteger(trackedPort) && trackedPort > 0) {
              const identity = await verifySpawnedInstance({
                systemId: canonicalId,
                port: trackedPort,
                token: spawnToken,
              });
              if (identity.ok) {
                const result = await terminateVerifiedInstance({
                  systemId,
                  canonicalId,
                  identity,
                  token: spawnToken,
                  source: 'spawn-token',
                });
                return sendJson(res, 200, result);
              }
              identityFailure = identity;
            }

            if (owner) {
              const identity = verifyOwnedOrphan({ owner, expectedPort });
              if (identity.ok) {
                const envToken = resolveSeToken(systemId) || resolveSeToken(canonicalId);
                const result = await terminateVerifiedInstance({
                  systemId,
                  canonicalId,
                  identity,
                  token: envToken || '',
                  source: 'owner',
                });
                return sendJson(res, 200, result);
              }
              if (!identityFailure) identityFailure = identity;
            }

            if (!reg && !owner && !tracked) {
              clearEndedState(systemId, canonicalId);
              return sendJson(res, 200, { ok: true, killed: false, graceful: false });
            }

            return sendEndFailure(res, {
              code: 'process-identity-unknown',
              phase: 'identity',
              reason: (identityFailure && identityFailure.reason) || 'no-verified-identity',
              retryable: true,
            });
          }

          return sendJson(res, 404, { error: 'not found' });
        } catch (err) {
          return sendJson(res, 500, { error: String((err && err.message) || err) });
        }
  };
}

export function attachSeWebSocket(httpServer, options = {}) {
  if (!httpServer) return;
  const isAllowed = (options.security && options.security.isAllowedUpgrade) || isAllowedSeRequest;
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (err) {
      return;
    }
    if (url.pathname !== '/api/se/ws') return;
    if (!isAllowed(req)) {
      socket.destroy();
      return;
    }
    const systemId = sanitizeSeSystemId(url.searchParams.get('system_id'));
    if (!systemId) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (browserWs) => {
      attachSeBrowser(browserWs, systemId);
    });
  });
}

export function seApi(options = {}) {
  return {
    name: 'se-api',
    configureServer(server) {
      if (options.security && server.config && server.config.server && server.config.server.port) {
        options.security.setPort(server.config.server.port);
      }
      server.middlewares.use(createSeApiMiddleware(options));
      const supervisor = options.supervisor || createSeSupervisor(options);
      supervisor.installExitHooks();
      attachSeWebSocket(server.httpServer, options);
    },
  };
}
