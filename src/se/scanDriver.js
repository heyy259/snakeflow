// 期 6-8 扫描驱动（SE 接线方案 §2.2 / 风险 7）。
//
// 职责：
// - 维护每流权威扫描态 `Map<nodeId,{state,position,ok,fail}>`，供重投影（会丢弃运行时
//   节点数据）后 `reapply()` 把权威态重新贴回节点；
// - `action()` 经注入的 `call` 发起 `scan.*` RPC，先乐观更新权威态、再等 RPC 结果；
// - `onEvent()` 消费 `scan.on_change` 通知，把 SE 事实（完成计数、实时执行等）写回节点。
// - 权限轴（authority-v2）：`authority / allowedAuthorities / canSetAuthority` 是服务端
//   事实的只读投影；`switchingAuthority` 只是本地 in-flight 标记。
//
// 纪律：
// - 本模块无 React / DOM 依赖，可在 Node 侧直接 import 做单测；
// - 只经注入的 `call / getNodes / setNodes / isActive / notify` 交互，不直接读 App state；
// - 每次写画布前一律 `isActive()` 守卫（后台 tab 只缓存权威态，不落地画布）；
// - `setNodes` 一律传**函数式** updater，保证脱离 React 也可测试；
// - **authority 绝不乐观更新**：`setauthority` 只置 `switchingAuthority`，最终值一律以
//   `scan.set_authority` 响应或 `scan.on_change` / `scan.status` 的服务端事实为准；
// - 不在本地复制权限矩阵（`allowed_authorities / can_set_authority` 原样透传）；
// - 不实现 `tick`（周期扫描已移除）；`anchor_stale` 不自动重扫，交由用户决定。
import { streamNodeId, streamNameFromId } from './streams.js';
import { errMessage } from './util.js';

/** 惰性初始态：未开始扫描的流（保留/提交受阻计数默认 0）。 */
const idleScan = () => ({
  state: 'idle',
  // 加法字段（2026-10-25 暂停诚实化）：paused / pausing / none。不持久化。
  pausePhase: 'none',
  position: 0,
  ok: 0,
  fail: 0,
  retained: 0,
  commitFailed: 0,
  stalled: 0,
  // 权限轴（authority-v2）：服务端事实的只读投影 + 本地 in-flight 标记。
  authority: null,
  allowedAuthorities: [],
  canSetAuthority: false,
  switchingAuthority: false,
});

/** SE 新增计数（旧 SE 缺字段按 0：纯加性）。 */
const countOf = (value) => Number(value) || 0;

/**
 * 暂停相位归一（新后端 `pause_phase` 优先；旧后端按 `state` 降级）。
 * - 旧后端 `scan.pause` 响应可能是 `{state:"pausing"}` 或 `{state:"paused"}`；
 * - 事件 `state` 缺 `pause_phase` 时：paused → paused，其余 → none。
 */
const phaseOf = (res, fallbackState) => {
  const raw = res && res.pause_phase;
  if (raw === 'paused' || raw === 'pausing' || raw === 'none') return raw;
  const st = (res && res.state) || fallbackState;
  if (st === 'pausing') return 'pausing';
  if (st === 'paused') return 'paused';
  return 'none';
};

/**
 * 创建扫描驱动。
 *
 * @param {{
 *   call:(method:string,params:object)=>Promise<any>,
 *   isActive:()=>boolean,
 *   getNodes:()=>Array<{id:string,data?:object}>,
 *   setNodes:(updater:Function)=>void,
 *   notify:(text:string,kind?:string)=>void,
 *   onResumeTargetMissing?:(info:{nodeId:string,name:string,reason:string,
 *     position:number,candidates:Array<object>})=>void,
 * }} deps
 * @returns {{
 *   topics:string[],
 *   onEvent:(topic:string,params:object)=>void,
 *   hydrate:()=>Promise<void>,
 *   reset:()=>void,
 *   reapply:()=>void,
 *   action:(nodeId:string,action:string,payload?:any)=>void,
 * }}
 */
