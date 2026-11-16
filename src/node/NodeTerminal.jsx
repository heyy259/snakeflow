// 后台工具终端（每节点）：折叠条 + 进程 chips + 日志 + 输入区，对齐原型 :3827-4231。
// 展开 / 手动切换 / 选中进程 / 确认停止均为组件内临时状态。
//
// 期 7 + 去 mock：进程清单与日志一律由 processDriver 投影（data.processes / data.termLog），
// 发送/停止经回调走真实 tool.send_input / tool.stop_process；不再有本地 mock 分支。
import { useEffect, useRef, useState } from 'react';
import { TERM_RENDER_MAX_LINES } from '../se/terminalCaps.js';
import './terminal.css';

export default function NodeTerminal({
  nodeId,
  selected,
  processes,
  log,
  onSendInput,
  onStopProcess,
}) {
  const [expanded, setExpanded] = useState(false);
  const [userToggled, setUserToggled] = useState(false);
  const [selectedProcId, setSelectedProcId] = useState(null);
  const [confirmStopId, setConfirmStopId] = useState(null);
  const [input, setInput] = useState('');
  const logLines = Array.isArray(log) ? log : [];
  // 期 14 加固：终端只渲染最近 N 行（termBody 派生的 console 正文可能很长），
  // 避免一次性挂载海量 DOM 冻结主线程；上方数据源本身也已各自设上限。
  const truncated = logLines.length > TERM_RENDER_MAX_LINES;
  const shownLines = truncated ? logLines.slice(logLines.length - TERM_RENDER_MAX_LINES) : logLines;

  // mousedown 时快照的展开态：click 时按「用户看到的值」取反
  const toggleBaseRef = useRef(null);
  const logRef = useRef(null);
  const taRef = useRef(null);
  // 底部粘附 / 上一次展开态都是组件内 ref，不引入全局状态或定时器。
  // 粘附仅在用户仍贴近底部时成立；用户拖滚动条或用键盘回看时立即解除。
  const stickToBottomRef = useRef(true);
  const wasExpandedRef = useRef(false);
  const NEAR_BOTTOM_PX = 24;

  const waitCount = processes.filter((p) => p.waiting).length;
  const selectedProc = processes.find((p) => p.id === selectedProcId) || null;

  // 选中且有后台进程：自动展开（用户手动切换过则尊重其选择，对齐原型 selectNode）
  useEffect(() => {
    if (selected && processes.length > 0 && !userToggled) setExpanded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // 选中进程后聚焦输入框（需等重渲染解除 disabled 后再聚焦）
  useEffect(() => {
    if (selectedProcId) taRef.current?.focus();
  }, [selectedProcId]);

  // 日志区滚动：只用真实几何更新粘附状态。
  // 用户拖滚动条或聚焦后用键盘滚动会立即解除粘附，后续新日志不会把视口拽回底部。
  const handleLogScroll = () => {
    const el = logRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
  };

  // 展开时强制回底并恢复粘附；展开期间只有仍在底部才跟随新日志。
  // 不添加 wheel 监听：滚轮始终交给画布平移（含终端区域），日志滚动只走滚动条/键盘。
  useEffect(() => {
    const el = logRef.current;
    if (!el || !expanded) {
      wasExpandedRef.current = expanded;
      return;
    }
    const justExpanded = !wasExpandedRef.current;
    wasExpandedRef.current = expanded;
    if (justExpanded) {
      stickToBottomRef.current = true;
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [log, expanded]);

  // 点击未选中节点的折叠条会先选中节点（副作用自动展开），再触发本 click：
  // 因此 mousedown 先记下用户看到的展开态，click 按快照取反
  const handleBarMouseDown = () => {
    toggleBaseRef.current = expanded;
  };
  const handleBarClick = () => {
    const base = toggleBaseRef.current;
    toggleBaseRef.current = null;
    setExpanded(base === null ? !expanded : !base);
    setUserToggled(true);
  };

  const confirmStop = () => {
    const pid = confirmStopId;
    setConfirmStopId(null);
    const p = processes.find((x) => x.id === pid);
    if (!p) return;
    if (selectedProcId === pid) setSelectedProcId(null);
    // 真实 tool.stop_process（driver 负责移除 chip + 日志 + 通知）。
    onStopProcess?.(nodeId, p.id);
  };

  const send = () => {
    if (!selectedProc) return;
    const text = input.trim();
    if (!text) {
      taRef.current?.focus();
      return;
    }
    // 真实 tool.send_input（driver 负责日志回显 + waiting 清除）。
    onSendInput?.(nodeId, selectedProc.id, text);
    setInput('');
    taRef.current?.focus();
  };

  return (
    <div className={'terminal-panel' + (expanded ? ' expanded' : '')}>
      <div
        className="term-bar"
        title="展开 / 收起终端"
        onMouseDown={handleBarMouseDown}
        onClick={handleBarClick}
      >
        <span className="term-caret">▸</span>
        <span className="term-title">终端</span>
        <span className="term-summary">
          {processes.length ? processes.length + ' 个进程运行中' : '无后台进程'}
        </span>
        {waitCount > 0 ? <span className="term-wait-badge">● {waitCount} 个进程等待输入</span> : null}
      </div>
      {expanded ? (
        <div className="term-body">
          <div className="term-chips">
            {processes.length === 0 ? (
              <span className="term-empty">无后台进程</span>
            ) : (
              processes.map((p) =>
                confirmStopId === p.id ? (
                  <span className="term-chip confirming" key={p.id}>
                    停止 {p.name}？
                    <button type="button" className="chip-yes nodrag nopan" onClick={confirmStop}>
                      是
                    </button>
                    <button
                      type="button"
                      className="chip-no nodrag nopan"
                      onClick={() => setConfirmStopId(null)}
                    >
                      否
                    </button>
                  </span>
                ) : (
                  <span
                    key={p.id}
                    className={'term-chip' + (selectedProcId === p.id ? ' selected' : '')}
                    title="点击选择 / 再次点击取消"
                    onClick={() => setSelectedProcId(selectedProcId === p.id ? null : p.id)}
                  >
                    {selectedProcId === p.id ? '▶ ' : ''}
                    {p.tool} + {p.name}
                    {p.waiting ? (
                      <span className="term-wait" title="等待输入">
                        ●输入
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className="chip-del nodrag nopan"
                      title="停止该进程"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmStopId(p.id);
                      }}
                    >
                      ✕
                    </button>
                  </span>
                )
              )
            )}
          </div>
          <div
            className="term-log nodrag nopan"
            ref={logRef}
            tabIndex={0}
            aria-label="终端日志，可用滚动条或方向键滚动"
            onScroll={handleLogScroll}
          >
            {logLines.length === 0 ? (
              <div className="term-empty">（暂无输出）</div>
            ) : (
              <>
                {truncated ? (
                  <div className="term-line system">… 仅显示最近 {TERM_RENDER_MAX_LINES} 行 …</div>
                ) : null}
                {shownLines.map((l, i) => (
                  <div className={'term-line ' + l.kind} key={i}>
                    {l.text}
                  </div>
                ))}
              </>
            )}
          </div>
          <div className="term-input">
            <span className="term-sel">
              {selectedProc ? '▶ ' + selectedProc.tool + ' — ' + selectedProc.name : ''}
            </span>
            <textarea
              ref={taRef}
              className="nodrag nopan"
              rows={1}
              spellCheck={false}
              value={input}
              disabled={!selectedProc}
              placeholder={selectedProc ? '输入内容，Enter 发送 / Shift+Enter 换行' : '先选择上方进程…'}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button type="button" className="term-send nodrag nopan" disabled={!selectedProc} onClick={send}>
              发送
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
