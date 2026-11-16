import { useState } from 'react';
import { scanPosText, nearContext, offsetToLine, lineStartOffset } from './scanUtils.js';
import './scanbar.css';

const SCAN_LABELS = {
  idle: '待机',
  scanning: '扫描中',
  pausing: '暂停中…',
  paused: '已暂停',
  error: '错误',
};
// Task 4：pending（非 `s-*` 本地草稿，SE 中不存在）时动作按钮的提示文案。
const PENDING_TIP = '该节点未同步到 SE，无法扫描';

/**
 * 节点扫描条：常驻行（状态点/状态/位置/统计）+ 选中时展开的控制行。
 * 按钮一一对应 scan.start/pause/resume/stop/move（本期为本地 mock 驱动）。
 * Set Position 输入行号：实时刷新 Near 预览但不提交，点「定位」才生效；
 * 扫描过程中输入框不跟随刷新（手动跳转控件，不是实时指示器）。
 * pending=true：节点为本地草稿（未同步 SE），动作按钮视觉禁用但**保留可点击** ——
 * 用 aria-disabled 而非 disabled：disabled 会吞掉 click，T2 的 scanDriver 兜底 toast
 * 就永远弹不出；aria-disabled 只改语义/样式，onClick 照常派发给 onAction。
 */
export default function ScanBar({ scan, selected, content, onAction, pending = false }) {
  const st = { state: 'idle', position: 0, ok: 0, fail: 0, ...(scan || {}) };
  const src = String(content || '');
  const [posInput, setPosInput] = useState('');
  // 初始扫描权限（Phase 5）：本地偏好，仅在 idle 的 Start 时随 scan.start 提交；
  // 空值表示沿用服务端默认（凭证 ceiling），不是「无权限」。
  const [startAuthority, setStartAuthority] = useState('');

  // 暂停相位（2026-10-25）：pausing 时 state 仍是 scanning（后端诚实态）。
  const pausing = st.pausePhase === 'pausing';
  const stateLabel = pausing ? '暂停中…' : SCAN_LABELS[st.state] || st.state;
  const showPos = st.state === 'scanning' || st.state === 'paused';
  const baseStats = st.ok || st.fail ? `(${st.ok} ok, ${st.fail} fail)` : '';
  const retained = Number(st.retained) || 0;
  const commitFailed = Number(st.commitFailed) || 0;
  const extraStats = [
    retained > 0 ? `${retained} retained` : '',
    commitFailed > 0 ? `${commitFailed} commit_failed` : '',
  ]
    .filter(Boolean)
    .join(', ');
  const stats = [baseStats, extraStats].filter(Boolean).join(' ');
  const statsTitle =
    retained || commitFailed
      ? `retained=${retained}（已执行但标记未消费：删除失败/提交停滞）；commit_failed=${commitFailed}（提交失败）`
      : undefined;
  const enabled = (states) => states.includes(st.state);
  // 重扫（scan.rescan）：空内容禁用；扫描进行中 / 暂停中（未 settle）禁用。
  const canRescan = src.trim() !== '' && st.state !== 'scanning' && !pausing;
  // 权限（Phase 5）：UI 只渲染服务端事实，不在本地复制 allow/deny 矩阵。
  // allowedAuthorities 为空/缺失时隐藏暂停切换控件，绝不凭空造选项。
  const allowedAuthorities = Array.isArray(st.allowedAuthorities) ? st.allowedAuthorities : [];
  const showAuthorityBadge = !!st.authority && (st.state === 'scanning' || st.state === 'paused');
  const canSwitchAuthority =
    st.state === 'paused' && st.canSetAuthority === true && !pausing && allowedAuthorities.length > 0;
  const authorityBusy = st.switchingAuthority === true;

  // 动作按钮统一门控：pending 时改走 aria-disabled（可点击），否则维持原生 disabled 状态门。
  const gate = (blocked, baseTitle) => ({
    disabled: !pending && blocked,
    'aria-disabled': pending || undefined,
    title: pending ? PENDING_TIP : baseTitle,
  });

  const inputLine = Number(posInput);
  const inputValid = posInput.trim() !== '' && Number.isFinite(inputLine) && inputLine >= 1;
  // 有合法输入时预览输入行附近，否则预览当前扫描位置附近
  const previewOffset = inputValid ? lineStartOffset(src, inputLine) : st.position;
  const preview = src.length && (inputValid || st.position > 0) ? nearContext(src, previewOffset) : '—';

  const commitSetPos = () => {
    if (!inputValid) return;
    onAction('setpos', lineStartOffset(src, inputLine));
  };

  return (
    <div className="scan-strip">
      <span className={`scan-dot state-${st.state}`} />
      <span className="scan-state">{stateLabel}</span>
      {showPos && <span className="scan-pos">{scanPosText(src, st.position)}</span>}
      {stats && (
        <span className="scan-stats" title={statsTitle}>
          {stats}
        </span>
      )}
      {showAuthorityBadge && (
        <span className="scan-authority-badge" title="当前扫描权限（服务端只读值）">
          权限: <b>{st.authority}</b>
        </span>
      )}
      {selected && (
        <div className="scan-controls nodrag nopan">
          <button
            type="button"
            {...gate(!enabled(['idle']))}
            onClick={() => (startAuthority ? onAction('start', startAuthority) : onAction('start'))}
          >
            ▶ 开始
          </button>
          {enabled(['idle']) && (
            <label className="scan-authority">
              <span>权限</span>
              <select
                aria-label="扫描权限"
                title="选择本次扫描的权限；默认沿用凭证允许的上限"
                value={startAuthority}
                disabled={pending}
                onChange={(e) => setStartAuthority(e.target.value)}
              >
                <option value="">默认（凭证上限）</option>
                <option value="workspace-write">workspace-write</option>
                <option value="full">full</option>
              </select>
            </label>
          )}
          <button
            type="button"
            {...gate(!enabled(['scanning']) || pausing, pausing ? '暂停中…等待当前工具结束' : undefined)}
            onClick={() => onAction('pause')}
          >
            ⏸ 暂停
          </button>
          <button
            type="button"
            {...gate(!enabled(['paused']) || pausing, pausing ? '暂停中…等待当前工具结束' : undefined)}
            onClick={() => onAction('resume')}
          >
            ▶ 继续
          </button>
          <button
            type="button"
            {...gate(!enabled(['scanning', 'paused']))}
            onClick={() => onAction('stop')}
          >
            ⏹ 停止
          </button>
          <button
            type="button"
            {...gate(!canRescan, '从头重扫该流（scan.rescan）；已执行标记不会重复执行')}
            onClick={() => onAction('rescan')}
          >
            ↻ 重扫
          </button>
          {canSwitchAuthority && (
            <label className="scan-authority scan-authority-switch">
              <span>切换权限</span>
              <select
                aria-label="切换扫描权限"
                title={authorityBusy ? '正在切换权限…' : '仅列出服务端允许的权限'}
                value={st.authority || ''}
                disabled={authorityBusy}
                onChange={(e) => onAction('setauthority', e.target.value)}
              >
                {allowedAuthorities.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
          )}
          <span className="scan-setpos">
            Set Position:
            <input
              type="number"
              min="1"
              step="1"
              placeholder={String(offsetToLine(src, st.position))}
              value={posInput}
              disabled={pending}
              onChange={(e) => setPosInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitSetPos();
              }}
            />
            <button type="button" {...gate(!inputValid)} onClick={commitSetPos}>
              定位
            </button>
          </span>
          <span className="scan-preview" title={preview !== '—' ? preview : undefined}>
            Near: {preview}
          </span>
        </div>
      )}
    </div>
  );
}
