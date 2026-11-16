import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import StreamItem from './StreamItem.jsx';
import TagsEditor, { validateTags, cleanTags } from './TagsEditor.jsx';
import TagFilterBar, { matchTagFilter, collectTagKeys, collectTagValues } from './TagFilterBar.jsx';
import { isReservedTagKey } from '../graph.js';
import { tagsToRows } from '../tools.js';
import { readFsText, resolveSiblingPath } from '../se/paths.js';
import { loadManifestFile, fetchStreamContents } from '../se/packageImport.js';
import { classifyStreamImport, streamFromManifest } from '../se/singleConfig.js';
import { streamNameError } from '../se/nameContract.js';
import ModalOverlay from '../components/ModalOverlay.jsx';

const CANVAS_KEY = 'canvas';
const DOC_FILTER =
  'Markdown/文本 (*.md;*.txt;*.json;*.csv;*.log;*.py;*.js;*.ts)|*.md;*.txt;*.json;*.csv;*.log;*.py;*.js;*.ts|所有文件 (*.*)|*.*';

/** 打开系统文件选择框；返回选中路径，取消返回 null，失败抛错。 */
async function pickPath(filter, title) {
  const res = await fetch('/api/dialog/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filter, title }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data && data.path ? data.path : null;
}
// 期 5：保留键谓词（canvas 精确 + edge. 前缀）——写入口/展示层统一排除。
const reservedPredicate = (key) => isReservedTagKey(key);

/**
 * 流面板：当前标签页全部流的列表视图（含隐藏流）。
 * 排序：在画布的排前、隐藏的排后，各自按名称。
 */
export default function StreamPanel({
  streams,
  onNotify,
  onExport,
  onImport,
  canImport,
  onToggle,
  onCreate,
  onRename,
  onDelete,
  onDeleteMany,
  onUpdateMeta,
  onFocus,
  onEdit,
  onSaveAs,
}) {
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState({});
  const [selectedId, setSelectedId] = useState(null);
  const [checkedIds, setCheckedIds] = useState(() => new Set());
  const [ctx, setCtx] = useState(null);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const [dialog, setDialog] = useState(null);
  const menuRef = useRef(null);

  const visibleCount = useMemo(() => streams.filter((s) => s.visible).length, [streams]);

  // 期 5：getTags 含 edge.*（搜索可达边键/目标名）；pills 用谓词排除 canvas+edge.*。
  const getTags = (s) =>
    Array.isArray(s.searchTags) ? s.searchTags : (Array.isArray(s.fields) ? s.fields : []);
  const tagKeys = useMemo(
    () => collectTagKeys(streams, getTags, [CANVAS_KEY], reservedPredicate),
    [streams]
  );

  const filtered = useMemo(() => {
    return streams
      .filter((s) =>
        matchTagFilter(s, { search: query, filters }, getTags, (x) => [x.name || '', x.description || ''])
      )
      .slice()
      .sort((a, b) => {
        if (a.visible !== b.visible) return a.visible ? -1 : 1;
        return (a.name || '').localeCompare(b.name || '', 'zh-CN');
      });
  }, [streams, query, filters]);

  const byId = useMemo(() => new Map(streams.map((s) => [s.id, s])), [streams]);

  /* ---------------- 多选（R2） ---------------- */

  // 列表本身变化时裁剪已删 id；过滤变化不动选择（全选作用于全部流）。
  // 无变化时返回同一 Set 引用，避免 effect → setState → 重渲染的死循环。
  useEffect(() => {
    setCheckedIds((prev) => {
      if (!prev.size) return prev;
      const valid = new Set(streams.map((s) => s.id));
      let changed = false;
      const next = new Set();
      prev.forEach((id) => {
        if (valid.has(id)) next.add(id);
        else changed = true;
      });
      return changed ? next : prev;
    });
  }, [streams]);

  const toggleCheck = useCallback((id) => {
    setCheckedIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // 全选/全不选作用于全部流（不受标签过滤影响）。
  const allChecked = streams.length > 0 && checkedIds.size === streams.length;
  const setAll = (on) => setCheckedIds(on ? new Set(streams.map((s) => s.id)) : new Set());

  /* ---------------- 右键菜单 ---------------- */

  const openCtx = (e, id) => {
    e.preventDefault();
    e.stopPropagation();
    const pos = { x: e.clientX, y: e.clientY };
    setMenuPos(pos);
    setCtx({ ...pos, id });
  };

  useLayoutEffect(() => {
    if (!ctx || !menuRef.current) return;
    const w = menuRef.current.offsetWidth;
    const h = menuRef.current.offsetHeight;
    setMenuPos({
      x: Math.max(6, Math.min(ctx.x, window.innerWidth - w - 8)),
      y: Math.max(6, Math.min(ctx.y, window.innerHeight - h - 8)),
    });
  }, [ctx]);

  useEffect(() => {
    if (!ctx) return undefined;
    const onDocDown = (e) => {
      if (e.target instanceof Element && e.target.closest('.context-menu')) return;
      setCtx(null);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setCtx(null);
    };
    const onScroll = () => setCtx(null);
    document.addEventListener('mousedown', onDocDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [ctx]);

  /* ---------------- 列表行为 ---------------- */

  // 单击：在画布流 = 平移视口居中并选中节点；隐藏流 = 只选中列表项
  const handleSelect = (id) => {
    setSelectedId(id);
    const s = byId.get(id);
    if (s?.visible) onFocus(id);
  };
  // 双击：在画布流 = 居中并进入编辑；隐藏流 = 显示到画布并居中（不自动进入编辑）
  const handleActivate = (id) => {
    const s = byId.get(id);
    if (!s) return;
    if (!s.visible) {
      onToggle(id, true, undefined, true); // show + focus（第 4 参 focus=true）
      return;
    }
    onEdit(id);
  };

  const ctxStream = ctx ? byId.get(ctx.id) : null;

  return (
    <div className="streams-panel">
      <div className="sidebar-head">
        <strong>流</strong>
        <span className="sidebar-state">
          画布 {visibleCount} / 共 {streams.length}
        </span>
        <button
          type="button"
          className="head-btn"
          title="新建流"
          onClick={() => setDialog({ kind: 'create' })}
        >
          ＋新建
        </button>
        <button
          type="button"
          className="head-btn"
          title="导出流配置包（.se.json + 同目录 streams 目录）"
          onClick={() => onExport('streams')}
        >
          💾
        </button>
        <button
          type="button"
          className="head-btn"
          title={canImport ? '加载配置包（增量更新到当前标签页）' : '需要已绑定系统'}
          disabled={!canImport}
          onClick={onImport}
        >
          📂
        </button>
      </div>
      <TagFilterBar
        search={query}
        onSearch={setQuery}
        tagKeys={tagKeys}
        valuesFor={(key) => collectTagValues(streams, getTags, key)}
        filters={filters}
        onFilters={setFilters}
        placeholder="搜索名称/描述/标签"
      />
      <div className="stream-select-bar">
        <button
          type="button"
          className="head-btn"
          disabled={!streams.length}
          onClick={() => setAll(!allChecked)}
        >
          {allChecked ? '全不选' : '全选'}
        </button>
        <span className="sidebar-state">
          已选 {checkedIds.size} / {streams.length}
        </span>
        <button
          type="button"
          className="head-btn danger"
          disabled={!checkedIds.size}
          onClick={() => onDeleteMany([...checkedIds])}
        >
          🗑 清理
        </button>
      </div>
      <div className="stream-list">
        {filtered.length ? (
          filtered.map((s) => (
            <StreamItem
              key={s.id}
              stream={s}
              selected={selectedId === s.id}
              checked={checkedIds.has(s.id)}
              onSelect={handleSelect}
              onActivate={handleActivate}
              onToggle={onToggle}
              onRename={(id) => setDialog({ kind: 'rename', id })}
              onDelete={(id) => onDelete(id)}
              onToggleCheck={toggleCheck}
              onContextMenu={openCtx}
            />
          ))
        ) : streams.length ? (
          <div className="streams-empty">无匹配结果</div>
        ) : (
          <div className="streams-empty">
            <div>还没有流</div>
            <button type="button" onClick={() => setDialog({ kind: 'create' })}>
              ＋新建你的第一个流
            </button>
          </div>
        )}
      </div>

      {ctx && ctxStream && (
        <div
          className="context-menu"
          ref={menuRef}
          style={{ left: menuPos.x, top: menuPos.y }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="ctx-title">{ctxStream.name || '未命名流'}</div>
          <button
            type="button"
            onClick={() => {
              setCtx(null);
              onToggle(ctxStream.id, !ctxStream.visible);
            }}
          >
            <span className="ctx-ico">👁</span>
            {ctxStream.visible ? '从画布移除' : '显示到画布'}
          </button>
          <button
            type="button"
            onClick={() => {
              setCtx(null);
              setDialog({ kind: 'rename', id: ctxStream.id });
            }}
          >
            <span className="ctx-ico">✏️</span>重命名
          </button>
          <button
            type="button"
            onClick={() => {
              setCtx(null);
              setDialog({ kind: 'meta', id: ctxStream.id });
            }}
          >
            <span className="ctx-ico">🏷</span>编辑标签…
          </button>
          <button
            type="button"
            onClick={() => {
              setCtx(null);
              setDialog({ kind: 'saveAs', id: ctxStream.id });
            }}
          >
            <span className="ctx-ico">💾</span>另存为…
          </button>
          <div className="ctx-sep" />
          <button
            type="button"
            onClick={() => {
              setCtx(null);
              onDelete(ctxStream.id);
            }}
          >
            <span className="ctx-ico">🗑</span>删除流…
          </button>
        </div>
      )}

      {dialog?.kind === 'create' && (
        <StreamFormDialog
          title="新建流"
          streams={streams}
          onNotify={onNotify}
          onCancel={() => setDialog(null)}
          onSubmit={(v) => {
            setDialog(null);
            onCreate(v);
          }}
        />
      )}
      {dialog?.kind === 'saveAs' && byId.get(dialog.id) && (
        <SaveAsDialog
          stream={byId.get(dialog.id)}
          onCancel={() => setDialog(null)}
          onConfirm={(opts) => {
            setDialog(null);
            onSaveAs?.(dialog.id, opts);
          }}
        />
      )}
      {dialog?.kind === 'rename' && byId.get(dialog.id) && (
        <RenameDialog
          stream={byId.get(dialog.id)}
          streams={streams}
          onCancel={() => setDialog(null)}
          onSubmit={(name) => {
            setDialog(null);
            onRename(dialog.id, name);
          }}
        />
      )}
      {dialog?.kind === 'meta' && byId.get(dialog.id) && (
        <StreamMetaDialog
          stream={byId.get(dialog.id)}
          onCancel={() => setDialog(null)}
          onSubmit={(v) => {
            setDialog(null);
            onUpdateMeta(dialog.id, v);
            onNotify('已更新流标签', 'ok');
          }}
        />
      )}
    </div>
  );
}

/* ---------------- 对话框 ---------------- */

/** 新建流对话框；initial 可预填 `{ name?, description?, tags?, content?, source? }`（R-3.1）。 */
export function StreamFormDialog({ title, streams, initial, onCancel, onSubmit, onNotify }) {
  const [name, setName] = useState(initial?.name || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [tags, setTags] = useState(() => (Array.isArray(initial?.tags) ? initial.tags : []));
  const [content, setContent] = useState(
    initial?.content != null ? String(initial.content) : ''
  );
  // 流来源（从文件/清单加载时登记）：随提交透传到节点 data.source，
  // 自动保存经「已有 source 即保留」写回真实路径（外部文档写回改造）。
  const [source, setSource] = useState(initial?.source || null);
  const nameTrim = name.trim();
  const dup = streams.some((s) => (s.name || '') === nameTrim);
  const tagErr = validateTags(tags, [CANVAS_KEY], reservedPredicate);
  const nameErr = nameTrim ? streamNameError(nameTrim) : null;
  const err = !nameTrim
    ? '名称不能为空'
    : nameErr
      ? '名称不合法：仅字母/数字/下划线（支持中文），不得以数字开头或命中保留后缀'
      : dup
        ? `已存在同名流「${nameTrim}」`
        : tagErr;

  const notify = (msg, kind) => {
    if (typeof onNotify === 'function') onNotify(msg, kind);
    else console.warn(msg);
  };

  const loadLocalFile = async () => {
    try {
      const picked = await pickPath(DOC_FILTER, '选择文件');
      if (!picked) return;
      const kind = /\.se\.json$/i.test(picked) ? 'manifest' : null;
      if (kind === 'manifest') {
        // loadManifestFile 返回 { path, manifest }（无 manifestPath 键）；正文兄弟路径基准 = picked。
        const { manifest } = await loadManifestFile(picked);
        const { contents } = await fetchStreamContents({ manifest, manifestPath: picked });
        const s = streamFromManifest(manifest, contents);
        if (!s.ok) {
          notify(s.error, 'err');
          return;
        }
        if (s.name) setName(s.name);
        setContent(s.content);
        setDescription(s.description);
        setTags(tagsToRows(s.tags));
        // 清单内相对 source → 按清单所在目录解析为绝对路径后登记（写回真实路径）。
        setSource(
          s.source && s.source.file_path
            ? { file_path: resolveSiblingPath(picked, s.source.file_path), encoding: s.source.encoding || 'utf-8' }
            : null
        );
        notify('已从配置包加载', 'ok');
        return;
      }
      const text = await readFsText(picked);
      const cls = classifyStreamImport(picked, text);
      if (cls.kind === 'legacy') {
        notify('旧 frontmatter 流文件已废弃，请改用 .se.json 配置包', 'err');
        return;
      }
      setName(cls.name);
      setContent(cls.content);
      // 纯文本/MD：来源 = 所选文件本身。
      setSource({ file_path: String(picked).replace(/\\/g, '/'), encoding: 'utf-8' });
      notify('已从本地文件加载', 'ok');
    } catch (error) {
      notify(`加载失败：${(error && error.message) || error}`, 'err');
    }
  };

  return (
    <ModalOverlay onCancel={onCancel} closeOnEsc>
      <div className="modal">
        <h3>{title}</h3>
        <div className="dlg-row">
          <input
            type="text"
            placeholder="名称（必填）"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="dlg-row">
          <textarea
            className="dlg-textarea"
            placeholder="描述（可空；仅显示在流列表与元数据对话框，不上画布节点）"
            value={description}
            rows={3}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="dlg-row">
          <textarea
            className="dlg-textarea"
            placeholder="初始内容（可空；新建后写入该流正文）"
            value={content}
            rows={4}
            onChange={(e) => setContent(e.target.value)}
          />
        </div>
        <div className="dlg-row">
          <button type="button" onClick={loadLocalFile}>
            从本地文件加载…
          </button>
        </div>
        <div className="dlg-block">
          <div className="dlg-label">初始标签（可空）</div>
          <TagsEditor
            value={tags}
            onChange={setTags}
            excludeKeys={[CANVAS_KEY]}
            excludePredicate={reservedPredicate}
          />
        </div>
        {err && (nameTrim || tags.length > 0) && <div className="dlg-err">{err}</div>}
        <div className="dlg-actions">
          <button
            type="button"
            className="primary"
            disabled={!!err}
            onClick={() =>
              onSubmit({
                name: nameTrim,
                description: description.trim(),
                tags: cleanTags(tags),
                content,
                ...(source ? { source } : {}),
              })
            }
          >
            创建
          </button>
          <button type="button" onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}

function RenameDialog({ stream, streams, onCancel, onSubmit }) {
  const [name, setName] = useState(stream.name || '');
  const nameTrim = name.trim();
  const dup = streams.some((s) => s.id !== stream.id && (s.name || '') === nameTrim);
  const nameErr = nameTrim ? streamNameError(nameTrim) : null;
  const err = !nameTrim
    ? '名称不能为空'
    : nameErr
      ? '名称不合法：仅字母/数字/下划线（支持中文），不得以数字开头或命中保留后缀'
      : dup
        ? `已存在同名流「${nameTrim}」`
        : null;

  return (
    <ModalOverlay onCancel={onCancel} closeOnEsc>
      <div className="modal">
        <h3>重命名流</h3>
        <div className="dlg-note">
          名称即 SE 流标识：在线改名会级联改写引用该流的边键（<code>edge.&lt;name&gt;</code>），<b>不可撤销</b>。
        </div>
        <div className="dlg-row">
          <input
            type="text"
            placeholder="名称（必填）"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !err) onSubmit(nameTrim);
            }}
          />
        </div>
        {err && nameTrim !== (stream.name || '') && <div className="dlg-err">{err}</div>}
        <div className="dlg-actions">
          <button
            type="button"
            className="primary"
            disabled={!!err}
            onClick={() => onSubmit(nameTrim)}
          >
            重命名
          </button>
          <button type="button" onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}

function StreamMetaDialog({ stream, onCancel, onSubmit }) {
  const [description, setDescription] = useState(stream.description || '');
  // 仅额外排除 CANVAS_KEY：`stream.fields` 来自投影层 `tagsToFields`，后者已过滤 `edge.*`，
  // 故此处不会把边标签带入元数据编辑（若投影口径变更需同步此处）。
  const [tags, setTags] = useState(() =>
    (Array.isArray(stream.fields) ? stream.fields : []).filter((f) => f && f.key !== CANVAS_KEY)
  );
  const err = validateTags(tags, [CANVAS_KEY], reservedPredicate);

  return (
    <ModalOverlay onCancel={onCancel} closeOnEsc>
      <div className="modal">
        <h3>编辑标签 · {stream.name || '未命名流'}</h3>
        <div className="dlg-row">
          <textarea
            className="dlg-textarea"
            placeholder="描述（可空）"
            value={description}
            rows={3}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="dlg-block">
          <div className="dlg-label">标签（canvas 为系统保留键，只能经眼睛/右键菜单切换）</div>
          <TagsEditor
            value={tags}
            onChange={setTags}
            excludeKeys={[CANVAS_KEY]}
            excludePredicate={reservedPredicate}
          />
        </div>
        {err && <div className="dlg-err">{err}</div>}
        <div className="dlg-actions">
          <button
            type="button"
            className="primary"
            disabled={!!err}
            onClick={() => onSubmit({ description: description.trim(), tags: cleanTags(tags) })}
          >
            保存
          </button>
          <button type="button" onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}

/**
 * 流删除确认框（期 12 D2：受控组件，由 App 渲染）。
 * `inboundCount` = **服务端真源**入边引用数（绑定在线）或本地画布派生数（未绑定），
 * 与删除级联实际清除数一致（不再有自环 ±1 的免责说明）。
 */
export function DeleteStreamDialog({ title, inboundCount, onCancel, onConfirm, showFileOption = false }) {
  const [mode, setMode] = useState('file');
  return (
    <ModalOverlay onCancel={onCancel} closeOnEsc={false}>
      <div className="modal">
        <h3>删除流</h3>
        <div className="dlg-note">
          「{title || '未命名流'}」将从流管理（SE）中永久移除
          {inboundCount > 0 ? `，并清除 ${inboundCount} 条指向它的连线` : ''}。
        </div>
        {showFileOption ? (
          <div className="dlg-note">
            <label className="pkg-check">
              <input
                type="radio"
                name="stream-delete-mode"
                checked={mode === 'keep'}
                onChange={() => setMode('keep')}
              />
              仅移除流（保留对应正文文件）
            </label>
            <label className="pkg-check">
              <input
                type="radio"
                name="stream-delete-mode"
                checked={mode === 'file'}
                onChange={() => setMode('file')}
              />
              连同正文文件一起删除
            </label>
          </div>
        ) : (
          <div className="dlg-note">没有本图管理的正文文件，将仅清理本地记录。</div>
        )}
        <div className="dlg-actions">
          <button
            type="button"
            className="primary danger"
            onClick={() => onConfirm(showFileOption ? mode : 'keep')}
          >
            删除
          </button>
          <button type="button" onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}

/**
 * 「另存为…」对话框（右键菜单）：自包含，选择导出格式。
 * 确认后交由 App 的 `onSaveAs(id, { raw })` 执行构建 + 写盘：
 * 勾选 = 纯正文 .md（无元数据）；不勾选 = .se.json 配置包 + 兄弟正文。
 */
function SaveAsDialog({ stream, onCancel, onConfirm }) {
  const [rawOnly, setRawOnly] = useState(false);
  return (
    <ModalOverlay onCancel={onCancel} closeOnEsc>
      <div className="modal">
        <h3>另存为流文件</h3>
        <div className="dlg-note">将「{stream.name || '未命名流'}」保存为本地文件。</div>
        <label className="pkg-check">
          <input
            type="checkbox"
            checked={rawOnly}
            onChange={(e) => setRawOnly(e.target.checked)}
          />
          仅导出正文（.md，不含元数据）；取消勾选 = 导出 .se.json 配置包 + 兄弟正文
        </label>
        <div className="dlg-actions">
          <button type="button" className="primary" onClick={() => onConfirm({ raw: rawOnly })}>
            另存为
          </button>
          <button type="button" onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
