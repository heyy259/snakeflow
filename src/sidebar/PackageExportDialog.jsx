import { useEffect, useMemo, useRef, useState } from 'react';
import ModalOverlay from '../components/ModalOverlay.jsx';

/**
 * 配置包导出对话框（期 10 · D3）——纯选择 / 展示层。
 *
 * 边界：本组件只负责「选哪些流/工具、存到哪、是否绑定」的 UI 与选择状态；
 * 不调用任何 SE RPC、不碰 `/api/fs/*`、也不调用 `buildPackage`。真正的读取
 * （stream.list / stream.read）、组装（src/se/packageExport.js）与写序
 * （兄弟文件先行、manifest 最后作提交点）全部由 App 在 onConfirm 后负责。
 *
 * props（冻结，App 接线以此为准）：
 * - streams:    Array<{ name:string, internal?:boolean }>  可选流（internal=true 默认不勾选）
 * - tools:      Array<{ name:string, description?:string }>      可选工具
 * - boundPath:  string|null   非空 = 当前标签页已绑定，保存即写回该路径（只读）
 * - busy:       boolean       导出进行中 → 禁用确认 / 取消
 * - progress:   null | { phase:'reading'|'writing', current:number, total:number }
 * - onConfirm:  (selection:{ streamNames:string[], toolNames:string[], savePath:string, bind:boolean }) => void
 * - onClose:    () => void
 */

/** 保存路径规范化：已是 `.se.json` 原样返回；否则去掉一层尾部 `.json` 再补 `.se.json`。 */
function normalizePackagePath(raw) {
  const p = String(raw == null ? '' : raw).trim();
  if (!p) return '';
  if (/\.se\.json$/i.test(p)) return p;
  return `${p.replace(/\.json$/i, '')}.se.json`;
}

