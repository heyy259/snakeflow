// SE 上游 WS 扇入代理：浏览器↔SE 的 id 重映射、auth 代发、notification 广播。
import { WebSocket } from 'ws';
import {
  SE_DEFAULT_HOST,
  SE_CLOSE_TOKEN_UNAVAILABLE,
  SE_CLOSE_OFFLINE,
  seUpstreams,
} from './state.js';
import { readSeRegistry } from './registry.js';
import { resolveSeToken, probeTcp } from './resolve.js';

/**
 * 浏览器帧 → 上游 SE：把浏览器请求 id 重映射为上游唯一 id（多浏览器扇入
 * 时各端 id 命名空间独立，必然撞车），并记录反向映射供响应回投；
 * notification（无 id 帧）原样透传。
 */
function forwardBrowserFrame(up, rec, raw) {
  if (!up.ws || up.ws.readyState !== WebSocket.OPEN) return;
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch (err) {
    return; // 非法 JSON 不透传
  }
  if (
    msg &&
    !Array.isArray(msg) &&
    typeof msg === 'object' &&
    msg.id !== undefined &&
    msg.id !== null &&
    msg.method
  ) {
    const upstreamId = up.nextId++;
    rec.idMap.set(String(msg.id), upstreamId);
    rec.reverse.set(upstreamId, msg.id);
    up.ws.send(JSON.stringify({ ...msg, id: upstreamId }));
    return;
  }
  up.ws.send(raw.toString());
}

/** 上游 SE 帧 → 浏览器：auth 响应优先拦截；响应按反向映射回投；notification 广播。 */
function handleSeUpstreamMessage(up, rawData) {
  let msg;
  try {
    msg = JSON.parse(rawData.toString());
  } catch (err) {
    return;
  }
  if (!up.authed) {
    // 只认首帧 auth 响应（代理以 id=1 代发）。
    if (msg && msg.id === 1) {
      if (msg.result && msg.result.status === 'ok') {
        up.authed = true;
        if (up.authTimer) {
          clearTimeout(up.authTimer);
          up.authTimer = null;
        }
        if (up.readyResolve) up.readyResolve();
      } else {
        const detail = msg.error && msg.error.message ? msg.error.message : 'se auth failed';
        up.seCode = SE_CLOSE_TOKEN_UNAVAILABLE;
        finalizeSeUpstream(up, SE_CLOSE_TOKEN_UNAVAILABLE, detail);
      }
    }
    return;
  }
  const hasId = msg && msg.id !== undefined && msg.id !== null;
  if (hasId && (msg.result !== undefined || msg.error !== undefined)) {
    for (const rec of up.browsers) {
      if (!rec.reverse.has(msg.id)) continue;
      const browserId = rec.reverse.get(msg.id);
      rec.reverse.delete(msg.id);
      rec.idMap.delete(String(browserId));
      if (rec.ws.readyState === WebSocket.OPEN) {
        rec.ws.send(JSON.stringify({ ...msg, id: browserId }));
      }
      return;
    }
    return; // 无主响应（浏览器已断）：丢弃
  }
  if (!hasId && msg && msg.method) {
    // notification：广播给该系统全部浏览器连接；各端按自身 subscription_id 过滤。
    for (const rec of up.browsers) {
      if (rec.ws.readyState === WebSocket.OPEN) rec.ws.send(JSON.stringify(msg));
    }
  }
}

/** 终结上游连接：拒绝未就绪的 ready，并以约定 close code 关闭全部浏览器连接。 */
export function finalizeSeUpstream(up, code, reason) {
  if (up.finalized) return;
  up.finalized = true;
  if (up.authTimer) {
    clearTimeout(up.authTimer);
    up.authTimer = null;
  }
  if (seUpstreams.get(up.systemId) === up) seUpstreams.delete(up.systemId);
  if (!up.authed && up.readyReject) {
    up.readyReject(Object.assign(new Error(reason), { seCode: code }));
  }
  for (const rec of up.browsers) {
    rec.closed = true;
    try {
      rec.ws.close(code, reason);
    } catch (err) {
      /* 关闭异常忽略 */
    }
  }
  up.browsers.clear();
  if (up.ws && (up.ws.readyState === WebSocket.CONNECTING || up.ws.readyState === WebSocket.OPEN)) {
    try {
      up.ws.close(code, reason);
    } catch (err) {
      /* 关闭异常忽略 */
    }
  }
}

