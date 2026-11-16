// 浏览器侧 SE JSON-RPC over WebSocket 客户端（期 1 接线层）。
//
// 安全前提：本模块**绝不接触 token**——auth 帧由 Vite Node 代理代发
// （见 vite.config.js 的 seApi()）。浏览器只连同源代理
// `/api/se/ws?system_id=`，SE 端口与凭据都留在 Node 进程内。
//
// 协议事实（SE 侧已核实）：
// - 请求/响应：`{jsonrpc, method, params, id}` → `{jsonrpc, id, result|error}`；
// - 订阅：`subscribe{topics:[...]}` → `{subscription_id}`；推送是**无 id notification**，
//   `method` = 主题字面量，`params` 含 `{subscription_id, topic, ...data}`；
// - 错误帧 `error.data` 强制五要素 `{kind, entity, expected, actual, hint}`。

import { getSessionSecret } from './session.js';

/** 请求缺省超时（毫秒）。 */
const REQUEST_TIMEOUT_MS = 30000;
/** 重连指数退避起点 / 封顶（毫秒）。 */
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8000;
// 代理侧约定：token 缺失 / auth 失败时以 close code 4401 关闭浏览器连接（D：前端
// 不再把它当终态，一律按离线退避重连由 ensure 自愈，故无需单独映射常量）。

/** 连接状态枚举（供顶栏徽标消费）。 */
export const SE_STATUS = Object.freeze({
  CONNECTING: 'connecting',
  ONLINE: 'online',
  OFFLINE: 'offline',
});

export class SEClient {
  constructor(systemId) {
    this.systemId = String(systemId);
    this.ws = null;
    this.closed = false;
    // id → {resolve, reject, timer}：本浏览器连接内唯一 id。
    this.pending = new Map();
    this.nextId = 1;
    // 订阅登记：entry = {topics, cb, subId}；订阅 id 仅在本连接内有效，
    // 重连后清空重订阅。
    this.subscriptions = new Set();
    this.subMap = new Map();
    this.status = SE_STATUS.CONNECTING;
    this.statusListeners = new Set();
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this._connect();
  }

  /**
   * 订阅状态变化；注册即回调一次当前状态。返回取消订阅函数。
   */
  onStatus(cb) {
    if (typeof cb !== 'function') return () => {};
    this.statusListeners.add(cb);
    try {
      cb(this.status);
    } catch (err) {
      /* 监听器异常不影响客户端 */
    }
    return () => this.statusListeners.delete(cb);
  }

