# 交接：SeSupervisor 实例化与请求路径异步 I/O

本文交接两项技术债。它们不阻塞当前 Windows 发布，但会影响多实例隔离、慢磁盘/OneDrive 下的响应时间和长期可维护性。
不要继续在这两项上叠加补丁；按 wrap → switch → delete 顺序处理。

## 1. SeSupervisor 实例化

### 当前状态

- `server/se/state.js` 持有模块级 `seSpawnedSystems`、`seSpawnInflight`、`activeSpawnNonces`、`seUpstreams`。
- `server/se/process.js` 的 spawn/reclaim/kill/list 直接使用这些全局 Map。
- `server/se/supervisor.js` 只是组合层包装，返回 `{paths, spawnSeSystem, listSeSystems, installExitHooks}`。

### 风险

- 同一进程内创建两个 `createAppRuntime` 会共享子进程和锁，无法可靠支持多实例。
- 测试之间可能互相 kill 或误回收。
- Vite 重启/HMR 时状态归属隐式，后续修改很容易引入跨实例竞态。

### 目标

`createSeState()` 返回每个 supervisor 独立的状态容器，`SeSupervisor` 实例拥有它：

```js
const supervisor = createSeSupervisor({ paths });
await supervisor.spawnSeSystem(systemId, options);
await supervisor.listSeSystems();
await supervisor.end(systemId);
supervisor.installExitHooks();
await supervisor.dispose();
```

- 所有 spawn/reclaim/lock/owner/upstream 状态都挂在实例上。
- `createAppRuntime` 持有唯一 supervisor；测试可创建多个实例且互不影响。
- 不再有 `server/se/state.js` 的模块级可变 Map；常量可以保留。

### 迁移顺序

1. **Wrap**：`createSeState()` 与 `createSeSupervisor()` 先包装现有全局状态，函数签名增加可选 `state`，默认旧全局实例。
2. **Switch**：`process.js`、`registry.js`、`resolve.js`、`api.js`、`proxy.js`、`gracefulEnd.js` 改为显式接收 `state`；`createAppRuntime` 创建实例并传递。
3. **Delete**：移除默认全局 Map 和 `state.js` 的可变状态；删除 `installSeExitHooks` 的全局安装标志，改为实例级 `dispose()`。

### 不变量

- 一个 storage root 只有一个 SnakeEats 写者。
- token 仍只在 Node 内存，不落盘。
- 单实例行为与现有一致，不引入第二套生命周期实现。
- 不新增锁/owner 机制，只改变状态归属。

### 验收

- 同进程两个 supervisor 使用不同 `dataRoot`，可同时 spawn 不同系统且互不影响。
- 关闭 A 不影响 B 的子进程和 registry。
- `dispose()` 只清理本实例子进程。
- `npm run test:se`、`npm run test:smoke`、`npm run test:parity` 全绿。
- 不再有模块级可变 SE 状态；`server/se/state.js` 只剩常量。

工作量估计：2–4 天，中高风险。macOS 发布稳定前不建议开始。

## 2. 请求路径异步 I/O

### 当前热点

- `server/graphsApi.js`：大量 `readFileSync/writeFileSync/readdirSync/mkdirSync`。
- `server/se/registry.js`：`readFileSync/writeFileSync/mkdirSync`。
- `server/se/process.js`：`mkdirSync/readFileSync/writeFileSync/statSync`。
- `server/se/identity.js`：同步 `readdirSync/mkdirSync`。
- `server/se/runtime/seRuntime.js` 已改为异步解析，但其它热点仍在。

### 风险

- OneDrive/慢磁盘下请求阻塞 Node 事件循环，表现为 UI 假死、WS 超时和 `system.info timeout`。
- 每个请求都重复 `mkdirSync`，会放大延迟。

### 目标

请求路径统一使用 `fs/promises`：

- `readJson` / `writeJson` / `listDir` / `ensureDir` 共用一套异步原语；
- 原子写继续 tmp + rename，保留 Windows/OneDrive 重试；
- `.spawn.lock` 与 `.owner.json` 只在 `runtime/`，读写在 supervisor 内异步完成；
- `findListeningProcess`/`getProcessStartTime` 仅作为旧版回退，主路径用 `system.info.pid`；
- 进程死亡等待改异步，不在请求路径自旋。

### 迁移顺序

1. 先提取 `readJson/writeJson/listDir/ensureDir`，保持返回形状一致。
2. `registry.js`、`identity.js` 改为异步。
3. `process.js` 的 spawn 状态机改异步。
4. `graphsApi.js` 按端点逐个替换，删除每请求 `mkdirSync`，改为按目录缓存 ensure。

### 不变量

- API 响应、错误码、owner/registry 文件格式不变。
- 不丢数据、不改变锁语义、不引入新的删除路径。
- 不新增依赖。

### 验收

- 慢磁盘/OneDrive 下 preflight、create、end 不再出现 `system.info timeout`。
- 并发请求时 `system.info` 仍能返回，事件循环不被整段阻塞。
- `npm run test:se`、`npm run test:smoke`、`npm run test:parity` 全绿。
- CJK/空格路径、Windows OneDrive 路径仍通过。

工作量估计：2–3 天，中风险。

## 建议顺序

- 如果近期要多实例/多窗口，先做 **SeSupervisor 实例化**。
- 如果主要是普通用户启动慢、WS 超时，先做 **异步 I/O**。
- 不要两项同时进行，避免把生命周期状态机和 I/O 语义一起改坏。

## 相关文件

- `server/se/state.js`
- `server/se/supervisor.js`
- `server/se/process.js`
- `server/se/registry.js`
- `server/se/identity.js`
- `server/se/resolve.js`
- `server/se/api.js`
- `server/graphsApi.js`
- `server/se/runtime/seRuntime.js`
