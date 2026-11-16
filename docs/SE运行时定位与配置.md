# SE 运行时定位与配置（现行）

- 日期：2026-10-24
- 状态：**现行权威文档**；`docs/archive/` 中与本主题冲突的旧表述以本文为准。
- 适用：reactflow 本体（Vite server + `scripts/` 测试）如何定位 snakeeats（SE）的 Python 解释器、包目录与项目根。

---

## 1. 目的与非目标

### 1.1 目的

1. 新机器/新用户无需修改源码即可定位 Python 与 snakeeats 包；
2. 生产（Vite server）与测试（`scripts/`）共用同一条解析、探测、spawn 链路；
3. 显式配置错误可见、可诊断，且**不静默连到错误的 SE**；
4. 仓库内不出现机器绝对路径；机器本地配置不随仓库同步。

### 1.2 非目标

- **不**迁移或配置 `se-systems` 存储位置（固定为 `<projectRoot>/se-systems`）；
- **不**增加端口/token 配置：SE 始终 `--port 0`（系统分配端口），token 仅存于 Node 内存；
- **不**修改 snakeeats 代码，也不改变其启动合同；
- **不**做 sibling/递归目录扫描或网络路径枚举来自动发现 SE；
- **不**把机器本地配置放进仓库默认读取路径。

---

## 2. 配置位置与优先级

### 2.1 配置文件位置

| 优先级 | 位置 |
|---|---|
| 1 | 环境变量 `SE_CONFIG` 指向的文件（CI/多 checkout 推荐） |
| 2 | Windows：`%APPDATA%\reactflow\se.config.json` |
| 3 | macOS/Linux：`$XDG_CONFIG_HOME/reactflow/se.config.json`，未设置则 `~/.config/reactflow/se.config.json` |
| 4 | 文件不存在 → 仅使用 env + 自动候选（**允许**，不是错误） |

仓库根目录的 `se.config.example.json` 只是格式示例，**运行时不读取**。本仓库可能位于 OneDrive 等同步目录，仓库内“本机配置”会被跨机同步，因此明确不支持把 `se.config.json` 放在仓库里提交。

### 2.2 优先级（逐项独立）

```
env（SE_PYTHON / SE_PACKAGE_PATH）
  > 配置文件（python / snakeeatsPath，逐项独立生效）
  > 固定自动候选（逐个探测，先通过先用）
  > 不可用（UNAVAILABLE）
```

规则：

- **空字符串 = 未设置**（与 snakeeats `env._clean` 语义一致）。
- 配置文件可以只提供 `python` 或只提供 `snakeeatsPath`，未提供的项继续走自动候选；`sources` 会逐项标注来源。
- `python: "auto"` 与空串等价，表示自动探测。
- 显式来源（env/config）**无效时不得回退**：结果为 UNAVAILABLE，`reason` 包含来源、值与修复建议。自动候选只用于“该项未显式设置”的情况。
- 解析结果不缓存：改配置后无需重启即可在下次 preflight / spawn 生效。
- **应用仍会启动**：运行时解析永不 throw；不可用时 preflight 返回 `available:false` 与 `reason`，由应用横幅展示。

配置来源标注 `sources` 取值：`env` | `config` | `auto`。

---

## 3. 配置 Schema（v1，严格）

只允许两个键，值必须为字符串：

```json
{
  "python": "",
  "snakeeatsPath": "../../MAX/heyy259/改造中的副本"
}
```

- **仅支持 JSON**：零字节、非法 JSON、顶层不是对象、含注释/JSONC 均视为配置错误。
- **未知键会被拒绝**（防拼写错误被静默忽略）。
- `python`：
  - 空串或 `"auto"` → 自动探测；
  - 其他值 → 显式解释器路径（必须是真实存在的文件）。
