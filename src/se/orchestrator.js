// SE 编排器（D3 从 App.jsx 下沉）：连接生命周期 / 内容读取管线 / 重投影 / 变更分类订阅。
//
// 边界（Oracle 评审：ref 桥 + 窄端口，为 D4 状态层预留接缝）：
// - 本模块**私有持有全部 SE 域状态**（版本基线 / 同步基线 / tags 缓存 / console 尾部偏移 /
//   自写抑制 / 内部流标记 / 订阅与世代守卫 / reconcile 协调器 / 运行时 driver 装配）；
// - 一切 App/React 侧能力经 `port`（取端口函数的函数）注入，**调用时才解引用**——
//   绝不构造期快照 nodes/edges/tabs；D4 时仅需更换 port 实现（React state → store）；
// - 方向纪律：App → orchestrator 单向调用；编排器永不回调 App 的具名函数，只走 port 通道。
//
// 纯模块：无 React 依赖；ref 间接层（onSeConnectedRef 等）在此消失——普通闭包函数声明即可。

import { sePool, SE_STATUS } from './pool.js';
import { createSeRuntime } from './runtime.js';
import { createReconcileRunner } from './reconcile.js';
import { createProjectionQueue } from './projectionQueue.js';
import { createSessionStore } from './sessionState.js';
import { classifyStreamChange } from './classify.js';
import { planEnsure, planSpawnOutcome } from './ensurePolicy.js';
import {
  projectStreams,
  splitMissing,
  streamNodeId,
  streamNameFromId,
  tagsToFields,
  collectPushableContents,
  isSuspiciousEmptyProjection,
} from './streams.js';
import { deriveEdgesFromTags } from './edges.js';
import { sameSystemId } from './nameContract.js';
import { appearedInternalNames, baseStreamName } from './internalStreams.js';
import { isInternalStream } from './procAssoc.js';
import { canAutoCreateStream } from './recoveryPolicy.js';
import { docBaseOf } from '../tabDoc.js';
import { CONSOLE_TAIL_MAX_CHARS, TERM_BODY_MAX_LINES, PAGE_CHAR_BUDGET } from './terminalCaps.js';
import { clearHistoryForNode, clearPage, deleteHistoryPage } from '../pageState.js';
import { carryNodeMeasurements, carryNodeSelection } from '../graph.js';
import { silentRefillFromManifest, planImport, applyImport } from './packageImport.js';
import { buildToolsOnlyManifest, buildStreamsOnlyManifest } from './manifest.js';
import { diffCodePoints } from './textDiff.js';

/** system_id　name 复合键（version/synced/consoleTail 缓存的键形）。 */
const seKey = (systemId, name) => `${String(systemId)} ${String(name)}`;

/** 扫描活动态（导入/撤销等非局部写必须让路）。 */
const SCAN_ACTIVE_STATES = new Set(['scanning', 'paused', 'pausing']);

/** 等待 SEClient 进入 online；超时则 reject。App 的懒加载迁移路径亦复用。 */
export function waitForClientOnline(client, timeout = 12000) {
  if (client.status === SE_STATUS.ONLINE) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (typeof off === 'function') off();
      reject(new Error('connect timeout'));
    }, timeout);
    const off = client.onStatus((st) => {
      if (st === SE_STATUS.ONLINE) {
        clearTimeout(timer);
        if (typeof off === 'function') off();
        resolve(true);
      }
    });
  });
}

/**
 * 关标签页 = 关对应 SE：显式终止本 vite 拉起的该系统（POST /api/se/end）。
 * 服务端按归属判定——仅杀己方 spawn 的进程；用户手动起 / 从未 spawn 的系统返回
 * 返回 Promise<{ok,killed,code?,reason?}|null>：服务端完成身份验证与终止后返回；
 * 超时/断网返回 null。前端必须保留标签并允许重试，不能把 null 当成功。
 */
const SE_END_ABORT_MS = 30000;

async function endSeSystem(systemId) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SE_END_ABORT_MS);
  try {
    const res = await fetch('/api/se/end', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system_id: String(systemId) }),
      signal: ac.signal,
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 创建 SE 编排器。
 * @param {() => object} getPort 取端口（每次调用解引用，读到 App 最新闭包）。
 */
