// 单一工具替换原语：unregister → register → 失败回滚。
//
// 边界：
// - 纯 RPC 组合 + 注入 `call`；不 import React / 不读写配置台账；
// - 只容忍 unregister 的 not-found（幂等），其它错误（认证/传输）停止且不盲目 register；
// - register 失败时用 `priorParams` 回滚（priorParams 由调用方按“原注册值”构造，
//   必须原样保留旧路径形态，避免把历史相对路径强行绝对化）；
// - `params.tool_path` 必须是调用方已绝对化并通过守卫的值（本模块不猜基准）。
import { errMessage } from './util.js';
import { isAbsolutePath } from './paths.js';

/** resolve 形态的业务失败：`{success:false}`。 */
function isFailure(res) {
  return !!(res && res.success === false);
}

/** not-found（-33001 / kind=not-found）；兼容 throw 与 resolve `{success:false,error:{...}}` 两形态。 */
export function isNotFoundError(x) {
  if (!x) return false;
  const err = x.error && typeof x.error === 'object' ? x.error : x;
  const code = x.code != null ? x.code : err.code;
  const kind = (x.data && x.data.kind) || err.kind;
  return code === -33001 || kind === 'not-found';
}

/** already-exists（-33002 / kind=already-exists）。 */
export function isAlreadyExistsError(x) {
  if (!x) return false;
  const err = x.error && typeof x.error === 'object' ? x.error : x;
  const code = x.code != null ? x.code : err.code;
  const kind = (x.data && x.data.kind) || err.kind;
  return code === -33002 || kind === 'already-exists';
}

/**
 * SE-facing 工具参数守卫：非空路径必须是绝对路径。
 * 返回错误文案；通过返回 ''。仅用于**本次新参数**——回滚 prior 必须原样重放。
 */
export function absoluteToolPathError(params) {
  for (const key of ['tool_path', 'execution_path', 'manual_path']) {
    const v = params && params[key];
    if (typeof v === 'string' && v !== '' && !isAbsolutePath(v)) {
      return `${key} 不是绝对路径（${v}）；请检查配置包/项目根/baseDir`;
    }
  }
  return '';
}

/** 把 resolve 的 `{success:false}` 转成可 catch 的错误（保留 code/kind）。 */
export function throwIfFailure(res) {
  if (!isFailure(res)) return res;
  const err = new Error(errMessage(res.error) || 'SE 返回失败');
  if (res.code != null) err.code = res.code;
  if (res.error && typeof res.error === 'object') {
    if (res.error.code != null) err.code = res.error.code;
    if (res.error.kind != null) err.data = { ...(err.data || {}), kind: res.error.kind };
  }
  throw err;
}

/** 尽力回滚旧定义；不抛错（回滚失败只作为结果返回）。 */
async function rollback(call, priorParams) {
  if (!priorParams || !priorParams.tool_path) return false;
  try {
    const res = await call('tool.register', priorParams);
    return !isFailure(res);
  } catch (err) {
    return false;
  }
}

/**
 * 替换一个**已存在**的工具：unregister → register；register 失败时用 priorParams 回滚。
 *
 * 返回：
 * - `{ok:true, result}`：替换成功；
 * - `{ok:false, error, rolledBack}`：失败；rolledBack=true 表示旧定义已恢复；
 * - `{ok:false, alreadyExists:true, error}`：register 撞 already-exists（旧工具仍在，不做任何破坏）。
 *
 * @param {{call:(m:string,p?:object)=>Promise<any>, name:string, params:object,
 *          priorParams?:object|null}} input
 * @returns {Promise<{ok:boolean, error?:string, alreadyExists?:boolean, rolledBack?:boolean, result?:any}>}
 */
export async function replaceRegisteredTool({ call, name, params, priorParams = null } = {}) {
  const target = String(name == null ? '' : name);
  if (typeof call !== 'function') return { ok: false, error: 'call 未注入' };
  if (!params || !params.tool_path) return { ok: false, error: 'tool_path 必填' };

  // 1) 注销旧名：not-found 视为已注销；其它错误 → 停止，不 register。
  let unregistered = false;
  try {
    const res = await call('tool.unregister', { name: target });
    if (isFailure(res)) {
      if (isNotFoundError(res)) unregistered = true;
      else return { ok: false, error: `tool.unregister ${target}：${errMessage(res.error)}` };
    } else {
      unregistered = true;
    }
  } catch (err) {
    if (isNotFoundError(err)) unregistered = true;
    else return { ok: false, error: `tool.unregister ${target}：${errMessage(err)}` };
  }

  // 2) 注册新定义；失败回滚 prior（若旧名已确认移除）。
  try {
    const res = await call('tool.register', params);
    if (isFailure(res)) {
      if (isAlreadyExistsError(res)) {
        return { ok: false, alreadyExists: true, error: `tool.register ${target}：${errMessage(res.error)}` };
      }
      const rolledBack = unregistered ? await rollback(call, priorParams) : false;
      return { ok: false, error: `tool.register ${target}：${errMessage(res.error)}`, rolledBack };
    }
    return { ok: true, result: res };
  } catch (err) {
    if (isAlreadyExistsError(err)) {
      // 旧工具仍未被移除（竞态/幂等 no-op）：保留现状，绝不盲目再 unregister。
      return { ok: false, alreadyExists: true, error: `tool.register ${target}：${errMessage(err)}` };
    }
    const rolledBack = unregistered ? await rollback(call, priorParams) : false;
    return { ok: false, error: `tool.register ${target}：${errMessage(err)}`, rolledBack };
  }
}
