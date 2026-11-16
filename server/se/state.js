// SE 子系统共享常量与进程内可变状态（单例）。
// 运行时定位（python/包父目录）统一由 shared/seRuntime.js 负责，本模块不再持有候选路径。
export const SE_DEFAULT_HOST = '127.0.0.1';
export const SE_ENV_ADMIN_TOKEN = 'SNAKEEATS_ADMIN_TOKEN';
// 代理侧约定：token 缺失 / auth 失败时关闭浏览器连接的 close code。
export const SE_CLOSE_TOKEN_UNAVAILABLE = 4401;
// 上游不可达 / 未就绪（可重连，浏览器保持离线并退避重试）。
export const SE_CLOSE_OFFLINE = 1011;
// /api/se/*（HTTP + WS upgrade）的 Host/Origin 白名单：仅本机回环。
// 此白名单是代理唯一安全闸门：不打 = 恶意网页经 DNS rebinding 借浏览器
// 驱代理 = 本机 RCE（tool.register / control.* 需 root）。不可省。
export const SE_ALLOWED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// 期 2 spawn 注入位：system_id → {port, token, pid, storageDir, child}
// （见 SE接线方案.md §5.5）。token 只在此 Node 内存留存，绝不落盘/下发。
export const seSpawnedSystems = new Map();
// system_id → 进行中的 spawn Promise（进程内并发闸门，防多 tab 同系统双 spawn）。
export const seSpawnInflight = new Map();
// 本进程在途 spawn 的 nonce 集合，供锁文件区分「本进程活持有」与「残留」。
export const activeSpawnNonces = new Set();
// system_id → 上游 SE 连接（一系统一条，多浏览器连接扇入）。
export const seUpstreams = new Map();

// ── SE 生命周期（期 2）配置 ─────────────────────────────────────────────────
export const SE_ENV_PYTHON = 'SE_PYTHON';
export const SE_ENV_PACKAGE_PATH = 'SE_PACKAGE_PATH';
export const SE_SPAWN_READY_TIMEOUT_MS = 15000;
export const SE_SPAWN_POLL_MS = 300;
export const SE_RPC_TIMEOUT_MS = 8000;
// storage 排他锁：陈旧阈值 + 锁文件名。
export const SE_LOCK_STALE_MS = 120000;
export const SE_LOCK_NAME = '.spawn.lock';
// 收到 exit 后等待 stdio 'close' 的上限：Windows 上最后一行 stderr 可能晚于 exit 到达。
export const SE_STDERR_CLOSE_GRACE_MS = 500;
// 期 5 进程归属：我们 spawn 的 SE 在 storage 目录留 .owner.json（{pid, vitePid, port, at}），
// 用于跨 vite 进程区分「我们起的」（可回收）与用户手动起的（绝不回收/终止）。vitePid 让启动时
// 能判定「己方硬杀残留」而非「另一活 vite 的实例」（§5.1 / Oracle Q3）。
// 注：`.se-token` 已废弃不再持久化（其存在会导致硬杀重启误 attach，见 resolveSeToken）。
export const SE_OWNER_NAME = '.owner.json';
export const SE_TOKEN_NAME = '.se-token';