- `snakeeatsPath`：指向以下两者之一：
  - **包父目录**：`<p>/snakeeats/__init__.py` 存在；
  - **包目录**：`<p>/__init__.py` 存在且 `basename(p) === "snakeeats"`，此时父目录 = `dirname(p)`。
  - 空串无效；相对路径按 **`projectRoot`** 解析（不按 cwd，也不按配置文件所在目录）。
- 配置文件可只写一个键；缺失的键继续走自动候选。

> 示例中的 `../../MAX/heyy259/改造中的副本` 对应当前 `tools/reactflow` 与 `MAX/heyy259/改造中的副本` 的并排布局。换布局时按实际相对关系改写。

---

## 4. 自动候选（固定列表，不做目录扫描）

只有“该项未显式设置”时才使用自动候选。每个候选都必须先通过基本检查（文件存在 / 含 `snakeeats/__init__.py`）才进入探测。

### 4.1 Python 候选（按顺序）

| 平台 | 候选 |
|---|---|
| 通用 | `<projectRoot>/.venv/Scripts/python.exe`（Windows）或 `<projectRoot>/.venv/bin/python`（POSIX） |
| Windows | `py -3 -c "import sys;print(sys.executable)"`（优先于 PATH，避免 Store 别名） |
| Windows | `where python` / `where python3`，排除 `WindowsApps` 别名 |
| POSIX | `which python3` / `which python` |
| 通用 | `~/anaconda3/python.exe`、`~/miniconda3/python.exe`、`~/AppData/Local/Programs/Python/Python3*/python.exe` |

### 4.2 包父目录候选（固定顺序）

1. `<projectRoot>/../../MAX/heyy259/改造中的副本`（当前两仓库相对布局，跨机器可移植）；
2. `<projectRoot>/../snakeeats`（并排 clone 且仓库根名为 `snakeeats`）；
3. 环境变量 `OneDrive` / `OneDriveCommercial` / `OneDriveConsumer` 下的 `programing/MAX/heyy259/改造中的副本`；
4. `~/OneDrive/programing/MAX/heyy259/改造中的副本`；
5. `~/OneDrive/programing/MAX/heyy259/SnakeEats`；
6. `~/OneDrive/programing/MAX/SnakeEats`。

**明确禁止**：递归扫描、sibling 全目录扫描、网络路径枚举。自动探测总次数有上限（12 次），避免旧副本过多时长时间卡住。

---

## 5. 探测与 spawn 规格

### 5.1 能力探测（唯一实现：`shared/seProbe.js`）

探测与 spawn 使用同一套环境构造（`shared/seSpawnSpec.js` 的 `buildSeEnv`）：

- `cwd = packageParent`
- `PYTHONPATH = packageParent + path.delimiter + 继承的 PYTHONPATH`（**追加，不替换**）
- `PYTHONIOENCODING = "utf-8"`（CJK 路径必需）
- `windowsHide: true`、`shell: false`、`encoding: "utf-8"`、超时 15s

两步探测：

1. `python -c "import snakeeats,sys;print(snakeeats.__file__);print('%d.%d'%sys.version_info[:2])"`
   - 必须退出码 0；
   - `snakeeats.__file__` 必须是绝对路径且位于 `packageParent` 之下；否则判定为 shadow（疑似 site-packages / 错误 `PYTHONPATH` 抢先命中）。
2. `python -m snakeeats serve --help`
   - 退出码必须为 0，用于验证 `__main__` → CLI → `serve` 子命令入口完整可用。

### 5.2 spawn 规格（唯一实现：`shared/seSpawnSpec.js`）

```text
command = <python>
args    = -u -m snakeeats serve --port 0 --storage <绝对路径>
cwd     = <packageParent>
env     = 继承环境
          + PYTHONPATH = packageParent + delimiter + 继承值
          + PYTHONIOENCODING = utf-8
          + SNAKEEATS_INSTANCE_LOCK_TIMEOUT = 1
          + SNAKEEATS_SYSTEM_ID（有值时）
          + SNAKEEATS_ADMIN_TOKEN（仅内存 token，有值时）
```

