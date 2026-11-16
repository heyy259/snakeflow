import { useCallback } from 'react';

const PANELS = ['streams', 'files', 'tools', 'config'];
const RAIL = [
  { id: 'streams', icon: '🌊', label: '流' },
  { id: 'files', icon: '📁', label: '文件' },
  { id: 'tools', icon: '🧰', label: '工具' },
  { id: 'config', icon: '⚙️', label: '配置' },
];

/**
 * 侧栏壳：rail 面板切换 + 折叠 + 宽度拖拽。
 * 四个面板以元素形式注入（filePanel / streamPanel / toolPanel / configPanel），壳不关心其内部实现。
 */
export default function Sidebar({
  collapsed,
  width,
  activePanel,
  onCollapsedChange,
  onWidthChange,
  onActivePanelChange,
  streamPanel,
  filePanel,
  toolPanel,
  configPanel,
}) {
  const panel = PANELS.includes(activePanel) ? activePanel : 'streams';

  const onRailClick = useCallback(
    (which) => {
      if (which !== panel) {
        onActivePanelChange(which);
        if (collapsed) onCollapsedChange(false);
      } else {
        onCollapsedChange(!collapsed);
      }
    },
    [panel, collapsed, onActivePanelChange, onCollapsedChange]
  );

  const onWidthPointerDown = useCallback(
    (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const el = e.currentTarget;
      const startX = e.clientX;
      const startW = width;
      try {
        el.setPointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
      const move = (ev) => {
        onWidthChange(Math.max(260, Math.min(560, startW + (ev.clientX - startX))));
      };
      const up = (ev) => {
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        try {
          el.releasePointerCapture(ev.pointerId);
        } catch (err) {
          /* ignore */
        }
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    },
    [width, onWidthChange]
  );

  // 侧栏内的 mousedown 不夺走外部（正在就地编辑的）输入焦点；表单控件与滚动条除外
  const onRootMouseDown = useCallback((e) => {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest('input, textarea, [contenteditable="true"]')) return;
    if (e.target.classList.contains('file-pane')) return;
    if (e.target.closest('.modal-overlay')) return;
    e.preventDefault();
  }, []);

  return (
    <aside
      className={'file-sidebar' + (collapsed ? ' collapsed' : '')}
      data-panel={panel}
      onMouseDown={onRootMouseDown}
    >
      <nav className="sidebar-rail" aria-label="侧栏切换">
        {RAIL.map((r) => (
          <button
            key={r.id}
            type="button"
            className={'rail-btn' + (panel === r.id ? ' active' : '')}
            title={panel === r.id ? (collapsed ? `展开${r.label}面板` : `折叠${r.label}面板`) : r.label}
            aria-pressed={panel === r.id}
            onClick={() => onRailClick(r.id)}
          >
            {r.icon}
          </button>
        ))}
      </nav>

      <div className="sidebar-panel" style={{ width: collapsed ? 0 : width }}>
        {panel === 'streams' ? streamPanel : panel === 'tools' ? toolPanel : panel === 'config' ? configPanel : filePanel}
      </div>

      <div
        className="sidebar-resize-handle"
        title="拖动调整宽度"
        onPointerDown={onWidthPointerDown}
      />
    </aside>
  );
}
