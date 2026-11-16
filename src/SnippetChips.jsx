// 节点编辑工具栏的片段 chips：两行（编辑=内置 / 片段=自定义 + ＋/管理），
// 各自独立溢出「⋯」（真值测量 + 每行硬上限 9）、双击应用、右键删、指针式拖拽排序（5px 阈值保住双击）。
// 另导出 SnippetMoreMenu / SnippetContextMenu 供选区浮条复用（原型 :2947-3115 / :3614-3628）。

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { snippetTypeLabel, visibleSnippets } from './editor/snippetData.js';
import { pushEsc } from './escStack.js';

const SNIP_ROW_MAX = 9;

function groupLabel(group) {
  return group === 'builtin' ? '编辑' : '片段';
}

/* ------------------------------------------------------------------ *
 * ⋯ 下拉（工具栏行 / 气泡分组共用）
 * ------------------------------------------------------------------ */

export function SnippetMoreMenu({ anchorEl, snippets, indices, onApply, onDelete, onNotify }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  const [ctx, setCtx] = useState(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const btn = anchorEl;
    if (!el || !btn) return;
    const r = btn.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(6, Math.min(r.left, window.innerWidth - w - 8));
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    setPos({ left, top });
  }, [anchorEl]);

  useEffect(() => {
    const un = pushEsc(() => {
      if (ctx) setCtx(null);
      else onNotify?.('close');
    });
    const onDown = (e) => {
      if (ref.current?.contains(e.target)) return;
      if (e.target === anchorEl || anchorEl?.contains?.(e.target)) return;
      onNotify?.('close');
    };
    const onScroll = () => onNotify?.('close');
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      un();
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [ctx, onNotify, anchorEl]);

  return (
    <>
      {createPortal(
        <div
          className="snip-more-menu"
          ref={ref}
          data-menu-scope="toolbar"
          style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
        >
          {indices.map((i) => {
            const s = snippets[i];
            if (!s) return null;
            return (
              <div
                key={i}
                className="snip-more-item"
                title={'双击应用：' + String(s.text || '').replace(/\n/g, '⏎')}
                onDoubleClick={() => onApply(i)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setCtx({ x: e.clientX, y: e.clientY, index: i });
                }}
              >
                <span className="snip-more-name">{s.name}</span>
                <span className="snip-lib-type">{snippetTypeLabel(s.text)}</span>
              </div>
            );
          })}
        </div>,
        document.body
      )}
      {ctx && (
        <SnippetContextMenu
          x={ctx.x}
          y={ctx.y}
          snippets={snippets}
          index={ctx.index}
          onDelete={onDelete}
          onClose={() => setCtx(null)}
          onNotify={onNotify}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * 片段右键菜单（内置 🔒 禁删）
 * ------------------------------------------------------------------ */

export function SnippetContextMenu({ x, y, snippets, index, onDelete, onClose, onNotify }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  const s = snippets[index];
  const builtin = s && (s.group || 'user') === 'builtin';

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    setPos({
      left: Math.max(6, Math.min(x, window.innerWidth - w - 8)),
      top: Math.max(6, Math.min(y, window.innerHeight - h - 8)),
    });
  }, [x, y]);

  useEffect(() => {
    const un = pushEsc(onClose);
    const onDown = (e) => {
      if (ref.current?.contains(e.target)) return;
      onClose();
    };
    const onScroll = () => onClose();
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      un();
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [onClose]);

  return createPortal(
    <div className="context-menu" ref={ref} style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}>
      <div className="ctx-title">片段「{s ? s.name : ''}」</div>
      {builtin ? (
        <button type="button" disabled>
          <span className="ctx-ico">🔒</span>内置片段不可删除
        </button>
      ) : (
        <button
          type="button"
          onClick={() => {
            onDelete?.(index);
            onClose();
          }}
        >
          <span className="ctx-ico">✕</span>删除
        </button>
      )}
    </div>,
    document.body
  );
}

/* ------------------------------------------------------------------ *
 * 工具栏两行 chips
 * ------------------------------------------------------------------ */

function measureRow(row) {
  // 工具栏已从节点内移到屏幕空间宿主；宽度不再由节点/视口决定。
  // HUD 下宽度由 .ntb-snips-wrap（= 工具栏内容宽度）约束；必须用 wrap 的宽度测量，
  // 且不要再写 row.maxWidth——否则每次测量都会把行宽再缩 4px（309→305→301…）。
  const toolbar = row.closest('.node-toolbar');
  const host = row.closest('.flow-edit-hud');
  const wrap = row.closest('.ntb-snips-wrap');
  const avail =
    (wrap && wrap.clientWidth) ||
    row.clientWidth ||
    (toolbar && toolbar.clientWidth) ||
    (host && host.clientWidth) ||
    window.innerWidth;
  const ref = Math.max(160, avail - 4);
  const chips = Array.from(row.querySelectorAll('.snip-chip[data-snip]'));
  const moreBtn = row.querySelector('.snip-more');
  if (!moreBtn) return;
  // 节点内旧工具栏保留 maxWidth 约束；HUD 由 wrap 约束，清空历史内联值。
  row.style.maxWidth = host ? '' : `${ref}px`;
  moreBtn.classList.add('hidden');
  moreBtn.classList.remove('is-open');
  chips.forEach((c) => c.classList.add('snip-hidden'));
  let fit = 0;
  for (let i = 0; i < chips.length; i += 1) {
    chips[i].classList.remove('snip-hidden');
    if (row.scrollWidth > row.clientWidth + 1) {
      chips[i].classList.add('snip-hidden');
      break;
    }
    fit += 1;
  }
  let visible = Math.min(SNIP_ROW_MAX, fit);
  chips.forEach((c, i) => {
    if (i < visible) c.classList.remove('snip-hidden');
    else c.classList.add('snip-hidden');
  });
  if (visible >= chips.length) {
    moreBtn.title = '还有 0 个片段';
    return;
  }
  moreBtn.classList.remove('hidden');
  while (visible > 0 && row.scrollWidth > row.clientWidth + 1) {
    visible -= 1;
    chips[visible].classList.add('snip-hidden');
  }
  const hidden = chips.length - visible;
  if (hidden <= 0) {
    moreBtn.classList.add('hidden');
    moreBtn.title = '还有 0 个片段';
    return;
  }
  moreBtn.title = '还有 ' + hidden + ' 个片段';
}

export default function SnippetChips({ snippets, onApply, onDelete, onReorder, onAdd, onManage, onNotify }) {
  const wrapRef = useRef(null);
  const timerRef = useRef(null);
  const dragRef = useRef(null);
  const reorderRef = useRef(onReorder);
  reorderRef.current = onReorder;
  const [more, setMore] = useState(null); // { anchorEl, indices }
  const [ctx, setCtx] = useState(null); // { x, y, index }

  const scheduleMeasure = () => {
    if (timerRef.current) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const wrap = wrapRef.current;
      if (!wrap) return;
      Array.from(wrap.querySelectorAll('.ntb-snips')).forEach(measureRow);
    }, 0);
  };

  useEffect(() => {
    scheduleMeasure();
    return () => clearTimeout(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snippets, more]);

  useEffect(() => {
    const onResize = () => scheduleMeasure();
    window.addEventListener('resize', onResize);
    let ro = null;
    if (typeof ResizeObserver !== 'undefined' && wrapRef.current) {
      ro = new ResizeObserver(scheduleMeasure);
      ro.observe(wrapRef.current);
    }
    return () => {
      window.removeEventListener('resize', onResize);
      if (ro) ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 指针式拖拽（5px 阈值）。全局监听一次，onReorder 走 ref 取最新。
  useEffect(() => {
    const slotOf = (e, row) => {
      const vis = Array.from(row.querySelectorAll('.snip-chip[data-snip]')).filter(
        (c) => !c.classList.contains('snip-dragging') && !c.classList.contains('snip-hidden')
      );
      let idx = vis.length;
      for (let k = 0; k < vis.length; k += 1) {
        const r = vis[k].getBoundingClientRect();
        if (e.clientX < r.left + r.width / 2) {
          idx = k;
          break;
        }
      }
      return { row, vis, idx };
    };
    const onMove = (e) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.active) {
        if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) < 5) return;
        d.active = true;
        d.chip.classList.add('snip-dragging');
        const line = document.createElement('span');
        line.className = 'snip-drop-line';
        d.row.appendChild(line);
        d.line = line;
      }
      const slot = slotOf(e, d.row);
      if (!slot || !d.line) return;
      const rowRect = slot.row.getBoundingClientRect();
      let x = 0;
      if (slot.idx < slot.vis.length) x = slot.vis[slot.idx].getBoundingClientRect().left - rowRect.left - 1;
      else if (slot.vis.length)
        x = slot.vis[slot.vis.length - 1].getBoundingClientRect().right - rowRect.left + 1;
      d.line.style.left = Math.max(0, x) + 'px';
    };
    const onUp = (e) => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      if (!d.active) return;
      if (d.line && d.line.parentNode) d.line.parentNode.removeChild(d.line);
      d.chip.classList.remove('snip-dragging');
      const slot = slotOf(e, d.row);
      if (!slot) return;
      let to;
      if (slot.idx < slot.vis.length) to = parseInt(slot.vis[slot.idx].getAttribute('data-snip'), 10);
      else if (slot.vis.length)
        to = parseInt(slot.vis[slot.vis.length - 1].getAttribute('data-snip'), 10) + 1;
      else to = 0;
      reorderRef.current?.(d.from, to);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, []);

  const openMore = (group, btn) => {
    const row = btn.closest('.ntb-snips');
    if (!row) return;
    const indices = Array.from(row.querySelectorAll('.snip-chip[data-snip]'))
      .filter((c) => c.classList.contains('snip-hidden'))
      .map((c) => parseInt(c.getAttribute('data-snip'), 10));
    if (!indices.length) return;
    setMore({ anchorEl: btn, indices });
  };

  const onChipMouseDown = (e) => {
    if (e.button !== 0) return;
    const chip = e.target.closest('.snip-chip[data-snip]');
    if (!chip) return;
    dragRef.current = {
      chip,
      row: chip.closest('.ntb-snips'),
      from: parseInt(chip.getAttribute('data-snip'), 10),
      sx: e.clientX,
      sy: e.clientY,
      active: false,
      line: null,
    };
  };

  const rowHTML = (group) => {
    const items = visibleSnippets(snippets, group);
    return (
      <div className="ntb-row ntb-snips" data-snip-group={group} onMouseDown={onChipMouseDown}>
        <span className="snip-label snip-group-label">{groupLabel(group)}</span>
        {items.map(({ s, i }) => (
          <span
            key={i}
            className="snip-chip"
            data-snip={i}
            title={'双击应用，拖动排序：' + String(s.text).replace(/\n/g, '⏎')}
            onDoubleClick={() => onApply(i)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setCtx({ x: e.clientX, y: e.clientY, index: i });
            }}
          >
            {s.name}
          </span>
        ))}
        {group === 'user' && (
          <>
            <span
              className="snip-chip snip-add"
              data-snip-add="1"
              title="新建片段"
              onClick={(e) => {
                e.stopPropagation();
                onAdd?.(e.currentTarget.getBoundingClientRect());
              }}
            >
              ＋
            </span>
            <span
              className="snip-chip snip-manage"
              data-snip-manage="1"
              title="打开片段库"
              onClick={(e) => {
                e.stopPropagation();
                onManage?.();
              }}
            >
              管理
            </span>
          </>
        )}
        <button
          type="button"
          className="snip-more hidden"
          data-snip-more="1"
          title="还有 0 个片段"
          onClick={(e) => {
            e.stopPropagation();
            if (more) setMore(null);
            else openMore(group, e.currentTarget);
          }}
        >
          ⋯
        </button>
      </div>
    );
  };

  return (
    <>
      <div className="ntb-snips-wrap" ref={wrapRef}>
        {rowHTML('builtin')}
        {rowHTML('user')}
      </div>
      {more && (
        <SnippetMoreMenu
          anchorEl={more.anchorEl}
          snippets={snippets}
          indices={more.indices}
          onApply={(i) => {
            setMore(null);
            onApply(i);
          }}
          onDelete={onDelete}
          onNotify={(act) => {
            if (act === 'close') setMore(null);
          }}
        />
      )}
      {ctx && (
        <SnippetContextMenu
          x={ctx.x}
          y={ctx.y}
          snippets={snippets}
          index={ctx.index}
          onDelete={onDelete}
          onClose={() => setCtx(null)}
          onNotify={onNotify}
        />
      )}
    </>
  );
}
