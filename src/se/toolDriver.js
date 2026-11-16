// 期 9 工具驱动：把 SE 工具注册表（tool.*）的**运行时状态**接进 App。
//
// 职责（对齐 plan §2/§3「配置=唯一台账，SE=一次性执行器」）：
// - hydrate()：`tool.list` → 计算「已注册工具名集合 + 完整定义」并经 onStatus 上报（**不写配置**）；
// - onEvent('tool.on_registry_change')：增量维护上述集合与定义；
// - register()/unregister()：前端组合 RPC（成功即返回，通知用户）；
// - update()：编辑工具（含同名）——SE tool.register 不 upsert，故始终 unregister→register，
//   失败尽力回滚 priorDef，且**恰好一次**通知（不发中间删除/注册 toast）；
// - probeRoot()：**无副作用**探测当前连接是否具备 root 工具管理权限。
//
// 纪律（Oracle Q1：单一写者）：
// - 驱动**绝不拥有/修改配置 tools 字典**。工具列表的真源是 App 的配置（即 `tools` state），
//   App 在 dispatch* 成功后经 commitTools 提交配置；驱动只回报「注册状态」。
// - 不 import React / 不 import src/tools.js（保持解耦，字段白名单本地维护）；
// - 不再需要 isActive：状态是 per-system 元数据，后台系统也要记账（切回即见）。
//
// root 权限探测原理（对齐 SE server/tools.py）：
//   tool.unregister {name:''} 在 **root** 下先过 name 校验 → -32602（invalid params）；
//   在 **非 root** 下先被权限门拦下 → -32001（unauthorized）。二者都不改注册表。

import { buildRegisterParams } from './toolParams.js';
import { replaceRegisteredTool, absoluteToolPathError } from './toolReplace.js';
import { errMessage, isPlainObject } from './util.js';

const TOPIC_REGISTRY = 'tool.on_registry_change';

/**
 * @param {{
 *   call:(method:string, params?:object)=>Promise<any>,
 *   notify:(text:string, kind?:string)=>void,
 *   onStatus?:(snapshot:{present:Set<string>, definitions:Object<string, object>})=>void,
 * }} deps
 * @returns {{
 *   topics:string[], onEvent:(topic:string, params:object)=>void,
 *   hydrate:()=>Promise<void>, reset:()=>void,
 *   register:(def:object, opts?:object)=>Promise<any>,
 *   unregister:(name:string, opts?:object)=>Promise<any>,
 *   update:(oldName:string, def:object, priorDef:object|null)=>Promise<any>,
 *   probeRoot:()=>Promise<boolean|null>, canManageTools:()=>boolean,
 * }}
 */
