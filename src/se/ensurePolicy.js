// SE「启动 / 切换标签时自动 attach-or-spawn」的纯决策逻辑。
//
// 抽成独立模块（无 React / DOM / 网络 / 定时器依赖）是为了可确定性单测，见
// scripts/smoke-se-ensure-unit.mjs。App.jsx 的 attachOrSpawn / ensureSystem 只做 I/O，
// 「是否允许自动拉起 → 下一步动作」的判断全部委托这里，避免逻辑散在组件里无法验证。

/**
 * 依据「是否允许自动拉起」决定 ensure 的第一步。
 *
 * 生命周期收口（需求1/需求A-E）：启动**不再 attach 到已运行的 SE**——SE 是「一次性执行器」，
 * 每次启动全新拉起；无归属/己方残留的存活 SE 由 Node 侧按 `.owner.json`/registry 端口回收后全新
 * spawn。因此本函数只看「是否允许自动拉起」（端点探测状态不参与决策）：
 * - allowSpawn=true  → 'spawn'（Node 侧先回收残留再全新起）；
 * - allowSpawn=false → 'attach'（用户明确不自动拉起，只能挂接现存实例）。
 *
 * @param {boolean} allowSpawn 是否允许自动拉起（对应偏好开关/preflight 能力）
 * @returns {'attach'|'spawn'}
 */
export function planEnsure(allowSpawn) {
  return allowSpawn ? 'spawn' : 'attach';
}

/**
 * 依据 `attachOrSpawn` 的返回值决定后续动作。
 *
 * @param {{ok?: boolean, status?: string, error?: string}|null|undefined} result
 * @returns {'attach'|'lazy-attach'|'error'}
 *   - attach      → 连接（WS + system.info 身份校验 + 静默回灌）
 *   - lazy-attach → 另一实例正在拉起（spawn 排他锁命中）：只建客户端，靠 WS 自动重连收敛，不报错
 *   - error       → 拉起 / 探测失败（含 owned-by-other-vite / port-unverifiable），带 error 交上层提示
 */
export function planSpawnOutcome(result) {
  const status = result && result.status;
  if (result && result.ok && status === 'online') return 'attach';
  if (status === 'locked') return 'lazy-attach';
  return 'error';
}
