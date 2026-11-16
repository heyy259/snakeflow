import { useEffect, useState } from 'react';
import ModalOverlay from '../components/ModalOverlay.jsx';

/**
 * 悬空边逐条清理对话框（期 5，SE接线方案.md §3.3）。
 *
 * 悬空边 = 某流上的 `edge.<目标>` 标签，但其目标 name 已不在 `stream.list` 内
 * （外部删除/改名）。**逐条确认**「保留 / 清除」——**不提供「全部清除」**：
 * 批量删除会把级联失败造成的「假悬空」边一并删掉 = 丢数据（Oracle 评审）。
 *
 * props:
 * - dangling: [{source, target, label}]（流 name）
 * - onClear(row): async，执行 remove_tag(source, edge.<target>) + 重投影
 * - onClose(): 关闭
 */
export default function DanglingEdgesDialog({ dangling, onClear, onClose }) {
  const [rows, setRows] = useState(() => (Array.isArray(dangling) ? dangling : []));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  // 父级重投影刷新悬空列表时同步（清除成功后该行消失）。
  useEffect(() => {
    setRows(Array.isArray(dangling) ? dangling : []);
  }, [dangling]);

  const keepRow = (row) => setRows((rs) => rs.filter((r) => r !== row));

  const clearRow = async (row) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onClear(row);
      setRows((rs) => rs.filter((r) => r !== row));
    } catch (e) {
      setErr((e && e.message) || String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalOverlay onCancel={onClose} closeOnEsc>
      <div className="modal">
        <h3>悬空边（{rows.length}）</h3>
        <div className="dlg-note">
          以下边指向的目标流已不存在。逐条决定：<b>保留</b> = 暂不处理；<b>清除</b> = 删除源流上的
          <code> edge.&lt;目标&gt; </code>标签。为避免误删「假悬空」边，此处不提供批量清除。
        </div>
        {rows.length ? (
          <div className="dangling-list" style={{ maxHeight: 320, overflow: 'auto', margin: '8px 0' }}>
            {rows.map((r, i) => (
              <div
                className="dangling-row"
                key={`${r.source}\u0000${r.target}\u0000${i}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 4px',
                  borderBottom: '1px solid var(--border, #3333)',
                }}
              >
                <span style={{ flex: 1 }}>
                  {r.source} → <b>{r.target}</b>
                  {r.label ? `（${r.label}）` : ''}
                </span>
                <button type="button" disabled={busy} onClick={() => keepRow(r)}>
                  保留
                </button>
                <button type="button" className="danger" disabled={busy} onClick={() => clearRow(r)}>
                  清除
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="dlg-note">没有待处理的悬空边。</div>
        )}
        {err && <div className="dlg-err">清除失败：{err}</div>}
        <div className="dlg-actions">
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