- **禁止**新增 `--token` / `--system-id` / `--manifest`（server 不传 manifest）。
- token 绝不进入配置文件、命令行或日志。
- `--storage` 始终为绝对路径（来自 `server/paths.js` 的 `seSystemsDir`，即 `<projectRoot>/se-systems`）。
- `<storage>/registry/.registry.json` 的形状与 `system.info.system_id` 校验保持不变。

---

## 6. Doctor：`npm run se:doctor`

只读诊断，不写文件、不启动 SE（只跑 `import` 与 `serve --help`）。退出码：可用 `0`，不可用 `1`。

输出内容：

- 配置搜索路径、是否存在、解析错误；
- `python` / `packageParent` 的最终值与来源（env/config/auto）；
- 探测详情：Python 版本、`snakeeats.__file__`、`serve --help` 结果；
- `projectRoot` 与 `se-systems` 路径；
- OneDrive 存储 warning（单写者锁仅同机有效，不转为失败）；
- 可粘贴的 JSON 模板与下一步建议。

### 6.1 当前机器实测示例（2026-10-24）

> 以下绝对路径仅为本机示例，**不要原样提交到仓库**。迁移后请重新运行 doctor。

```text
SE 运行时诊断（只读）
项目根：C:/Users/demo\OneDrive\programing\tools\reactflow

== 配置 ==
配置文件：C:/Users/demo\AppData\Roaming\reactflow\se.config.json
  存在：否

== 运行时 ==
结果：OK
python：C:\Python313\python313\python.exe（来源：auto）
packageParent：C:/Users/demo\OneDrive\programing\MAX\heyy259\改造中的副本（来源：auto）
探测：import snakeeats + serve --help ok
Python 版本：3.13
模块文件：C:/Users/demo\OneDrive\programing\MAX\heyy259\改造中的副本\snakeeats\__init__.py

== 存储 ==
se-systems：C:/Users/demo\OneDrive\programing\tools\reactflow\se-systems
WARNING: storage on OneDrive: single-writer lock is same-machine only（projectRoot=...；se-systems=...）

== 可粘贴配置（%APPDATA%\reactflow\se.config.json 或 SE_CONFIG 指向的文件）==
{
  "python": "D:\\programfiles\\python313\\python.exe",
  "snakeeatsPath": "C:/\Users\\example\\OneDrive\\programing\\MAX\\heyy259\\改造中的副本"
}
注意：上述绝对路径与机器相关，迁移到另一台机器时请改用相对路径或重新运行本诊断。
```

---

## 7. 迁移步骤（新机器 / 新用户）

1. clone reactflow 与 snakeeats（保持当前并排布局，或记住实际路径）；
2. 在 reactflow 内执行 `npm install`；
3. 运行 `npm run se:doctor`，确认能否自动定位 Python 与包；
4. 若自动定位失败或想固定值：
   - 把 `se.config.example.json` 复制为 `%APPDATA%\reactflow\se.config.json`（POSIX：`~/.config/reactflow/se.config.json`）；
   - 按实际环境编辑；优先使用**相对路径**（按项目根解析），例如：
     ```json
     {
       "python": "",
       "snakeeatsPath": "../../MAX/heyy259/改造中的副本"
     }
     ```
   - 绝对 `python` 路径是机器相关的；迁移到另一台机器时应重新体检或改回空串/`"auto"`。
5. 再次运行 `npm run se:doctor`，确认 `结果：OK`；
6. 运行 `npm run dev`，应用内 SE 横幅应显示可用（不可用时显示具体原因）。

CI/多 checkout 场景建议用 `SE_CONFIG=/path/to/se.config.json` 指定独立配置，避免依赖用户目录。

---

## 8. 故障排查

