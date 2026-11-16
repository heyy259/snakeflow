# 流示例（可扫描执行）

> 每条独立成行的 `@{工具|{JSON}}` 就是一个标记；写进**有活跃扫描的流**后按顺序执行。
> 把 `${PROJECT_DIR}` 换成项目目录（正斜杠），`${SESSION_ID}` 用 `oc_prompt` 返回的 `session_id` 替换。
>
> 前提：跑 `snake serve` 的终端已导出 `SNAKEEATS_AUTH_TOKEN`；已执行 `python opencode_tools\oc_setup.py` 注册工具。

```text
@{oc_setup|{}}
@{oc_server|{"action":"start","project_dir":"${PROJECT_DIR}"}}
@{oc_models|{"project_dir":"${PROJECT_DIR}"}}
@{oc_server|{"action":"status","project_dir":"${PROJECT_DIR}"}}
@{oc_prompt|{"text":"Reply with exactly: pong","project_dir":"${PROJECT_DIR}"}}
@{oc_prompt|{"sessionID":"${SESSION_ID}","text":"再补一句：done"}}
@{oc_sessions|{"action":"list"}}
@{oc_sessions|{"action":"get","sessionID":"${SESSION_ID}"}}
@{oc_view|{"sessionID":"${SESSION_ID}","mode":"messages","limit":5}}
@{oc_view|{"sessionID":"${SESSION_ID}","mode":"todo"}}
@{oc_view|{"sessionID":"${SESSION_ID}","mode":"status"}}
@{oc_view|{"sessionID":"${SESSION_ID}","mode":"cost"}}
@{oc_permission|{"action":"list"}}
@{oc_abort|{"sessionID":"${SESSION_ID}"}}
@{oc_server|{"action":"restart","project_dir":"${PROJECT_DIR}"}}
@{oc_server|{"action":"stop","project_dir":"${PROJECT_DIR}"}}
```

结果看 `{命令流}_console`；会话过程看 `oc_sess_<sid>`。
`oc_host` 由 `oc_server start` 自动拉起，不用手写标记。
