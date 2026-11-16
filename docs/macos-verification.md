# macOS 实机验收清单

本清单用于验证 SnakeFlow 在 macOS 上的一键启动、SnakeEats 接线、数据所有权和进程生命周期。
Windows 上已通过的 `start.cmd`/内嵌 Node 用例不替代本清单。

## 前置条件

- macOS 12 或更高。
- 源码运行：Node `^20.19.0 || >=22.12.0`。
- 便携包：解压 `snakeflow-<version>-mac-arm64.zip`（或 `mac-x64.zip`）。
- Python 3.10+，并执行一次：
  ```bash
  python3 -m pip install "snakeeats>=0.1.0,<0.2.0"
  ```
- 开发目录模式则准备 SnakeEats 源码目录，并设 `SE_PACKAGE_PATH`。

## 1. 启动与诊断

```bash
chmod +x start.command start.sh
./start.command --doctor
```

预期：

- 返回 `available: true`；
- `mode` 为 `pip`（或 `dir`）；
- `version` 为 SnakeEats 包版本，`pythonVersion` 为 Python 版本；
- `protocol_version` 在 spawn 握手后为 1；
- 不使用系统 `snake` 命令，也不要求 `snake init`。

如果系统没有 Node，使用内嵌 Node 的 zip，`./start.command --doctor` 仍应成功。

## 2. 一键启动与流读写

```bash
./start.command
```

预期：

- 浏览器打开 `http://127.0.0.1:5173`；
- 新建图谱后 SE 显示 online；
- 创建流、写入正文、重新打开后正文一致；
- `system.info` 返回 `system_id`、`port`、`pid`、`instance_id`、`protocol_version`、`version`。

## 3. 数据目录与所有权

默认安装模式：

- `~/Library/Application Support/SnakeFlow/workspace`
- `~/Library/Application Support/SnakeFlow/se-storage`
- `~/Library/Application Support/SnakeFlow/runtime`

检查：

- `se-storage/<systemId>/` 内只有 SnakeEats 的 registry/journal/snapshots/scan/control；
- `runtime/<systemId>/.owner.json` 存在，且不在 `se-storage/` 内；
- 不会自动删除 `se-storage/` 或工作区文档；
- 旧 `graphs/`、`se-systems/` 只被复制，不被删除。

便携模式：

```bash
./start.command --portable
```

预期：数据仍放在应用目录内，方便整体迁移。

## 4. 进程退出与孤儿检查

关闭启动器后：

```bash
ps -ef | grep snakeeats | grep -v grep
lsof -i :<SE-port> 2>/dev/null || true
```

预期：

- 没有残留的 `python -m snakeeats serve` 进程；
- SE 端口不再监听；
- `runtime/` 中不会留下指向活进程的 `.spawn.lock`。

如果仍有进程，记录其 `pid`，并检查 `runtime/<systemId>/.owner.json` 中的 `listenerPid` 是否一致。
SnakeFlow 应优先使用 `system.info.pid`，不要求 `lsof`。

## 5. 进程组清理

```bash
ps -o pid,pgid,command -p <se-pid>
```

SnakeFlow 在 POSIX 上使用 detached 子进程和进程组：
`kill -TERM -<pgid>` 应能清理整个组；`kill -KILL -<pgid>` 仅作兜底。
不需要 `taskkill`、PowerShell 或 `wmic`。

## 6. 文件对话框与绝对路径

- 保存/打开图谱对话框由 `osascript` 提供，不应出现 `powershell.exe` 错误。
- 文件侧栏搜索范围输入 `/Users/<你的用户名>/...` 应被接受，不能误报为相对路径。
- 可执行扩展名拦截应包含 `.app`、`.command`、`.sh`，而不只 Windows 扩展名。

## 7. Gatekeeper

首次打开被拦截时：

- 右键 `start.command` → 打开；或
- `xattr -dr com.apple.quarantine start.command`；
- 然后重试 `./start.command --doctor`。

## 8. 需要保存的证据

- `./start.command --doctor` 输出；
- `system.info` 输出；
- `runtime/<systemId>/.owner.json`；
- `ps -ef | grep snakeeats` 的输出；
- 首启、创建流、关闭后的截图或日志；
- 若失败，记录 macOS 版本、Node/Python 版本、`SE_MODE`、`dataRoot` 和完整错误。

## 常见失败与处理

| 现象 | 处理 |
| --- | --- |
| `command not found` | 先 `chmod +x start.command start.sh` |
| `ModuleNotFoundError: snakeeats` | `python3 -m pip install "snakeeats>=0.1.0,<0.2.0"` |
| `storage root already owned` | 用 `runtime/` 的 owner 信息确认旧进程并停止它，不要手删 storage |
| 写入失败 / 只读 | 确认 `dataRoot` 可写，且不在 iCloud/OneDrive 同步目录 |
| 对话框无响应 | 检查是否被 Gatekeeper 阻止，或改用浏览器文件选择路径 |
