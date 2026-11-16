import { useEffect, useMemo, useRef, useState } from 'react';
import { reservedDeltaSummary, filterPredictedDangling } from '../se/packageImport.js';
import ModalOverlay from '../components/ModalOverlay.jsx';

/**
 * 配置包导入预览对话框（期 11 · D3）——纯展示 / 选择层。
 *
 * 边界：本组件不调用任何 SE RPC、不碰 `/api/fs/*`、也不调用 `planImport`。
 * `plan` 由 App 在打开对话框前算好并传入；本组件只负责逐项勾选、策略/开关
 * 选择与预警展示，确认后把选择原样回传给 App（真正的读取/应用/重投影由 App 编排）。
 *
 * props（冻结，App 接线以此为准）：
 * - mode:         'into-bound' | 'new-tab'
 * - targetLabel:  string        目标系统显示名 / 配置包路径（只读展示）
 * - plan:         { streams:[{ name, state:'new'|'update'|'unchanged', selected,
 *                              contentMissing, contentChanged, descriptionChanged,
 *                              tagDiff:{ set, remove }, reservedRemovals:[], reservedAdds:[] }],
 *                   tools:[{ name, state, selected, pathMissing }],
 *                   predictedDangling:[{ source, target, label }],
 *                   warnings:[] }
 * - hasPositions: bool          `ui.positions` 非空 → 显示「恢复画布布局」
 * - boundPath:    string|null   情境一：当前标签页已绑定路径
 * - selectedPath: string        情境一：本次所选配置包路径
 * - busy:         boolean
 * - progress:     null | { phase:'reading'|'writing'|'applying', current, total }
 * - onConfirm:    ({ selection:{ streamNames:[], toolNames:[] }, strategy:'overwrite'|'skip',
 *                     restoreLayout:bool, confirmReserved:bool }) => void
 * - onClose:      () => void
 */

const STATE_BADGE = {
  new: { text: '新增', color: 'var(--tf-success)' },
  update: { text: '更新', color: 'var(--tf-warn)' },
  unchanged: { text: '不变', color: 'var(--tf-text-dim)' },
};

function badge(text, color) {
  return (
    <span
      style={{
        flex: '0 0 auto',
        padding: '0 6px',
        borderRadius: 999,
        fontSize: 10,
        lineHeight: '15px',
        whiteSpace: 'nowrap',
        color,
        background: `color-mix(in srgb, ${color} 16%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 40%, transparent)`,
      }}
    >
      {text}
    </span>
  );
}

function stateBadge(state) {
  const b = STATE_BADGE[state] || { text: String(state ?? '—'), color: 'var(--tf-text-dim)' };
  return badge(b.text, b.color);
}

const PROGRESS_LABEL = {
  reading: '读取文件',
  writing: '写入系统',
  applying: '应用导入',
};