export function createSeOrchestrator(getPort) {
  const port = () => getPort();

  // ── 私有状态（原 App.jsx 的 SE 域 ref 群）────────────────────────────────
  //
  // 关系统即失效的状态全部归 per-SID session 所有（见 sessionState.js）：版本/同步基线、
  // console 偏移、自写抑制、tags/internalMark、删除 tombstone、缺失修复账本、状态历史、
  // 离线暂存上推、投影世代、读取调度、订阅标记。确认最终关闭 → 整个 session 丢弃；
  // 失败关闭/共享 SID → 原样保留。以下只保留**全局生命周期**状态。
  const sessions = createSessionStore();
  /**
   * 常规操作访问：只读**已存在**的会话，绝不创建。确认最终关闭后，迟到的公开
   * 读写（baselineSet / markSelfWrite / noteCasResolved / pending push …）必须
   * no-op——否则空会话会被悄悄种回所有权表，污染未来同 SID 的重开会话。
   */
  const sessionOf = (sid) => sessions.peek(sid);
  /** 跨 await 身份守卫：sid 仍映射到捕获时的会话才允许继续。 */
  const sessionAlive = (sid, session) => sessions.owns(sid, session);

  const seEnding = new Map(); // sid → 关闭进行中的 endSeSystem Promise
  const seEpoch = new Map(); // sid → 世代号；关闭时 +1，使在途握手作废
  // 确认最终关闭时的 tab 所有者快照。预连接水合（pendingPush）只能在同一批
  // 所有者上创建会话；关闭后旧所有者的迟到调用不得复活，新 tab 绑定才算重开。
  const closedOwners = new Map(); // sid → Set<tabId>
  /**
   * 关闭后是否出现了关闭快照之外的新 tab 所有者。仅旧 tab 仍存活不算重开；
   * 新所有者出现后消费关闭快照，后续生命周期入口恢复正常。
   */
  const hasReopenedOwner = (sid) => {
    const key = String(sid);
    const closed = closedOwners.get(key);
    if (!closed) return true;
    const ownersNow = port()
      .getTabs()
      .filter((t) => t.system?.system_id === key)
      .map((t) => String(t.id));
    if (!ownersNow.some((id) => !closed.has(id))) return false;
    closedOwners.delete(key);
    return true;
  };
  const ensureInflight = new Map(); // 同 system_id 的 ensure 并发闸门
  // 每 sid 一条投影串行链：事件协调器只负责合并，直连 reproject 也必须排队，
  // 保证「后发起的写后校验」一定看到写后投影（见 projectionQueue.js）。
  const projectionQueue = createProjectionQueue();
  // rename / 显式删除成功后 bump：已拿到旧 stream.list 的在飞投影会在落地前发现
  // 世代变化（或会话已换）并放弃 setNodes，避免“旧列表把新节点删掉”的竞态。
  const bumpProjectionEpoch = (systemId) => {
    const session = sessionOf(systemId);
    if (session) session.projectionEpoch += 1;
  };

  // 期 14（方案 D2）：对账协调器——单飞 + 前缘/尾缘合并（reconcile.js 纯逻辑）。
  const coordinator = createReconcileRunner({
    run: (sid) => reproject(sid),
    isActive: (sid) => port().getActiveSystemId() === String(sid),
  });

  // 期 6-8：SE 运行时惰性装配一次。isActive(sid) = 该 sid 为当前活动系统且非离线；
  // 工具驱动为纯 RPC + 状态回报（Oracle Q1），经 port.onToolStatus 按 sid 上报注册名集合，不写配置。
  const runtime = createSeRuntime({
    getNodes: () => port().getNodes(),
    setNodes: (...args) => port().setNodes(...args),
    notify: (...args) => port().notify(...args),
    isActive: (sid) => port().getActiveSystemId() === String(sid) && !port().isOffline(),
    onToolStatus: (...args) => port().onToolStatus(...args),
    // 重锚失败（resume-target-missing）→ App 弹「候选继续 / 从头重扫 / 停止」。
    onResumeTargetMissing: (...args) => {
      const p = port();
      if (p && typeof p.onResumeTargetMissing === 'function') p.onResumeTargetMissing(...args);
    },
  });

  // ── 世代 / 归属守卫 ──────────────────────────────────────────────────────
  /** sid 当前世代号（无记录视为 0）。 */
  const epochOf = (sid) => Number(seEpoch.get(String(sid))) || 0;
  /** 世代守卫：在途流程捕获的 epoch 仍等于当前世代才允许继续。 */
  const epochAlive = (sid, epoch) => epochOf(sid) === epoch;
  /** 该 sid 此刻是否仍有 tab 绑定（读 tabs；不以 client 活性为依据，避免 sePool.get 懒建复活）。 */
  const ownedNow = (sid) => port().getTabs().some((t) => t.system?.system_id === String(sid));

  /**
   * 显式生命周期创建（onConnected / subscribeStatuses）：重开 SID 的唯一入口。
   * 关闭进行中不创建（避免迟到握手在 drop 之后复活）；成功重开会清掉关闭快照。
   */
  const ensureLifecycleSession = (sid) => {
    const key = String(sid);
    const existing = sessions.peek(key);
    if (existing) {
      closedOwners.delete(key);
      return existing;
    }
    if (seEnding.has(key)) return null;
    if (!hasReopenedOwner(key)) return null;
    return sessions.ensure(key);
  };

  /**
   * 预连接水合创建缝（pendingPush 等）：会话不存在时，只有出现**关闭快照之外**
   * 的新 tab 所有者（即真正重开）才允许创建；确认最终关闭后的旧所有者迟到调用
   * 一律 no-op，绝不复活或种入未来会话。
   */
  const sessionForHydration = (sid) => {
    const key = String(sid);
    const existing = sessions.peek(key);
    if (existing) return existing;
    if (!hasReopenedOwner(key)) return null;
    return sessions.ensure(key);
  };

  /** 该流当前是否处于扫描活动态（导入/整篇覆盖必须让路）。 */
  const isScanActiveName = (name) => {
    const nodeId = streamNodeId(name);
    const node = port().getNodes().find((n) => String(n.id) === nodeId);
    return !!node && SCAN_ACTIVE_STATES.has(node.data?.scan?.state);
  };

  // ── 自写抑制（期 14 方案 D3/D6）──────────────────────────────────────────
  const markSelfWrite = (sid, name, sessionArg) => {
    const session = sessionArg || sessionOf(sid);
    if (!session) return;
    session.selfWrite.set(seKey(sid, name), Date.now() + 2000);
  };
  const isSelfWrite = (sid, name, sessionArg) => {
    const session = sessionArg || sessionOf(sid);
    if (!session) return false;
    const exp = session.selfWrite.get(seKey(sid, name));
    return exp != null && Date.now() <= exp;
  };

  /** 期 14（方案 D5/D6）：内部流首次出现时本地注入 canvas:false 并异步持久化（在飞去重）。 */
  const persistInternalTag = (sid, name, sessionArg) => {
    const session = sessionArg || sessionOf(sid);
    if (!session) return;
    if (session.internalMarking.has(name)) return;
    const client = sePool.get(String(sid));
    if (client.status !== SE_STATUS.ONLINE) return;
    session.internalMarking.add(name);
    markSelfWrite(sid, name, session);
    client
      .call('stream.set_tag', { name, key: 'canvas', value: 'false' })
      .catch(() => {})
      .finally(() => {
        session.internalMarking.delete(name);
      });
  };

  /* ── 删除意图 tombstone / 缺失修复（根治「其他流消失」的核心状态）─────────
   *
   * 纪律：`stream.list` 缺一条**不等于**删除。只有显式删除（本 client 的删除
   * 按钮成功、或非自写的 lifecycle deleted）才登记 tombstone；投影只允许移除
   * tombstone 里的名字。其余缺失一律保留节点/布局，并按文档差集重建（create）。
   */

  /** 该会话已确认可移除的流名集合（只读视图）。 */
  const tombstoneSet = (session) => new Set(session.deletedTombstones.keys());

  const noteDeleted = (sid, name, cause = 'user') => {
    const n = String(name == null ? '' : name);
    if (!n) return;
    const key = String(sid);
    const session = sessionOf(key);
    if (!session) return;
    session.deletedTombstones.set(n, { at: Date.now(), cause });
    // 显式删除是结构真源变更：作废旧列表投影，避免在飞投影把已删流复活。
    session.projectionEpoch += 1;
  };

  const clearDeleted = (sid, name) => {
    const session = sessionOf(sid);
    if (session) session.deletedTombstones.delete(String(name));
  };

  const hasUnconfirmedMissing = (sid) => {
    const session = sessionOf(sid);
    return !!session && session.unconfirmedMissing.size > 0;
  };

  /** 该 sid 所属 tab 的文档流元数据：name → {source, docBase}（用于差集修复的归属判定）。 */
  const getDocumentStreamMeta = (sid) => {
    const key = String(sid);
    const owner = port().getTabs().find((t) => t.system?.system_id === key);
    const g = owner ? port().getStoreGraph(owner.id) : null;
    const docBase = owner ? docBaseOf(owner) : '';
    const out = new Map();
    (Array.isArray(g?.nodes) ? g.nodes : []).forEach((n) => {
      const name = streamNameFromId(n && n.id);
      if (!name) return;
      const source = n && n.data && n.data.source ? n.data.source.file_path : '';
      out.set(name, { source: String(source == null ? '' : source), docBase });
    });
    return out;
  };

  /** 该 sid 所属 tab 的文档节点里出现的流名（用于差集修复：只重建文档拥有的流）。 */
  const getDocumentStreamNames = (sid) => new Set(getDocumentStreamMeta(sid).keys());

  /**
   * 文档有、SE list 缺失 → 只 `stream.create`（绝不写正文，避免空覆盖）。
   * 失败按名字冷却 10s，防每轮重投影都重试；create 前 markSelfWrite 抑制回声。
   */
  async function repairRegistryFromDocument(sid, names, sessionArg) {
    const key = String(sid);
    const session = sessionArg || sessionOf(key);
    if (!sessionAlive(key, session)) return;
    const client = sePool.get(key);
    if (!client || client.status !== SE_STATUS.ONLINE) return;
    const docMeta = getDocumentStreamMeta(key);
    const now = Date.now();
    const inflight = session.repairing;
    const todo = (Array.isArray(names) ? names : []).filter((name) => {
      const n = String(name == null ? '' : name);
      if (!n) return false;
      const info = docMeta.get(n);
      if (!info) return false;
      // 保留后缀（SE 公共 create 必拒）与跨图谱 source 一律不自动建流。
      if (!canAutoCreateStream(n, info.source, info.docBase)) return false;
      if (isScanActiveName(n)) return false;
      if ((session.repairCooldown.get(n) || 0) > now) return false;
      return !inflight.has(n);
    });
    if (!todo.length) return;
    todo.forEach((n) => inflight.add(String(n)));
    try {
      for (const name of todo) {
        if (client.status !== SE_STATUS.ONLINE) break;
        if (!sessionAlive(key, session)) return;
        markSelfWrite(key, name, session);
        try {
          await client.call('stream.create', { name });
        } catch (err) {
          // already-exists（列表瞬时遗漏）/ 名称非法 / 其他：不阻断，冷却后再试。
          session.repairCooldown.set(String(name), Date.now() + 10000);
        }
      }
    } finally {
      todo.forEach((n) => inflight.delete(String(n)));
    }
    if (!sessionAlive(key, session)) return;
    // 创建/已存在都值得再对账一次；keepMissing 保证期间不误删。
    coordinator.invalidate(key, 'registry-repair');
  }

  const scheduleRegistryRepair = (sid, names) => {
    const list = (Array.isArray(names) ? names : []).filter((n) => n != null && n !== '');
    if (!list.length) return;
    const session = sessionOf(sid);
    if (!session) return;
    setTimeout(() => {
      void repairRegistryFromDocument(sid, list, session).catch(() => {});
    }, 0);
  };

  // ── 期 14（方案 D4/B2 · 派生通道）：console 正文派生父节点 data.termBody ─────
  const applyConsoleDerivation = (systemId, consoleName) => {
    if (port().getActiveSystemId() !== String(systemId)) return;
    const cname = String(consoleName == null ? '' : consoleName);
    const base = baseStreamName(cname);
    if (!base) return;
    const consoleId = streamNodeId(cname);
    const baseId = streamNodeId(base);
    port().setNodes((nds) => {
      const list = Array.isArray(nds) ? nds : [];
      const consoleNode = list.find((n) => String(n.id) === consoleId);
      const raw =
        consoleNode && consoleNode.data && consoleNode.data.content != null
          ? String(consoleNode.data.content)
          : '';
      let parts = raw ? raw.split(/\r?\n/) : [];
      if (parts.length && parts[parts.length - 1] === '') parts.pop();
      // 期 14 加固：termBody 行数硬上限（只保留最近 N 行），避免正文无限增长时
      // 一次性构建超大数组并在终端逐行渲染，冻结主线程。
      const truncated = parts.length > TERM_BODY_MAX_LINES;
      if (truncated) parts = parts.slice(parts.length - TERM_BODY_MAX_LINES);
      const termBody = parts.map((line) => ({
        kind: line.startsWith('[stderr]') ? 'error' : 'system',
        text: line,
      }));
      if (truncated) {
        termBody.unshift({ kind: 'system', text: `… truncated …（仅显示最近 ${TERM_BODY_MAX_LINES} 行）` });
      }
      return list.map((n) => {
        if (String(n.id) !== baseId) return n;
        const data = { ...n.data };
        if (termBody.length) data.termBody = termBody;
        else delete data.termBody;
        return { ...n, data };
      });
    });
  };

  /**
   * 读取因 tab/系统切换被丢弃时，撤销仍自称 authoritative 的陈旧基线，使 reactivation
   * 的 reproject 能通过 contentCatchup 重新读回。只在基线版本确实落后于当前待追赶版本
   *（存在待追赶信号）时撤销——绝不推进版本/文本，避免 inactive 基线推进。
   */
  const revokeStaleAuthority = (session, key) => {
    const synced = session.synced.get(key);
    const pendingVersion = session.version.get(key);
    if (
      synced &&
      synced.authoritative === true &&
      pendingVersion !== undefined &&
      Number(pendingVersion) !== Number(synced.version)
    ) {
      session.synced.set(key, { ...synced, authoritative: false, source: 'stale' });
    }
  };

  const isFileProvenance = (record) =>
    !!record && (record.source === 'file-hydrated' || record.source === 'file-preserved');
  const sameVersion = (a, b) =>
    a === b || (a != null && b != null && Number.isFinite(Number(a)) && Number(a) === Number(b));

  /**
   * 读取单个 SE 流的最新内容与元数据（聚焦/进画布/编辑前），刷新节点内容 + version 基线。
   * 正在编辑的节点跳过（避免打乱光标）；本地节点（n-*）与离线态直接 no-op。
   * 事件入口 runContentRead 持有该 key 的 session.reading；直接读取可并发，冷启动
   * provenance / version 守卫负责淘汰迟到回包。
   */
  const readContent = async (nodeId, systemIdOverride) => {
    const name = streamNameFromId(nodeId);
    if (!name) return;
    const sid = systemIdOverride || port().getActiveSystemId();
    if (!sid) return;
    if (port().getEditingNodeId() === nodeId) return;
    if (port().isOffline()) return;
    // B2：并发竞态守卫——回包时校验仍是同一 tab / 同一系统，否则不得改写别的画布节点。
    const pendingTabId = port().getActiveTabId();
    // 系统已随 tab 关闭：绝不取 client（sePool.get 会懒建复活连接）。
    if (!ownedNow(sid)) return;
    const session = sessionOf(sid);
    if (!session) return;
    const key = seKey(sid, name);
    const syncedAtStart = session.synced.get(key);
    const fileProvenance = isFileProvenance(syncedAtStart) ? syncedAtStart : null;
    const versionAtStart = session.version.get(key);
    const nodeAtStart = port().getNodes().find((n) => String(n.id) === nodeId);
    const nodeTextAtStart =
      nodeAtStart && nodeAtStart.data && nodeAtStart.data.content != null
        ? String(nodeAtStart.data.content)
        : '';
    const nodeStateAtStart = nodeAtStart && nodeAtStart.data ? nodeAtStart.data.contentState : undefined;
    const sourceAtStart =
      nodeAtStart && nodeAtStart.data && nodeAtStart.data.source
        ? String(nodeAtStart.data.source.file_path || '')
        : '';
    const client = sePool.get(String(sid));
    if (client.status !== SE_STATUS.ONLINE) return;
    try {
      let read;
      let meta;
      let snapshotBeforeVersion;
      if (fileProvenance) {
        const before = await client.call('stream.get_metadata', { name });
        const beforeNumber = before && before.version != null ? Number(before.version) : undefined;
        snapshotBeforeVersion = Number.isFinite(beforeNumber) ? beforeNumber : undefined;
        read = await client.call('stream.read', { name });
        meta = await client.call('stream.get_metadata', { name });
      } else {
        [read, meta] = await Promise.all([
          client.call('stream.read', { name }),
          client.call('stream.get_metadata', { name }),
        ]);
      }
      // 等待回包期间会话可能已关闭/重开：旧会话的迟到回包绝不落地到新会话。
      if (!sessionAlive(sid, session)) return;
      // Tier-1 读完整性判别：只有回包明确携带 text 字段才算「确认读成功」（含确认空）。
      // 畸形/缺字段回包按读取失败处理——绝不用它清画布内容（否则「loaded+空」会被
      // 自动保存写成 0 字节正文文件，再经 pushFileStreams 回推 SE，造成实丢）。
      if (!read || typeof read !== 'object' || !Object.prototype.hasOwnProperty.call(read, 'text')) return;
      const text = read.text != null ? String(read.text) : '';
      const version = meta && meta.version != null ? Number(meta.version) : undefined;
      const readVersion = Number.isFinite(version) ? version : undefined;
      // 等待回包期间用户可能已进入编辑：绝不覆盖编辑器/node/同步基线。
      if (port().getEditingNodeId() === nodeId) {
        session.stale.add(key);
        return;
      }
      // 期 14 加固：内部流（_console/_scan_log）本地只保留滚动尾部——全文累加 + 渲染会冻结
      // 主线程；同时记录服务端绝对偏移，供增量 append 的 start 定位（截尾后 length 不再是
      // 绝对偏移）。普通代理流 content 语义不变（仍存全文）。
      const internal = isInternalStream(name);
      const shown =
        internal && text.length > CONSOLE_TAIL_MAX_CHARS
          ? text.slice(text.length - CONSOLE_TAIL_MAX_CHARS)
          : text;
      // 期 15：内部流本地 content 为尾部窗口，记录其在服务端的绝对字符区间（分页真源）。
      const nextAbsStart = text.length - shown.length;
      // 非活动 tab 不落地节点，也不得单独推进正文/版本基线；否则稍后切回时，
      // 陈旧节点文本会被误判为已同步，版本未再变化便失去最后一次读回机会。
      if (port().getActiveSystemId() !== String(sid) || port().getActiveTabId() !== pendingTabId) {
        // 正文事件会在防抖等待期间先推进版本（handleSeStreamChange），而本次成功
        // 回包可能因用户切走而被丢弃。若旧基线仍自称 authoritative，切回后的 reproject
        // 会因「版本相等 + 权威 seed」跳过读回，永久保留旧文本 → 撤销其权威性。
        if (!fileProvenance) revokeStaleAuthority(session, key);
        return;
      }
      if (fileProvenance) {
        const liveFileGuard = (requireStableVersion) => {
          if (!sessionAlive(sid, session)) return false;
          if (session.synced.get(key) !== fileProvenance) return false;
          if (port().getActiveSystemId() !== String(sid) || port().getActiveTabId() !== pendingTabId) return false;
          if (port().getEditingNodeId() === nodeId) return false;
          const currentVersion = session.version.get(key);
          const projectionSeededVersion =
            fileProvenance.source === 'file-hydrated' &&
            versionAtStart === undefined &&
            sameVersion(currentVersion, readVersion);
          if (
            requireStableVersion &&
            !sameVersion(currentVersion, versionAtStart) &&
            !projectionSeededVersion
          ) {
            return false;
          }
          const live = port().getNodes().find((n) => String(n.id) === nodeId);
          if (!live || !live.data) return false;
          const liveText = live.data.content != null ? String(live.data.content) : '';
          const liveSource = live.data.source ? String(live.data.source.file_path || '') : '';
          return (
            liveText === nodeTextAtStart &&
            live.data.contentState === nodeStateAtStart &&
            liveSource === sourceAtStart
          );
        };
        const publishPreserved = (preservedVersion) => {
          if (!liveFileGuard(true)) return false;
          if (preservedVersion !== undefined) session.version.set(key, preservedVersion);
          if (internal) session.consoleTailOffset.set(key, text.length);
          session.synced.set(key, {
            version: preservedVersion,
            text,
            authoritative: !internal,
            source: 'file-preserved',
          });
          return true;
        };
        const stableSnapshot =
          snapshotBeforeVersion !== undefined &&
          readVersion !== undefined &&
          sameVersion(snapshotBeforeVersion, readVersion);
        const unversionedSnapshot = snapshotBeforeVersion === undefined && readVersion === undefined;
        const pendingBaseline =
          fileProvenance.source === 'file-preserved' && fileProvenance.version === undefined;
        const preservePendingBaseline = async () => {
          if (!liveFileGuard(false)) return;
          if (!pendingBaseline) {
            session.synced.set(key, {
              version: undefined,
              text: nodeTextAtStart,
              authoritative: false,
              source: 'file-preserved',
            });
          }
          if (pendingBaseline || session.reading.has(key)) return;
          await readContent(nodeId, sid);
        };
        if (!stableSnapshot && !unversionedSnapshot) {
          await preservePendingBaseline();
          return;
        }
        const changedPreservedVersion =
          fileProvenance.source === 'file-preserved' &&
          fileProvenance.version !== undefined &&
          readVersion !== undefined &&
          !sameVersion(fileProvenance.version, readVersion);
        if (!changedPreservedVersion) {
          if (!liveFileGuard(true)) return;
          if (fileProvenance.source === 'file-preserved') {
            if (readVersion === undefined) return;
            publishPreserved(readVersion);
            return;
          }

          const fileText = fileProvenance.text != null ? String(fileProvenance.text) : '';
          const live = port().getNodes().find((n) => String(n.id) === nodeId);
          const owner = port().getTabs().find((t) => t.system?.system_id === String(sid));
          const docBase = owner ? docBaseOf(owner) : '';
          const sourcePath = live && live.data && live.data.source ? live.data.source.file_path : '';
          const loaded = live && live.data && live.data.contentState === 'loaded';
          const excluded =
            internal ||
            !loaded ||
            isScanActiveName(name) ||
            !canAutoCreateStream(name, sourcePath, docBase) ||
            session.unconfirmedMissing.has(name);
          if (readVersion === undefined) {
            publishPreserved(undefined);
            return;
          }
          if (excluded) {
            publishPreserved(readVersion);
            return;
          }
          if (!live || String(live.data.content == null ? '' : live.data.content) !== fileText) return;
          if (fileText === text) {
            if (!liveFileGuard(true)) return;
            session.version.set(key, readVersion);
            session.synced.set(key, {
              version: readVersion,
              text,
              authoritative: true,
              source: 'read',
            });
            return;
          }

          if (!liveFileGuard(true)) return;
          markSelfWrite(sid, name, session);
          let written;
          try {
            written = await client.call('stream.write', {
              name,
              text: fileText,
              expected_version: readVersion,
            });
          } catch (err) {
            if (err && err.code === -32010) await preservePendingBaseline();
            return;
          }
          const returnedVersion = written && written.version != null ? Number(written.version) : undefined;
          const writeVersion = Number.isFinite(returnedVersion) ? returnedVersion : undefined;
          if (writeVersion === undefined || !sessionAlive(sid, session)) return;
          if (port().getEditingNodeId() === nodeId) {
            session.stale.add(key);
            return;
          }
          if (!liveFileGuard(true)) return;
          const current = port().getNodes().find((n) => String(n.id) === nodeId);
          if (
            !current ||
            current.data?.contentState !== 'loaded' ||
            String(current.data.content == null ? '' : current.data.content) !== fileText
          ) {
            return;
          }
          session.version.set(key, writeVersion);
          session.synced.set(key, {
            version: writeVersion,
            text: fileText,
            authoritative: true,
            source: 'commit',
          });
          return;
        }

        const currentVersion = session.version.get(key);
        if (!sameVersion(currentVersion, versionAtStart) && !sameVersion(currentVersion, readVersion)) return;
        if (!liveFileGuard(false)) return;
        // file-preserved 只在 SE 版本确实前进后交还既有正常读回语义。
      }
      if (session.reading.has(key) && !sameVersion(session.version.get(key), versionAtStart)) return;
      if (internal) session.consoleTailOffset.set(key, text.length);
      if (version !== undefined) session.version.set(key, version);
      session.synced.set(key, {
        version,
        text: shown,
        authoritative: !internal,
        source: internal ? 'internal' : 'read',
      });
      if (internal) {
        const prevNode = port().getNodes().find((n) => String(n.id) === nodeId);
        const prevWin = prevNode && prevNode.data ? prevNode.data.contentWindow : null;
        // 期 15：维护历史页缓存有效性（按窗口绝对起点变化）。
        if (prevWin && Number.isFinite(Number(prevWin.absStart))) {
          const prevAbs = Number(prevWin.absStart);
          if (nextAbsStart < prevAbs) {
            // 服务端内容回退（append-only 不变量被破坏）→ 全量失效；首次加载（无旧窗口）不清。
            clearHistoryForNode(pendingTabId, nodeId);
            clearPage(pendingTabId, nodeId);
          } else if (nextAbsStart > prevAbs) {
            // 期 15（B3）：窗口前移，[prevAbs, nextAbsStart) 并入边界历史页；该页此前若已缓存
            // 则内容不全，失效之（整除时指向未缓存索引，deleteHistoryPage 为无害 no-op）。
            deleteHistoryPage(pendingTabId, nodeId, Math.floor(prevAbs / PAGE_CHAR_BUDGET));
          }
        }
      }
      port().setNodes((nds) =>
        nds.map((n) => {
          if (String(n.id) !== nodeId) return n;
          const data = { ...n.data };
          if (shown) data.content = shown;
          else delete data.content;
          // Tier-1：确认读成功（含确认空）→ 显式标记 loaded，语义不再依赖 prevData 残留。
          data.contentState = 'loaded';
          if (internal) data.contentWindow = { absStart: nextAbsStart, absEnd: text.length };
          else delete data.contentWindow;
          if (meta) {
            // v3：SE name 即显示名（不再读 title）。
            data.name = name;
            if (meta.description) data.description = String(meta.description);
            else delete data.description;
            // 期 4：canvas 与普通标签同源（tagsToFields 已含 canvas）；SE 为唯一真源。
            const fields = tagsToFields(meta.tags);
            if (fields.length) data.fields = fields;
            else delete data.fields;
          }
          return { ...n, data };
        })
      );
    } catch (err) {
      // 流被外部删除（-32002）等：留给下一次重投影移除，不打断当前视图。
      return;
    }
    if (name.endsWith('_console')) applyConsoleDerivation(sid, name);
  };

  /** 全量重投影（SE stream.list → 画布节点 + 派生边）。失败/离线返回 false。 */
  const reprojectImpl = async (systemId) => {
    const sid = String(systemId);
    // 投影是操作而非生命周期：确认关闭后（会话已丢弃）迟到投影一律 no-op，
    // 绝不通过 sePool.get 顺手复活 client，也绝不重建会话。
    const session = sessionOf(sid);
    if (!session) return false;
    const epochAtStart = session.projectionEpoch;
    const client = sePool.get(sid);
    // 新增：等待 tab 就绪（确保 layoutRef 已初始化）
    if (port().isTabReady && !port().isTabReady()) {
      console.warn(`Tab 未就绪，跳过重投影（sid: ${sid}）`);
      // 不丢弃这次真源变化：App 在 tab ready 后会补一次 reproject。
      coordinator.markDirty(sid, 'tab-not-ready');
      return false;
    }
    // R2：重投影失败即清除本系统的悬空边状态，防陈旧「发现 N 条悬空边」横幅残留。
    const clearDanglingIfActive = () => {
      if (port().getActiveSystemId() === sid) port().setDangling([]);
    };
    if (client.status !== SE_STATUS.ONLINE) {
      clearDanglingIfActive();
      return false;
    }
    let list;
    try {
      list = await client.call('stream.list', {});
    } catch (err) {
      clearDanglingIfActive();
      return false;
    }
    // 关系统/重开可能发生在 list 往返期间：旧会话结果一律不落地。
    if (!sessionAlive(sid, session)) return false;
    // 期 14（方案 D4/§P0）：内部流是普通流——不再从投影剔除；可见性由下方本地 canvas:false 保证。
    let rows = Array.isArray(list) ? list : [];
    // FIX-2：切 tab / 级联发生在后台时，仍计算真实投影并返回；但绝不 mutate 活动画布。
    const isActive = port().getActiveSystemId() === sid;
    // B4 守卫：SE 返回空列表但画布仍有 s-* 投影节点——若这些缺失**未被显式确认删除**，
    // 绝不投影空结构。短暂等待后重取一次；仍为空则保留画布、标记待对账并按文档重建。
    if (isActive && isSuspiciousEmptyProjection(rows, port().getNodes())) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      try {
        const retried = await client.call('stream.list', {});
        rows = Array.isArray(retried) ? retried : [];
      } catch (err) {
        rows = []; // 重取失败按仍空处理
      }
      if (!sessionAlive(sid, session)) return false;
      const prevNow = port().getNodes();
      const splitNow = splitMissing(prevNow, rows, tombstoneSet(session));
      if (isSuspiciousEmptyProjection(rows, prevNow) && splitNow.unexpectedIds.length > 0) {
        port().notify('SE 返回空流列表，已保留当前画布（疑似系统重启），将自动对账恢复', 'warn');
        coordinator.markDirty(sid, 'empty-list');
        scheduleRegistryRepair(sid, splitNow.unexpectedNames);
        return false;
      }
    }
    // 期 5：缓存原始 tags（含 edge.*），供流面板搜索命中边键/目标名。
    const tagMap = new Map();
    rows.forEach((s) => {
      if (s && s.name != null && s.name !== '') {
        tagMap.set(String(s.name), s.tags && typeof s.tags === 'object' ? s.tags : {});
      }
    });
    // prev / 落点只对活动系统有意义：非活动用空前态（结果仅作校验，不落地）。
    const prev = isActive ? port().getNodes() : [];
    // 缺失 ≠ 删除：只有 tombstone（显式删除意图）能移除；其余缺失保留并按文档差集重建。
    const confirmed = tombstoneSet(session);
    const split = splitMissing(prev, rows, confirmed);
    if (isActive) {
      if (split.unexpectedNames.length) {
        session.unconfirmedMissing = new Set(split.unexpectedNames);
        const sig = split.unexpectedNames.slice().sort().join('\u0001');
        const prevNotice = session.missingNotice;
        if (!prevNotice || prevNotice.sig !== sig || Date.now() - prevNotice.at > 30000) {
          session.missingNotice = { sig, at: Date.now() };
          port().notify(
            `SE 列表缺少 ${split.unexpectedNames.length} 个未确认删除的流，已保留画布并尝试修复`,
            'warn'
          );
        }
        coordinator.markDirty(sid, 'unconfirmed-missing');
        scheduleRegistryRepair(sid, split.unexpectedNames);
      } else {
        session.unconfirmedMissing.clear();
      }
    }
    const center = isActive ? port().screenToFlowCenter() : { x: 100, y: 100 };
    // 常驻布局表（system.graph.layout，App 侧持久化、永不消费）：重投影时读取，新流按记录
    // 落点/尺寸。getLayout 可能不存在（旧测试桩）→ 可选调用保护，缺失时回退中心网格落点。
    const layout = port().getLayout ? port().getLayout(sid) : null;
    const {
      nodes: proj,
      removedIds,
      versions,
      keptMissingIds,
    } = projectStreams(rows, prev, {
      center,
      layout,
      confirmedRemoved: confirmed,
      keepMissing: true,
    });
    if (split.unexpectedIds.length) {
      console.warn('[se/reproject] 未确认缺失（已保留）', {
        sid,
        prev: prev.length,
        rows: rows.length,
        missing: split.missingNames,
        confirmed: split.confirmedNames,
        unexpected: split.unexpectedNames,
      });
    }
    // 期 14（方案 D5/D6）：内部流首次出现时本地注入 canvas:false 并异步持久化；
    // 用户取消隐藏者（移出 internalMark）不再反打。仅活动系统写标签。
    const prevIds = new Set(prev.map((n) => String(n.id)));
    if (isActive) {
      appearedInternalNames(rows, prevIds).forEach(({ name }) => {
        session.internalMark.add(name);
        persistInternalTag(sid, name, session);
      });
      proj.forEach((p) => {
        const name = streamNameFromId(p.id);
        if (!name || !session.internalMark.has(name)) return;
        const fields = Array.isArray(p.data.fields) ? p.data.fields : [];
        if (!fields.some((f) => f && f.key === 'canvas' && String(f.value) === 'false')) {
          p.data.fields = [...fields, { key: 'canvas', value: 'false' }];
        }
      });
    }
    // ── 期 5：边 = 流标签派生 ──────────────────────────────────────────────
    // 一次 stream.list 同时喂 projectStreams 与 deriveEdgesFromTags（避免二次遍历）。
    // 两端均 s-* 的边 = 派生边（SE 真源）；含 n-* 端点的边 = 本地边保留（派生不覆盖）。
    const { edges: rawEdges, dangling } = deriveEdgesFromTags(rows);
    const derivedEdges = rawEdges.map((e) => ({
      id: e.id,
      type: 'agent',
      source: streamNodeId(e.source),
      target: streamNodeId(e.target),
      ...(e.label ? { label: e.label } : {}),
      data: { state: 'se' },
    }));
    const locals = isActive ? prev.filter((n) => !String(n.id).startsWith('s-')) : [];
    const canvas = port().toCanvasGraph({ nodes: [...proj, ...locals], edges: [] });
    // 保留 React Flow 渲染态：结构重投影只更新结构，不重置 measured（见 graph.js 约定）。
    canvas.nodes = carryNodeMeasurements(prev, canvas.nodes);
    // 同一纪律：选中态属于交互态，不因扫描/内容事件触发的重投影丢失（仅同 id 且仍可见）。
    canvas.nodes = carryNodeSelection(prev, canvas.nodes);
    // R-2.4：新投影节点标记 fresh（短暂高亮 / 保留尾巴），4s 后由计时器清除。
    canvas.nodes.forEach((n) => {
      if (!prevIds.has(n.id)) n.data.fresh = true;
    });
    const derivedIds = new Set(derivedEdges.map((e) => String(e.id)));
    const keptSet = new Set(keptMissingIds.map(String));
    const prevEdges = isActive ? port().getEdges() : [];
    const localEdges = isActive ? prevEdges.filter((e) => !port().isSeEdge(e)) : [];
    // 临时缺失（未确认删除）的 s-* 端点：保留其 SE 边，避免节点还在而边先消失；
    // 本次已派生出的同名边以 derived 为准（按 id 去重）。
    const keptSeEdges = isActive
      ? prevEdges.filter(
          (e) =>
            port().isSeEdge(e) &&
            !derivedIds.has(String(e.id)) &&
            (keptSet.has(String(e.source)) || keptSet.has(String(e.target)))
        )
      : [];
    const nextEdges = [...localEdges, ...keptSeEdges, ...derivedEdges];
    if (!isActive) {
      // 非活动系统：只返回投影真源（供级联校验），不触碰活动画布的 nodes/edges/缓存/横幅。
      return { nodes: canvas.nodes, edges: nextEdges, dangling };
    }
    // 期 15（B1c）：重投影后回灌内部流窗口元数据。projectStreams/toCanvasGraph 已透传
    // contentWindow，但既有节点（本会话未读过 / 旧快照）可能缺失，会退化为 absStart=0。
    // 有绝对偏移 ref（本会话已读过）→ 就地按 ref 重建窗口，零网络；无 ref（全新会话）→
    // 调度一次全量读以同时建立 offset ref 与窗口。内部流数量极少，开销可忽略。
    canvas.nodes.forEach((cn) => {
      const nm = streamNameFromId(cn.id);
      if (!nm || !isInternalStream(nm)) return;
      const d = cn.data;
      if (!d || d.content == null || String(d.content) === '') return;
      if (d.contentWindow && Number.isFinite(Number(d.contentWindow.absStart))) return;
      const ck = seKey(sid, nm);
      const absEnd = session.consoleTailOffset.get(ck);
      if (absEnd !== undefined) {
        d.contentWindow = { absStart: absEnd - String(d.content).length, absEnd };
      } else {
        readContent(cn.id, sid);
      }
    });
    tagMap.forEach((v, k) => session.tags.set(k, v));
    // 版本基线（list 携带 version）；记录相对上次基线的变化，供漏收事件的内容追赶（D7）。
    const contentCatchup = new Set();
    Object.entries(versions).forEach(([name, v]) => {
      const key = seKey(sid, name);
      const prevV = session.version.get(key);
      if (prevV !== undefined && Number(prevV) !== Number(v)) contentCatchup.add(name);
      session.version.set(key, v);
    });
    removedIds.forEach((rid) => {
      const n = streamNameFromId(rid);
      if (n) {
        session.version.delete(seKey(sid, n));
        session.synced.delete(seKey(sid, n));
        session.consoleTailOffset.delete(seKey(sid, n));
      }
    });
    // 已投影流：首次接触时把本地缓存内容登记为同步基线（无则空串）。
    proj.forEach((p) => {
      const name = streamNameFromId(p.id);
      const key = seKey(sid, name);
      if (!session.synced.has(key)) {
        session.synced.set(key, {
          version: session.version.get(key),
          text: p.data.content != null ? String(p.data.content) : '',
          authoritative: false,
          source: 'seed',
        });
      }
      const synced = session.synced.get(key);
      if (
        prevIds.has(p.id) &&
        !isInternalStream(name) &&
        (!synced || synced.authoritative !== true)
      ) {
        contentCatchup.add(name);
      }
    });
    // 落地前最后一道闸：会话已换（关闭/重开）或 rename 已 bump 世代 → 整轮丢弃，
    // 由调用方/后续 flush 用新列表重投，避免旧 s-* 节点覆盖/删除新身份。
    if (!sessionAlive(sid, session)) return false;
    if (session.projectionEpoch !== epochAtStart) {
      coordinator.markDirty(sid, 'projection-epoch');
      return false;
    }
    port().setNodes(canvas.nodes);
    // 常驻布局表：落地后清理已删除流的表项（removedIds 为 s-<name> 节点 id，名称映射在 App 侧）；
    // pruneLayout 可能不存在（旧测试桩）→ 可选调用保护。
    port().pruneLayout?.(sid, removedIds);
    port().setEdges(nextEdges);
    port().setDangling(dangling);
    if (isActive) {
      setTimeout(() => {
        port().setNodes((nds) => {
          let changed = false;
          const next = nds.map((n) => {
            if (n && n.data && n.data.fresh) {
              changed = true;
              const data = { ...n.data };
              delete data.fresh;
              return { ...n, data };
            }
            return n;
          });
          return changed ? next : nds;
        });
      }, 4000);
    }

    // 新发现的流（外部 create / 改名）：拉一次内容填充节点。
    proj
      .filter((p) => !prevIds.has(p.id))
      .forEach((p) => {
        const name = streamNameFromId(p.id);
        if (name) readContent(p.id, sid);
      });
    // 版本变化或只有非权威本地 seed 的既有流：补一次内容读取（重连 / 漏事件追赶，D7）。
    contentCatchup.forEach((name) => {
      const nodeId = streamNodeId(name);
      if (prevIds.has(nodeId)) readContent(nodeId, sid);
    });
    // G-8：重投影会用 prevData 回灌旧 scan/processes（projectStreams），此处按 driver
    // 权威态重新贴回（幂等）；顺序：重投影 → driver re-apply。
    runtime.reapply(sid);
    // 期 14（方案 D4/B2）：重投影丢弃 termBody（toCanvasGraph 不透传），对既有 `_console` 节点重算派生（幂等）。
    proj.forEach((p) => {
      const name = streamNameFromId(p.id);
      if (name && name.endsWith('_console')) applyConsoleDerivation(sid, name);
    });
    return { nodes: canvas.nodes, edges: nextEdges, dangling };
  };

  /**
   * 对外唯一重投影入口：每 sid 串行（projectionQueue）。
   * 直连调用也排队，调用方拿到的是**本次**投影结果，而不是在飞的旧 promise。
   */
  const reproject = (systemId, opts) =>
    projectionQueue.run(String(systemId), () => reprojectImpl(systemId, opts));

  /** 等待该 sid 当前投影链尾（删除落盘前用；无在飞时立即 resolve）。 */
  const whenProjectionIdle = (sid) => projectionQueue.whenIdle(String(sid));

  /**
   * 元数据事件专用：只并本地缓存（tags/description），绝不读正文、绝不重投影。
   * 结构标签（`edge.*`/`canvas`）在 classify 阶段已分流为 structural，到不了这里。
   * v3：`field==='title'` 的旧事件容忍忽略（我们不再产出 title；name 变更走 rename 结构事件）。
   */
  const mergeMetadataCache = (sid, name, metadata) => {
    const md = metadata && typeof metadata === 'object' ? metadata : null;
    if (!md) return;
    const tags =
      md.tags && typeof md.tags === 'object' && !Array.isArray(md.tags) ? md.tags : null;
    if (tags) {
      const session = sessionOf(sid);
      if (!session) return;
      session.tags.set(name, tags);
    }
    const nodeId = streamNodeId(name);
    port().setNodes((nds) =>
      nds.map((n) => {
        if (String(n.id) !== nodeId) return n;
        const data = { ...n.data };
        if (md.description != null && String(md.description) !== '') {
          data.description = String(md.description);
        } else delete data.description;
        if (tags) {
          const fields = tagsToFields(tags);
          if (fields.length) data.fields = fields;
          else delete data.fields;
        }
        return { ...n, data };
      })
    );
  };

  /** 正文事件合流：每 `s-<name>` 120ms 防抖 + per-stream 单飞；append 增量、其余全量（D4/B3）。 */
  const runContentRead = async (sid, name, mode, recoveryTrailing = false) => {
    const key = seKey(sid, name);
    const session = sessionOf(sid);
    if (!sessionAlive(sid, session)) return;
    if (session.reading.has(key)) return;
    session.reading.add(key);
    const versionAtStart = session.version.get(key);
    try {
      const nodeId = streamNodeId(name);
      const internal = isInternalStream(name);
      const node = port().getNodes().find((n) => String(n.id) === nodeId);
      const current =
        node && node.data && node.data.content != null ? String(node.data.content) : '';
      if (mode !== 'append' || !node || !current || isFileProvenance(session.synced.get(key))) {
        await readContent(nodeId, sid);
        return;
      }
      if (port().isOffline()) return;
      if (port().getActiveSystemId() !== String(sid)) {
        revokeStaleAuthority(session, key);
        return;
      }
      if (port().getEditingNodeId() === nodeId) {
        revokeStaleAuthority(session, key);
        return;
      }
      const client = sePool.get(String(sid));
      if (client.status !== SE_STATUS.ONLINE) return;
      // 期 14 加固：内部流的本地 content 已被截为滚动尾部，其 length 不再是服务端绝对偏移；
      // 用记录的偏移定位增量起点，首次无基线则回退全量读建立偏移。普通流保持原语义（len）。
      let start = current.length;
      if (internal) {
        const known = session.consoleTailOffset.get(key);
        if (known === undefined) {
          await readContent(nodeId, sid);
          return;
        }
        start = known;
      }
      let text = '';
      try {
        const res = await client.call('stream.read', { name, start });
        text = res && typeof res.text === 'string' ? res.text : '';
      } catch (err) {
        await readContent(nodeId, sid); // 增量失败 → 回退全量读
        return;
      }
      if (!sessionAlive(sid, session)) return;
      if (internal) session.consoleTailOffset.set(key, start + text.length);
      if (!text) return;
      if (port().getActiveSystemId() !== String(sid)) {
        revokeStaleAuthority(session, key);
        return;
      }
      let nextFull = current + text;
      if (internal && nextFull.length > CONSOLE_TAIL_MAX_CHARS) {
        nextFull = nextFull.slice(nextFull.length - CONSOLE_TAIL_MAX_CHARS);
      }
      // 期 15（B3）：追加使窗口前移时，[prevAbs, newAbsStart) 并入边界历史页，需失效其缓存。
      // 在 setNodes mapper 之外用 getNodes 决策（mapper 可能逐节点执行，且不应在更新器内广播）。
      if (internal) {
        const prevNode = port().getNodes().find((n) => String(n.id) === nodeId);
        const prevWin = prevNode && prevNode.data ? prevNode.data.contentWindow : null;
        if (prevWin && Number.isFinite(Number(prevWin.absStart))) {
          const prevAbs = Number(prevWin.absStart);
          const cur = prevNode.data.content != null ? String(prevNode.data.content) : '';
          let nextLen = cur.length + text.length;
          if (nextLen > CONSOLE_TAIL_MAX_CHARS) nextLen = CONSOLE_TAIL_MAX_CHARS;
          const newAbsStart = start + text.length - nextLen;
          if (newAbsStart > prevAbs) {
            deleteHistoryPage(port().getActiveTabId(), nodeId, Math.floor(prevAbs / PAGE_CHAR_BUDGET));
          }
        }
      }
      port().setNodes((nds) =>
        nds.map((n) => {
          if (String(n.id) !== nodeId) return n;
          const data = { ...n.data };
          data.content = nextFull;
          // 期 15：增量后同步内部流窗口的绝对区间（end = 服务端绝对终点，start = end - 本地长度）。
          if (internal) {
            const absEnd = start + text.length;
            data.contentWindow = { absStart: absEnd - nextFull.length, absEnd };
          }
          return { ...n, data };
        })
      );
      // append 后 node 内容已是服务端当前全文：同步基线（否则最小 diff 会把远端追加重放成本地插入）。
      const prevSynced = session.synced.get(key);
      session.synced.set(key, {
        version: versionAtStart !== undefined ? versionAtStart : prevSynced && prevSynced.version,
        text: nextFull,
        authoritative: !internal,
        source: internal ? 'internal' : 'read',
      });
      if (String(name).endsWith('_console')) applyConsoleDerivation(sid, name);
    } finally {
      const currentVersion = session.version.get(key);
      const synced = session.synced.get(key);
      const advancedPastRead =
        !sameVersion(currentVersion, versionAtStart) &&
        !sameVersion(currentVersion, synced && synced.version);
      const pendingBaseline =
        currentVersion !== undefined &&
        synced &&
        synced.source === 'file-preserved' &&
        synced.version === undefined;
      session.reading.delete(key);
      if (sessionAlive(sid, session)) {
        if (advancedPastRead) {
          scheduleContentRead(sid, name, 'full');
        } else if (pendingBaseline && !recoveryTrailing) {
          void runContentRead(sid, name, 'full', true);
        }
      }
    }
  };

  const scheduleContentRead = (sid, name, mode) => {
    const key = seKey(sid, name);
    const session = sessionOf(sid);
    if (!session) return;
    const prev = session.readTimers.get(key);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      session.readTimers.delete(key);
      if (!sessionAlive(sid, session)) return;
      void runContentRead(sid, name, mode === 'append' ? 'append' : 'full');
    }, 120);
    session.readTimers.set(key, timer);
  };

  /**
   * `stream.on_change` / `stream.on_lifecycle` 推送（期 14 / 方案 D1/D3）：
   * classify 四分类 → 结构走对账协调器；元数据只并缓存；正文按已知/未知分流。
   */
  const handleSeStreamChange = (systemId, params) => {
    const sid = String(systemId);
    const session = sessionOf(sid);
    if (!session) return;
    const cls = classifyStreamChange(params);
    if (cls.kind === 'ignore') return;
    if (cls.kind === 'structural') {
      if (isSelfWrite(sid, cls.name, session)) return;
      // 显式删除意图才登记 tombstone；恢复/启动导致的删除未来靠 cause 区分，
      // 当前只认 lifecycle deleted（非自写）为外部用户删除。
      if (cls.reason === 'deleted') noteDeleted(sid, cls.name, 'external');
      else if (cls.reason === 'created') clearDeleted(sid, cls.name);
      else if (cls.reason === 'rename') {
        // 改名 = 旧身份移除 + 新身份出现；派生内部流（_console/_scan_log）由 SE 一并改名，
        // 也必须把旧派生名 tombstone，否则 keepMissing 会保留旧节点。
        const oldName = params && params.change ? String(params.change.old_name || '') : '';
        if (oldName && oldName !== cls.name) {
          noteDeleted(sid, oldName, 'rename');
          noteDeleted(sid, `${oldName}_console`, 'rename');
          noteDeleted(sid, `${oldName}_scan_log`, 'rename');
        }
        clearDeleted(sid, cls.name);
        clearDeleted(sid, `${cls.name}_console`);
        clearDeleted(sid, `${cls.name}_scan_log`);
      }
      coordinator.invalidate(sid, cls.reason);
      return;
    }
    if (port().getActiveSystemId() !== sid) {
      // 非激活系统：只置脏记账（切回/校验时统一对账），绝不丢弃。
      coordinator.markDirty(sid, cls.kind);
      return;
    }
    const name = cls.name;
    if (cls.kind === 'metadata') {
      if (isSelfWrite(sid, name, session)) return;
      mergeMetadataCache(sid, name, cls.metadata);
      return;
    }
    const nodeId = streamNodeId(name);
    const known = port().getNodes().some((n) => String(n.id) === nodeId);
    if (!known) {
      coordinator.invalidate(sid, 'content-unknown');
      return;
    }
    if (port().getEditingNodeId() === nodeId) {
      // 编辑中不打断光标：记 stale，退出编辑/失焦时再读。
      session.stale.add(seKey(sid, name));
      return;
    }
    if (params.version != null) session.version.set(seKey(sid, name), Number(params.version));
    scheduleContentRead(sid, name, cls.mode);
  };

  /**
   * 把配置工具投影进 SE（config → SE，需求1 §3.1 #2 / Oracle Q2=C）：
   * 只注册 SE 注册表中**尚不存在**的配置工具（`state === 'new'`）；已存在不重注册，
   * 保证 tab 切换/重连幂等零抖动。失败逐条记录，供列表标注「注册失败」。
   * 注意：与 `pushFileStreams` 分离——后者在无 s-* 流时 early-return，不能承载工具投影。
   * @returns {Promise<{ok:boolean, summary?:object|null, failures?:Array, error?:string}>}
   */
  const projectToolsToSe = async (systemId) => {
    const sid = String(systemId);
    const client = sePool.get(sid);
    if (!client || client.status !== SE_STATUS.ONLINE) return { ok: false, reason: 'offline' };
    const tools = port().toolsForSystem(sid);
    if (!Object.keys(tools).length) return { ok: true, summary: null };
    try {
      const existingTools = await client.call('tool.list', {}).catch(() => []);
      const manifest = buildToolsOnlyManifest(tools, sid);
      const plan = planImport({ manifest, contents: new Map(), existingStreams: [], existingTools });
      // 只注册新增（已注册的改动交给编辑路径 toolDriver.update），避免每次连接 unregister/register 抖动。
      plan.tools = plan.tools.filter((r) => r && r.state === 'new');
      const failures = [];
      const summary = await applyImport({
        plan,
        manifest,
        call: (m, p) => client.call(m, p || {}),
        contents: new Map(),
        baseDir: port().baseDirForSystem(sid),
        registeredTools: existingTools,
        strategy: 'overwrite',
        confirmReserved: false,
        onProgress: (p) => {
          if (p && p.kind === 'tool' && p.state === 'failed') {
            failures.push({ name: p.name, error: p.error || '注册失败' });
          }
        },
      });
      if (failures.length) {
        const added = port().recordToolFailures(sid, failures);
        // 仅在出现「新」失败时告警，避免每次 tab 切换重复刷同一条。
        if (added > 0) port().notify(`${added} 个工具未能注册进 SE（见工具列表标注）`, 'warn');
      }
      return { ok: true, summary, failures };
    } catch (err) {
      console.warn('配置→SE 工具投影失败', err);
      return { ok: true, summary: null, error: (err && err.message) || String(err) };
    }
  };

  /**
   * 把 s-* 节点的**文件内容**上推到 SE（file → SE）。
   * @returns {Promise<{ok:boolean, reason?:string, summary?:object|null, error?:string}>}
   *   ok=false 当 SE 离线（调用方保留 pending，连上后重试）或会话已确认关闭（closed）；
   *   无 s-* 流 → ok:true, summary:null。
   */
  const pushFileStreams = async (systemId, nodes, coldStart = false) => {
    const sid = String(systemId);
    // tab 水合（文件→SE 首推）可先于连接生命周期；同一水合缝在确认关闭后
    // 无新所有者时返回 null，绝不复活会话。
    const session = sessionForHydration(sid);
    if (!session) return { ok: false, reason: 'closed' };
    const client = sePool.get(sid);
    if (!client || client.status !== SE_STATUS.ONLINE) return { ok: false, reason: 'offline' };
    const owner = port().getTabs().find((t) => t.system?.system_id === sid);
    const docBase = owner ? docBaseOf(owner) : '';
    // 保留后缀无法经公共 create 创建；跨图谱 source 不属于本文档。两者都不上推。
    const eligibleNodes = (Array.isArray(nodes) ? nodes : []).filter((n) => {
      const name = streamNameFromId(n && n.id);
      if (!name) return false;
      const source = n && n.data && n.data.source ? n.data.source.file_path : '';
      return canAutoCreateStream(name, source, docBase);
    });
    const allStreams = collectPushableContents(eligibleNodes);
    const blocked = allStreams.filter((s) => isScanActiveName(s.name));
    if (blocked.length) {
      port().notify(
        `扫描活动期间已跳过 ${blocked.length} 个流的文件覆盖；请先停止扫描或显式 rescan`,
        'warn'
      );
    }
    const streams = allStreams.filter((s) => !isScanActiveName(s.name));
    const contents = new Map(streams.map((s) => [s.name, s.content]));
    const documentNames = new Set(
      eligibleNodes.map((n) => streamNameFromId(n && n.id)).filter(Boolean)
    );
    // 冷启动 existing 流由 reproject 的 file-provenance 读取独占处理；pendingPush 再读
    // 一次既可能覆盖 commit 基线，也可能让两个相同 provenance 的响应重复 CAS。
    const coldNames = new Set(
      coldStart
        ? eligibleNodes
            .filter((n) => n && n.data && n.data.source && n.data.source.file_path)
            .map((n) => streamNameFromId(n.id))
            .filter(Boolean)
        : []
    );
    if (!documentNames.size) return { ok: true, summary: null };
    const manifest = buildStreamsOnlyManifest(streams, sid);
    try {
      const existingStreams = await client.call('stream.list', {}).catch(() => []);
      const existingNames = new Set(
        (Array.isArray(existingStreams) ? existingStreams : [])
          .map((s) => String((s && s.name) || ''))
          .filter(Boolean)
      );
      const coldCreateNames = new Set(
        [...coldNames].filter(
          (name) => !existingNames.has(name) || session.unconfirmedMissing.has(name)
        )
      );
      coldCreateNames.forEach((name) => contents.set(name, ''));
      await Promise.all(
        [...documentNames]
          .filter((name) => existingNames.has(name) && !coldNames.has(name))
          .map((name) => readContent(streamNodeId(name), sid))
      );
      if (!streams.length) return { ok: true, summary: null };
      const plan = planImport({ manifest, contents, existingStreams });
      plan.streams = plan.streams.filter((row) => row && row.state === 'new');
      // 工具投影不在此处（见 projectToolsToSe）：此处只推流，避免无流时被 early-return 吞掉。
      const summary = await applyImport({
        plan,
        manifest,
        call: (m, p) => client.call(m, p || {}),
        contents,
        baseDir: port().baseDirForSystem(sid),
        registeredTools: [],
        strategy: 'skip',
        confirmReserved: false,
      });
      await Promise.all(
        [...coldCreateNames]
          .filter((name) => isFileProvenance(session.synced.get(seKey(sid, name))))
          .map((name) => readContent(streamNodeId(name), sid))
      );
      return { ok: true, summary };
    } catch (err) {
      console.warn('文件→SE 上推失败', err);
      return { ok: true, summary: null, error: (err && err.message) || String(err) };
    }
  };

  /** 注册 `stream.on_change` + `stream.on_lifecycle` 订阅（每系统一次；SEClient 重连自动重订阅）。 */
  const subscribeSeChanges = (systemId, sessionArg) => {
    const sid = String(systemId);
    const session = sessionArg || sessionOf(sid);
    if (!session) return;
    if (session.subscribed) return;
    session.subscribed = true;
    const client = sePool.get(sid);
    client.subscribe(['stream.on_change', 'stream.on_lifecycle'], (params) => {
      // 旧会话的订阅回包在关闭/重开后必须 no-op，绝不能写进新会话。
      if (!sessionAlive(sid, session)) return;
      handleSeStreamChange(sid, params);
    });
  };

  /** 连接成功后：订阅变更 + 一次全量重投影（§3.6）+ 期 6-8 运行时装配。 */
  const onConnected = async (systemId) => {
    const sid = String(systemId);
    const session = ensureLifecycleSession(sid);
    if (!session) return;
    const epoch = epochOf(sid);
    subscribeSeChanges(sid, session);
    await reproject(sid);
    // 关闭后进行中的握手不得继续装配（世代已变 / 会话已换 → 静默放弃）。
    if (!epochAlive(sid, epoch) || !sessionAlive(sid, session)) return;
    // 期 3：若该系统的文件→SE 上推因离线被暂存，连上后补推一次。
    const pendingPush = session.pendingPush;
    let pushing = null;
    if (pendingPush) {
      session.pendingPush = null;
      pushing = pushFileStreams(sid, pendingPush, true)
        .then((res) => {
          const n = res && res.summary ? (res.summary.streams.created || 0) + (res.summary.streams.updated || 0) : 0;
          if (n) port().notify(`已按文件内容同步 ${n} 个流到 SE`, 'ok');
        })
        .catch(() => {});
    }
    // Task6：补推完成后，用当前文档/画布边补齐 s-*↔s-* 边到 SE tags（幂等）。
    // 覆盖「离线加载→重连」缺口——该 tab 加载尾部的对齐因离线空返回，只能在此收口。
    // 先于下方 projectToolsToSe/自存窗口执行，避免 storeRef 被重投影后的空边快照覆盖。
    Promise.resolve(pushing)
      .catch(() => {})
      .then(() => port().callAlignEdges(sid))
      .catch(() => {});
    // 需求1 §3.1 #2 / Oracle Q2：连接后把配置工具投影进 SE（只注册新增）。
    // 必须在 ensure（触发 hydrate 计算注册状态）之前完成，使状态反映投影结果。
    await projectToolsToSe(sid);
    // 工具投影回包期间 tab 可能已关闭：ensure 前置再查一次。
    if (!epochAlive(sid, epoch) || !sessionAlive(sid, session)) return;
    const entry = runtime.ensure(sid);
    runtime.reapply(String(systemId));
    // 期 8：root 能力探测（无副作用）→ 缓存 canManageTools（未知时保持可用，由 RPC 兜错）。
    entry?.tools
      ?.probeRoot()
      .then((root) => {
        if (port().getActiveSystemId() === String(systemId)) port().setCanManageTools(root !== false);
      })
      .catch(() => {});
  };

  /** 断线重连（离线→在线）：重水合 driver（scan/process/tools）+ 触发一次结构/内容对账（D7）。 */
  const handleSeReconnected = async (systemId) => {
    const sid = String(systemId);
    // tab 已关闭（或从未拥有）：不重水合、不复活 client。
    if (!ownedNow(sid)) return;
    const session = sessionOf(sid);
    if (!session) return;
    runtime.ensure(sid);
    // B5 兜底：空注册表与部分缺失共用自动同步缝——已有流只读回，缺失流才按文档创建。
    const list = await sePool.get(sid).call('stream.list', {}).catch(() => null);
    if (!sessionAlive(sid, session)) return;
    if (Array.isArray(list)) {
      const owner = port().getTabs().find((t) => t.system?.system_id === sid);
      const g = owner ? port().getStoreGraph(owner.id) : null;
      const hasStreamNodes = !!(
        g &&
        Array.isArray(g.nodes) &&
        g.nodes.some((n) => String(n.id).startsWith('s-'))
      );
      if (hasStreamNodes) {
        await pushFileStreams(sid, g.nodes).catch(() => {});
      }
      // pushFileStreams 只上推**已加载正文**（loaded-only），未加载的文档流不会出现在
      // 其清单里；但重连后注册表缺失时它们仍须按名重建（create-only，绝不写正文）。
      // 用 push 后的最新 list 求差集，避免把刚创建的流再 create 一次。
      const afterPush = await sePool.get(sid).call('stream.list', {}).catch(() => null);
      if (!sessionAlive(sid, session)) return;
      if (Array.isArray(afterPush)) {
        const serverNames = new Set(
          afterPush.map((s) => String((s && s.name) || '')).filter(Boolean)
        );
        const missing = [...getDocumentStreamNames(sid)].filter((name) => !serverNames.has(name));
        if (missing.length) await repairRegistryFromDocument(sid, missing).catch(() => {});
      }
    }
    coordinator.invalidate(sid, 'reconnect');
    // SE 工具注册表会持久化；此处只补台账中缺失的工具，已有同名项不重注册
    // （避免每次连接 unregister/register 抖动）。路径变更由导入覆盖负责。
    projectToolsToSe(sid).catch(() => {});
    // Task5：重连成功后事件驱动地提升 pending 节点（fire-and-forget；离线/非活动自会空返回）。
    const promoting = port().callPromotePending(sid) || Promise.resolve();
    // Task6：提升完成后用当前文档/画布边补齐 SE tags（幂等；提升可能新增 s-* 端点后需补）。
    Promise.resolve(promoting)
      .catch(() => {})
      .then(() => port().callAlignEdges(sid))
      .catch(() => {});
  };

  /** 同 system_id 查重（方案 §5.1：禁止两 tab 同系统；大小写不敏感 = 同一物理目录）。 */
  const findSystemOwner = (systemId) =>
    port().getTabs().find((t) => t.system?.system_id && sameSystemId(t.system.system_id, systemId)) ||
    null;

  /**
   * attach-or-spawn 核心：endpoint 判状态 → online / spawn。
   * 不含「同 system_id 占用查重」——绑定流程才需查重；恢复 / 重连时该 tab 本就是拥有者。
   * 决策委托纯逻辑 ensurePolicy（可单测）：online→attach / 否则 spawn。
   * D/B：存活但无 token 的残留由 Node 侧 spawn 按归属回收后全新拉起，前端绝不弹 token、不强杀；
   * 仅 owned-by-other-vite / port-unverifiable 作为诚实错误上抛。
   */
  const attachOrSpawn = async (systemId) => {
    const id = String(systemId);
    // 关闭序列化：同 id 有未完结的终止 → 等旧实例死透（响应即死）再探活/spawn。
    const ending = seEnding.get(id);
    if (ending) await ending;
    let ep = null;
    try {
      ep = await sePool.probe(id);
    } catch (err) {
      ep = null;
    }
    const action = planEnsure(true);
    if (action === 'attach') return { ok: true, status: 'online' };
    try {
      const res = await fetch('/api/se/spawn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ system_id: id }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data && data.status === 'online') return { ok: true, status: 'online' };
      if (res.status === 409 && data && data.status === 'locked') {
        return { ok: false, status: 'locked', error: 'spawn already in progress' };
      }
      // 409 带 status：owned-by-other-vite / port-unverifiable / identity-mismatch /
      // storage-root-busy 等。canonical/holder 由 Node 提供，供 UI 给可执行修复。
      if (res.status === 409 && data && data.status) {
        let message = data.error || String(data.status);
        if (data.status === 'storage-root-busy') {
          message = `存储目录已被另一个 SE 实例占用（pid ${data.holder_pid ?? '未知'}${
            data.holder_alive ? '' : '，可能已退出'
          }）`;
        } else if (data.status === 'identity-mismatch') {
          message = `系统 id 大小写与磁盘不一致（磁盘：${data.canonical || '未知'}）`;
        }
        return {
          ok: false,
          status: data.status,
          error: message,
          canonical: data.canonical || null,
          candidates: Array.isArray(data.candidates) ? data.candidates : [],
          holderPid: data.holder_pid ?? null,
          holderAlive: !!data.holder_alive,
        };
      }
      return { ok: false, error: (data && data.error) || `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  };

  /**
   * 创建**全新独立**系统（从配置包创建 / 导出并绑定）。
   * 分配与原子占位由 Node 在磁盘命名空间内完成；本函数只负责 HTTP 接线，
   * 绝不走 attach/reclaim，也不在客户端拼 system_id（避免 TOCTOU）。
   */
  const createSystem = async ({ base, avoid } = {}) => {
    const b = String(base == null ? '' : base).trim();
    if (!b) return { ok: false, error: 'base required' };
    const avoidIds = Array.isArray(avoid)
      ? avoid
      : port()
          .getTabs()
          .filter((t) => t.system?.system_id)
          .map((t) => String(t.system.system_id));
    try {
      const res = await fetch('/api/se/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base: b, avoid: avoidIds }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data && data.system_id) {
        return {
          ok: true,
          systemId: String(data.system_id),
          port: data.port,
          status: data.status || 'online',
        };
      }
      return {
        ok: false,
        status: (data && data.status) || null,
        error: (data && data.error) || `HTTP ${res.status}`,
        canonical: (data && data.canonical) || null,
      };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  };

  /** 创建成功但绑定失败时的回滚：终止刚创建、尚未被任何 tab 接管的系统。 */
  const endUnboundSystem = (systemId) => endSeSystem(systemId);

  /** attach-or-spawn 准备（绑定流程）：同 system_id 占用查重 + 核心。 */
  const prepareSystem = async (systemId) => {
    const id = String(systemId);
    const owner = findSystemOwner(id);
    if (owner) {
      return { ok: false, error: `该系统已被标签页「${owner.name || '未命名图'}」绑定` };
    }
    return attachOrSpawn(id);
  };

  /**
   * 统一入口：attach-or-spawn + 连接（WS 身份校验 + 静默回灌）。
   * allowSpawn=false 时退化为只 attach（不自动拉起死进程）；同 id 并发去重。
   */
  const ensureSystem = async (systemId, { allowSpawn = true } = {}) => {
    const id = String(systemId);
    if (seEnding.has(id)) {
      return { ok: false, status: 'closing', code: 'close-in-progress', error: 'close in progress' };
    }
    const inflight = ensureInflight.get(id);
    if (inflight) return inflight;
    const task = (async () => {
      const epoch = epochOf(id);
      if (allowSpawn) {
        const spawned = await attachOrSpawn(id);
        // 等旧实例期间/之后 tab 可能已关闭：一次守卫覆盖 lazy-attach 与 connectSystem 两条后续分支。
        if (!epochAlive(id, epoch)) return { ok: false, error: 'closed' };
        const outcome = planSpawnOutcome(spawned);
        if (outcome === 'error') return spawned;
        if (outcome === 'lazy-attach') {
          // 另一实例正在拉起（spawn 排他锁命中）：建客户端等待收敛，但**有界**——
          // 20s 未 online 视为收敛失败，park 客户端停止闪重连；离线由自愈 effect 自动重试。
          const client = sePool.get(id);
          waitForClientOnline(client, 20000)
            .then(() => {
              // 等待期间 tab 可能已关闭：不动作（status 兜底回调会处理正常上线）。
              if (!epochAlive(id, epoch)) return;
            })
            .catch(() => {
              if (!epochAlive(id, epoch)) return;
              sePool.release(id); // park：停止自动重连闪烁；离线由自愈 effect 自动重试
              port().notify(`系统「${id}」拉起疑似失败（等待超时），将自动重试`, 'warn');
            });
          return spawned;
        }
      }
      return connectSystem(id);
    })().finally(() => {
      ensureInflight.delete(id);
    });
    ensureInflight.set(id, task);
    return task;
  };

  /** 懒连接某系统 + system.info 身份校验 + 注册表静默回灌。 */
  const connectSystem = async (systemId, { skipRefill = false } = {}) => {
    const id = String(systemId);
    const epoch = epochOf(id);
    const client = sePool.get(id);
    try {
      await waitForClientOnline(client);
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
    // 关闭后进行中的握手不得继续（世代已变 → 静默放弃，不复活 client）。
    if (!epochAlive(id, epoch)) return { ok: false, error: 'closed' };
    let info = null;
    try {
      info = await client.call('system.info', {});
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
    // system.info 回包期间 tab 可能已关闭：身份校验前再查一次。
    if (!epochAlive(id, epoch)) return { ok: false, error: 'closed' };
    if (!info || String(info.system_id) !== id) {
      sePool.release(id);
      port().notify(
        `系统身份校验失败：期望 ${id}，实际 ${info ? info.system_id : '未知'}（防端口串台，已断开）`,
        'warn'
      );
      return { ok: false, error: 'system_id mismatch' };
    }
    // 注册表静默回灌：tool.list 为空且绑定含 manifest_path → 导入同一个包（免确认）。
    // 显式导入流程传 skipRefill=true，避免与随后带确认的 applyImport 竞争。
    const boundTab = port().getTabs().find((t) => t.system?.system_id === id);
    const manifestPath = boundTab?.system?.manifest_path;
    // 方案 #9 / Oracle Q1：静默回灌降级为「配置无工具」时的兜底，避免与配置投影形成双真源竞争。
    const hasConfigTools = Object.keys(port().getStoreGraph(boundTab?.id)?.tools || {}).length > 0;
    if (manifestPath && !skipRefill && !hasConfigTools) {
      silentRefillFromManifest((m, p) => client.call(m, p || {}), manifestPath)
        .then((summary) => {
          if (summary && !summary.error && summary.tools && summary.tools.registered > 0) {
            port().notify(`已静默回灌配置包：${summary.tools.registered} 个工具`, 'info');
          }
        })
        .catch(() => {});
    }
    return { ok: true, info };
  };

  /**
   * 自愈核心：对指定系统 ensureSystem（存活残留由 Node 侧回收重拉），成功后补 onConnected；
   * 失败给诚实错误文案（E：owned-by-other-vite / port-unverifiable），绝不弹 token 对话框。
   * D：取代原手动「重连」——离线由自愈 effect 自动调用，无需用户操作。
   */
  const recoverSystem = (systemId, { quiet = false } = {}) => {
    const id = String(systemId);
    if (!id) return Promise.resolve(null);
    return ensureSystem(id, { allowSpawn: true }).then((res) => {
      if (res && res.ok) {
        if (port().getActiveSystemId() === id) onConnected(id);
        return res;
      }
      if (!quiet && res && res.status !== 'locked' && res.error) {
        port().notify(port().seErrorMessage(res), 'warn');
      }
      return res;
    });
  };

  /**
   * 关标签页 = 关对应 SE：世代 +1 作废在途握手 → 对账/运行时/订阅清理 →
   * 确认最终关闭后丢弃整个 per-SID session（失败/共享 SID 保留）→
   * 登记并发起终止（seEnding 同步登记，重开路径 attachOrSpawn 会等它死透）。
   */
  const closeSystem = (sid) => {
    const key = String(sid);
    const existing = seEnding.get(key);
    if (existing) return existing;

    /** 是否仍有其它 tab 绑定同一 SID（决定是否可丢弃会话）。 */
    const isFinalClose = () =>
      port().getTabs().filter((t) => t.system?.system_id === key).length <= 1;

    seEpoch.set(key, epochOf(sid) + 1);
    const ending = endSeSystem(sid).then((res) => {
      const stopped = !!(res && (res.ok || res.killed));
      if (stopped) {
        coordinator.drop(key);
        runtime.dispose(sid);
        sePool.release(sid);
        projectionQueue.clear(key);
        if (isFinalClose()) {
          // 快照当前所有者：它们后续的迟到水合调用不得复活会话；新 tab 才算重开。
          closedOwners.set(
            key,
            new Set(
              port()
                .getTabs()
                .filter((t) => t.system?.system_id === key)
                .map((t) => String(t.id))
            )
          );
          sessions.drop(key);
        } else {
          // 共享 SID：其它 tab 仍持有该会话，只清在飞读取计时器，状态全部保留。
          const session = sessions.peek(key);
          if (session) {
            for (const timer of session.readTimers.values()) clearTimeout(timer);
            session.readTimers.clear();
          }
        }
        if (res.killed) port().setStatus(`SE「${sid}」已停止`);
        return res;
      }

      // 未确认停止：保留会话（含 pendingPush），标签与运行状态不动，允许重试。
      const message = res
        ? port().seErrorMessage({ code: res.code, status: res.status || res.error, error: res.reason || res.error })
        : '未能确认 SE 已停止（连接中断）';
      port().notify(`未终止 SE「${sid}」：${message}。标签与运行状态已保留，可重试。`, 'warn');
      return res;
    });
    let tracked;
    tracked = ending.finally(() => {
      if (seEnding.get(key) === tracked) seEnding.delete(key);
    });
    seEnding.set(key, tracked);
    return tracked;
  };

  /** 从服务端读回权威基线（码点全文；内部流只保留尾部窗口，不可 diff）。 */
  const readServerBaseline = async (client, sid, name, sessionArg) => {
    const key = seKey(sid, name);
    const session = sessionArg || sessionOf(sid);
    if (!session) return null;
    const [read, meta] = await Promise.all([
      client.call('stream.read', { name }),
      client.call('stream.get_metadata', { name }),
    ]);
    if (!read || typeof read !== 'object' || !Object.prototype.hasOwnProperty.call(read, 'text')) {
      return null;
    }
    const full = read.text != null ? String(read.text) : '';
    const internal = isInternalStream(name);
    const shown =
      internal && full.length > CONSOLE_TAIL_MAX_CHARS
        ? full.slice(full.length - CONSOLE_TAIL_MAX_CHARS)
        : full;
    const version = meta && meta.version != null ? Number(meta.version) : session.version.get(key);
    const record = {
      version,
      text: shown,
      authoritative: !internal,
      source: internal ? 'internal' : 'read',
    };
    if (version !== undefined) session.version.set(key, version);
    session.synced.set(key, record);
    if (internal) session.consoleTailOffset.set(key, full.length);
    return record;
  };

  /** CAS 冲突回包：payload 字段保持 App 既有消费口径，并补内部/基线信息。 */
  const casConflictResult = async (client, ctx) => {
    const { sid, name, nodeId, node, text, synced, rescanRequired, session } = ctx;
    try {
      const [read, meta] = await Promise.all([
        client.call('stream.read', { name }),
        client.call('stream.get_metadata', { name }),
      ]);
      const remoteVersion = meta && meta.version != null ? Number(meta.version) : undefined;
      if (remoteVersion !== undefined) session.version.set(seKey(sid, name), remoteVersion);
      return {
        ok: false,
        reason: 'cas',
        ...(rescanRequired ? { rescanRequired: true } : {}),
        conflict: {
          systemId: sid,
          name,
          nodeId,
          nodeType: (node && node.type) || 'agent',
          localText: text,
          remoteText: read && read.text != null ? String(read.text) : '',
          remoteVersion,
          remoteInternal: isInternalStream(name),
          baselineText: synced && synced.text != null ? String(synced.text) : '',
          baselineVersion: synced ? synced.version : undefined,
        },
      };
    } catch (err2) {
      port().notify(`冲突重读失败：${(err2 && err2.message) || err2}`, 'warn');
      return { ok: false, reason: 'cas', ...(rescanRequired ? { rescanRequired: true } : {}) };
    }
  };

  /** 整篇写入（非局部回退路径）：成功后基线为 commit；失败保留诚实错误。 */
  const wholeWrite = async (client, ctx) => {
    const { sid, name, key, text, synced, rescanRequired, session } = ctx;
    const expected = session.version.has(key) ? session.version.get(key) : synced && synced.version;
    const params = { name, text };
    if (expected !== undefined) params.expected_version = expected;
    try {
      const res = await client.call('stream.write', params);
      const version = res && res.version != null ? Number(res.version) : expected;
      session.version.set(key, version);
      session.synced.set(key, { version, text, authoritative: true, source: 'commit' });
      port().setStatus(`已写入流「${name}」`);
      return { ok: true, version, text, ...(rescanRequired ? { rescanRequired: true } : {}) };
    } catch (err) {
      if (err && err.code === -32010) {
        return casConflictResult(client, {
          sid,
          name,
          key,
          node: port().getNodes().find((n) => String(n.id) === streamNodeId(name)),
          nodeId: streamNodeId(name),
          text,
          synced,
          rescanRequired: true,
          session,
        });
      }
      port().notify(`写入流「${name}」失败：${(err && err.message) || err}`, 'warn');
      return { ok: false, reason: 'error', ...(rescanRequired ? { rescanRequired: true } : {}) };
    }
  };

  /** 按 hunk.start 降序应用 range RPC：高位先改，低位偏移始终对旧基线有效。 */
  const applyRangeHunks = async (client, name, hunks, expectedVersion) => {
    let version = expectedVersion;
    const ordered = [...hunks].sort((a, b) => b.start - a.start);
    for (const hunk of ordered) {
      const params = { name };
      let method;
      if (hunk.type === 'insert') {
        method = 'stream.insert';
        params.pos = hunk.start;
        params.text = hunk.text;
      } else if (hunk.type === 'delete') {
        method = 'stream.delete_range';
        params.start = hunk.start;
        params.end = hunk.end;
      } else {
        method = 'stream.replace_range';
        params.start = hunk.start;
        params.end = hunk.end;
        params.text = hunk.text;
      }
      if (version !== undefined) params.expected_version = version;
      const res = await client.call(method, params);
      if (res && res.version != null) version = Number(res.version);
    }
    return version;
  };

  /**
   * 内容提交：权威基线可 diff 时走最小 range RPC（insert/delete_range/replace_range），
   * 无权威基线 / 内部流 / diff 过大时整篇 `stream.write` 并要求 rescan；
   * CAS(-32010) 重读重算有界重试，最终失败回退整篇写并带 rescanRequired。
   * 未绑定/本地节点不经此路径。
   */
  /** 局部 range 写入因远端文本已变化而越界：按整篇 CAS 重试，避免静默吞掉本地编辑。 */
  const isRangeOpMismatch = (err) => {
    if (!err) return false;
    if (err.code === -32602) return true;
    return /out of bounds|position\s+\d+|range/i.test(String(err.message || ''));
  };

  const commitContent = async (nodeId, textOverride) => {
    const name = streamNameFromId(nodeId);
    if (!name) return { ok: false, reason: 'no-stream' };
    const sid = port().getActiveSystemId();
    if (!sid) return { ok: false, reason: 'no-system' };
    if (port().isOffline()) {
      port().notify('系统离线，内容修改已挂起', 'warn');
      return { ok: false, reason: 'offline' };
    }
    const session = sessionOf(sid);
    if (!session) return { ok: false, reason: 'closed' };
    const client = sePool.get(String(sid));
    if (client.status !== SE_STATUS.ONLINE) return { ok: false, reason: 'not-online' };
    const node = port().getNodes().find((n) => String(n.id) === nodeId);
    const text =
      textOverride !== undefined
        ? String(textOverride)
        : node && node.data && node.data.content != null
          ? String(node.data.content)
          : '';
    const key = seKey(sid, name);
    let synced = session.synced.get(key);
    if (synced && synced.text === text) return { ok: false, reason: 'unchanged' };

    const internal = isInternalStream(name);
    if (!internal && (!synced || synced.authoritative !== true)) {
      try {
        const fresh = await readServerBaseline(client, sid, name, session);
        if (!sessionAlive(sid, session)) return { ok: false, reason: 'closed' };
        if (fresh) synced = fresh;
      } catch (err) {
        synced = null;
      }
      if (synced && synced.text === text) return { ok: false, reason: 'unchanged' };
    }

    const canDiff = !internal && !!synced && synced.authoritative === true;
    const hunks = canDiff ? diffCodePoints(synced.text, text) : null;
    if (!canDiff || hunks === null) {
      return wholeWrite(client, { sid, name, key, text, synced, rescanRequired: true, session });
    }
    if (hunks.length === 0) {
      session.synced.set(key, { ...synced, text });
      return { ok: false, reason: 'unchanged' };
    }

    let attempts = 0;
    let currentSynced = synced;
    let currentHunks = hunks;
    for (;;) {
      const expected = session.version.has(key) ? session.version.get(key) : currentSynced.version;
      try {
        const version = await applyRangeHunks(client, name, currentHunks, expected);
        if (!sessionAlive(sid, session)) return { ok: false, reason: 'closed' };
        const finalVersion = version !== undefined ? version : expected;
        session.version.set(key, finalVersion);
        session.synced.set(key, {
          version: finalVersion,
          text,
          authoritative: true,
          source: 'commit',
        });
        port().setStatus(`已写入流「${name}」`);
        return { ok: true, version: finalVersion, text };
      } catch (err) {
        if (!err || err.code !== -32010) {
          if (isRangeOpMismatch(err)) {
            return wholeWrite(client, {
              sid,
              name,
              key,
              text,
              synced: currentSynced,
              rescanRequired: true,
              session,
            });
          }
          port().notify(`写入流「${name}」失败：${(err && err.message) || err}`, 'warn');
          return { ok: false, reason: 'error' };
        }
        if (attempts >= 2) {
          return wholeWrite(client, {
            sid,
            name,
            key,
            text,
            synced: currentSynced,
            rescanRequired: true,
            session,
          });
        }
        attempts += 1;
        let fresh = null;
        try {
          fresh = await readServerBaseline(client, sid, name, session);
        } catch (err2) {
          fresh = null;
        }
        if (!sessionAlive(sid, session)) return { ok: false, reason: 'closed' };
        if (!fresh || fresh.authoritative !== true) {
          return wholeWrite(client, {
            sid,
            name,
            key,
            text,
            synced: fresh || currentSynced,
            rescanRequired: true,
            session,
          });
        }
        const nextHunks = diffCodePoints(fresh.text, text);
        if (nextHunks === null) {
          return wholeWrite(client, {
            sid,
            name,
            key,
            text,
            synced: fresh,
            rescanRequired: true,
            session,
          });
        }
        if (nextHunks.length === 0) {
          session.synced.set(key, { version: fresh.version, text, authoritative: true, source: 'commit' });
          return { ok: true, version: fresh.version, text };
        }
        currentSynced = fresh;
        currentHunks = nextHunks;
      }
    }
  };

  /** CAS 决议后同步基线（App 的覆盖/放弃两个分支共用）。 */
  const noteCasResolved = (systemId, name, version, text) => {
    const key = seKey(systemId, name);
    const session = sessionOf(systemId);
    if (!session) return;
    if (version !== undefined) session.version.set(key, version);
    session.synced.set(key, { version, text, authoritative: true, source: 'cas' });
  };

  // ── 基线 / 缓存的语义化访问（App 写路径：rename/delete/create/undo/exitEdit）──

  /** 同步基线读取（undoSeContent 等）。 */
  const baselineGet = (sid, name) => sessionOf(sid)?.synced.get(seKey(sid, name));
  /** CAS 版本读取（redoSeContent 等）。 */
  const versionGet = (sid, name) => sessionOf(sid)?.version.get(seKey(sid, name));
  /** 播种/更新 CAS 基线与对称文本（createStream / promote / redo 同口径）。 */
  const baselineSet = (sid, name, version, text) => {
    const key = seKey(sid, name);
    const session = sessionOf(sid);
    if (!session) return;
    session.version.set(key, version);
    // create / redo / promote 的成功整篇写入结果即服务端当前文本。
    session.synced.set(key, { version, text, authoritative: true, source: 'commit' });
  };
  /** 流删除后清基线（version + synced + consoleTail）。 */
  const baselineDelete = (sid, name) => {
    const key = seKey(sid, name);
    const session = sessionOf(sid);
    if (!session) return;
    session.version.delete(key);
    session.synced.delete(key);
    session.consoleTailOffset.delete(key);
  };
  /**
   * 缓存按 name re-key：`s-<oldName>` 相关的一切 seKey 缓存迁移到 `newName`。
   * 供 rename（oldName→newName）与 promote（oldName=null）复用（null 时 no-op）。
   */
  const baselineRekey = (sid, oldName, newName) => {
    if (oldName == null || newName == null) return;
    const session = sessionOf(sid);
    if (!session) return;
    const oldKey = seKey(sid, oldName);
    const newKey = seKey(sid, newName);
    for (const cache of [session.version, session.synced, session.consoleTailOffset]) {
      if (cache.has(oldKey)) {
        cache.set(newKey, cache.get(oldKey));
        cache.delete(oldKey);
      }
    }
    if (session.tags.has(oldName)) {
      session.tags.set(newName, session.tags.get(oldName));
      session.tags.delete(oldName);
    }
    // 可选加固：编辑中收到外部写的 stale 标记也随 name 迁移，避免遗留在旧 key。
    if (session.stale.has(oldKey)) {
      session.stale.delete(oldKey);
      session.stale.add(newKey);
    }
  };
  const staleHas = (sid, name) => !!sessionOf(sid)?.stale.has(seKey(sid, name));
  const staleDelete = (sid, name) => sessionOf(sid)?.stale.delete(seKey(sid, name));
  /** 流 name → 当前活动系统最近一次 stream.list 的原始 tags（含 edge.*）；流面板搜索可达边键。 */
  const tagsGet = (name) => {
    const sid = port().getActiveSystemId();
    return sid ? sessions.peek(sid)?.tags.get(name) : undefined;
  };
  /** 用户显式显示（取消隐藏）内部流：移出内部流标记，后续重投影不再反打 canvas:false。 */
  const unmarkInternal = (name) => {
    const sid = port().getActiveSystemId();
    sessions.peek(sid)?.internalMark.delete(String(name));
  };

  /**
   * 状态订阅扇出（原 boundSystemKey effect）：每系统一条 sePool.onStatus；
   * 重连判定（先在线过再掉线的 ONLINE 才触发 handleSeReconnected）+ 订阅兜底握手。
   * 返回清理函数（App effect 的 cleanup）。
   */
  const subscribeStatuses = (ids) => {
    const offs = ids.map((id) => {
      const session = ensureLifecycleSession(id);
      if (!session) return () => {};
      return sePool.onStatus(id, (st) => {
        // 会话已换（关闭/重开）：旧订阅回包不得写进新会话。
        if (!sessionAlive(id, session)) return;
        port().setSeStatus(id, st);
        const prev = session.prevStatus;
        if (prev === undefined) {
          session.prevStatus = st; // 首次回调只播种，不触发「重连」对账
          // 首个回调即 ONLINE（订阅已连接系统的状态回放）也要记录「曾在线」，
          // 否则该系统之后第一次真实重连会被 everOnline 门控跳过（第二次才生效）。
          if (st === SE_STATUS.ONLINE) session.everOnline = true;
        } else {
          if (st === SE_STATUS.ONLINE && prev !== SE_STATUS.ONLINE && session.hadOffline) {
            session.hadOffline = false;
            // 仅「先在线过再掉线」的真实重连才触发；首次连接（启动 spawn 抖动）交给
            // onConnected，避免把抖动当重连（Task5 起会连带触发 pending 提升）。
            if (session.everOnline) handleSeReconnected(id);
          } else if (st === SE_STATUS.OFFLINE) {
            session.hadOffline = true;
          }
          if (st === SE_STATUS.ONLINE) session.everOnline = true;
          session.prevStatus = st;
        }
        // 订阅兜底（A）：客户端 online 但尚未订阅（如 lazy-attach 的懒连接、
        // 或从未成为活动 tab 的系统）→ 补做连接握手。否则外部 stream.on_change 永远收不到，
        // 画布与 SE 真源静默脱节。会话订阅标记保证只做一次；已在握手路径中的系统跳过。
        if (st === SE_STATUS.ONLINE && !session.subscribed) {
          onConnected(id);
        }
      });
    });
    return () => offs.forEach((off) => off());
  };

  return {
    // 守卫
    epochOf,
    epochAlive,
    ownedNow,
    // 生命周期
    closeSystem,
    ensureSystem,
    prepareSystem,
    createSystem,
    endUnboundSystem,
    connectSystem,
    recoverSystem,
    findSystemOwner,
    onConnected,
    subscribeStatuses,
    // 投影 / 内容
    reproject,
    reprojectFresh: reproject,
    whenProjectionIdle,
    bumpProjectionEpoch,
    noteDeleted,
    clearDeleted,
    hasUnconfirmedMissing,
    readContent,
    commitContent,
    noteCasResolved,
    coordinatorFlush: (sid, reason) => coordinator.flush(String(sid), reason),
    // 基线 / 缓存
    baselineGet,
    versionGet,
    baselineSet,
    baselineDelete,
    baselineRekey,
    staleHas,
    staleDelete,
    tagsGet,
    unmarkInternal,
    // 自写 / 内部流
    markSelfWrite,
    isSelfWrite,
    persistInternalTag,
    // 上推 / journal
    pushFileStreams,
    projectToolsToSe,
    stashPendingPush: (sid, nodes) => {
      const session = sessionForHydration(sid);
      if (!session) return;
      session.pendingPush = nodes;
      (Array.isArray(nodes) ? nodes : []).forEach((node) => {
        const name = streamNameFromId(node && node.id);
        const sourcePath = node && node.data && node.data.source && node.data.source.file_path;
        if (!name || !sourcePath) return;
        const key = seKey(sid, name);
        session.synced.set(key, {
          version: session.version.get(key),
          text: node.data.content != null ? String(node.data.content) : '',
          authoritative: false,
          source: 'file-hydrated',
        });
      });
    },
    dropPendingPush: (sid) => {
      const session = sessionOf(sid);
      if (session) session.pendingPush = null;
    },
    // 运行时 driver 入口（tool/scan/process dispatch）
    runtimeEntry: (sid) => runtime.ensure(sid),
  };
}

