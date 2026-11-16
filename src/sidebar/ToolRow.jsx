import { memo, useEffect, useRef } from 'react';

// 哈希取色（对齐 stream-editor-py getTagColor）：同一标签稳定同色
function getTagColor(text) {
  let h = 0;
  const s = String(text || '');
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return {
    bg: `hsl(${hue} 45% 28%)`,
    fg: `hsl(${hue} 80% 82%)`,
  };
}

/**
 * 工具行：名称（ellipsis）+ 彩色标签 chips + 悬停操作（✏️ 编辑 / 📋 插入调用 / ✕ 删除）。
 * 单击 = 详情/编辑弹窗；双击 = 插入 @{name|{json}} 到光标处。
 * DOM 竞态（方案 §6.5）：双击会先派发两次 `click` → 编辑窗口被误开。用 ~250ms 延迟：
 * 单击排程开窗；双击到达即取消排程，保证**双击只插入、不弹窗**。
 * 期 8：`canManage=false`（非 root）时禁用删除按钮。
 * SE-only 行只展示显式「纳入配置」动作，不参与选择、编辑、删除或插入。
 */
function ToolRow({
  tool,
  status = null,
  canManage = true,
  checked = false,
  seOnly = false,
  onOpen,
  onInsert,
  onEdit,
  onDelete,
  onToggleCheck,
  onAdopt,
}) {
  const clickTimerRef = useRef(null);
  useEffect(
    () => () => {
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    },
    []
  );

  const handleClick = () => {
    if (seOnly) return;
    // 双击的第二击：让 onDoubleClick 处理，不重排单击。
    if (clickTimerRef.current) return;
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;
      onOpen(tool);
    }, 250);
  };

  const handleDoubleClick = () => {
    if (seOnly) return;
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    onInsert(tool);
  };

  const tags = Object.entries(tool.tags || {});
  const pathHint = tool.tool_path ? `\n${tool.tool_path}` : '';
  return (
    <div
      className={'tool-row' + (checked ? ' checked' : '')}
      data-tool-name={tool.name}
      data-tool-scope={seOnly ? 'se-only' : 'config'}
      title={`${tool.name}${tool.description ? ` — ${tool.description}` : ''}${pathHint}${
        seOnly ? '\nSE 已注册，尚未纳入当前配置' : ''
      }`}
      onClick={seOnly ? undefined : handleClick}
      onDoubleClick={seOnly ? undefined : handleDoubleClick}
    >
      {!seOnly && (
        <button
          type="button"
          draggable={false}
          className={'tool-check' + (checked ? ' on' : '')}
          aria-pressed={!!checked}
          title={checked ? '取消选择' : '选择'}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            onToggleCheck(tool.name);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          onDragStart={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          {checked ? '✓' : ''}
        </button>
      )}
      <span className="tool-name">{tool.name}</span>
      {status && status.state !== 'registered' && (
        <span
          className={`tool-status tool-status-${status.state}`}
          title={
            status.state === 'failed'
              ? `注册失败：${status.reason || '未知原因'}`
              : '未注册到 SE（本次运行不可执行）'
          }
        >
          {status.state === 'failed' ? '注册失败' : '未注册'}
        </span>
      )}
      <span className="tool-tags">
        {tags.map(([k, v]) => {
          const c = getTagColor(`${k}:${v}`);
          return (
            <span
              className="tool-tag"
              key={k}
              style={{ background: c.bg, color: c.fg }}
              title={`${k}: ${v}`}
            >
              {v || k}
            </span>
          );
        })}
      </span>
      {seOnly ? (
        <span className="tool-actions">
          <button
            type="button"
            aria-label={`纳入配置 ${tool.name}`}
            title="读取最新 SE 定义并保存到当前配置；不重新注册"
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.stopPropagation();
              onAdopt?.(tool.name);
            }}
          >
            纳入配置
          </button>
        </span>
      ) : (
        <span className="tool-actions">
          <button
            type="button"
            title="编辑元数据"
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.stopPropagation();
              onEdit(tool);
            }}
          >
            ✏️
          </button>
          <button
            type="button"
            title="插入调用 @{name|{json}} 到光标处"
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.stopPropagation();
              onInsert(tool);
            }}
          >
            📋
          </button>
          <button
            type="button"
            title={canManage ? '删除工具…' : '需要 root 权限'}
            disabled={!canManage}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (!canManage) return;
              onDelete(tool);
            }}
          >
            ✕
          </button>
        </span>
      )}
    </div>
  );
}

export default memo(ToolRow);
