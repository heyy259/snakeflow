# SnakeFlow

SnakeFlow 是一个本地优先的图谱工作台：画布、流文档、工具与扫描状态保存在本机，
运行时的流/工具能力由独立的 [SnakeEats](https://github.com/heyy259/snakeeats)
Python 服务提供。两者通过本机回环 WebSocket JSON-RPC 通信，SnakeEats 也可以
脱离 SnakeFlow 单独使用。

界面基于 [React Flow](https://reactflow.dev/)（`@xyflow/react`）构建；SnakeFlow
不是 React Flow 官方项目。

## 环境要求

| 组件 | 要求 |
| --- | --- |
| 操作系统 | Windows 10/11，macOS 12+（开发也支持 Linux） |
| Node.js | `^20.19.0` 或 `>=22.12.0`（仅源码运行/构建需要） |
| Python | 3.10 或更高，由用户自行安装 |
| SnakeEats | `python -m pip install "snakeeats>=0.1,<0.2"` |

SnakeFlow 不会把 SnakeEats 安装到系统 Python，也不会自动下载 Python。
如果本机没有可用的 Python/SnakeEats，启动器会给出明确的安装指引；
画布与文档功能仍可在降级模式下使用。

## 快速开始

### 方式 A：便携包（面向普通用户）

1. 下载对应平台的 `snakeflow-<version>-<platform>.zip` 并解压。
2. Windows 双击 `start.cmd`；macOS 双击 `start.command`。
3. 首次启动会检查 Python 与 SnakeEats，然后打开浏览器。
4. 数据默认写入每用户数据目录，不写安装目录。

macOS 首次打开如被 Gatekeeper 拦截，请右键 `start.command` → 打开，
或在终端执行 `chmod +x start.command` 后再运行。

### 方式 B：源码运行

```bash
npm ci
python -m pip install "snakeeats>=0.1,<0.2"
npm run build
npm run build:server
npm start
```

开发模式（前端热更新，使用同一套服务端路由）：

```bash
npm run dev
```

诊断 SnakeEats 运行时：

```bash
npm run se:doctor
```

## SnakeEats 接入方式

配置文件的 `mode` 决定如何找到 SnakeEats：

| mode | 含义 | 适用场景 |
| --- | --- | --- |
| `auto` | 优先使用已安装到 Python 环境的 `snakeeats`，其次尝试开发目录 | 大多数用户 |
| `pip` | 只使用 `python -m snakeeats`，不要求源码目录 | 正式使用 |
| `dir` | 使用指定的 SnakeEats 源码目录（`packagePath`） | 开发者、便携双目录 |

`pip` 模式的启动命令为：

```bash
python -u -m snakeeats serve --port 0 --storage <dataRoot>/se-storage/<systemId>
```

不依赖 PATH 上的 `snake`，不注入 `PYTHONPATH`。`dir` 模式保留原有
`cwd=packageParent` 与 `PYTHONPATH` 行为。

## 数据与配置

安装模式（默认）：

| 内容 | Windows | macOS |
| --- | --- | --- |
| 数据根 | `%LOCALAPPDATA%\SnakeFlow` | `~/Library/Application Support/SnakeFlow` |
| 配置 | `<数据根>/config/app.config.json` | 同左 |
| 工作区 | `<数据根>/workspace` | 同左 |
| SnakeEats 存储 | `<数据根>/se-storage` | 同左 |
| 运行时元数据 | `<数据根>/runtime` | 同左 |
| 日志 | `<数据根>/logs` | 同左 |

便携模式（`--portable`）继续把数据放在应用目录内，方便整体拷贝。

**SnakeFlow 不会自动删除 `se-storage/` 或工作区文档。** 只有 `runtime/`
中可证明已失效的元数据会被清理。

## 文档

- [兼容性矩阵](COMPATIBILITY.md)
- [安全模型](SECURITY.md)
- [贡献指南](CONTRIBUTING.md)
- [更新日志](CHANGELOG.md)
- [运行时定位与配置](docs/SE运行时定位与配置.md)

## 许可证

MIT，见 [LICENSE](LICENSE)。
