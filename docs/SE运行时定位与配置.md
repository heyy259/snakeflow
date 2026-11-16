# SnakeEats 运行时定位与配置（现行）

本文描述 SnakeFlow 如何定位 Python/SnakeEats、如何隔离数据，以及 HTTP/WS 的安全边界。
`docs/archive/` 中的旧表述不再适用。

## 1. 运行时解析（RuntimeProvider）

`server/se/runtime/seRuntime.js` 是唯一解析入口，返回 `{ mode, python, packageParent, versionRange, probe }`。

| mode | 行为 | 适用 |
| --- | --- | --- |
| `auto` | 先尝试已安装到 Python 环境的 `snakeeats`（pip），失败后尝试 `../snakeeats` 源码目录 | 默认 |
| `pip` | 只使用 `python -m snakeeats`，不要求源码目录 | 正式使用 |
| `dir` | 使用 `packagePath` 指定的 SnakeEats 源码目录 | 开发者、便携双目录 |

优先级：`SE_MODE` > 配置文件 `mode` > `auto`。Python/包路径优先级：
`SE_PYTHON` / `SE_PACKAGE_PATH` > 配置文件 `python` / `packagePath` > 自动候选。
显式值无效时 fail-fast，不回退到自动候选。

`pip` 模式：

```bash
<python> -u -m snakeeats serve --port 0 --storage <dataRoot>/se-storage/<systemId>
```

- 不注入 `PYTHONPATH`，`cwd = dataRoot`；
- probe 验证 `import snakeeats` 与 `serve --help`，并读取包版本；
- `snakeeats.__file__` 位于应用目录内时拒绝（防止本地影子包）。

`dir` 模式保留 `cwd = packageParent` 与 `PYTHONPATH = packageParent + 继承值`。

## 2. 配置文件（schema v2）

默认位置：

- Windows：`%APPDATA%\SnakeFlow\se.config.json`
- macOS/Linux：`$XDG_CONFIG_HOME/SnakeFlow/se.config.json` 或 `~/.config/SnakeFlow/se.config.json`
- 安装模式额外读取 `<dataRoot>/config/app.config.json`
- `SE_CONFIG` 可显式指定；旧的 `reactflow/se.config.json` 仍可读（v1 迁移）。

示例（`se.config.example.json`）：

```json
{
  "schemaVersion": 2,
  "mode": "auto",
  "python": "auto",
  "packagePath": "",
  "versionRange": ">=0.1.0 <0.2.0",
  "server": { "port": 5173, "host": "127.0.0.1" },
  "dataRoot": "auto",
  "portable": false
}
```

- `python`：`auto`、空串或解释器绝对路径；
- `packagePath`：SnakeEats 包父目录或包目录（仅 `dir`）；
- `versionRange`：SnakeEats 包版本区间，预检与 spawn 握手都会校验；
- `portable`：`true` = 数据放应用目录；`false` = 每用户数据目录；
- `dataRoot`：`auto` 或绝对路径，可被 `RF_DATA_ROOT` 覆盖；
- `server.port` / `server.host`：HTTP 监听地址与端口。

v1 `{python, snakeeatsPath}` 按 `mode: "dir"` 只读兼容。

## 3. 数据与所有权（AppPaths）

`server/appPaths.js` 统一计算四根：

| 根 | 安装模式 | 便携/旧开发模式 |
| --- | --- | --- |
| `appRoot` | 只读安装目录 | 项目根 |
| `dataRoot` | `%LOCALAPPDATA%\SnakeFlow` 或 `~/Library/Application Support/SnakeFlow` | 项目根 |
| `workspaceRoot` | `<dataRoot>/workspace` | `<项目根>/graphs` |
| `seSystemsDir` | `<dataRoot>/se-storage` | `<项目根>/se-systems` |
| `runtimeDir` | `<dataRoot>/runtime` | 同 `seSystemsDir` |

- SnakeEats 独占 `se-storage/`（registry/journal/snapshots/scan/control）。
- SnakeFlow 独占 `runtime/`（`.spawn.lock`、`.owner.json`、进程身份）。
- **不会自动删除 `se-storage/` 或工作区文档**；只有 `runtime/` 中可证明失效的元数据会被清理。
- 首次安装模式启动会把旧 `graphs/`、`flows/`、`se-systems/` 复制到新根，写 `migration.json`，不删除旧目录。

## 4. HTTP / WebSocket 安全边界

所有 `/api/*` 与 `/api/se/ws` 都经过同一个 `SecurityGate`：

- Host/Origin 必须精确匹配 `http://127.0.0.1:<实际端口>` 或 `http://localhost:<实际端口>`；
- 浏览器先 `GET /api/session` 获取每进程随机 session secret；
- 后续 HTTP 请求带 `X-RF-Session`，WebSocket 带 `?s=<secret>`；
- 非浏览器客户端可用 `Authorization: Bearer <secret>`；
- 拒绝其他端口、其他主机、无 secret 的请求。

SnakeEats root token 仍只在 Node 内存中生成并注入子进程环境，绝不进入 argv、配置文件或浏览器。

## 5. 启动方式

开发（Vite）：

```bash
npm run dev
```

生产（独立 Node 服务器，与 Vite 共用同一套路由）：

```bash
npm run build
npm run build:server
npm start
```

诊断：

```bash
npm run se:doctor
```

预检返回 `{ available, mode, python, packageParent, version, pythonVersion, versionRange, reason }`。