/** 取得（或新建）某系统的上游 SE 连接；已终结的旧连接会被替换。 */
function acquireSeUpstream(systemId) {
  const existing = seUpstreams.get(systemId);
  if (
    existing &&
    !existing.finalized &&
    existing.ws &&
    (existing.ws.readyState === WebSocket.CONNECTING || existing.ws.readyState === WebSocket.OPEN)
  ) {
    return existing;
  }
  if (existing) seUpstreams.delete(systemId);

  const up = {
    systemId,
    ws: null,
    authed: false,
    finalized: false,
    seCode: 1011,
    browsers: new Set(),
    nextId: 1000,
    authTimer: null,
    readyResolve: null,
    readyReject: null,
  };
  up.ready = new Promise((resolve, reject) => {
    up.readyResolve = resolve;
    up.readyReject = reject;
  });
  up.ready.catch(() => {}); // 防未处理拒绝告警

  const reg = readSeRegistry(systemId);
  const token = resolveSeToken(systemId);
  if (!reg) {
    up.finalized = true;
    up.readyReject(Object.assign(new Error('se not registered'), { seCode: 1011 }));
    return up;
  }
  if (!token) {
    // 无 token：先探测端口存活。死进程（陈旧 registry）→ 可重连(1011)；
    // 真活着才判缺 token(4401)，避免"SE 没跑却报缺 token"。
    probeTcp(reg.port)
      .then((alive) => {
        up.finalized = true;
        if (alive) {
          up.readyReject(
            Object.assign(new Error('token unavailable'), { seCode: SE_CLOSE_TOKEN_UNAVAILABLE })
          );
        } else {
          up.readyReject(Object.assign(new Error('se offline'), { seCode: SE_CLOSE_OFFLINE }));
        }
      })
      .catch(() => {
        // 探活自身异常：按不可达处理（可重连），避免 ready 永挂、浏览器 socket 死等不重连。
        up.finalized = true;
        up.readyReject(Object.assign(new Error('se probe failed'), { seCode: SE_CLOSE_OFFLINE }));
      });
    return up;
  }

  let ws;
  try {
    ws = new WebSocket(`ws://${SE_DEFAULT_HOST}:${reg.port}`);
  } catch (err) {
    up.finalized = true;
    up.readyReject(Object.assign(new Error('se connect failed'), { seCode: 1011 }));
    return up;
  }
  up.ws = ws;
  seUpstreams.set(systemId, up);

  up.authTimer = setTimeout(() => {
    up.seCode = SE_CLOSE_OFFLINE;
    finalizeSeUpstream(up, SE_CLOSE_OFFLINE, 'se auth timeout');
  }, 15000);

  ws.on('open', () => {
    // 首帧代发 auth：token 永不出 Node 进程。
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'auth', params: { token }, id: 1 }));
  });
  ws.on('message', (data) => handleSeUpstreamMessage(up, data));
  ws.on('close', () => finalizeSeUpstream(up, up.seCode || 1011, 'se disconnected'));
  ws.on('error', () => {
    /* close 事件兜底 */
  });

  return up;
}

/** 接受浏览器连接：缓冲至上游 auth 就绪，再开始双向透传。 */
export function attachSeBrowser(browserWs, systemId) {
  const up = acquireSeUpstream(systemId);
  const rec = {
    ws: browserWs,
    idMap: new Map(),
    reverse: new Map(),
    queue: [],
    closed: false,
  };

  browserWs.on('message', (data) => {
    if (up.authed && !up.finalized && up.ws && up.ws.readyState === WebSocket.OPEN) {
      forwardBrowserFrame(up, rec, data);
    } else if (!rec.closed) {
      rec.queue.push(data); // auth 就绪前缓冲，避免 SE 回 -32001
    }
  });
  browserWs.on('close', () => {
    rec.closed = true;
    up.browsers.delete(rec);
    rec.idMap.clear();
    rec.reverse.clear();
    rec.queue.length = 0;
  });
  browserWs.on('error', () => {
    /* close 兜底 */
  });

  up.ready
    .then(() => {
      if (rec.closed || up.finalized) return;
      up.browsers.add(rec);
      const queued = rec.queue.slice();
      rec.queue.length = 0;
      for (const data of queued) forwardBrowserFrame(up, rec, data);
    })
    .catch((err) => {
      rec.closed = true;
      const code = err && err.seCode ? err.seCode : 1011;
      try {
        browserWs.close(code, 'se proxy unavailable');
      } catch (e) {
        /* 忽略 */
      }
    });
}
