import { memo, useEffect, useRef } from 'react';
import { BaseEdge, EdgeLabelRenderer, EdgeToolbar, getBezierPath } from '@xyflow/react';
import { edgeActions } from './actions.js';

function AgentEdge({
  id,
  label,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
}) {
  const editing = Boolean(data?.editing);
  const inputRef = useRef(null);
  const doneRef = useRef(false);

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  useEffect(() => {
    if (!editing) return;
    doneRef.current = false;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const len = el.value.length;
    try {
      el.setSelectionRange(len, len);
    } catch (err) {
      /* some inputs may not support selection range */
    }
  }, [editing]);

  const commit = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    edgeActions.onEditLabel?.(id, (inputRef.current?.value ?? '').trim());
  };

  const cancel = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    edgeActions.onEditCancel?.(id);
  };

  const hasLabel = Boolean(label);

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        labelX={labelX}
        labelY={labelY}
        label={hasLabel && !editing ? label : undefined}
      />
      {editing && (
        <EdgeLabelRenderer>
          <div
            className="edge-edit-wrap nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            <input
              ref={inputRef}
              className="edge-edit-input"
              defaultValue={label || ''}
              placeholder="连线文字（留空清除）"
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commit();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancel();
                }
              }}
              onBlur={commit}
            />
          </div>
        </EdgeLabelRenderer>
      )}
      <EdgeToolbar edgeId={id} x={labelX} y={labelY} className="nodrag nopan">
        <button
          onClick={(e) => {
            e.stopPropagation();
            edgeActions.onEdit?.(id);
          }}
        >
          编辑文字
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            edgeActions.onDelete?.(id);
          }}
        >
          删除
        </button>
      </EdgeToolbar>
    </>
  );
}

export default memo(AgentEdge);
