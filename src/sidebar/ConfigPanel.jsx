import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ModalOverlay from '../components/ModalOverlay.jsx';
import {
  canonConfigPath,
  loadConfigRegistry,
  saveConfigRegistry,
  registerEntry,
  removeEntry,
  touchEntry,
} from '../configRegistry.js';
import { portableDocPath, stripBom } from '../se/paths.js';
import { rewriteSourcePrefixInDoc } from '../document.js';
import { getProjectRoot } from '../se/projectRoot.js';

const CONFIG_FILTER = '配置文件 (*.se.json)|*.se.json|所有文件 (*.*)|*.*';
const SE_EXT_RE = /\.se\.json$/i;
const ILLEGAL_NAME_RE = /[\\/:*?"<>|]/;

/** 登记 / 去重比较键：注入项目根，使绝对/相对混合路径同口径（与 App 的 canonDocPath 一致）。 */
const cfgKey = (p) => canonConfigPath(p, getProjectRoot());

/** 打开系统文件选择框；取消 → null，失败抛错（与 StreamPanel 的 pickPath 同通路）。 */
async function pickPath(filter, title) {
  const res = await fetch('/api/dialog/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filter, title }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data && data.path ? String(data.path).replace(/\\/g, '/') : null;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/** 配置内相对 source 前缀 `<oldBase>.streams/` → `<newBase>.streams/`（改名/复制后保持一致）。 */
async function rewriteSourcePrefix(configPath, oldBase, newBase) {
  if (!oldBase || !newBase || oldBase === newBase) return true;
  const read = await postJson('/api/fs/read', { path: configPath });
  if (!read.ok) return false;
  let doc;
  try {
    doc = JSON.parse(stripBom(read.data && read.data.text != null ? read.data.text : ''));
  } catch (err) {
    return false;
  }
  if (!doc || !Array.isArray(doc.streams)) return false;
  if (!rewriteSourcePrefixInDoc(doc, oldBase, newBase)) return true;
  const write = await postJson('/api/fs/write', {
    path: configPath,
    text: JSON.stringify(doc, null, 2),
    atomic: true,
  });
  return !!write.ok;
}

const isGraphsPath = (p) => /^graphs\//i.test(String(p || '').replace(/\\/g, '/'));
/** `<名>.se.json` 的兄弟正文目录 `<名>.streams`。 */
const streamsDirOf = (cfgPath) => cfgPath.replace(SE_EXT_RE, '.streams');
const dirOf = (p) => {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i) : '';
};
const baseOf = (p) => p.split('/').pop().replace(SE_EXT_RE, '');

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

function fmtTime(ms) {
  const n = Number(ms) || 0;
  return n ? new Date(n).toLocaleString('zh-CN', { hour12: false }) : '';
}

/**
 * 配置面板：本地配置文件的列表化管理（方案 §3）。
 * 数据源 = /api/graphs（graphs/ 目录扫描）∪ 外部登记表（.configs.json），按 canon 路径去重。
 * graphs 项移除 = 物理删除；外部项分「物理删除」与「仅从列表移除」两个独立出口。
 */
export default function ConfigPanel({ onNotify, openPaths, onOpenPath, onCreateNew, onOpenTabRenamed }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState('mtime');
  const [selectedPath, setSelectedPath] = useState(null);
  const [checkedPaths, setCheckedPaths] = useState(() => new Set());
  const [ctx, setCtx] = useState(null);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const [dialog, setDialog] = useState(null);
  const menuRef = useRef(null);

  const notify = useCallback(
    (msg, kind) => (typeof onNotify === 'function' ? onNotify(msg, kind) : console.warn(msg)),
    [onNotify]
  );

  /* ---------------- 数据源：目录扫描 ∪ 登记表 ---------------- */

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [graphsRes, registry] = await Promise.all([
        fetch('/api/graphs').then((r) => (r.ok ? r.json() : [])).catch(() => []),
        loadConfigRegistry(),
      ]);
      const openCanons = openPaths instanceof Set
        ? openPaths
        : new Set(Array.isArray(openPaths) ? openPaths : []);
      const merged = new Map();
      for (const g of Array.isArray(graphsRes) ? graphsRes : []) {
        if (!g || !g.path) continue;
        const path = String(g.path).replace(/\\/g, '/');
        merged.set(cfgKey(path), {
          name: baseOf(path),
          path,
          mtime: Number(g.mtime) || 0,
          size: Number(g.size) || 0,
          origin: 'graphs',
          status: openCanons.has(cfgKey(path)) ? 'open' : null,
          lastOpenedAt: 0,
        });
      }
      const externals = registry.filter((e) => !isGraphsPath(e.path));
      // 外部项逐个探测存在性（本地延迟可忽略，不做 watcher——方案 §3.2）。
      const stats = await Promise.all(
        externals.map((e) => postJson('/api/fs/stat', { path: e.path }).catch(() => null))
      );
      externals.forEach((e, i) => {
        const canon = cfgKey(e.path);
        if (merged.has(canon)) return; // graphs 扫描优先（同路径已在目录下）
        const exists = stats[i] && stats[i].ok && stats[i].data && stats[i].data.exists;
        merged.set(canon, {
          name: baseOf(e.path),
          path: e.path,
          mtime: 0,
          size: 0,
          origin: 'external',
          status: !exists ? 'missing' : openCanons.has(canon) ? 'open' : null,
          lastOpenedAt: Number(e.lastOpenedAt) || 0,
        });
      });
      setItems([...merged.values()]);
    } catch (err) {
      notify(`刷新配置列表失败：${(err && err.message) || err}`, 'warn');
    } finally {
      setLoading(false);
    }
  }, [openPaths, notify]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /* ---------------- 过滤 / 排序 / 多选 ---------------- */

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? items.filter(
          (it) => it.name.toLowerCase().includes(q) || it.path.toLowerCase().includes(q)
        )
      : items.slice();
    list.sort((a, b) => {
      if (sortKey === 'name') return a.name.localeCompare(b.name, 'zh-CN');
      if (sortKey === 'opened') return (b.lastOpenedAt || b.mtime) - (a.lastOpenedAt || a.mtime);
      return b.mtime - a.mtime;
    });
    return list;
  }, [items, query, sortKey]);

  // 列表变化时裁剪已消失的勾选（同 StreamPanel 口径；无变化返回原引用防重渲染循环）。
  useEffect(() => {
    setCheckedPaths((prev) => {
      if (!prev.size) return prev;
      const valid = new Set(items.map((it) => cfgKey(it.path)));
      let changed = false;
      const next = new Set();
      prev.forEach((c) => {
        if (valid.has(c)) next.add(c);
        else changed = true;
      });
      return changed ? next : prev;
    });
  }, [items]);

  const toggleCheck = useCallback((path) => {
    const canon = cfgKey(path);
    setCheckedPaths((cur) => {
      const next = new Set(cur);
      if (next.has(canon)) next.delete(canon);
      else next.add(canon);
      return next;
    });
  }, []);

  const allChecked = items.length > 0 && checkedPaths.size === items.length;

  /* ---------------- 右键菜单（与 StreamPanel 同机制） ---------------- */

  const openCtx = (e, path) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuPos({ x: e.clientX, y: e.clientY });
    setCtx({ x: e.clientX, y: e.clientY, path });
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

  /* ---------------- 行操作（方案 §3.2 矩阵） ---------------- */

  const byCanon = useMemo(() => {
    const m = new Map();
    items.forEach((it) => m.set(cfgKey(it.path), it));
    return m;
  }, [items]);
  const ctxItem = ctx ? byCanon.get(cfgKey(ctx.path)) : null;

  const touchRegistry = useCallback((fn) => {
    loadConfigRegistry()
      .then((entries) => saveConfigRegistry(fn(entries)))
      .catch(() => {});
  }, []);

  const openItem = useCallback(
    (item) => {
      if (!item || item.status === 'missing') return;
      onOpenPath(item.path);
      if (item.origin === 'external') touchRegistry((es) => touchEntry(es, item.path, getProjectRoot()));
    },
    [onOpenPath, touchRegistry]
  );

  const addExternal = useCallback(async () => {
    try {
      const picked = await pickPath(CONFIG_FILTER, '添加外部配置');
      if (!picked) return;
      if (!SE_EXT_RE.test(picked)) {
        notify('请选择 .se.json 配置文件', 'warn');
        return;
      }
      if (!isGraphsPath(picked)) {
        const entries = await loadConfigRegistry();
        await saveConfigRegistry(
          registerEntry(entries, portableDocPath(picked, getProjectRoot()), getProjectRoot())
        );
      }
      onOpenPath(picked);
    } catch (err) {
      notify(`添加外部配置失败：${(err && err.message) || err}`, 'err');
    }
  }, [notify, onOpenPath]);

  /** 物理删除一个项（文件 + 兄弟 .streams/ 目录 + history/登记清理）。调用方负责确认与已打开守卫。 */
  const physicalDelete = useCallback(
    async (item) => {
      const r1 = await postJson('/api/fs/delete', { path: item.path });
      if (!r1.ok) throw new Error((r1.data && r1.data.error) || `HTTP ${r1.status}`);
      await postJson('/api/fs/delete', { path: streamsDirOf(item.path), recursive: true });
      await postJson('/api/history/delete', { path: item.path });
      if (item.origin === 'external') {
        const entries = await loadConfigRegistry();
        await saveConfigRegistry(removeEntry(entries, item.path, getProjectRoot()));
      }
    },
    []
  );

  const copyConfig = useCallback(
    async (item) => {
      const dir = dirOf(item.path);
      let target = `${dir}/${item.name}_copy.se.json`;
      let r = await postJson('/api/fs/copy', { from: item.path, to: target });
      for (let i = 2; r.status === 409 && i <= 50; i += 1) {
        target = `${dir}/${item.name}_copy_${i}.se.json`;
        r = await postJson('/api/fs/copy', { from: item.path, to: target });
      }
      if (!r.ok) throw new Error((r.data && r.data.error) || `HTTP ${r.status}`);
      // 兄弟正文目录随配置一并复制（包完整性）。
      const srcDir = streamsDirOf(item.path);
      const dirStat = await postJson('/api/fs/stat', { path: srcDir });
      if (dirStat.ok && dirStat.data && dirStat.data.exists) {
        await postJson('/api/fs/copy', { from: srcDir, to: streamsDirOf(target) });
      }
      const rewritten = await rewriteSourcePrefix(target, item.name, baseOf(target));
      if (!rewritten) throw new Error('副本正文路径改写失败');
      return target;
    },
    []
  );

  const renameItem = useCallback(
    async (item, newBase) => {
      const dir = dirOf(item.path);
      const newPath = `${dir}/${newBase}.se.json`;
      if (cfgKey(newPath) === cfgKey(item.path)) return;
      const r = await postJson('/api/fs/move', { from: item.path, to: newPath });
      if (!r.ok) throw new Error((r.data && r.data.error) || `HTTP ${r.status}`);
      const oldDir = streamsDirOf(item.path);
      const dirStat = await postJson('/api/fs/stat', { path: oldDir });
      if (dirStat.ok && dirStat.data && dirStat.data.exists) {
        await postJson('/api/fs/move', { from: oldDir, to: streamsDirOf(newPath) });
      }
      const rewritten = await rewriteSourcePrefix(newPath, baseOf(item.path), newBase);
      if (!rewritten) notify('配置文件已改名，但正文路径改写失败；请检查该配置的 source.file_path', 'warn');
      // 已打开项：tab 的 docPath / manifest_path 跟随新路径（tab 名不变——身份链既定决策）。
      if (item.status === 'open' && typeof onOpenTabRenamed === 'function') {
        onOpenTabRenamed(item.path, newPath);
      }
      await postJson('/api/history/delete', { path: item.path });
      if (item.origin === 'external') {
        const entries = await loadConfigRegistry();
        const kept = entries.find((e) => cfgKey(e.path) === cfgKey(item.path));
        let next = removeEntry(entries, item.path, getProjectRoot());
        next = registerEntry(next, portableDocPath(newPath, getProjectRoot()), getProjectRoot());
        if (kept && kept.addedAt) {
          next = next.map((e) =>
            cfgKey(e.path) === cfgKey(newPath)
              ? { ...e, addedAt: kept.addedAt }
              : e
          );
        }
        await saveConfigRegistry(next);
      }
      notify(`已重命名为「${newBase}」`, 'ok');
    },
    [notify, onOpenTabRenamed]
  );

  /* ---------------- 渲染 ---------------- */

  return (
    <div className="streams-panel cfg-panel">
      <div className="sidebar-head">
        <strong>配置</strong>
        <span className="sidebar-state">共 {items.length}</span>
        <button type="button" className="head-btn" title="刷新列表" onClick={refresh}>
          ⟳
        </button>
        <button type="button" className="head-btn" title="新建配置" onClick={onCreateNew}>
          ＋新建
        </button>
        <button type="button" className="head-btn" title="添加外部配置…" onClick={addExternal}>
          📂
        </button>
      </div>

      <div className="cfg-toolbar">
        <input
          type="text"
          className="cfg-search"
          placeholder="搜索名称/路径"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="cfg-sort"
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value)}
          title="排序"
        >
          <option value="mtime">修改时间</option>
          <option value="name">名称</option>
          <option value="opened">最近打开</option>
        </select>
      </div>

      <div className="stream-select-bar">
        <button
          type="button"
          className="head-btn"
          disabled={!items.length}
          onClick={() =>
            setCheckedPaths(allChecked ? new Set() : new Set(items.map((it) => cfgKey(it.path))))
          }
        >
          {allChecked ? '全不选' : '全选'}
        </button>
        <span className="sidebar-state">
          已选 {checkedPaths.size} / {items.length}
        </span>
        <button
          type="button"
          className="head-btn danger"
          disabled={!checkedPaths.size}
          onClick={() => setDialog({ kind: 'deleteMany' })}
        >
          🗑 批量删除
        </button>
      </div>

      <div className="stream-list cfg-list">
        {loading ? (
          <div className="streams-empty">加载中…</div>
        ) : filtered.length ? (
          filtered.map((it) => (
            <div
              key={cfgKey(it.path)}
              className={
                'cfg-row' +
                (selectedPath === cfgKey(it.path) ? ' selected' : '') +
                (it.status === 'missing' ? ' missing' : '')
              }
              onClick={() => setSelectedPath(cfgKey(it.path))}
              onDoubleClick={() => openItem(it)}
              onContextMenu={(e) => openCtx(e, it.path)}
              title={it.path}
            >
              <input
                type="checkbox"
                checked={checkedPaths.has(cfgKey(it.path))}
                onClick={(e) => e.stopPropagation()}
                onChange={() => toggleCheck(it.path)}
              />
              <div className="cfg-row-main">
                <div className="cfg-row-title">
                  <span className="cfg-name">{it.name || '未命名'}</span>
                  {it.origin === 'external' && <span className="cfg-badge">外部</span>}
                  {it.status === 'open' && <span className="cfg-badge open">已打开</span>}
                  {it.status === 'missing' && <span className="cfg-badge warn">⚠缺失</span>}
                </div>
                <div className="cfg-row-meta">
                  {it.path}
                  {it.size ? ` · ${fmtSize(it.size)}` : ''}
                  {it.mtime ? ` · ${fmtTime(it.mtime)}` : ''}
                </div>
              </div>
            </div>
          ))
        ) : items.length ? (
          <div className="streams-empty">无匹配结果</div>
        ) : (
          <div className="streams-empty">
            <div>还没有配置</div>
            <button type="button" onClick={onCreateNew}>
              新建配置
            </button>
            <button
              type="button"
              onClick={async () => {
                try {
                  const picked = await pickPath(CONFIG_FILTER, '打开配置文件');
                  if (!picked) return;
                  if (!isGraphsPath(picked)) {
                    const entries = await loadConfigRegistry();
                    await saveConfigRegistry(
                      registerEntry(entries, portableDocPath(picked, getProjectRoot()), getProjectRoot())
                    );
                  }
                  onOpenPath(picked);
                } catch (err) {
                  notify(`打开失败：${(err && err.message) || err}`, 'err');
                }
              }}
            >
              打开文件…
            </button>
            <button type="button" onClick={addExternal}>
              添加外部配置…
            </button>
          </div>
        )}
      </div>

      {ctx && ctxItem && (
        <div
          className="context-menu"
          ref={menuRef}
          style={{ left: menuPos.x, top: menuPos.y }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="ctx-title">{ctxItem.name || '未命名'}</div>
          <button
            type="button"
            disabled={ctxItem.status === 'missing'}
            onClick={() => {
              setCtx(null);
              openItem(ctxItem);
            }}
          >
            <span className="ctx-ico">📂</span>打开
          </button>
          <button
            type="button"
            disabled={ctxItem.status === 'missing'}
            onClick={() => {
              setCtx(null);
              setDialog({ kind: 'rename', path: ctxItem.path });
            }}
          >
            <span className="ctx-ico">✏️</span>重命名…
          </button>
          <button
            type="button"
            disabled={ctxItem.status === 'missing'}
            onClick={async () => {
              setCtx(null);
              try {
                const target = await copyConfig(ctxItem);
                notify(`已创建副本：${baseOf(target)}`, 'ok');
                refresh();
              } catch (err) {
                notify(`复制失败：${(err && err.message) || err}`, 'err');
              }
            }}
          >
            <span className="ctx-ico">📄</span>复制副本
          </button>
          <div className="ctx-sep" />
          {ctxItem.origin === 'external' && (
            <button
              type="button"
              onClick={() => {
                setCtx(null);
                loadConfigRegistry()
                  .then((es) => saveConfigRegistry(removeEntry(es, ctxItem.path, getProjectRoot())))
                  .then(() => {
                    notify('已从列表移除（文件保留）', 'ok');
                    refresh();
                  })
                  .catch((err) => notify(`移除失败：${(err && err.message) || err}`, 'err'));
              }}
            >
              <span className="ctx-ico">🚫</span>仅从列表移除
            </button>
          )}
          <button
            type="button"
            className="danger"
            onClick={() => {
              setCtx(null);
              setDialog({ kind: 'delete', path: ctxItem.path });
            }}
          >
            <span className="ctx-ico">🗑</span>物理删除…
          </button>
        </div>
      )}

      {dialog?.kind === 'rename' && byCanon.get(cfgKey(dialog.path)) && (
        <RenameConfigDialog
          item={byCanon.get(cfgKey(dialog.path))}
          onCancel={() => setDialog(null)}
          onSubmit={async (newBase) => {
            const item = byCanon.get(cfgKey(dialog.path));
            setDialog(null);
            try {
              await renameItem(item, newBase);
              refresh();
            } catch (err) {
              notify(`重命名失败：${(err && err.message) || err}`, 'err');
            }
          }}
        />
      )}
      {dialog?.kind === 'delete' && byCanon.get(cfgKey(dialog.path)) && (
        <DeleteConfigDialog
          item={byCanon.get(cfgKey(dialog.path))}
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            const item = byCanon.get(cfgKey(dialog.path));
            setDialog(null);
            try {
              await physicalDelete(item);
              notify(`已永久删除「${item.name}」`, 'ok');
              refresh();
            } catch (err) {
              notify(`删除失败：${(err && err.message) || err}`, 'err');
            }
          }}
        />
      )}
      {dialog?.kind === 'deleteMany' && (
        <DeleteManyDialog
          items={items.filter((it) => checkedPaths.has(cfgKey(it.path)))}
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            const targets = items.filter((it) => checkedPaths.has(cfgKey(it.path)));
            setDialog(null);
            let done = 0;
            let skipped = 0;
            for (const it of targets) {
              if (it.status === 'open') {
                skipped += 1;
                continue;
              }
              try {
                await physicalDelete(it);
                done += 1;
              } catch (err) {
                notify(`删除「${it.name}」失败：${(err && err.message) || err}`, 'warn');
              }
            }
            setCheckedPaths(new Set());
            notify(
              `批量删除完成：${done} 个已删除${skipped ? `，${skipped} 个已打开项跳过` : ''}`,
              skipped ? 'warn' : 'ok'
            );
            refresh();
          }}
        />
      )}
    </div>
  );
}

