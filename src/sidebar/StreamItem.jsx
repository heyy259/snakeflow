import { memo } from 'react';
import { isReservedTagKey } from '../graph.js';

function fmtSize(n) {
  const len = Number(n) || 0;
  if (len < 1024) return `${len} B`;
  if (len < 1024 * 1024) return `${(len / 1024).toFixed(1)} KB`;
  return `${(len / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 流列表项：状态点（●在画布 / ○隐藏）+ 名称 + 大小 + 描述 + 标签 chips + 悬停操作。
 * 标签 chips 过滤系统保留键 canvas（可见性用眼睛表达，不作为普通 chip）。
 */
function StreamItem({
  stream,
  selected,
  checked,
  onSelect,
  onActivate,
  onToggle,
  onRename,
  onDelete,
  onToggleCheck,
  onContextMenu,
}) {
  const { id, name, description, fields, visible, size } = stream;
  // 期 5：chips 排除全部保留键（canvas + edge.*）——边/可见性用画布与眼睛表达。
  const tags = (Array.isArray(fields) ? fields : []).filter((f) => f && f.key && !isReservedTagKey(f.key));

  const onDragStart = (e) => {
    e.dataTransfer.setData('application/x-stream-id', id);
    e.dataTransfer.effectAllowed = 'move';
    // 半透明虚线幽灵，与画布实节点明确区分
    const ghost = document.createElement('div');
    ghost.className = 'stream-drag-ghost';
    ghost.textContent = name || '未命名流';
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 16, 16);
    requestAnimationFrame(() => ghost.remove());
  };

  return (
    <div
      className={
        'stream-item' +
        (visible ? '' : ' is-hidden') +
        (selected ? ' selected' : '') +
        (checked ? ' checked' : '')
      }
      draggable
      onDragStart={onDragStart}
      onClick={() => onSelect(id)}
      onDoubleClick={() => onActivate(id)}
      onContextMenu={(e) => onContextMenu(e, id)}
    >
      <button
        type="button"
        draggable={false}
        className={'stream-check' + (checked ? ' on' : '')}
        aria-pressed={!!checked}
        title={checked ? '取消选择' : '选择'}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.stopPropagation();
          onToggleCheck(id);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        onDragStart={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {checked ? '✓' : ''}
      </button>
      <span className="stream-dot" title={visible ? '在画布' : '已隐藏'}>
        {visible ? '●' : '○'}
      </span>
      <div className="stream-main">
        <div className="stream-line1">
          <span className="stream-name" title={name || '未命名流'}>
            {name || '未命名流'}
          </span>
          <span className="stream-size">{fmtSize(size)}</span>
        </div>
        {description && (
          <div className="stream-desc" title={description}>
            {description}
          </div>
        )}
        {tags.length > 0 && (
          <div className="stream-tags">
            {tags.map((f, i) => (
              <span className="tag-chip" key={i} title={`${f.key}: ${f.value}`}>
                {f.value ? `${f.key}: ${f.value}` : f.key}
              </span>
            ))}
          </div>
        )}
      </div>
      <span className="stream-actions">
        <button
          type="button"
          title={visible ? '从画布移除（流仍在列表中）' : '显示到画布'}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(id, !visible);
          }}
        >
          {visible ? '👁' : '👁‍🗨'}
        </button>
        <button
          type="button"
          title="重命名"
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            onRename(id);
          }}
        >
          ✏️
        </button>
        <button
          type="button"
          title="删除流…"
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            onDelete(id);
          }}
        >
          🗑
        </button>
      </span>
    </div>
  );
}

export default memo(StreamItem);