export default function PackageImportDialog({
  mode,
  targetLabel,
  plan,
  hasPositions,
  boundPath,
  selectedPath,
  busy,
  progress,
  onConfirm,
  onClose,
}) {
  const p = plan || {};

  const streamList = useMemo(() => (Array.isArray(p.streams) ? p.streams : []), [p]);
  const toolList = useMemo(() => (Array.isArray(p.tools) ? p.tools : []), [p]);
  const dangling = useMemo(
    () => (Array.isArray(p.predictedDangling) ? p.predictedDangling : []),
    [p]
  );
  const warnings = useMemo(() => (Array.isArray(p.warnings) ? p.warnings : []), [p]);

  const [streamSel, setStreamSel] = useState(
    () => new Set(streamList.filter((s) => s && s.selected).map((s) => s.name))
  );
  const [toolSel, setToolSel] = useState(
    () => new Set(toolList.filter((t) => t && t.selected).map((t) => t.name))
  );
  const [strategy, setStrategy] = useState('overwrite');
  // 布局修复：有位置数据时默认恢复布局（复选框仅在 hasPositions 时渲染；
  // 默认 false 曾导致用户无从察觉位置被丢弃、节点全部堆叠到视口中心）。
  const [restoreLayout, setRestoreLayout] = useState(true);
  const [confirmReserved, setConfirmReserved] = useState(false);

  const prevPlan = useRef(p);
  useEffect(() => {
    if (prevPlan.current === p) return;
    prevPlan.current = p;
    setStreamSel(new Set(streamList.filter((s) => s && s.selected).map((s) => s.name)));
    setToolSel(new Set(toolList.filter((t) => t && t.selected).map((t) => t.name)));
    setConfirmReserved(false);
  }, [p, streamList, toolList]);

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

  // 保留键差量 / 悬空边预警均限定到**当前选区**（期 12 · D6/Q6）：只展示、只 gate 已选项，
  // 与 `applyImport` 仅作用于 `row.selected` 保持一致；不重算 `plan`（避免触发 reset effect）。
  const { removals, adds } = useMemo(
    () => reservedDeltaSummary(streamList, streamNames),
    [streamList, streamNames]
  );
  const hasReservedDeltas = removals.length > 0 || adds.length > 0;

  const danglingShown = useMemo(
    () => filterPredictedDangling(dangling, streamNames),
    [dangling, streamNames]
  );

  const locked = !!busy || !!progress;
  const nothingSelected = streamNames.length === 0 && toolNames.length === 0;
  const confirmDisabled =
    locked || nothingSelected || (hasReservedDeltas && !confirmReserved);

  const pct =
    progress && progress.total > 0
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

  const setAllStreams = (on) =>
    setStreamSel(on ? new Set(streamList.map((s) => s.name)) : new Set());
  const setAllTools = (on) =>
    setToolSel(on ? new Set(toolList.map((t) => t.name)) : new Set());

  const handleConfirm = () => {
    if (confirmDisabled) return;
    onConfirm({
      selection: { streamNames, toolNames },
      strategy,
      restoreLayout: !!restoreLayout,
      confirmReserved: !!confirmReserved,
    });
  };

  return (
    <ModalOverlay onCancel={onClose} busy={locked} closeOnEsc={!locked}>
      <div className="modal pkg-modal">
        <h3>{mode === 'new-tab' ? '从配置包创建 · 预览' : '加载配置包 · 预览'}</h3>
        <div className="dlg-hint">
          {mode === 'new-tab'
            ? '确认后将先创建系统再全量导入；取消不会产生孤儿进程。'
            : '继续加载到已绑定标签页：按所选策略增量更新，未勾选的项目不会被改动。'}
        </div>

        {/* ---------------- 目标 ---------------- */}
        <div className="dlg-block">
          <div className="dlg-label">{mode === 'new-tab' ? '新建系统' : '目标系统'}</div>
          <div className="pkg-bound" title={targetLabel || ''}>
            {targetLabel || '—'}
          </div>
          {mode === 'into-bound' && selectedPath ? (
            <div className="dlg-hint">
              配置包：<code>{selectedPath}</code>
              {boundPath && boundPath !== selectedPath ? (
                <>
                  <br />
                  当前绑定：<code>{boundPath}</code>
                </>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* ---------------- 冲突处理策略 ---------------- */}
        <div className="dlg-block">
          <div className="dlg-label">冲突处理策略</div>
          <div className="dlg-actions">
            <button
              type="button"
              className={strategy === 'overwrite' ? 'primary' : ''}
              disabled={locked}
              aria-pressed={strategy === 'overwrite'}
              onClick={() => setStrategy('overwrite')}
            >
              覆盖
            </button>
            <button
              type="button"
              className={strategy === 'skip' ? 'primary' : ''}
              disabled={locked}
              aria-pressed={strategy === 'skip'}
              onClick={() => setStrategy('skip')}
            >
              跳过
            </button>
            <button
              type="button"
              className={strategy === 'config-load' ? 'primary' : ''}
              disabled={locked}
              aria-pressed={strategy === 'config-load'}
              onClick={() => setStrategy('config-load')}
            >
              合并登记（config.load）
            </button>
          </div>
          <div className="dlg-hint">
            覆盖（默认）：同名流/工具用包内版本重建；跳过仅作用于冲突项；包内新项仍会创建。
            「合并登记」经 snakeeats `config.load` 加载清单（未勾选的流按 skip_streams 跳过）；
            非 root 环境自动回落逐项导入。
          </div>
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
                const parts = [];
                if (s.contentChanged) parts.push('内容');
                if (s.descriptionChanged) parts.push('描述');
                const setKeys =
                  s.tagDiff && s.tagDiff.set ? Object.keys(s.tagDiff.set) : [];
                const removeKeys =
                  s.tagDiff && Array.isArray(s.tagDiff.remove) ? s.tagDiff.remove : [];
                if (setKeys.length || removeKeys.length) {
                  parts.push(`标签 +${setKeys.length}/-${removeKeys.length}`);
                }
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
                      <span
                        className="pkg-row-title"
                        style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                      >
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {s.name}
                        </span>
                        {stateBadge(s.state)}
                        {s.contentMissing
                          ? badge('文件缺失', 'var(--tf-danger)')
                          : null}
                      </span>
                      {parts.length ? (
                        <span className="pkg-row-sub">{parts.join(' · ')} 变更</span>
                      ) : null}
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
                    title={
                      t.pathMissing
                        ? `${t.name}（${
                            t.pathMissingKind === 'relative'
                              ? '包内路径缺失，将跳过注册'
                              : '外部路径缺失，仍可导入'
                          }）`
                        : t.name
                    }
                    onClick={() => toggleTool(t.name)}
                  >
                    <span className="tfbar-check">{on ? '✓' : ''}</span>
                    <span className="pkg-row-main">
                      <span
                        className="pkg-row-title pkg-row-mono"
                        style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                      >
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {t.name}
                        </span>
                        {stateBadge(t.state)}
                        {t.pathMissing
                          ? badge(
                              t.pathMissingKind === 'relative' ? '包内路径缺失' : '外部路径缺失',
                              'var(--tf-danger)'
                            )
                          : null}
                      </span>
                    </span>
                  </button>
                );
              })
            ) : (
              <div className="pkg-empty">（无可选工具）</div>
            )}
          </div>
        </div>

        {/* ---------------- 保留键差量（Q4 · 必须显式确认） ---------------- */}
        {hasReservedDeltas && (
          <div className="dlg-block">
            <div className="dlg-label">保留键差量（需确认）</div>
            <div className="dlg-err">
              导入将移除 {removals.length} 条、新增 {adds.length} 条边 / 保留标签。
            </div>
            <div className="dlg-hint">
              {removals.map((r) => (
                <div key={`rm:${r.stream}:${r.key}`}>
                  − <code>{r.key}</code>（{r.stream}）
                </div>
              ))}
              {adds.map((a) => (
                <div key={`add:${a.stream}:${a.key}`}>
                  + <code>{a.key}</code>（{a.stream}）
                </div>
              ))}
            </div>
            <label className="pkg-check">
              <input
                type="checkbox"
                checked={confirmReserved}
                disabled={locked}
                onChange={(e) => setConfirmReserved(e.target.checked)}
              />
              我已知悉并确认上述保留键差量
            </label>
          </div>
        )}

        {/* ---------------- 预测悬空边 ---------------- */}
        {danglingShown.length > 0 && (
          <div className="dlg-block">
            <div className="dlg-label">预测悬空边</div>
            <div className="dlg-err">
              将产生 {danglingShown.length} 条指向不存在目标的新边（导入后可逐条确认）。
            </div>
            <div className="dlg-hint">
              {danglingShown.map((d, i) => (
                <div key={`dangling:${d.source}:${d.target}:${i}`}>
                  <code>{d.source}</code> → <code>{d.target}</code>
                  {d.label ? `（${d.label}）` : ''}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ---------------- plan 级提示 ---------------- */}
        {warnings.length > 0 && (
          <div className="dlg-block">
            <div className="dlg-label">提示</div>
            {warnings.map((w, i) => (
              <div className="dlg-hint" key={`warn:${i}`}>
                {w}
              </div>
            ))}
          </div>
        )}

        {/* ---------------- 可选开关 ---------------- */}
        {hasPositions && (
          <label className="pkg-check">
            <input
              type="checkbox"
              checked={restoreLayout}
              disabled={locked}
              onChange={(e) => setRestoreLayout(e.target.checked)}
            />
            恢复画布布局
          </label>
        )}

        {/* ---------------- 进度 ---------------- */}
        {progress && (
          <div className="pkg-progress">
            <span className="pkg-progress-label">
              {PROGRESS_LABEL[progress.phase] || '处理'} {progress.current}/{progress.total}
            </span>
            <span className="pkg-progress-bar">
              <span className="pkg-progress-fill" style={{ width: `${pct}%` }} />
            </span>
          </div>
        )}

        <div className="pkg-summary">
          已选 {streamNames.length} 流 · {toolNames.length} 工具 →{' '}
          {mode === 'new-tab' ? '新建系统' : '增量导入'}
        </div>

        <div className="dlg-actions">
          <button
            type="button"
            className="primary"
            disabled={confirmDisabled}
            onClick={handleConfirm}
          >
            {locked
              ? progress
                ? `${PROGRESS_LABEL[progress.phase] || '处理'}中…`
                : '处理中…'
              : '确认导入'}
          </button>
          <button type="button" disabled={locked} onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
