// SE 每系统会话（per-SID session）状态所有权。纯模块：无 React / DOM / 网络依赖。
//
// 为什么需要会话对象：这些状态全部是「关标签页即失效」的——版本基线 / 同步基线 /
// console 偏移 / 自写抑制 / 内部流标记 / 删除 tombstone / 缺失修复账本 / 状态历史 /
// 离线暂存上推。它们曾经是一堆各自按 sid 索引的独立 Map，closeSystem 必须逐张清空，
// 漏一张就会让旧 SE 的状态存活到新会话。现在它们是同一个 session 的字段：确认最终
// 关闭时整对象丢弃（并清计时器），失败关闭整对象保留。
//
// 不在此模块的「全局生命周期」状态：seEpoch / seEnding / ensureInflight / 连接池 /
// 运行时 driver / 对账协调器 / 投影串行队列——那些由 orchestrator 私有持有，跨会话
// 共享，关闭时按现有顺序单独清理。
//
// 键形状保持不变：版本类缓存仍用 orchestrator 的 `${sid} ${name}` seKey。

/**
 * 新建一个 per-SID 会话。
 * @param {string} systemId
 */
export function createSeSession(systemId) {
  return {
    sid: String(systemId),
    // 内容 / 版本（键形 `${sid} ${name}`）
    version: new Map(), // seKey → 最近记录的 version（CAS 依据）
    synced: new Map(), // seKey → {version,text,authoritative,source}
    consoleTailOffset: new Map(), // seKey → 内部流已消费的服务端绝对偏移
    stale: new Set(), // seKey：编辑期间收到外部写、暂不打断光标
    selfWrite: new Map(), // seKey → expiry epoch ms（短 TTL 自写抑制）
    // 流 name 键控（必须按会话隔离，避免不同系统同名流交叉污染）
    tags: new Map(), // name → 最近一次 stream.list 的原始 tags（含 edge.*）
    internalMark: new Set(), // 已决定隐藏的内部流 name
    internalMarking: new Set(), // 在飞 set_tag 去重
    // 状态历史（重连判定）
    prevStatus: undefined,
    hadOffline: false,
    everOnline: false,
    // 离线暂存的文件→SE 上推
    pendingPush: null,
    // 删除意图 / 缺失修复 / 投影世代
    deletedTombstones: new Map(), // name → {at,cause}
    unconfirmedMissing: new Set(), // 最近投影里「缺失但未确认删除」的 name
    repairing: new Set(), // 差集修复在飞 name 去重
    repairCooldown: new Map(), // name → 冷却截止时间
    missingNotice: null, // {sig, at}：缺失告警去重
    projectionEpoch: 0, // rename / 显式删除成功后 bump
    // 正文读取调度
    readTimers: new Map(), // seKey → 防抖计时器
    reading: new Set(), // seKey：per-stream 单飞
    // 订阅
    subscribed: false,
  };
}

/**
 * 清空会话内全部可变状态。幂等；对象丢弃前调用。
 * @param {ReturnType<typeof createSeSession>|null|undefined} session
 */
export function disposeSeSession(session) {
  if (!session) return;
  for (const timer of session.readTimers.values()) clearTimeout(timer);
  session.readTimers.clear();
  session.version.clear();
  session.synced.clear();
  session.consoleTailOffset.clear();
  session.stale.clear();
  session.selfWrite.clear();
  session.tags.clear();
  session.internalMark.clear();
  session.internalMarking.clear();
  session.prevStatus = undefined;
  session.hadOffline = false;
  session.everOnline = false;
  session.pendingPush = null;
  session.deletedTombstones.clear();
  session.unconfirmedMissing.clear();
  session.repairing.clear();
  session.repairCooldown.clear();
  session.missingNotice = null;
  session.projectionEpoch = 0;
  session.reading.clear();
  session.subscribed = false;
}

/**
 * sid → session 的所有权表。`owns` 是跨 await 的身份守卫：旧会话的迟到回包
 * 必须在落地前确认 sid 仍映射到同一个 session，否则 no-op。
 */
export function createSessionStore() {
  const sessions = new Map();

  /**
   * 创建/取会话：仅供**显式生命周期**入口调用（onConnected / subscribeStatuses）。
   * 普通读写一律走 peek，确认关闭后绝不通过 ensure 复活会话。
   */
  const ensure = (systemId) => {
    const key = String(systemId);
    let session = sessions.get(key);
    if (!session) {
      session = createSeSession(key);
      sessions.set(key, session);
    }
    return session;
  };

  /** 只读查看：不创建会话（普通读写 / name 键控缓存 / 跨 await 身份校验都走这里）。 */
  const peek = (systemId) => sessions.get(String(systemId)) || null;

  /** sid 当前是否仍映射到给定会话对象。 */
  const owns = (systemId, session) =>
    !!session && sessions.get(String(systemId)) === session;

  /** 丢弃会话：先从所有权表移除（并发迟到回包立即失效），再清空状态。 */
  const drop = (systemId) => {
    const key = String(systemId);
    const session = sessions.get(key);
    if (!session) return null;
    sessions.delete(key);
    disposeSeSession(session);
    return session;
  };

  return { ensure, peek, owns, drop };
}
