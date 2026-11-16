import { useCallback, useEffect, useMemo, useState } from 'react';
import ToolRow from './ToolRow.jsx';
import TagsEditor, { validateTags, cleanTags } from './TagsEditor.jsx';
import TagFilterBar, { matchTagFilter, collectTagKeys, collectTagValues } from './TagFilterBar.jsx';
import { isValidToolName, tagsToRows, rowsToTags, buildCallStub } from '../tools.js';
import { readFsText } from '../se/paths.js';
import { parseToolImport } from '../se/singleConfig.js';
import { buildPackage } from '../se/packageExport.js';
import { planToolBundles } from '../se/packageBundle.js';
import { toToolName } from '../se/nameContract.js';
import ModalOverlay from '../components/ModalOverlay.jsx';

const CODE_FILTER =
  '代码文件 (*.py;*.js;*.mjs;*.cjs;*.ts;*.sh;*.bat;*.ps1;*.rb;*.go;*.rs;*.java;*.c;*.cpp)|*.py;*.js;*.mjs;*.cjs;*.ts;*.sh;*.bat;*.ps1;*.rb;*.go;*.rs;*.java;*.c;*.cpp|所有文件 (*.*)|*.*';
const SE_FILTER = 'SE 配置包 (*.se.json)|*.se.json|JSON (*.json)|*.json|所有文件 (*.*)|*.*';

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