/* ---------------- 对话框 ---------------- */

function RenameConfigDialog({ item, onCancel, onSubmit }) {
  const [name, setName] = useState(item.name || '');
  const nameTrim = name.trim();
  const err = !nameTrim
    ? '名称不能为空'
    : ILLEGAL_NAME_RE.test(nameTrim)
      ? '名称含非法字符（\\ / : * ? " < > |）'
      : null;

  return (
    <ModalOverlay onCancel={onCancel} closeOnEsc>
      <div className="modal">
        <h3>重命名配置</h3>
        <div className="dlg-note">
          配置文件与兄弟 <code>.streams/</code> 目录一并改名
          {item.status === 'open' ? '；该配置已打开，标签页将指向新路径（标签名不变）' : ''}。
        </div>
        <div className="dlg-row">
          <input
            type="text"
            placeholder="名称（不含 .se.json 后缀）"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !err) onSubmit(nameTrim);
            }}
          />
        </div>
        {err && nameTrim !== (item.name || '') && <div className="dlg-err">{err}</div>}
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

function DeleteConfigDialog({ item, onCancel, onConfirm }) {
  const [dirInfo, setDirInfo] = useState(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const dir = streamsDirOf(item.path);
      const st = await postJson('/api/fs/stat', { path: dir });
      if (!st.ok || !st.data || !st.data.exists) return;
      let count = -1;
      try {
        const res = await fetch(`/api/fs/list?path=${encodeURIComponent(dir)}`);
        if (res.ok) {
          const data = await res.json();
          count = Array.isArray(data.entries) ? data.entries.length : -1;
        }
      } catch (err) {
        /* 计数失败只影响提示文案 */
      }
      if (!cancelled) setDirInfo({ exists: true, count });
    })();
    return () => {
      cancelled = true;
    };
  }, [item.path]);

  const blocked = item.status === 'open';
  return (
    <ModalOverlay onCancel={onCancel} closeOnEsc={!blocked}>
      <div className="modal">
        <h3>物理删除配置</h3>
        <div className="dlg-note">
          {blocked ? (
            <>该配置已在标签页中打开，请先关闭对应标签页再删除。</>
          ) : (
            <>
              将永久删除 <b>{item.name}.se.json</b>
              {dirInfo
                ? ` 及其 ${baseOf(item.path)}.streams/ 目录${
                    dirInfo.count >= 0 ? `（含 ${dirInfo.count} 个文件）` : ''
                  }`
                : ''}
              ，不可恢复。
            </>
          )}
        </div>
        <div className="dlg-actions">
          <button
            type="button"
            className="primary danger"
            disabled={blocked}
            onClick={onConfirm}
          >
            永久删除
          </button>
          <button type="button" onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}

function DeleteManyDialog({ items, onCancel, onConfirm }) {
  const openCount = items.filter((it) => it.status === 'open').length;
  return (
    <ModalOverlay onCancel={onCancel} closeOnEsc>
      <div className="modal">
        <h3>批量物理删除</h3>
        <div className="dlg-note">
          将永久删除 {items.length - openCount} 个配置（各自含兄弟 .streams/ 目录），不可恢复。
          {openCount ? `另有 ${openCount} 个已打开项将被跳过。` : ''}
        </div>
        <div className="dlg-actions">
          <button
            type="button"
            className="primary danger"
            disabled={items.length - openCount === 0}
            onClick={onConfirm}
          >
            永久删除
          </button>
          <button type="button" onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