export default function PackageExportDialog({
  streams,
  tools,
  scope = 'document',
  boundPath,
  busy,
  progress,
  onConfirm,
  onClose,
}) {
  // useMemo 锁住数组身份：本组件自身 setState 重渲染时不会误触发「重置全选」。
  const streamList = useMemo(() => (Array.isArray(streams) ? streams : []), [streams]);
  const toolList = useMemo(() => (Array.isArray(tools) ? tools : []), [tools]);
  const bound = typeof boundPath === 'string' && boundPath.trim() !== '';

  const [streamSel, setStreamSel] = useState(
    () => new Set(streamList.filter((s) => !s.internal).map((s) => s.name))
  );
  const [toolSel, setToolSel] = useState(() => new Set(toolList.map((t) => t.name)));
  const [path, setPath] = useState('');
  const [bind, setBind] = useState(false);
  const [toolMode, setToolMode] = useState('dir');
  const [browsing, setBrowsing] = useState(false);
  const [browseErr, setBrowseErr] = useState('');
  const title =
    scope === 'streams' ? '导出流配置包' : scope === 'tools' ? '导出工具配置包' : '导出配置包';

  // 提供的数组身份变化（异步加载 / 数据刷新）时按列表各自重置为全选。
  const prevStreams = useRef(streamList);
  useEffect(() => {
    if (prevStreams.current === streamList) return;
    prevStreams.current = streamList;
    setStreamSel(new Set(streamList.filter((s) => !s.internal).map((s) => s.name)));
  }, [streamList]);

  const prevTools = useRef(toolList);
  useEffect(() => {
    if (prevTools.current === toolList) return;
    prevTools.current = toolList;
    setToolSel(new Set(toolList.map((t) => t.name)));
  }, [toolList]);

  const streamNames = useMemo(
    () => streamList.filter((s) => streamSel.has(s.name)).map((s) => s.name),
    [streamList, streamSel]
  );
  const toolNames = useMemo(
    () => toolList.filter((t) => toolSel.has(t.name)).map((t) => t.name),
    [toolList, toolSel]
  );

  const allStreams = streamList.length > 0 && streamNames.length === streamList.length;
  const allTools = toolList.length > 0 && toolNames.length === toolList.length;

  const locked = !!busy || !!progress;
  const normalizedPath = bound ? String(boundPath).trim() : normalizePackagePath(path);
  const nothingSelected = streamNames.length === 0 && toolNames.length === 0;
  const confirmDisabled = locked || nothingSelected || !normalizedPath;

  const pct = progress && progress.total > 0
    ? Math.max(0, Math.min(100, Math.round((progress.current / progress.total) * 100)))
    : 0;

  const toggleStream = (name) =>
    setStreamSel((cur) => {
      const next = new Set(cur);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const toggleTool = (name) =>
    setToolSel((cur) => {
      const next = new Set(cur);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const setAllStreams = (on) => setStreamSel(on ? new Set(streamList.map((s) => s.name)) : new Set());
  const setAllTools = (on) => setToolSel(on ? new Set(toolList.map((t) => t.name)) : new Set());

  const browse = async () => {
    if (locked || browsing) return;
    setBrowsing(true);
    setBrowseErr('');
    try {
      const res = await fetch('/api/dialog/save', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
      if (data && data.path) setPath(normalizePackagePath(data.path));
    } catch (err) {
      console.warn('选择保存路径失败', err);
      setBrowseErr('无法打开系统保存对话框，请手动输入路径');
    } finally {
      setBrowsing(false);
    }
  };

  return (
    <ModalOverlay onCancel={onClose} busy={locked} closeOnEsc={!locked}>
      <div className="modal pkg-modal">
        <h3>{title}</h3>
        <div className="dlg-hint">
          导出为 SE 体系配置包（<code>.se.json</code>）：每个流会产出同名兄弟文件；工具按下方方式复刻；
          manifest 最后写入作为提交点。
        </div>

        {/* ---------------- 流 ---------------- */}
        <div className="dlg-block">
          <div className="pkg-section-head">
            <div className="dlg-label">流</div>
            <button
              type="button"
              className="pkg-toggle"
              disabled={locked || streamList.length === 0}
              onClick={() => setAllStreams(!allStreams)}
            >
              {allStreams ? '全不选' : '全选'}
            </button>
            <span className="pkg-count">
              已选 {streamNames.length} / {streamList.length}
            </span>
          </div>
          <div className="pkg-list">
            {streamList.length ? (
              streamList.map((s) => {
                const on = streamSel.has(s.name);
                return (
                  <button
                    type="button"
                    key={s.name}
                    className={'pkg-row' + (on ? ' on' : '')}
                    aria-pressed={on}
                    disabled={locked}
                    title={s.name}
                    onClick={() => toggleStream(s.name)}
                  >
                    <span className="tfbar-check">{on ? '✓' : ''}</span>
                    <span className="pkg-row-main">
                      <span className="pkg-row-title">{s.name}</span>
                    </span>
                  </button>
                );
              })
            ) : (
              <div className="pkg-empty">（无可选流）</div>
            )}
          </div>
        </div>

        {/* ---------------- 工具 ---------------- */}
        <div className="dlg-block">
          <div className="pkg-section-head">
            <div className="dlg-label">工具</div>
            <button
              type="button"
              className="pkg-toggle"
              disabled={locked || toolList.length === 0}
              onClick={() => setAllTools(!allTools)}
            >
              {allTools ? '全不选' : '全选'}
            </button>
            <span className="pkg-count">
              已选 {toolNames.length} / {toolList.length}
            </span>
          </div>
          <div className="pkg-list pkg-list-tools">
            {toolList.length ? (
              toolList.map((t) => {
                const on = toolSel.has(t.name);
                return (
                  <button
                    type="button"
                    key={t.name}
                    className={'pkg-row' + (on ? ' on' : '')}
                    aria-pressed={on}
                    disabled={locked}
                    title={t.description ? `${t.name} — ${t.description}` : t.name}
                    onClick={() => toggleTool(t.name)}
                  >
                    <span className="tfbar-check">{on ? '✓' : ''}</span>
                    <span className="pkg-row-main">
                      <span className="pkg-row-title pkg-row-mono">{t.name}</span>
                      {t.description ? <span className="pkg-row-sub">{t.description}</span> : null}
                    </span>
                  </button>
                );
              })
            ) : (
              <div className="pkg-empty">（无可选工具）</div>
            )}
          </div>
        </div>

        {/* ---------------- 工具复刻方式 ---------------- */}
        {scope !== 'streams' && (
          <div className="dlg-block">
            <div className="dlg-label">工具复刻方式</div>
            <div className="dlg-row">
              <select
                value={toolMode}
                disabled={locked}
                onChange={(e) => setToolMode(e.target.value)}
              >
                <option value="dir">整体镜像执行目录（推荐）</option>
                <option value="file">仅复制脚本文件</option>
                <option value="external">保留外部引用（不复制）</option>
              </select>
            </div>
            <div className="dlg-hint">
              {toolMode === 'dir'
                ? '复制 execution_path（缺省为脚本目录）整棵目录；同目录多工具只复制一份。'
                : toolMode === 'file'
                  ? '只复制脚本与手册；执行目录与脚本目录不同时，execution_path 保留外部路径。'
                  : '不复制工具文件，manifest 写绝对路径；接收方必须自带这些文件。'}
            </div>
          </div>
        )}

        {/* ---------------- 保存路径 ---------------- */}
        <div className="dlg-block">
          <div className="dlg-label">保存路径</div>
          {bound ? (
            <>
              <div className="pkg-bound" title={boundPath}>
                {String(boundPath).trim()}
              </div>
              <div className="dlg-hint">已绑定：保存将写回该配置包</div>
            </>
          ) : (
            <>
              <div className="dlg-row">
                <input
                  type="text"
                  placeholder="完整路径，如 D:\pkgs\my-system.se.json"
                  value={path}
                  spellCheck={false}
                  disabled={locked}
                  onChange={(e) => setPath(e.target.value)}
                />
                <button type="button" onClick={browse} disabled={locked || browsing}>
                  浏览…
                </button>
              </div>
              {path && normalizedPath !== path && (
                <div className="dlg-hint">
                  将保存为：<code>{normalizedPath}</code>
                </div>
              )}
              {browseErr && <div className="dlg-err">{browseErr}</div>}
            </>
          )}
        </div>

        {!bound && scope === 'document' && (
          <label className="pkg-check">
            <input
              type="checkbox"
              checked={bind}
              disabled={locked}
              onChange={(e) => setBind(e.target.checked)}
            />
            保存后绑定为当前标签页的系统包
          </label>
        )}

        {progress && (
          <div className="pkg-progress">
            <span className="pkg-progress-label">
              {progress.phase === 'writing' ? '写入文件' : '读取流'} {progress.current}/{progress.total}
            </span>
            <span className="pkg-progress-bar">
              <span className="pkg-progress-fill" style={{ width: `${pct}%` }} />
            </span>
          </div>
        )}

        <div className="pkg-summary">
          {streamNames.length} 流 · {toolNames.length} 工具 →{' '}
          <code>{normalizedPath || '（未选择路径）'}</code>
        </div>

        <div className="dlg-actions">
          <button
            type="button"
            className="primary"
            disabled={confirmDisabled}
            onClick={() =>
              onConfirm({
                streamNames,
                toolNames,
                savePath: normalizedPath,
                bind: bound ? false : bind,
                toolMode,
              })
            }
          >
            {progress ? (progress.phase === 'writing' ? '写入中…' : '读取中…') : '导出'}
          </button>
          <button type="button" disabled={locked} onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
