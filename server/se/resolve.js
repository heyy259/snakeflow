// SE 解析层：system_id 净化、Host/Origin 闸门、运行时解析、token 解析、TCP/RPC 探针。
import net from 'node:net';
import { WebSocket } from 'ws';
import {
  SE_DEFAULT_HOST,
  SE_ENV_ADMIN_TOKEN,
  SE_CLOSE_TOKEN_UNAVAILABLE,
  SE_ALLOWED_HOSTNAMES,
  SE_RPC_TIMEOUT_MS,
  seSpawnedSystems,
} from './state.js';
import { resolveSeRuntime } from './runtime/seRuntime.js';
import { validateSystemId } from '../../shared/nameContract.js';
import { getAppPaths } from '../paths.js';

export async function resolveSeRuntimeForServer() {
  const paths = getAppPaths();
  const result = await resolveSeRuntime({
    projectRoot: paths.appRoot,
    dataRoot: paths.dataRoot,
    configFile: paths.mode === 'installed' ? paths.configFile : undefined,
  });
  return { ...result, appRoot: paths.appRoot, dataRoot: paths.dataRoot };
}

export const sanitizeSeSystemId = validateSystemId;

/** 取 Host 头的 hostname（去端口；IPv6 字面量保留方括号）。 */
function hostnameOf(hostHeader) {
  const host = String(hostHeader || '').trim().toLowerCase();
  if (!host) return '';
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end >= 0 ? host.slice(0, end + 1) : host;
  }
  const colon = host.indexOf(':');
  return colon >= 0 ? host.slice(0, colon) : host;
}

/**
 * Host/Origin 白名单校验（代理唯一安全闸门）。
 * Host 必须命中回环名单；Origin 若存在同样必须命中（缺失 = Node 客户端，放行）。
 */
export function isAllowedSeRequest(req) {
  if (!SE_ALLOWED_HOSTNAMES.has(hostnameOf(req.headers.host))) return false;
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try {
      host = new URL(origin).hostname.toLowerCase();
    } catch (err) {
      return false;
    }
    if (!SE_ALLOWED_HOSTNAMES.has(host)) return false;
  }
  return true;
}

/**
 * Node 侧 token 解析：spawn 注入位优先，退回 vite 进程 env。
 * §5.1：**不再回退** storage 的 `.se-token` —— 该回退正是「硬杀后重启误 attach 到孤儿」的根因；
 * 启动一律回收己方残留后全新 spawn，故持久化 token 不再参与认证。
 */
export function resolveSeToken(systemId) {
  const spawned = seSpawnedSystems.get(systemId);
  if (spawned && spawned.token) return spawned.token;
  const envToken = process.env[SE_ENV_ADMIN_TOKEN];
  if (envToken) return envToken;
  return null;
}

/** TCP 探测 127.0.0.1:<port> 存活（registry 无 pid，TCP 是唯一判据）。 */
export function probeTcp(port, timeout = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: SE_DEFAULT_HOST, port });
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

/** 向 SE 发单次 JSON-RPC（代发 auth）。返回 result；auth 失败抛 seCode=4401。 */
export function seRpcOnce(port, token, method, params = {}, timeout = SE_RPC_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(`ws://${SE_DEFAULT_HOST}:${port}`);
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch (err) {
        /* 忽略 */
      }
      fn(arg);
    };
    const timer = setTimeout(() => {
      finish(reject, new Error(`se ${method} timeout`));
    }, timeout);
    let authed = false;
    ws.on('open', () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'auth', params: { token }, id: 1 }));
    });
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (err) {
        return;
      }
      if (!authed && msg && msg.id === 1) {
        if (msg.result && msg.result.status === 'ok') {
          authed = true;
          ws.send(JSON.stringify({ jsonrpc: '2.0', method, params: params || {}, id: 2 }));
        } else {
          finish(
            reject,
            Object.assign(new Error('se auth failed'), { seCode: SE_CLOSE_TOKEN_UNAVAILABLE })
          );
        }
        return;
      }
      if (authed && msg && msg.id === 2) {
        if (msg.error) {
          finish(reject, Object.assign(new Error(msg.error.message || 'se error'), {
            code: msg.error.code,
            data: msg.error.data,
          }));
        } else {
          finish(resolve, msg.result);
        }
      }
    });
    ws.on('error', (err) => finish(reject, err));
  });
}

/** 经代理校验 system_id（防端口串台）：返回 system.info 结果，失配抛 mismatch。 */
export async function verifySeSystem(systemId, port, token) {
  const info = await seRpcOnce(port, token, 'system.info');
  if (!info || String(info.system_id) !== systemId) {
    throw Object.assign(new Error('system_id mismatch'), {
      mismatch: true,
      actual: info ? info.system_id : null,
    });
  }
  return info;
}
