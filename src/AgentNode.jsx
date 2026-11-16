import { memo, Suspense, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Handle, Position, NodeToolbar, NodeResizeControl, ResizeControlVariant } from '@xyflow/react';
import { FlowEditHudContext } from './flowEditHud.js';
import { NODE_W, isReservedTagKey } from './graph.js';
import MarkdownView from './MarkdownView.jsx';
import { isInternalStream } from './se/procAssoc.js';
import { streamNameFromId } from './se/streams.js';
import { PAGE_CHAR_BUDGET, PAGE_LINE_BUDGET } from './se/terminalCaps.js';
import { splitMarkdownPages, splitLinePages } from './se/pageSplit.js';
import { subscribePages, getPage, setPage, getHistoryPage } from './pageState.js';
import { viewStateKey } from './viewStateScope.js';
import { caretBridge, registerInputTarget, registerNodeEditor } from './caretBridge.js';
import { pushEsc } from './escStack.js';
import SnippetChips from './SnippetChips.jsx';
import SnippetForm from './SnippetForm.jsx';
import SelBubble from './editor/SelBubble.jsx';
import { moveSnippet } from './editor/snippetData.js';
import ScanBar from './node/ScanBar.jsx';
import PageBar from './node/PageBar.jsx';
import NodeTerminal from './node/NodeTerminal.jsx';

const NAME_PLACEHOLDER = '双击编辑名称';
const CONTENT_PLACEHOLDER = '双击添加内容';
const KEY_PLACEHOLDER = '键';
const VALUE_PLACEHOLDER = '值';
const SYNC_DELAY = 500;
// 源码 textarea 最小高度（与 .node-source-edit 的 min-height 对齐）
const SOURCE_MIN_H = 44;

/** 二分查找 offset 所在页（与扫描跟随/手动翻页锚点共用；pages 为空 → 0）。 */
const pageIndexAtOffset = (pages, offset, textLen) => {
  if (!pages.length) return 0;
  let lo = 0;
  let hi = pages.length - 1;
  let idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pages[mid].start <= offset) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (offset >= textLen) idx = pages.length - 1;
  return idx;
};

