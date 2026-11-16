// SE 连接池（期 1 接线层）：按 system_id 键控的 SEClient 复用。
//
// 语义（对齐 SE接线方案.md §2.1/§5.1）：
// - get(system_id) 懒连接：首次取用时建连，之后切 tab/重复取用复用同一条；
// - release(system_id)：退订全部 + 关闭连接 + 从池中删除（关 tab 时调用）；
// - onStatus(system_id, cb) 透传客户端状态，供顶栏徽标订阅；
// - 状态枚举 connecting / online / offline（D：token-unavailable 已成防御性死路径——
//   存活但无 token 的残留由 Node 侧回收重拉，不再暴露给前端）。
import { SEClient, SE_STATUS } from './client.js';

export { SE_STATUS };

/** system_id → SEClient。 */
const clients = new Map();
/** system_id → Set<statusListener>。 */
const listeners = new Map();
/** system_id → 最近一次状态（供后来订阅者立即取值）。 */
const lastStatus = new Map();

function emit(systemId, status) {
  lastStatus.set(systemId, status);
  const set = listeners.get(systemId);
  if (!set) return;
  for (const cb of set) {
    try {
      cb(status);
    } catch (err) {
      /* 单个监听器异常不影响其余 */
    }
  }
}

export const sePool = {
  /** 懒连接：多次取用同一 system_id 复用同一客户端。 */
  get(systemId) {
    const id = String(systemId);
    let client = clients.get(id);
    if (!client) {
      client = new SEClient(id);
      client.onStatus((status) => emit(id, status));
      clients.set(id, client);
    }
    return client;
  },

  /** 释放：退订全部 + 关闭 + 从池中删除。 */
  release(systemId) {
    const id = String(systemId);
    const client = clients.get(id);
    if (!client) return;
    clients.delete(id);
    client.close();
  },

  /** 立即重连某系统（透传 client.retryNow）；池中不存在则忽略。 */
  retryNow(systemId) {
    const client = clients.get(String(systemId));
    if (client) client.retryNow();
  },

  /**
   * 订阅某系统状态；注册即回调最近一次状态（未知时回落 connecting）。
   * 返回取消订阅函数。
   */
  onStatus(systemId, cb) {
    const id = String(systemId);
    if (typeof cb !== 'function') return () => {};
    let set = listeners.get(id);
    if (!set) {
      set = new Set();
      listeners.set(id, set);
    }
    set.add(cb);
    try {
      cb(lastStatus.get(id) || SE_STATUS.CONNECTING);
    } catch (err) {
      /* 忽略监听器异常 */
    }
    return () => {
      const current = listeners.get(id);
      if (!current) return;
      current.delete(cb);
      if (current.size === 0) listeners.delete(id);
    };
  },

  /** 最近一次已知状态（未连接时 connecting）。 */
  statusOf(systemId) {
    return lastStatus.get(String(systemId)) || SE_STATUS.CONNECTING;
  },

  /**
   * 探查 `/api/se/endpoint`：offline 映射进状态事件（D：服务端已收敛 online/offline，
   * 不再有 alive-unauthed）。返回端点 JSON（或 null）；本调用不返回 token（服务端也不下发）。
   */
  async probe(systemId) {
    const id = String(systemId);
    try {
      const res = await fetch(`/api/se/endpoint?system_id=${encodeURIComponent(id)}`);
      if (!res.ok) return null;
      const data = await res.json();
      if (data && data.status === 'offline') emit(id, SE_STATUS.OFFLINE);
      return data;
    } catch (err) {
      return null;
    }
  },
};