export function createToolDriver({ call, notify, onStatus } = {}) {
  /** 上次探测到的 root 能力（默认 false = 未确认）。 */
  let canManage = false;
  /** SE 当前已注册的工具名集合（运行时状态，非配置）。 */
  let present = new Set();
  let definitions = new Map();

  const info = (text, kind) => {
    try {
      if (typeof notify === 'function') notify(text, kind);
    } catch (err) {
      /* 通知失败不影响驱动主流程 */
    }
  };
  const report = () => {
    try {
      if (typeof onStatus === 'function') {
        onStatus({ present: new Set(present), definitions: Object.fromEntries(definitions) });
      }
    } catch (err) {
      /* 状态上报失败不影响驱动主流程 */
    }
  };

  /** 全量对账：tool.list → 已注册名集合与完整定义（调用失败保留旧快照）。不触碰任何配置。 */
  async function hydrate() {
    let list;
    try {
      list = await call('tool.list', {});
    } catch (err) {
      return; // 调用失败：保留现有集合，等下次重连/切换重试
    }
    const items = Array.isArray(list)
      ? list
      : isPlainObject(list)
        ? Object.values(list)
        : [];
    const next = new Set();
    const nextDefinitions = new Map();
    for (const item of items) {
      const name = isPlainObject(item) ? String(item.name == null ? '' : item.name).trim() : '';
      if (!name) continue;
      next.add(name);
      nextDefinitions.set(name, item);
    }
    present = next;
    definitions = nextDefinitions;
    report();
  }

  /** 增量事件：注册表变更（registered / unregistered）→ 同步已注册名集合与定义。 */
  function onEvent(topic, params) {
    if (topic !== TOPIC_REGISTRY) return;
    const p = isPlainObject(params) ? params : {};
    if (p.type === 'registered') {
      const name = isPlainObject(p.tool) ? String(p.tool.name == null ? '' : p.tool.name).trim() : '';
      if (!name) return;
      present = new Set(present);
      present.add(name);
      definitions = new Map(definitions);
      const previous = definitions.get(name);
      const eventDefinition = Object.keys(p.tool).length === 1 && previous ? previous : p.tool;
      definitions.set(name, eventDefinition);
      report();
      return;
    }
    if (p.type === 'unregistered') {
      const name = String(p.name == null ? '' : p.name);
      if (!name) return;
      present = new Set(present);
      present.delete(name);
      definitions = new Map(definitions);
      definitions.delete(name);
      report();
    }
  }

  /** 注册工具：必填三件套（tool_path 空则 fail-fast，无 RPC）。配置提交由 App 负责。 */
  async function register(def, opts = {}) {
    const params = buildRegisterParams(def, opts.baseDir || '');
    if (!params.tool_path) {
      throw new Error('tool_path 必填');
    }
    const pathErr = absoluteToolPathError(params);
    if (pathErr) throw new Error(pathErr);
    let res;
    try {
      res = await call('tool.register', params);
    } catch (err) {
      info('注册工具失败：' + errMessage(err), 'warn');
      throw err;
    }
    // 显式失败（SE 返回 {success:false,error}）→ 通知并抛错，交由调用方反应。
    if (res && res.success === false) {
      const msg = errMessage(res.error) || '未知错误';
      info('注册工具失败：' + msg, 'warn');
      const failure = new Error(msg);
      if (res.code != null) failure.code = res.code;
      failure.result = res;
      throw failure;
    }
    present = new Set(present);
    present.add(params.name);
    definitions = new Map(definitions);
    definitions.set(params.name, params);
    report();
    info('已注册工具「' + params.name + '」', 'ok');
    return res;
  }

  /** 删除工具：成功则通知；失败/异常通知并抛错。opts.silent=true 时抑制自身通知。 */
  async function unregister(name, opts = {}) {
    const silent = !!(opts && opts.silent);
    const target = String(name == null ? '' : name);
    let res;
    try {
      res = await call('tool.unregister', { name: target });
    } catch (err) {
      if (!silent) info('删除工具失败：' + errMessage(err), 'warn');
      throw err;
    }
    if (res && res.success === false) {
      const msg = errMessage(res.error) || '未知错误';
      if (!silent) info('删除工具失败：' + msg, 'warn');
      const failure = new Error(msg);
      if (res.code != null) failure.code = res.code;
      failure.result = res;
      throw failure;
    }
    present = new Set(present);
    present.delete(target);
    definitions = new Map(definitions);
    definitions.delete(target);
    report();
    if (!silent) info('已删除工具「' + target + '」', 'info');
    return res;
  }

  /**
   * 编辑工具（含同名）：始终 unregister→register（SE tool.register 不 upsert）。
   * - 空 tool_path → fail-fast 抛错（同 register，无 RPC）。
   * - unregister 的 not-found 视为可继续（幂等）；静默执行，不发中间 toast。
   * - register 失败且旧名已注销 → 尽力 re-register priorDef 回滚。
   * - 通知**恰好一次**：成功 → 已更新；失败 → 单条 warn（含回滚结果）。
   * @param {string} oldName 当前注册名
   * @param {object} def 表单产出的新定义（调用方已合并 priorDef）
   * @param {object|null} priorDef 旧定义（回滚用；来自当前 tools 树）
   * @returns {Promise<any>}
   */
  async function update(oldName, def, priorDef, opts = {}) {
    const target = String(oldName == null ? '' : oldName);
    const baseDir = opts.baseDir || '';
    const params = buildRegisterParams(def, baseDir);
    if (!params.tool_path) {
      throw new Error('tool_path 必填');
    }
    const pathErr = absoluteToolPathError(params);
    if (pathErr) throw new Error(pathErr);
    // 旧定义按同一基准重建（台账里的旧值），仅用于失败回滚。
    const priorParams = isPlainObject(priorDef) ? buildRegisterParams(priorDef, baseDir) : null;

    // 统一替换原语：unregister（not-found 幂等）→ register → 失败回滚。
    const result = await replaceRegisteredTool({
      call,
      name: target,
      params,
      priorParams: priorParams && priorParams.tool_path ? priorParams : null,
    });
    if (!result.ok) {
      const msg = result.error || '未知错误';
      info(result.rolledBack ? '更新工具失败：' + msg + '（已回滚旧定义）' : '更新工具失败：' + msg, 'warn');
      const failure = new Error(msg);
      failure.rolledBack = !!result.rolledBack;
      failure.result = result;
      throw failure;
    }

    // 成功：更新已注册名集合（旧名可能改名）+ 恰好一次成功通知。配置提交由 App 负责。
    present = new Set(present);
    present.delete(target);
    present.add(params.name);
    definitions = new Map(definitions);
    definitions.delete(target);
    definitions.set(params.name, params);
    report();
    info('已更新工具「' + params.name + '」', 'ok');
    return result.result || { success: true };
  }

  /**
   * 无副作用 root 能力探测：tool.unregister {name:''}。
   * - -32602（先过 root 门，name 校验失败）→ 具备 root 权限 → true；
   * - -32001（权限门拦下）→ 非 root → false；
   * - 其它/意外成功 → null（unknown，canManage 不变）。
   * 探测绝不动注册表。
   */
  async function probeRoot() {
    try {
      await call('tool.unregister', { name: '' });
      return null; // 字面成功不符合预期（name 必填），视为未知
    } catch (err) {
      const code = err && err.code;
      if (code === -32602) {
        canManage = true;
        return true;
      }
      if (code === -32001) {
        canManage = false;
        return false;
      }
      return null;
    }
  }

  return {
    topics: [TOPIC_REGISTRY],
    onEvent,
    hydrate,
    reset() {
      canManage = false;
      present = new Set();
      definitions = new Map();
      report();
    },
    register,
    unregister,
    update,
    probeRoot,
    canManageTools() {
      return canManage;
    },
  };
}