  /**
   * 发起 JSON-RPC 调用。离线时立即 reject；在线时挂 pending 等响应。
   * 错误响应会把服务端 `error.message` 作为 Error.message，并把五要素
   * error.data 挂到 `err.data`；超时 reject。
   */
  call(method, params) {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error('SE client closed'));
        return;
      }
      if (this.status !== SE_STATUS.ONLINE || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`SE client not online (${this.status})`));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`SE request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this._send({ jsonrpc: '2.0', method, params: params || {}, id });
    });
  }

  /**
   * 订阅主题集合；notification 帧按 subscription_id 派发给 cb。
   * 返回取消订阅函数。重连成功后自动重发全部有效订阅。
   */
  subscribe(topics, cb) {
    const entry = { topics: Array.isArray(topics) ? topics.slice() : [topics], cb, subId: null };
    this.subscriptions.add(entry);
    if (this.status === SE_STATUS.ONLINE) this._sendSubscribe(entry);
    return () => {
      if (!this.subscriptions.delete(entry)) return;
      if (entry.subId != null) {
        this.subMap.delete(entry.subId);
        this._send({ jsonrpc: '2.0', method: 'unsubscribe', params: { subscription_id: entry.subId } });
        entry.subId = null;
      }
    };
  }

  /**
   * 关闭客户端：尽力退订全部订阅后关闭连接，并拒绝所有 pending。
   * 关闭后不再自动重连。
   */
  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const entry of this.subscriptions) {
      if (entry.subId != null) {
        this._send({ jsonrpc: '2.0', method: 'unsubscribe', params: { subscription_id: entry.subId } });
        entry.subId = null;
      }
    }
    this.subscriptions.clear();
    this.subMap.clear();
    this._failAllPending(new Error('SE client closed'));
    if (this.ws) {
      try {
        this.ws.close();
      } catch (err) {
        /* 忽略关闭异常 */
      }
      this.ws = null;
    }
    this._setStatus(SE_STATUS.OFFLINE);
  }

  /**
   * 立即重连：复位退避与尝试次数，拒绝在途请求后换新 socket。
   * 已关闭或 socket 已 OPEN 时为 no-op；订阅不清空（onopen 自动重订阅）。
   */
  retryNow() {
    if (this.closed) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    // 先显式拒绝在途请求：旧 socket 的 onclose 因 `this.ws !== ws` 提前返回，
    // 否则这些请求会一直挂到超时。
    this._failAllPending(new Error('SE client retrying'));
    const old = this.ws;
    if (old) {
      this.ws = null;
      try {
        old.close();
      } catch (err) {
        /* 忽略关闭异常 */
      }
    }
    this._connect();
  }

  // ── 内部实现 ──────────────────────────────────────────────────────────

  async _connect() {
    if (this.closed) return;
    this._setStatus(SE_STATUS.CONNECTING);
    let session = '';
    try {
      session = await getSessionSecret();
    } catch (err) {
      this._scheduleReconnect();
      return;
    }
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/api/se/ws?system_id=${encodeURIComponent(this.systemId)}&s=${encodeURIComponent(session)}`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws || this.closed) return;
      this.reconnectAttempt = 0;
      this._setStatus(SE_STATUS.ONLINE);
      // 重连后订阅 id 全部失效 → 清空重订阅。
      this.subMap.clear();
      for (const entry of this.subscriptions) {
        entry.subId = null;
        this._sendSubscribe(entry);
      }
    };

    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this._handleMessage(ev.data);
    };

    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this._failAllPending(new Error('SE connection closed'));
      if (this.closed) return;
      // D：4401（token 不可用）不再是终态。存活但无 token 的残留由 Node 侧回收重拉后会
      // 提供新 token，故一律按离线走退避重连，由 ensure 流程自愈（回收+全新拉起）。
      this._setStatus(SE_STATUS.OFFLINE);
      this._scheduleReconnect();
    };

    ws.onerror = () => {
      /* onclose 会跟进处理 */
    };
  }

  _scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, delay);
  }

  _sendSubscribe(entry) {
    this.call('subscribe', { topics: entry.topics })
      .then((result) => {
        if (!this.subscriptions.has(entry)) return;
        entry.subId = result ? result.subscription_id : null;
        if (entry.subId != null) this.subMap.set(entry.subId, entry);
      })
      .catch(() => {
        /* 订阅失败由连接状态体现；重连后会重试 */
      });
  }

  _send(frame) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch (err) {
      return;
    }
    if (Array.isArray(msg)) {
      for (const item of msg) this._handleFrame(item);
      return;
    }
    this._handleFrame(msg);
  }

  _handleFrame(msg) {
    if (!msg || msg.jsonrpc !== '2.0') return;
    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasId && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) {
        const err = new Error(msg.error.message || 'SE error');
        err.code = msg.error.code;
        if (msg.error.data != null) err.data = msg.error.data;
        pending.reject(err);
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (!hasId && msg.method) {
      const subId = msg.params ? msg.params.subscription_id : null;
      const entry = subId != null ? this.subMap.get(subId) : null;
      if (entry && typeof entry.cb === 'function') {
        try {
          entry.cb(msg.params, msg.method);
        } catch (err) {
          /* 订阅回调异常不影响其它订阅 */
        }
      }
    }
  }

  _failAllPending(err) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }

  _setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    for (const cb of this.statusListeners) {
      try {
        cb(status);
      } catch (err) {
        /* 监听器异常不影响客户端 */
      }
    }
  }
}