export function createScanDriver({
  call,
  isActive,
  getNodes,
  setNodes,
  notify,
  onResumeTargetMissing,
}) {
  /** 权威扫描态：nodeId → {state,position,ok,fail}。 */
  const store = new Map();
  /** Per-node status refresh sequence: ignore late responses after resume/stop. */
  const statusSeq = new Map();

  /** 安全判定当前 tab 是否活跃；注入异常按不活跃处理。 */
  const active = () => {
    try {
      return !!isActive();
    } catch (err) {
      return false;
    }
  };

  /** 取当前画布节点数组（容错）。 */
  const nodesNow = () => {
    const list = getNodes();
    return Array.isArray(list) ? list : [];
  };

  const findNode = (nodeId) => nodesNow().find((n) => n && String(n.id) === String(nodeId));

  /** 惰性取权威态；不存在则以 idle 建立。 */
  const ensure = (nodeId) => {
    let cur = store.get(nodeId);
    if (!cur) {
      cur = idleScan();
      store.set(nodeId, cur);
    }
    return cur;
  };

  /** 单节点权威态 → node.data.scan（函数式 setNodes，活跃守卫）。 */
  const applyOne = (nodeId) => {
    if (!active()) return;
    const s = store.get(nodeId);
    if (!s) return;
    setNodes((nds) =>
      nds.map((n) => (n && String(n.id) === String(nodeId) ? { ...n, data: { ...n.data, scan: { ...s } } } : n))
    );
  };

  /** 全部权威态一次性贴回画布（重投影 / hydrate 后对账，幂等）。 */
  const applyAll = () => {
    if (!active()) return;
    if (store.size === 0) return;
    setNodes((nds) =>
      nds.map((n) => {
        const s = n ? store.get(String(n.id)) : undefined;
        return s ? { ...n, data: { ...n.data, scan: { ...s } } } : n;
      })
    );
  };

  /** 写入权威态并（活跃时）落地画布。 */
  const commit = (nodeId, next) => {
    store.set(nodeId, next);
    applyOne(nodeId);
    return next;
  };

  /** 统一失败提示：`扫描操作失败：<message>`。 */
  const notifyFail = (err) => {
    if (typeof notify === 'function') notify(`扫描操作失败：${errMessage(err)}`, 'warn');
  };

  /**
   * Best-effort server-truth refresh of the additive authority fields.
   * `scan.on_change` carries `authority` but not
   * `allowed_authorities`/`can_set_authority`; a settled pause must fetch
   * `scan.status` once so the paused switcher can render without a reload.
   * Missing fields in the response leave the current value untouched.
   */
  const refreshStatus = (nodeId, name, { onlyIfPaused = false } = {}) => {
    const seq = (statusSeq.get(nodeId) || 0) + 1;
    statusSeq.set(nodeId, seq);
    return call('scan.status', { stream_name: name })
      .then((res) => {
        if (!res || typeof res !== 'object') return;
        // A newer refresh/state change superseded this response.
        if (statusSeq.get(nodeId) !== seq) return;
        const cur = ensure(nodeId);
        // The pause-triggered refresh must never repopulate authority after a
        // resume/stop; callers that refresh outside pause omit this guard.
        if (onlyIfPaused && cur.state !== 'paused') return;
        const next = { ...cur };
        if (Object.prototype.hasOwnProperty.call(res, 'authority')) {
          next.authority = res.authority ?? null;
        }
        if (Array.isArray(res.allowed_authorities)) {
          next.allowedAuthorities = res.allowed_authorities.slice();
        }
        if (Object.prototype.hasOwnProperty.call(res, 'can_set_authority')) {
          next.canSetAuthority = !!res.can_set_authority;
        }
        // Never cancel an in-flight set_authority from a status refresh.
        commit(nodeId, next);
      })
      .catch(() => {});
  };

  /**
   * 重锚失败（无法定位剩余步骤）→ 保持 PAUSED + 候选交给 App 弹三选一。
   * 绝不在这里把权威态抹成 idle（否则用户失去“继续/重扫/停止”的上下文）。
   */
  const emitResumeMissing = (nodeId, info) => {
    const cur = ensure(nodeId);
    const payload = {
      nodeId,
      name: streamNameFromId(nodeId) || '',
      reason: (info && info.reason) || 'resume-target-missing',
      position: Number(info && info.position) || cur.position || 0,
      candidates: Array.isArray(info && info.candidates) ? info.candidates : [],
    };
    commit(nodeId, {
      ...cur,
      state: 'paused',
      pausePhase: 'paused',
      resumeMissing: payload,
    });
    if (typeof onResumeTargetMissing === 'function') {
      try {
        onResumeTargetMissing(payload);
      } catch (err) {
        /* 回调异常不影响扫描态 */
      }
    }
    return payload;
  };

  // SE 业务失败以 resolved {success:false} 返回，进不了 .catch；须显式收敛态。
  // `resume-target-missing` 是**可恢复**失败：保持 paused + 候选，绝不重置 idle。
  const settleScanFail = (p, nodeId, label) =>
    p.then(
      (res) => {
        if (res && res.success === false) {
          const kind = res.error && res.error.kind;
          if (typeof notify === 'function') notify(`${label}：${errMessage(res.error)}`, 'warn');
          if (kind === 'resume-target-missing') {
            emitResumeMissing(nodeId, {
              reason: kind,
              position: ensure(nodeId).position,
              candidates: (res.error && res.error.candidates) || [],
            });
          } else {
            commit(nodeId, idleScan());
          }
        }
        return res;
      },
      (err) => {
        if (typeof notify === 'function') notify(`${label}：${errMessage(err)}`, 'warn');
        commit(nodeId, idleScan());
      }
    );

  return {
    topics: ['scan.on_change'],

    /**
     * 消费 `scan.on_change` 通知。
     * 通知形态：`{subscription_id, topic, stream_name, name, change}`。
     */
    onEvent(topic, params) {
      const p = params || {};
      const name = p.stream_name ?? p.name ?? (p.change && p.change.stream_name);
      if (name == null || name === '') return;
      const nodeId = streamNodeId(name);
      // 只更新已存在的投影节点，绝不因通知新建节点。
      if (!findNode(nodeId)) return;

      let cur = ensure(nodeId);
      const c = p.change || {};
      // 顶层 `authority` 是服务端实际值：任何事件携带即对账，并清 in-flight 标记。
      const hasTopAuthority = Object.prototype.hasOwnProperty.call(p, 'authority');
      const topAuthority = p.authority;
      if (hasTopAuthority && topAuthority !== undefined) {
        cur = commit(nodeId, { ...cur, authority: topAuthority, switchingAuthority: false });
      }
      switch (c.type) {
        case 'authority': {
          // 权限实际变化：只更新 authority 轴，绝不动 state / pausePhase。
          const hasNew = Object.prototype.hasOwnProperty.call(c, 'new_authority');
          const reported = hasNew ? c.new_authority : cur.authority;
          const next = { ...cur, authority: reported };
          if (hasNew || topAuthority !== undefined) next.switchingAuthority = false;
          commit(nodeId, next);
          return;
        }
        case 'state': {
          const raw = c.new_state !== undefined ? c.new_state : c.state;
          const state = raw == null || raw === '' ? 'idle' : raw;
          // 暂停相位（加法）：优先消费后端 pause_phase；旧后端按 state 降级。
          const pausePhase =
            c.pause_phase !== undefined
              ? phaseOf({ pause_phase: c.pause_phase, state }, state)
              : state === 'paused'
                ? 'paused'
                : 'none';
          const next = { ...cur, state, pausePhase };
          // idle 时位置归零（保留 ok/fail）；离开暂停即清空“待选择候选”。
          if (state === 'idle') {
            next.position = 0;
            next.authority = null;
            next.allowedAuthorities = [];
            next.canSetAuthority = false;
            next.switchingAuthority = false;
          }
          if (state === 'idle' || state === 'scanning') next.resumeMissing = null;
          commit(nodeId, next);
          // A settled pause is the only point where the switcher may appear;
          // hydrate allowed_authorities/can_set_authority from server truth.
          if (state === 'paused') refreshStatus(nodeId, name, { onlyIfPaused: true });
          return;
        }
        case 'reanchored': {
          // 编辑后续跑：后端已按语义前沿重新定位，继续本轮扫描。
          const remaining = countOf(c.remaining);
          commit(nodeId, { ...cur, state: 'scanning', pausePhase: 'none', resumeMissing: null });
          if (typeof notify === 'function') {
            notify(`已重新定位到第 ${remaining + 1} 步`, 'ok');
          }
          return;
        }
        case 'resume-target-missing': {
          // 无法安全定位：保持 PAUSED，候选交给 App 弹「候选继续 / 从头重扫 / 停止」。
          emitResumeMissing(nodeId, c);
          if (typeof notify === 'function') {
            notify('无法定位剩余步骤；请选择候选继续、从头重扫或停止', 'warn');
          }
          return;
        }
        case 'position': {
          commit(nodeId, { ...cur, position: Number(c.position) || 0 });
          return;
        }
        case 'scan_complete': {
          // 权威最终计数：执行成功/失败 + 保留/提交失败（旧 SE 缺字段按 0）。
          const ok = countOf(c.normal_succeeded) + countOf(c.background_started);
          const retained = countOf(c.normal_retained);
          const commitFailed = countOf(c.commit_failed);
          const stalled = countOf(c.commit_stalled !== undefined ? c.commit_stalled : c.stalled);
          const fail =
            countOf(c.normal_failed) + countOf(c.background_failed) + commitFailed + retained;
          commit(nodeId, {
            ...cur,
            state: 'idle',
            position: 0,
            ok,
            fail,
            retained,
            commitFailed,
            stalled,
            // Completed scans have no live authority; clear the axis so a
            // later start cannot briefly show the previous scan's tier.
            authority: null,
            allowedAuthorities: [],
            canSetAuthority: false,
            switchingAuthority: false,
          });
          // reason 缺失（旧 SE）或 'eof' 视为正常完成；其余为中断，如实区分呈现。
          const REASON_LABELS = {
            stopped: '已停止',
            anchor_stale: '扫描锚失效',
            commit_stalled: '提交受阻（扫描已暂停）',
            error: '扫描错误',
            geometry_inconsistent: '内容几何不一致',
            'resume-target-missing': '无法定位剩余步骤',
            pause_dirty: '已暂停（有标记未提交）',
          };
          const reason = c.reason;
          if (typeof notify === 'function') {
            if (reason == null || reason === '' || reason === 'eof') {
              if (fail > 0) {
                notify(`扫描完成（有失败）: ${ok} ok, ${fail} fail`, 'warn');
              } else {
                notify(`扫描完成: ${ok} ok, ${fail} fail`, 'ok');
              }
            } else {
              const label = REASON_LABELS[reason] || String(reason);
              notify(`扫描中断（${label}）: ${ok} ok, ${fail} fail`, 'warn');
            }
          }
          return;
        }
        case 'anchor_stale': {
          // 不自动重扫：仅置 idle 并提示用户。
          commit(nodeId, { ...cur, state: 'idle', pausePhase: 'none', resumeMissing: null });
          if (typeof notify === 'function') notify('扫描锚失效，需重扫', 'warn');
          return;
        }
        case 'geometry_inconsistent': {
          // 内容几何与扫描锚不一致：SE 已停止扫描，仅置 idle 并提示用户重扫。
          commit(nodeId, { ...cur, state: 'idle', pausePhase: 'none', resumeMissing: null });
          if (typeof notify === 'function') notify('扫描内容几何不一致，已停止；请重新扫描', 'warn');
          return;
        }
        case 'marker_executed': {
          // 实时启发式：多标记批量有 result.count/succeeded/failed；否则单标记按 success。
          const r = c.result || {};
          if (typeof r.count === 'number') {
            commit(nodeId, {
              ...cur,
              ok: cur.ok + (Number(r.succeeded) || 0),
              fail: cur.fail + (Number(r.failed) || 0),
            });
          } else if (c.success) {
            commit(nodeId, { ...cur, ok: cur.ok + 1 });
          } else {
            commit(nodeId, { ...cur, fail: cur.fail + 1 });
          }
          return;
        }
        case 'marker_failed': {
          // 仅后台启动失败补计（前台失败已计入 marker_executed，避免重复计数）。
          if (c.reason === 'background 启动失败') commit(nodeId, { ...cur, fail: cur.fail + 1 });
          // 可执行提示（加法，2026-10-25）：如 stdin/EOF → 「传参或后台 keep_stdin」。
          if (c.hint && typeof notify === 'function') notify(String(c.hint), 'warn');
          return;
        }
        case 'error': {
          if (typeof notify === 'function') notify(`扫描错误：${c.message || c.error || '未知'}`, 'warn');
          return;
        }
        // marker_found / marker_skipped / marker_denied / scan_window：不参与计数。
        default:
          return;
      }
    },

    /**
     * 从 SE 侧 `scan.status` 对账权威态（重连 / 切回 tab）。
     * `scan.status` 只用于对账，完成后的最终计数以 `scan_complete` 为准。
     */
    async hydrate() {
      if (!active()) return;
      for (const n of nodesNow()) {
        const nodeId = n && n.id != null ? String(n.id) : '';
        const name = streamNameFromId(nodeId);
        if (!name) continue;
        let res;
        try {
          res = await call('scan.status', { stream_name: name });
        } catch (err) {
          continue; // best-effort：单流失败不影响其余对账
        }
        if (res && typeof res === 'object') {
          const retained = countOf(res.normal_retained !== undefined ? res.normal_retained : res.retained);
          const commitFailed = countOf(res.commit_failed !== undefined ? res.commit_failed : res.commitFailed);
          const stalled = countOf(res.commit_stalled !== undefined ? res.commit_stalled : res.stalled);
          store.set(nodeId, {
            state: res.state || 'idle',
            // 暂停相位（加法；旧 SE 缺键按 state 降级）。pausePhase 不持久化。
            pausePhase: phaseOf(res, res.state || 'idle'),
            resumeMissing: null,
            position: Number(res.position) || 0,
            ok: countOf(res.normal_succeeded) + countOf(res.background_started),
            fail:
              countOf(res.normal_failed) +
              countOf(res.background_failed) +
              commitFailed +
              retained,
            retained,
            commitFailed,
            stalled,
            // 权限轴：以 status 为唯一事实源，原样透传 allowed_authorities。
            authority: res.authority ?? null,
            allowedAuthorities: Array.isArray(res.allowed_authorities)
              ? res.allowed_authorities.slice()
              : [],
            canSetAuthority: !!res.can_set_authority,
            switchingAuthority: false,
          });
        }
      }
      applyAll();
    },

    /** 清空权威态（关闭 tab / 卸载）。不回写画布。 */
    reset() {
      store.clear();
    },

    /** 重投影后把权威态重新贴回节点（幂等）。 */
    reapply() {
      applyAll();
    },

    /**
     * 执行扫描操作。RPC 参数不带 `?` 后缀（由 hub 统一处理）。
     * @param {string} nodeId
     * @param {string} action
     * @param {any} [payload]
     */
    action(nodeId, action, payload) {
      const name = streamNameFromId(nodeId);
      // !name 覆盖 null（非 s-* 本地 pending）与 ''（'s-' 空名，理论不可达，防御收紧）。
      if (!name) {
        // 非 s-* 节点（本地 pending，离线创建）：只有 start 是用户可感知的“点了没反应”，
        // 补一条提示；pause/resume/stop/move/rescan 等保持静默（节点可能已删除，避免噪音）。
        if (action === 'start' && typeof notify === 'function') {
          notify('该节点未同步到 SE（待同步），无法扫描', 'warn');
        }
        return;
      }
      const cur = ensure(nodeId);
      const node = findNode(nodeId);
      const content = node && node.data ? String(node.data.content || '') : '';

      switch (action) {
        case 'start': {
          if (cur.state !== 'idle') return;
          if (!content.trim()) {
            if (typeof notify === 'function') notify('内容为空，无法扫描', 'warn');
            return;
          }
          // 权限：仅当显式传入非空字符串才附带 authority；缺省沿用服务端凭证 ceiling。
          const authority = typeof payload === 'string' ? payload : '';
          const params = { stream_name: name };
          if (authority) params.authority = authority;
          // 乐观：先置 scanning，再等 RPC（authority 轴保持服务端事实，不乐观改）。
          commit(nodeId, {
            ...cur,
            state: 'scanning',
            pausePhase: 'none',
            resumeMissing: null,
            position: 0,
            ok: 0,
            fail: 0,
            // A new scan has no authoritative tier until the server reports
            // one; never carry the previous scan's authority into the badge.
            authority: null,
            allowedAuthorities: [],
            canSetAuthority: false,
            switchingAuthority: false,
          });
          return settleScanFail(call('scan.start', params), nodeId, '开始扫描失败');
        }
        case 'pause': {
          // 乐观「pausing」（绝不提前宣称 paused）：后端 settle 后才转 paused。
          // 旧后端 `{state:"pausing"|"paused"}` 由 phaseOf 降级兼容。
          commit(nodeId, { ...cur, state: 'scanning', pausePhase: 'pausing' });
          const p = call('scan.pause', { stream_name: name });
          return p
            .then((res) => {
              if (res && res.success === false) {
                if (typeof notify === 'function') notify(`暂停失败：${errMessage(res.error)}`, 'warn');
                commit(nodeId, { ...ensure(nodeId), state: 'scanning', pausePhase: 'none' });
                return res;
              }
              const phase = phaseOf(res, 'paused');
              commit(nodeId, {
                ...ensure(nodeId),
                state: phase === 'paused' ? 'paused' : 'scanning',
                pausePhase: phase,
              });
              // The state event usually performs this refresh; also cover the
              // case where the pause response settles before the event arrives.
              if (phase === 'paused' && ensure(nodeId).allowedAuthorities.length === 0) {
                refreshStatus(nodeId, name, { onlyIfPaused: true });
              }
              return res;
            })
            .catch(notifyFail);
        }
        case 'resume': {
          // payload 为显式候选（head 绝对坐标）时透传 reanchor_to；否则自动重锚。
          const params = { stream_name: name };
          const target = payload == null || payload === '' ? NaN : Number(payload);
          if (Number.isFinite(target)) params.reanchor_to = target;
          commit(nodeId, {
            ...cur,
            state: 'scanning',
            pausePhase: 'none',
            resumeMissing: null,
          });
          return settleScanFail(call('scan.resume', params), nodeId, '恢复扫描失败');
        }
        case 'setauthority': {
          // 只在 settled PAUSED 且服务端授权可切换时发 RPC；不做本地权限矩阵计算。
          const authority = typeof payload === 'string' ? payload : '';
          if (!authority) {
            if (typeof notify === 'function') notify('切换扫描权限失败：未指定目标权限', 'warn');
            return;
          }
          const settledPaused =
            cur.state === 'paused' &&
            (cur.pausePhase == null || cur.pausePhase === 'none' || cur.pausePhase === 'paused');
          if (!settledPaused) {
            if (typeof notify === 'function') notify('仅暂停时可切换扫描权限', 'warn');
            return;
          }
          if (cur.canSetAuthority !== true) {
            if (typeof notify === 'function') notify('当前无权切换扫描权限', 'warn');
            return;
          }
          // 绝不乐观改 authority：仅置 in-flight 标记，最终值等响应/事件回填。
          commit(nodeId, { ...cur, switchingAuthority: true });
          const p = call('scan.set_authority', { stream_name: name, authority });
          return p.then(
            (res) => {
              if (res && res.success === false) {
                if (typeof notify === 'function') {
                  notify(`切换扫描权限失败：${errMessage(res.error)}`, 'warn');
                }
                commit(nodeId, { ...ensure(nodeId), switchingAuthority: false });
                return res;
              }
              const nextAuthority =
                res && res.authority !== undefined && res.authority !== null ? res.authority : authority;
              commit(nodeId, {
                ...ensure(nodeId),
                authority: nextAuthority,
                switchingAuthority: false,
              });
              return res;
            },
            (err) => {
              if (typeof notify === 'function') {
                notify(`切换扫描权限失败：${errMessage(err)}`, 'warn');
              }
              // 失败保持旧 authority，仅清除 in-flight 标记。
              commit(nodeId, { ...ensure(nodeId), switchingAuthority: false });
            }
          );
        }
        case 'stop': {
          const p = call('scan.stop', { stream_name: name });
          commit(nodeId, idleScan());
          return p.catch(notifyFail);
        }
        case 'setpos': {
          // offset 已是字符偏移，直接透传整数，不做任何缩放。
          const position = Number(payload) || 0;
          const p = call('scan.move', { stream_name: name, position });
          commit(nodeId, { ...cur, position });
          return p.catch(notifyFail);
        }
        case 'rescan': {
          if (!content.trim()) {
            if (typeof notify === 'function') notify('内容为空，无法扫描', 'warn');
            return;
          }
          commit(nodeId, {
            ...cur,
            state: 'scanning',
            pausePhase: 'none',
            resumeMissing: null,
            position: 0,
            ok: 0,
            fail: 0,
            // A new scan has no authoritative tier until the server reports
            // one; never carry the previous scan's authority into the badge.
            authority: null,
            allowedAuthorities: [],
            canSetAuthority: false,
            switchingAuthority: false,
          });
          return settleScanFail(call('scan.rescan', { stream_name: name, mode: 'start' }), nodeId, '重扫失败');
        }
        default:
          // 未知动作：no-op。
          return;
      }
    },
  };
}
