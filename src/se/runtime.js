// 期 6-8 运行时装配（方案 §2.1/§2.2）：每系统一个 sessionHub + 三个 driver。
//
// 职责：
// - ensure(sid)：sePool.get → 建 hub（3 个新增主题）→ 挂三 driver → subscribe → hydrate；
// - dispose(sid)：hub.dispose + 清各 driver per-system 状态（关 tab / 卸载）；
// - reapply(sid)：重投影（projectStreams 回灌旧 scan/processes，G-8）之后把 driver 权威态
//   重新贴回节点（幂等）。
//
// 纪律（§2.1）：driver 不 import React / 不直接读 App state；只经注入的
// call/getNodes/setNodes/isActive。所有 setNodes 前置 isActive() 守卫（后台 tab 只缓存）。
import { sePool } from './pool.js';
import { createSessionHub } from './sessionHub.js';
import { createScanDriver } from './scanDriver.js';
import { createProcessDriver } from './processDriver.js';
import { createToolDriver } from './toolDriver.js';

/** hub 所有权：期 6-8 新增主题（stream.on_change 仍走 App 既有订阅）。 */
const DRIVER_TOPICS = ['scan.on_change', 'tool.process.on_change', 'tool.on_registry_change'];

/**
 * @param {{
 *   getNodes:()=>Array, setNodes:Function, notify:(text:string,kind?:string)=>void,
 *   isActive:(sid:string)=>boolean,
 *   onToolStatus?:(sid:string, snapshot:{present:Set<string>})=>void,
 * }} deps
 * @returns {{ensure:(sid:string)=>object, dispose:(sid:string)=>void, get:(sid:string)=>object|null,
 *            reapply:(sid:string)=>void}}
 */
export function createSeRuntime(deps) {
  const { getNodes, setNodes, notify, isActive, onToolStatus, onResumeTargetMissing } = deps;
  /** system_id → {sid, hub, scan, processes, tools} */
  const entries = new Map();
  const pending = new Set(); // 防止 ensure 期间重复 hydrate

  const scheduleHydrate = (entry) => {
    if (pending.has(entry.sid)) return;
    pending.add(entry.sid);
    Promise.resolve()
      .then(async () => {
        try {
          await entry.scan.hydrate();
          await entry.processes.hydrate();
          await entry.tools.hydrate();
        } catch (err) {
          /* hydrate 失败不致命：下一次重连/切换会重试 */
        }
      })
      .finally(() => pending.delete(entry.sid));
  };

  const ensure = (sidRaw) => {
    const sid = String(sidRaw);
    let entry = entries.get(sid);
    if (entry) {
      // 已存在：仅重新对账（切回 tab / 重连），不重复建订阅。
      scheduleHydrate(entry);
      return entry;
    }
    const client = sePool.get(sid);
    const hub = createSessionHub(client, { topics: DRIVER_TOPICS });
    const call = (m, p) => hub.call(m, p);
    const active = () => isActive(sid);
    const scan = createScanDriver({
      call,
      isActive: active,
      getNodes,
      setNodes,
      notify,
      onResumeTargetMissing,
    });
    const processes = createProcessDriver({ call, isActive: active, getNodes, setNodes, notify });
    // Oracle Q1：工具驱动是纯 RPC + 状态回报，**不写配置**；状态按 sid 回报给 App。
    const tools = createToolDriver({
      call,
      notify,
      onStatus: (snapshot) => {
        if (typeof onToolStatus === 'function') onToolStatus(sid, snapshot);
      },
    });
    hub.on('scan.on_change', (params) => scan.onEvent('scan.on_change', params));
    hub.on('tool.process.on_change', (params) => processes.onEvent('tool.process.on_change', params));
    hub.on('tool.on_registry_change', (params) => tools.onEvent('tool.on_registry_change', params));
    entry = { sid, hub, scan, processes, tools };
    entries.set(sid, entry);
    hub.subscribe();
    scheduleHydrate(entry);
    return entry;
  };

  const dispose = (sidRaw) => {
    const sid = String(sidRaw);
    const entry = entries.get(sid);
    if (!entry) return;
    entries.delete(sid);
    pending.delete(sid);
    try {
      entry.hub.dispose();
    } catch (err) {
      /* teardown 异常不影响其它系统 */
    }
    try {
      entry.scan.reset();
      entry.processes.reset();
      entry.tools.reset();
    } catch (err) {
      /* 同上 */
    }
  };

  const get = (sidRaw) => entries.get(String(sidRaw)) || null;

  /** 重投影后重贴 driver 权威态（scan/processes/termLog），幂等。 */
  const reapply = (sidRaw) => {
    const entry = entries.get(String(sidRaw));
    if (!entry) return;
    try {
      entry.scan.reapply();
      entry.processes.reapply();
    } catch (err) {
      /* 重贴失败不影响重投影结果 */
    }
  };

  return { ensure, dispose, get, reapply };
}
