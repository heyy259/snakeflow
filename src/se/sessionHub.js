// 期 6-8 共享接缝：每系统一条多主题订阅 + 按主题扇出 + call 透传（方案 §2.2）。
//
// 目的：把 scan/process/registry 三个新主题（`scan.on_change` /
// `tool.process.on_change` / `tool.on_registry_change`）收归**单一所有者**，
// 使重连后的 hydrate 顺序确定、teardown 收敛为一次 `dispose()`。
//
// `stream.on_change` 仍由 App 既有的 `subscribeSeChanges` 订阅（期 3-5 通路，
// 复用不重构）——本 hub 只管期 6-8 新增主题，避免重复订阅。
//
// 无 React 依赖；driver 经 hub.call 发起 RPC（call 透传到 SEClient.call）。

/**
 * @param {{call:(m:string,p?:object)=>Promise<any>, status?:string}} client SEClient
 * @param {{topics:string[]}} opts 订阅主题集合（合法值见 SE server/subscriptions.py）
 * @returns {{
 *   call:(m:string,p?:object)=>Promise<any>,
 *   on:(topic:string, fn:(params:object, topic:string)=>void)=>()=>void,
 *   subscribe:()=>void,
 *   status:()=>string,
 *   dispose:()=>void,
 * }}
 */
export function createSessionHub(client, { topics = [] } = {}) {
  const handlers = new Map(); // topic → Set<fn>
  const subscribed = Array.isArray(topics) ? topics.slice() : [];
  let offSubscription = null;

  /** notification 帧：`method` = 主题字面量，`params` 含 subscription_id/topic/data。 */
  const dispatch = (params, method) => {
    const topic = method;
    const set = handlers.get(topic);
    if (!set || set.size === 0) return;
    for (const fn of set) {
      try {
        fn(params, topic);
      } catch (err) {
        /* 单个 handler 异常不影响其余主题/订阅 */
      }
    }
  };

  return {
    call(method, params) {
      return client.call(method, params || {});
    },

    /** 按主题注册 handler；返回注销函数。 */
    on(topic, fn) {
      if (typeof fn !== 'function') return () => {};
      let set = handlers.get(topic);
      if (!set) {
        set = new Set();
        handlers.set(topic, set);
      }
      set.add(fn);
      return () => {
        const cur = handlers.get(topic);
        if (!cur) return;
        cur.delete(fn);
        if (cur.size === 0) handlers.delete(topic);
      };
    },

    /** 建立底层订阅（幂等）；SEClient 重连会自动重订阅。 */
    subscribe() {
      if (offSubscription || subscribed.length === 0) return;
      offSubscription = client.subscribe(subscribed, dispatch);
    },

    status() {
      return client.status;
    },

    /** 退订 + 清空 handler；幂等。 */
    dispose() {
      if (offSubscription) {
        try {
          offSubscription();
        } catch (err) {
          /* 退订异常不影响 teardown */
        }
        offSubscription = null;
      }
      handlers.clear();
    },
  };
}