function AgentNode({ id, data, selected, width }) {
  const [editing, setEditing] = useState(null);
  const editingRef = useRef(null);
  const editElRef = useRef(null);
  const sessionRef = useRef(0);
  const isCustomWidth = Number.isFinite(width) && width > 0 && Math.abs(width - NODE_W) > 0.5;

  // 节点内容就地编辑（全局单实例由 App 的 editingNodeId 保证）
  const isEditing = !!data.editing;
  const MkHost = data.MkHost;
  // 工具栏 DOM 挂到 App 的 `.flow` 级常驻宿主；React owner 仍是本节点，
  // 因此 dirty/sourceOpen/foldMenuOpen/addAnchor/editorApiRef 全部保持局部。
  const flowEditHudRef = useContext(FlowEditHudContext);
  const flowEditHudHost = flowEditHudRef?.current || null;
  const editorApiRef = useRef(null);
  const unregisterBridgeRef = useRef(null);
  const syncTimerRef = useRef(null);
  const dirtyRef = useRef(false);
  const [dirty, setDirty] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceText, setSourceText] = useState('');
  const sourceElRef = useRef(null);
  const sourceTextRef = useRef('');
  const sourceTimerRef = useRef(null);
  const sourceOpenRef = useRef(false);
  // 切源码瞬间的 WYSIWYG 面板高度，作为 textarea 初始高度，避免节点高度突变
  const wysiwygPaneRef = useRef(null);
  const sourceInitHeightRef = useRef(0);
  const isEditingRef = useRef(isEditing);
  isEditingRef.current = isEditing;
  const [foldMenuOpen, setFoldMenuOpen] = useState(false);
  // 扫描条：状态存 data.scan；期 6 起 locked **仅 scanning**（paused 可编辑，决策⑤/D3）。
  const scan = data.scan && typeof data.scan === 'object' ? data.scan : null;
  const scanState = scan?.state || 'idle';
  const locked = scanState === 'scanning';
  // 位置标记仍应在 scanning/paused 显示（与编辑锁口径解耦）。
  const scanRunning = scanState === 'scanning' || scanState === 'paused';
  const [shake, setShake] = useState(false);
  const contentWrapRef = useRef(null);
  // G-3：进程清单只来自 canonical data.processes（SE 绑定由 processDriver 投影，未绑定由
  // 用户操作写回）。不再预置 demo 假进程——否则未扫描也会显示「工具在运行」，且清空后会回灌。
  const processes = Array.isArray(data.processes) ? data.processes : [];
  const fresh = !!data.fresh;
  // 期 15：只读分页状态订阅（pageState 为模块级真源；翻页/历史页变化时强制本节点重渲染）。
  const [, bumpPages] = useReducer((x) => x + 1, 0);
  useEffect(() => subscribePages(bumpPages), []);
  const historyReqRef = useRef(new Set());
  // 扫描跟随锚点：仅当扫描位置「跨页」时才自动翻页；用户手动翻页会把锚点重置为当前
  // 扫描位置所在页，此后同页内的 position 更新不再打扰用户。扫描停止时清空。
  const scanFollowAnchorRef = useRef(null);
  const fetchHistoryRef = useRef(null);
  // 期 15：内部流（`_console`/`_scan_log`）正文改为「行窗口页 + 历史页」分页渲染，不再截尾。
  // markdown 流按顶层块切页（splitMarkdownPages），console 流按行窗口切页（splitLinePages）。
  const isConsoleLike = isInternalStream(streamNameFromId(id));
  // Task 4：pending 节点 = 非 `s-` 前缀（本地草稿 n-* 等），SE 中不存在 → 扫描等 SE 能力不可用。
  // 用显式角标 + ScanBar 禁用态提示用户（样式见 index.css `.pending-badge`）。
  const isPending = streamNameFromId(id) === null;
  const content = data.content != null ? String(data.content) : '';
  // 分页/折叠/历史页的归属 scope = 渲染本节点的 tab id（App renderNodes 注入，非持久化）。
  const viewScope = data.viewScope;
  // 期 15（B5）：分页切分按 [content, isConsoleLike] 记忆化，避免每次渲染重解析；编辑态永不分页 → []。
  const mdPages = useMemo(
    () =>
      !isEditing && !isConsoleLike && content
        ? splitMarkdownPages(content, { charBudget: PAGE_CHAR_BUDGET })
        : [],
    [content, isConsoleLike, isEditing]
  );
  const mdPageCount = mdPages.length;
  const mdEffectivePage = Math.max(0, Math.min(getPage(viewScope, id) ?? 0, mdPageCount - 1));
  // console：本地 content 只是尾部窗口，contentWindow 给出该窗口在服务端的绝对字符区间；
  // 未提供（旧数据 / 未加载）时按 [0, content.length) 兜底。历史页用 PAGE_CHAR_BUDGET 固定
  // 绝对栅格，append-only 增长不会使已缓存页失效，仅服务端内容回退（变短）才失效（见 App）。
  const cw = isConsoleLike ? data.contentWindow : null;
  const absStart = cw && Number.isFinite(Number(cw.absStart)) ? Math.max(0, Number(cw.absStart)) : 0;
  const winPages = useMemo(
    () =>
      !isEditing && isConsoleLike && content
        ? splitLinePages(content, { lineBudget: PAGE_LINE_BUDGET })
        : [],
    [content, isConsoleLike, isEditing]
  );
  const historyPageCount = isConsoleLike ? Math.ceil(absStart / PAGE_CHAR_BUDGET) : 0;
  const consoleTotalPages = historyPageCount + winPages.length;
  // console 默认末页（延续「看最新日志尾部」语义）；显式页码夹紧入范围。
  const consoleEffectivePage =
    consoleTotalPages > 0
      ? Math.max(0, Math.min(getPage(viewScope, id) ?? consoleTotalPages - 1, consoleTotalPages - 1))
      : 0;
  // console 当前页文本：窗口页直接 slice；历史页命中缓存则渲染，未命中显示占位并触发取回。
  let consolePageText = '';
  let consolePageMiss = false;
  if (isConsoleLike && content) {
    const p = consoleEffectivePage;
    if (p >= historyPageCount) {
      const pg = winPages[p - historyPageCount];
      consolePageText = pg ? content.slice(pg.start, pg.end) : content;
    } else {
      const hist = getHistoryPage(viewScope, id, p);
      if (hist == null) consolePageMiss = true;
      else consolePageText = hist;
    }
  }
  // 分页态：锁高度避免翻页时节点重测；编辑态不参与分页；用户手动固定尺寸者交给其自滚动。
  const paged =
    !isEditing &&
    !data.userFixedSize &&
    (isConsoleLike ? consoleTotalPages > 1 : mdPageCount > 1);
  // 源码模式：textarea 与 refs 同步（供 Esc / flush / closeSource 读取最新文本）
  sourceTextRef.current = sourceText;
  sourceOpenRef.current = sourceOpen;
  fetchHistoryRef.current = data.onFetchHistoryPage;
  // 片段体系（需求 8）：编辑器 api 快照 + 选区浮条状态 + 「＋」弹层锚点。
  const [readyApi, setReadyApi] = useState(null);
  const [selInfo, setSelInfo] = useState({ empty: true });
  const [addAnchor, setAddAnchor] = useState(null);
  const snippets = Array.isArray(data.snippets) ? data.snippets : [];
  // 清除格式可用性：源码模式下不可用；无选区且光标在普通段落（clearable=false）时禁用。
  const clearFormatDisabled = sourceOpen || (selInfo.empty && selInfo.clearable === false);

  // 只在一次编辑会话开始时定位光标：标题全选便于改写，其余把光标放到末尾。
  useEffect(() => {
    if (!editing) return;
    const el = editElRef.current;
    if (!el) return;
    el.focus?.();
    if (editing.kind === 'name') {
      el.select?.();
    } else {
      const len = typeof el.value === 'string' ? el.value.length : 0;
      try {
        el.setSelectionRange(len, len);
      } catch (err) {
        /* some inputs may not support selection range */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.session]);

  // 编辑态开始时重置脏状态与源面板初值；结束时注销光标桥（桥在编辑态存续期存活）。
  useEffect(() => {
    if (isEditing) {
      dirtyRef.current = false;
      setDirty(false);
      setSourceText(data.content || '');
      sourceTextRef.current = data.content || '';
      return undefined;
    }
    setSourceOpen(false);
    sourceOpenRef.current = false;
    sourceInitHeightRef.current = 0;
    clearTimeout(sourceTimerRef.current);
    sourceTimerRef.current = null;
    setFoldMenuOpen(false);
    setReadyApi(null);
    setSelInfo({ empty: true });
    setAddAnchor(null);
    unregisterBridgeRef.current?.();
    unregisterBridgeRef.current = null;
    caretBridge.clear();
    return undefined;
  }, [isEditing]); // eslint-disable-line react-hooks/exhaustive-deps

  // 卸载清理：防抖定时器 + 光标桥注册
  useEffect(
    () => () => {
      clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
      clearTimeout(sourceTimerRef.current);
      sourceTimerRef.current = null;
      unregisterBridgeRef.current?.();
      unregisterBridgeRef.current = null;
      caretBridge.clear();
    },
    []
  );

  const writeBack = (md) => {
    if (md == null) return;
    sourceTextRef.current = md;
    setSourceText(md);
    data.onEditContentText?.(id, md);
    dirtyRef.current = false;
    setDirty(false);
  };

  // 注册/恢复节点编辑器插入目标（退出源码模式时用）。
  const registerNodeBridge = () => {
    unregisterBridgeRef.current?.();
    const api = editorApiRef.current;
    if (!api) return;
    unregisterBridgeRef.current = registerNodeEditor(`节点「${data.name || ''}」`, (text) =>
      api.insertTextAtSavedSelection(text)
    );
  };

  // 内联编辑失焦：内容编辑会话仍存活时还原为节点编辑器目标，否则注销（否则碰过名称/字段后侧栏插入路径误报无目标）。
  const clearOrRestoreBridge = () => {
    if (isEditingRef.current) {
      if (sourceOpenRef.current && sourceElRef.current) {
        registerInputTarget(sourceElRef.current, 'node', `节点「${data.name || ''}」源码`);
      } else if (editorApiRef.current) {
        registerNodeBridge();
      } else {
        caretBridge.clear();
      }
      return;
    }
    caretBridge.clear();
  };

  // 编辑器挂载完成：把命令出口交给工具栏/源面板/App，并注册 Bridge。
  const handleReady = (rawApi) => {
    const api = {
      ...rawApi,
      // exitEdit 强制 flush：只有脏会话才回写，未改动的内容字符串保持逐字节不变。
      // 源码模式下以 textarea 文本为准，避免回写编辑器里的旧 doc。
      flush: () => {
        clearTimeout(syncTimerRef.current);
        syncTimerRef.current = null;
        if (!dirtyRef.current) return false;
        if (sourceOpenRef.current) writeBack(sourceTextRef.current);
        else writeBack(rawApi.getMarkdown());
        return true;
      },
    };
    editorApiRef.current = api;
    setReadyApi(api);
    unregisterBridgeRef.current?.();
    unregisterBridgeRef.current = registerNodeEditor(`节点「${data.name || ''}」`, (text) =>
      rawApi.insertTextAtSavedSelection(text)
    );
    data.onEditorReady?.(api);
  };

  // onChange → 置脏 → 500ms 防抖 getMarkdown() 回写 data.content（不 trim）。
  const handleDirty = () => {
    dirtyRef.current = true;
    setDirty(true);
    clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      syncTimerRef.current = null;
      const api = editorApiRef.current;
      if (!api) return;
      writeBack(api.getMarkdown());
    }, SYNC_DELAY);
  };

  // 切到源码模式：先 flush/取最新 md 填入 textarea。
  const openSource = () => {
    clearTimeout(syncTimerRef.current);
    syncTimerRef.current = null;
    try {
      editorApiRef.current?.flush?.();
    } catch (err) {
      /* ignore */
    }
    const md = editorApiRef.current?.getMarkdown?.() ?? data.content ?? '';
    // 面板此时仍可见，先量高度再置 sourceOpen，textarea 以同高度挂载
    sourceInitHeightRef.current = wysiwygPaneRef.current?.offsetHeight || 0;
    sourceTextRef.current = md;
    setSourceText(md);
    setSourceOpen(true);
  };

  // 切回 WYSIWYG：把 textarea 最新文本灌回编辑器（replaceAll，保留 fold 上下文）。
  const closeSource = () => {
    clearTimeout(sourceTimerRef.current);
    sourceTimerRef.current = null;
    const md = sourceTextRef.current;
    editorApiRef.current?.setMarkdown?.(md);
    setSourceOpen(false);
    sourceOpenRef.current = false;
    sourceInitHeightRef.current = 0;
    registerNodeBridge();
    editorApiRef.current?.focus?.();
  };

  const toggleSource = () => {
    if (sourceOpen) closeSource();
    else openSource();
  };

  // 源码 textarea 高度随内容伸缩（先 auto 再取 scrollHeight 是标准量法）
  const autoGrowSource = (el) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(SOURCE_MIN_H, el.scrollHeight)}px`;
  };

  // 源码编辑：置脏 → 500ms 防抖经同一通道回写；高度随内容伸缩，与 WYSIWYG 行为一致。
  const handleSourceChange = (e) => {
    const v = e.target.value;
    autoGrowSource(e.target);
    sourceTextRef.current = v;
    setSourceText(v);
    dirtyRef.current = true;
    setDirty(true);
    clearTimeout(sourceTimerRef.current);
    sourceTimerRef.current = setTimeout(() => {
      sourceTimerRef.current = null;
      writeBack(sourceTextRef.current);
    }, SYNC_DELAY);
  };

  // 源码 textarea 挂载时定高：优先沿用 WYSIWYG 面板高度，量不到（如骨架屏期）则按内容自适应。
  useEffect(() => {
    if (!isEditing || !sourceOpen) return undefined;
    const el = sourceElRef.current;
    if (!el) return undefined;
    const base = sourceInitHeightRef.current;
    if (base > 0) el.style.height = `${Math.max(SOURCE_MIN_H, base)}px`;
    else autoGrowSource(el);
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, sourceOpen]);

  // 源码模式下 caretBridge 插入目标切到 textarea（失焦不注销，退出源码模式注销）。
  useEffect(() => {
    if (!isEditing || !sourceOpen) return undefined;
    const el = sourceElRef.current;
    if (el) registerInputTarget(el, 'node', `节点「${data.name || ''}」源码`);
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, sourceOpen]);

  // Esc 级联：源码模式下 Esc 先切回 WYSIWYG，再 Esc 才退出编辑。
  useEffect(() => {
    if (!isEditing || !sourceOpen) return undefined;
    return pushEsc(() => closeSource());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, sourceOpen]);

  // 扫描跟随翻页：只在扫描位置跨页时 setPage（锚点语义），不与用户手动翻页对抗。
  // 注意：绝不把 mdEffectivePage 放进依赖 —— 用户翻页引起的重渲染不得触发强制回跳。
  useEffect(() => {
    if (isConsoleLike || isEditing || !scanRunning || mdPageCount <= 1) return undefined;
    const src = String(data.content || '');
    const offset = Math.max(0, Math.min(Number(scan?.position) || 0, src.length));
    const idx = pageIndexAtOffset(mdPages, offset, src.length);
    if (scanFollowAnchorRef.current === idx) return undefined;
    scanFollowAnchorRef.current = idx;
    const cur = Math.max(0, Math.min(getPage(viewScope, id) ?? 0, mdPageCount - 1));
    if (cur !== idx) setPage(viewScope, id, idx);
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scan?.position, scanState, data.content, isEditing, scanRunning, mdPageCount, isConsoleLike, id, viewScope]);

  // 扫描停止 → 清空锚点，下次扫描从头跟随。
  useEffect(() => {
    if (!scanRunning) scanFollowAnchorRef.current = null;
  }, [scanRunning]);

  // 扫描位置标记：色块 + 脉冲 ▶；折叠体内的块不标记；非编辑态下滚动跟随。
  // 自动翻页（跟随）已移至上方独立 effect（锚点语义），此处只做 DOM 标记与滚动。
  useEffect(() => {
    const wrap = contentWrapRef.current;
    if (!wrap) return undefined;
    const md = wrap.querySelector('.md-body');
    if (!md) return undefined;
    md.querySelectorAll('.scan-marker').forEach((el) => el.remove());
    md.querySelectorAll('[data-line].scan-line').forEach((el) => el.classList.remove('scan-line'));
    if (isEditing || !scanRunning) return undefined;
    const src = String(data.content || '');
    const offset = Math.max(0, Math.min(Number(scan?.position) || 0, src.length));
    if (offset <= 0) return undefined;
    const line = src.slice(0, offset).split('\n').length;
    const blocks = Array.from(md.querySelectorAll('[data-line]')).filter(
      (b) => !b.closest('.md-fold-body')
    );
    let target = null;
    for (const b of blocks) {
      if (Number(b.getAttribute('data-line')) <= line) target = b;
      else break;
    }
    if (!target) return undefined;
    target.classList.add('scan-line');
    const marker = document.createElement('span');
    marker.className = 'scan-marker';
    marker.textContent = '▶';
    if (target.tagName === 'HR') {
      target.parentNode.insertBefore(marker, target);
    } else if (target.tagName === 'DETAILS') {
      const sum = target.querySelector('.md-fold-sum');
      (sum || target).insertBefore(marker, (sum || target).firstChild);
    } else {
      target.insertBefore(marker, target.firstChild);
    }
    wrap.scrollTop = Math.max(0, target.offsetTop - wrap.offsetTop - 8);
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // mdEffectivePage 必须在依赖里：上方 setPage 翻页后 effect 需重跑，才能在新页打标记。
  }, [scan?.position, scanState, data.content, isEditing, scanRunning, mdEffectivePage, mdPageCount]);

  // 期 15：console 历史页未命中 → 触发一次服务端取回（绝不在渲染期调用）。取回写入 pageState
  // 后广播，本节点重渲染即命中缓存切换为正文。in-flight Set 保证每页只触发一次。
  useEffect(() => {
    if (!isConsoleLike || !content) return undefined;
    const p = consoleEffectivePage;
    if (p >= historyPageCount) return undefined;
    if (getHistoryPage(viewScope, id, p) != null) return undefined;
    const reqKey = `${viewStateKey(viewScope, id)}:${p}:${absStart}`;
    if (historyReqRef.current.has(reqKey)) return undefined;
    historyReqRef.current.add(reqKey);
    const length = Math.min(PAGE_CHAR_BUDGET, absStart - p * PAGE_CHAR_BUDGET);
    // 期 15（B2）：Set 语义为「在途」而非「已尝试」——请求落定（成功/失败）即释放，
    // 使 LRU 淘汰或失败后可重新取回（否则该页永久停在「历史页加载中…」）。
    Promise.resolve(fetchHistoryRef.current?.(viewScope, id, p * PAGE_CHAR_BUDGET, length)).finally(() =>
      historyReqRef.current.delete(reqKey)
    );
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConsoleLike, content, consoleEffectivePage, historyPageCount, absStart, id, viewScope]);

  const startEdit = (kind, value, event, extra = {}) => {
    event?.stopPropagation?.();
    event?.preventDefault?.();
    sessionRef.current += 1;
    const next = { kind, value, ...extra, session: sessionRef.current };
    editingRef.current = next;
    setEditing(next);
  };

  const changeValue = (value) => {
    const next = { ...editingRef.current, value };
    editingRef.current = next;
    setEditing(next);
  };

  const cancelEdit = (event) => {
    event?.stopPropagation?.();
    clearOrRestoreBridge();
    editingRef.current = null;
    setEditing(null);
  };

  const commitEdit = (event) => {
    event?.stopPropagation?.();
    clearOrRestoreBridge();
    const current = editingRef.current;
    if (!current) return;
    editingRef.current = null;
    setEditing(null);
    if (current.kind === 'field') {
      data.onEditField?.(id, current.index, current.part, current.value);
      return;
    }
    const prev = (current.kind === 'name' ? data.name : data.content) || '';
    if (String(current.value).trim() !== String(prev).trim()) {
      data.onEditText?.(id, current.kind, current.value);
    }
  };

  const onEditKeyDown = (event) => {
    if (event.key === 'Escape') {
      cancelEdit(event);
      return;
    }
    if (event.key === 'Enter' && editingRef.current?.kind !== 'content') {
      event.preventDefault();
      commitEdit(event);
    }
  };

  const fields = Array.isArray(data.fields) ? data.fields : [];
  const isFieldEditing = (index, part) =>
    editing?.kind === 'field' && editing.index === index && editing.part === part;

  const fieldInput = (part, placeholder, f) => (
    <input
      ref={editElRef}
      className={`agent-edit agent-edit-field agent-edit-f${part === 'key' ? 'k' : 'v'} nodrag nopan`}
      value={editing.value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => changeValue(e.target.value)}
      onKeyDown={onEditKeyDown}
      onBlur={commitEdit}
      onFocus={() =>
        registerInputTarget(editElRef.current, 'field', `节点「${data.name || ''}」字段「${(f && f.key) || part}」`)
      }
    />
  );

  // 浮动工具栏：不夺焦（表单控件除外），避免点击时编辑器失焦。
  const toolbarGuard = (e) => {
    e.stopPropagation();
    if (e.target.closest('input, textarea, select')) return;
    e.preventDefault();
  };

  return (
    <div
      className={
        'agent-node' +
        (isEditing ? ' editing' : '') +
        (locked ? ' locked' : '') +
        (shake ? ' scan-shake' : '') +
        (fresh ? ' node-new' : '') +
        (!selected && !isEditing && scanState === 'idle' && processes.length === 0 && !fresh
          ? ' tail-idle'
          : '')
      }
    >
      {(selected || isEditing) && (
        <>
          <NodeResizeControl
            position={Position.Left}
            variant={ResizeControlVariant.Line}
            color="var(--tf-accent)"
            minWidth={140}
            onResizeEnd={(_, dims) => data.onResize?.(id, { width: dims.width })}
          />
          <NodeResizeControl
            position={Position.Right}
            variant={ResizeControlVariant.Line}
            color="var(--tf-accent)"
            minWidth={140}
            onResizeEnd={(_, dims) => data.onResize?.(id, { width: dims.width })}
          />
          <NodeResizeControl
            position={Position.Top}
            variant={ResizeControlVariant.Line}
            color="var(--tf-accent)"
            minHeight={40}
            onResizeEnd={(_, dims) => data.onResize?.(id, { height: dims.height })}
          />
          <NodeResizeControl
            position={Position.Bottom}
            variant={ResizeControlVariant.Line}
            color="var(--tf-accent)"
            minHeight={40}
            onResizeEnd={(_, dims) => data.onResize?.(id, { height: dims.height })}
          />
          {['top-left', 'top-right', 'bottom-left', 'bottom-right'].map((position) => (
            <NodeResizeControl
              key={position}
              position={position}
              variant={ResizeControlVariant.Handle}
              color="var(--tf-accent)"
              minWidth={140}
              minHeight={40}
              onResizeEnd={(_, dims) => data.onResize?.(id, { width: dims.width, height: dims.height })}
            />
          ))}
        </>
      )}

      <Handle type="target" position={Position.Top} />

      <div className="agent-node-body">

      {isEditing ? (
        flowEditHudHost ? createPortal(
        <div
          className="node-toolbar nodrag nopan"
          role="toolbar"
          aria-label="节点编辑工具栏"
          onMouseDown={toolbarGuard}
          onDoubleClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()}
        >
          <div className="ntb-row">
            <button
              type="button"
              title="撤销（编辑器内）"
            onClick={(e) => {
              e.stopPropagation();
              editorApiRef.current?.undo?.();
            }}
          >
            ↶
          </button>
          <button
            type="button"
            title="重做（编辑器内）"
            onClick={(e) => {
              e.stopPropagation();
              editorApiRef.current?.redo?.();
            }}
          >
            ↷
          </button>
          <span className="tb-sep" />
          <span className="ntb-fold-wrap">
            <button
              type="button"
              title="全部展开 / 全部收起（折叠块）"
              onClick={(e) => {
                e.stopPropagation();
                setFoldMenuOpen((v) => !v);
              }}
            >
              折叠 ▾
            </button>
            {foldMenuOpen && (
              <span className="ntb-fold-menu">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setFoldMenuOpen(false);
                    editorApiRef.current?.foldAll?.(true);
                  }}
                >
                  全部展开
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setFoldMenuOpen(false);
                    editorApiRef.current?.foldAll?.(false);
                  }}
                >
                  全部收起
                </button>
              </span>
            )}
          </span>
          <span className="tb-sep" />
          <button
            type="button"
            className={sourceOpen ? 'active' : ''}
            data-tb-source="1"
            title="源码编辑模式（同一内容区切换）"
            onClick={(e) => {
              e.stopPropagation();
              toggleSource();
            }}
          >
            &lt;/&gt;
          </button>
          <button
            type="button"
            data-tb-clear="1"
            title="清除格式（还原为普通正文）"
            disabled={clearFormatDisabled}
            onClick={(e) => {
              e.stopPropagation();
              editorApiRef.current?.clearFormat?.();
            }}
          >
            Tx
          </button>
          <span className="tb-sep" />
          <span className={'edit-dirty ' + (dirty ? 'dirty' : 'saved')}>
            {dirty ? '● 未保存' : '已保存'}
          </span>
          <button
            type="button"
            className="ntb-done"
            title="完成并回写 Markdown（Esc 同效）"
            onClick={(e) => {
              e.stopPropagation();
              data.onExitEdit?.();
            }}
          >
            ✓ 完成
          </button>
          </div>
          <SnippetChips
            snippets={snippets}
            onApply={(i) => {
              const r = editorApiRef.current?.applySnippet?.(snippets[i]);
              if (r && snippets[i]) {
                data.onNotify?.(
                  '已应用片段「' +
                    snippets[i].name +
                    '」' +
                    (r.type === 'prefix' ? '（行前缀）' : r.toggled ? '（已剥离）' : ''),
                  'ok'
                );
              }
            }}
            onDelete={(i) => data.onDeleteSnippet?.(i)}
            onReorder={(from, to) => data.onSnippetsChange?.(moveSnippet(snippets, from, to))}
            onAdd={(anchorRect) => setAddAnchor({ rect: anchorRect })}
            onManage={() => data.onOpenSnippetLib?.()}
            onNotify={data.onNotify}
          />
        </div>,
        flowEditHudHost
        ) : null
      ) : (
        <NodeToolbar position={Position.Top} className="nodrag nopan">
          <button
            onClick={(e) => {
              e.stopPropagation();
              data.onAddField?.(id);
            }}
            title="新增一行键值属性，双击行内文字即可编辑"
          >
            + 属性
          </button>
          {isCustomWidth && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                data.onResetSize?.(id);
              }}
              title="恢复默认宽度，并清除手动固定的高度"
            >
              恢复默认尺寸
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              data.onDelete?.(id);
            }}
            title="仅从画布移除，流仍在左侧列表中（真正删除走侧边栏）"
          >
            移出画布
          </button>
        </NodeToolbar>
      )}

      <div className="agent-node-head">
        {editing?.kind === 'name' ? (
          <input
            ref={editElRef}
            className="agent-edit agent-edit-title nodrag nopan"
            value={editing.value}
            placeholder={NAME_PLACEHOLDER}
            onChange={(e) => changeValue(e.target.value)}
            onKeyDown={onEditKeyDown}
            onBlur={commitEdit}
            onFocus={() =>
              registerInputTarget(editElRef.current, 'name', `节点「${data.name || ''}」名称`)
            }
          />
        ) : (
          <div
            className="agent-title"
            title={data.name || NAME_PLACEHOLDER}
            onDoubleClick={(e) => startEdit('name', data.name || '', e)}
          >
            {data.name || <span className="agent-placeholder">{NAME_PLACEHOLDER}</span>}
          </div>
        )}
        {isPending && (
          <span
            className="pending-badge"
            role="button"
            tabIndex={0}
            title="本地草稿，未同步到 SE；联网绑定后将自动同步（点击立即重试）"
            onClick={(e) => {
              e.stopPropagation();
              data.onRetrySync?.(id);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation();
                e.preventDefault();
                data.onRetrySync?.(id);
              }
            }}
          >
            待同步
          </span>
        )}
        {isEditing && <span className="edit-badge">编辑中</span>}
        {locked && (
          <span className="node-lock" title="扫描中，流已锁定">
            🔒
          </span>
        )}
      </div>

      {fields.map((f, i) =>
        isReservedTagKey(f.key) ? null : (
        <div className="agent-field" key={i}>
          {isFieldEditing(i, 'key') ? (
            fieldInput('key', KEY_PLACEHOLDER, f)
          ) : (
            <span
              className="agent-field-key"
              title={f.key || KEY_PLACEHOLDER}
              onDoubleClick={(e) => startEdit('field', f.key || '', e, { index: i, part: 'key' })}
            >
              {f.key || <span className="agent-placeholder">{KEY_PLACEHOLDER}</span>}
            </span>
          )}
          {isFieldEditing(i, 'value') ? (
            fieldInput('value', VALUE_PLACEHOLDER, f)
          ) : (
            <span
              className="agent-field-value"
              title={f.value || VALUE_PLACEHOLDER}
              onDoubleClick={(e) => startEdit('field', f.value || '', e, { index: i, part: 'value' })}
            >
              {f.value || <span className="agent-placeholder">{VALUE_PLACEHOLDER}</span>}
            </span>
          )}
          <button
            type="button"
            className="agent-field-del nodrag nopan"
            title="删除该属性"
            onClick={(e) => {
              e.stopPropagation();
              data.onRemoveField?.(id, i);
            }}
          >
            ×
          </button>
        </div>
        )
      )}

      <div className={'agent-content-wrap' + (paged ? ' paged' : '')} ref={contentWrapRef}>
        {isEditing ? (
          <>
            <div ref={wysiwygPaneRef} className={'wysiwyg-pane' + (sourceOpen ? ' is-hidden' : '')}>
              <Suspense fallback={<div className="md-body milkdown-skeleton" />}>
                {MkHost ? (
                  <MkHost
                    markdown={data.content || ''}
                    nodeId={id}
                    viewScope={viewScope}
                    onDirty={handleDirty}
                    onReady={handleReady}
                    onSelectionChange={setSelInfo}
                    onNotify={data.onNotify}
                  />
                ) : (
                  <div className="md-body milkdown-skeleton" />
                )}
              </Suspense>
            </div>
            {sourceOpen && (
              <textarea
                ref={sourceElRef}
                className="node-source-edit md-body nodrag nopan"
                value={sourceText}
                placeholder={CONTENT_PLACEHOLDER}
                spellCheck={false}
                onChange={handleSourceChange}
                onFocus={() =>
                  registerInputTarget(sourceElRef.current, 'node', `节点「${data.name || ''}」源码`)
                }
              />
            )}
          </>
        ) : (
          <div
            // nodrag：允许正文文本选择（d3-drag 不拦截 mousedown）；节点改从标题/边框拖动，双击进编辑不受影响。
            className="agent-content nodrag"
            title={String(data.content || CONTENT_PLACEHOLDER).slice(0, 200)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              // 期 15：运行日志流只读，禁止进入编辑（早于 locked 判定）。
              if (isConsoleLike) {
                data.onNotify?.('运行日志流不可编辑', 'warn');
                setShake(true);
                setTimeout(() => setShake(false), 450);
                return;
              }
              // 扫描/暂停时锁编辑：toast + 节点抖动，不进入编辑
              if (locked) {
                data.onNotify?.('扫描进行中，流已锁定', 'warn');
                setShake(true);
                setTimeout(() => setShake(false), 450);
                return;
              }
              data.onEditContent?.(id);
            }}
          >
            {content ? (
              isConsoleLike ? (
                <pre className="agent-console-text">
                  {consolePageMiss ? '历史页加载中…' : consolePageText}
                </pre>
              ) : (
                <MarkdownView content={content} nodeId={id} page={mdEffectivePage} viewScope={viewScope} />
              )
            ) : (
              <span className="agent-placeholder">{CONTENT_PLACEHOLDER}</span>
            )}
          </div>
        )}
      </div>

      {!isEditing &&
        (isConsoleLike ? (
          <PageBar
            page={consoleEffectivePage}
            pageCount={consoleTotalPages}
            onPage={(p) => setPage(viewScope, id, p)}
            onJumpToEnd={() => setPage(viewScope, id, consoleTotalPages - 1)}
          />
        ) : (
          <PageBar
            page={mdEffectivePage}
            pageCount={mdPageCount}
            onPage={(p) => {
              const src = String(data.content || '');
              const off = Math.max(0, Math.min(Number(scan?.position) || 0, src.length));
              scanFollowAnchorRef.current = pageIndexAtOffset(mdPages, off, src.length);
              setPage(viewScope, id, p);
            }}
          />
        ))}

      {isEditing && readyApi && (
        <SelBubble
          editorApi={readyApi}
          snippets={snippets}
          selInfo={selInfo}
          onApply={(i) => editorApiRef.current?.applySnippet?.(snippets[i])}
          onDelete={(i) => data.onDeleteSnippet?.(i)}
          onAddSnippet={(name, content) => data.onAddSnippet?.(name, content, true)}
          onOpenLibrary={() => data.onOpenSnippetLib?.()}
          onNotify={data.onNotify}
        />
      )}

      {isEditing && addAnchor && (
        <SnippetForm
          variant="popover"
          anchorRect={addAnchor.rect}
          title="新建片段"
          focusName
          onError={(msg) => data.onNotify?.(msg, 'warn')}
          onCancel={() => setAddAnchor(null)}
          onSave={(v) => {
            setAddAnchor(null);
            data.onAddSnippet?.(v.name, v.content, true);
          }}
        />
      )}

      <ScanBar
        scan={scan}
        selected={selected}
        content={String(data.content || '')}
        pending={isPending}
        onAction={(action, payload) => data.onScanAction?.(id, action, payload)}
      />

      <NodeTerminal
        nodeId={id}
        selected={selected}
        processes={processes}
        log={[
          ...(Array.isArray(data.termBody) ? data.termBody : []),
          ...(Array.isArray(data.termLog) ? data.termLog : []),
        ]}
        onSendInput={(nid, procName, text) => data.onSendInput?.(nid, procName, text)}
        onStopProcess={(nid, procName) => data.onStopProcess?.(nid, procName)}
      />

      </div>

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export default memo(AgentNode);
