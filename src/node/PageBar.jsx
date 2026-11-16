import { memo } from 'react';

/**
 * 翻页条：节点内长文本分页的纯展示控件（0 基页码）。
 * 由 AgentNode 渲染在可滚动内容区之外，markdown / 纯文本控制台两类流共用。
 * 无内部状态、无副作用：只把翻页意图回传给父级 onPage(nextPage) / onJumpToEnd()。
 */
function PageBar({ page, pageCount, onPage, onJumpToEnd }) {
  if (pageCount <= 1) return null;

  const atFirst = page <= 0;
  const atLast = page >= pageCount - 1;

  // 节点内交互：nodrag/nopan + mousedown 阻断 + click 阻断，避免画布拖拽/平移/失焦劫持。
  const press = (e, handler) => {
    e.preventDefault();
    e.stopPropagation();
    handler();
  };

  return (
    <div className="md-pager nodrag nopan">
      <button
        type="button"
        disabled={atFirst}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => press(e, () => onPage(page - 1))}
      >
        « 上一页
      </button>
      <span className="md-pager-label">
        第 {page + 1} / {pageCount} 页
      </span>
      <button
        type="button"
        disabled={atLast}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => press(e, () => onPage(page + 1))}
      >
        下一页 »
      </button>
      {onJumpToEnd ? (
        <button
          type="button"
          disabled={atLast}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => press(e, onJumpToEnd)}
        >
          跳至末尾
        </button>
      ) : null}
    </div>
  );
}

export default memo(PageBar);