/** 打开系统保存框（可带默认文件名）；返回目标路径，取消返回 null，失败抛错。 */
async function pickSavePath(body) {
  const res = await fetch('/api/dialog/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data && data.path ? data.path : null;
}

/** 存在探针（POST `/api/fs/stat` `{path}`）：返回 `{exists,isFile,isDirectory,size}`；失败抛错。 */
async function statFsPath(target) {
  const res = await fetch('/api/fs/stat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: target }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data || {};
}

/**
 * 工具面板：当前标签页文档的工具集合（注册/编辑/删除真实可用）。
 * 期 8（D1=(a)/D2=(b)）：绑定在线时读/注册/删除接 SE；注册/删除需 root
 * （canManageTools 门控）；💾 期 10 启用（导出配置包）；📂 期 11 启用（导入预览）。
 */
export default function ToolPanel({
  tools,
  onNotify,
  onExport,
  onImport,
  canImport,
  onRegister,
  onAdopt,
  onUpdate,
  onDelete,
  onDeleteMany,
  onInsert,
  canManageTools = true,
  // 绑定在线（SE 系统）时删除/编辑走真实 tool.unregister；仅影响文案。
  bound = false,
  // 活动系统的 SE 注册状态：name → {state:'registered'|'unregistered'|'failed', reason?}；
  // 未绑定（本地 tab）为 null（无 SE 状态，不标注）。配置与 SE-only 分区展示。
  statusByName = null,
  seOnlyTools = {},
}) {
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState({});
  const [checkedNames, setCheckedNames] = useState(() => new Set());
  const [dialog, setDialog] = useState(null); // {kind:'register'} | {kind:'edit', name} | {kind:'delete', name} | {kind:'deleteMany', names}

  const list = useMemo(
    () => Object.values(tools || {}).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
    [tools]
  );
  const seOnlyList = useMemo(
    () => Object.values(seOnlyTools || {}).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
    [seOnlyTools]
  );
  const filterSource = useMemo(() => [...list, ...seOnlyList], [list, seOnlyList]);

  /* ---------------- 多选（R2） ---------------- */

  // 列表本身变化时裁剪已删名称；过滤变化不动选择（全选作用于全部工具）。
  // 无变化时返回同一 Set 引用，避免 effect → setState → 重渲染的死循环。
  useEffect(() => {
    setCheckedNames((prev) => {
      if (!prev.size) return prev;
      const valid = new Set(list.map((t) => t.name));
      let changed = false;
      const next = new Set();
      prev.forEach((n) => {
        if (valid.has(n)) next.add(n);
        else changed = true;
      });
      return changed ? next : prev;
    });
  }, [list]);

  const toggleCheck = useCallback((name) => {
    setCheckedNames((cur) => {
      const next = new Set(cur);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  // 全选/全不选作用于全部工具（不受标签过滤影响）。
  const allChecked = list.length > 0 && checkedNames.size === list.length;
  const setAll = (on) => setCheckedNames(on ? new Set(list.map((t) => t.name)) : new Set());

  /** 配置有、但 SE 未注册/注册失败的工具数（仅绑定态有意义）。 */
  const unregisteredCount = useMemo(() => {
    if (!statusByName) return 0;
    return list.filter((t) => statusByName[t.name] && statusByName[t.name].state !== 'registered').length;
  }, [list, statusByName]);

  const getTags = (t) => tagsToRows(t.tags);
  const tagKeys = useMemo(() => collectTagKeys(filterSource, getTags), [filterSource]);

  const filtered = useMemo(
    () =>
      list.filter((t) =>
        matchTagFilter(t, { search: query, filters }, getTags, (x) => [
          x.name,
          x.description || '',
          x.brief_description || '',
        ])
      ),
    [list, query, filters]
  );

  const filteredSeOnly = useMemo(
    () =>
      seOnlyList.filter((t) =>
        matchTagFilter(t, { search: query, filters }, getTags, (x) => [
          x.name,
          x.description || '',
          x.brief_description || '',
        ])
      ),
    [seOnlyList, query, filters]
  );

  const byName = useMemo(() => new Map(list.map((t) => [t.name, t])), [list]);

  return (
    <div className="tools-panel-v2">
      <div className="sidebar-head">
        <strong>工具</strong>
        <span className="sidebar-state">
          {filtered.length} / {list.length}
          {unregisteredCount > 0 && (
            <span className="tool-status-summary" title="配置已登记、但未注册进 SE（不可执行）">
              {' '}
              · {unregisteredCount} 未注册
            </span>
          )}
        </span>
        <button
          type="button"
          className="head-btn"
          title={canManageTools ? '注册新工具' : '需要 root 权限'}
          disabled={!canManageTools}
          onClick={() => setDialog({ kind: 'register' })}
        >
          ＋
        </button>
        <button
          type="button"
          className="head-btn"
          title="导出工具配置包（.se.json + 复刻执行目录）"
          onClick={() => onExport('tools')}
        >
          💾
        </button>
        <button
          type="button"
          className="head-btn"
          title={canImport ? '加载配置包（导入预览）' : '需要已绑定系统'}
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
        valuesFor={(key) => collectTagValues(filterSource, getTags, key)}
        filters={filters}
        onFilters={setFilters}
        placeholder="搜索工具"
      />
      <div className="tool-select-bar">
        <button
          type="button"
          className="head-btn"
          disabled={!list.length}
          onClick={() => setAll(!allChecked)}
        >
          {allChecked ? '全不选' : '全选'}
        </button>
        <span className="sidebar-state">
          已选 {checkedNames.size} / {list.length}
        </span>
        <button
          type="button"
          className="head-btn danger"
          disabled={!checkedNames.size || !canManageTools}
          title={canManageTools ? undefined : '需要 root 权限'}
          onClick={() => setDialog({ kind: 'deleteMany', names: [...checkedNames] })}
        >
          🗑 清理
        </button>
      </div>
      <div className="tool-list">
        {filtered.map((t) => (
          <ToolRow
            key={t.name}
            tool={t}
            status={statusByName ? statusByName[t.name] || null : null}
            canManage={canManageTools}
            checked={checkedNames.has(t.name)}
            onToggleCheck={toggleCheck}
            onOpen={(tool) => setDialog({ kind: 'edit', name: tool.name })}
            onInsert={onInsert}
            onEdit={(tool) => setDialog({ kind: 'edit', name: tool.name })}
            onDelete={(tool) => setDialog({ kind: 'delete', name: tool.name })}
          />
        ))}
        {!filtered.length && !filteredSeOnly.length && (list.length || seOnlyList.length) ? (
          <div className="streams-empty">无匹配结果</div>
        ) : null}
        {!list.length && !seOnlyList.length && (
          <div className="streams-empty">
            <div>还没有工具</div>
            <button
              type="button"
              disabled={!canManageTools}
              title={canManageTools ? undefined : '需要 root 权限'}
              onClick={() => setDialog({ kind: 'register' })}
            >
              ＋注册第一个工具
            </button>
          </div>
        )}
        {filteredSeOnly.length > 0 && (
          <section className="tool-se-only-section" aria-label="SE 已注册（未纳入配置）">
            <div className="home-group-title">
              SE 已注册（未纳入配置）
              <span className="count">{filteredSeOnly.length}</span>
            </div>
            {filteredSeOnly.map((t) => (
              <ToolRow key={t.name} tool={t} seOnly onAdopt={onAdopt} />
            ))}
          </section>
        )}
      </div>

      {(dialog?.kind === 'register' || (dialog?.kind === 'edit' && byName.get(dialog.name))) && (
        <ToolFormDialog
          tool={dialog.kind === 'edit' ? byName.get(dialog.name) : null}
          tools={list}
          onNotify={onNotify}
          onCancel={() => setDialog(null)}
          onSubmit={(def) => {
            const oldName = dialog.kind === 'edit' ? dialog.name : null;
            setDialog(null);
            if (oldName) {
              onUpdate(oldName, def);
            } else {
              onRegister(def);
            }
          }}
        />
      )}
      {dialog?.kind === 'delete' && byName.get(dialog.name) && (
        <ModalOverlay onCancel={() => setDialog(null)} closeOnEsc={false}>
          <div className="modal">
            <h3>删除工具</h3>
            <div className="dlg-note">
              {bound
                ? `将从 SE 系统注册表注销工具「${dialog.name}」（需要 root 权限）。`
                : `将从当前标签页文档中删除工具「${dialog.name}」。`}
              <br />
              已插入文本中的 @{dialog.name}|… 标记不会被改写。
            </div>
            <div className="dlg-actions">
              <button
                type="button"
                className="primary danger"
                onClick={() => {
                  const name = dialog.name;
                  setDialog(null);
                  onDelete(name);
                }}
              >
                删除
              </button>
              <button type="button" onClick={() => setDialog(null)}>
                取消
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}
      {dialog?.kind === 'deleteMany' && (
        <ModalOverlay onCancel={() => setDialog(null)} closeOnEsc={false}>
          <div className="modal">
            <h3>批量删除工具</h3>
            <div className="dlg-note">
              {bound
                ? `将从 SE 系统注册表中注销 ${dialog.names.length} 个工具（需要 root 权限）。`
                : `将从当前标签页文档中删除 ${dialog.names.length} 个工具。`}
              <br />已插入文本中的 @name|… 标记不会被改写。
            </div>
            <div className="dlg-actions">
              <button
                type="button"
                className="primary danger"
                onClick={() => {
                  const names = dialog.names;
                  setDialog(null);
                  onDeleteMany(names);
                }}
              >
                删除
              </button>
              <button type="button" onClick={() => setDialog(null)}>
                取消
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}
    </div>
  );
}

/* ---------------- 工具元数据对话框（注册/编辑共用） ---------------- */

/** 去掉最后一个扩展名（`a.b.py` → `a.b`）。 */
const stripExt = (s) => String(s).replace(/\.[^.]+$/, '');
/** 路径 basename 并去扩展名（兼容 `\\` 与 `/`）。 */
const fileBaseNameNoExt = (p) => stripExt(String(p).split(/[\\/]/).pop() || '');

/** 工具注册/编辑对话框；initial 可预填 `{ name?, tool_path? }`（R-3.2 代码文件注册）。 */
export function ToolFormDialog({ tool, tools, initial, onCancel, onSubmit, onNotify }) {
  const isEdit = !!tool;
  const [name, setName] = useState(tool?.name || initial?.name || '');
  const [description, setDescription] = useState(tool?.description || '');
  const [toolPath, setToolPath] = useState(tool?.tool_path || initial?.tool_path || '');
  const [executionPath, setExecutionPath] = useState(tool?.execution_path || '');
  const [manualPath, setManualPath] = useState(tool?.manual_path || '');
  const [brief, setBrief] = useState(tool?.brief_description || '');
  const [detailed, setDetailed] = useState(tool?.detailed_description || '');
  const [version, setVersion] = useState(tool?.version || '');
  const [tags, setTags] = useState(() => tagsToRows(tool?.tags));
  const [insertTemplate, setInsertTemplate] = useState(tool?.insert_template || '');
  // 「选文件即命名」：从 tool_path 的文件名带出 name 后锁定，需显式解锁才能手改（编辑既有工具不锁）。
  const [nameLocked, setNameLocked] = useState(false);

  const nameTrim = name.trim();
  const pathTrim = toolPath.trim();
  const descTrim = description.trim();
  const dup = tools.some((t) => t.name === nameTrim && t.name !== tool?.name);
  const tagErr = validateTags(tags);
  const err = !nameTrim
    ? '名称不能为空'
    : !isValidToolName(nameTrim)
      ? '名称仅允许字母、数字、下划线（支持中文），且不得以数字开头'
      : dup
        ? `已存在同名工具「${nameTrim}」`
        : !pathTrim
          ? 'tool_path 不能为空（可执行脚本文件或含 main.py 的目录）'
          : !descTrim
            ? 'description 不能为空'
            : tagErr;
  const renamed = isEdit && nameTrim !== tool.name;
  // 插入内容默认文本（placeholder）：随名称/schema 实时预览 buildCallStub 结果。
  const defaultInsert = buildCallStub({ name: nameTrim || tool?.name || '', input_schema: tool?.input_schema || {} });

  const notify = (msg, kind) => {
    if (typeof onNotify === 'function') onNotify(msg, kind);
    else console.warn(msg);
  };

  const probeToolPath = async () => {
    if (!pathTrim) return;
    try {
      const st = await statFsPath(pathTrim);
      if (st && st.exists === false) {
        notify(`tool_path 不存在：${pathTrim}（将仍尝试提交）`, 'warn');
      }
    } catch (error) {
      /* 探针失败不阻断提交 */
    }
  };

  const collectDef = () => ({
    name: nameTrim,
    description: description.trim(),
    tool_path: pathTrim,
    ...(executionPath.trim() ? { execution_path: executionPath.trim() } : {}),
    ...(manualPath.trim() ? { manual_path: manualPath.trim() } : {}),
    brief_description: brief.trim(),
    detailed_description: detailed.trim(),
    version: version.trim(),
    tags: rowsToTags(cleanTags(tags)),
    requires: Array.isArray(tool?.requires) ? tool.requires : [],
    input_schema: tool?.input_schema || {},
    // 需求2：前端私有，留空 = 使用 buildCallStub 自动生成（随配置持久化）。
    insert_template: insertTemplate.trim(),
  });

  const browseInto = async (setter) => {
    try {
      const picked = await pickPath(CODE_FILTER, '选择文件');
      if (picked) setter(picked);
    } catch (error) {
      notify(`无法打开系统对话框：${(error && error.message) || error}`, 'err');
    }
  };

  // Task 6：选代码文件 → 回填 tool_path，并在 name 为空或仍锁定时用文件名派生合规工具名。
  const browseToolFile = async () => {
    try {
      const picked = await pickPath(CODE_FILTER, '选择代码文件');
      if (!picked) return;
      setToolPath(picked);
      if (!name.trim() || nameLocked) {
        const taken = new Set((tools || []).map((t) => t.name));
        setName(toToolName(fileBaseNameNoExt(picked), taken));
      }
      setNameLocked(true);
    } catch (error) {
      notify(`无法打开系统对话框：${(error && error.message) || error}`, 'err');
    }
  };

  const importToolPackage = async () => {
    try {
      const picked = await pickPath(SE_FILTER, '选择工具配置包（.se.json）');
      if (!picked) return;
      if (/\.tool\.json$/i.test(picked)) {
        notify('旧 .tool.json 已废弃，请改用 .se.json 工具配置包', 'err');
        return;
      }
      const text = await readFsText(picked);
      const parsed = parseToolImport(text);
      if (!parsed.ok) {
        notify(parsed.error, 'err');
        return;
      }
      const imported = parsed.tool;
      setName(imported.name || '');
      setDescription(imported.description || '');
      setToolPath(imported.tool_path || '');
      setExecutionPath(imported.execution_path || '');
      setManualPath(imported.manual_path || '');
      setBrief(imported.brief_description || '');
      setDetailed(imported.detailed_description || '');
      setVersion(imported.version || '');
      setTags(tagsToRows(imported.tags));
      setInsertTemplate(imported.insert_template || '');
      notify(`已从配置包导入「${imported.name}」`, 'ok');
    } catch (error) {
      notify(`导入失败：${(error && error.message) || error}`, 'err');
    }
  };

  const exportToolPackage = async () => {
    try {
      const nd = collectDef();
      if (!nd.name.trim()) {
        notify('请先填写工具名', 'warn');
        return;
      }
      const picked = await pickSavePath({
        filter: SE_FILTER,
        defaultName: `${nd.name}.se.json`,
        title: '导出工具配置包',
      });
      if (!picked) return;
      const baseDir = picked.split(/[\\/]/).slice(0, -1).join('/');
      // 与整包导出同一引擎：默认镜像执行目录，脚本/数据随包走。
      // 相对 tool_path 的基准是“当前工作文档”，不是导出目的地；未知时只做路径改写，不复制。
      const isAbsTool =
        /^[A-Za-z]:[\\/]/.test(String(nd.tool_path || '')) ||
        String(nd.tool_path || '').startsWith('//') ||
        String(nd.tool_path || '').startsWith('/');
      const bundle = isAbsTool
        ? planToolBundles({ tools: [nd], baseDir, mode: 'dir' })
        : { rewrites: {}, copies: [] };
      const built = buildPackage({
        displayName: nd.name,
        streams: [],
        tools: [nd],
        baseDir,
        toolRewrites: bundle.rewrites,
        copies: bundle.copies,
      });
      // buildPackage 对非法工具名只记 warning 并跳过；防空包落盘。
      if (!Object.keys((built.manifest && built.manifest.tools) || {}).length) {
        notify('导出失败：工具名不合法（须字母/数字/下划线，支持中文，不得以数字开头）', 'err');
        return;
      }
      const manifestRel = `${nd.name}.se.json`;
      const manifestFile = built.files.find((f) => f.relPath === manifestRel);
      if (!manifestFile) throw new Error('manifest 缺失');
      const join = (dir, rel) => `${String(dir).replace(/[\\/]+$/, '')}/${rel}`;
      const res = await fetch('/api/package/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: built.files
            .filter((f) => f.relPath !== manifestRel)
            .map((f) => ({ path: join(baseDir, f.relPath), text: f.text })),
          copies: built.copies.map((c) => ({
            from: c.from,
            to: join(baseDir, c.to),
            unit: c.unit,
          })),
          manifest: { path: picked, text: manifestFile.text },
          options: { overwrite: true },
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
      notify('已导出工具配置包', 'ok');
    } catch (error) {
      notify(`导出失败：${(error && error.message) || error}`, 'err');
    }
  };

  return (
    <ModalOverlay onCancel={onCancel} closeOnEsc>
      <div className="modal modal-wide">
        <h3>{isEdit ? `编辑工具 · ${tool.name}` : '注册工具'}</h3>
        <div className="dlg-row">
          <button type="button" onClick={importToolPackage}>
            从配置包导入…
          </button>
          {isEdit && (
            <button type="button" onClick={exportToolPackage}>
              导出工具配置包…
            </button>
          )}
        </div>
        <div className="dlg-row">
          <input
            type="text"
            placeholder="名称（必填；字母/数字/下划线，支持中文）"
            value={name}
            autoFocus={!isEdit}
            spellCheck={false}
            readOnly={nameLocked}
            onChange={(e) => setName(e.target.value)}
          />
          {nameLocked && (
            <button type="button" onClick={() => setNameLocked(false)}>
              解锁名称
            </button>
          )}
        </div>
        {nameLocked && (
          <div className="dlg-note">名称来自所选文件名（已去扩展名）；如需手改请点「解锁名称」。</div>
        )}
        {renamed && (
          <div className="dlg-note">改名提示：已插入文本中的 @{tool.name}|… 不会被改写。</div>
        )}
        <div className="dlg-row">
          <input
            type="text"
            placeholder="tool_path（必填；可执行脚本文件或含 main.py 的目录）"
            value={toolPath}
            spellCheck={false}
            onChange={(e) => setToolPath(e.target.value)}
          />
          <button type="button" onClick={browseToolFile}>
            浏览…
          </button>
        </div>
        <div className="dlg-row">
          <input
            type="text"
            placeholder="execution_path（可空；执行时工作目录 cwd）"
            value={executionPath}
            spellCheck={false}
            onChange={(e) => setExecutionPath(e.target.value)}
          />
          <button type="button" onClick={() => browseInto(setExecutionPath)}>
            浏览…
          </button>
        </div>
        <div className="dlg-row">
          <input
            type="text"
            placeholder="manual_path（可空；使用手册文件）"
            value={manualPath}
            spellCheck={false}
            onChange={(e) => setManualPath(e.target.value)}
          />
          <button type="button" onClick={() => browseInto(setManualPath)}>
            浏览…
          </button>
        </div>
        <div className="dlg-row">
          <textarea
            className="dlg-textarea"
            placeholder="description（必填）"
            value={description}
            rows={2}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="dlg-row">
          <textarea
            className="dlg-textarea"
            placeholder="brief_description（可空）"
            value={brief}
            rows={2}
            onChange={(e) => setBrief(e.target.value)}
          />
        </div>
        <div className="dlg-row">
          <textarea
            className="dlg-textarea"
            placeholder="detailed_description（可空）"
            value={detailed}
            rows={3}
            onChange={(e) => setDetailed(e.target.value)}
          />
        </div>
        <div className="dlg-row">
          <input
            type="text"
            placeholder="version（可空）"
            value={version}
            spellCheck={false}
            onChange={(e) => setVersion(e.target.value)}
          />
        </div>
        <div className="dlg-block">
          <div className="dlg-label">tags</div>
          <TagsEditor value={tags} onChange={setTags} />
        </div>
        <div className="dlg-block">
          <div className="dlg-label">input_schema（只读；真实场景由工具自身上报）</div>
          <pre className="schema-view">
            {Object.keys(tool?.input_schema || {}).length
              ? JSON.stringify(tool.input_schema, null, 2)
              : '（空）'}
          </pre>
        </div>
        <div className="dlg-block">
          <div className="dlg-label">插入内容（留空 = 使用下方默认生成）</div>
          <textarea
            className="dlg-textarea"
            placeholder={defaultInsert}
            value={insertTemplate}
            rows={2}
            spellCheck={false}
            onChange={(e) => setInsertTemplate(e.target.value)}
          />
          <div className="dlg-note">
            双击 / 📋 插入的完整文本（含调用标记全体）；留空则插入默认生成结果。
            {insertTemplate ? '' : ` 当前默认：${defaultInsert}`}
          </div>
          <div className="dlg-row">
            <button
              type="button"
              disabled={!insertTemplate}
              onClick={() => setInsertTemplate('')}
            >
              恢复默认
            </button>
          </div>
        </div>
        {err && (nameTrim || tags.length > 0) && <div className="dlg-err">{err}</div>}
        <div className="dlg-actions">
          <button
            type="button"
            className="primary"
            disabled={!!err}
            onClick={() => {
              probeToolPath();
              onSubmit({
                name: nameTrim,
                description: description.trim(),
                tool_path: pathTrim,
                ...(executionPath.trim() ? { execution_path: executionPath.trim() } : {}),
                ...(manualPath.trim() ? { manual_path: manualPath.trim() } : {}),
                brief_description: brief.trim(),
                detailed_description: detailed.trim(),
                version: version.trim(),
                tags: rowsToTags(cleanTags(tags)),
                // requires 不在表单中暴露；tool.register 为全量替换，必须透传保真。
                requires: Array.isArray(tool?.requires) ? tool.requires : [],
                input_schema: tool?.input_schema || {},
                // 需求2：前端私有插入内容定制；留空 = 使用默认生成。
                insert_template: insertTemplate.trim(),
              });
            }}
          >
            {isEdit ? '保存' : '注册'}
          </button>
          <button type="button" onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
