// 片段库弹窗（需求 8）：搜索、新建、编辑、删除确认、隐藏/显示（👁/🚫）、
// 内置「全部恢复」（显隐复位 + 默认顺序）、库内拖拽排序（同组约束）、Esc 关闭、关闭后还原编辑器选区。
// 交互对齐原型 :3667-3804。

import { useEffect, useRef, useState } from 'react';
import { moveSnippet, restoreBuiltins, snippetTypeLabel } from './editor/snippetData.js';
import { pushEsc } from './escStack.js';
import SnippetForm from './SnippetForm.jsx';

function filteredIndices(snippets, query) {
  const q = query.trim().toLowerCase();
  const out = [];
  snippets.forEach((s, i) => {
    if (
      !q ||
      String(s.name || '').toLowerCase().includes(q) ||
      String(s.text || '').toLowerCase().includes(q)
    ) {
      out.push(i);
    }
  });
  return out;
}

export default function SnippetLibrary({ snippets, onChange, onClose, getEditorApi, onNotify }) {
  const [query, setQuery] = useState('');
  const [editIndex, setEditIndex] = useState(null);
  const [deleteIndex, setDeleteIndex] = useState(null);
  const [newOpen, setNewOpen] = useState(false);
  const dragRef = useRef(null);
  const snippetsRef = useRef(snippets);
  snippetsRef.current = snippets;
  const searchRef = useRef(null);

  const close = () => {
    getEditorApi?.()?.restoreSelection?.();
    onClose?.();
  };

  useEffect(() => pushEsc(close), []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // 库内拖拽（同组约束；跨组直接拒绝，吸附回原位）。
  useEffect(() => {
    const libSlot = (e, group) => {
      const list = document.getElementById('snipLibList');
      const rows = list
        ? Array.from(list.querySelectorAll('.snip-lib-row[data-lib-group="' + group + '"]'))
        : [];
      let idx = rows.length;
      for (let k = 0; k < rows.length; k += 1) {
        const r = rows[k].getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) {
          idx = k;
          break;
        }
      }
      return { rows, idx };
    };
    const onMove = (e) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.active) {
        if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) < 5) return;
        d.active = true;
        d.row.classList.add('dragging');
      }
      const slot = libSlot(e, d.group);
      slot.rows.forEach((r) => r.classList.remove('drop-target'));
      if (slot.idx < slot.rows.length) slot.rows[slot.idx].classList.add('drop-target');
      d.slot = slot;
    };
    const onUp = (e) => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      if (!d.active) return;
      d.row.classList.remove('dragging');
      const list = document.getElementById('snipLibList');
      if (list) {
        Array.from(list.querySelectorAll('.snip-lib-row')).forEach((r) => r.classList.remove('drop-target'));
      }
      const allRows = list
        ? Array.from(list.querySelectorAll('.snip-lib-row'))
        : [];
      let overRow = null;
      for (let k = 0; k < allRows.length; k += 1) {
        const rb = allRows[k].getBoundingClientRect();
        if (e.clientY < rb.top + rb.height / 2) {
          overRow = allRows[k];
          break;
        }
      }
      if (!overRow && allRows.length) overRow = allRows[allRows.length - 1];
      if (overRow && (overRow.getAttribute('data-lib-group') || 'user') !== d.group) {
        return; // 跨组拖动拒绝
      }
      const slot = d.slot || libSlot(e, d.group);
      const arr = snippetsRef.current;
      let gStart = arr.length;
      let gEnd = 0;
      arr.forEach((s, i) => {
        if ((s.group || 'user') === d.group) {
          if (i < gStart) gStart = i;
          if (i + 1 > gEnd) gEnd = i + 1;
        }
      });
      let to = slot.idx < slot.rows.length ? parseInt(slot.rows[slot.idx].getAttribute('data-lib-index'), 10) : gEnd;
      to = Math.max(gStart, Math.min(to, gEnd));
      onChange(moveSnippet(arr, d.from, to));
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [onChange]);

  const beginLibDrag = (row, e) => {
    dragRef.current = {
      row,
      group: row.getAttribute('data-lib-group') || 'user',
      from: parseInt(row.getAttribute('data-lib-index'), 10),
      sx: e.clientX,
      sy: e.clientY,
      active: false,
      slot: null,
    };
  };

  const addSnippet = (name, content) => {
    onChange([...snippets, { group: 'user', name, text: content, hidden: false }]);
    onNotify?.('已新增片段「' + name + '」（' + snippetTypeLabel(content) + '）', 'ok');
  };
  const updateSnippet = (index, name, content) => {
    onChange(snippets.map((s, i) => (i === index ? { ...s, name, text: content } : s)));
    onNotify?.('已保存片段「' + name + '」', 'ok');
  };
  const toggleHidden = (index) => {
    const s = snippets[index];
    if (!s) return;
    onChange(snippets.map((x, i) => (i === index ? { ...x, hidden: !x.hidden } : x)));
    onNotify?.((s.hidden ? '已恢复显示' : '已隐藏') + '片段「' + s.name + '」', 'info');
  };
  const deleteSnippet = (index) => {
    const s = snippets[index];
    if (!s) return;
    if ((s.group || 'user') === 'builtin') {
      onNotify?.('内置片段不可删除', 'warn');
      return;
    }
    onChange(snippets.filter((_, i) => i !== index));
    onNotify?.('已删除片段「' + s.name + '」', 'info');
  };

  const idxs = filteredIndices(snippets, query);
  const builtinIdxs = idxs.filter((i) => (snippets[i].group || 'user') === 'builtin');
  const userIdxs = idxs.filter((i) => (snippets[i].group || 'user') !== 'builtin');

  const rowHTML = (i) => {
    const s = snippets[i];
    const group = s.group || 'user';
    const builtin = group === 'builtin';
    if (!builtin && editIndex === i) {
      return (
        <div className="snip-lib-row editing" key={i} data-lib-index={i} data-lib-group={group}>
          <SnippetForm
            variant="inline"
            title="编辑片段"
            name={s.name}
            content={s.text}
            onError={(msg) => onNotify?.(msg, 'warn')}
            onCancel={() => setEditIndex(null)}
            onSave={(v) => {
              setEditIndex(null);
              updateSnippet(i, v.name, v.content);
            }}
          />
        </div>
      );
    }
    if (!builtin && deleteIndex === i) {
      return (
        <div className="snip-lib-row" key={i} data-lib-index={i} data-lib-group={group}>
          <span className="snip-chip snip-lib-name">{s.name}</span>
          <span className="snip-lib-confirm">确认删除？</span>
          <button
            className="snip-lib-btn danger"
            data-lib-action="del-yes"
            onClick={() => {
              setDeleteIndex(null);
              deleteSnippet(i);
            }}
          >
            删除
          </button>
          <button className="snip-lib-btn" data-lib-action="del-no" onClick={() => setDeleteIndex(null)}>
            取消
          </button>
        </div>
      );
    }
    const hidden = !!s.hidden;
    return (
      <div
        className={'snip-lib-row' + (hidden ? ' hidden-snippet' : '')}
        key={i}
        data-lib-index={i}
        data-lib-group={group}
      >
        <span
          className="snip-lib-grip"
          data-lib-grip="1"
          title="拖动排序"
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            const row = e.currentTarget.closest('.snip-lib-row');
            if (row) beginLibDrag(row, e);
          }}
        >
          ⠿
        </span>
        <button
          className="snip-lib-btn snip-lib-toggle"
          data-lib-action="toggle"
          title={hidden ? '显示（恢复到工具栏/气泡）' : '隐藏（不显示在工具栏/气泡）'}
          onClick={() => toggleHidden(i)}
        >
          {hidden ? '🚫' : '👁'}
        </button>
        <span className="snip-chip snip-lib-name">{s.name}</span>
        <span className="snip-lib-preview" title={s.text}>
          {String(s.text).replace(/\n/g, ' ⏎ ')}
        </span>
        <span className="snip-lib-type">{snippetTypeLabel(s.text)}</span>
        {builtin ? (
          <span className="snip-lib-lock" title="内置片段，内容不可编辑/删除">
            🔒
          </span>
        ) : (
          <>
            <button
              className="snip-lib-btn"
              data-lib-action="edit"
              title="编辑"
              onClick={() => {
                setEditIndex(i);
                setDeleteIndex(null);
                setNewOpen(false);
              }}
            >
              ✏️
            </button>
            <button
              className="snip-lib-btn"
              data-lib-action="delete"
              title="删除"
              onClick={() => {
                setDeleteIndex(i);
                setEditIndex(null);
              }}
            >
              🗑
            </button>
          </>
        )}
      </div>
    );
  };

  return (
    <div className="snip-lib-overlay">
      <div className="snip-lib" role="dialog" aria-modal="true" aria-label="片段库">
        <div className="snip-lib-head">
          <strong>片段库</strong>
          <span className="snip-lib-count">{snippets.length} 条</span>
          <button className="snip-lib-close" title="关闭" onClick={close}>
            ×
          </button>
        </div>
        <div className="snip-lib-tools">
          <input
            ref={searchRef}
            type="text"
            className="snip-lib-search"
            placeholder="搜索名字或内容…"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            className="primary"
            onClick={() => {
              setNewOpen(true);
              setEditIndex(null);
              setDeleteIndex(null);
            }}
          >
            ＋ 新建片段
          </button>
        </div>
        <div className="snip-lib-list" id="snipLibList">
          {newOpen && (
            <div className="snip-lib-new">
              <SnippetForm
                variant="inline"
                title="新建片段"
                focusName
                onError={(msg) => onNotify?.(msg, 'warn')}
                onCancel={() => setNewOpen(false)}
                onSave={(v) => {
                  setNewOpen(false);
                  addSnippet(v.name, v.content);
                }}
              />
            </div>
          )}
          {builtinIdxs.length > 0 && (
            <div className="snip-lib-section-head">
              内置编辑
              <button
                className="snip-lib-restore"
                data-lib-action="restore-builtin"
                title="全部显示并恢复默认顺序"
                onClick={() => {
                  onChange(restoreBuiltins(snippets));
                  onNotify?.('已恢复全部内置片段（显示 + 默认顺序）', 'ok');
                }}
              >
                全部恢复
              </button>
            </div>
          )}
          {builtinIdxs.map(rowHTML)}
          {userIdxs.length > 0 && <div className="snip-lib-section-head">自定义</div>}
          {userIdxs.map(rowHTML)}
          {builtinIdxs.length === 0 && userIdxs.length === 0 && (
            <div className="snip-lib-empty">没有匹配的片段</div>
          )}
        </div>
        <div className="snip-lib-foot">双击编辑态工具栏中的片段签可插入 / 包裹</div>
      </div>
    </div>
  );
}
