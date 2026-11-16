import { useState } from 'react';
import ModalOverlay from '../components/ModalOverlay.jsx';

/**
 * 级联修复对话框（期 5，SE接线方案.md §3.3「捕获 → 应用 → 校验」三段式）。
 *
 * rename / delete 的级联非原子（SE 无事务）。应用完成后一次 `stream.list` 全量重投影，
 * 与预期比对；有差异 → 本对话框列出 `{流, 键, 期望, 实际}`：
 * - **重试**：再跑一次差量修正（按 key set/remove，幂等）；
 * - **放弃**：关窗并 notify 保留差异 —— **绝不静默收尾**。
 *
 * props:
 * - diffs: [{stream, key, expected, actual}]
 * - onRetry(): async，再跑一次修正
 * - onDiscard(): 关窗（上层保留差异并 notify）
 */
export default function CascadeRepairDialog({ diffs, onRetry, onDiscard }) {
  const [busy, setBusy] = useState(false);
  const rows = Array.isArray(diffs) ? diffs : [];
  if (!rows.length) return null;

  return (
    <ModalOverlay onCancel={onDiscard} closeOnEsc={false}>
      <div className="modal">
        <h3>级联校验未收敛（{rows.length}）</h3>
        <div className="dlg-note">
          以下边标签与预期不一致。可「重试」再跑一次差量修正（幂等）；或「放弃」保留当前差异
          （不会静默丢弃）。
        </div>
        <div className="cascade-diff-list" style={{ maxHeight: 320, overflow: 'auto', margin: '8px 0' }}>
          {rows.map((d, i) => (
            <div
              className="cascade-diff-row"
              key={`${d.stream}\u0000${d.key}\u0000${i}`}
              style={{ padding: '6px 4px', borderBottom: '1px solid var(--border, #3333)' }}
            >
              <div>
                <b>{d.stream}</b> · <code>{d.key}</code>
              </div>
              <div style={{ opacity: 0.85 }}>
                期望：<code>{JSON.stringify(d.expected)}</code> ／ 实际：
                <code>{JSON.stringify(d.actual)}</code>
              </div>
            </div>
          ))}
        </div>
        <div className="dlg-actions">
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onRetry();
              } finally {
                setBusy(false);
              }
            }}
          >
            重试
          </button>
          <button type="button" disabled={busy} onClick={onDiscard}>
            放弃
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