| 现象 | 原因与处理 |
|---|---|
| `显式 SE_PYTHON 无效：...（来源 env）` | 环境变量指向不存在/非文件。改正，或置空/改为 `"auto"`。显式值无效**不会**回退。 |
| `显式 config.python 无效：...` | 配置文件 `python` 写错。修正或改为空串/`"auto"`。 |
| `显式 SE_PACKAGE_PATH 无效` / `config.snakeeatsPath` 无效 | 路径不是“含 `snakeeats/__init__.py` 的父目录”，也不是 `snakeeats` 包目录本身。检查目录层级与拼写。 |
| `import snakeeats 命中 <file>，不在 <packageParent> 下` | shadow：`PYTHONPATH` / site-packages 里有另一个 snakeeats。清理环境或把 `snakeeatsPath` 指向真实包父目录。 |
| `包可导入但入口不可用：python -m snakeeats serve --help 退出码 ...` | 包不完整或版本不匹配；检查 snakeeats 仓库完整性，必要时更新到支持 `serve` 的版本。 |
| `未找到 Python 解释器` | 安装 Python ≥ 3.10，或在项目内建 `.venv`，或设置 `python` 配置/`SE_PYTHON`。 |
| 配置报 `未知键` | schema 只允许 `python`、`snakeeatsPath`；删除多余键（运行时不接受未知键）。 |
| 配置报“不是合法 JSON / 为空 / 顶层必须是对象” | 使用严格 JSON（无注释），文件非零字节且顶层为对象。 |
| OneDrive storage warning | 仅提示：snakeeats 的单写者锁只在同一台机器内有效。不要把同一个 `se-systems` 同时交给两台机器写。**不**导致失败。 |
| 把配置放进同步仓库 | 不支持：会被跨机同步并串机。改用 `%APPDATA%` / XDG 或 `SE_CONFIG`。 |

---

## 9. 合同不变量（不可破坏）

1. argv 精确：`-u -m snakeeats serve --port 0 --storage <绝对路径>`；无 `--token` / `--system-id` / `--manifest`。
2. `cwd === packageParent`（生产与测试 helper 一致）。
3. `PYTHONPATH === packageParent + delimiter + 继承值`（追加，不替换）。
4. `PYTHONIOENCODING === "utf-8"`。
5. `SNAKEEATS_ADMIN_TOKEN`、`SNAKEEATS_SYSTEM_ID`、`SNAKEEATS_INSTANCE_LOCK_TIMEOUT="1"` 保留。
6. token 只在内存；不在配置文件、命令行、日志、doctor 输出中回显。
7. `snakeeats.__file__` 位于 `packageParent` 下；Python ≥ 3.10；`serve` 入口可用。
8. `--storage` 始终绝对；`<storage>/registry/.registry.json` 形状不变；`system.info.system_id` 校验不变。
9. 不修改 snakeeats 仓库；不修改 `llm_agent_tools`。
10. OneDrive 存储仅产生 warning，不转为失败。

---

## 10. 验证命令

```bash
npm run se:doctor            # 运行时定位与可粘贴配置，退出码 0/1
node scripts/se-preflight.mjs # 一行结论 AVAILABLE / UNAVAILABLE
npm run test:se:runtime-boot  # 起 Vite：/api/project/info + /api/se/preflight
npm run test:smoke           # 常规前端/服务端冒烟
npm run test:se:require      # SE 套件（含纯 Node 单测；真实 SE 必须可用）
npm run build                # 生产构建
```

`test:se:runtime-boot` 固定使用端口 `5399`（`--strictPort`）；被占用时会直接失败并提示，不会复用旧服务。

---

## 11. 版本控制与安全

- **绝不提交** `se.config.json` 或 `se.config.local.json`；`.gitignore` 已做防御性忽略。
- 仓库只提交 `se.config.example.json`（无机器绝对路径、无注释、无额外键）。
- 机器本地配置放 `%APPDATA%\reactflow\se.config.json`（POSIX 用 XDG）或由 `SE_CONFIG` 指定。
- 不要把 token 写入任何配置文件；token 由 server 生成并仅保存在内存。
