import { useCallback, useEffect, useMemo, useRef, useState, lazy } from 'react';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  BackgroundVariant,
  Panel,
  MarkerType,
  useNodesState,
  useEdgesState,
  useReactFlow,
  useOnSelectionChange,
  useStoreApi,
  useStore,
  useNodesInitialized,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './index.css';
import {
  fromLogicGraph,
  NODE_W,
  normalizeFields,
  isStreamVisible,
  deriveEdgeHidden,
  isReservedTagKey,
} from './graph.js';
import { serializeTextView, parseTextView } from './textView.js';
import AgentNode from './AgentNode.jsx';
import AgentEdge from './AgentEdge.jsx';
import CanvasWheelController from './CanvasWheelController.jsx';
import FileSidebar from './sidebar/Sidebar.jsx';
import FilePanel from './sidebar/FilePanel.jsx';
import ConfigPanel from './sidebar/ConfigPanel.jsx';
import StreamPanel, { DeleteStreamDialog, StreamFormDialog } from './sidebar/StreamPanel.jsx';
import ToolPanel, { ToolFormDialog } from './sidebar/ToolPanel.jsx';
import SnippetLibrary from './SnippetLibrary.jsx';
import { caretBridge } from './caretBridge.js';
import { nodeActions, edgeActions } from './actions.js';
import { FlowEditHudContext } from './flowEditHud.js';
import { normalizeSnippets } from './editor/snippetData.js';
import { runTopEsc } from './escStack.js';
import { THEMES, useTheme } from './theme.js';
import { isValidToolName, normalizeTools, normalizeToolDef, resolveInsertText, rowsToTags } from './tools.js';
import {
  buildDocument,
  isUnifiedDocument,
  parseDocument,
  normalizeScan,
  normalizeProcesses,
  documentFileNameOf,
  documentDirOf,
  documentStreamsDirName,
  remapSourcePrefix,
  planDocumentSources,
  applyPlannedSources,
  applyImportedSources,
  sourceOf,
} from './document.js';
import {
  readContentRef,
  stripBom,
  writeFsText,
  writePackageFiles,
  portableDocPath,
  absolutizeDocPath,
  isAbsolutePath,
  manifestAbsDirOf,
  isGraphsDocPath,
  canonDocPath,
  GRAPH_CONFIG_EXT,
} from './se/paths.js';
import { workDocPathOf, toolBasePathOf, docBaseOf, findDocOwner } from './tabDoc.js';
import { isCrossGraphSource } from './se/ownedSource.js';
import { isStreamNotFoundError } from './se/deletePolicy.js';
import { ensureProjectRoot, getProjectRoot } from './se/projectRoot.js';
import { sePool, SE_STATUS } from './se/pool.js';
import { createSeOrchestrator, waitForClientOnline } from './se/orchestrator.js';
import {
  loadManifestFile,
  fetchStreamContents,
  planImport,
  applyImport,
  resolveSiblingPath,
  silentRefillFromManifest,
  collectManifestSources,
} from './se/packageImport.js';
import {
  buildPackage,
  manifestDirOf,
  packageNameFromPath,
  selectPackageInput,
  readManifestLayout,
} from './se/packageExport.js';
import { planToolBundles } from './se/packageBundle.js';
import PackageExportDialog from './sidebar/PackageExportDialog.jsx';
import PackageImportDialog from './sidebar/PackageImportDialog.jsx';
import { NewTabDialog } from './sidebar/SeBindDialogs.jsx';
import {
  streamNodeId,
  streamNameFromId,
  projectStreams,
  fieldsToTags,
} from './se/streams.js';
import { shouldSkipEmptyPersist } from './se/persistGuard.js';
import {
  isPendingNode,
  pendingNodes,
  derivePromoteName,
  collectTakenNames,
  rewriteEdgesForIdSwap,
  incidentEdgeTagOps,
} from './se/promote.js';
import {
  buildConfigLoadParams,
  mapConfigLoadResult,
  buildToolsOnlyManifest,
  buildStreamsOnlyManifest,
  summarizeManifestResult,
} from './se/manifest.js';
import {
  streamNameError,
  isValidStreamName,
  toStreamName,
  toToolName,
  deriveSystemId,
  displayNameFromPath,
  uniqueDisplayName,
  sameSystemId,
} from './se/nameContract.js';
import { captureStreamTags, applyTagSnapshot, edgeTagKey } from './se/tagOps.js';
import { edgeId, collectInboundRefs } from './se/edges.js';
import { collectDocumentEdges, planEdgeAlignOps } from './se/edgeAlign.js';
import { isInternal } from './se/internalStreams.js';
import { isInternalStream, INTERNAL_SUFFIXES } from './se/procAssoc.js';
import { planOwnedSourceRename, resolveOwnedSourcePath } from './se/ownedSource.js';
import { PAGE_CHAR_BUDGET } from './se/terminalCaps.js';
import { setHistoryPage, rekeyNodeState, clearPageScope } from './pageState.js';
import { rekeyFoldsForNode, clearFoldScope } from './foldState.js';
import {
  applyRenameCascade,
  applyDeleteCascade,
  mergeCascadeDiffs,
  diffEdgeRefs,
} from './se/cascade.js';
import DanglingEdgesDialog from './sidebar/DanglingEdgesDialog.jsx';
import CascadeRepairDialog from './sidebar/CascadeRepairDialog.jsx';
import ModalOverlay from './components/ModalOverlay.jsx';
import { loadConfigRegistry, saveConfigRegistry, registerEntry } from './configRegistry.js';

const STORAGE_KEY = 'agentgraph-canvas';

/** 扫描活动态：非局部写（导入/覆盖/撤销）必须让路。 */
const SCAN_ACTIVE_STATES = ['scanning', 'paused', 'pausing'];

/** SE 连接徽标状态文案（tab 绑定驱动）。 */
const SE_STATUS_LABEL = {
  [SE_STATUS.CONNECTING]: '连接中',
  [SE_STATUS.ONLINE]: '已连接',
  [SE_STATUS.OFFLINE]: '离线',
};

/** SE spawn/ensure 失败状态的诚实文案（E：不再弹 token 对话框）。 */
const SE_ERROR_STATUS_LABEL = {
  'owned-by-other-vite': '该系统由另一个运行中的开发服务器持有，未接管',
  'port-unverifiable': '无法确认系统进程归属或端口状态，未接管',
  'process-identity-unknown': '无法确认 SE 进程归属，已保留进程和记录；可重试',
  'process-exit-unconfirmed': '已尝试停止但无法确认进程退出，记录已保留；可重试',
  'spawn-in-flight': '系统正在启动，请稍后重试',
  'close-in-progress': '系统正在关闭',
};

/** 把 ensure/spawn/close 返回的失败规整为可读错误文案。 */
function seErrorMessage(res) {
  if (!res) return '未知错误';
  const key = res.code || res.status;
  if (key && SE_ERROR_STATUS_LABEL[key]) return SE_ERROR_STATUS_LABEL[key];
  if (res.status && SE_ERROR_STATUS_LABEL[res.status]) return SE_ERROR_STATUS_LABEL[res.status];
  return res.error || `状态 ${res.status || 'error'}`;
}

/** 另存为流文件：原生保存对话框的文件类型过滤串。 */
const DOC_FILTER =
  'Markdown/文本 (*.md;*.txt;*.json;*.csv;*.log;*.py;*.js;*.ts)|*.md;*.txt;*.json;*.csv;*.log;*.py;*.js;*.ts|所有文件 (*.*)|*.*';
/** 另存为 SE 配置包：原生保存对话框的文件类型过滤串。 */
const SE_FILTER = 'SE 配置包 (*.se.json)|*.se.json|JSON (*.json)|*.json|所有文件 (*.*)|*.*';

// 编辑器懒加载：milkdown 只在首次进入编辑态时随独立 chunk 载入（阶段 5）。
const MilkdownHost = lazy(() => import('./editor/MilkdownHost.jsx'));

/** UI 偏好默认值（持久化到 /api/store/ui → graphs/.ui.json） */
const DEFAULT_UI = {
  sidebarWidth: 300,
  sidebarCollapsed: false,
  activePanel: 'streams',
  sortKey: 'name',
  sortDir: 'asc',
  colW: { size: 74, time: 122 },
};

/** 规范化从 /api/store/ui 或本地写回的 UI 偏好，非法值回落到默认。 */
function normalizeUi(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const num = (v, d, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : d;
  };
  const colW = o.colW && typeof o.colW === 'object' ? o.colW : {};
  return {
    sidebarWidth: num(o.sidebarWidth, DEFAULT_UI.sidebarWidth, 260, 560),
    sidebarCollapsed: !!o.sidebarCollapsed,
    activePanel: ['files', 'streams', 'tools', 'config'].includes(o.activePanel)
      ? o.activePanel
      : DEFAULT_UI.activePanel,
    sortKey: ['name', 'size', 'mtime'].includes(o.sortKey) ? o.sortKey : DEFAULT_UI.sortKey,
    sortDir: o.sortDir === 'desc' ? 'desc' : 'asc',
    colW: {
      size: num(colW.size, DEFAULT_UI.colW.size, 60, 400),
      time: num(colW.time, DEFAULT_UI.colW.time, 90, 500),
    },
  };
}

/** 视口值校验：{x,y,zoom} 全为有限数才返回规范化副本，否则 null（持久化/恢复共用）。 */
function validViewportOrNull(vp) {
  if (!vp || typeof vp !== 'object') return null;
  const x = Number(vp.x);
  const y = Number(vp.y);
  const zoom = Number(vp.zoom);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom)) return null;
  return { x, y, zoom };
}

const nodeTypes = { agent: AgentNode };
const edgeTypes = { agent: AgentEdge };
const defaultEdgeOptions = { markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 } };
const GRID = 16;
// 画布缩放策略：minZoom 必须低于 fit 的计算结果，否则超高节点永远 fit 不进去
// （getViewportForBounds 会按组件 minZoom 钳制；setViewport 不受 d3 scaleExtent 限制）。
const CANVAS_MIN_ZOOM = 0.05;
const CANVAS_MAX_ZOOM = 2;
const CANVAS_FIT_PADDING = 0.15;
const HISTORY_LIMIT = 50;
const SNAP = (v) => Math.round(v / GRID) * GRID;
const snapPos = (p) => ({ x: SNAP(p.x), y: SNAP(p.y) });

/** 读取节点持久化的自定义宽度；非法/缺省返回 null（届时用默认宽度 NODE_W）。 */
const toW = (v) => {
  const w = Number(v);
  return Number.isFinite(w) && w > 0 ? w : null;
};

/**
 * 画布图构造的统一入口：
 * - 节点宽度：有自定义宽度用自定义，否则用默认 NODE_W；只持久化宽度，绝不写死高度。
 * - 节点高度由内容自适应；若用户手动固定了高度，内容区在内部滚动。
 */
const toCanvasGraph = (graph) => ({
  nodes: graph.nodes.map((n) => {
    const data = n.data || {};
    const content = data.content != null ? String(data.content) : '';
    const description = data.description != null ? String(data.description) : '';
    const fields = normalizeFields(data.fields);
    const width = toW(n.style?.width) ?? toW(n.width) ?? NODE_W;
    const height = toW(n.style?.height);
    const style = { width };
    if (height) style.height = height;
    return {
      id: String(n.id),
      type: 'agent',
      position: { x: Number(n.position?.x) || 0, y: Number(n.position?.y) || 0 },
      style,
      data: {
        name: data.name != null ? String(data.name) : data.title != null ? String(data.title) : '',
        // v2：contentState='loaded' 时空串也保留（区分"空文件"与"未加载/缺失"）。
        ...(content || data.contentState === 'loaded' ? { content } : {}),
        ...(data.contentState ? { contentState: data.contentState } : {}),
        ...(data.source && data.source.file_path ? { source: { ...data.source } } : {}),
        ...(description ? { description } : {}),
        ...(fields.length ? { fields } : {}),
        // 期 15（B1b）：内部流窗口元数据经 data 透传至 AgentNode（非持久化，见 snapshotOf 白名单）。
        ...(data.contentWindow ? { contentWindow: data.contentWindow } : {}),
        ...(normalizeScan(data.scan) ? { scan: normalizeScan(data.scan) } : {}),
        ...(normalizeProcesses(data.processes).length
          ? { processes: normalizeProcesses(data.processes) }
          : {}),
        onEditText: (id, kind, value) => nodeActions.onEditText?.(id, kind, value),
        onEditField: (id, index, part, value) => nodeActions.onEditField?.(id, index, part, value),
        onAddField: (id) => nodeActions.onAddField?.(id),
        onRemoveField: (id, index) => nodeActions.onRemoveField?.(id, index),
        onResetSize: (id) => nodeActions.onResetSize?.(id),
        onResize: (id, dims) => nodeActions.onResize?.(id, dims),
        onDelete: (id) => nodeActions.onDelete?.(id),
        onEditContent: (id) => nodeActions.onEditContent?.(id),
        onExitEdit: () => nodeActions.onExitEdit?.(),
        onEditContentText: (id, text) => nodeActions.onEditContentText?.(id, text),
        onEditorReady: (api) => nodeActions.onEditorReady?.(api),
        // 扫描条 / 终端（SE 驱动）
        onScanAction: (id, action, payload) => nodeActions.onScanAction?.(id, action, payload),
        // 终端：发送输入 / 停止进程（真实 tool.send_input / tool.stop_process）
        onSendInput: (id, procName, text) => nodeActions.onSendInput?.(id, procName, text),
        onStopProcess: (id, procName) => nodeActions.onStopProcess?.(id, procName),
        // Task5：pending 角标点击 → 手动提升该节点（经 App 转 promoteLocalNode）
        onRetrySync: (id) => nodeActions.onRetrySync?.(id),
        // 片段体系（需求 8）
        onSnippetsChange: (next) => nodeActions.onSnippetsChange?.(next),
        onAddSnippet: (name, text, flash) => nodeActions.onAddSnippet?.(name, text, flash),
        onDeleteSnippet: (index) => nodeActions.onDeleteSnippet?.(index),
        onOpenSnippetLib: () => nodeActions.onOpenSnippetLib?.(),
        onNotify: (text, kind) => nodeActions.onNotify?.(text, kind),
        // 期 15：console 历史页取回（只读分页）
        onFetchHistoryPage: (viewScope, nodeId, absStart, length) =>
          nodeActions.onFetchHistoryPage?.(viewScope, nodeId, absStart, length),
      },
    };
  }),
  edges: graph.edges.map((e) => ({ ...e, type: e.type || 'agent' })),
});

const toStr = (v) => (v == null ? '' : String(v));
const baseName = (p) =>
  toStr(p).split(/[\\/]/).pop().replace(/\.se\.json$/i, '').replace(/\.json$/i, '');

/**
 * 「示例」默认图（R-5）：复用原型 `prototype/index.html:1525-1543` 的「支付系统」——
 * 3 节点（支付流 / 风控校验 / 对账任务，各带 fields 与 markdown 正文）+ 2 边，
 * 交给 `replaceGraph` → `toCanvasGraph` 转为画布结构。
 */
function buildDefaultGraph() {
  return {
    nodes: [
      {
        id: 'n1',
        position: { x: 70, y: 60 },
        style: { width: 400 },
        data: {
          name: '支付流',
          fields: [
            { key: '类型', value: '主链路' },
            { key: '负责人', value: '张三' },
            { key: '状态', value: '评审中' },
          ],
          content:
            '# 支付流\n\n- 下单 → 支付 → 回调\n- 幂等键 `payNo`\n- 失败重试与补偿\n\n> 资金安全优先，所有状态变更留痕。',
        },
      },
      {
        id: 'n2',
        position: { x: 560, y: 70 },
        style: { width: 320 },
        data: {
          name: '风控校验',
          fields: [
            { key: '规则', value: '实时规则引擎' },
            { key: '超时', value: '800ms' },
          ],
          content:
            '# 风控校验\n\n- 黑名单命中直接拦截\n- 大额交易转人工复核\n- 超时默认放行并记录\n\n> 所有拦截需写入审计日志。',
        },
      },
      {
        id: 'n3',
        position: { x: 300, y: 620 },
        style: { width: 340 },
        data: {
          name: '对账任务',
          fields: [
            { key: '频率', value: 'T+1' },
            { key: '范围', value: '全渠道' },
          ],
          content:
            '## 对账任务\n\n每日凌晨 **02:00** 拉取渠道对账单，\n差异单自动进入人工队列。\n\n- 渠道单 vs 本地流水\n- 生成差异报表\n- 推送财务系统',
        },
      },
    ],
    edges: [
      { id: 'e1', type: 'agent', source: 'n1', target: 'n2', label: '发起校验' },
      { id: 'e2', type: 'agent', source: 'n1', target: 'n3', label: '落流水' },
    ],
  };
}

function genTabId() {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** R-3：文件路径 → 去扩展名 basename（对话框预填建议名）。 */
function fileBaseNameNoExt(filePath) {
  const base = String(filePath || '').split(/[\\/]/).pop() || '';
  return base.replace(/\.[^.]+$/, '') || base;
}

/** 期 5：边两端是否均为 SE 流（s-* 节点 id）。 */
const isSeEdge = (e) =>
  !!e && !!streamNameFromId(e.source) && !!streamNameFromId(e.target);

/** 期 5（G-5）：一端 s-*、另一端非 s-* 的混合连线（本地节点 ↔ SE 流）不允许。 */
const isMixedConnection = (a, b) => (streamNameFromId(a) != null) !== (streamNameFromId(b) != null);

/**
 * 期 5：把边写操作 `[{source, key, value}]` 归并为 `seApplyTagChanges` 的 entries
 * `[{name, changes:[{key,value}]}]`（同一 source 的多个 key 合并为一次写路径）。
 */
function buildEdgeEntries(ops) {
  const byName = new Map();
  (Array.isArray(ops) ? ops : []).forEach((op) => {
    if (!op || !op.source) return;
    const list = byName.get(op.source) || [];
    list.push({ key: op.key, value: op.value });
    byName.set(op.source, list);
  });
  return Array.from(byName.entries()).map(([name, changes]) => ({ name, changes }));
}

/**
 * 期 5：级联后校验 `diffEdgeRefs` 已迁至 `src/se/cascade.js`（纯函数、可 Node 单测），
 * 由本文件 import 复用，保持单一定义。
 */

/** 把画布内容拍成可持久化的快照（含坐标，不含布局噪音之外的东西）。
 * 期 6/7（D5）：绑定 tab 的 scan/processes 是运行时态（SE 为真源）→ omitRuntime=true 时剔除；
 * 未绑定 tab 保留（本地 mock 逃生舱语义不变）。 */
function snapshotOf(nodes, edges, omitRuntime = false) {
  return {
    nodes: nodes.map((n) => {
      const fields = normalizeFields(n.data?.fields);
      const out = {
        id: String(n.id),
        position: {
          x: Number(n.position?.x) || 0,
          y: Number(n.position?.y) || 0,
        },
        data: {
          name: n.data?.name != null ? String(n.data.name) : n.data?.title != null ? String(n.data.title) : '',
          // v2：contentState='loaded' 时空串也保留；source 引用必须随快照存活，
          // 否则 buildDocument 会为已有文件重新分配文件名（churn/孤儿）。
          ...(n.data?.content || n.data?.contentState === 'loaded'
            ? { content: n.data.content == null ? '' : String(n.data.content) }
            : {}),
          ...(n.data?.contentState ? { contentState: n.data.contentState } : {}),
          ...(n.data?.source && n.data.source.file_path
            ? {
              source: {
                file_path: String(n.data.source.file_path),
                encoding: n.data.source.encoding ? String(n.data.source.encoding) : 'utf-8',
              },
            }
            : {}),
          ...(n.data?.description ? { description: String(n.data.description) } : {}),
          ...(fields.length ? { fields } : {}),
          ...(!omitRuntime && normalizeScan(n.data?.scan) ? { scan: normalizeScan(n.data.scan) } : {}),
          ...(!omitRuntime && normalizeProcesses(n.data?.processes).length
            ? { processes: normalizeProcesses(n.data.processes) }
            : {}),
        },
      };
      const style = {};
      const w = Number(n.style?.width);
      // 只持久化“用户自定义过、且不同于默认”的宽度；高度仅在用户手动拉伸后持久化。
      if (Number.isFinite(w) && w > 0 && Math.abs(w - NODE_W) > 0.5) style.width = w;
      const h = Number(n.style?.height);
      if (Number.isFinite(h) && h > 0) style.height = h;
      if (style.width || style.height) out.style = style;
      return out;
    }),
    edges: edges.map((e) => {
      const out = {
        id: String(e.id),
        source: String(e.source),
        target: String(e.target),
      };
      if (e.label) out.label = String(e.label);
      return out;
    }),
  };
}

/** 落地节点 → 常驻布局表（仅 s-* 流节点；key=流名 data.name，值为坐标 + 有限正数的宽高）。 */
function layoutFromNodes(nodes) {
  const out = {};
  for (const n of Array.isArray(nodes) ? nodes : []) {
    const id = String(n.id == null ? '' : n.id);
    if (!id.startsWith('s-')) continue;
    const name = n.data?.name != null ? String(n.data.name) : '';
    if (!name) continue;
    const x = Number(n.position?.x);
    const y = Number(n.position?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const entry = { x, y };
    const w = Number(n.style?.width);
    if (Number.isFinite(w) && w > 0) entry.width = w;
    const h = Number(n.style?.height);
    if (Number.isFinite(h) && h > 0) entry.height = h;
    out[name] = entry;
  }
  return out;
}

/** 校验并规范化一份存储快照里的单张图；无效则返回 null。
 * 期 6/7（D5）：omitRuntime=true（绑定 tab）时读端亦忽略 scan/processes，防旧值回灌。 */
function normalizeStoredGraph(raw, omitRuntime = false) {
  if (!raw || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return null;
  const ids = new Set();
  const nodes = [];
  raw.nodes.forEach((rawNode) => {
    if (!rawNode || rawNode.id == null) return;
    const id = String(rawNode.id);
    if (ids.has(id)) return;
    ids.add(id);
    const data = rawNode.data || {};
    const name = data.name != null ? String(data.name) : data.title != null ? String(data.title) : '';
    // byte 保真：不 trim（保留 CRLF 与首尾空白）；contentState='loaded' 时空串也保留。
    const content = data.content != null ? String(data.content) : '';
    const description = data.description != null ? String(data.description) : '';
    const fields = normalizeFields(data.fields);
    const p = rawNode.position || {};
    const node = {
      id,
      position: { x: Number(p.x) || 0, y: Number(p.y) || 0 },
      data: {
        name,
        ...(content || data.contentState === 'loaded' ? { content } : {}),
        ...(data.contentState ? { contentState: data.contentState } : {}),
        ...(data.source && data.source.file_path
          ? {
            source: {
              file_path: String(data.source.file_path),
              encoding: data.source.encoding ? String(data.source.encoding) : 'utf-8',
            },
          }
          : {}),
        ...(description ? { description } : {}),
        ...(fields.length ? { fields } : {}),
        ...(!omitRuntime && normalizeScan(data.scan) ? { scan: normalizeScan(data.scan) } : {}),
        ...(!omitRuntime && normalizeProcesses(data.processes).length
          ? { processes: normalizeProcesses(data.processes) }
          : {}),
      },
    };
    const style = {};
    // 迁移兼容：宽度只在非默认时保留；高度存在即视为用户手动固定。
    const w = toW(rawNode.style?.width) ?? toW(rawNode.width);
    if (w && Math.abs(w - NODE_W) > 0.5) style.width = w;
    const h = toW(rawNode.style?.height) ?? toW(rawNode.height);
    if (h) style.height = h;
    if (style.width || style.height) node.style = style;
    nodes.push(node);
  });
  const edges = [];
  raw.edges.forEach((rawEdge) => {
    if (!rawEdge || rawEdge.source == null || rawEdge.target == null) return;
    const source = String(rawEdge.source);
    const target = String(rawEdge.target);
    if (!ids.has(source) || !ids.has(target)) return;
    const label =
      rawEdge.label != null && String(rawEdge.label).trim() !== '' ? String(rawEdge.label) : '';
    const id = rawEdge.id != null ? String(rawEdge.id) : `e-${edges.length + 1}`;
    edges.push({ id, source, target, ...(label ? { label } : {}) });
  });
  return { nodes, edges };
}

/**
 * 一次性迁移：把旧快照里节点的 label / title 键改名为 name，note → content。
 * 只有这里允许读取旧键；其余主逻辑一律只认新键。
 * 兼容：React Flow 格式（node.data）、逻辑格式（无 node.data），
 * 以及旧版顶层单图与多标签 store。就地修改并返回同一对象。
 */
function migrateLegacySnapshot(s) {
  if (!s || typeof s !== 'object') return s;
  const migrateNodes = (arr) => {
    if (!Array.isArray(arr)) return;
    arr.forEach((node) => {
      if (!node || typeof node !== 'object') return;
      if (node.data && typeof node.data === 'object') {
        if (node.data.name === undefined) {
          if (node.data.title !== undefined) node.data.name = node.data.title;
          else if (node.data.label !== undefined) node.data.name = node.data.label;
        }
        if (node.data.note !== undefined && node.data.content === undefined) {
          node.data.content = node.data.note;
        }
        delete node.data.label;
        delete node.data.note;
        delete node.data.title;
      } else {
        if (node.name === undefined) {
          if (node.title !== undefined) node.name = node.title;
          else if (node.label !== undefined) node.name = node.label;
        }
        if (node.note !== undefined && node.content === undefined) {
          node.content = node.note;
        }
        delete node.label;
        delete node.note;
        delete node.title;
      }
    });
  };
  // 旧版顶层单图：{ nodes, edges }
  migrateNodes(s.nodes);
  // 多标签：store 下每张图
  if (s.store && typeof s.store === 'object') {
    Object.values(s.store).forEach((g) => {
      if (g && typeof g === 'object') migrateNodes(g.nodes);
    });
  }
  return s;
}

/**
 * 规范化 tab 的 SE 绑定字段（§5.1）：{system_id, display_name, manifest_path,
 * storage_dir}；token 不落盘。无该字段（旧工作区）返回 null，原样兼容。
 * manifest_path 经 `portableDocPath` 落契为项目内相对路径（存量迁移与跨机同步）。
 */
function normalizeTabSystem(raw, opts) {
  if (!raw || typeof raw !== 'object') return null;
  const systemId = toStr(raw.system_id).trim();
  if (!systemId) return null;
  return {
    system_id: systemId,
    display_name: toStr(raw.display_name) || systemId,
    manifest_path:
      raw.manifest_path == null
        ? null
        : portableDocPath(toStr(raw.manifest_path), getProjectRoot(), opts),
    storage_dir: raw.storage_dir == null ? null : toStr(raw.storage_dir),
  };
}

/**
 * 为无 SE 绑定的 tab 就地分配一个稳定系统身份（P4：每个 tab 终将拥有真实 SE）。
 * 名字优先，无名草稿回落 tab.id；`taken` 为该次分配内去重集合，命中自动追加 _2/_3…
 */
function assignTabSystem(tab, taken) {
  const sid = deriveSystemId(String(tab.name || '').trim() || String(tab.id), taken);
  taken.add(sid);
  return {
    ...tab,
    system: {
      system_id: sid,
      display_name: tab.name || tab.id,
      manifest_path: null,
      storage_dir: `se-systems/${sid}`,
    },
  };
}

/**
 * 校验并规范化一份工作区快照（本地文件或 localStorage 均可），
 * 结构：{ activeId, tabs: [{id, name, system?}], store: { [id]: {nodes, edges} } }。
 * 兼容旧版单图快照（顶层 nodes/edges/name）→ 迁移为一个标签；无效返回 null。
 */
function normalizeWorkspace(s) {
  try {
    migrateLegacySnapshot(s);
    // 旧工作区（无 workspaceVersion）才允许“异机 graphs 残留”折叠；
    // 新工作区显式外部路径（含外部 .../graphs/ 目录）绝不折叠。
    const legacy = !(s && s.workspaceVersion);

    if (s && Array.isArray(s.nodes) && Array.isArray(s.edges) && !Array.isArray(s.tabs)) {
      const id = genTabId();
      const g = normalizeStoredGraph(s) ?? { nodes: [], edges: [] };
      return {
        workspaceVersion: 2,
        activeId: id,
        tabs: [{ id, name: toStr(s.name) }],
        store: { [id]: { ...g, tools: {} } },
      };
    }

    if (!s || !Array.isArray(s.tabs) || s.tabs.length === 0) return null;
    const tabs = [];
    const store = {};
    s.tabs.forEach((t) => {
      if (!t || t.id == null) return;
      const id = String(t.id);
      const tab = { id, name: toStr(t.name) };
      const system = normalizeTabSystem(t.system, { repairGraphsResidue: legacy });
      if (system) tab.system = system;
      // 外部文档写回：放行 docPath（配置真实路径；null/缺省 = 应用内新建，行为不变）。
      if (t.docPath != null && String(t.docPath).trim()) {
        tab.docPath = portableDocPath(t.docPath, getProjectRoot(), {
          repairGraphsResidue: legacy,
        });
      }
      tabs.push(tab);
      const g = normalizeStoredGraph(s.store?.[id], !!system);
      // 工具随标签页文档持久化；旧工作区无 tools 键 → 空工具集（不再预置示例工具）。
      if (g) {
        store[id] = {
          ...g,
          tools: s.store?.[id]?.tools ? normalizeTools(s.store[id].tools) : {},
          viewport: validViewportOrNull(s.store?.[id]?.viewport),
        };
      }
    });
    if (tabs.length === 0) return null;
    const activeId = tabs.some((t) => t.id === s.activeId) ? String(s.activeId) : tabs[0].id;
    return { workspaceVersion: 2, tabs, activeId, store };
  } catch (err) {
    console.warn('工作区快照规范化失败', err);
    return null;
  }
}

/** localStorage 兜底恢复：仅在本地工作区文件不可用（如 dev server 未带 API）时使用。 */
function restoreSnapshot() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return normalizeWorkspace(JSON.parse(raw));
  } catch (err) {
    console.warn('本地画布快照恢复失败', err);
    return null;
  }
}

function maxSeq(ids, prefix) {
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  let m = 0;
  ids.forEach((id) => {
    const match = re.exec(String(id || ''));
    if (match) m = Math.max(m, parseInt(match[1], 10));
  });
  return m;
}

/**
 * 快速内容指纹（FNV-1a 32 位，按 UTF-16 code unit）——仅用于跳过未变的正文文件写入。
 * 非安全哈希；对"本会话内避免重复写同一文件"足够。碰撞仅会导致少写一次（下次内容再变仍会写）。
 */
function hashText(text) {
  const s = String(text == null ? '' : text);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * 相对路径契约（外部文档写回改造）：`.se.json` 内的相对路径一律 = **相对该 .se.json 所在目录**。
 * `source.file_path` → 可下发服务端的读取/写入路径：绝对路径原样；相对路径拼 `configDir`。
 * `configDir` 缺省 `'graphs'`（graphs 惯例：与改造前的 `graphs/` 硬编码前缀逐字节等价）。
 * 兼容：相对路径已带 `<configDir>/` 前缀（旧配置遗留 `graphs/...`）时原样，避免双重拼接。
 */
function resolveAgainstConfigDir(filePath, configDir) {
  const fp = String(filePath == null ? '' : filePath).replace(/\\/g, '/').trim();
  if (!fp) return '';
  if (/^[A-Za-z]:\//.test(fp) || fp.startsWith('//') || fp.startsWith('/')) return fp;
  const base = String(configDir || 'graphs').replace(/\\/g, '/').replace(/\/+$/, '') || 'graphs';
  if (fp === base || fp.startsWith(`${base}/`)) return fp;
  return `${base}/${fp}`;
}

/** tab.docPath（null = 应用内新建）→ 配置所在目录（posix）；null 回退 graphs 惯例。 */
function configDirOf(docPath) {
  const p = String(docPath || '').replace(/\\/g, '/').trim();
  if (!p) return 'graphs';
  return manifestDirOf(p).replace(/\\/g, '/');
}

/**
 * 配置目录绝对化。写侧归一化/注册的基准必须是绝对路径——
 * 否则 `absolutizeToolPath` 拼出来的仍是相对值，SE 会按自身进程 cwd 解析。
 * 项目根未知时回退原值（不猜测）。
 */
function absoluteConfigDirOf(docPath) {
  const dir = configDirOf(docPath);
  return absolutizeDocPath(dir, getProjectRoot()) || dir;
}

/**
 * 统一文档路径规范化（手动「加载文档」用）：正斜杠；裸文件名 → `graphs/<名>.json`（兼容旧行为）；
 * 相对路径保持相对（服务端按项目根解析）；补 `.json` 后缀。
 */
function normalizeDocTarget(target) {
  let t = String(target || '').trim().replace(/\\/g, '/');
  if (!t) return '';
  const isAbs = /^[A-Za-z]:\//.test(t) || t.startsWith('//') || t.startsWith('/');
  if (!isAbs && !t.includes('/')) t = `graphs/${t}`;
  if (!new RegExp(`${GRAPH_CONFIG_EXT.replace('.', '\\.')}$`, 'i').test(t)) t += GRAPH_CONFIG_EXT;
  return t;
}

/** 视口唯一自动决策者：仅在显式请求 + 容器尺寸就绪 + 至少 1 个可见节点 + 全部测量完成时执行一次。
 *  结构投影/节点测量变化本身绝不触发 fit（这是旧 FitViewer 的竞态来源）。 */
function ViewportController({ request, onConsumed }) {
  const { fitView, setViewport, getNodes, getNodesBounds } = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const initialized = useNodesInitialized();
  const appliedRef = useRef(0);
  useEffect(() => {
    if (!request || !initialized) return;
    if (appliedRef.current === request.id) return;
    if (!(width > 0) || !(height > 0)) return;
    // getNodes() 返回 <ReactFlow nodes={renderNodes}> 的节点，hidden 由 renderNodes 派生
    const nodes = getNodes().filter((n) => !n.hidden);
    if (!nodes.length) return; // 空画布 / 全隐藏：绝不 fit（否则会 fit 到 maxZoom 原点）
    appliedRef.current = request.id;
    onConsumed?.(request.id); // 先消费，避免 setViewport/fitView 触发的 onMoveStart 造成重复
    const pv = request.viewport;
    if (request.kind === 'restore' && pv &&
        Number.isFinite(pv.x) && Number.isFinite(pv.y) &&
        Number.isFinite(pv.zoom) && pv.zoom > 0) {
      const b = getNodesBounds(nodes);
      if (b && Number.isFinite(b.x) && Number.isFinite(b.y) && b.width > 0 && b.height > 0) {
        const vis = { x: -pv.x / pv.zoom, y: -pv.y / pv.zoom, w: width / pv.zoom, h: height / pv.zoom };
        const iw = Math.min(b.x + b.width, vis.x + vis.w) - Math.max(b.x, vis.x);
        const ih = Math.min(b.y + b.height, vis.y + vis.h) - Math.max(b.y, vis.y);
        if (iw > 0 && ih > 0) {
          setViewport(pv, { duration: 250 });
          return;
        }
      }
    }
    fitView({ padding: CANVAS_FIT_PADDING, duration: 250 });
  }, [request, initialized, width, height, getNodes, getNodesBounds, fitView, setViewport, onConsumed]);
  return null;
}

/** 底部 toast：挂载后下一帧加 .show 触发淡入，与原型一致。 */
function Toast({ text, kind }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShow(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className={`toast ${kind || 'info'}${show ? ' show' : ''}`}>
      <span className="toast-dot" />
      <span>{text}</span>
    </div>
  );
}

/**
 * 内容 CAS 冲突对话框（编辑器选型与迁移方案 §1.3 v1 口径）：
 * 服务端内容已被外部修改 → 重读后二选一「覆盖服务端 / 放弃本地修改」，不做三路合并。
 */
function CasConflictDialog({ conflict, onOverwrite, onDiscard }) {
  if (!conflict) return null;
  return (
    <ModalOverlay className="cas-conflict">
      <div className="modal">
        <h3>服务端内容已被外部修改</h3>
        <div className="dlg-note">
          流「{conflict.name}」在你编辑期间被其它写入者改动。请选择保留哪一份：
          <br />
          覆盖 = 用画布上的本地版本写回服务端；放弃 = 采用服务端最新内容，丢弃本地修改。
        </div>
        <div className="dlg-actions">
          <button type="button" className="primary danger cas-overwrite" onClick={onOverwrite}>
            覆盖服务端
          </button>
          <button type="button" className="cas-discard" onClick={onDiscard}>
            放弃本地修改
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}

/**
 * 迁移（§5.3）：画布 rows → snake-manifest-v1（正文内联 + tags 含 edge.* + system.graph.layout）。
 * 纯函数，便于与既有 planImport/applyImport 复用同一导入通路。
 */
function buildMigrationManifest(rows, tools, positions) {
  const manifest = {
    $schema: 'snake-manifest-v1',
    streams: (Array.isArray(rows) ? rows : []).map((r) => ({
      name: r.name,
      description: r.description,
      tags: { ...(r.tags || {}) },
      content: r.content,
    })),
    tools: Array.isArray(tools) ? tools : [],
  };
  if (positions && Object.keys(positions).length) {
    manifest.system = { ...(manifest.system || {}), graph: { format_version: '5.0', layout: positions } };
  }
  return manifest;
}

export default function App() {
  // boot === undefined 表示仍在加载本地工作区文件；null 表示无任何可恢复快照。
  const [boot, setBoot] = useState(undefined);
  const [bootFrom, setBootFrom] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let ws = null;
      let from = null;
      try {
        // 项目根先行：normalizeWorkspace 的存量迁移（绝对 → 相对）依赖它。
        await ensureProjectRoot();
        const res = await fetch('/api/workspace');
        if (res.ok) {
          ws = normalizeWorkspace(await res.json());
          if (ws) from = 'file';
        }
      } catch (err) {
        console.warn('读取本地工作区文件失败，尝试浏览器缓存', err);
      }
      if (!ws) {
        ws = restoreSnapshot();
        if (ws) from = 'local';
      }
      if (!cancelled) {
        setBoot(ws);
        setBootFrom(from);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (boot === undefined) {
    return (
      <div style={{ padding: 24, color: '#888', fontFamily: 'sans-serif' }}>
        正在从本地文件加载画布…
      </div>
    );
  }
  return <FlowApp restored={boot} restoredFrom={bootFrom} />;
}

function FlowApp({ restored, restoredFrom }) {
  const initialTabs = restored?.tabs ?? [{ id: genTabId(), name: '' }];
  const initialActive = restored?.activeId ?? initialTabs[0].id;
  const initialGraph = restored?.store?.[initialActive] ?? { nodes: [], edges: [] };
  const initialCanvas = toCanvasGraph(initialGraph);

  const [tabs, setTabs] = useState(initialTabs);
  const [activeId, setActiveId] = useState(initialActive);
  const [closingTabIds, setClosingTabIds] = useState(() => new Set());
  const closingTabIdsRef = useRef(new Set());
  const storeRef = useRef(restored?.store ?? {});
  // 已从磁盘加载（或明确为本地草稿）的 tab id：未加载前禁止自动保存/切换落空，
  // 防「空画布覆盖既有图谱配置」。纯指针工作区下初始为空 → 首个 tab 触发懒加载。
  const hydratedRef = useRef(new Set(Object.keys(restored?.store ?? {})));
  const [nodes, setNodes, onNodesChange] = useNodesState(initialCanvas.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialCanvas.edges);
  // 工具集合：当前标签页文档的一部分（随工作区持久化，不进 undo 快照）。
  const [tools, setTools] = useState(() =>
    initialGraph.tools ? normalizeTools(initialGraph.tools) : {}
  );
  const toolsRef = useRef(tools);
  useEffect(() => {
    toolsRef.current = tools;
  }, [tools]);
  // 编辑回写走 setNodes 直写；refs 保持与 state 同步，供切图/历史等同步读最新节点，
  // 避免「flush 后立刻切标签」读到旧的 state 闭包而丢失最后一段编辑。
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);
  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);
  // 原子节点写：完整数组写入时同步 nodesRef，避免后续 removeNode/flush 以陈旧 ref
  // 覆盖刚投影出的节点（函数式更新仍交给 React，由上面的 effect 负责同步 ref）。
  const applyNodes = useCallback(
    (next) => {
      if (typeof next === 'function') {
        setNodes(next);
        return;
      }
      nodesRef.current = next;
      setNodes(next);
    },
    [setNodes]
  );
  const [graphName, setGraphNameState] = useState(
    initialTabs.find((t) => t.id === initialActive)?.name ?? ''
  );
  const [status, setStatus] = useState(
    restoredFrom === 'file'
      ? '已从本地文件恢复上次的画布'
      : restoredFrom === 'local'
        ? '本地文件不可用，已从浏览器缓存恢复'
        : ''
  );
  const [dialog, setDialog] = useState(null);
  const [dlgPath, setDlgPath] = useState('');
  const [dlgName, setDlgName] = useState('');
  const [history, setHistory] = useState([]);
  const [dlgBusy, setDlgBusy] = useState(false);
  // 统一文档加载预览（含冲突统计，等待用户三选策略）
  const [docPreview, setDocPreview] = useState(null);
  const [edgeEdit, setEdgeEdit] = useState(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [themeId, setThemeId] = useTheme();
  // ── SE tab 绑定（期 2）：每 tab 绑一个 SE 系统，状态由连接池事件驱动 ──────────
  // seStatusMap: system_id → SE_STATUS（徽标 / 离线态 / tabbar 小点共用）。
  const [seStatusMap, setSeStatusMap] = useState({});
  const [newTabOpen, setNewTabOpen] = useState(false);
  // 期 10：配置包导出对话框（null = 关闭；{streams,tools} = 打开）＋进度/忙碌态。
  const [pkgExport, setPkgExport] = useState(null);
  const [pkgBusy, setPkgBusy] = useState(false);
  const [pkgProgress, setPkgProgress] = useState(null);
  // 期 11：配置包导入（null = 关闭；{mode,manifest,manifestPath,contents,plan,planInputs} = 打开）。
  const [pkgImport, setPkgImport] = useState(null);
  const [pkgImportBusy, setPkgImportBusy] = useState(false);
  const [pkgImportProgress, setPkgImportProgress] = useState(null);
  // 双提交守卫：busy 状态是异步的，快速双击可能在同一渲染帧内触发两次导入。
  const pkgImportBusyRef = useRef(false);
  // 情境一：已绑定 tab 的「加载配置包」选择器（重载绑定包 / 选择其他包）。
  const [pkgImportChoose, setPkgImportChoose] = useState(null);
  // R-3（D9）：文件面板快捷创建——App 层对话框宿主（不依赖 StreamPanel/ToolPanel 挂载）。
  const [streamDraft, setStreamDraft] = useState(null);
  const [toolDraft, setToolDraft] = useState(null);
  // 供异步回调读最新 tabs（避免 stale closure）。
  const tabsRef = useRef(initialTabs);
  const colorMode = THEMES.find((t) => t.id === themeId)?.colorMode ?? 'dark';
  const [panelText, setPanelText] = useState('');
  const [panelBase, setPanelBase] = useState('');
  const [panelDirty, setPanelDirty] = useState(false);
  const [panelMsg, setPanelMsg] = useState(null);
  const nodeSeqRef = useRef(0);
  const edgeSeqRef = useRef(0);
  const saveTimerRef = useRef(null);
  const graphSyncRef = useRef({});
  // .workspace.json 纯指针基线：初始 = 本次实际加载并规范化的快照（冷启动同值 → 零写）。
  // 写成功后才推进；失败保留旧基线，下次 tabs/activeId 变化再重试。
  const workspaceBaselineRef = useRef(
    JSON.stringify({ workspaceVersion: 2, activeId: initialActive, tabs: initialTabs })
  );
  // 用户显式清空（"重置"）的 tab id：仅这些 tab 允许把含流图写成空文档（B3 护栏放行票）。
  const explicitEmptySaveRef = useRef(new Set());
  // file_path → 内容指纹：v2 保存时跳过未变的正文文件写入（避免 600ms 自动保存写放大）。
  const contentHashRef = useRef(new Map());
  // owned-source reconcile 告警去重：同一路径失败只提示一次，避免 600ms 自动保存刷屏。
  const sourceWarnRef = useRef(new Set());
  // Tier-1 保存串行化：自动保存/flushDeletion/closeTab 共享同一 Promise 链，
  // 消除并发在飞写互相覆盖（last-writer-wins 把删除前旧快照写回 → 已删流复活）。
  // 队列顺序即写盘顺序；每次执行读最新 storeRef/tabsRef，最终落盘必为最新态。
  const saveChainRef = useRef(Promise.resolve());
  // Tier-1 绑定中禁写（P0-3）：bindSystem 全程持有；导入/首投影未完成前，
  // 该 tab 的空画布/半成品绝不写盘（首次保存 prev 不存在，B3 空写护栏不生效）。
  const bindInflightRef = useRef(new Set());
  // 工具新建/纳入的并发守卫：同一操作在飞时重复点击直接 no-op（不并发发 RPC/写盘）。
  const toolOpsInflightRef = useRef(new Set());
  // Tier-1：退出编辑的 SE 提交句柄——closeTab 杀 SE 前必须等它落定。
  const exitCommitRef = useRef(null);
  // system_id → 常驻布局表（流名 → {x,y,width?,height?}）：投影真源，永不消费；
  // 条目删除仅经 pruneLayout（服务端已删流）与 closeTab。
  const layoutRef = useRef({});
  const shortcutsRef = useRef({});
  const blockRef = useRef({ dialog: null, edgeEdit: null, panelOpen: false });
  // 视口按需捕获：onMoveEnd 捕获，span/持久化读取此值。
  const viewportRef = useRef(null);
  // 视口请求：唯一自动视口动作来源（取代旧 tick/ref + <ReactFlow fitView> 两条自动 fit 来源）。
  // 结构投影/测量变化绝不主动请求；只有显式调用 requestViewport 才可能移动视口。
  const [viewportRequest, setViewportRequest] = useState(null);
  const viewportSeqRef = useRef(0);
  const requestViewport = useCallback((kind, viewport = null) => {
    viewportSeqRef.current += 1;
    setViewportRequest({
      id: viewportSeqRef.current,
      kind: kind === 'restore' && viewport ? 'restore' : 'fit',
      viewport: kind === 'restore' && viewport ? viewport : null,
    });
  }, []);
  const consumeViewportRequest = useCallback((id) => {
    setViewportRequest((r) => (r && r.id === id ? null : r));
  }, []);
  const cancelViewportRequest = useCallback(() => setViewportRequest(null), []);
  useEffect(() => {
    // 首次挂载：已水合 tab 恢复存档视口（无则 fit 一次）；未水合交给懒加载 effect
    if (!hydratedRef.current.has(activeId)) return;
    const g = storeRef.current[activeId];
    requestViewport(g && g.viewport ? 'restore' : 'fit', g && g.viewport ? g.viewport : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const { screenToFlowPosition, setCenter, getZoom } = useReactFlow();
  const storeApi = useStoreApi();
  const undoRef = useRef({});
  const undoBusyRef = useRef(false);
  const clipboardRef = useRef(null);
  const pasteCountRef = useRef(1);
  const connectFromRef = useRef(null);
  const [selCount, setSelCount] = useState({ nodes: 0, edges: 0 });
  // 文本视图双向同步/拖拽相关的状态与引用
  const [panelWidth, setPanelWidth] = useState(520);
  const panelDragRef = useRef(null);
  const textFocusedRef = useRef(false);
  const applyingTextRef = useRef(false);
  const textTimerRef = useRef(null);
  const textBurstRef = useRef(false);
  const applyTextToCanvasRef = useRef(null);

  // 文件侧栏 UI 偏好（宽度/折叠/排序/列宽）→ /api/store/ui（graphs/.ui.json）
  const [uiPrefs, setUiPrefs] = useState(DEFAULT_UI);
  const [uiReady, setUiReady] = useState(false);
  const uiLoadedRef = useRef(false);
  // 实际加载/确认写回的 UI 载荷基线（缺文件时 = 默认规范载荷 → 首启不建文件）。
  const uiPayloadBaselineRef = useRef(JSON.stringify(DEFAULT_UI));
  const updatePrefs = useCallback((partial) => {
    setUiPrefs((p) => normalizeUi({ ...p, ...partial }));
  }, []);
  const toggleSidebar = useCallback(() => {
    setUiPrefs((p) => normalizeUi({ ...p, sidebarCollapsed: !p.sidebarCollapsed }));
  }, []);

  // P6：SE 启动前置探测（仅一次）。不可用时禁止本地兜底 spawn，改由单一横幅提示。
  const [sePreflight, setSePreflight] = useState(null);
  const sePreflightRef = useRef(false);
  useEffect(() => {
    if (sePreflightRef.current) return;
    sePreflightRef.current = true;
    fetch('/api/se/preflight')
      .then((res) => res.json())
      .then((data) => setSePreflight(data))
      .catch(() => setSePreflight({ available: false, reason: 'preflight 请求失败' }));
  }, []);
  const preflightUnavailable = !!(sePreflight && sePreflight.available === false);

  // P4：任何无 system 的 tab（初始草稿 / 关最后一个 tab 的替补 / 旧工作区本地 tab）
  // 在 UI 偏好就绪后一次性补齐稳定 SE 身份；taken 取已绑定集合，避免派生撞名。
  const unboundKey = tabs
    .filter((t) => !t.system?.system_id)
    .map((t) => t.id)
    .join('|');
  useEffect(() => {
    if (!uiReady || !unboundKey) return;
    const taken = new Set(tabs.filter((t) => t.system?.system_id).map((t) => t.system.system_id));
    const next = tabs.map((t) => (t.system?.system_id ? t : assignTabSystem(t, taken)));
    tabsRef.current = next;
    setTabs(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiReady, unboundKey]);

  // 状态栏：光标桥插入目标 + Toast 栈 + 编辑会话（阶段 5）
  const [bridgeTarget, setBridgeTarget] = useState(null);
  const [editingNodeId, setEditingNodeId] = useState(null);
  const editingIdRef = useRef(null);
  const editorApiRef = useRef(null);
  // 屏幕空间编辑条宿主：常驻 ref，只换工具栏的 DOM 挂载点，不改变编辑状态归属。
  const flowEditHudRef = useRef(null);
  // 片段体系（需求 8）：内置 + 自定义，持久化 /api/store/snippets。
  const [snippets, setSnippets] = useState(() => normalizeSnippets(null));
  const snippetsLoadedRef = useRef(false);
  // 实际加载/确认写回的片段载荷基线（缺文件时 = 内置默认 → 首启不建文件）。
  const snippetsPayloadBaselineRef = useRef(null);
  const [snippetLibOpen, setSnippetLibOpen] = useState(false);
  const [toasts, setToasts] = useState([]);
  const toastSeqRef = useRef(0);
  const pushToast = useCallback((text, kind) => {
    const id = (toastSeqRef.current += 1);
    setToasts((ts) => [...ts, { id, text, kind }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 2800);
  }, []);
  const notify = useCallback(
    (text, kind = 'info') => {
      setStatus(text);
      pushToast(text, kind);
    },
    [pushToast]
  );

  /** 该流当前是否扫描活动（导入覆盖 fail-closed 用）。 */
  const scanActiveForName = useCallback((name) => {
    const nodeId = streamNodeId(name);
    const node = nodesRef.current.find((n) => String(n.id) === nodeId);
    return !!node && SCAN_ACTIVE_STATES.includes(node.data?.scan?.state);
  }, []);

  /** 若任一目标流正在扫描 → 提示并拒绝非局部写；names 缺省 = 当前画布全部流。 */
  const guardNoActiveScan = useCallback(
    (label, names) => {
      if (Array.isArray(names) && names.length === 0) return true;
      const wanted = Array.isArray(names) ? names.map(String) : null;
      const active = nodesRef.current
        .filter((n) => SCAN_ACTIVE_STATES.includes(n?.data?.scan?.state))
        .map((n) => streamNameFromId(n.id))
        .filter((name) => name && (!wanted || wanted.includes(name)));
      if (!active.length) return true;
      notify(
        `扫描活动期间不支持${label}（${active.slice(0, 3).join('、')}${
          active.length > 3 ? ' 等' : ''
        }）；请先停止扫描或显式 rescan`,
        'warn'
      );
      return false;
    },
    [notify]
  );

  // ── SE 绑定派生 + 连接/启动动作（期 2）──────────────────────────────────────
  const activeTab = tabs.find((t) => t.id === activeId) || null;
  const openDocPaths = useMemo(
    () => new Set(tabs.map(workDocPathOf).filter(Boolean).map(canonDocPath)),
    [tabs]
  );
  const activeWorkDocPath = workDocPathOf(activeTab);
  const activeSystem = activeTab?.system || null;
  const activeSystemId = activeSystem?.system_id || null;
  const activeStatus = activeSystemId
    ? seStatusMap[activeSystemId] || SE_STATUS.CONNECTING
    : null;
  // D：token-unavailable 已成防御性死路径；离线仅认 OFFLINE。离线是瞬态——
  // 自愈 effect（见下）会自动 ensureSystem 重拉，不再停「只读展示本地缓存」终态。
  const systemOffline = !!activeSystemId && activeStatus === SE_STATUS.OFFLINE;
  const systemOfflineRef = useRef(false);
  systemOfflineRef.current = systemOffline;
  tabsRef.current = tabs;

  // ── SE 流读写主干（期 3）───────────────────────────────────────────────────
  // 活动系统/标签的 ref：异步 RPC 回包时判定「是否仍是当前活动 tab」，避免污染别的画布。
  const activeSystemIdRef = useRef(null);
  activeSystemIdRef.current = activeSystemId;
  const activeTabIdRef = useRef(activeId);
  activeTabIdRef.current = activeId;

  // ── 工具注册状态（per-system 元数据；配置=列表真源，SE=可执行状态）─────────────
  // Oracle Q1：App 是配置 tools 字典的**唯一写者**；toolDriver 只经 onToolStatus 回报
  // 「SE 已注册名集合 + 完整定义」，绝不自动回写配置（避免 SE 事件覆盖台账 + 陈旧 ref 竞态）。
  const toolRegistryRef = useRef({}); // sid → { present:Set<string>, definitions:{ [name]:def }, failed:{ [name]:reason } }
  const [toolStatusTick, setToolStatusTick] = useState(0);
  const bumpToolStatus = useCallback(() => setToolStatusTick((t) => t + 1), []);

  /** 同步提交配置 tools（toolsRef + React state），关闭 stash/驱动的陈旧读竞态。 */
  const commitTools = useCallback(
    (updater) => {
      const base = toolsRef.current || {};
      const draft = typeof updater === 'function' ? updater(base) : updater;
      const next = normalizeTools(draft);
      toolsRef.current = next;
      setTools(next);
    },
    [setTools]
  );

  /** 取某系统的配置工具（活动系统读 toolsRef；后台系统读其 tab 缓存）。 */
  const toolsForSystem = useCallback((systemIdRaw) => {
    const sid = String(systemIdRaw);
    if (String(activeSystemIdRef.current || '') === sid) return normalizeTools(toolsRef.current);
    const tab = tabsRef.current.find((t) => String(t.system?.system_id) === sid);
    return tab ? normalizeTools(storeRef.current[tab.id]?.tools || {}) : {};
  }, []);

  /**
   * 某系统绑定 tab 的 manifest 目录（工具相对路径绝对化基准）。
   * 必须返回**绝对目录**：manifest_path/docPath 是项目相对的可移植形式，
   * 直接拼相对值会让 SE 按自身进程 cwd 解析（见 process.js spawn cwd）。
   * 无 manifest_path/docPath → 项目根（仍为绝对）；项目根未知 → ''。
   */
  const baseDirForSystem = useCallback((systemIdRaw) => {
    const sid = String(systemIdRaw);
    const tab = tabsRef.current.find((t) => String(t.system?.system_id) === sid);
    const mp = toolBasePathOf(tab) || '';
    if (!mp) return getProjectRoot() || '';
    // 唯一基准：manifestPath 先绝对化；根未知 → ''（调用方 fail-closed，绝不退回相对路径）。
    return manifestAbsDirOf(mp) || getProjectRoot() || '';
  }, []);

  /** SE 注册表快照回报：保留完整定义供显式纳入；成功注册的名字清除历史失败。 */
  const onToolStatus = useCallback(
    (systemIdRaw, snapshot) => {
      const sid = String(systemIdRaw);
      const present = snapshot && snapshot.present instanceof Set ? snapshot.present : new Set();
      const definitions =
        snapshot && snapshot.definitions && typeof snapshot.definitions === 'object' && !Array.isArray(snapshot.definitions)
          ? snapshot.definitions
          : {};
      const cur = toolRegistryRef.current[sid] || { present: new Set(), definitions: {}, failed: {} };
      const failed = { ...cur.failed };
      for (const name of present) delete failed[name];
      toolRegistryRef.current[sid] = {
        present: new Set(present),
        definitions: { ...definitions },
        failed,
      };
      bumpToolStatus();
    },
    [bumpToolStatus]
  );

  /** 扫描重锚失败：弹「候选继续 / 从头重扫 / 停止」（2026-10-25）。 */
  const onScanResumeMissing = useCallback((info) => {
    if (!info || !info.nodeId) return;
    setScanResumeMissing(info);
  }, []);

  /** 逐条记录投影失败（不覆盖已注册者），供列表标注「注册失败」。 */
  const recordToolFailures = useCallback(
    (systemIdRaw, failures) => {
      if (!Array.isArray(failures) || !failures.length) return 0;
      const sid = String(systemIdRaw);
      const cur = toolRegistryRef.current[sid] || { present: new Set(), definitions: {}, failed: {} };
      const failed = { ...cur.failed };
      let added = 0;
      for (const f of failures) {
        const name = String((f && f.name) || '');
        if (!name || cur.present.has(name)) continue;
        const reason = String((f && f.error) || '注册失败');
        if (failed[name] === reason) continue; // 同一失败不重复计数/告警
        failed[name] = reason;
        added += 1;
      }
      toolRegistryRef.current[sid] = { ...cur, failed };
      bumpToolStatus();
      return added;
    },
    [bumpToolStatus]
  );

  /** 活动系统工具注册状态：name → {state, reason?}；未绑定返回 null（无 SE 状态）。 */
  const toolStatusByName = useMemo(() => {
    if (!activeSystemId) return null;
    const reg = toolRegistryRef.current[String(activeSystemId)] || { present: new Set(), failed: {} };
    const out = {};
    Object.keys(tools).forEach((name) => {
      if (reg.present.has(name)) out[name] = { state: 'registered' };
      else if (reg.failed[name]) out[name] = { state: 'failed', reason: reg.failed[name] };
      else out[name] = { state: 'unregistered' };
    });
    return out;
    // toolStatusTick 触发重算（ref 内容变化不引起渲染）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSystemId, tools, toolStatusTick]);

  const seOnlyTools = useMemo(() => {
    if (!activeSystemId) return {};
    const reg = toolRegistryRef.current[String(activeSystemId)] || {
      present: new Set(),
      definitions: {},
      failed: {},
    };
    const liveSE = normalizeTools(reg.definitions);
    return Object.fromEntries(
      Object.entries(liveSE).filter(
        ([name]) => reg.present.has(name) && !Object.prototype.hasOwnProperty.call(tools, name)
      )
    );
    // toolStatusTick 触发重算（ref 内容变化不引起渲染）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSystemId, tools, toolStatusTick]);

  // 期 Task5：pending → SE 提升器（定义靠后）。reconnect / tab 加载尾部经 ref 调用，避免
  // 前向引用与 effect 依赖抖动。
  const promotePendingRef = useRef(null);
  // 期 Task6：运行时边对齐（定义靠后）。连接/重连握手尾部经 ref 调用，用当前文档/画布边补写
  // SE tags（幂等），覆盖「离线加载→重连」缺口（此时加载尾部的对齐因离线空返回）。
  const alignEdgesRef = useRef(null);

  // CAS 冲突（-32010）弹窗状态。
  const [casConflict, setCasConflict] = useState(null);
  // ── 期 5：边派生 / 悬空边 / 级联修复 ──────────────────────────────────────
  // 当前活动系统派生的悬空边（目标流缺失）；>0 显示横幅「发现 N 条悬空边」。
  const [seDangling, setSeDangling] = useState([]);
  // 期 8：当前活动系统的工具注册/删除能力（root 探测结果）；非 root → 面板禁用 ＋/🗑。
  const [canManageTools, setCanManageTools] = useState(true);
  const [danglingOpen, setDanglingOpen] = useState(false);
  // 级联（rename/delete）后与预期的差异 → CascadeRepairDialog（重试/放弃）。
  const [cascadeRepair, setCascadeRepair] = useState(null);
  // rename 目标名 already-exists（D7 残留）→ G-1 错误对话框。
  const [renameConflict, setRenameConflict] = useState(null);
  // rename 前置确认框（应用内 ModalOverlay，替代原生 confirm）：{ old, newName, sid, refs }。
  const [renameConfirm, setRenameConfirm] = useState(null);
  // 期 12：流删除确认框（受控；入边计数由 App 以服务端真源注入）。
  // { id, name, title(显示名), refs } —— refs 为服务端入边引用（绑定在线）；local 模式为 null + localInbound。
  const [streamDelete, setStreamDelete] = useState(null);
  // R2：流多选批量删除聚合确认框；{ ids, title, online, inboundCount }。
  const [streamDeleteMany, setStreamDeleteMany] = useState(null);
  // 扫描重锚失败（resume-target-missing）候选对话框（2026-10-25）：
  // { nodeId, name, reason, position, candidates:[{tool,hash,position,context}] }。
  const [scanResumeMissing, setScanResumeMissing] = useState(null);

  // 已绑定系统集合（排序去重成 key，避免 tabs 引用变化导致重复订阅）。
  const boundSystemKey = tabs
    .filter((t) => t.system?.system_id)
    .map((t) => t.system.system_id)
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort()
    .join('|');

  useEffect(() => {
    const ids = boundSystemKey ? boundSystemKey.split('|') : [];
    return se.subscribeStatuses(ids);
  }, [boundSystemKey]);

  // ── 期 3：SE 流投影 / 内容读写 / 事件刷新 ───────────────────────────────────

  /**
   * 内容提交：已绑定在线流走 `stream.write`（带 CAS expected_version）；
   * 冲突 -32010 → 重读提示（§1.3 v1）。未绑定/本地节点不经此路径。
   * 实现已下沉 se.commitContent；此处仅把 CAS 冲突 payload 弹为对话框。
   */
  const commitStreamContent = useCallback(
    async (nodeId, textOverride) => {
      const res = await se.commitContent(nodeId, textOverride);
      if (res && res.reason === 'cas' && res.conflict) setCasConflict(res.conflict);
      if (res && res.rescanRequired) {
        notify('内容已整篇写入，扫描位置可能重置；请显式 rescan', 'warn');
      }
      return res;
    },
    [notify]
  );

  /** 冲突选项一：用本地版本覆盖服务端（以重读到的 version 作 CAS）。
   * 非局部整篇写：保留 stream.write，提交后需一次显式 rescan。 */
  const resolveCasOverwrite = useCallback(async () => {
    const c = casConflict;
    if (!c) return;
    const client = sePool.get(c.systemId);
    try {
      const params = { name: c.name, text: c.localText };
      if (c.remoteVersion !== undefined) params.expected_version = c.remoteVersion;
      const res = await client.call('stream.write', params);
      const version = res && res.version != null ? Number(res.version) : c.remoteVersion;
      se.noteCasResolved(c.systemId, c.name, version, c.localText);
      setNodes((nds) =>
        nds.map((n) => {
          if (String(n.id) !== c.nodeId) return n;
          const data = { ...n.data };
          if (c.localText) data.content = c.localText;
          else delete data.content;
          return { ...n, data };
        })
      );
      notify('已覆盖服务端内容', 'ok');
    } catch (err) {
      notify(`覆盖失败：${(err && err.message) || err}`, 'warn');
    } finally {
      setCasConflict(null);
    }
  }, [casConflict, notify, setNodes]);

  /** 冲突选项二：丢弃本地修改，采用服务端最新内容。 */
  const resolveCasDiscard = useCallback(() => {
    const c = casConflict;
    if (!c) return;
    se.noteCasResolved(c.systemId, c.name, c.remoteVersion, c.remoteText);
    setNodes((nds) =>
      nds.map((n) => {
        if (String(n.id) !== c.nodeId) return n;
        const data = { ...n.data };
        if (c.remoteText) data.content = c.remoteText;
        else delete data.content;
        return { ...n, data };
      })
    );
    setCasConflict(null);
    notify('已放弃本地修改，采用服务端内容', 'info');
  }, [casConflict, notify, setNodes]);

  /**
   * 建构导入计划（期 11）：读兄弟文件 + 取现有流/工具 + 正文/stat 探针 → planImport。
   * client 为空（情境二新系统）时按空现有集处理；返回 plan/contents/planInputs，供重算 selected。
   */
  const buildPackageImportPlan = useCallback(async ({ manifest, manifestPath, client }) => {
    const fetched = await fetchStreamContents({ manifest, manifestPath });
    let existingStreams = [];
    let existingTools = [];
    let toolListWarning = '';
    const existingContents = new Map();
    if (client) {
      const list = await client.call('stream.list', {}).catch(() => []);
      existingStreams = Array.isArray(list) ? list : [];
      const tlist = await client.call('tool.list', {}).catch((err) => {
        toolListWarning = `读取 SE 工具注册表失败：${(err && err.message) || err}；导入时会以实况重新判定`;
        return [];
      });
      existingTools = Array.isArray(tlist) ? tlist : Object.values(tlist || {});
      const incoming = new Set();
      for (const raw of Array.isArray(manifest.streams) ? manifest.streams : []) {
        const n = raw && raw.name != null ? String(raw.name) : '';
        if (n) incoming.add(n);
      }
      for (const row of existingStreams) {
        const n = row && row.name != null ? String(row.name) : '';
        if (!n || !incoming.has(n)) continue;
        try {
          const r = await client.call('stream.read', { name: n });
          existingContents.set(n, r && r.text != null ? String(r.text) : '');
        } catch (err) {
          // 读取失败：按未知处理，计划会保守判为 update。
        }
      }
    }
    const statResults = new Map();
    for (const def of Array.isArray(manifest.tools) ? manifest.tools : []) {
      const n = def && def.name != null ? String(def.name).trim() : '';
      const toolPath = def && def.tool_path != null ? String(def.tool_path).trim() : '';
      if (!n || !toolPath) continue;
      try {
        const res = await fetch('/api/fs/stat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: resolveSiblingPath(manifestPath, toolPath) }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data && data.exists === false) statResults.set(n, false);
      } catch (err) {
        // 探针失败：不标缺失。
      }
    }
    const basePlan = planImport({
      manifest,
      contents: fetched.contents,
      existingStreams,
      existingTools,
      existingContents,
      statResults,
    });
    const planInputs = {
      manifest,
      contents: fetched.contents,
      existingStreams,
      existingTools,
      existingContents,
      statResults,
    };
    return {
      plan: {
        ...basePlan,
        warnings: [...basePlan.warnings, ...fetched.warnings, ...(toolListWarning ? [toolListWarning] : [])],
      },
      contents: fetched.contents,
      planInputs,
    };
  }, []);

  /** 从配置包创建：选 .se.json → 解析 → 读兄弟内容 + 建计划 → 派生显示名/system_id。
   *  所选包就是工作文档（原地写回）；不再探测/重开 graphs 活副本。 */
  const pickPackage = useCallback(async () => {
    const res = await fetch('/api/dialog/open', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    if (!data.path) return null; // 用户取消
    const baseName = displayNameFromPath(data.path);
    const { manifest } = await loadManifestFile(data.path);
    const built = await buildPackageImportPlan({
      manifest,
      manifestPath: data.path,
      client: null,
    });
    const displayName = uniqueDisplayName(
      baseName,
      tabsRef.current.map((t) => t.name)
    );
    return {
      displayName,
      // system_id 不再在客户端派生：/api/se/create 在磁盘命名空间内原子分配
      // （避免“只看打开标签页”造成的大小写别名与旧 storage 复用）。
      baseName,
      // 绑定持久化用可移植路径；读取/建计划仍用原始 data.path。
      manifestPath: portableDocPath(data.path, getProjectRoot(), {
        repairGraphsResidue: false,
      }),
      manifest,
      contents: built.contents,
      plan: built.plan,
      planInputs: built.planInputs,
    };
  }, [buildPackageImportPlan]);

  /** 离线只读守卫：绑定系统不可达时挂起编辑/流 CRUD/可见性操作。 */
  const guardOffline = useCallback(() => {
    if (!systemOfflineRef.current) return false;
    notify('系统离线，操作已挂起', 'warn');
    return true;
  }, [notify]);
  const guardWrap = useCallback(
    (fn) =>
      (...args) => {
        if (guardOffline()) return undefined;
        return fn(...args);
      },
    [guardOffline]
  );

  // 片段增删（工具栏 ＋ / 浮条「存为片段」/ 右键删共用）。
  const addSnippet = useCallback(
    (name, content) => {
      const item = {
        group: 'user',
        name: String(name || '').trim(),
        text: String(content == null ? '' : content),
        hidden: false,
      };
      if (!item.name || !item.text.trim()) return;
      setSnippets((prev) => [...prev, item]);
      notify(`已新增片段「${item.name}」`, 'ok');
    },
    [notify]
  );
  const deleteSnippet = useCallback(
    (index) => {
      const s = snippets[index];
      if (!s) return;
      if ((s.group || 'user') === 'builtin') {
        notify('内置片段不可删除', 'warn');
        return;
      }
      setSnippets((prev) => prev.filter((_, i) => i !== index));
      notify(`已删除片段「${s.name}」`, 'info');
    },
    [snippets, notify]
  );

  // 读取 UI 偏好（graphs/.ui.json 首次 GET 404，按空对象处理）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let loaded = DEFAULT_UI;
      try {
        const res = await fetch('/api/store/ui');
        if (res.ok) {
          const data = await res.json();
          loaded = normalizeUi({ ...DEFAULT_UI, ...data });
          if (!cancelled) setUiPrefs((p) => normalizeUi({ ...p, ...data }));
        }
      } catch (err) {
        /* 首次不存在：忽略 */
      }
      if (!cancelled) {
        uiPayloadBaselineRef.current = JSON.stringify(loaded);
        uiLoadedRef.current = true;
        setUiReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 写回 UI 偏好（防抖；仅实际载荷变化时写，res.ok 后才推进基线）
  useEffect(() => {
    if (!uiLoadedRef.current) return undefined;
    const payload = JSON.stringify(uiPrefs);
    if (payload === uiPayloadBaselineRef.current) return undefined;
    const t = setTimeout(() => {
      fetch('/api/store/ui', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      })
        .then((res) => {
          if (res.ok) uiPayloadBaselineRef.current = payload;
        })
        .catch((err) => console.warn('保存 UI 偏好失败', err));
    }, 500);
    return () => clearTimeout(t);
  }, [uiPrefs]);

  // 片段加载（graphs/.snippets.json；首次 GET 404 → 仅内置）。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let raw = null;
      try {
        const res = await fetch('/api/store/snippets');
        if (res.ok) raw = await res.json();
      } catch (err) {
        /* 首次不存在：忽略 */
      }
      if (!cancelled) {
        const loaded = normalizeSnippets(raw);
        setSnippets(loaded);
        snippetsPayloadBaselineRef.current = JSON.stringify(loaded);
        snippetsLoadedRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 片段写回（防抖；仅实际载荷变化时写，res.ok 后才推进基线）。
  useEffect(() => {
    if (!snippetsLoadedRef.current) return undefined;
    const payload = JSON.stringify(snippets);
    if (payload === snippetsPayloadBaselineRef.current) return undefined;
    const t = setTimeout(() => {
      fetch('/api/store/snippets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      })
        .then((res) => {
          if (res.ok) snippetsPayloadBaselineRef.current = payload;
        })
        .catch((err) => console.warn('保存片段失败', err));
    }, 500);
    return () => clearTimeout(t);
  }, [snippets]);

  // 状态栏「插入目标」跟随光标桥
  useEffect(() => caretBridge.subscribe(setBridgeTarget), []);

  const onSelectionChange = useCallback(({ nodes: selNodes, edges: selEdges }) => {
    setSelCount({ nodes: selNodes.length, edges: selEdges.length });
  }, []);
  useOnSelectionChange({ onChange: onSelectionChange });

  const setGraphName = useCallback((name) => {
    setGraphNameState(name);
    setTabs((ts) => ts.map((t) => (t.id === activeId ? { ...t, name } : t)));
  }, [activeId]);

  const stashActive = useCallback(() => {
    // 未加载的 tab 不能被空画布覆盖缓存（懒加载语义）。
    if (!hydratedRef.current.has(activeId)) return;
    const bound = !!tabsRef.current.find((t) => t.id === activeId)?.system?.system_id;
    storeRef.current[activeId] = {
      ...snapshotOf(nodesRef.current, edgesRef.current, bound),
      tools: toolsRef.current,
      viewport: viewportRef.current || null,
    };
  }, [activeId]);

  // 文本视图只含可见流（无 canvas:false），输出规范化 YAML；持久化仍走全量（见 syncGraphFiles / snapshotOf）。
  const logicText = useMemo(() => serializeTextView(nodes, edges), [nodes, edges]);

  const refreshCounters = useCallback((ns, es) => {
    nodeSeqRef.current = maxSeq(ns.map((n) => n.id), 'n') + 1;
    edgeSeqRef.current = maxSeq(es.map((e) => e.id), 'e') + 1;
  }, []);

  useEffect(() => {
    refreshCounters(nodes, edges);
  }, [nodes, edges, refreshCounters]);

  // v2 收集需写入的正文文件：仅变化项（按内容指纹跳过）；正文空且「非已加载空文件」的节点
  // 绝不写，避免用空串清空既有正文。返回 {files, hashes}；写成功后由调用方 commitContentHashes 提交指纹。
  // configDir = 当前 tab 配置文件所在目录（相对路径契约基准；graphs 惯例传 'graphs'）。
  const collectContentFiles = useCallback((doc, nodes, configDir) => {
    const nodeById = new Map((Array.isArray(nodes) ? nodes : []).map((n) => [String(n.id), n]));
    const files = [];
    const hashes = new Map();
    for (const s of Array.isArray(doc?.streams) ? doc.streams : []) {
      const fp = s?.source?.file_path;
      if (!fp) continue;
      const rootPath = resolveAgainstConfigDir(fp, configDir); // 相对配置目录；绝对原样
      const data = nodeById.get(String(s.id))?.data || {};
      const raw = data.content;
      const hasContent = raw != null && String(raw) !== '';
      const knownEmpty = data.contentState === 'loaded'; // 明确加载过的空文件也算已知
      if (!hasContent && !knownEmpty) continue;          // 未加载/缺失且无内容：绝不写空，避免清空既有正文
      const text = raw == null ? '' : String(raw);
      const h = hashText(text);
      if (contentHashRef.current.get(rootPath) === h) continue;
      files.push({ path: rootPath, text });
      hashes.set(rootPath, h);
    }
    return { files, hashes };
  }, []);

  const commitContentHashes = useCallback((hashes) => {
    for (const [fp, h] of hashes) contentHashRef.current.set(fp, h);
  }, []);

  /** POST /api/document/save：正文文件先行、配置最后（提交点不变量在服务端）。失败抛错。
   *  configPath 可选：外部文档写回路径（绝对/项目根相对）；缺省 = graphs/<净化名>.se.json。 */
  const saveDocumentToServer = useCallback(async ({ name, doc, files, configPath }) => {
    const res = await fetch('/api/document/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        doc,
        files: files || [],
        ...(configPath ? { configPath } : {}),
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data;
  }, []);

  /**
   * config.load 注册通道（D-B / 单边增量）：优先走 snakeeats manifest 加载；非 root（scoped
   * attach，`-32001` / `kind=auth-required`）时返回 `fallback:true`，由调用方回落逐项 applyImport。
   * 返回 `{ok:true, created, skipped, errors, preview}` / `{ok:false, fallback:true}` / `{ok:false, error}`。
   */
  const runConfigLoadRegister = useCallback(async (client, { filePath, dryRun, skipStreams, streamNames }) => {
    if (!client || typeof client.call !== 'function' || !filePath) {
      return { ok: false, fallback: true };
    }
    if (!guardNoActiveScan('加载配置', streamNames)) {
      return { ok: false, error: 'scan-active' };
    }
    // config.load 走 SE 通道（不经 vite resolveUserPath）：相对路径按项目根还原为绝对，保行为不变。
    // 项目根未就绪时，相对 filePath 会被 Python 按 cwd(packageParent) 误解析 → 回退逐项导入。
    await ensureProjectRoot();
    const projectRoot = getProjectRoot();
    if (!projectRoot && !isAbsolutePath(filePath)) {
      notify('项目根未就绪，config.load 已回退为逐项导入', 'warn');
      return { ok: false, fallback: true };
    }
    const params = buildConfigLoadParams(absolutizeDocPath(filePath, projectRoot), { dryRun, skipStreams });
    try {
      const result = await client.call('config.load', params);
      return { ok: true, ...mapConfigLoadResult(result) };
    } catch (err) {
      if ((err && err.data && err.data.kind === 'auth-required') || (err && err.code === -32001)) {
        return { ok: false, fallback: true };
      }
      return { ok: false, error: String((err && err.message) || err) };
    }
  }, [guardNoActiveScan, notify]);

  /**
   * 单边清单统一注册 seam（工具/流"新建 / 导入 / 批量投影"共用）。
   * 内部 = planImport + applyImport（逐项、全字段、非 root）。
   * 本地/离线不进本函数（由调用方沿用逃生舱）。成功不入台账——由调用方 commitTools。
   */
  const registerEntries = useCallback(
    async ({
      systemId,
      manifest,
      contents = new Map(),
      selection,
      strategy = 'overwrite',
      confirmReserved = false,
      onProgress,
      createOnly = false,
    } = {}) => {
      const sid = String(systemId == null ? '' : systemId);
      const client = sePool.get(sid);
      if (!client || client.status !== SE_STATUS.ONLINE) return { ok: false, reason: 'offline' };
      try {
        const [list, tlist] = await Promise.all([
          client.call('stream.list', {}).catch(() => []),
          client.call('tool.list', {}).catch(() => []),
        ]);
        const existingStreams = Array.isArray(list) ? list : [];
        const existingTools = Array.isArray(tlist) ? tlist : Object.values(tlist || {});
        const plan = planImport({ manifest, contents, existingStreams, existingTools, selection });
        const affected = plan.streams
          .filter((row) => row && row.selected && row.state !== 'unchanged')
          .map((row) => String(row.name));
        if (!guardNoActiveScan('写入配置流', affected)) {
          return { ok: false, error: 'scan-active' };
        }
        const summary = await applyImport({
          plan,
          manifest,
          call: (m, p) => client.call(m, p || {}),
          contents,
          baseDir: baseDirForSystem(sid),
          registeredTools: existingTools,
          strategy,
          confirmReserved,
          onProgress,
          createOnly,
          isScanActive: scanActiveForName,
        });
        return { ok: true, summary: summarizeManifestResult(summary) };
      } catch (err) {
        return { ok: false, error: (err && err.message) || String(err) };
      }
    },
    [baseDirForSystem, guardNoActiveScan, scanActiveForName]
  );

  /**
   * 运行时内部流（`_console`/`_scan_log` 等，`isInternal` 判定）**不落盘**（D7）：
   * 仅内存/缓存，显式"固化"才持久化。本地 tab（无 s-* 节点）原样返回。
   */
  const persistableNodes = useCallback((nodes) => {
    const all = Array.isArray(nodes) ? nodes : [];
    const names = all.map((n) => streamNameFromId(n.id)).filter(Boolean);
    if (!names.length) return all;
    const nameSet = new Set(names);
    return all.filter((n) => {
      const nm = streamNameFromId(n.id);
      if (!nm || !isInternal(nm, nameSet)) return true;
      // 内部运行时流默认不落盘（D7）；已显式「固化」（有 source）的保留，避免固化后被再次剔除。
      return !!(n.data && n.data.source && n.data.source.file_path);
    });
  }, []);

  /**
   * 显式「固化」运行时流（D7）：为当前 tab 的内部流（`_console`/`_scan_log` 等）分配内容文件引用，
   * 使其随下次自动保存落盘，并从此进入常规持久化（有 source 即保留）。
   */
  const freezeRuntimeStreams = useCallback(() => {
    const name = String(graphName || '').trim();
    if (!name) {
      notify('请先为标签页命名，再固化运行时流', 'warn');
      return;
    }
    const all = nodesRef.current;
    const nameSet = new Set(all.map((n) => streamNameFromId(n.id)).filter(Boolean));
    const targets = all.filter((n) => {
      const nm = streamNameFromId(n.id);
      return nm && isInternal(nm, nameSet) && !(n.data && n.data.source && n.data.source.file_path);
    });
    if (!targets.length) {
      notify('当前没有可固化的运行时流', 'warn');
      return;
    }
    const srcMap = planDocumentSources(docBaseOf(activeTab) || name, all);
    setNodes((nds) =>
      nds.map((n) => {
        const s = srcMap.get(String(n.id));
        const nm = streamNameFromId(n.id);
        if (s && nm && isInternal(nm, nameSet)) {
          return { ...n, data: { ...n.data, source: { file_path: s.file_path, encoding: s.encoding } } };
        }
        return n;
      })
    );
    notify(`已固化 ${targets.length} 个运行时流，将随下次自动保存落盘`, 'ok');
  }, [graphName, activeTab, notify, setNodes]);

  /** POST /api/fs/move：移动文件/目录（重命名）。源缺失 → moved:false，不抛。 */
  const moveFsPath = useCallback(async (from, to) => {
    const res = await fetch('/api/fs/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error((data && data.error) || `HTTP ${res.status}`);
      err.status = res.status;
      err.code = data && data.code;
      err.data = data;
      throw err;
    }
    return data;
  }, []);

  /** contentHashRef 的键随 tab 重命名迁移（否则会重写全部正文文件）。 */
  const remapContentHashes = useCallback((oldDir, newDir) => {
    const from = String(oldDir || '').replace(/\/+$/, '');
    const to = String(newDir || '').replace(/\/+$/, '');
    if (!from || !to || from === to) return;
    const next = new Map();
    for (const [k, v] of contentHashRef.current) {
      if (k === from) next.set(to, v);
      else if (k.startsWith(`${from}/`)) next.set(`${to}${k.slice(from.length)}`, v);
      else next.set(k, v);
    }
    contentHashRef.current = next;
  }, []);

  /**
   * 保存期 owned-source 对账（唯一文件迁移执行点）。
   *
   * 只移动「当前 tab 的 .streams 目录内的相对镜像」：
   * - 外部绝对路径 / `..` 逃逸 / 其他目录 → 永不移动；
   * - 移动成功后才更新 source + contentHash；
   * - 源缺失但目标已存在 → 采用目标（崩溃/旧版自愈）；
   * - 目标被占用 → 换确定性后缀重试，绝不覆盖。
   *
   * 不在改名事务里直接 move：所有改名入口（在线、离线残留、文本视图、
   * promote、崩溃恢复）都收敛到保存管线这一个执行点。
   */
  const reconcileOwnedSourcesForTab = useCallback(
    async (tab, nodes, configDir) => {
      const list = Array.isArray(nodes) ? nodes : [];
      if (!list.length) return { nodes: list, changed: false, warnings: [] };
      const docBase = docBaseOf(tab);
      const sources = list.map((n) => {
        const src = sourceOf(n);
        return src ? resolveOwnedSourcePath(src.file_path, configDir) : null;
      });
      const next = list.slice();
      const warnings = [];
      let changed = false;
      for (let index = 0; index < list.length; index += 1) {
        const n = list[index];
        const src = sourceOf(n);
        if (!src) continue;
        const others = sources.filter((p, i) => i !== index && p);
        const fromAbs = resolveOwnedSourcePath(src.file_path, configDir);
        // 共享镜像（复制节点/两个节点指向同一文件）不可移动：移动会连带改掉另一个节点。
        // 宁可保留旧文件名并告警，也不做隐式破坏。
        if (
          fromAbs &&
          others.some((p) => String(p).toLowerCase() === String(fromAbs).toLowerCase())
        ) {
          warnings.push(`镜像文件被多个节点共享，未改名：${src.file_path}`);
          continue;
        }
        let applied = false;
        let planned = false;
        let noop = false;
        for (let suffixIndex = 0; suffixIndex < 8 && !applied; suffixIndex += 1) {
          const plan = planOwnedSourceRename({
            sourcePath: src.file_path,
            configDir,
            docBase,
            newName: n.data?.name,
            suffixTag: n.id,
            otherSourcePaths: others,
            suffixIndex,
          });
          if (!plan) break;
          planned = true;
          if (plan.noop) {
            noop = true;
            break;
          }
          try {
            const r = await moveFsPath(plan.fromAbs, plan.toAbs);
            if (r && r.moved === false) {
              if (r.targetExists) {
                // 源已缺失、目标已存在：adopt（崩溃/旧版移动后的自愈）。
                next[index] = {
                  ...n,
                  data: { ...n.data, source: { ...n.data.source, file_path: plan.to } },
                };
                sources[index] = plan.toAbs;
                remapContentHashes(plan.fromAbs, plan.toAbs);
                changed = true;
                applied = true;
              } else {
                warnings.push(`内容文件缺失，暂未改名：${plan.from}`);
              }
              break;
            }
            if (r && r.moved) {
              next[index] = {
                ...n,
                data: { ...n.data, source: { ...n.data.source, file_path: plan.to } },
              };
              sources[index] = plan.toAbs;
              remapContentHashes(plan.fromAbs, plan.toAbs);
              changed = true;
              applied = true;
              break;
            }
            warnings.push(`内容文件未移动：${plan.from}`);
            break;
          } catch (err) {
            if (err && err.status === 409) continue; // 目标被占用：换后缀重试
            warnings.push(`内容文件改名失败：${(err && err.message) || err}`);
            break;
          }
        }
        if (planned && !applied && !noop && !warnings.length) {
          warnings.push(`内容文件目标均被占用，暂未改名：${src.file_path}`);
        }
      }
      return { nodes: next, changed, warnings };
    },
    [moveFsPath, remapContentHashes]
  );

  /** tab 重命名：配置文件 + `.streams/` 目录改名（D11）。源缺失属正常（草稿），静默。 */
  const renamePersistedGraph = useCallback(
    async (oldName, newName) => {
      const oldCfg = `graphs/${documentFileNameOf(oldName)}`;
      const newCfg = `graphs/${documentFileNameOf(newName)}`;
      const oldDir = documentDirOf(oldName);
      const newDir = documentDirOf(newName);
      let configMoved = false;
      try {
        const cfg = await moveFsPath(oldCfg, newCfg);
        configMoved = !!(cfg && cfg.moved);
        if (oldDir && newDir && oldDir !== newDir) {
          const dir = await moveFsPath(oldDir, newDir);
          if (dir && dir.moved === false && dir.targetExists === false) {
            // 草稿没有 .streams 目录：正常。
          }
        }
        return true;
      } catch (err) {
        console.warn(`重命名图谱文件失败「${oldName}」→「${newName}」`, err);
        if (configMoved) {
          try {
            await moveFsPath(newCfg, oldCfg);
          } catch (rollbackErr) {
            console.warn('回滚图谱配置文件名失败', rollbackErr);
          }
        }
        return false;
      }
    },
    [moveFsPath]
  );

  // 统一保存管线（自动/手动/关闭/删除共用）：每个具名 tab → 正文先行 + 配置最后。
  // 写目标 = workDocPathOf(tab)：docPath（显式外部文档）> manifest_path（配置包）>
  // graphs/<名>.se.json（应用内新建）。仅当配置或正文有变化时才发请求。
  const syncGraphFilesImpl = useCallback(
    async (store) => {
      const nextSync = { ...graphSyncRef.current };
      const results = {};
      for (const t of tabsRef.current) {
        const name = String(t.name || '').trim();
        if (!name) continue;
        const g = store[t.id];
        if (!g) continue;
        if (!hydratedRef.current.has(t.id)) {
          results[t.id] = { ok: false, reason: 'unhydrated' };
          continue;
        }
        if (bindInflightRef.current.has(t.id)) {
          results[t.id] = { ok: false, reason: 'bind-inflight' };
          continue;
        }
        const vp = t.id === activeId ? (viewportRef.current || null) : (g.viewport || null);
        // 活动 tab 视口以 ref 为准并回写 store：供后续切换/保存读取新鲜值。
        if (t.id === activeId && vp) {
          storeRef.current[t.id] = { ...(storeRef.current[t.id] || {}), viewport: vp };
        }
        const prev = nextSync[t.id];
        // tab 重命名：只有“纯 graphs 文档”改文件名 + .streams 目录 + source 前缀；
        // 配置包/外部文档改名只改显示名（文件名是包/文档身份）。
        let gNodes = g.nodes;
        const graphsOwned = !t.system?.manifest_path && (!t.docPath || isGraphsDocPath(t.docPath));
        if (prev && prev.name && prev.name !== name && graphsOwned) {
          // 先移动，成功后才 remap source/hash。否则移动失败但 source 已指向新目录，
          // 配置会持久化出“路径不存在”的坏引用（旧目录还在，但新目录没建）。
          const renamed = await renamePersistedGraph(prev.name, name);
          if (!renamed) {
            notify(`重命名图谱文件失败「${prev.name}」→「${name}」，本次保存已跳过`, 'warn');
            results[t.id] = { ok: false, reason: 'rename-failed' };
            continue;
          }
          const oldFsDirRaw = documentDirOf(prev.name);
          const newFsDirRaw = documentDirOf(name);
          // 指纹键与保存侧（absoluteConfigDirOf）同为绝对路径；根未知时回退相对，两侧仍一致。
          const oldFsDir = absolutizeDocPath(oldFsDirRaw, getProjectRoot()) || oldFsDirRaw;
          const newFsDir = absolutizeDocPath(newFsDirRaw, getProjectRoot()) || newFsDirRaw;
          const oldSrcDir = documentStreamsDirName(prev.name); // manifest 同级（用于 source 前缀）
          const newSrcDir = documentStreamsDirName(name);
          if (oldSrcDir && newSrcDir && oldSrcDir !== newSrcDir) {
            gNodes = remapSourcePrefix(gNodes, oldSrcDir, newSrcDir);
            storeRef.current[t.id] = { ...(storeRef.current[t.id] || {}), nodes: gNodes };
            remapContentHashes(oldFsDir, newFsDir);
            if (t.id === activeId) {
              const live = remapSourcePrefix(nodesRef.current, oldSrcDir, newSrcDir);
              nodesRef.current = live;
              setNodes(live);
            }
          }
          // docPath 跟随改名（graphs 惯例）：否则后续保存按旧 docPath 写回，重建旧文件。
          if (t.docPath) {
            const dir = manifestDirOf(String(t.docPath).replace(/\\/g, '/'));
            const nextDocPath = `${dir}/${documentFileNameOf(name)}`.replace(/\\/g, '/');
            t.docPath = nextDocPath;
            setTabs((ts) => ts.map((x) => (x.id === t.id ? { ...x, docPath: nextDocPath } : x)));
          }
        }
        const target = workDocPathOf(t);
        const configDir = absoluteConfigDirOf(target);
        // 唯一 owned-source 文件迁移点：放在 buildDocument / collectContentFiles 之前，
        // 确保 doc、contentHash、正文写入全部使用移动后的路径。
        const reconciled = await reconcileOwnedSourcesForTab(t, gNodes, configDir);
        if (reconciled.changed) {
          gNodes = reconciled.nodes;
          storeRef.current[t.id] = { ...(storeRef.current[t.id] || {}), nodes: gNodes };
          if (t.id === activeId) {
            // gNodes 是 store 快照（无 type / 运行时字段）；活动画布必须只合并 source，
            // 绝不能 setNodes(gNodes)，否则 React Flow 会退化成 default 节点（空壳）。
            const sourceById = new Map(
              reconciled.nodes.map((n) => [String(n.id), n.data && n.data.source])
            );
            const live = nodesRef.current.map((n) => {
              const source = sourceById.get(String(n.id));
              if (!source) return n;
              return { ...n, data: { ...n.data, source } };
            });
            nodesRef.current = live;
            setNodes(live);
          }
        }
        for (const warning of reconciled.warnings) {
          if (sourceWarnRef.current.has(warning)) continue;
          sourceWarnRef.current.add(warning);
          notify(warning, 'warn');
        }
        const persistNodes = persistableNodes(gNodes);
        const doc = buildDocument(
          {
            name,
            docBase: docBaseOf(t),
            nodes: persistNodes,
            edges: g.edges,
            tools: g.tools,
            viewport: vp || undefined,
            baseDir: configDir,
          },
          null
        );
        // G1 保存时回写 source（根修「删除流不连带删除 md」）：doc.streams 的分配结果补回内存态
        // 节点 data.source，删除路径才能拿到 fp。必须在下方去重 continue 与保存失败 catch 之外
        // 每次都跑——undo 回到建流前快照会使 source 再丢失，而 planDocumentSources 确定性会让
        // doc 与 prev.json 相同导致去重跳过，放去重之后 = 永不回灌。
        // 只影响内存态：persistNodes/doc/files 已由 gNodes 算好，本次写盘内容不变（不动 undo 栈）。
        const patched = applyPlannedSources(gNodes, doc);
        if (patched !== gNodes) {
          gNodes = patched;
          storeRef.current[t.id] = { ...(storeRef.current[t.id] || {}), nodes: patched };
        }
        if (t.id === activeId) {
          const live = applyPlannedSources(nodesRef.current, doc);
          if (live !== nodesRef.current) {
            nodesRef.current = live;
            setNodes(live);
          }
        }
        const json = JSON.stringify(doc);
        const { files, hashes } = collectContentFiles(doc, persistNodes, configDir);
        if (!files.length && prev && prev.name === name && prev.json === json) {
          results[t.id] = { ok: true, skipped: true, reason: 'unchanged', savedPath: target || '' };
          continue;
        }
        // B3 写盘空值护栏：上一份成功写盘含流、本次却变空且非用户显式清空 → 跳过写盘，
        // 保留磁盘旧内容（防懒加载失败/异常清空把 graphs/<名>.se.json 覆盖成空）。
        if (shouldSkipEmptyPersist(prev, persistNodes.length, explicitEmptySaveRef.current.has(t.id))) {
          notify(`已阻止空画布覆盖「${name}」（检测到异常清空，数据已保留）；如确需清空请用"重置"`, 'warn');
          results[t.id] = { ok: false, reason: 'empty-guard' };
          continue;
        }
        try {
          const saved = await saveDocumentToServer({ name, doc, files, configPath: target });
          commitContentHashes(hashes);
          explicitEmptySaveRef.current.delete(t.id);
          nextSync[t.id] = { name, json, streamCount: persistNodes.length };
          const savedPath = saved && saved.path
            ? String(saved.path).replace(/\\/g, '/')
            : (target || '');
          // 仅应用内新建（无 docPath / manifest_path）首次保存后落契 docPath；
          // 配置包 tab 的 manifest_path 本身就是目标，不再复制一份。
          if (!target && saved && saved.path) {
            const portablePath = portableDocPath(savedPath, getProjectRoot());
            t.docPath = portablePath;
            setTabs((ts) => ts.map((x) => (x.id === t.id ? { ...x, docPath: portablePath } : x)));
          }
          results[t.id] = { ok: true, savedPath };
        } catch (err) {
          console.warn(`同步图文件失败「${name}」，下次自动保存重试`, err);
          results[t.id] = {
            ok: false,
            reason: 'save-error',
            error: (err && err.message) || String(err),
          };
        }
      }
      graphSyncRef.current = nextSync;
      return { ok: true, results };
    },
    [
      persistableNodes,
      collectContentFiles,
      commitContentHashes,
      saveDocumentToServer,
      remapContentHashes,
      renamePersistedGraph,
      reconcileOwnedSourcesForTab,
      activeId,
      setNodes,
      notify,
    ]
  );

  // Tier-1：syncGraphFiles 的串行化外壳——所有写盘经同一 Promise 链排队，
  // closeTab await 本函数即隐式等待全部在飞保存落定。
  const syncGraphFiles = useCallback(
    (store) => {
      const p = saveChainRef.current.then(
        () => syncGraphFilesImpl(store),
        () => syncGraphFilesImpl(store)
      );
      saveChainRef.current = p.catch(() => {});
      return p;
    },
    [syncGraphFilesImpl]
  );

  /**
   * 工具配置持久化唯一序列：commitTools → stashActive → 串行写盘 → 校验目标 tab。
   * failurePolicy='retain'：保存失败保留已提交配置（新建工具语义：配置可见、SE 不注册）。
   * failurePolicy='rollback'：保存失败调用 revert() 回滚，再经同一串行链写回还原态并校验；
   * revert 必须 null-safe（目标 tab 已关闭时返回 false，绝不抛错）。
   * 返回 { ok, save?, reason?, rolledBack?, corrective? }；corrective = { ok, reason? }。
   */
  const persistToolConfig = useCallback(
    async ({ tabId, apply, failurePolicy = 'retain', revert }) => {
      const saveOnce = async () => {
        try {
          const saved = await syncGraphFiles({ ...storeRef.current });
          const tabSave = saved && saved.results ? saved.results[tabId] : null;
          if (tabSave && tabSave.ok === true) return { ok: true, save: tabSave };
          return {
            ok: false,
            reason: (tabSave && (tabSave.error || tabSave.reason)) || '未确认当前标签页已保存',
          };
        } catch (err) {
          return { ok: false, reason: (err && err.message) || String(err) };
        }
      };
      commitTools(apply);
      stashActive();
      const first = await saveOnce();
      if (first.ok) return { ok: true, save: first.save };
      if (failurePolicy !== 'rollback' || typeof revert !== 'function') {
        return { ok: false, reason: first.reason, rolledBack: false };
      }
      let rolledBack = false;
      try {
        rolledBack = revert() === true;
      } catch (err) {
        console.warn('回滚工具配置失败', err);
      }
      // 回滚提交后立即取消可能在飞的防抖自动保存，再经同一串行链写回还原态：
      // 否则已排队的纳入态自动保存可能在回滚之后才落盘，让回滚变得不持久。
      clearTimeout(saveTimerRef.current);
      const corrective = await saveOnce();
      return { ok: false, reason: first.reason, rolledBack, corrective };
    },
    [commitTools, stashActive, syncGraphFiles]
  );

  // pagehide 兜底（best-effort）：卸载时防抖保存来不及跑，用 keepalive 把有落契文件的 tab
  // 配置最后写一次（正文文件不随行；参数口径镜像 syncGraphFiles，含空画布护栏）。
  useEffect(() => {
    const flushOnPageHide = () => {
      for (const t of tabsRef.current) {
        const name = String(t.name || '').trim();
        const target = workDocPathOf(t);
        if (!name || !target) continue;
        const g = storeRef.current[t.id];
        if (!g) continue;
        const vp = t.id === activeTabIdRef.current ? (viewportRef.current || null) : (g.viewport || null);
        const persistNodes = persistableNodes(g.nodes);
        const doc = buildDocument(
          {
            name,
            docBase: docBaseOf(t),
            nodes: persistNodes,
            edges: g.edges,
            tools: g.tools,
            viewport: vp || undefined,
            baseDir: absoluteConfigDirOf(target),
          },
          null
        );
        const json = JSON.stringify(doc);
        const prev = graphSyncRef.current[t.id];
        if (prev && prev.name === name && prev.json === json) continue;
        if (shouldSkipEmptyPersist(prev, persistNodes.length, explicitEmptySaveRef.current.has(t.id))) continue;
        try {
          fetch('/api/document/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name,
              doc,
              files: [],
              configPath: target,
            }),
            keepalive: true,
          }).catch(() => {});
        } catch (err) {
          /* best-effort：pagehide 阶段失败不再上报 */
        }
      }
    };
    window.addEventListener('pagehide', flushOnPageHide);
    return () => window.removeEventListener('pagehide', flushOnPageHide);
  }, [persistableNodes]);

  // .workspace.json 纯指针：tabs + activeId，不内联 store / 正文。
  const persistWorkspace = useCallback(() => {
    const payload = JSON.stringify({
      workspaceVersion: 2,
      activeId: activeTabIdRef.current,
      tabs: tabsRef.current,
    });
    return fetch('/api/workspace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        workspaceBaselineRef.current = payload;
        try {
          localStorage.setItem(STORAGE_KEY, payload);
        } catch (err) {
          /* 镜像缓存失败不影响本地文件已保存的事实 */
        }
        return true;
      })
      .catch((err) => {
        console.warn('工作区指针保存失败，改用浏览器缓存', err);
        try {
          localStorage.setItem(STORAGE_KEY, payload);
        } catch (err2) {
          console.warn('浏览器缓存也写入失败', err2);
        }
        return false;
      });
  }, []);

  // .workspace.json 纯指针：仅 tabs/activeId 结构变化时防抖写盘；
  // 节点/边/工具变化只走图文档自动保存，绝不触发 /api/workspace。
  useEffect(() => {
    const payload = JSON.stringify({ workspaceVersion: 2, activeId, tabs });
    if (payload === workspaceBaselineRef.current) return undefined;
    const t = setTimeout(() => {
      persistWorkspace();
    }, 500);
    return () => clearTimeout(t);
  }, [tabs, activeId, persistWorkspace]);

  useEffect(() => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      // 懒加载未完成前不保存：否则会用空画布把已有配置覆盖成空。
      if (!hydratedRef.current.has(activeId)) return;
      storeRef.current = {
        ...storeRef.current,
        [activeId]: { ...snapshotOf(nodes, edges, !!activeSystemIdRef.current), tools },
      };
      syncGraphFiles(storeRef.current)
        .then((out) => {
          const r = out && out.results ? out.results[activeId] : null;
          if (!r) return;
          if (r.ok) {
            setStatus(
              r.skipped
                ? '已自动保存（无变化）'
                : `已自动保存到 ${r.savedPath || '本地文件'} ${new Date().toLocaleTimeString('zh-CN')}`
            );
          } else if (r.reason === 'unhydrated' || r.reason === 'bind-inflight') {
            setStatus('自动保存已跳过（当前标签页未就绪）');
          } else {
            setStatus(`自动保存失败：${r.error || r.reason || '未知'}`);
          }
        })
        .catch((err) => {
          console.warn('自动保存失败', err);
          setStatus(`自动保存失败：${(err && err.message) || err}`);
        });
    }, 600);
    return () => clearTimeout(saveTimerRef.current);
  }, [nodes, edges, tools, tabs, activeId, syncGraphFiles]);

  const replaceGraph = useCallback(
    (graph) => {
      const canvas = toCanvasGraph(graph);
      setNodes(canvas.nodes);
      setEdges(canvas.edges);
      // B1：同步 refs（replaceGraph 后紧接的 flush/保存读到陈旧 prev 会误判）。
      nodesRef.current = canvas.nodes;
      edgesRef.current = canvas.edges;
      refreshCounters(canvas.nodes, canvas.edges);
      // 结构投影只换图，绝不触发视口动作；需要移动视口的调用方显式 requestViewport。
    },
    [setNodes, setEdges, refreshCounters]
  );

  const getHistoryStack = useCallback(() => {
    let s = undoRef.current[activeId];
    if (!s) {
      s = { undo: [], redo: [] };
      undoRef.current[activeId] = s;
    }
    return s;
  }, [activeId]);

  // 撤销栈记录类型（§2.2 期 4 核心设计）：
  //   {kind:'graph', snap}  本地图操作（位置/尺寸/本地节点/加载等）
  //   {kind:'se-tags', systemId, label, before, after}  SE tag 结构操作（可见性/fields/期 5 边）
  //   {kind:'se-content', systemId, name, beforeText, beforeVersion, afterText, afterVersion} 内容（D1）
  const pushHistory = useCallback(() => {
    if (undoBusyRef.current) return;
    const stack = getHistoryStack();
    stack.undo.push({ kind: 'graph', snap: snapshotOf(nodesRef.current, edgesRef.current, !!activeSystemIdRef.current) });
    if (stack.undo.length > HISTORY_LIMIT) stack.undo.shift();
    stack.redo = [];
  }, [activeId, getHistoryStack]);

  /** SE tag 结构操作：**成功后** push（after 需操作后才可知）。 */
  const pushSeTagsHistory = useCallback(
    (systemId, label, before, after) => {
      if (undoBusyRef.current) return;
      const stack = getHistoryStack();
      stack.undo.push({ kind: 'se-tags', systemId: String(systemId), label, before, after });
      if (stack.undo.length > HISTORY_LIMIT) stack.undo.shift();
      stack.redo = [];
    },
    [getHistoryStack]
  );

  /** 内容编辑（D1）：**写入成功后** push se-content 记录。 */
  const pushSeContentHistory = useCallback(
    (rec) => {
      if (undoBusyRef.current) return;
      const stack = getHistoryStack();
      stack.undo.push({ kind: 'se-content', ...rec });
      if (stack.undo.length > HISTORY_LIMIT) stack.undo.shift();
      stack.redo = [];
    },
    [getHistoryStack]
  );

  /**
   * 任何撤销/重做后，若当前 tab 绑定在线 → 追加一次全量重投影对账。
   * 这是「本地快照撤销」与「SE 真源」之间唯一的收敛点（R7 / §2.2）。
   */
  const reconcileSeAfterHistory = useCallback(async () => {
    const sid = activeSystemIdRef.current;
    if (!sid || systemOfflineRef.current) return;
    const client = sePool.get(String(sid));
    if (client.status !== SE_STATUS.ONLINE) return;
    await se.reproject(sid);
  }, []);

  // ---------------------------------------------------------------------------
  // 编辑层骨架（阶段 5）：节点内容就地编辑会话
  // ---------------------------------------------------------------------------

  // 内容回写通道：不 trim、不 pushHistory —— 保 markdown 逐字节保真；
  // 整段编辑在 enterEdit 时只 pushHistory 一次，作为一步撤销（§9 红线）。
  const applyEditContent = useCallback(
    (id, text) => {
      const md = text == null ? '' : String(text);
      let changed = false;
      const next = nodesRef.current.map((n) => {
        if (n.id !== id) return n;
        const prev = n.data?.content != null ? String(n.data.content) : '';
        if (prev === md) return n;
        changed = true;
        const data = { ...n.data };
        if (md) data.content = md;
        else delete data.content;
        return { ...n, data };
      });
      if (!changed) return;
      nodesRef.current = next;
      setNodes(next);
    },
    [setNodes]
  );

  // 退出编辑：默认提交（强制 flush 未保存内容）→ 清会话（编辑器随 AgentNode 卸载销毁）。
  const exitEdit = useCallback((commit = true) => {
    const id = editingIdRef.current;
    if (!id) return false;
    if (commit) {
      try {
        editorApiRef.current?.flush?.();
      } catch (err) {
        console.warn('强制回写编辑内容失败', err);
      }
    }
    editorApiRef.current = null;
    editingIdRef.current = null;
    setEditingNodeId(null);
    // 期 3：已绑定流退出编辑 → 提交内容到 SE（CAS，冲突走对话框）。
    // 编辑期间收到外部写（stale）：本地有改动 → 用编辑前 version 提交（CAS 冲突可感知）；
    // 本地无改动 → 直接重读采用服务端最新，不弹窗。
    if (commit && streamNameFromId(id)) {
      const name = streamNameFromId(id);
      const sid = activeSystemIdRef.current;
      const stale = se.staleHas(sid, name);
      se.staleDelete(sid, name);
      const node = nodesRef.current.find((n) => String(n.id) === id);
      const localText = node && node.data && node.data.content != null ? String(node.data.content) : '';
      const synced = se.baselineGet(sid, name);
      if (stale && synced && synced.text === localText) {
        se.readContent(id);
      } else {
        // 写入成功后才 push se-content（after 需写入结果）。
        const beforeText = synced && synced.text != null ? String(synced.text) : '';
        const beforeVersion = synced ? synced.version : undefined;
        const commitPromise = commitStreamContent(id).then((res) => {
          if (!res || !res.ok || !sid) return;
          pushSeContentHistory({
            systemId: String(sid),
            name,
            beforeText,
            beforeVersion,
            afterText: String(res.text == null ? '' : res.text),
            afterVersion: res.version,
          });
        });
        // closeTab 杀 SE 前需 await 本句柄（否则最后一笔编辑在途丢失）。
        exitCommitRef.current = commitPromise;
        commitPromise.finally(() => {
          if (exitCommitRef.current === commitPromise) exitCommitRef.current = null;
        });
      }
    }
    return true;
  }, [commitStreamContent, pushSeContentHistory]);

  // 进入节点内容就地编辑（全局单实例）：先退出旧会话、再提交焦点中的 name/field inline 编辑。
  const enterEdit = useCallback(
    (id) => {
      if (editingIdRef.current === id) return;
      if (editingIdRef.current) exitEdit(true);
      const ae = document.activeElement;
      if (
        ae &&
        (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') &&
        typeof ae.blur === 'function'
      ) {
        ae.blur();
      }
      const node = nodesRef.current.find((n) => n.id === id);
      if (!node) return;
      // 编辑门控（2026-10-25）：扫描执行中 / 暂停未 settle 时禁止进入编辑，
      // 避免“工具还在跑时改内容”与扫描读快照竞态。paused / idle 允许编辑。
      const scan = node.data?.scan;
      if (scan && (scan.state === 'scanning' || scan.pausePhase === 'pausing')) {
        notify('扫描执行中；请先暂停并等待当前工具结束', 'warn');
        setStatus('扫描执行中，已拒绝进入编辑');
        return;
      }
      // D1（SE 原生内容撤销，用户拍板）：绑定在线流不再压整图快照；内容记录在
      // exitEdit 写入成功后以 se-content 入栈。未绑定/离线保持本地整图快照（逃生舱）。
      const name = streamNameFromId(id);
      const sid = activeSystemIdRef.current;
      const boundOnline =
        !!name &&
        !!sid &&
        !systemOfflineRef.current &&
        sePool.get(String(sid)).status === SE_STATUS.ONLINE;
      if (!boundOnline) pushHistory(); // 整段编辑作为一步撤销
      editingIdRef.current = id;
      setEditingNodeId(id);
      setStatus(`已进入就地编辑：节点「${node.data?.name || ''}」（Esc / ✓完成 退出）`);
    },
    [exitEdit, pushHistory, notify]
  );

  /**
   * 撤销一条 se-content 记录：走 SE 原生 `stream.undo`（非幂等，绝不自动重试）。
   * @returns {Promise<boolean>} true = SE 内容确已回退（记录可移入 redo 栈）。
   */
  const undoSeContent = useCallback(
    async (rec) => {
      const client = sePool.get(String(rec.systemId));
      let ok = true;
      try {
        await client.call('stream.undo', { name: rec.name, n: 1 });
      } catch (err) {
        ok = false;
        // -32005（undo 窗口超限 / 链空）等：提示后一律重读，绝不让本地与 SE 静默分叉。
        notify(`内容撤销失败：${(err && err.message) || err}`, 'warn');
      }
      await se.readContent(streamNodeId(rec.name), rec.systemId);
      if (ok) {
        const cur = se.baselineGet(rec.systemId, rec.name);
        const text = cur && cur.text != null ? String(cur.text) : '';
        if (text !== String(rec.beforeText == null ? '' : rec.beforeText)) {
          notify('内容撤销结果与预期不一致，已按服务端内容刷新', 'warn');
        }
      }
      return ok;
    },
    [notify]
  );

  /**
   * 重做一条 se-content 记录：优先 `stream.write{afterText, expected_version}`（确定性）。
   * 非局部整篇写：保留 stream.write，提交后需一次显式 rescan。
   * @returns {Promise<boolean>} true = 写入成功（记录可移入 undo 栈）。
   */
  const redoSeContent = useCallback(
    async (rec) => {
      const client = sePool.get(String(rec.systemId));
      const expected = se.versionGet(rec.systemId, rec.name);
      let ok = true;
      try {
        const params = { name: rec.name, text: rec.afterText };
        if (expected !== undefined) params.expected_version = expected;
        const res = await client.call('stream.write', params);
        const version = res && res.version != null ? Number(res.version) : expected;
        se.baselineSet(rec.systemId, rec.name, version, rec.afterText);
      } catch (err) {
        ok = false;
        notify(`内容重做失败：${(err && err.message) || err}`, 'warn');
      }
      await se.readContent(streamNodeId(rec.name), rec.systemId);
      return ok;
    },
    [notify]
  );

  const undo = useCallback(async () => {
    if (undoBusyRef.current) return; // B5：撤销/重做不可重入
    const stack = getHistoryStack();
    if (stack.undo.length === 0) {
      setStatus('没有可撤销的操作');
      return;
    }
    const rec = stack.undo[stack.undo.length - 1];
    if ((rec.kind === 'se-tags' || rec.kind === 'se-content') &&
      sePool.get(String(rec.systemId)).status !== SE_STATUS.ONLINE) {
      notify('系统离线，无法撤销该操作', 'warn');
      setStatus('系统离线，撤销已挂起');
      return;
    }
    if (rec.kind === 'se-content') {
      const targetNode = nodesRef.current.find((n) => String(n.id) === streamNodeId(rec.name));
      if (SCAN_ACTIVE_STATES.includes(targetNode?.data?.scan?.state)) {
        notify('扫描活动期间不支持撤销；请先停止扫描或显式 rescan', 'warn');
        setStatus('扫描活动期间撤销已拒绝');
        return;
      }
    }
    undoBusyRef.current = true;
    stack.undo.pop();
    let ok = true;
    try {
      if (rec.kind === 'se-tags') {
        const client = sePool.get(String(rec.systemId));
        const summary = await applyTagSnapshot(client, rec.before);
        const failed = summary.filter((s) => s.error && s.error !== 'missing');
        if (failed.length) {
          // B4：SE 未完全还原 → 记录留在原栈可重试，绝不谎报成功。
          notify(`标签还原失败：${failed.map((s) => s.name).join('、')}`, 'warn');
          stack.undo.push(rec);
          ok = false;
        } else {
          stack.redo.push(rec);
        }
      } else if (rec.kind === 'se-content') {
        ok = await undoSeContent(rec);
        if (ok) stack.redo.push(rec);
        else stack.undo.push(rec); // B4：SE 未回退 → 留原栈可重试
      } else {
        stack.redo.push({ kind: 'graph', snap: snapshotOf(nodesRef.current, edgesRef.current, !!activeSystemIdRef.current) });
        replaceGraph(rec.snap);
      }
    } finally {
      await reconcileSeAfterHistory();
      undoBusyRef.current = false;
    }
    setStatus(ok ? '已撤销' : '撤销未生效');
  }, [getHistoryStack, replaceGraph, notify, reconcileSeAfterHistory, undoSeContent]);

  const redo = useCallback(async () => {
    if (undoBusyRef.current) return; // B5：撤销/重做不可重入
    const stack = getHistoryStack();
    if (stack.redo.length === 0) {
      setStatus('没有可重做的操作');
      return;
    }
    const rec = stack.redo[stack.redo.length - 1];
    if ((rec.kind === 'se-tags' || rec.kind === 'se-content') &&
      sePool.get(String(rec.systemId)).status !== SE_STATUS.ONLINE) {
      notify('系统离线，无法重做该操作', 'warn');
      setStatus('系统离线，重做已挂起');
      return;
    }
    undoBusyRef.current = true;
    stack.redo.pop();
    let ok = true;
    try {
      if (rec.kind === 'se-tags') {
        const client = sePool.get(String(rec.systemId));
        const summary = await applyTagSnapshot(client, rec.after);
        const failed = summary.filter((s) => s.error && s.error !== 'missing');
        if (failed.length) {
          // B4：SE 未完全应用 → 记录留原栈可重试。
          notify(`标签重做失败：${failed.map((s) => s.name).join('、')}`, 'warn');
          stack.redo.push(rec);
          ok = false;
        } else {
          stack.undo.push(rec);
        }
      } else if (rec.kind === 'se-content') {
        ok = await redoSeContent(rec);
        if (ok) stack.undo.push(rec);
        else stack.redo.push(rec); // B4：SE 未写入 → 留原栈可重试
      } else {
        stack.undo.push({ kind: 'graph', snap: snapshotOf(nodesRef.current, edgesRef.current, !!activeSystemIdRef.current) });
        replaceGraph(rec.snap);
      }
    } finally {
      await reconcileSeAfterHistory();
      undoBusyRef.current = false;
    }
    setStatus(ok ? '已重做' : '重做未生效');
  }, [getHistoryStack, replaceGraph, notify, reconcileSeAfterHistory, redoSeContent]);

  const loadFromParsed = useCallback(
    (parsed, okPrefix) => {
      try {
        const { graph, warnings } = fromLogicGraph(parsed);
        pushHistory();
        replaceGraph(graph);
        requestViewport('fit');
        let msg = okPrefix;
        if (warnings.length) msg += `；${warnings.join('；')}`;
        setStatus(msg);
        return true;
      } catch (err) {
        setStatus(`加载失败：${(err && err.message) || err}`);
        return false;
      }
    },
    [pushHistory, replaceGraph, requestViewport]
  );

  const refreshHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/history');
      if (!res.ok) return;
      setHistory(await res.json());
    } catch (err) {
      console.warn('刷新历史失败', err);
      setHistory([]);
    }
  }, []);

  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

  const switchTab = useCallback(
    (id) => {
      if (id === activeId) return;
      const tab = tabs.find((t) => t.id === id);
      if (!tab) return;
      exitEdit(true);
      stashActive();
      const g = storeRef.current[id] ?? { nodes: [], edges: [] };
      const canvas = toCanvasGraph(g);
      setActiveId(id);
      setNodes(canvas.nodes);
      setEdges(canvas.edges);
      // B1：切 tab 同步 refs，避免切换瞬间的保存/校验读到上一 tab 的陈旧 prev。
      nodesRef.current = canvas.nodes;
      edgesRef.current = canvas.edges;
      commitTools(g.tools || {});
      setGraphNameState(tab.name);
      requestViewport(g && g.viewport ? 'restore' : 'fit', g && g.viewport ? g.viewport : null);
      setStatus(`已切换到「${tab.name || '未命名图'}」`);
      // 已绑定 tab：懒连接（effect 也会兜底，这里显式触发以对齐 §5.1）。
      if (tab.system?.system_id) se.connectSystem(tab.system.system_id);
    },
    [activeId, tabs, stashActive, commitTools, setNodes, setEdges, exitEdit, requestViewport]
  );

  // ＋新建：弹对话框（从配置包创建 / 连接或启动系统）。
  const addTab = useCallback(() => {
    setNewTabOpen(true);
  }, []);

  const closeTab = useCallback(
    async (id) => {
      if (closingTabIdsRef.current.has(id)) return;
      const tab = tabs.find((t) => t.id === id);
      if (!tab) return;
      const remaining = tabs.filter((t) => t.id !== id);
      // 关 tab = 关对应 SE：仅当没有其它标签页仍绑定同一 system_id 时才释放/终止，
      // 防手改工作区等异常情况下误关仍被其它 tab 引用的 SE。
      const sid = tab.system?.system_id;
      const stillOwned = !!sid && remaining.some((t) => t.system?.system_id && sameSystemId(t.system.system_id, sid));
      const label = tab.name || '未命名图';
      const confirmMsg =
        sid && !stillOwned
          ? `关闭「${label}」？将同时停止对应的 SE 系统，未保存到文件的修改将丢失`
          : `关闭「${label}」？未保存到文件的修改将丢失`;
      if (!window.confirm(confirmMsg)) return;
      closingTabIdsRef.current.add(id);
      setClosingTabIds(new Set(closingTabIdsRef.current));
      try {
        exitEdit(true);
        // Tier-1：等最后一笔编辑的 SE 写落定再落盘/停机（否则关闭杀 SE 时该写在途丢失）。
        if (exitCommitRef.current) {
          try {
            await exitCommitRef.current;
          } catch (err) {
            /* commitContent 内部已兜底 */
          }
        }
        // 关闭前落盘（删除/编辑耐久化）：防抖自动保存有 600ms 窗口，「删除后立刻关闭」会让
        // .se.json 停在旧版本（重开同一配置包时已删流复活）。先把当前画布快照同步到磁盘——
        // fire-and-forget：写盘由 vite 侧完成，不依赖即将终止的 SE 进程。
        stashActive();
        await syncGraphFiles({ ...storeRef.current });
        if (sid && !stillOwned) {
          const endResult = await se.closeSystem(sid);
          if (!endResult || endResult.ok !== true) return;
        }
        const latestTabs = tabsRef.current;
        if (!latestTabs.some((t) => t.id === id)) return;
        const nextTabs = latestTabs.filter((t) => t.id !== id);
        delete storeRef.current[id];
        delete graphSyncRef.current[id];
        if (sid && !stillOwned) delete layoutRef.current[String(sid)];
        delete undoRef.current[id];
        hydratedRef.current.delete(id);
        if (nextTabs.length === 0) {
          const nid = genTabId();
          const taken = new Set(
            nextTabs.filter((t) => t.system?.system_id).map((t) => t.system.system_id)
          );
          const replacement = assignTabSystem({ id: nid, name: '' }, taken);
          storeRef.current[nid] = { nodes: [], edges: [], tools: {} };
          hydratedRef.current.add(nid);
          tabsRef.current = [replacement];
          activeTabIdRef.current = nid;
          setTabs([replacement]);
          setActiveId(nid);
          setNodes([]);
          setEdges([]);
          nodesRef.current = [];
          edgesRef.current = [];
          commitTools(storeRef.current[nid].tools || {});
          setGraphNameState('');
        } else if (id === activeTabIdRef.current) {
          const idx = latestTabs.findIndex((t) => t.id === id);
          const next = nextTabs[Math.min(idx, nextTabs.length - 1)];
          tabsRef.current = nextTabs;
          activeTabIdRef.current = next.id;
          setTabs(nextTabs);
          setActiveId(next.id);
          const g = storeRef.current[next.id] ?? { nodes: [], edges: [] };
          const canvas = toCanvasGraph(g);
          setNodes(canvas.nodes);
          setEdges(canvas.edges);
          nodesRef.current = canvas.nodes;
          edgesRef.current = canvas.edges;
          commitTools(g.tools || {});
          setGraphNameState(next.name);
          requestViewport(g && g.viewport ? 'restore' : 'fit', g && g.viewport ? g.viewport : null);
        } else {
          tabsRef.current = nextTabs;
          setTabs(nextTabs);
        }
        // 关闭已确认成功：仅清该 tab 的页码/历史页/折叠态。按 scope 前缀删除，
        // 绝不按裸 nodeId 删（同名 SE 流可能仍被其它标签页渲染）。取消/失败路径不会走到这里。
        clearPageScope(id);
        clearFoldScope(id);
      } catch (err) {
        notify(`关闭「${label}」失败：${(err && err.message) || err}`, 'warn');
      } finally {
        closingTabIdsRef.current.delete(id);
        setClosingTabIds(new Set(closingTabIdsRef.current));
      }
    },
    [tabs, commitTools, setNodes, setEdges, exitEdit, stashActive, syncGraphFiles, requestViewport, notify]
  );

  /** 绑定一个 SE 系统为新标签页（同 system_id / 同工作文档查重前置，§5.1）。 */
  const bindSystem = useCallback(
    async ({ systemId, displayName, manifestPath, storageDir, importPackage, requireConnected = false }) => {
      const id = String(systemId);
      const epoch = se.epochOf(id);
      const owner = se.findSystemOwner(id);
      if (owner) {
        notify(`该系统已被标签页「${owner.name || '未命名图'}」绑定`, 'warn');
        return { ok: false, error: 'duplicate' };
      }
      const docTarget = manifestPath
        ? portableDocPath(manifestPath, getProjectRoot(), { repairGraphsResidue: false })
        : null;
      if (docTarget) {
        const docOwner = findDocOwner(tabsRef.current, docTarget);
        if (docOwner) {
          if (docOwner.id !== activeId) switchTab(docOwner.id);
          notify(`该配置包已在标签页「${docOwner.name || '未命名图'}」中打开，已切换`, 'info');
          return { ok: false, error: 'duplicate-doc' };
        }
      }
      const tabId = genTabId();
      const name = displayName || id;
      const system = {
        system_id: id,
        display_name: name,
        manifest_path: docTarget,
        storage_dir: storageDir || `se-systems/${id}`,
      };
      exitEdit(true);
      stashActive();
      storeRef.current[tabId] = { nodes: [], edges: [], tools: {} };
      hydratedRef.current.add(tabId);
      bindInflightRef.current.add(tabId); // Tier-1：导入/首投影完成前禁止该 tab 写盘
      const prevActiveId = activeId;
      setTabs((ts) => [...ts, { id: tabId, name, system }]);
      setActiveId(tabId);
      setNodes([]);
      setEdges([]);
      nodesRef.current = [];
      edgesRef.current = [];
      commitTools(storeRef.current[tabId].tools || {});
      setGraphNameState(name);
      requestViewport('fit');
      try {
      // 包内布局先喂常驻表：连接握手/导入/重投影全程可用（新流按记录落点，重启后仍复用）。
      if (importPackage && importPackage.manifest) {
        const pkgLayout = readManifestLayout(importPackage.manifest);
        if (importPackage.restoreLayout && pkgLayout) {
          layoutRef.current[id] = pkgLayout;
        }
        // Tier-1（RC4 可见性）：无布局的包不再静默堆叠——明确告知，且说明排布的保存去处。
        if (!pkgLayout || !Object.keys(pkgLayout).length) {
          notify('该配置包无布局信息，节点将按默认网格排布；拖拽排布后会随工作文档自动保存', 'info');
        }
      }
      const conn = await se.connectSystem(id, { skipRefill: !!importPackage });
      // 连接握手期间 tab 可能已关闭：静默放弃（不向已关闭的 tab notify）。
      if (!se.epochAlive(id, epoch)) return { ok: false, error: 'closed' };
      if (!conn.ok) {
        if (requireConnected) {
          // create 流程：连接失败必须回滚 tab，否则自愈 effect 会把无主新系统再拉起。
          notify(`新系统「${name}」连接失败：${conn.error || '未知'}`, 'warn');
          setTabs((ts) => ts.filter((t) => t.id !== tabId));
          delete storeRef.current[tabId];
          delete layoutRef.current[String(id)];
          hydratedRef.current.delete(tabId);
          setActiveId((cur) => (cur === tabId ? prevActiveId : cur));
          return { ok: false, connected: false, error: conn.error || 'connect failed', tabId };
        }
        notify(`已绑定「${name}」，但连接失败：${conn.error}`, 'warn');
        return { ok: true, connected: false };
      }
      let toolsRegistered = 0;
      let importedTools = {};
      let importedWrittenNames = new Set();
      if (importPackage && importPackage.manifest) {
        try {
          const client = sePool.get(id);
          // reconcile 修复（关标签页重开丢数据/复活/正文丢失）：
          // 挑包时 client=null，planInputs.existingStreams 恒为空 → 存储残留流被误分类 new，
          // stream.create 撞 already-exists 后正文被跳过。此处以刚连接 SE 的实况重建计划：
          // 残留流分类为 update → 正文经 stream.write 以包为真源写入。
          let liveStreams = null;
          let liveTools = null;
          const liveVersions = new Map();
          // 实况正文读取失败的流名：内容「未知」≠「已变更」。计划若按 update
          // 处理会以刚读到的当前版本做 CAS 写入（CAS 挡不住——版本就是最新的），
          // 一次瞬时读失败就会用包内旧正文覆盖 SE 实存内容。
          const unknownContent = new Set();
          // Promise.allSettled：tool.list 失败不得连带丢弃 stream.list 的结果
          //（否则存量清单未知 → 计划把已存在流误判 new → already-exists 回退
          //  无保护地写入包内正文）。
          const [lsRes, ltRes] = await Promise.allSettled([
            client.call('stream.list', {}),
            client.call('tool.list', {}),
          ]);
          if (lsRes.status === 'fulfilled') liveStreams = lsRes.value;
          else console.warn('读取 SE 流清单失败', lsRes.reason);
          if (ltRes.status === 'fulfilled') liveTools = ltRes.value;
          else console.warn('读取 SE 工具清单失败', ltRes.reason);
          if (!Array.isArray(liveStreams)) {
            // 存量清单未知时中止导入：否则 planImport 会把已存在流判为 new，
            // 走 already-exists 回退用包内正文覆盖实存内容（数据丢失）。
            throw new Error('读取 SE 实况失败，已中止导入以避免覆盖现有内容；请稍后重试');
          }
          const liveInputs = { ...(importPackage.planInputs || {}) };
          if (Array.isArray(liveTools)) liveInputs.existingTools = liveTools;
          if (Array.isArray(liveStreams)) {
            liveInputs.existingStreams = liveStreams;
            // Tier-1（P0-1 根治）：挑包时 client=null → planInputs.existingContents 为空 Map，
            // 会把全部已存在流误判 contentChanged=true 并无 CAS 覆盖写（陈旧包清空 SE 新内容）。
            // 此处以实况正文+版本重建：内容一致 → unchanged 不写；不一致 → CAS 写；
            // 包内空正文 → protectNonempty 跳过（绝不把 SE 非空内容清空）。
            const liveContents = new Map();
            await Promise.all(
              liveStreams.map(async (s) => {
                const n = String((s && s.name) || '');
                if (!n) return;
                if (s && s.version != null) liveVersions.set(n, Number(s.version));
                try {
                  const r = await client.call('stream.read', { name: n });
                  // 与 orchestrator readContent 同口径：缺 text 字段的畸形回包 =
                  // 读取失败（不是「确认空」）——否则仍会用包内旧正文覆盖实存内容。
                  if (
                    !r ||
                    typeof r !== 'object' ||
                    !Object.prototype.hasOwnProperty.call(r, 'text')
                  ) {
                    unknownContent.add(n);
                    return;
                  }
                  liveContents.set(n, r.text != null ? String(r.text) : '');
                } catch (err) {
                  // 读取失败：内容保持未知——后续从导入计划中剔除正文写入。
                  unknownContent.add(n);
                }
              })
            );
            liveInputs.existingContents = liveContents;
          }
          const callImport = () => {
            const plan = planImport({
              ...liveInputs,
              manifest: importPackage.manifest,
              selection: importPackage.selection,
            });
            // Tier-1 加固：实况正文未知的流绝不覆盖写（读取瞬时失败 ≠ 内容变化）。
            if (Array.isArray(plan.streams)) {
              for (const row of plan.streams) {
                if (row && unknownContent.has(String(row.name))) row.contentChanged = false;
              }
            }
            const affected = plan.streams
              .filter((row) => row && row.selected && row.state !== 'unchanged')
              .map((row) => String(row.name));
            if (!guardNoActiveScan('导入配置包', affected)) {
              throw new Error('扫描活动期间已阻止导入；请先停止扫描或显式 rescan');
            }
            return applyImport({
              plan,
              manifest: importPackage.manifest,
              call: (m, p) => client.call(m, p || {}),
              contents: importPackage.contents,
              baseDir: manifestAbsDirOf(manifestPath),
              registeredTools: liveInputs.existingTools,
              strategy: importPackage.strategy === 'config-load' ? 'overwrite' : (importPackage.strategy || 'overwrite'),
              confirmReserved: true,
              casVersions: liveVersions,
              protectNonempty: true,
              isScanActive: scanActiveForName,
            });
          };
          let summary;
          if (importPackage.strategy === 'config-load' && manifestPath) {
            const allNames = (importPackage.manifest.streams || []).map((s) => String(s?.name || '')).filter(Boolean);
            const sel = new Set((importPackage.selection?.streamNames || []).map(String));
            const skipStreams = allNames.filter((n) => !sel.has(n));
            const reg = await runConfigLoadRegister(client, {
              filePath: manifestPath,
              skipStreams,
              streamNames: sel.size ? allNames.filter((n) => sel.has(n)) : allNames,
            });
            if (reg.ok) {
              summary = {
                streams: { created: reg.created.length, updated: 0, skipped: reg.skipped.length, unchanged: 0, failed: 0 },
                tools: { registered: 0, updated: 0, skipped: 0, failed: 0 },
                errors: (reg.errors || []).map((e) => (e && (e.message || e.reason || e.entity)) || String(e)),
                warnings: (reg.preview && reg.preview.warnings) || [],
              };
            } else {
              summary = await callImport();
            }
          } else {
            summary = await callImport();
          }
          toolsRegistered = (summary.tools && summary.tools.registered) || 0;
          importedWrittenNames = new Set(
            Object.keys((summary.streams && summary.streams.versions) || {})
          );
          const importConflicts = Array.isArray(summary.streams && summary.streams.conflicts)
            ? summary.streams.conflicts
            : [];
          if (importConflicts.length) {
            notify(
              `配置包导入：${importConflicts.length} 个流初始化未确认，已以 SE 读回为准`,
              'warn'
            );
          }
          // 配置=唯一台账（需求1）：包内工具同步登记进本 tab 配置，列表才能从配置渲染。
          importedTools = normalizeTools(importPackage.manifest.tools || {});
          if (Object.keys(importedTools).length) {
            commitTools((prev) => ({ ...prev, ...importedTools }));
          }
          const errCount = summary.errors.length;
          notify(
            `已导入配置包：${summary.streams.created} 流 / ${summary.tools.registered} 工具${
              errCount ? `（${errCount} 项失败）` : ''
            }`,
            errCount ? 'warn' : 'ok'
          );
          // 包外残留流**不再自动删除**：导入/绑定不是删除意图，自动按“选区补集”删流
          // 会误删未选中的运行期流（且刷新后靠文档回推才恢复）。删除只由显式删除
          // 按钮/tombstone 承担；这里仅提示，交由用户处理。
          if (Array.isArray(liveStreams) && liveStreams.length) {
            const keep = new Set(
              (importPackage.selection?.streamNames ||
                (importPackage.manifest.streams || []).map((s) => s && s.name)
              ).map(String)
            );
            const residuals = liveStreams
              .map((s) => String((s && s.name) || ''))
              .filter((n) => n && !keep.has(n) && !isInternalStream(n));
            if (residuals.length) {
              notify(
                `检测到 ${residuals.length} 个包外流（未删除）：${residuals.slice(0, 5).join('、')}${
                  residuals.length > 5 ? '…' : ''
                }`,
                'info'
              );
            }
          }
        } catch (err) {
          notify(`配置包导入失败：${(err && err.message) || err}`, 'warn');
        }
      }
      // 竞态修复：显式导入已结束；仅当**配置无工具**时兜底回灌（配置有工具则投影已覆盖，避免双真源）。
      if (
        importPackage &&
        importPackage.manifestPath &&
        toolsRegistered === 0 &&
        Object.keys(importedTools).length === 0
      ) {
        silentRefillFromManifest((m, p) => sePool.get(id).call(m, p || {}), importPackage.manifestPath).catch(() => {});
      }
      // 连接成功：订阅 stream.on_change + 全量重投影（配置包导入后执行以纳入新流）。
      await se.onConnected(id);
      // 原地绑定：manifest 的真实 source 灌回投影节点，并把本次实际写入的正文播种到内存，
      // 使首次保存直接写回包内 md（不再按 graphs 惯例另建副本）。
      if (importPackage && importPackage.manifest) {
        const sources = collectManifestSources(importPackage.manifest);
        const contents = importPackage.contents;
        const written = importedWrittenNames;
        if (sources.size || (contents && written.size)) {
        // 正文指纹键与保存侧 collectContentFiles 同为绝对目录；相对基准会让冷启动 hash 永远不命中。
        const cfgDir = absoluteConfigDirOf(docTarget);
        setNodes((nds) => {
            let next = applyImportedSources(nds, sources);
            if (contents && written.size) {
              next = next.map((n) => {
                const nm = String(n.data?.name || '');
                if (!written.has(nm) || n.data?.contentState === 'loaded') return n;
                if (!contents.has(nm)) return n;
                return {
                  ...n,
                  data: { ...n.data, content: contents.get(nm), contentState: 'loaded' },
                };
              });
            }
            if (next !== nds) {
              nodesRef.current = next;
              storeRef.current[tabId] = { ...(storeRef.current[tabId] || {}), nodes: next };
              if (contents) {
                for (const [nm, src] of sources) {
                  if (!written.has(nm) || !contents.has(nm)) continue;
                  const abs = resolveAgainstConfigDir(src.file_path, cfgDir);
                  contentHashRef.current.set(abs, hashText(contents.get(nm)));
                }
              }
            }
            return next;
          });
        }
      }
      if (docTarget && !isGraphsDocPath(docTarget)) {
        loadConfigRegistry()
          .then((es) => saveConfigRegistry(registerEntry(es, docTarget, getProjectRoot())))
          .catch(() => {});
      }
      notify(`已绑定系统「${name}」`, 'ok');
      return { ok: true, connected: true };
      } finally {
        bindInflightRef.current.delete(tabId);
      }
    },
    [
      exitEdit,
      stashActive,
      setNodes,
      setEdges,
      setGraphNameState,
      commitTools,
      notify,
      runConfigLoadRegister,
      guardNoActiveScan,
      scanActiveForName,
      switchTab,
      requestViewport,
    ]
  );

  // 切到已绑定 tab / 启动恢复：探活 + 按偏好 attach-or-spawn + 订阅/重投影。
  useEffect(() => {
    // R2：切换 tab/系统即清除上一系统的悬空边状态（含切到无绑定本地 tab），防陈旧横幅。
    setSeDangling([]);
    if (!activeSystemId) {
      // 未绑定：工具面板为本地逃生舱，全能力可用。
      setCanManageTools(true);
      return;
    }
    // 切到绑定系统：先乐观置可用，root 探测回来再收敛（非 root → 禁用 ＋/🗑）。
    setCanManageTools(true);
    sePool.probe(activeSystemId);
    // UI 偏好异步加载：就绪后再决策是否自动拉起，避免默认值抢先 spawn（用户可能已关）。
    if (!uiReady) return;
    const allowSpawn = !preflightUnavailable;
    se.ensureSystem(activeSystemId, { allowSpawn }).then((res) => {
      if (res && res.ok) {
        if (activeSystemIdRef.current === activeSystemId) se.onConnected(activeSystemId);
        return;
      }
      // preflight 不可用时关闭 spawn，不因"连不上"逐系统报错（统一由横幅提示）。
      // D/E：失败（含 owned-by-other-vite / port-unverifiable）给诚实文案，不再弹 token。
      if (allowSpawn && res && res.status !== 'locked' && res.error) {
        notify(`自动启动系统失败：${seErrorMessage(res)}`, 'warn');
      }
    });
    // 活动系统或「是否自动拉起」变化时触发；ensureSystem 引用稳定，无需入依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSystemId, uiReady, preflightUnavailable]);

  // 启动 / 绑定集合变化：为「每个已绑定标签页」都 attach-or-spawn（存活残留由 Node 侧回收重拉，
  // 失败给诚实错误，不再弹 token），不限于当前激活，确保每个 tab 都有自己在线的新 SE。有界并发（2）；
  // 活动 tab 的系统优先，其余按 boundSystemKey 顺序。同 id 并发由 ensureInflightRef 去重。
  useEffect(() => {
    if (!uiReady) return;
    const ids = boundSystemKey ? boundSystemKey.split('|') : [];
    if (!ids.length) return;
    const allowSpawn = !preflightUnavailable;
    const active = activeSystemIdRef.current ? String(activeSystemIdRef.current) : '';
    const ordered = [...ids.filter((id) => id === active), ...ids.filter((id) => id !== active)];
    const runOne = (id) =>
      se.ensureSystem(id, { allowSpawn }).then((res) => {
        if (res && res.ok) return;
        if (allowSpawn && res && res.status !== 'locked' && res.error) {
          notify(`自动启动系统「${id}」失败：${seErrorMessage(res)}`, 'warn');
        }
      });
    const LIMIT = 2;
    let cursor = 0;
    const worker = async () => {
      while (cursor < ordered.length) {
        const id = ordered[cursor];
        cursor += 1;
        await runOne(id);
      }
    };
    const workers = [];
    for (let i = 0; i < Math.min(LIMIT, ordered.length); i += 1) workers.push(worker());
    Promise.all(workers).catch(() => {});
    // 依赖：已绑定集合 + 偏好就绪/开关；ensureSystem 引用稳定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiReady, preflightUnavailable, boundSystemKey]);

  // 自愈（D）：活动系统转离线且仍被 tab 绑定、SE 能力可用 → 去抖自动 ensureSystem 回收重拉，
  // 离线变瞬态（不再停「只读展示本地缓存」终态，也无需手动重连）。epoch/seOwnedNow 守卫防复活已关系统。
  const seRecoverTimerRef = useRef(null);
  useEffect(() => {
    if (!systemOffline || !activeSystemId) return undefined;
    if (!uiReady || preflightUnavailable) return undefined;
    if (!se.ownedNow(activeSystemId)) return undefined; // 已关 tab 的系统绝不复活
    const id = String(activeSystemId);
    const epoch = se.epochOf(id);
    clearTimeout(seRecoverTimerRef.current);
    seRecoverTimerRef.current = setTimeout(() => {
      if (!se.epochAlive(id, epoch)) return;
      if (!se.ownedNow(id)) return;
      se.recoverSystem(id, { quiet: true });
    }, 600);
    return () => clearTimeout(seRecoverTimerRef.current);
    // 依赖：离线态/活动系统/能力门；ensureSystem/recoverSystem 引用稳定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [systemOffline, activeSystemId, uiReady, preflightUnavailable]);

  /**
   * 唯一 SE 结构写路径（时机：capture → 本地乐观 → RPC → 重投影 → 校验 → pushSeTagsHistory；
   * 失败 → 重投影回滚本地 + notify）。可见性（toggleStreamCanvas / onBeforeDelete）与节点
   * fields 编辑、期 5 边增删改共用，禁止复制第二份实现（§2.1-4/5 / §3.1-6）。
   *
   * @param {Array<{name:string, changes:Array<{key:string, value:string|null}>}>} entries
   *        value===null → remove_tag；否则 set_tag。
   * @param {{validate?:(projected:any)=>boolean, skipReproject?:boolean}} [opts]
   *        skipReproject：仅当写操作不可能改变**流结构**（如纯可见性 canvas 标签）时用；
   *        跳过后端重投影以省去全量重建（见 seApplyVisibility），失败仍走下方回滚重投影。
   */
  const seApplyTagChanges = useCallback(
    async (entries, localApply, label, opts = {}) => {
      const sid = activeSystemIdRef.current;
      if (!sid) return false;
      const client = sePool.get(String(sid));
      if (client.status !== SE_STATUS.ONLINE) return false;
      const names = entries.map((e) => e.name);
      const before = await captureStreamTags(client, names);
      if (typeof localApply === 'function') localApply();
      // 期 14：登记自写（短 TTL），抑制本次写触发的 on_change 回声。
      entries.forEach((e) => se.markSelfWrite(sid, e.name));
      try {
        for (const e of entries) {
          for (const c of e.changes) {
            if (c.value == null) await client.call('stream.remove_tag', { name: e.name, key: c.key });
            else await client.call('stream.set_tag', { name: e.name, key: c.key, value: String(c.value) });
          }
        }
      } catch (err) {
        notify(`${label}失败：${(err && err.message) || err}`, 'warn');
        // B1：部分 RPC 可能已生效 → 尽力把 SE 还原到操作前快照（§2.1「失败回滚」），
        // 避免留下不可恢复的中间态；回滚本身若失败必须显式上报，绝不吞掉。
        let rollbackErr = null;
        try {
          const rolled = await applyTagSnapshot(client, before);
          const rollbackFailed = rolled.filter((s) => s.error && s.error !== 'missing');
          if (rollbackFailed.length) {
            rollbackErr = `还原失败：${rollbackFailed.map((s) => s.name).join('、')}`;
          }
        } catch (rbErr) {
          rollbackErr = (rbErr && rbErr.message) || String(rbErr);
        }
        await se.reproject(sid); // 本地以 SE 真源回滚乐观更新
        if (rollbackErr) {
          notify(`${label}回滚未完成（${rollbackErr}），已按服务端当前状态刷新`, 'warn');
        }
        return false;
      }
      const projected = opts.skipReproject ? null : await se.reproject(sid);
      // B3：校验读取重投影返回的投影真源，而非乐观本地 nodesRef（setNodes 尚未 flush）。
      // skipReproject（纯可见性）：`set_tag/remove_tag` 不推进 version、不改流结构，乐观
      // localApply 即真源，无需（也无可校验的）重投影；写失败仍走上方回滚重投影兜底。
      if (!opts.skipReproject && typeof opts.validate === 'function' && !opts.validate(projected)) {
        await se.reproject(sid);
        notify(`${label}校验不一致，已按服务端状态刷新`, 'warn');
      }
      const after = await captureStreamTags(client, names);
      pushSeTagsHistory(sid, label, before, after);
      return true;
    },
    [notify, pushSeTagsHistory]
  );

  /** 当前活动 tab 是否绑定在线 SE（边写路径的 SE 分流判据）。 */
  const boundOnlineNow = useCallback(() => {
    const sid = activeSystemIdRef.current;
    return !!sid && !systemOfflineRef.current && sePool.get(String(sid)).status === SE_STATUS.ONLINE;
  }, []);

  // ── SE 编排器（D3 下沉）：实例经 ref 稳定持有；能力端口每次渲染重建（调用时解引用取最新闭包）。
  // D4 状态层落地后，只需把 port 的实现从 React state 换成 store，调用点零改动。
  const sePortRef = useRef(null);
  sePortRef.current = {
    // 画布
    getNodes: () => nodesRef.current,
    getEdges: () => edgesRef.current,
    setNodes: applyNodes,
    setEdges,
    setDangling: setSeDangling,
    toCanvasGraph,
    isSeEdge,
    screenToFlowCenter: () => {
      const el = document.querySelector('.flow');
      const rect = el ? el.getBoundingClientRect() : null;
      return rect
        ? screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
        : { x: 100, y: 100 };
    },
    // 通知
    notify,
    setStatus,
    // 配置 / 标签
    getTabs: () => tabsRef.current,
    getStoreGraph: (tabId) => storeRef.current[tabId],
    getActiveSystemId: () => activeSystemIdRef.current,
    getActiveTabId: () => activeTabIdRef.current,
    isOffline: () => systemOfflineRef.current,
    getEditingNodeId: () => editingIdRef.current,
    isTabReady: () => tabReady, // 新增：检查当前 tab 是否已完成懒加载（layoutRef 已初始化）
    // 工具
    toolsForSystem,
    baseDirForSystem,
    recordToolFailures,
    onToolStatus,
    // 扫描重锚失败 → App 弹候选对话框（runtime → scanDriver 回调）。
    onResumeTargetMissing: onScanResumeMissing,
    setCanManageTools,
    setSeStatus: (id, st) => setSeStatusMap((m) => (m[id] === st ? m : { ...m, [id]: st })),
    // 常驻布局表（投影真源，永不消费；条目删除仅经 pruneLayout / closeTab）
    getLayout: (sid) => layoutRef.current[String(sid)] || null,
    pruneLayout: (sid, removedIds) => {
      const t = layoutRef.current[String(sid)];
      if (!t || !Array.isArray(removedIds)) return;
      for (const id of removedIds) {
        const name = streamNameFromId(id);
        if (name) delete t[name];
      }
    },
    // 延期调用（App 拥有的提升 / 边对齐）
    callPromotePending: (sid) => promotePendingRef.current?.(sid),
    callAlignEdges: (sid) => alignEdgesRef.current?.(sid),
    seErrorMessage,
  };
  const seRef = useRef(null);
  if (!seRef.current) seRef.current = createSeOrchestrator(() => sePortRef.current);
  const se = seRef.current;

  /**
   * FIX-3（R1）：绑定但未在线的 tab 上，任何改变 SE 边结构（s-* 边）的操作都必须挂起并提示。
   * 否则会落到本地分支 mutate 一条本地 s-* 边，被下一次重投影的 `isSeEdge` 过滤而静默丢失
   * （`.flow-offline` 只做视觉降噪，不禁用指针事件）。未绑定 tab 返回 false，本地行为不变。
   * 与 `guardOffline`（整体离线只读）不同：本守卫只拦 SE 结构编辑，放行 n-* 本地边。
   *
   * @param {boolean} isSe 目标操作是否作用于 SE 边结构（source/target 均 s-*）
   * @returns {boolean} true = 已拦截并已 notify
   */
  const seStructuralEditBlocked = useCallback(
    (isSe) => {
      if (!isSe) return false;
      if (!activeSystemIdRef.current) return false; // 未绑定 = 本地逃生舱
      if (boundOnlineNow()) return false;
      notify('系统离线，结构编辑已挂起', 'warn');
      return true;
    },
    [boundOnlineNow, notify]
  );

  // 期 5（G-4）：放开自环（去掉 a===b 分支）；一对流之间仍至多一条边（同键覆盖）。
  const pairTaken = useCallback(
    (a, b, ignoreId) =>
      edges.some(
        (e) =>
          e.id !== ignoreId &&
          ((e.source === a && e.target === b) || (e.source === b && e.target === a))
      ),
    [edges]
  );

  const isValidConnection = useCallback(
    (conn) =>
      !isMixedConnection(conn.source, conn.target) && !pairTaken(conn.source, conn.target),
    [pairTaken]
  );

  const onConnect = useCallback(
    (params) => {
      const { source, target } = params;
      if (isMixedConnection(source, target)) {
        notify('本地节点与 SE 流之间不支持连线', 'warn');
        return;
      }
      if (pairTaken(source, target)) {
        setStatus('已存在相同连线');
        return;
      }
      const seEdge = isSeEdge({ source, target });
      // R1/FIX-3：绑定 tab 离线时创建 s-* 边会落到本地分支，下次重投影被 `isSeEdge` 过滤 =
      // 静默丢失。按 §5.3「编辑动作禁止」挂起并提示；n-*↔n-* 本地边不受影响。
      if (seStructuralEditBlocked(seEdge)) return;
      const sName = streamNameFromId(source);
      const tName = streamNameFromId(target);
      const optimisticEdge = {
        id: seEdge ? edgeId(sName, tName) : `e-${edgeSeqRef.current++}`,
        type: 'agent',
        source,
        target,
        ...(seEdge ? { data: { state: 'se' } } : {}),
      };
      const localApply = () => setEdges((eds) => [...eds, optimisticEdge]);
      if (boundOnlineNow() && sName && tName) {
        seApplyTagChanges(
          [{ name: sName, changes: [{ key: edgeTagKey(tName), value: '' }] }],
          localApply,
          `连线 ${sName}→${tName}`,
          {
            validate: (p) =>
              !!p && Array.isArray(p.edges) && p.edges.some((e) => e.id === edgeId(sName, tName)),
          }
        );
        return;
      }
      pushHistory();
      localApply();
    },
    [pairTaken, pushHistory, setEdges, notify, seApplyTagChanges, boundOnlineNow, seStructuralEditBlocked]
  );

  const onConnectStart = useCallback((_, params) => {
    connectFromRef.current = params.nodeId;
  }, []);

  const onReconnect = useCallback(
    (oldEdge, newConnection) => {
      const ns = newConnection.source;
      const nt = newConnection.target;
      if (isMixedConnection(ns, nt)) {
        notify('本地节点与 SE 流之间不支持连线', 'warn');
        return;
      }
      if (pairTaken(ns, nt, oldEdge.id)) {
        setStatus('已存在相同连线');
        return;
      }
      const oldSe = isSeEdge(oldEdge);
      const newSe = isSeEdge({ source: ns, target: nt });
      // FIX-3：绑定离线时改接 s-* 边同样挂起（否则落到本地分支、被下次重投影丢弃）。
      if (seStructuralEditBlocked(oldSe || newSe)) return;
      if (boundOnlineNow() && oldSe !== newSe) {
        notify('不支持在本地节点与 SE 流之间改接连线', 'warn');
        return;
      }
      const oldS = streamNameFromId(oldEdge.source);
      const oldT = streamNameFromId(oldEdge.target);
      const newS = streamNameFromId(ns);
      const newT = streamNameFromId(nt);
      const label = oldEdge.label != null ? String(oldEdge.label) : '';
      const sameKey = oldS === newS && oldT === newT;
      const localApply = () =>
        setEdges((eds) =>
          eds.map((e) =>
            e.id === oldEdge.id
              ? {
                  ...e,
                  source: ns,
                  target: nt,
                  sourceHandle: newConnection.sourceHandle ?? undefined,
                  targetHandle: newConnection.targetHandle ?? undefined,
                  ...(newSe ? { data: { ...(e.data || {}), state: 'se' } } : {}),
                }
              : e
          )
        );
      if (boundOnlineNow() && oldSe && newSe && !sameKey) {
        const ops = [
          { source: oldS, key: edgeTagKey(oldT), value: null },
          { source: newS, key: edgeTagKey(newT), value: label },
        ];
        seApplyTagChanges(buildEdgeEntries(ops), localApply, `改接 ${newS}→${newT}`, {
          validate: (p) =>
            !!p &&
            Array.isArray(p.edges) &&
            !p.edges.some((e) => e.id === edgeId(oldS, oldT)) &&
            p.edges.some((e) => e.id === edgeId(newS, newT)),
        });
        return;
      }
      pushHistory();
      localApply();
    },
    [pairTaken, pushHistory, setEdges, notify, seApplyTagChanges, boundOnlineNow, seStructuralEditBlocked]
  );

  const addNodeAt = useCallback(
    (position, fromId) => {
      pushHistory();
      const id = `n-${nodeSeqRef.current++}`;
      const graph = {
        nodes: [{ id, position: snapPos(position), data: { name: '新节点' } }],
        edges: fromId
          ? [{ id: `e-${edgeSeqRef.current++}`, source: fromId, target: id }]
          : [],
      };
      const canvas = toCanvasGraph(graph);
      setNodes((nds) => [...nds, ...canvas.nodes]);
      setEdges((eds) => [...eds, ...canvas.edges]);
    },
    [pushHistory, setNodes, setEdges]
  );

  // Task 3 入口门控①：绑定在线时不再落 n-* 本地节点（孤儿来源），改唤起「新建流」对话框经 SE
  // 创建；未绑定/离线保持原本地行为（随机位置 + n-* 节点）。
  const addNode = useCallback(() => {
    if (boundOnlineNow()) {
      setStreamDraft({ title: '新建流', name: '新节点' });
      return;
    }
    addNodeAt({ x: Math.random() * 300 + 60, y: Math.random() * 220 + 40 });
  }, [addNodeAt, boundOnlineNow]);

  const onConnectEnd = useCallback(
    (event, connectionState) => {
      if (connectionState.isValid) return;
      const fromId = connectFromRef.current ?? connectionState.fromNode?.id;
      const toNode = connectionState.toNode;
      if (fromId && toNode && isMixedConnection(fromId, toNode.id)) {
        notify('本地节点与 SE 流之间不支持连线', 'warn');
        return;
      }
      if (connectionState.toNode || connectionState.toHandle) {
        setStatus('已存在相同连线');
        return;
      }
      if (!fromId) return;
      const position = snapPos(screenToFlowPosition({ x: event.clientX, y: event.clientY }));
      // Task 3 入口门控②：绑定在线时不再补 n-* 本地节点，改唤起「新建流」对话框；创建成功后
      // 经创建回调补 fromId → 新流的 SE 边（走 onConnect 的在线 seam）；取消则不创建、不补边。
      // 源为 pending（非 s-*）节点时走本地路径：混合连线本就被禁，两个 pending 节点随后可一并提升。
      if (boundOnlineNow() && streamNameFromId(fromId) != null) {
        setStreamDraft({ title: '连线到新流', name: '新节点', position, fromId });
        return;
      }
      addNodeAt(position, fromId);
    },
    [screenToFlowPosition, addNodeAt, notify, boundOnlineNow]
  );

  const openEdgeEdit = useCallback((id) => setEdgeEdit({ id }), []);

  const onEdgeDoubleClick = useCallback((_, edge) => openEdgeEdit(edge.id), [openEdgeEdit]);

  const cancelEdgeEdit = useCallback(() => setEdgeEdit(null), []);

  const commitEdgeLabel = useCallback(
    (id, value) => {
      setEdgeEdit((cur) => (cur && cur.id === id ? null : cur));
      const clean = String(value ?? '').trim();
      const target = edgesRef.current.find((e) => e.id === id);
      if (!target) return;
      const prev = target.label != null ? String(target.label) : '';
      if (prev === clean) return;
      const isSe = isSeEdge(target);
      // FIX-3：绑定离线时改 s-* 边注释同样挂起（否则本地改写被下次重投影丢弃）。
      if (seStructuralEditBlocked(isSe)) return;
      const localApply = () =>
        setEdges((eds) => eds.map((e) => (e.id === id ? { ...e, label: clean || undefined } : e)));
      if (boundOnlineNow() && isSe) {
        const sName = streamNameFromId(target.source);
        const tName = streamNameFromId(target.target);
        seApplyTagChanges(
          [{ name: sName, changes: [{ key: edgeTagKey(tName), value: clean }] }],
          localApply,
          `边注释 ${sName}→${tName}`,
          {
            validate: (p) => {
              const e =
                p && Array.isArray(p.edges) ? p.edges.find((x) => x.id === edgeId(sName, tName)) : null;
              return !!e && String(e.label || '') === clean;
            },
          }
        );
        return;
      }
      pushHistory();
      localApply();
    },
    [pushHistory, setEdges, seApplyTagChanges, boundOnlineNow, seStructuralEditBlocked]
  );

  // React Flow 只向自定义边透传白名单字段 + data，编辑态必须挂在 data 上才能到达 AgentEdge。
  // 边的 hidden 不独立存储，由两端点流的 canvas 标签派生（§3.7）。
  const renderEdges = useMemo(() => {
    const derived = deriveEdgeHidden(edges, nodes);
    return edgeEdit
      ? derived.map((e) =>
          e.id === edgeEdit.id ? { ...e, data: { ...(e.data || {}), editing: true } } : e
        )
      : derived;
  }, [edges, nodes, edgeEdit]);

  // Node 同理：编辑态标记 + 懒加载宿主组件挂到 data 上（React Flow 只透传 data）。
  // 节点 hidden 按 canvas 标签投影：数据永远在 nodes 里，画布只是过滤视图。
  const renderNodes = useMemo(() => {
    const seBound = !!activeSystemId;
    const projected = nodes.map((n) => {
      const hidden = !isStreamVisible(n);
      // 期 7（G-3）：把「本 tab 是否绑定 SE」透传到节点 data，供 AgentNode 门控 DEMO 进程。
      // 期 15（B4）：同时透传「用户是否手动固定了尺寸」——固定高度的节点分页时不套 .paged，
      // 保留用户尺寸（内容区自滚动）。非持久化字段（snapshotOf 白名单不含）。
      const userFixedSize = !!(n.style?.height != null || n.height != null);
      // viewScope 是节点渲染归属（活动 tab id），仅运行时透传；snapshotOf 白名单不包含它。
      const unchanged =
        n.data?.seBound === seBound &&
        n.data?.userFixedSize === userFixedSize &&
        n.data?.viewScope === activeId;
      const data = unchanged
        ? n.data
        : { ...n.data, seBound, userFixedSize, viewScope: activeId };
      return n.hidden === hidden && data === n.data ? n : { ...n, hidden, data };
    });
    return editingNodeId
      ? projected.map((n) =>
          n.id === editingNodeId
            ? { ...n, data: { ...n.data, editing: true, MkHost: MilkdownHost, snippets } }
            : n
        )
      : projected;
  }, [nodes, editingNodeId, snippets, activeSystemId, activeId]);

  const removeNode = useCallback(
    (id) => {
      pushHistory();
      // refs 必须同步删除：deleteStream 的 flushDeletion 紧接着读 nodesRef 落盘，
      // 等 React setState 生效会把这颗已删节点重新写回配置。
      const nextNodes = nodesRef.current.filter((n) => n.id !== id);
      const nextEdges = edgesRef.current.filter(
        (e) => e.source !== id && e.target !== id
      );
      nodesRef.current = nextNodes;
      edgesRef.current = nextEdges;
      applyNodes(nextNodes);
      setEdges(nextEdges);
    },
    [pushHistory, applyNodes, setEdges]
  );

  const removeEdge = useCallback(
    (id) => {
      const target = edgesRef.current.find((e) => e.id === id);
      // FIX-3：绑定离线时删除 s-* 边同样挂起（否则本地删边会被下次重投影复现）。
      if (seStructuralEditBlocked(isSeEdge(target))) return;
      const localApply = () => setEdges((eds) => eds.filter((e) => e.id !== id));
      if (target && boundOnlineNow() && isSeEdge(target)) {
        const sName = streamNameFromId(target.source);
        const tName = streamNameFromId(target.target);
        seApplyTagChanges(
          [{ name: sName, changes: [{ key: edgeTagKey(tName), value: null }] }],
          localApply,
          `删边 ${sName}→${tName}`,
          {
            validate: (p) =>
              !!p && Array.isArray(p.edges) && !p.edges.some((e) => e.id === edgeId(sName, tName)),
          }
        );
        return;
      }
      pushHistory();
      localApply();
    },
    [pushHistory, setEdges, seApplyTagChanges, boundOnlineNow, seStructuralEditBlocked]
  );

  // ---------------------------------------------------------------------------
  // 流可见性（需求 9）：画布显示 = 投影过滤，数据永远保留
  // ---------------------------------------------------------------------------

  // 流面板数据源：从当前标签页 nodes/edges 派生（含隐藏流）。
  const streamList = useMemo(() => {
    // 期 5（G-6）：入边/出边分开统计（派生自当前画布边，SE 边与本地边同口径）。
    const inbound = new Map();
    const outbound = new Map();
    edges.forEach((e) => {
      outbound.set(e.source, (outbound.get(e.source) || 0) + 1);
      inbound.set(e.target, (inbound.get(e.target) || 0) + 1);
    });
    return nodes.map((n) => {
      const fields = normalizeFields(n.data?.fields);
      const name = streamNameFromId(n.id);
      // 期 5：搜索可达 edge.* 原始 tags（SE 投影）；本地节点回落 fields。
      const rawTags = name ? se.tagsGet(name) : null;
      const searchTags = rawTags
        ? Object.entries(rawTags).map(([key, value]) => ({ key, value: value == null ? '' : String(value) }))
        : fields;
      return {
        id: String(n.id),
        name: n.data?.name != null ? String(n.data.name) : n.data?.title != null ? String(n.data.title) : '',
        description: n.data?.description != null ? String(n.data.description) : '',
        fields,
        searchTags,
        visible: isStreamVisible(n),
        size: String(n.data?.content || '').length,
        inbound: inbound.get(String(n.id)) || 0,
        outbound: outbound.get(String(n.id)) || 0,
      };
    });
  }, [nodes, edges]);

  // ── 期 10：SE 体系配置包导出（D4）──────────────────────────────────────────
  // 已绑定在线：以 SE RPC 为真源（stream.list/read + tool.list）；未绑定：以本地画布派生。
  // 写入顺序：兄弟文本文件先行、manifest 最后（提交点）；任一兄弟失败即抛错，不发布半包。

  /**
   * 打开导出对话框。scope：
   * - 'document'（默认）：整份文档（流 + 工具）；
   * - 'streams'：只导出流（侧栏流按钮）；
   * - 'tools'：只导出工具（侧栏工具按钮）。
   */
  const openPackageExport = useCallback((scope = 'document') => {
    const sid = activeSystemIdRef.current;
    if (sid && systemOfflineRef.current) {
      notify('系统离线，无法导出配置包', 'warn');
      return;
    }
    const wantStreams = scope !== 'tools';
    const wantTools = scope !== 'streams';
    const rows = [];
    if (!wantStreams) {
      // 只导出工具：流列表留空。
    } else if (sid) {
      for (const s of streamList) {
        const name = streamNameFromId(s.id);
        if (name) rows.push({ name });
      }
    } else {
      const taken = [];
      for (const s of streamList) {
        const name = streamNameFromId(s.id) || toStreamName(s.name || '', taken);
        if (!name) continue;
        taken.push(name);
        rows.push({ name });
      }
    }
    // R-4.1：内部流（_console/_scan_log）导出默认不勾选；用户仍可手动勾选（R-4.2）。
    const exportNames = new Set(rows.map((r) => r.name));
    rows.forEach((r) => {
      r.internal = isInternal(r.name, exportNames);
    });
    const toolRows = wantTools
      ? Object.values(tools || {}).map((t) => ({
          name: String(t.name),
          description: t.description || '',
        }))
      : [];
    if (!rows.length && !toolRows.length) {
      notify('没有可导出的流或工具', 'warn');
      return;
    }
    setPkgExport({ streams: rows, tools: toolRows, scope });
  }, [streamList, tools, notify]);

  /** 执行导出：读 → 复刻计划 → 流正文/工具/ manifest 一次原子落盘 →（可选）绑定/写回。 */
  const runPackageExport = useCallback(
    async ({ streamNames, toolNames, savePath, bind, toolMode = 'dir' }) => {
      const sid = activeSystemIdRef.current;
      const path = /\.se\.json$/i.test(savePath)
        ? savePath
        : `${savePath.replace(/\.json$/i, '')}.se.json`;
      const displayName = packageNameFromPath(path);
      const portablePath = portableDocPath(path, getProjectRoot(), {
        repairGraphsResidue: false,
      });
      if (bind && !sid && !workDocPathOf(activeTab)) {
        const owner = findDocOwner(tabsRef.current, portablePath, activeId);
        if (owner) {
          notify(`该配置包已在标签页「${owner.name || '未命名图'}」中打开，未重复绑定`, 'warn');
          return;
        }
      }
      // baseDir 必须是绝对目录：工具复刻/路径改写都以它为基准。
      const baseDir = absolutizeDocPath(manifestDirOf(path), getProjectRoot()) || manifestDirOf(path);
      const joinPath = (dir, rel) => `${String(dir).replace(/[\\/]+$/, '')}/${rel}`;
      setPkgBusy(true);
      setPkgProgress(null);
      try {
        const streams = [];
        const toolsOut = [];
        const driftWarnings = [];
        if (sid) {
          const client = sePool.get(String(sid));
          const list = await client.call('stream.list', {});
          // 期 12（D7）：单项/多项导出经纯选择器挑子集（可单测；行为等价于原 wanted 过滤）。
          const rows = selectPackageInput({ streams: list, streamNames }).streams;
          let readDone = 0;
          for (const r of rows) {
            setPkgProgress({ phase: 'reading', current: (readDone += 1), total: rows.length });
            const read = await client.call('stream.read', { name: r.name });
            streams.push({
              name: String(r.name),
              description: r.description == null ? '' : String(r.description),
              tags: r.tags && typeof r.tags === 'object' ? r.tags : {},
              content: read && read.text != null ? String(read.text) : '',
            });
            // Q6：stream.read 不回 version，用 get_metadata 复核导出期间的并发修改。
            if (r.version != null) {
              const meta = await client
                .call('stream.get_metadata', { name: r.name })
                .catch(() => null);
              if (meta && meta.version != null && String(meta.version) !== String(r.version)) {
                driftWarnings.push(`流 ${r.name} 导出期间被修改（版本 ${r.version}→${meta.version}）`);
              }
            }
          }
          const tlist = await client.call('tool.list', {});
          toolsOut.push(...selectPackageInput({ tools: tlist, toolNames }).tools);
        } else {
          const taken = [];
          for (const n of nodesRef.current) {
            const displayName = n.data?.name != null
              ? String(n.data.name)
              : n.data?.title != null
                ? String(n.data.title)
                : '';
            const name = streamNameFromId(n.id) || toStreamName(displayName, taken);
            if (!name || !streamNames.includes(name)) continue;
            taken.push(name);
            const tags = {};
            normalizeFields(n.data?.fields).forEach((f) => {
              if (f.key) tags[f.key] = f.value;
            });
            streams.push({
              name,
              description: n.data?.description != null ? String(n.data.description) : '',
              tags,
              content: n.data?.content != null ? String(n.data.content) : '',
            });
          }
          for (const t of Object.values(toolsRef.current || {})) {
            if (toolNames.includes(t.name)) toolsOut.push(t);
          }
        }

        const positions = {};
        // Tier-1（RC2）：本地未绑定节点（n-*）也要带坐标——streamNameFromId 只认 s-*，
        // 旧逻辑把本地画布导出的布局整体丢弃（重建即堆叠）。本地节点名按上方导出段同口径
        // 推导（data.name/data.title → toStreamName + taken 去重），确保 positions 键
        // 与 streamNames 清单（导出对话框同口径规范化结果）一致。
        const posTaken = [];
        nodesRef.current.forEach((n) => {
          const displayName = n.data?.name != null
            ? String(n.data.name)
            : n.data?.title != null
              ? String(n.data.title)
              : '';
          const name = streamNameFromId(n.id) || toStreamName(displayName, posTaken);
          if (!name || !streamNames.includes(name)) return;
          posTaken.push(name);
          positions[name] = { x: n.position.x, y: n.position.y };
        });

        // 工具复刻计划：dir（默认）/ file / external。流正文始终物化。
        const bundle = planToolBundles({ tools: toolsOut, baseDir, mode: toolMode });
        const built = buildPackage({
          displayName,
          streams,
          tools: toolsOut,
          positions,
          baseDir,
          savedAt: new Date().toISOString(),
          toolRewrites: bundle.rewrites,
          copies: bundle.copies,
        });
        const manifestRel = `${displayName}.se.json`;
        const manifestFile = built.files.find((f) => f.relPath === manifestRel);
        const siblingFiles = built.files.filter((f) => f.relPath !== manifestRel);
        if (!manifestFile) throw new Error('manifest 缺失，导出中止');
        const total = siblingFiles.length + built.copies.length + 1;
        setPkgProgress({ phase: 'writing', current: 0, total });
        // 一次请求完成：流正文 → 工具复刻 → manifest 最后写（服务端提交点）。
        const res = await fetch('/api/package/apply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            files: siblingFiles.map((f) => ({
              path: joinPath(baseDir, f.relPath),
              text: f.text,
            })),
            copies: built.copies.map((c) => ({
              from: c.from,
              to: joinPath(baseDir, c.to),
              unit: c.unit,
            })),
            manifest: { path: joinPath(baseDir, manifestRel), text: manifestFile.text },
            options: { overwrite: true },
          }),
        });
        const applied = await res.json().catch(() => null);
        if (!res.ok) throw new Error((applied && applied.error) || `HTTP ${res.status}`);
        setPkgProgress({ phase: 'writing', current: total, total });

        if (bind && !sid) {
          // system_id 由 Node 在磁盘命名空间内原子分配；create 绝不复用已有 storage。
          const created = await se.createSystem({ base: displayName });
          if (!created.ok) {
            notify(`已导出，但创建系统失败：${created.error || created.status || '未知'}`, 'warn');
          } else {
            const systemId = created.systemId;
            setTabs((ts) =>
              ts.map((t) =>
                t.id === activeId
                  ? {
                      ...t,
                      system: {
                        system_id: systemId,
                        display_name: displayName,
                        manifest_path: portablePath,
                        storage_dir: `se-systems/${systemId}`,
                      },
                    }
                  : t
              )
            );
            const conn = await se.connectSystem(systemId);
            if (conn.ok) {
              const contents = new Map(streams.map((s) => [s.name, s.content]));
              const plan = planImport({
                manifest: built.manifest,
                contents,
                existingStreams: [],
                existingTools: [],
              });
              await applyImport({
                plan,
                manifest: built.manifest,
                call: (m, p) => sePool.get(systemId).call(m, p || {}),
                contents,
                baseDir,
                registeredTools: [],
                strategy: 'overwrite',
                confirmReserved: true,
                isScanActive: scanActiveForName,
              });
              // Tier-1（RC3）：导出即绑定时把当前排布喂常驻布局表——否则导入后的
              // 首次重投影无 layout 可用，节点回退中心网格堆叠（布局不落 SE，只能靠它）。
              layoutRef.current[systemId] = { ...positions };
              await se.onConnected(systemId);
              notify(`已绑定并导入系统「${displayName}」`, 'ok');
            } else {
              // 创建成功但连接失败：终止无主新系统并解绑，避免自愈 effect 再把它拉起。
              await se.endUnboundSystem(systemId).catch(() => {});
              setTabs((ts) =>
                ts.map((t) => (t.id === activeId ? { ...t, system: undefined } : t))
              );
              notify(`已导出，但连接新系统失败：${conn.error || '未知'}`, 'warn');
            }
          }
        }

        notify(
          `已导出配置包：${streams.length} 流 / ${toolsOut.length} 工具 / 复刻 ${built.copies.length} 项 → ${path}`,
          'ok'
        );
        const warnAll = [...driftWarnings, ...built.warnings, ...bundle.warnings];
        if (bundle.externals.length) {
          warnAll.push(`${bundle.externals.length} 个工具按外部引用导出（未复制）`);
        }
        if (warnAll.length) notify(`注意：${warnAll[0]}`, 'warn');
        setPkgExport(null);
      } catch (err) {
        notify(`导出失败：${(err && err.message) || err}`, 'warn');
      } finally {
        setPkgBusy(false);
        setPkgProgress(null);
      }
    },
    [activeId, activeTab, notify, scanActiveForName]
  );

  /** 迁移源数据（§5.3）：给定画布 → rows（标题 + 推导 SE 名 + 正文 + tags 含 edge.*）+ tools + positions。 */
  const buildMigrationDataFrom = useCallback((nodes, edges, tools) => {
    const taken = [];
    const nameById = new Map();
    const rowByName = new Map();
    const rows = [];
    const positions = {};
    for (const n of Array.isArray(nodes) ? nodes : []) {
      const id = String(n.id);
      const displayName = n.data?.name != null
        ? String(n.data.name)
        : n.data?.title != null
          ? String(n.data.title)
          : '';
      const existing = streamNameFromId(id);
      const name = existing && isValidStreamName(existing) ? existing : toStreamName(displayName, taken);
      taken.push(name);
      nameById.set(id, name);
      const fields = {};
      normalizeFields(n.data?.fields).forEach((f) => {
        if (f.key) fields[f.key] = f.value;
      });
      const row = {
        id,
        name,
        content: n.data?.content == null ? '' : String(n.data.content),
        description: n.data?.description == null ? '' : String(n.data.description),
        tags: { ...fields },
      };
      rows.push(row);
      rowByName.set(name, row);
      const px = Number(n.position?.x);
      const py = Number(n.position?.y);
      if (Number.isFinite(px) && Number.isFinite(py)) positions[name] = { x: px, y: py };
    }
    for (const e of Array.isArray(edges) ? edges : []) {
      const srcName = nameById.get(String(e.source));
      const tgtName = nameById.get(String(e.target));
      if (!srcName || !tgtName) continue;
      const row = rowByName.get(srcName);
      if (row) row.tags[edgeTagKey(tgtName)] = e.label == null ? '' : String(e.label);
    }
    return { rows, tools: Object.values(tools || {}), positions };
  }, []);

  /**
   * 自动迁移（P4）：新 SE 为空且本地图有内容时，按 §5.3 同一通路把本地流/工具灌入。
   * 仅当目标 SE 在线且 `stream.list` 为空、且本地确有可迁移内容时执行；返回是否已迁移。
   */
  const migrateLocalContentIfEmpty = useCallback(
    async (systemId, graph) => {
      const sid = String(systemId);
      const data = buildMigrationDataFrom(graph?.nodes, graph?.edges, graph?.tools);
      if (!data.rows.length && !data.tools.length) return false;
      const manifest = buildMigrationManifest(data.rows, data.tools, data.positions);
      const contents = new Map(data.rows.map((r) => [r.name, r.content]));
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      // 刚 spawn 的 SE 其浏览器 WS 可能先 open 再被代理瞬断：以一次成功的轻量 RPC 作为
      // 「稳定在线」判据（最多轮询 ~20s）；拿不到就放弃迁移并保留本地画布（绝不返回 true）。
      let existing = null;
      for (let i = 0; i < 20 && existing === null; i += 1) {
        const c = sePool.get(sid);
        if (c.status === SE_STATUS.ONLINE) {
          try {
            existing = await c.call('stream.list', {});
          } catch (err) {
            existing = null;
          }
        }
        if (existing === null) await delay(1000);
      }
      if (existing === null) return false;
      if (Array.isArray(existing) && existing.length) return false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const client = sePool.get(sid);
        try {
          const plan = planImport({ manifest, contents, existingStreams: [], existingTools: [] });
          const summary = await applyImport({
            plan,
            manifest,
            call: (m, p) => client.call(m, p || {}),
            contents,
            baseDir: baseDirForSystem(sid),
            registeredTools: [],
            strategy: 'overwrite',
            confirmReserved: true,
            isScanActive: scanActiveForName,
          });
          const nStreams = (summary.streams && summary.streams.created) || 0;
          const nTools = (summary.tools && summary.tools.registered) || 0;
          const failed = (summary.streams && summary.streams.failed) || 0;
          const errText = (summary.errors && summary.errors[0]) || '';
          if (!failed && !(data.rows.length > 0 && nStreams === 0)) {
            notify(`已自动迁移本地内容：${nStreams} 流 / ${nTools} 工具`, 'ok');
            return true;
          }
          if (attempt < 2 && /not online|offline|closed/i.test(errText)) {
            await delay(800);
            continue;
          }
          notify(`本地内容自动迁移未完成，保留本地画布：${errText || '创建流失败'}`, 'warn');
          return false;
        } catch (err) {
          if (attempt < 2) {
            await delay(800);
            continue;
          }
          notify(`本地内容自动迁移失败：${(err && err.message) || err}`, 'warn');
          return false;
        }
      }
      return false;
    },
    [buildMigrationDataFrom, notify, scanActiveForName]
  );

  /** 情境一：读包 + 建计划 → 打开导入预览（path 直读；pick 弹文件框）。 */
  const loadPackageIntoBound = useCallback(
    async ({ path, pick }) => {
      const sid = activeSystemIdRef.current;
      if (!sid) return;
      let manifestPath = path || null;
      if (!manifestPath || pick) {
        try {
          const res = await fetch('/api/dialog/open', { method: 'POST' });
          const data = await res.json();
          if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
          if (!data.path) return;
          manifestPath = data.path;
        } catch (err) {
          notify(`选择配置包失败：${(err && err.message) || err}`, 'warn');
          return;
        }
      }
      setPkgImportBusy(true);
      try {
        const { manifest } = await loadManifestFile(manifestPath);
        const client = sePool.get(String(sid));
        const built = await buildPackageImportPlan({ manifest, manifestPath, client });
        setPkgImport({
          mode: 'into-bound',
          manifest,
          manifestPath,
          contents: built.contents,
          plan: built.plan,
          planInputs: built.planInputs,
        });
      } catch (err) {
        notify(`读取配置包失败：${(err && err.message) || err}`, 'warn');
      } finally {
        setPkgImportBusy(false);
      }
    },
    [notify, buildPackageImportPlan]
  );

  /** 情境一入口（面板 📂）：已绑定包 → 弹「重载 / 另选」选择器；否则直接选包。 */
  const openPackageImport = useCallback(() => {
    const sid = activeSystemIdRef.current;
    if (!sid) {
      notify('当前标签页未绑定系统，无法加载配置包', 'warn');
      return;
    }
    if (systemOfflineRef.current) {
      notify('系统离线，无法加载配置包', 'warn');
      return;
    }
    const bound = activeSystem?.manifest_path || null;
    if (bound) setPkgImportChoose(bound);
    else loadPackageIntoBound({ pick: true });
  }, [activeSystem, notify, loadPackageIntoBound]);

  /** 情境一执行：按选择重算 selected → applyImport（merge-only）→ 重投影 → 恢复布局。
   *  不切换工作文档：增量导入只把包内容并入当前系统，当前 docPath/manifest_path 不变。 */
  const runPackageImport = useCallback(
    async ({ selection, strategy, restoreLayout, confirmReserved }) => {
      const cur = pkgImport;
      const sid = activeSystemIdRef.current;
      if (!cur || !sid) return;
      if (pkgImportBusyRef.current) return; // 双提交守卫
      const selectedStreamNames = Array.isArray(selection?.streamNames)
        ? selection.streamNames.map(String).filter(Boolean)
        : [];
      const selectedToolNames = Array.isArray(selection?.toolNames)
        ? selection.toolNames.map(String).filter(Boolean)
        : [];
      const manifestStreamNames = Array.isArray(cur.manifest?.streams)
        ? cur.manifest.streams.map((s) => s?.name).filter(Boolean)
        : [];
      const affectedNames = selectedStreamNames.length ? selectedStreamNames : manifestStreamNames;
      const hasSelectedTools = selectedToolNames.length > 0;
      // 工具是系统级：只要本次会动工具，就按“全部流”做扫描守卫（不能用空 affectedNames 放行）。
      if (!guardNoActiveScan('导入/覆盖配置流/工具', hasSelectedTools ? null : affectedNames)) return;
      pkgImportBusyRef.current = true;
      setPkgImportBusy(true);
      setPkgImportProgress(null);
      try {
        const client = sePool.get(String(sid));
        // 实况工具快照：预览快照可能过期/为空/工具不可见；未知绝不当作 new。
        let liveTools = null;
        if (hasSelectedTools) {
          let raw;
          try {
            raw = await client.call('tool.list', {});
          } catch (err) {
            notify(`读取 SE 工具注册表失败，已中止导入：${(err && err.message) || err}`, 'warn');
            return;
          }
          if (Array.isArray(raw)) liveTools = raw;
          else if (raw && typeof raw === 'object') liveTools = Object.values(raw);
          else {
            notify('读取 SE 工具注册表返回畸形数据，已中止导入；请重试', 'warn');
            return;
          }
        }
        const planInputs = liveTools ? { ...cur.planInputs, existingTools: liveTools } : cur.planInputs;
        const callImport = (prog) =>
          applyImport({
            plan: planImport({ ...planInputs, selection }),
            manifest: cur.manifest,
            call: (m, p) => client.call(m, p || {}),
            contents: cur.contents,
            baseDir: manifestAbsDirOf(cur.manifestPath),
            registeredTools: liveTools,
            strategy: strategy === 'config-load' ? 'overwrite' : strategy,
            confirmReserved,
            onProgress: prog,
            isScanActive: scanActiveForName,
          });
        let summary;
        let configLoadAddOnly = false;
        if (strategy === 'config-load' && cur.manifestPath) {
          const allNames = (cur.manifest.streams || []).map((s) => String(s?.name || '')).filter(Boolean);
          const sel = new Set((selection?.streamNames || []).map(String));
          const skipStreams = allNames.filter((n) => !sel.has(n));
          const reg = await runConfigLoadRegister(client, {
            filePath: cur.manifestPath,
            skipStreams,
            streamNames: sel.size ? allNames.filter((n) => sel.has(n)) : allNames,
          });
          if (reg.ok) {
            configLoadAddOnly = true;
            summary = {
              streams: { created: reg.created.length, updated: 0, skipped: reg.skipped.length, unchanged: 0, failed: 0 },
              tools: { registered: 0, updated: 0, skipped: 0, failed: 0 },
              errors: (reg.errors || []).map((e) => (e && (e.message || e.reason || e.entity)) || String(e)),
              warnings: (reg.preview && reg.preview.warnings) || [],
            };
          } else {
            if (reg.fallback) notify('config.load 不可用（非 root），回落逐项导入', 'warn');
            summary = await callImport((prog) => setPkgImportProgress(prog));
          }
        } else {
          summary = await callImport((prog) => setPkgImportProgress(prog));
        }
        // 配置=唯一台账（需求1）：包内工具（按选区）登记进本 tab 配置，列表从配置渲染。
        const selToolNames =
          selection && Array.isArray(selection.toolNames)
            ? new Set(selection.toolNames.map(String))
            : null;
        const pkgTools = normalizeTools(cur.manifest.tools || {});
        const pickedTools = {};
        for (const [tname, tdef] of Object.entries(pkgTools)) {
          if (selToolNames && !selToolNames.has(tname)) continue;
          pickedTools[tname] = tdef;
        }
        if (configLoadAddOnly) {
          // config.load 是上游 add-only：保持“整包登记”的既有语义，不按逐项结果裁剪。
          if (Object.keys(pickedTools).length) {
            commitTools((prev) => ({ ...prev, ...pickedTools }));
          }
        } else {
          // 普通覆盖：只提交成功注册/更新的工具，并写入**实际下发的绝对路径**；
          // 失败项保留旧台账并标注 failed，避免“UI 新路径、SE 旧路径”。
          const results = Array.isArray(summary.toolResults) ? summary.toolResults : [];
          const okByName = new Map(
            results
              .filter((r) => r && (r.state === 'registered' || r.state === 'updated'))
              .map((r) => [String(r.name), r])
          );
          const committed = {};
          for (const [tname, tdef] of Object.entries(pickedTools)) {
            const r = okByName.get(tname);
            if (!r || !r.params) continue;
            committed[tname] = { ...tdef, tool_path: r.params.tool_path };
            if (r.params.execution_path) committed[tname].execution_path = r.params.execution_path;
            else delete committed[tname].execution_path;
            if (r.params.manual_path) committed[tname].manual_path = r.params.manual_path;
            else delete committed[tname].manual_path;
          }
          if (Object.keys(committed).length) {
            commitTools((prev) => ({ ...prev, ...committed }));
          }
          const failures = results
            .filter((r) => r && r.state === 'failed')
            .map((r) => ({ name: String(r.name), error: r.error || '注册失败' }));
          if (failures.length) recordToolFailures(sid, failures);
        }
        // 包内布局喂常驻表（新流按记录落点；与连接路径同一载体）。
        if (restoreLayout) layoutRef.current[String(sid)] = readManifestLayout(cur.manifest) || {};
        await se.onConnected(sid);
        // merge-only：本次实际写入的正文播种到投影节点，下次保存在当前文档 streams 目录生成 md。
        const written = new Set(Object.keys((summary.streams && summary.streams.versions) || {}));
        if (written.size && cur.contents) {
          setNodes((nds) => {
            let changed = false;
            const next = nds.map((n) => {
              const nm = String(n.data?.name || '');
              if (!written.has(nm) || n.data?.contentState === 'loaded') return n;
              if (!cur.contents.has(nm)) return n;
              changed = true;
              return {
                ...n,
                data: { ...n.data, content: cur.contents.get(nm), contentState: 'loaded' },
              };
            });
            if (changed) {
              nodesRef.current = next;
              storeRef.current[activeId] = { ...(storeRef.current[activeId] || {}), nodes: next };
            }
            return next;
          });
        }
        const s = summary.streams;
        const t = summary.tools;
        const failed = s.failed + t.failed;
        notify(
          `配置包加载完成：新增 ${s.created} / 更新 ${s.updated} / 跳过 ${s.skipped + t.skipped} / 失败 ${failed}`,
          failed ? 'warn' : 'ok'
        );
        if (summary.errors && summary.errors.length) notify(summary.errors[0], 'warn');
        else if (Array.isArray(s.conflicts) && s.conflicts.length) {
          notify(
            `配置包加载：${s.conflicts.length} 个流初始化未确认，已以 SE 读回为准`,
            'warn'
          );
        } else if (summary.warnings && summary.warnings.length) notify(summary.warnings[0], 'warn');
        setPkgImport(null);
      } catch (err) {
        notify(`加载配置包失败：${(err && err.message) || err}`, 'warn');
      } finally {
        pkgImportBusyRef.current = false;
        setPkgImportBusy(false);
        setPkgImportProgress(null);
      }
    },
    [
      pkgImport,
      activeId,
      notify,
      commitTools,
      recordToolFailures,
      runConfigLoadRegister,
      guardNoActiveScan,
      scanActiveForName,
    ]
  );

  /**
   * 可见性写路径：canvas 键 set/remove（纯本地可见性乐观更新）。
   *
   * 期 14 加固：`canvas` 被 classify 视为结构标签（其他客户端需重投影对账），但对**本客户端**
   * 它只是一次就地可见性切换——`localApply` 已改节点 fields，且 `set_tag/remove_tag` 不推进
   * version、不改变流结构。故用 `skipReproject` 免去 `reprojectSeSystem` 的全量重建（也免去对
   * 全部 `_console` 正文的重复派生），眼睛切换立即完成；写失败仍由 seApplyTagChanges 的回滚
   * 重投影兜底，服务端真源保持一致。
   */
  const seApplyVisibility = useCallback(
    (names, show, localApply, label) => {
      const entries = names.map((name) => ({
        name,
        changes: [{ key: 'canvas', value: show ? null : 'false' }],
      }));
      return seApplyTagChanges(entries, localApply, label, { skipReproject: true });
    },
    [seApplyTagChanges]
  );

  // 眼睛/右键/拖拽共用入口：隐藏写 canvas:false、显示移除该键；显示时可指定落点。
  // 绑定在线 → 走 SE tag 写路径（seApplyVisibility）；未绑定/离线保持本地行为（逃生舱）。
  const toggleStreamCanvas = useCallback(
    (id, show, position, focus) => {
      const node = nodesRef.current.find((n) => n.id === id);
      if (!node) return;
      const visible = isStreamVisible(node);
      if (show && visible && !position) return;
      if (!show && !visible) return;
      // 正在编辑态的流先自动提交退出编辑，再隐藏
      if (!show && editingIdRef.current === id) exitEdit(true);

      const name = streamNameFromId(id);
      // 用户显式显示（取消隐藏）：移出内部流标记，后续重投影不再反打 canvas:false。
      if (show && name) se.unmarkInternal(name);
      const sid = activeSystemIdRef.current;
      const boundOnline =
        !!name &&
        !!sid &&
        !systemOfflineRef.current &&
        sePool.get(String(sid)).status === SE_STATUS.ONLINE;

      // 双击隐藏流显形时的聚焦落点（含防重叠级联后的最终位置），由 localApply 内赋值。
      let focusPoint = null;
      const localApply = () => {
        setNodes((nds) =>
          nds.map((n) => {
            if (n.id !== id) return n;
            const fields = normalizeFields(n.data?.fields).filter((f) => f.key !== 'canvas');
            const data = { ...n.data };
            if (!show) fields.push({ key: 'canvas', value: 'false' });
            if (fields.length) data.fields = fields;
            else delete data.fields;
            const next = { ...n, data, selected: !!show };
            if (show) {
              if (position) {
                next.position = position;
              } else {
                // 历史位置优先；与已有可见节点重叠时级联 +24px 防重叠
                let { x, y } = n.position;
                for (let k = 0; k < 10; k += 1) {
                  const clash = nds.some(
                    (m) =>
                      m.id !== id &&
                      isStreamVisible(m) &&
                      Math.abs(m.position.x - x) < 12 &&
                      Math.abs(m.position.y - y) < 12
                  );
                  if (!clash) break;
                  x += 24;
                  y += 24;
                }
                next.position = { x, y };
              }
              const width = toW(next.style?.width) ?? NODE_W;
              focusPoint = { x: next.position.x + width / 2, y: next.position.y + 60 };
            }
            return next;
          })
        );
        // 显示后居中并拉取最新内容；不进入编辑（编辑仍以画布节点为准）。
        if (focus && show && focusPoint) {
          setCenter(focusPoint.x, focusPoint.y, { zoom: getZoom(), duration: 300 });
          se.readContent(id);
        }
      };

      if (boundOnline) {
        seApplyVisibility([name], !!show, localApply, show ? `显示流「${name}」` : `隐藏流「${name}」`);
      } else {
        pushHistory();
        localApply();
      }

      if (!show) {
        const count = edgesRef.current.filter((e) => e.source === id || e.target === id).length;
        notify(
          count
            ? `已隐藏，${count} 条连线一并收起，恢复时还原`
            : '已从画布移除（流仍在左侧列表中）',
          'info'
        );
      } else {
        notify('已显示到画布', 'ok');
      }
    },
    [exitEdit, pushHistory, setNodes, notify, seApplyVisibility, setCenter, getZoom]
  );

  // 画布侧删除 = 从画布移除（语义分层）；真正删除流只走侧边栏 deleteStream。
  const removeFromCanvas = useCallback(
    (id) => toggleStreamCanvas(id, false),
    [toggleStreamCanvas]
  );

  /**
   * 期 5 级联：把一批流上的 `edge.<old>` 改写为 `edge.<new>`（保留原标签），
   * 重投影后与期望比对，返回差异列表。幂等（按 key set/remove），供「重试」复用。
   */
  const rewriteEdgeRefs = useCallback(
    async (client, sid, old, newName, refs) => {
      // B2：逐条容错（失败不抛）——失败项成为 diff（actual = 错误），仍继续重投影。
      // 每条写 RPC 前就近 markSelfWrite（TTL 仅 2s）：级联元数据事件按各来源流名发出，不标会被对账误吞。
      const failures = await applyRenameCascade(client, old, newName, refs, (source) => se.markSelfWrite(sid, source));
      const projected = await se.reproject(sid);
      const diffs = diffEdgeRefs(
        projected,
        refs.map((r) => ({
          source: r.source === old ? newName : r.source,
          target: newName,
          label: r.label,
        }))
      );
      return mergeCascadeDiffs(diffs, failures);
    },
    []
  );

  /** 期 5 级联：清除指向 target 的入边标签 `edge.<target>`，重投影后返回差异列表。 */
  const removeInboundRefs = useCallback(
    async (client, sid, target, refs) => {
      // B2：逐条容错（失败不抛）——失败项成为 diff（actual = 错误），仍继续重投影。
      // 每条写 RPC 前就近 markSelfWrite（TTL 仅 2s）：级联元数据事件按各来源流名发出，不标会被对账误吞。
      const failures = await applyDeleteCascade(client, target, refs, (source) => se.markSelfWrite(sid, source));
      const projected = await se.reproject(sid);
      const diffs = diffEdgeRefs(
        projected,
        refs.map((r) => ({ source: r.source, target, label: null }))
      );
      return mergeCascadeDiffs(diffs, failures);
    },
    []
  );

  /** 级联差异对话框「重试」：再跑一次差量修正（幂等）；B2：绝不 reject，异常必 notify。 */
  const retryCascade = useCallback(async () => {
    const c = cascadeRepair;
    if (!c) return;
    try {
      const client = sePool.get(String(c.systemId));
      if (client.status !== SE_STATUS.ONLINE) {
        notify('系统离线，无法重试级联修正', 'warn');
        return;
      }
      const diffs =
        c.kind === 'delete'
          ? await removeInboundRefs(client, c.systemId, c.target, c.refs)
          : await rewriteEdgeRefs(client, c.systemId, c.oldName, c.newName, c.refs);
      if (diffs.length) setCascadeRepair({ ...c, diffs });
      else {
        setCascadeRepair(null);
        notify('级联修正已收敛', 'ok');
      }
    } catch (err) {
      notify(`级联重试失败：${(err && err.message) || err}`, 'warn');
    }
  }, [cascadeRepair, rewriteEdgeRefs, removeInboundRefs, notify]);

  /** 级联差异对话框「放弃」：关窗并 notify 保留差异（绝不静默收尾）。 */
  const discardCascade = useCallback(() => {
    const c = cascadeRepair;
    setCascadeRepair(null);
    if (c) notify(`已放弃级联修正，保留 ${c.diffs.length} 项差异`, 'warn');
  }, [cascadeRepair, notify]);

  /** 悬空边逐条「清除」：remove_tag(source, edge.<target>) + 重投影。 */
  const clearDangling = useCallback(
    async (row) => {
      const sid = activeSystemIdRef.current;
      const client = sePool.get(String(sid));
      if (client.status !== SE_STATUS.ONLINE) {
        notify('系统离线，无法清除悬空边', 'warn');
        throw new Error('系统离线');
      }
      se.markSelfWrite(sid, row.source);
      await client.call('stream.remove_tag', { name: row.source, key: edgeTagKey(row.target) });
      await se.reproject(sid);
    },
    []
  );

  /**
   * B3：rename 后把旧 name 的投影节点与缓存迁移到新 name。
   * `projectStreams` 按**新 id** 查 prev 缓存，若不迁移：节点找不到坐标 → 落到默认中心
   * （跳位）、内容缓存被丢弃 → 异步重读前空白闪烁。这里在重投影前把 `s-<old>` 节点以
   * 新 id 放回 `nodesRef`（保留 position/style/data.content），并迁移 seKey 缓存。
   */
  /**
   * 缓存按 name re-key：`s-<oldName>` 相关的一切 seKey 缓存迁移到 `newName`。
   * 抽自 migrateStreamIdentity，供 rename（oldName→newName）与 promote（oldName=null）复用。
   */
  const rekeyStreamCaches = useCallback((sid, oldName, newName) => {
    se.baselineRekey(sid, oldName, newName);
    // 常驻布局表同步 re-key（promote 传 oldName=null → 无旧条目可搬）。
    const t = sid ? layoutRef.current[String(sid)] : null;
    if (t && oldName && newName && oldName !== newName && t[oldName]) {
      t[newName] = t[oldName];
      delete t[oldName];
    }
  }, []);

  /**
   * 泛化版身份迁移：任意 `oldId → newId`（rename 用 `s-old→s-new`；promote 用 `n-*→s-<name>`）。
   * 只处理节点 id + seKey 缓存 re-key（oldName=null 时 re-key 为 no-op）。边重写由调用方
   * 按各自语义处理（rename 走 SE tag 级联；promote 走本地边端点替换）。
   */
  const migrateNodeIdentity = useCallback(
    (sid, oldId, newId, oldName, newName) => {
      const migrated = nodesRef.current.map((n) =>
        String(n.id) === String(oldId)
          ? {
              ...n,
              id: newId,
              // 改名必须原子更新 data.name；不能等 reproject（cascade 失败/自动保存窗口
              // 会留下 id 新、name 旧、layout 键错位的状态）。
              ...(newName != null
                ? { data: { ...(n.data || {}), name: String(newName) } }
                : {}),
            }
          : n
      );
      // 同步 ref（后续 reproject 同步读取）与 state（React Flow 渲染真源）。
      nodesRef.current = migrated;
      setNodes(migrated);
      rekeyStreamCaches(sid, oldName, newName);
      // 分页/折叠缓存按 owner scope + nodeId 建键，必须随身份迁移；否则新 id 丢页码、旧 id 残留。
      const viewScope = activeTabIdRef.current;
      rekeyNodeState(viewScope, oldId, newId);
      rekeyFoldsForNode(viewScope, oldId, newId);
    },
    [setNodes, rekeyStreamCaches]
  );

  const migrateStreamIdentity = useCallback(
    (sid, oldName, newName) => {
      migrateNodeIdentity(sid, streamNodeId(oldName), streamNodeId(newName), oldName, newName);
    },
    [migrateNodeIdentity]
  );

  /**
   * 期 5（#8）：改流名 name（名称即 SE 标识；触发边键级联；**不进 undo 栈**）。
   * 校验与 pre-op 快照 → 弹出应用内确认框（确认前**零副作用**）；确认后由
   * `doRenameConfirmed` 执行 `stream.rename` → 身份迁移 + 本地边端点改写 → 边键级联 → 校验。
   */
  const renameStreamName = useCallback(
    async (id, newNameRaw) => {
      // FIX-1：改标识会改节点 id（s-<old>→s-<new>），必须先在旧 id 上退出内容编辑并提交，
      // 否则 MkHost 因 editingNodeId 仍是旧 id 而卸载、未 flush 的编辑丢失，且后续
      // enterEdit 会对已不存在的旧流名发起写。与 deleteStream 同口径。
      if (editingIdRef.current === id) {
        exitEdit(true);
        // 关键：exitEdit 的 SE 提交是异步的；不 await 就 rename，提交会打到旧名字上丢失。
        const commit = exitCommitRef.current;
        if (commit) {
          try {
            const res = await commit;
            if (res && res.ok === false && res.reason !== 'unchanged') {
              notify('内容提交未完成，已取消改名；请先处理提交冲突', 'warn');
              return;
            }
          } catch (err) {
            notify(`内容提交失败，已取消改名：${(err && err.message) || err}`, 'warn');
            return;
          }
        }
      }
      const old = streamNameFromId(id);
      const newName = String(newNameRaw || '').trim();
      const sid = activeSystemIdRef.current;
      if (!old || !sid) return;
      const nameErr = streamNameError(newName);
      if (nameErr) {
        notify('名称不合法：仅字母/数字/下划线（支持中文），不得以数字开头或命中保留后缀', 'warn');
        return;
      }
      if (newName === old) return;
      const node = nodesRef.current.find((n) => String(n.id) === String(id));
      const scanState = node?.data?.scan?.state;
      if (scanState === 'scanning' || scanState === 'paused') {
        notify('扫描进行中，无法改名；请先结束扫描', 'warn');
        return;
      }
      if (Array.isArray(node?.data?.processes) && node.data.processes.length) {
        notify('存在运行中的进程，无法改名；请先停止进程', 'warn');
        return;
      }
      const client = sePool.get(String(sid));
      if (client.status !== SE_STATUS.ONLINE) {
        notify('系统离线，无法改名', 'warn');
        return;
      }
      // pre-op 快照（含 tags）：既做查重，又做级联引用集。
      let preList;
      try {
        preList = await client.call('stream.list', {});
      } catch (err) {
        notify(`读取流列表失败：${(err && err.message) || err}`, 'warn');
        return;
      }
      if (Array.isArray(preList) && preList.some((s) => s && s.name === newName)) {
        notify(`流名称「${newName}」已存在`, 'warn');
        return;
      }
      // 期 12（D1）：统一入边引用口径（复用 se/edges.collectInboundRefs）；rename 含自环
      // （excludeSelf 缺省 false），与级联改写 `edge.<old>`→`edge.<new>` 的覆盖范围一致。
      const refs = collectInboundRefs(preList, old);
      // 走应用内确认框而非原生 confirm（原生模态会打断指针手势，诱发 autoPan/视口漂移）；
      // 确认前不做任何可变副作用，取消即零成本返回。
      setRenameConfirm({ old, newName, sid, refs });
    },
    [exitEdit, notify]
  );

  /**
   * rename 确认后的执行体（由确认框「确认改名」按钮触发）：
   * markSelfWrite → `stream.rename`（already-exists → G-1 对话框）→ 身份迁移 +
   * 本地边端点改写 → 边键级联 → 重投影校验 → 差异走 CascadeRepairDialog。
   */
  const doRenameConfirmed = useCallback(
    async (pending) => {
      const { old, newName, sid, refs } = pending;
      const client = sePool.get(String(sid));
      if (client.status !== SE_STATUS.ONLINE) {
        notify('系统离线，无法改名', 'warn');
        return;
      }
      try {
        // rename 的 on_change 事件以**新名**发出，须在 RPC 前就近标记自写
        // （markSelfWrite TTL 仅 2s，不能提前批量标记），否则对账把自己的改名误当外部变更。
        se.markSelfWrite(sid, newName);
        await client.call('stream.rename', { old_name: old, new_name: newName });
        // rename 已提交：让所有持有旧 stream.list 的在飞投影作废，避免旧列表
        // 在迁移后落地并把 s-<new> 删掉/把 s-<old> 加回来。
        se.bumpProjectionEpoch?.(sid);
      } catch (err) {
        const already =
          (err && err.data && err.data.kind === 'already-exists') ||
          (err && err.code === -32603 && /exist/i.test((err && err.message) || ''));
        if (already) setRenameConflict({ oldName: old, newName, message: '目标名存在残留，请换名' });
        else notify(`改名失败：${(err && err.message) || err}`, 'warn');
        return;
      }
      // B3：先迁移 base + 派生内部流的身份/缓存，再做级联重投影，避免跳位与内容闪烁。
      // SE 的 stream.rename 会自动迁移 `_console`/`_scan_log`；前端节点 id/data.name
      // 与 page/fold 缓存必须同步迁移，否则这些流会在重投影时被当成“旧节点删除”。
      const idMap = {};
      const nameMap = {};
      const oldBaseId = streamNodeId(old);
      const newBaseId = streamNodeId(newName);
      idMap[oldBaseId] = newBaseId;
      nameMap[oldBaseId] = newName;
      migrateStreamIdentity(sid, old, newName);
      for (const suffix of INTERNAL_SUFFIXES) {
        const oldDerived = `${old}${suffix}`;
        const newDerived = `${newName}${suffix}`;
        const oldDerivedId = streamNodeId(oldDerived);
        const newDerivedId = streamNodeId(newDerived);
        idMap[oldDerivedId] = newDerivedId;
        nameMap[oldDerivedId] = newDerived;
        migrateStreamIdentity(sid, oldDerived, newDerived);
      }
      // 本地边端点同步换 id（与 promote 路径同口径）：否则旧边 source/target 仍指 s-<old>，
      // 整个改名/级联窗口内 React Flow 因端点缺失而停止渲染这些边（悬空）。
      let rewritten = edgesRef.current;
      for (const [from, to] of Object.entries(idMap)) {
        rewritten = rewriteEdgesForIdSwap(rewritten, from, to);
      }
      if (rewritten !== edgesRef.current) {
        edgesRef.current = rewritten;
        setEdges(rewritten);
      }

      // 同一 SE 系统的其他 in-app tab：迁移 store 快照、强制下次保存、清空撤销历史。
      // 仅改 active tab 会留下 s-old 快照；其他 tab 下一次自动保存会把旧 id 写回 .se.json。
      for (const t of tabsRef.current) {
        if (t.system?.system_id !== sid) continue;
        delete graphSyncRef.current[t.id];
        undoRef.current[t.id] = { undo: [], redo: [] };
        if (t.id === activeId) continue;
        const g = storeRef.current[t.id];
        if (!g) continue;
        storeRef.current[t.id] = {
          ...g,
          nodes: (g.nodes || []).map((n) => {
            const nextId = idMap[String(n.id)];
            if (!nextId) return n;
            return {
              ...n,
              id: nextId,
              data: { ...(n.data || {}), name: nameMap[String(n.id)] },
            };
          }),
          edges: (g.edges || []).map((e) => ({
            ...e,
            source: idMap[String(e.source)] ?? e.source,
            target: idMap[String(e.target)] ?? e.target,
          })),
        };
      }

      let diffs = [];
      let cascadeError = null;
      try {
        diffs = await rewriteEdgeRefs(client, sid, old, newName, refs);
      } catch (err) {
        // B2：级联层已逐条容错；意外异常也不能吞掉重投影，否则 data.name/source 可能停在中间态。
        cascadeError = err;
        try {
          await se.reproject(sid);
        } catch (reprojErr) {
          console.warn('改名后重投影失败', reprojErr);
        }
      }

      // 强制保存：把身份/名称/source 意图落盘；owned-source reconcile 会在保存管线里
      // 执行唯一的镜像文件迁移（本次改名不再直接 move）。
      try {
        stashActive();
        const out = await syncGraphFiles({ ...storeRef.current });
        const r = out && out.results ? out.results[activeId] : null;
        if (r && !r.ok && r.reason !== 'unchanged') {
          notify(`改名已生效，但保存失败：${r.error || r.reason || '未知'}`, 'warn');
        }
      } catch (err) {
        notify(`改名已生效，但保存失败：${(err && err.message) || err}`, 'warn');
      }

      notify(`已将流「${old}」改名为「${newName}」`, 'ok');
      se.clearDeleted?.(sid, newName); // 新名字若曾 tombstone，改名后应正常投影
      if (cascadeError) {
        notify(`改名已生效，但边级联失败：${(cascadeError && cascadeError.message) || cascadeError}`, 'warn');
        return;
      }
      if (diffs.length) setCascadeRepair({ diffs, kind: 'rename', systemId: sid, oldName: old, newName, refs });
    },
    [notify, migrateStreamIdentity, rewriteEdgeRefs, setEdges, activeId, stashActive, syncGraphFiles]
  );

  /**
   * 期 12（D2/F1）：打开流删除确认框。绑定在线时以**服务端 `stream.list` 真源**抓取入边引用
   * （排除自环），使提示计数与删除级联实际清除数严格一致（消除画布派生的自环 ±1 与隐藏流漏报）；
   * 未绑定走本地画布计数。抓取到的 refs 随确认框状态保存，确认时直接复用于删除（净 RPC 数不变）。
   */
  const openDeleteStream = useCallback(
    async (id) => {
      const name = streamNameFromId(id);
      const sid = activeSystemIdRef.current;
      const s = streamList.find((x) => String(x.id) === String(id));
      const title = s ? s.name : '';
      const node = nodesRef.current.find((n) => String(n.id) === String(id));
      const sourcePath = node && node.data && node.data.source ? node.data.source.file_path : '';
      // 跨图谱正文不属于本文档：不提供“连同正文删除”，避免误删他图文件。
      const showFileOption = !isCrossGraphSource(sourcePath, docBaseOf(activeTab));
      const boundOnline =
        !!name &&
        !!sid &&
        !systemOfflineRef.current &&
        sePool.get(String(sid)).status === SE_STATUS.ONLINE;
      if (!boundOnline) {
        // 本地模式：画布派生入边即真源（无服务端边标签概念）。
        setStreamDelete({ id, name, title, refs: null, localInbound: s ? s.inbound || 0 : 0, showFileOption });
        return;
      }
      const client = sePool.get(String(sid));
      let preList;
      try {
        preList = await client.call('stream.list', {});
      } catch (err) {
        notify(`读取流列表失败：${(err && err.message) || err}`, 'warn');
        return;
      }
      const refs = collectInboundRefs(preList, name, { excludeSelf: true });
      setStreamDelete({ id, name, title, refs, showFileOption });
    },
    [streamList, notify, activeTab]
  );

  // 删除流的磁盘副作用：mode='file' 时删正文文件。best-effort（任何失败不抛错、不阻断删除主流程）。
  // journal 处置已收归 SE 内核（Tier-1：关停终态快照保证删除耐久；孤儿 journal 由
  // SE 在 create 时归档收养），前端不再旁路 unlink（Windows 句柄占用必失败 + 绕过 InstanceLock）。
  // 可观测性（G2）：服务端 /api/fs/delete 幂等——目标缺失返回 200 {ok:true, deleted:false}，
  // 视为成功不提示；真实失败（非 2xx / 网络异常）notify 告警；无 source 记录时 info 提示
  // （便于发现残留预存孤儿——G1 修复前会话内新建流永远没有 source）。
  const purgeStreamArtifacts = useCallback(
    async (name, source, mode, sid) => {
      if (mode === 'keep') return;
      const cfgDir = configDirOf(workDocPathOf(activeTab));
      const fp = source && source.file_path ? source.file_path : '';
      if (!fp) {
        notify(`流「${name}」无关联正文文件记录，仅移除画布节点`, 'info');
        return;
      }
      if (isCrossGraphSource(fp, docBaseOf(activeTab))) {
        notify(`流「${name}」的正文属于其他图谱，已保留文件：${fp}`, 'info');
        return;
      }
      const target = resolveAgainstConfigDir(fp, cfgDir);
      if (!target) return;
      try {
        const res = await fetch('/api/fs/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: target }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          notify(`删除正文文件失败：${(data && data.error) || `HTTP ${res.status}`}`, 'warn');
        }
      } catch (err) {
        notify(`删除正文文件失败：${(err && err.message) || err}`, 'warn');
      }
    },
    [activeTab, notify]
  );

  const deleteStream = useCallback(
    async (id, refs, mode = 'file') => {
      if (editingIdRef.current === id) exitEdit(true);
      const name = streamNameFromId(id);
      const sid = activeSystemIdRef.current;
      const tabId = activeTabIdRef.current;
      const node = nodesRef.current.find((n) => String(n.id) === String(id));
      const source = node && node.data && node.data.source ? node.data.source : null;
      const boundOnline =
        !!name &&
        !!sid &&
        !systemOfflineRef.current &&
        sePool.get(String(sid)).status === SE_STATUS.ONLINE;
      // 删除耐久化（复活 bug 修复）：不等 600ms 防抖自动保存，立即把「移除该节点后的画布」
      // 确定性写入 storeRef 并触发落盘——否则「删除后立刻关标签页」会让 .se.json 停在旧版本，
      // 下次从同一配置包创建时已删流复活。画布节点移除本身仍由重投影/removeNode 负责。
      const flushDeletion = async () => {
        const tid = activeId;
        if (!tid || !hydratedRef.current.has(tid)) return;
        // 等当前投影链尾：避免把「半投影」的瞬时节点集合写盘（keepMissing 已保证
        // 不误删未确认流，这里只防“已确认删除 + 修复创建”交错时的半态）。
        if (sid && se.whenProjectionIdle) await se.whenProjectionIdle(sid).catch(() => {});
        if (activeTabIdRef.current !== tabId) return;
        const remainingNodes = nodesRef.current.filter((n) => String(n.id) !== String(id));
        const remainingEdges = edgesRef.current.filter(
          (e) => String(e.source) !== String(id) && String(e.target) !== String(id)
        );
        // 删到空属用户显式清空：标记以通过 B3 空写护栏（否则最后一流删除无法落盘）。
        if (!persistableNodes(remainingNodes).length) explicitEmptySaveRef.current.add(tid);
        storeRef.current = {
          ...storeRef.current,
          [tid]: {
            ...(storeRef.current[tid] || {}),
            ...snapshotOf(remainingNodes, remainingEdges, !!sid),
            tools: toolsRef.current || {},
          },
        };
        await syncGraphFiles(storeRef.current).catch(() => {});
      };
      // refs 为数组表示来自绑定在线的确认框；若此刻已离线则不静默回落本地删除。
      if (!boundOnline) {
        if (Array.isArray(refs)) {
          notify('系统离线，无法删除流', 'warn');
          return;
        }
        await purgeStreamArtifacts(name, source, mode, sid);
        if (activeTabIdRef.current === tabId) removeNode(id);
        await flushDeletion();
        return;
      }
      const client = sePool.get(String(sid));
      // 优先复用确认框抓取的 refs（提示==级联）；缺失时兜底重抓。
      let useRefs = Array.isArray(refs) ? refs : null;
      if (!useRefs) {
        let preList;
        try {
          preList = await client.call('stream.list', {});
        } catch (err) {
          notify(`读取流列表失败：${(err && err.message) || err}`, 'warn');
          return;
        }
        useRefs = collectInboundRefs(preList, name, { excludeSelf: true });
      }
      try {
        // 删除的生命周期事件携带被删 name，须就近标记自写（TTL 仅 2s），否则对账会把自己的删除误当外部变更。
        se.markSelfWrite(sid, name);
        await client.call('stream.delete', { name });
      } catch (err) {
        if (!isStreamNotFoundError(err)) {
          notify(`删除流失败：${(err && err.message) || err}`, 'warn');
          return;
        }
        // 目标已不存在 = 删除后置条件已满足；仍须完成本地 tombstone / 节点移除 / 快照写盘。
        notify(`流「${name}」在 SE 中已不存在，已清理本地记录`, 'info');
      }
      // 显式删除意图：唯一允许投影移除该流的凭据（缺失≠删除）。
      se.noteDeleted(sid, name, 'user');
      se.baselineDelete(sid, name);
      await purgeStreamArtifacts(name, source, mode, sid);
      // 自写标记会抑制删除事件的重投影（handleSeStreamChange: structural + isSelfWrite → return），
      // 因此在线删除必须显式移除节点，不能只等 SE 事件。
      const sameTab = activeTabIdRef.current === tabId;
      if (sameTab) removeNode(id);
      // 入边级联（不进 undo 栈）：清除其它流上的 edge.<name>；出边随流死亡。
      let diffs = [];
      try {
        diffs = await removeInboundRefs(client, sid, name, useRefs);
      } catch (err) {
        // B2：级联层已逐条容错；此处兜底意外异常，绝不静默收尾。
        notify(`删除流入边清理失败：${(err && err.message) || err}`, 'warn');
        return;
      }
      if (sameTab) {
        notify(`已删除流「${name}」${useRefs.length ? `，并清除 ${useRefs.length} 条入边` : ''}`, 'ok');
        await flushDeletion();
      }
      if (diffs.length) setCascadeRepair({ diffs, kind: 'delete', systemId: sid, target: name, refs: useRefs });
    },
    [exitEdit, removeNode, notify, removeInboundRefs, purgeStreamArtifacts, persistableNodes, syncGraphFiles, activeId]
  );

  /**
   * R2：批量清理（流）。在线：`stream.list` 取一次 → 聚合入边总数 → 单次确认；确认后逐条走
   * `deleteStream(id, null)`（内部重新拉 stream.list，天然排除批内已删来源，避免对已删来源
   * remove_tag 产生假失败/悬空边）。本地/离线：单次历史快照 + 一次性过滤节点/边。
   */
  const openDeleteStreams = useCallback(
    async (ids) => {
      const idList = Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
      if (!idList.length) return;
      const sid = activeSystemIdRef.current;
      const boundOnline =
        !!sid && !systemOfflineRef.current && sePool.get(String(sid)).status === SE_STATUS.ONLINE;
      const rows = idList
        .map((id) => streamList.find((s) => String(s.id) === id))
        .filter(Boolean);
      const title = `${rows.length} 个流`;
      const byId = new Map(nodesRef.current.map((n) => [String(n.id), n]));
      // 批内任一流的正文属于其他图谱 → 不提供“连同正文删除”。
      const showFileOption = !idList.some((id) => {
        const n = byId.get(id);
        const sourcePath = n && n.data && n.data.source ? n.data.source.file_path : '';
        return isCrossGraphSource(sourcePath, docBaseOf(activeTab));
      });
      if (!boundOnline) {
        const inboundCount = rows.reduce((sum, s) => sum + (s.inbound || 0), 0);
        setStreamDeleteMany({ ids: idList, title, online: false, inboundCount, showFileOption });
        return;
      }
      const client = sePool.get(String(sid));
      let preList;
      try {
        preList = await client.call('stream.list', {});
      } catch (err) {
        notify(`读取流列表失败：${(err && err.message) || err}`, 'warn');
        return;
      }
      let inboundCount = 0;
      rows.forEach((s) => {
        const name = streamNameFromId(s.id);
        if (name) inboundCount += collectInboundRefs(preList, name, { excludeSelf: true }).length;
      });
      setStreamDeleteMany({ ids: idList, title, online: true, inboundCount, showFileOption });
    },
    [streamList, notify, activeTab]
  );

  const confirmDeleteStreams = useCallback(async (mode) => {
    const payload = streamDeleteMany;
    if (!payload) return;
    setStreamDeleteMany(null);
    const { ids, online } = payload;
    const sid = activeSystemIdRef.current;
    const boundOnline =
      !!sid && !systemOfflineRef.current && sePool.get(String(sid)).status === SE_STATUS.ONLINE;
    if (online) {
      if (!boundOnline) {
        notify('系统离线，无法删除流', 'warn');
        return;
      }
      // 顺序删除；refs=null 让 deleteStream 内部重新拉取 stream.list，正确排除批内已删来源。
      for (const id of ids) {
        await deleteStream(id, null, mode);
      }
      return;
    }
    // 本地/离线：先按档位清磁盘副作用，再一次历史快照 + 过滤节点/边。
    for (const id of ids) {
      const node = nodesRef.current.find((n) => String(n.id) === String(id));
      await purgeStreamArtifacts(
        streamNameFromId(id),
        node && node.data ? node.data.source : null,
        mode,
        sid
      );
    }
    pushHistory();
    setNodes((nds) => nds.filter((n) => !ids.includes(String(n.id))));
    setEdges((eds) =>
      eds.filter((e) => !ids.includes(String(e.source)) && !ids.includes(String(e.target)))
    );
    notify(`已删除 ${ids.length} 个流`, 'ok');
  }, [streamDeleteMany, pushHistory, setNodes, setEdges, notify, deleteStream, purgeStreamArtifacts]);

  // 新建流：已绑定在线系统经 registerEntries 单边清单 seam 注册（planImport+applyImport）；
  // 未绑定/离线保持原本地行为（落到视口中心并选中）。content（R-3.1 可空）：
  // 在线 = 新建成功播种版本+正文并 flush 重投影；离线 = 直接落到本地节点 data。
  const createStream = useCallback(
    async ({ name, description, tags, content, source }) => {
      const trimmed = String(name == null ? '' : name).trim();
      if (!trimmed) return;
      if (streamNameError(trimmed)) {
        notify('名称不合法：仅字母/数字/下划线（支持中文），不得以数字开头或命中保留后缀', 'warn');
        return;
      }
      const body = content == null ? '' : String(content);
      // 流来源（从文件/清单导入时登记）：透传到节点 data.source，
      // planDocumentSources「已有 source 即保留」使自动保存写回真实路径。
      const srcRef =
        source && source.file_path
          ? {
              file_path: String(source.file_path).replace(/\\/g, '/'),
              encoding: source.encoding ? String(source.encoding) : 'utf-8',
            }
          : null;
      const sid = activeSystemIdRef.current;
      const boundOnline =
        !!sid &&
        !systemOfflineRef.current &&
        sePool.get(String(sid)).status === SE_STATUS.ONLINE;
      if (boundOnline) {
        // 碰撞守卫（与原 stream.create 的 already-exists 行为一致）：SE 已有同名流 → 拒绝创建，
        // 避免经 applyImport 的 update 分支（保守视为变更→stream.write）覆盖既有流正文。
        const client0 = sePool.get(String(sid));
        const slist = await client0.call('stream.list', {}).catch(() => []);
        const existingStreamNames = new Set(
          (Array.isArray(slist) ? slist : Object.values(slist || {}))
            .map((s) => (s && typeof s === 'object' ? String(s.name || '') : String(s)))
            .filter(Boolean)
        );
        if (existingStreamNames.has(trimmed)) {
          notify(`已存在同名流「${trimmed}」；如需修改请直接编辑该流`, 'warn');
          return;
        }
        const clean = normalizeFields(tags).filter((f) => f.key && !isReservedTagKey(f.key));
        const tagObj = fieldsToTags(clean);
        const streamEntry = { name: trimmed };
        if (description) streamEntry.description = String(description);
        if (Object.keys(tagObj).length) streamEntry.tags = tagObj;
        // 空正文也要入 contents（applyImport 的 new 分支要求 hasText，否则拒绝创建）。
        const contents = new Map([[trimmed, body]]);
        const manifest = buildStreamsOnlyManifest([streamEntry], String(sid));
        const res = await registerEntries({
          systemId: String(sid),
          manifest,
          contents,
          selection: { streamNames: [trimmed] },
          strategy: 'overwrite',
          createOnly: true,
        });
        if (!res.ok) {
          notify(`创建流失败：${res.error || 'SE 运行时未就绪'}`, 'warn');
          return;
        }
        // 失败守卫：applyImport 的 stream.write 失败记 errors 但不计 failed（Task 2 评审结论），
        // 故 failed 或 errors 任一非零都视为失败，避免对半成功状态播种假同步基线。
        const sSum = res.summary.streams;
        if (sSum.failed > 0 || (res.summary.errors && res.summary.errors.length > 0)) {
          notify(res.summary.errors[0] || '创建流失败', 'warn');
          return;
        }
        if (sSum.skipped > 0) {
          // 同名已存在（碰撞守卫的 list 判定失败或并发创建）：未写入正文，绝不播种 version 0 假基线。
          notify(`已存在同名流「${trimmed}」，未新建；如需修改请直接编辑该流`, 'warn');
          return;
        }
        if (!(sSum.created > 0)) {
          notify(`创建流失败：未发生新建；如需修改请直接编辑该流`, 'warn');
          return;
        }
        // 仅当 applyImport 给出可信 version（目标内容状态已确立）才播种 CAS 基线与本地正文；
        // 版本缺失/初始化冲突时一律跳过播种，交由 SE 读回兜底。
        const version = sSum.versions ? sSum.versions[trimmed] : undefined;
        const initialized = version != null;
        if (initialized) {
          se.baselineSet(sid, trimmed, version, body);
        } else {
          const conflict = Array.isArray(sSum.conflicts) ? sSum.conflicts[0] : null;
          notify(
            (res.summary.warnings && res.summary.warnings[0]) ||
              `流「${trimmed}」已创建，但正文初始化未确认${
                conflict && conflict.reason ? `（${conflict.reason}）` : ''
              }；将以 SE 读回为准`,
            'warn'
          );
        }
        se.clearDeleted?.(sid, trimmed); // 同名重建：撤销旧删除 tombstone
        // 服务端为唯一真源：不本地乐观插入；等对账投影出新节点后按 name 选中（并登记来源）。
        await se.coordinatorFlush(String(sid), 'post-create');
        setNodes((nds) => {
          const next = nds.map((n) => {
            const hit = String(n.id) === streamNodeId(trimmed);
            if (!hit) return n.selected ? { ...n, selected: false } : n;
            return {
              ...n,
              selected: true,
              data: {
                ...n.data,
                ...(srcRef ? { source: srcRef } : {}),
                ...(initialized ? { content: body, contentState: 'loaded' } : {}),
              },
            };
          });
          nodesRef.current = next;
          storeRef.current[activeId] = { ...(storeRef.current[activeId] || {}), nodes: next };
          return next;
        });
        notify(`已新建流「${trimmed}」`, 'ok');
        // Task 3：返回创建结果，供入口层（工具栏/双击/拖连线）在创建成功后联动（如补 SE 边）。
        return { ok: true, name: trimmed };
      }
      // 未绑定 / 离线：逃生舱语义，保持原本地行为。
      pushHistory();
      const id = `n-${nodeSeqRef.current++}`;
      const el = document.querySelector('.flow');
      const rect = el?.getBoundingClientRect();
      const center = rect
        ? screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
        : { x: 100, y: 100 };
      const fields = normalizeFields(tags);
      const canvas = toCanvasGraph({
        nodes: [
          {
            id,
            position: snapPos(center),
            data: {
              name: trimmed,
              ...(description ? { description } : {}),
              ...(body ? { content: body } : {}),
              ...(fields.length ? { fields } : {}),
              ...(srcRef ? { source: srcRef } : {}),
            },
          },
        ],
        edges: [],
      });
      canvas.nodes.forEach((n) => {
        n.selected = true;
      });
      setNodes((nds) => [...nds.map((n) => (n.selected ? { ...n, selected: false } : n)), ...canvas.nodes]);
      notify(`已新建流「${trimmed}」`, 'ok');
      // Task 3：本地逃生舱同样返回结果，local=true 供入口层区分（本地创建不补 SE 边）。
      return { ok: true, name: trimmed, local: true };
    },
    [pushHistory, screenToFlowPosition, setNodes, notify, registerEntries]
  );

  /**
   * pending → SE 流自动提升（方案 §4.2，串行、单节点）。
   *
   * 时序（规避重投影 removedIds 的关键）：
   *  ① SE 先落库（`stream.create` + 正文 + tags，播种 CAS 基线）；
   *  ② 成功后才把本地节点 id `n-* → s-<name>`（并 re-key 缓存、改写本地边端点）；
   *  ③ 最后重投影。重投影的 `locals = prev.filter(!startsWith('s-'))` 只保留 pending、`removedIds`
   *     只移除 list 中不存在的 `s-*`——② 之后本节点已是 `s-`，且其流已在 ① 存在于 list，
   *     故绝不会被当「已删除」移除；反之若先换 id 再落库，则 ③ 会因 list 无此名而把它移除。
   *
   * 纪律：不入 undo 栈（不调 pushHistory）；nodeSeqRef 只读不写；失败保持 pending、notify 一次
   * 原因、不抛异常。
   *
   * @param {string} sidRaw system_id
   * @param {string} nodeIdRaw pending 节点 id（提升前）
   * @param {{batch?:boolean, ctx?:{taken:Set<string>}}} [opts] batch=true 时抑制逐点失败 notify（批量汇总）
   * @returns {Promise<{status:'promoted'|'skipped'|'failed', name?:string, renamed?:boolean, reason?:string, error?:string}>}
   */
  const promoteLocalNode = useCallback(
    async (sidRaw, nodeIdRaw, opts = {}) => {
      const sid = String(sidRaw);
      const oldId = String(nodeIdRaw);
      const tabId = activeTabIdRef.current;
      // 只提升当前活动画布（nodesRef/setNodes 都指向活动 tab）。
      if (activeSystemIdRef.current !== sid) return { status: 'skipped', reason: 'inactive' };
      const client = sePool.get(sid);
      if (!client || client.status !== SE_STATUS.ONLINE || systemOfflineRef.current) {
        if (!opts.batch) notify('系统离线，待同步节点将保持本地草稿', 'warn');
        return { status: 'skipped', reason: 'offline' };
      }
      const node = nodesRef.current.find((n) => String(n.id) === oldId);
      if (!node) return { status: 'skipped', reason: 'missing' };
      if (!isPendingNode(node)) return { status: 'skipped', reason: 'already-se' };
      // ① 驱动门控：scan / process 非空闲则跳过本次（留待下一事件），不报错。
      const scanState = node.data?.scan?.state;
      if (scanState === 'scanning' || scanState === 'paused') return { status: 'skipped', reason: 'scanning' };
      const procs = Array.isArray(node.data?.processes) ? node.data.processes : [];
      if (procs.length > 0) return { status: 'skipped', reason: 'busy-process' };

      // ② 名字推导：taken = 画布 s-* ∪ SE 流名 ∪ 本次批量已分配名。
      let taken = opts.ctx && opts.ctx.taken;
      if (!taken) {
        let list = [];
        try {
          list = await client.call('stream.list', {});
        } catch (err) {
          /* 列表失败按空 taken（后续 create 的 already-exists 守卫兜底） */
        }
        taken = collectTakenNames(
          nodesRef.current,
          (Array.isArray(list) ? list : []).map((s) => s && s.name).filter(Boolean)
        );
      }
      const { name, raw, renamed } = derivePromoteName(node, taken);
      taken.add(name);

      // ③ SE 创建：tags = fields（去保留键）；正文空也要入 contents（applyImport 要求键存在）。
      const fields = normalizeFields(node.data?.fields).filter((f) => f.key && !isReservedTagKey(f.key));
      const tags = fieldsToTags(fields);
      const body = node.data?.content == null ? '' : String(node.data.content);
      const description = node.data?.description == null ? '' : String(node.data.description);
      const entry = { name };
      if (description) entry.description = description;
      if (Object.keys(tags).length) entry.tags = tags;
      const contents = new Map([[name, body]]);
      const manifest = buildStreamsOnlyManifest([entry], sid);

      const failPromote = (msg) => {
        if (!opts.batch) notify(`同步到 SE 失败：${msg}`, 'warn');
        return { status: 'failed', error: msg };
      };

      let res;
      try {
        res = await registerEntries({
          systemId: sid,
          manifest,
          contents,
          selection: { streamNames: [name] },
          strategy: 'overwrite',
          createOnly: true,
        });
      } catch (err) {
        return failPromote((err && err.message) || String(err));
      }
      if (!res || !res.ok) return failPromote((res && res.error) || 'SE 运行时未就绪');
      const sSum = res.summary && res.summary.streams ? res.summary.streams : {};
      const errs = res.summary && Array.isArray(res.summary.errors) ? res.summary.errors : [];
      if (sSum.failed > 0 || errs.length > 0) return failPromote(errs[0] || '写入 SE 失败');
      if (sSum.skipped > 0) return failPromote(`已存在同名流「${name}」`);
      if (!(sSum.created > 0)) return failPromote(`未发生新建「${name}」`);

      // 异步创建期间用户可能已切走 tab：绝不再改当前画布 / 当前 store。
      if (activeTabIdRef.current !== tabId || activeSystemIdRef.current !== sid) {
        return { status: 'skipped', reason: 'tab-changed' };
      }

      // 仅当 applyImport 返回可信 version 时才播种 CAS 基线；版本缺失/初始化冲突一律跳过，
      // 依赖 SE 读回，且不把本地草稿标记为已同步。
      const version = sSum.versions ? sSum.versions[name] : undefined;
      const initialized = version != null;
      if (initialized) {
        se.baselineSet(sid, name, version, body);
      } else {
        const conflict = Array.isArray(sSum.conflicts) ? sSum.conflicts[0] : null;
        notify(
          (res.summary.warnings && res.summary.warnings[0]) ||
            `流「${name}」已创建，但正文初始化未确认${
              conflict && conflict.reason ? `（${conflict.reason}）` : ''
            }；将以 SE 读回为准`,
          'warn'
        );
      }
      se.clearDeleted?.(sid, name); // 同名提升/重建：撤销旧删除 tombstone

      // ④ 成功后换身份：node id + data.name + contentState；re-key 缓存（pending 无旧 name，no-op）；
      // 改写本地边端点。
      const newId = streamNodeId(name);
      const migrated = nodesRef.current.map((n) =>
        String(n.id) === oldId
          ? {
              ...n,
              id: newId,
              data: {
                ...(n.data || {}),
                name,
                ...(initialized ? { contentState: 'loaded' } : {}),
              },
            }
          : n
      );
      applyNodes(migrated);
      rekeyStreamCaches(sid, null, name);
      const rewritten = rewriteEdgesForIdSwap(edgesRef.current, oldId, newId);
      if (rewritten !== edgesRef.current) {
        edgesRef.current = rewritten;
        setEdges(rewritten);
      }

      // ⑤ 边标签：与刚提升节点相关、另一端已可解析为流名的边，补写 `edge.<目标>` 标签
      // （另一端仍 pending 者跳过，待其提升时由其反向补写）。失败仅告警，不回滚节点提升。
      const { selfTags, remote } = incidentEdgeTagOps({
        nodeId: newId,
        name,
        edges: rewritten,
        resolveName: streamNameFromId,
      });
      try {
        const selfKeys = Object.entries(selfTags);
        if (selfKeys.length || remote.length) se.markSelfWrite(sid, name);
        for (const [key, value] of selfKeys) {
          await client.call('stream.set_tag', { name, key, value });
        }
        for (const r of remote) {
          se.markSelfWrite(sid, r.source);
          await client.call('stream.set_tag', { name: r.source, key: r.key, value: r.value });
        }
      } catch (err) {
        console.warn('promote 边标签写入失败（节点已提升）', err);
      }

      // ⑥ 重投影：结构权威来自 SE，此处把新 s-* 流与派生边落地。
      // 流已落库、id 已换，重投影失败不回滚提升；吞错保持「失败不抛」契约（调用方均 fire-and-forget）。
      try {
        await se.reproject(sid);
      } catch (err) {
        console.warn('promote 后重投影失败（节点已提升，下次对账自愈）', err);
      }

      // ⑥b 历史隔离（undo×promote 防重复）：undo/redo 快照若仍含被提升的 n-* 节点，
      // Ctrl+Z 会把它恢复成本地节点，与 SE 投影出的 s-<name> 并存成重复节点（还会被再次提升成 _2）。
      // 与「提升不入 undo 栈」纪律一致：从该 tab 历史中剔除含 oldId 的图快照（保留其余历史）。
      const stack = undoRef.current[activeId];
      if (stack) {
        const hasOld = (e) =>
          e && e.kind === 'graph' && Array.isArray(e.snap?.nodes) &&
          e.snap.nodes.some((n) => String(n.id) === String(oldId));
        stack.undo = stack.undo.filter((e) => !hasOld(e));
        stack.redo = stack.redo.filter((e) => !hasOld(e));
      }

      if (renamed) {
        notify(`节点「${raw || '未命名'}」已同步为流「${name}」（名称已按契约调整）`, 'ok');
      } else if (!opts.batch) {
        notify(`已同步节点为流「${name}」`, 'ok');
      }
      return { status: 'promoted', name, renamed };
    },
    [notify, registerEntries, applyNodes, setEdges, rekeyStreamCaches, activeId]
  );

  /**
   * 批量串行提升当前画布全部 pending 节点（防并发建流/改 id 竞态）。
   * 触发点：tab 加载尾部、SE 重连成功、pending 角标点击（单点）。离线/非活动直接空返回（静默）。
   *
   * @returns {Promise<{promoted:number, skipped:number, failed:number}>}
   */
  const promotePendingNodes = useCallback(
    async (sidRaw) => {
      const sid = String(sidRaw);
      const empty = { promoted: 0, skipped: 0, failed: 0 };
      if (activeSystemIdRef.current !== sid) return empty;
      const client = sePool.get(sid);
      if (!client || client.status !== SE_STATUS.ONLINE || systemOfflineRef.current) return empty;
      let list;
      try {
        list = await client.call('stream.list', {});
      } catch (err) {
        return empty;
      }
      const seNames = (Array.isArray(list) ? list : []).map((s) => s && s.name).filter(Boolean);
      const ctx = { taken: collectTakenNames(nodesRef.current, seNames) };
      const targets = pendingNodes(nodesRef.current).map((n) => String(n.id));
      let promoted = 0;
      let skipped = 0;
      let failed = 0;
      for (const id of targets) {
        // 前一次提升可能已改写/移除该节点（或它已被识别为非 pending）：以最新画布为准。
        const live = nodesRef.current.find((n) => String(n.id) === id);
        if (!live || !isPendingNode(live)) continue;
        const r = await promoteLocalNode(sid, id, { batch: true, ctx });
        if (r.status === 'promoted') {
          promoted += 1;
          if (r.name) ctx.taken.add(r.name);
        } else if (r.status === 'skipped') {
          skipped += 1;
        } else {
          failed += 1;
        }
      }
      if (failed > 0) {
        notify(`有 ${failed} 个待同步节点未能提升到 SE，将在下次连接/点击角标时重试`, 'warn');
      }
      return { promoted, skipped, failed };
    },
    [promoteLocalNode, notify]
  );
  promotePendingRef.current = promotePendingNodes;

  /**
   * Task6（方案 §4.5）运行时边对齐：把**文档中两端均为 s-*** 的边补写进 SE 的
   * `edge.<目标>` 标签（唯一真源），使加载重投影后派生边回到画布。
   *
   * 触发时机：绑定 tab 加载 → pushFileStreamsToSe resolve → pending 提升完成后（提升可能
   * 新增 s-* 端点）。决策委托纯函数 `planEdgeAlignOps`（幂等：source 已有同名标签则跳过）。
   * 写路径复用 promoteLocalNode 的 set_tag + markSelfWrite 模式（串行、单条失败记日志继续）。
   * 实际写入 >0 才重投影并汇总 notify 一次；全已对齐则静默。
   *
   * @param {string} systemId
   * @param {Array<{source:string,target:string,label?:string}>} documentEdges 已并集/去重的文档边
   * @returns {Promise<{written:number, failed:number}>}
   */
  const alignDocumentEdgesToSe = useCallback(
    async (systemId, documentEdges) => {
      const empty = { written: 0, failed: 0 };
      const sid = String(systemId);
      const client = sePool.get(sid);
      if (!client || client.status !== SE_STATUS.ONLINE || systemOfflineRef.current) return empty;
      let list;
      try {
        list = await client.call('stream.list', {});
      } catch (err) {
        return empty;
      }
      const ops = planEdgeAlignOps(documentEdges, list);
      if (!ops.length) return empty;
      let written = 0;
      let failed = 0;
      for (const op of ops) {
        se.markSelfWrite(sid, op.source);
        try {
          await client.call('stream.set_tag', { name: op.source, key: op.key, value: op.value });
          written += 1;
        } catch (err) {
          failed += 1;
          console.warn('运行时边对齐写入失败', op.source, op.key, err);
        }
      }
      if (written > 0) {
        try {
          // Task6：写 tag 后的重投影走对账协调器（单飞 + 尾随），与并发的 on_change 结构对账
          // 串行化——避免 align 的直连 reproject 与协调器在飞 run 交错，导致陈旧投影落地覆盖。
          await se.coordinatorFlush(sid, 'edge-align');
        } catch (err) {
          console.warn('边对齐后重投影失败（下次对账自愈）', err);
        }
      }
      return { written, failed };
    },
    []
  );

  /**
   * Task6（重连补齐）：用**当前文档/当前画布**的边触发一次边对齐（不依赖加载时 graph 的陈旧引用）。
   *
   * 边来源（需求 2）：
   * - 优先 `storeRef.current[<该 sid 所属 tab>]` 的 canonical `graph.edges`（加载/暂存时写入的文档边）；
   * - 形状不含 edges 时才回落当前画布 `edgesRef`（仅活动系统有意义）；
   * - 非活动系统且无 canonical 文档边 → 不动作。
   * 幂等由 `planEdgeAlignOps` 保证（source 已有 `edge.<target>` 键即跳过，画布已有派生边不会重写）。
   * 写入/重投影门控与静默失败复用 `alignDocumentEdgesToSe`（client 离线即空返回）。
   *
   * @param {string} systemId
   * @returns {Promise<{written:number, failed:number}>}
   */
  const alignCurrentDocumentEdges = useCallback(
    (systemId) => {
      const empty = { written: 0, failed: 0 };
      const sid = String(systemId);
      const tab = tabsRef.current.find((t) => t.system?.system_id === sid) || null;
      if (!tab) return Promise.resolve(empty);
      const g = storeRef.current[tab.id];
      let documentEdges;
      if (g && Array.isArray(g.edges)) {
        documentEdges = collectDocumentEdges(g);
      } else if (activeSystemIdRef.current === sid) {
        documentEdges = collectDocumentEdges({ edges: edgesRef.current });
      } else {
        documentEdges = [];
      }
      if (!documentEdges.length) return Promise.resolve(empty);
      return alignDocumentEdgesToSe(sid, documentEdges);
    },
    [alignDocumentEdgesToSe]
  );
  alignEdgesRef.current = alignCurrentDocumentEdges;

  /**
   * R-3.1：文件面板选文档 → 读文本（复用 /api/fs/read）→ 打开 App 层「新建流」对话框。
   * 读取失败仍以建议名打开（用户可手填）；提交复用 createStream。
   */
  const openStreamFromFile = useCallback(
    async ({ path, suggestedName } = {}) => {
      const target = String(path || '').trim();
      if (!target) return;
      const name = String(suggestedName || fileBaseNameNoExt(target) || '').trim();
      let content = '';
      try {
        const res = await fetch('/api/fs/read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: target }),
        });
        let data = null;
        try {
          data = await res.json();
        } catch (err) {
          data = null;
        }
        if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
        content = data && data.text != null ? String(data.text) : '';
      } catch (err) {
        notify(`读取文件失败：${(err && err.message) || err}`, 'warn');
      }
      // 登记流来源（需求 2）：source 保留真实路径，自动保存经「已有 source 即保留」写回该路径。
      setStreamDraft({
        name,
        content,
        source: { file_path: target.replace(/\\/g, '/'), encoding: 'utf-8' },
      });
    },
    [notify]
  );

  /**
   * 将单条流另存为本地文件（原生保存对话框）。
   * 已绑定在线：以 SE `stream.read` 为内容真源；未绑定/离线：回落本地节点 `data.content`。
   * @param {string} id 流节点 id
   * @param {{raw?:boolean}} [opts] raw 为真时仅写纯正文 .md；否则写 .se.json 配置包 + 兄弟正文
   */
  const saveStreamToFile = useCallback(
    async (id, { raw } = {}) => {
      const item = streamList.find((s) => s.id === id);
      const displayName = item ? item.name : '';
      const description = item ? item.description : '';
      const tags = rowsToTags(item ? item.fields : []);
      const sid = activeSystemIdRef.current;
      const name = streamNameFromId(id);
      const boundOnline =
        !!name &&
        !!sid &&
        !systemOfflineRef.current &&
        sePool.get(String(sid)).status === SE_STATUS.ONLINE;
      let content = '';
      if (boundOnline) {
        try {
          const read = await sePool.get(String(sid)).call('stream.read', { name });
          content = read && read.text != null ? String(read.text) : '';
        } catch (err) {
          notify(`读取流内容失败：${(err && err.message) || err}`, 'warn');
          return;
        }
      } else {
        const node = nodesRef.current.find((n) => String(n.id) === id);
        content = node && node.data && node.data.content != null ? String(node.data.content) : '';
      }
      let path = '';
      try {
        const res = await fetch('/api/dialog/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filter: raw ? DOC_FILTER : SE_FILTER,
            defaultName: raw ? `${displayName}.md` : `${displayName}.se.json`,
            title: '另存为流文件',
          }),
        });
        let data = null;
        try {
          data = await res.json();
        } catch (err) {
          data = null;
        }
        path = data && data.path ? String(data.path) : '';
      } catch (err) {
        notify(`另存为失败：${(err && err.message) || err}`, 'warn');
        return;
      }
      if (!path) return;
      try {
        if (raw) {
          await writeFsText(path, content);
        } else {
          const baseDir = path.split(/[\\/]/).slice(0, -1).join('/');
          const { files } = buildPackage({
            displayName,
            streams: [{ name: displayName, description, tags, content }],
            tools: [],
            baseDir,
          });
          await writePackageFiles(files, path);
        }
      } catch (err) {
        notify(`另存为失败：${(err && err.message) || err}`, 'warn');
        return;
      }
      notify('已另存为 ' + path, 'ok');
    },
    [streamList, notify]
  );

  /** R-3.2：代码文件「注册为工具」——只传路径引用，绝不读取/复制内容。 */
  const openToolFromFile = useCallback(({ path, name } = {}) => {
    const target = String(path || '').trim();
    if (!target) return;
    const explicit = String(name || '').trim();
    const fallback = toToolName(fileBaseNameNoExt(target), new Set(Object.keys(toolsRef.current || {})));
    setToolDraft({ name: explicit || fallback, tool_path: target });
  }, []);

  // 元数据编辑（描述 + 标签）；已绑定在线系统：description→update_description、
  // tags→差量 set_tag/remove_tag（canvas/edge. 保留键拒绝写入）；未绑定保持本地。
  const updateStreamMeta = useCallback(
    async (id, { description, tags }) => {
      const name = streamNameFromId(id);
      const sid = activeSystemIdRef.current;
      const boundOnline =
        !!name &&
        !!sid &&
        !systemOfflineRef.current &&
        sePool.get(String(sid)).status === SE_STATUS.ONLINE;
      const desc = String(description || '').trim();
      const clean = normalizeFields(tags).filter((f) => f.key && !isReservedTagKey(f.key));
      if (boundOnline) {
        const client = sePool.get(String(sid));
        const node = nodesRef.current.find((n) => String(n.id) === id);
        se.markSelfWrite(sid, name);
        try {
          const curDesc = node && node.data && node.data.description != null
            ? String(node.data.description)
            : '';
          if (desc !== curDesc) {
            await client.call('stream.update_description', { name, text: desc });
          }
          const nextTags = fieldsToTags(clean);
          // G-3：排除全部保留键（canvas + edge.*），否则保存元数据会清空 edge 标签 = 丢边。
          const curTags = fieldsToTags(
            normalizeFields(node && node.data ? node.data.fields : []).filter(
              (f) => !isReservedTagKey(f.key)
            )
          );
          for (const [k, v] of Object.entries(nextTags)) {
            if (curTags[k] !== v) {
              await client.call('stream.set_tag', { name, key: k, value: v });
            }
          }
          for (const k of Object.keys(curTags)) {
            if (!(k in nextTags)) await client.call('stream.remove_tag', { name, key: k });
          }
          setNodes((nds) =>
            nds.map((n) => {
              if (String(n.id) !== id) return n;
              const data = { ...n.data };
              if (desc) data.description = desc;
              else delete data.description;
              const kept = normalizeFields(n.data?.fields).filter((f) => isReservedTagKey(f.key));
              const fields = [...clean, ...kept];
              if (fields.length) data.fields = fields;
              else delete data.fields;
              return { ...n, data };
            })
          );
        } catch (err) {
          notify(`更新流元数据失败：${(err && err.message) || err}`, 'warn');
        }
        return;
      }
      // 未绑定 / 离线：保持原本地行为。
      pushHistory();
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== id) return n;
          const data = { ...n.data };
          if (desc) data.description = desc;
          else delete data.description;
          const kept = normalizeFields(n.data?.fields).filter((f) => isReservedTagKey(f.key));
          const fields = [...normalizeFields(tags), ...kept];
          if (fields.length) data.fields = fields;
          else delete data.fields;
          return { ...n, data };
        })
      );
    },
    [pushHistory, setNodes, notify]
  );

  // 平移视口居中并选中节点；edit=true 时随后进入内容编辑态。
  const focusStream = useCallback(
    (id, edit = false) => {
      const node = nodesRef.current.find((n) => n.id === id);
      if (!node || !isStreamVisible(node)) return;
      const state = storeApi.getState();
      state.unselectNodesAndEdges();
      state.addSelectedNodes([id]);
      const w = Number(node.style?.width) || NODE_W;
      setCenter(node.position.x + w / 2, node.position.y + 60, {
        zoom: getZoom(),
        duration: 300,
      });
      // 进画布/聚焦：已绑定流拉取最新内容（编辑中的跳过）。
      se.readContent(id);
      if (edit) enterEdit(id);
    },
    [storeApi, setCenter, getZoom, enterEdit]
  );

  /**
   * 三态 SE 能力门（去 mock §5.2）：未绑定 → 明确拒绝「请先绑定」；绑定离线 → 「系统离线，
   * 正在重连」；绑定在线 → 返回 sid。所有 SE 能力 dispatch 统一经此判定，绝不回落本地 mock。
   * @returns {string|null} 在线时返回 String(sid)，否则已 notify 并返回 null。
   */
  const seGate = useCallback(() => {
    const sid = activeSystemIdRef.current;
    if (!sid) {
      notify('请先绑定 SE 系统', 'warn');
      return null;
    }
    if (!boundOnlineNow()) {
      notify('系统离线，正在重连', 'warn');
      return null;
    }
    return String(sid);
  }, [boundOnlineNow, notify]);

  // 工具"新建"走单边清单 seam（与导入/投影同管线）；"编辑"仍走 toolDriver.update（保留回滚）。
  const dispatchToolRegister = useCallback(
    async (def) => {
      const sid = seGate();
      if (!sid) return;
      const nd = normalizeToolDef(def);
      if (!nd) {
        notify('工具定义无效（缺 name/tool_path）', 'warn');
        return;
      }
      const opKey = `register:${sid}:${nd.name}`;
      if (toolOpsInflightRef.current.has(opKey)) {
        notify(`工具「${nd.name}」正在注册，请勿重复提交`, 'warn');
        return;
      }
      toolOpsInflightRef.current.add(opKey);
      try {
        // 捕获目标上下文：RPC/保存期间可能切换标签页或系统，副作用必须仍落在调用时的目标上。
        const tabId = activeId;
        const stillOnTarget = () =>
          activeTabIdRef.current === tabId && String(activeSystemIdRef.current || '') === sid;
        // 碰撞守卫（与原 toolDriver.register 行为一致）：SE 已注册同名 → 拒绝创建（请改用编辑），
        // 避免经 applyImport 的 update 分支（unregister→register 无回滚）覆盖既有工具。
        const client = sePool.get(sid);
        let tlist;
        try {
          tlist = await client.call('tool.list', {});
        } catch (err) {
          notify(`读取工具清单失败：${(err && err.message) || err}；未注册「${nd.name}」`, 'warn');
          return;
        }
        if (!stillOnTarget()) {
          notify(`标签页或系统已切换，未注册「${nd.name}」`, 'warn');
          return;
        }
        const existingNames = new Set(
          (Array.isArray(tlist) ? tlist : Object.values(tlist || {}))
            .map((t) => (t && typeof t === 'object' ? String(t.name || '') : String(t)))
            .filter(Boolean)
        );
        if (existingNames.has(nd.name)) {
          notify(
            `已存在同名工具「${nd.name}」；若为 SE 孤立项，请在「SE 已注册（未纳入配置）」区点「纳入配置」，否则请改用编辑`,
            'warn'
          );
          return;
        }
        // 配置意图先落盘：只有当前 tab 明确保存成功后才允许产生 SE 注册副作用。
        // 失败策略 retain：配置保留可见（不静默丢弃用户意图），但绝不注册。
        const persisted = await persistToolConfig({
          tabId,
          apply: (prev) => ({ ...prev, [nd.name]: nd }),
          failurePolicy: 'retain',
        });
        if (!persisted.ok) {
          notify(`保存工具配置失败：${persisted.reason}；未注册「${nd.name}」`, 'warn');
          return;
        }
        if (!stillOnTarget()) {
          notify(`标签页或系统已切换，未注册「${nd.name}」`, 'warn');
          return;
        }
        const manifest = buildToolsOnlyManifest({ [nd.name]: nd }, sid);
        const res = await registerEntries({
          systemId: sid,
          manifest,
          contents: new Map(),
          selection: { toolNames: [nd.name] },
          strategy: 'overwrite',
          createOnly: true,
        });
        if (!res.ok) {
          const error = res.error || 'SE 运行时未就绪';
          recordToolFailures(sid, [{ name: nd.name, error }]);
          notify(`注册工具失败：${error}`, 'warn');
          return;
        }
        const st = res.summary.tools;
        if (st.failed > 0) {
          const error = res.summary.errors[0] || '注册工具失败';
          recordToolFailures(sid, [{ name: nd.name, error }]);
          notify(error, 'warn');
          return;
        }
        // createOnly 下只有真实新增（registered）才算成功：updated 意味着竞态下替换了已有
        // 注册（或摘要不可信），必须视为失败——配置保留可见，但不得伪装注册成功。
        if (!(st.registered > 0)) {
          const error = st.updated > 0
            ? `注册工具失败：检测到同名工具已被更新而非新建；请改用编辑或纳入配置（${nd.name}）`
            : '注册工具失败：未发生注册（请检查名称/定义）';
          recordToolFailures(sid, [{ name: nd.name, error }]);
          notify(error, 'warn');
          return;
        }
        // 清单执行不维护注册状态：hydrate 刷新「已注册」标注。
        const entry = se.runtimeEntry(sid);
        if (entry?.tools) await entry.tools.hydrate();
        notify(`已注册工具「${nd.name}」`, 'ok');
      } finally {
        toolOpsInflightRef.current.delete(opKey);
      }
    },
    [seGate, notify, persistToolConfig, registerEntries, activeId, recordToolFailures]
  );

  const dispatchToolAdopt = useCallback(
    async (name) => {
      const sid = seGate();
      if (!sid) return false;
      const target = String(name == null ? '' : name).trim();
      if (!isValidToolName(target)) {
        notify(`工具名「${target}」无效，未纳入配置`, 'warn');
        return false;
      }
      const opKey = `adopt:${sid}:${target}`;
      if (toolOpsInflightRef.current.has(opKey)) {
        notify(`SE 工具「${target}」正在纳入配置，请勿重复提交`, 'warn');
        return false;
      }
      toolOpsInflightRef.current.add(opKey);
      try {
        const tabId = activeId;
        const client = sePool.get(sid);
        let fresh;
        try {
          fresh = await client.call('tool.get', { name: target });
          if (fresh && fresh.success === false) {
            throw new Error(String(fresh.error || 'tool.get 失败'));
          }
        } catch (err) {
          notify(`读取 SE 工具「${target}」失败：${(err && err.message) || err}；未纳入配置`, 'warn');
          return false;
        }
        const raw = fresh && typeof fresh === 'object' && fresh.tool && typeof fresh.tool === 'object'
          ? fresh.tool
          : fresh;
        const nd = normalizeToolDef(raw);
        if (!nd || nd.name !== target || !isValidToolName(nd.name)) {
          notify(`SE 工具「${target}」返回的定义或名称无效，未纳入配置`, 'warn');
          return false;
        }
        const configForTargetTab = () =>
          activeTabIdRef.current === tabId
            ? toolsRef.current || {}
            : storeRef.current[tabId]?.tools || {};
        if (Object.prototype.hasOwnProperty.call(configForTargetTab(), target)) {
          notify(`配置已存在同名工具「${target}」，已保留现有定义`, 'info');
          return false;
        }
        if (activeTabIdRef.current !== tabId || String(activeSystemIdRef.current || '') !== sid) {
          notify(`标签页或系统已切换，未纳入 SE 工具「${target}」`, 'warn');
          return false;
        }

        const adoptedJson = JSON.stringify(nd);
        const rollbackAdoption = () => {
          if (activeTabIdRef.current === tabId) {
            const existing = (toolsRef.current || {})[nd.name];
            if (!existing || JSON.stringify(normalizeToolDef(existing)) !== adoptedJson) return false;
            commitTools((prev) => {
              const next = { ...prev };
              delete next[nd.name];
              return next;
            });
            stashActive();
            return true;
          }
          const graph = storeRef.current[tabId];
          if (!graph) return false; // 目标 tab 已关闭：缓存已清空，回滚无残留且绝不抛错
          const existing = (graph.tools || {})[nd.name];
          if (!existing || JSON.stringify(normalizeToolDef(existing)) !== adoptedJson) return false;
          const next = { ...(graph.tools || {}) };
          delete next[nd.name];
          storeRef.current[tabId] = { ...graph, tools: next };
          return true;
        };

        // 失败策略 rollback：先回滚内存态，再经同一串行链 corrective save 还原态。
        const persisted = await persistToolConfig({
          tabId,
          apply: (prev) => ({ ...prev, [nd.name]: nd }),
          failurePolicy: 'rollback',
          revert: rollbackAdoption,
        });
        if (persisted.ok) {
          notify(`已将 SE 工具「${nd.name}」纳入配置并保存`, 'ok');
          return true;
        }
        const corrective = persisted.corrective || null;
        if (persisted.rolledBack && corrective && corrective.ok === true) {
          notify(`保存工具配置失败：${persisted.reason}；「${nd.name}」未纳入配置，已回滚并保存还原态`, 'warn');
        } else if (persisted.rolledBack) {
          const reason = (corrective && corrective.reason) || '未确认';
          notify(
            `保存工具配置失败：${persisted.reason}；「${nd.name}」内存中未纳入配置，但回滚态未能保存：${reason}；请手动保存或重试`,
            'warn'
          );
        } else if (!storeRef.current[tabId]) {
          notify(`保存工具配置失败：${persisted.reason}；目标标签页已关闭，「${nd.name}」未纳入配置`, 'warn');
        } else {
          notify(
            `保存工具配置失败：${persisted.reason}；已保留后续写入的同名配置「${nd.name}」（无法安全回滚）`,
            'warn'
          );
        }
        return false;
      } finally {
        toolOpsInflightRef.current.delete(opKey);
      }
    },
    [seGate, notify, activeId, commitTools, stashActive, persistToolConfig]
  );

  const dispatchToolUpdate = useCallback(
    async (oldName, def) => {
      const sid = seGate();
      if (!sid) return;
      const entry = se.runtimeEntry(sid);
      if (!entry?.tools) {
        notify('SE 运行时未就绪', 'warn');
        return;
      }
      try {
        // 期 12（F3/Q4）：SE `tool.register` 不 upsert（同名抛 already-exists），故编辑一律走
        // toolDriver.update（内部 unregister→register + 失败回滚 + 单次通知）；priorDef 供回滚。
        await entry.tools.update(oldName, def, toolsRef.current?.[oldName], { baseDir: baseDirForSystem(sid) });
        const nd = normalizeToolDef(def);
        if (nd) {
          commitTools((prev) => {
            const next = { ...prev };
            if (String(oldName) !== nd.name) delete next[oldName];
            next[nd.name] = nd;
            return next;
          });
        }
      } catch (err) {
        /* driver 已 notify；失败不改台账 */
      }
    },
    [seGate, notify, commitTools, baseDirForSystem]
  );

  const dispatchToolDelete = useCallback(
    async (name) => {
      const sid = seGate();
      if (!sid) return;
      const entry = se.runtimeEntry(sid);
      if (!entry?.tools) {
        notify('SE 运行时未就绪', 'warn');
        return;
      }
      try {
        await entry.tools.unregister(name);
        commitTools((prev) => {
          const next = { ...prev };
          delete next[name];
          return next;
        });
      } catch (err) {
        /* driver 已 notify；失败不移除台账 */
      }
    },
    [seGate, notify, commitTools]
  );

  /** R2：批量注销工具（绑定在线逐条 unregister，成功项一次 commitTools 移除；失败逐条已由 driver notify）。 */
  const deleteTools = useCallback(
    async (names) => {
      const toolNames = Array.isArray(names) ? names.map(String).filter(Boolean) : [];
      if (!toolNames.length) return;
      const sid = seGate();
      if (!sid) return;
      const entry = se.runtimeEntry(sid);
      if (!entry?.tools) {
        notify('SE 运行时未就绪', 'warn');
        return;
      }
      const ok = [];
      for (const name of toolNames) {
        try {
          await entry.tools.unregister(name);
          ok.push(name);
        } catch (err) {
          /* driver 已 notify；失败不移除台账 */
        }
      }
      if (ok.length) {
        commitTools((prev) => {
          const next = { ...prev };
          ok.forEach((n) => delete next[n]);
          return next;
        });
        notify(`已删除 ${ok.length}/${toolNames.length} 个工具`, ok.length === toolNames.length ? 'ok' : 'warn');
      }
    },
    [seGate, notify, commitTools]
  );

  // 双击/📋 插入调用文本到当前编辑节点光标处（与文件面板 ＋ 同一通路）。
  // 需求2：优先工具定制的 insert_template（留空则回落到 buildCallStub 自动生成，历史行为不变）。
  const insertToolCall = useCallback(
    (tool) => {
      if (!caretBridge.target) {
        notify('请先点击要插入的文本位置', 'warn');
        return;
      }
      const text = resolveInsertText(tool);
      caretBridge.insert(text);
      notify(`已插入: ${text}`, 'ok');
    },
    [notify]
  );

  // 期 6 + 去 mock（§3.1/§5.2）：绑定在线 → 经 ensure(sid) 取 scanDriver（scan.* + scan.on_change
  // 真源，UI 不动）；未绑定/离线 → seGate 明确拒绝，不再本地随机游走。
  const dispatchScan = useCallback(
    (id, action, payload) => {
      const sid = seGate();
      if (!sid) return undefined;
      const entry = se.runtimeEntry(sid);
      if (!entry?.scan) {
        notify('SE 运行时未就绪', 'warn');
        return undefined;
      }
      return entry.scan.action(id, action, payload);
    },
    [seGate, notify]
  );

  // 流项拖拽上画布：隐藏流 = 显示并落到落点；在画布流 = 移动节点到落点。
  const onFlowDragOver = useCallback((e) => {
    if (e.dataTransfer.types.includes('application/x-stream-id')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  }, []);

  const onFlowDrop = useCallback(
    (e) => {
      const id = e.dataTransfer.getData('application/x-stream-id');
      if (!id) {
        // Dropping an image file on the canvas must not navigate the tab to the
        // file. Image insertion is handled by the focused node editor.
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          e.preventDefault();
        }
        return;
      }
      e.preventDefault();
      if (guardOffline()) return;
      const node = nodesRef.current.find((n) => n.id === id);
      if (!node) return;
      const pos = snapPos(screenToFlowPosition({ x: e.clientX, y: e.clientY }));
      if (isStreamVisible(node)) {
        pushHistory();
        setNodes((nds) =>
          nds.map((n) => (n.id === id ? { ...n, position: pos, selected: true } : n))
        );
      } else {
        toggleStreamCanvas(id, true, pos);
      }
    },
    [screenToFlowPosition, pushHistory, setNodes, toggleStreamCanvas, guardOffline]
  );

  /** 就地编辑（Enter / 失焦）提交：content 去首尾空白，name 折叠换行；内容没变则不产生历史。 */
  const updateNodeText = useCallback(
    (id, kind, value) => {
      const flat = (s) => String(s).replace(/\s*\n+\s*/g, ' ').trim();
      const clean = kind === 'content' ? String(value).trim() : flat(value);
      const cur = nodes.find((x) => x.id === id);
      const prev = kind === 'content' ? String(cur?.data?.content || '').trim() : flat(cur?.data?.name);
      if (clean === prev) return;
      const name = streamNameFromId(id);
      const sid = activeSystemIdRef.current;
      const boundOnline =
        !!name &&
        !!sid &&
        !systemOfflineRef.current &&
        sePool.get(String(sid)).status === SE_STATUS.ONLINE;
      if (boundOnline && kind === 'name') {
        // 名称即 SE name：在线改名走 rename 级联链路（校验 + 确认 + 边键级联 + 修复对话框）。
        renameStreamName(id, clean);
        return;
      }
      if (kind === 'name' && name) {
        // s-* 的身份由 SE 决定；离线/未绑定时本地改名会造成 id/name/file 三态分叉，
        // 恢复在线后 name 被 SE 拉回、文件却已改名。直接拒绝，等在线再改。
        notify('系统离线或未绑定，SE 流改名已挂起；请恢复在线后再改名', 'warn');
        return;
      }
      pushHistory();
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== id) return n;
          if (kind === 'content') {
            const data = { ...n.data };
            if (clean) data.content = clean;
            else delete data.content;
            return { ...n, data };
          }
          return { ...n, data: { ...n.data, name: clean } };
        })
      );
      // 节点重命名的文件迁移统一由保存管线 reconcileOwnedSourcesForTab 执行；
      // 不在每个改名入口各写一份 move（避免外部文件误移动与 close/autosave 竞态）。
      // 内容提交：已绑定在线流走 stream.write(CAS)，本地节点已在上方就地更新。
      if (boundOnline && kind === 'content') commitStreamContent(id, clean);
    },
    [nodes, pushHistory, setNodes, notify, commitStreamContent, renameStreamName]
  );

  // 期 3 遗留缺口 G-7：节点 fields 行内编辑过去纯本地：期 4 起绑定在线流接 SE tag。
  // 空键「新增行」本身不产生 tag（键由 updateNodeField 落定）；其余增删改走 seApplyTagChanges。
  const addField = useCallback(
    (id) => {
      pushHistory();
      setNodes((nds) =>
        nds.map((n) =>
          n.id === id
            ? {
                ...n,
                data: {
                  ...n.data,
                  fields: [
                    ...(Array.isArray(n.data?.fields) ? n.data.fields : []),
                    { key: '', value: '' },
                  ],
                },
              }
            : n
        )
      );
    },
    [pushHistory, setNodes]
  );

  const removeField = useCallback(
    (id, index) => {
      const target = nodesRef.current.find((n) => n.id === id);
      const list = Array.isArray(target?.data?.fields) ? target.data.fields : [];
      const key = toStr(list[index]?.key).trim();
      const name = streamNameFromId(id);
      const sid = activeSystemIdRef.current;
      const boundOnline =
        !!name &&
        !!sid &&
        !systemOfflineRef.current &&
        sePool.get(String(sid)).status === SE_STATUS.ONLINE;
      const localApply = () =>
        setNodes((nds) =>
          nds.map((n) => {
            if (n.id !== id) return n;
            const fields = (Array.isArray(n.data?.fields) ? n.data.fields : []).filter(
              (_, j) => j !== index
            );
            const data = { ...n.data };
            if (fields.length) data.fields = fields;
            else delete data.fields;
            return { ...n, data };
          })
        );
      if (boundOnline && key) {
        if (isReservedTagKey(key)) {
          notify('canvas/edge. 为系统保留键，不能在此编辑', 'warn');
          return;
        }
        seApplyTagChanges([{ name, changes: [{ key, value: null }] }], localApply, `删除流「${name}」标签`);
        return;
      }
      pushHistory();
      localApply();
    },
    [pushHistory, setNodes, notify, seApplyTagChanges]
  );

  const updateNodeField = useCallback(
    (id, index, part, value) => {
      const clean = String(value ?? '').trim();
      const target = nodesRef.current.find((n) => n.id === id);
      const list = Array.isArray(target?.data?.fields) ? target.data.fields : [];
      const cur = part === 'key' ? toStr(list[index]?.key).trim() : toStr(list[index]?.value).trim();
      if (cur === clean) return;
      const oldKey = toStr(list[index]?.key).trim();
      const oldValue = toStr(list[index]?.value).trim();
      const effectiveKey = part === 'key' ? clean : oldKey;
      // 保留键防护：canvas/edge. 命中即拒绝，不写 SE、不改本地。
      if (isReservedTagKey(effectiveKey)) {
        notify('canvas/edge. 为系统保留键，不能在此编辑', 'warn');
        return;
      }
      const name = streamNameFromId(id);
      const sid = activeSystemIdRef.current;
      const boundOnline =
        !!name &&
        !!sid &&
        !systemOfflineRef.current &&
        sePool.get(String(sid)).status === SE_STATUS.ONLINE;
      const localApply = () =>
        setNodes((nds) =>
          nds.map((n) => {
            if (n.id !== id) return n;
            const fields = (Array.isArray(n.data?.fields) ? n.data.fields : []).map((f, j) =>
              j === index ? { ...f, [part]: clean } : f
            );
            return { ...n, data: { ...n.data, fields } };
          })
        );
      if (boundOnline) {
        const changes = [];
        if (part === 'key') {
          if (oldKey && oldKey !== clean) changes.push({ key: oldKey, value: null });
          if (clean) changes.push({ key: clean, value: oldValue });
        } else if (oldKey) {
          changes.push({ key: oldKey, value: clean });
        }
        if (!changes.length) {
          localApply();
          return;
        }
        seApplyTagChanges([{ name, changes }], localApply, `编辑流「${name}」标签`);
        return;
      }
      pushHistory();
      localApply();
    },
    [pushHistory, setNodes, notify, seApplyTagChanges]
  );

  // 传入哪个维度就更新哪个，未传入的维度保持不变（右缘只改宽、下缘只改高、右下角两者都改）。
  const updateNodeSize = useCallback(
    (id, dims = {}) => {
      const hasW = Number.isFinite(dims.width) && dims.width > 0;
      const hasH = Number.isFinite(dims.height) && dims.height > 0;
      if (!hasW && !hasH) return;
      pushHistory();
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== id) return n;
          const width = hasW ? dims.width : toW(n.style?.width) ?? NODE_W;
          const height = hasH ? dims.height : toW(n.style?.height);
          const { width: _w, height: _h, measured: _m, resizing: _r, ...rest } = n;
          const style = { width };
          if (height) style.height = height;
          return { ...rest, style };
        })
      );
      // 尺寸写回常驻布局表：与节点 style 一致（条目无则按节点坐标先建，保留已有 x/y）。
      const sid = activeSystemIdRef.current;
      const name = streamNameFromId(id);
      if (sid && name) {
        const key = String(sid);
        const t = layoutRef.current[key] || (layoutRef.current[key] = {});
        const n = nodesRef.current.find((x) => String(x.id) === String(id));
        const width = hasW ? dims.width : toW(n?.style?.width) ?? NODE_W;
        const height = hasH ? dims.height : toW(n?.style?.height);
        const x = Number(n?.position?.x);
        const y = Number(n?.position?.y);
        const entry = t[name] || (Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null);
        if (entry) {
          entry.width = width;
          if (height) entry.height = height;
          else delete entry.height;
          t[name] = entry;
        }
      }
    },
    [pushHistory, setNodes]
  );

  const resetNodeSize = useCallback(
    (id) => {
      pushHistory();
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== id) return n;
          const { width: _w, height: _h, measured: _m, resizing: _r, ...rest } = n;
          return { ...rest, style: { width: NODE_W } };
        })
      );
      // 尺寸写回常驻布局表：镜像复位后的 style（宽回默认 → 删 width 键，高度删除）。
      const sid = activeSystemIdRef.current;
      const name = streamNameFromId(id);
      if (sid && name) {
        const key = String(sid);
        const t = layoutRef.current[key] || (layoutRef.current[key] = {});
        const n = nodesRef.current.find((x) => String(x.id) === String(id));
        const x = Number(n?.position?.x);
        const y = Number(n?.position?.y);
        const entry = t[name] || (Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null);
        if (entry) {
          delete entry.width;
          delete entry.height;
          t[name] = entry;
        }
      }
    },
    [pushHistory, setNodes]
  );

  // 拖动结束（position 终态）把落点写回常驻布局表；本地 n-* 节点无流名 → 跳过。
  const handleNodesChange = useCallback(
    (changes) => {
      onNodesChange(changes);
      const sid = activeSystemIdRef.current;
      if (!sid) return;
      const key = String(sid);
      for (const change of Array.isArray(changes) ? changes : []) {
        if (change.type !== 'position' || !change.position || change.dragging !== false) continue;
        const name = streamNameFromId(change.id);
        if (!name) continue;
        const x = Number(change.position.x);
        const y = Number(change.position.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const t = layoutRef.current[key] || (layoutRef.current[key] = {});
        t[name] = { ...(t[name] || {}), x, y };
      }
    },
    [onNodesChange]
  );

  const handlePaneDoubleClick = useCallback(
    (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t !== e.currentTarget && !t.closest('.react-flow__pane')) return;
      if (t.closest('.react-flow__node, .react-flow__edge, .react-flow__edge-toolbar, .react-flow__node-toolbar, .react-flow__controls, .react-flow__minimap, .react-flow__panel')) return;
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      // Task 3 入口门控③：绑定在线时改唤起「新建流」对话框，并把双击处落点交给服务端投影消费
      // （layoutRef → projectStreams.layout）；未绑定/离线保持原本地行为。
      if (boundOnlineNow()) {
        setStreamDraft({ title: '新建流', name: '新节点', position: snapPos(position) });
        return;
      }
      addNodeAt(position);
    },
    [screenToFlowPosition, addNodeAt, boundOnlineNow]
  );

  const openDialog = useCallback(
    (type) => {
      setDlgPath('');
      setDlgName(graphName);
      setDialog(type);
      refreshHistory();
    },
    [graphName, refreshHistory]
  );

  const browsePath = useCallback(async () => {
    setDlgBusy(true);
    try {
      const res = await fetch('/api/dialog/open', { method: 'POST' });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`);
      if (result.path) {
        setDlgPath(result.path);
      } else {
        setStatus('已取消选择');
      }
    } catch (err) {
      console.warn('系统对话框失败', err);
      setStatus('无法打开系统对话框');
    } finally {
      setDlgBusy(false);
    }
  }, []);

  const removeHistory = useCallback(
    async (event, p) => {
      event.stopPropagation();
      try {
        await fetch('/api/history/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: p }),
        });
      } catch (err) {
        console.warn('删除历史失败', err);
      }
      refreshHistory();
    },
    [refreshHistory]
  );

  const saveCurrent = useCallback(async () => {
    try {
      // 保存前先落盘未同步的编辑内容（不退出编辑态）。
      try {
        editorApiRef.current?.flush?.();
      } catch (err) {
        console.warn('保存前回写编辑内容失败', err);
      }
      const name = String(graphName || '').trim();
      if (!name) {
        setStatus('请先为当前标签页命名，再保存');
        return;
      }
      stashActive();
      clearTimeout(saveTimerRef.current);
      const out = await syncGraphFiles(storeRef.current);
      const r = out && out.results ? out.results[activeId] : null;
      if (r && r.ok) {
        setStatus(r.skipped ? '已保存（无变化）' : `已保存到 ${r.savedPath || '本地文件'}`);
      } else if (r && (r.reason === 'unhydrated' || r.reason === 'bind-inflight')) {
        setStatus('当前标签页未就绪，暂不能保存');
      } else {
        setStatus(`保存失败：${(r && (r.error || r.reason)) || '未知'}`);
      }
      persistWorkspace();
    } catch (err) {
      console.warn('保存失败', err);
      setStatus(`保存失败：${(err && err.message) || err}`);
    }
  }, [graphName, activeId, stashActive, syncGraphFiles, persistWorkspace]);

  /** 按 source 引用懒读正文，水合进节点 data（content + contentState）。返回 warnings（缺失不抛）。
   *  configDir = 相对路径解析基准（配置所在目录）；缺省 'graphs'（graphs 惯例）。 */
  const hydrateNodes = useCallback(async (nodeList, configDir) => {
    const warnings = [];
    await Promise.all(
      (Array.isArray(nodeList) ? nodeList : []).map(async (n) => {
        const src = n?.data?.source;
        if (!src || !src.file_path) return;
        if (n.data.contentState === 'loaded') return;
        const rootPath = resolveAgainstConfigDir(src.file_path, configDir || 'graphs');
        const res = await readContentRef({ ...src, file_path: rootPath });
        n.data.content = res.text;
        n.data.contentState = res.state;
        // 种子指纹：刚读到的正文视为"与磁盘一致"，避免首次自动保存重写全部正文文件。
        if (res.state === 'loaded') contentHashRef.current.set(rootPath, hashText(res.text));
        if (res.state === 'missing') {
          warnings.push(`流「${n.data.name || n.id}」正文缺失：${rootPath}`);
        }
      })
    );
    return warnings;
  }, []);

  // 懒加载（期 2 / D8）：切到未加载的具名 tab 时，读 graphs/<名>.json → parseDocument
  // → 按 source.file_path 水合正文 → 上画布。404/无名 = 空草稿；失败 = 空画布 + 告警。
  const loadingTabRef = useRef(null);
  const [tabReady, setTabReady] = useState(false); // 新增：标记当前 tab 是否已完成懒加载（layoutRef 已初始化）
  useEffect(() => {
    const tab = tabs.find((t) => t.id === activeId);
    if (!tab) return;
    if (hydratedRef.current.has(activeId)) {
      setTabReady(true); // 已加载的 tab 直接标记为就绪
      return;
    }
    if (loadingTabRef.current === activeId) return;
    const name = String(tab.name || '').trim();
    if (!name) {
      // 无名草稿 tab：空画布，标记已加载；命名后首次保存才落 graphs/<名>.json。
      hydratedRef.current.add(activeId);
      storeRef.current[activeId] = { nodes: [], edges: [], tools: {} };
      setTabReady(true); // 空 tab 直接标记为就绪
      return;
    }
    setTabReady(false); // 开始加载时标记为未就绪
    loadingTabRef.current = activeId;
    let cancelled = false;
    (async () => {
      let graph = { nodes: [], edges: [], tools: {} };
      // B2 三态：加载失败不得标 hydrated（否则自动保存会用空画布覆盖磁盘）。置此标志延后处理。
      let loadFailed = false;
      // 有有效工作文档（docPath 或配置包 manifest_path）→ 按路径直读；
      // 仅“应用内新建/未落契”才回退 /api/graphs/file?name=。
      const target = workDocPathOf(tab);
      // 与保存侧 collectContentFiles 同一目录基准（绝对化），否则正文指纹键不一致 → 冷启动重写。
      const cfgDir = absoluteConfigDirOf(target);
      // 磁盘文档流数（与 shouldSkipEmptyPersist 同口径）：优先磁盘 streams/nodes，缺省退回可持久化节点。
      const diskStreamCountOf = (doc) => {
        if (Array.isArray(doc?.streams)) return doc.streams.length;
        if (Array.isArray(doc?.nodes)) return doc.nodes.length;
        return persistableNodes(graph.nodes).length;
      };
      let parsed = null;
      let diskJson = null;
      try {
        if (target) {
          const res = await fetch('/api/fs/read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: target }),
          });
          if (res.ok) {
            const data = await res.json().catch(() => null);
            parsed = JSON.parse(stripBom(data && data.text != null ? data.text : ''));
            diskJson = JSON.stringify(parsed);
          } else if (res.status !== 404) {
            throw new Error(`HTTP ${res.status}`);
          } else {
            notify(`未找到「${name}」的配置文件，已按空画布打开`, 'warn');
          }
        } else {
          const res = await fetch(`/api/graphs/file?name=${encodeURIComponent(name)}`);
          if (res.ok) {
            parsed = await res.json();
            diskJson = JSON.stringify(parsed);
          } else if (res.status !== 404) {
            throw new Error(`HTTP ${res.status}`);
          } else {
            // B2：graphs 惯例 404 原为静默 → 明确告知按空画布打开。
            notify(`未找到「${name}」的配置文件，已按空画布打开`, 'warn');
          }
        }
        if (parsed) {
          if (isUnifiedDocument(parsed)) {
            const canonical = parseDocument(parsed);
            const warnings = await hydrateNodes(canonical.nodes, cfgDir);
            graph = {
              nodes: canonical.nodes,
              edges: canonical.edges,
              tools: canonical.tools,
              viewport: canonical.viewport || null,
            };
            if (warnings.length) notify(`「${name}」有 ${warnings.length} 个正文缺失`, 'warn');
          } else if (parsed && Array.isArray(parsed.nodes)) {
            // 旧逻辑格式（v0）：宽容升级，无工具/引用。
            const r = fromLogicGraph(parsed);
            graph = { nodes: r.graph.nodes, edges: r.graph.edges, tools: {}, viewport: null };
          }
        }
      } catch (err) {
        loadFailed = true;
        notify(`加载「${name}」失败：${(err && err.message) || err}（已显示空画布）`, 'warn');
      }
      if (cancelled) return;
      // B2：加载失败 → 不写 storeRef、不标 hydrated、不 setNodes（仅由 notify 告知）；hydrated
      // 未置真 → 自动保存被「懒加载未完成前不保存」护栏挡住，磁盘安全；切走再切回可重试。
      if (loadFailed) {
        loadingTabRef.current = null;
        return;
      }
      // 成功水合后以磁盘原始 JSON 作为保存基线（先于 setNodes，避免 600ms 自动保存抢先写回）：
      // 规范文档冷启动命中 unchanged 比较 → 零文档写；旧/非规范格式仍会归一化一次。
      // 404 / 解析失败 / 未水合不播种。
      if (parsed && diskJson != null) {
        graphSyncRef.current[activeId] = {
          name,
          json: diskJson,
          streamCount: diskStreamCountOf(parsed),
        };
      }
      // P4：绑定 tab 且 SE 为空、本地图非空 → 自动迁移本地内容（离线 / 缺 token 则保持本地画布不动）。
      if (tab.system?.system_id) {
        const sid = tab.system.system_id;
        let online = false;
        try {
          await waitForClientOnline(sePool.get(String(sid)), 15000);
          online = true;
        } catch (err) {
          // offline / token-unavailable：保留本地画布，不迁移。
        }
        if (cancelled) return;
        if (online && (await migrateLocalContentIfEmpty(sid, graph))) {
          if (cancelled) return;
          // 迁移成功后本地正文就是刚写入 SE 的真源。先把本地节点以**新 s-* 身份**
          // + 正文/坐标播种进画布，再重投影：projectStreams 以 prev 节点保留
          // content/position，避免“标题已投影、正文仍为空”的异步读窗口。
          const migration = buildMigrationDataFrom(graph.nodes, graph.edges, graph.tools);
          const rowById = new Map(migration.rows.map((r) => [String(r.id), r]));
          const migratedCanvas = toCanvasGraph(graph);
          const existingSe = migratedCanvas.nodes.filter((n) => String(n.id).startsWith('s-'));
          const seededLocal = migratedCanvas.nodes
            .filter((n) => !String(n.id).startsWith('s-'))
            .map((n) => {
              const row = rowById.get(String(n.id));
              if (!row) return null;
              return {
                ...n,
                id: streamNodeId(row.name),
                data: {
                  ...n.data,
                  name: row.name,
                  content: row.content == null ? '' : String(row.content),
                  contentState: 'loaded',
                },
              };
            })
            .filter(Boolean);
          const seNodes = [...existingSe, ...seededLocal];
          const seIds = new Set(seNodes.map((n) => String(n.id)));
          const seEdges = migratedCanvas.edges.filter(
            (e) => seIds.has(String(e.source)) && seIds.has(String(e.target))
          );
          storeRef.current[activeId] = { ...graph, nodes: seNodes, edges: seEdges };
          hydratedRef.current.add(activeId);
          loadingTabRef.current = null;
          // 迁移分支同样必须把配置工具发布到可见状态：否则 tools 状态停留在空集，
          // 随后的防抖自动保存会用空工具集覆盖已水合的配置（工具“已保存却丢”）。
          commitTools(graph.tools);
          setNodes(seNodes);
          setEdges(seEdges);
          nodesRef.current = seNodes;
          // 文档是打开时的布局真源：落地节点覆盖常驻表。
          layoutRef.current[String(sid)] = layoutFromNodes(seNodes);
          requestViewport(graph && graph.viewport ? 'restore' : 'fit', graph && graph.viewport ? graph.viewport : null);
          setTabReady(true); // 标记 tab 就绪（layoutRef 已初始化）
          await se.onConnected(sid);
          return;
        }
      }
      storeRef.current[activeId] = graph;
      hydratedRef.current.add(activeId);
      loadingTabRef.current = null;
      // 新增：确保内容状态正确恢复（有 source 且内容已加载的节点，contentState 设为 'loaded'）
      graph.nodes = graph.nodes.map((n) => {
        if (n.data?.source?.file_path && n.data?.content != null && !n.data?.contentState) {
          return {
            ...n,
            data: {
              ...n.data,
              contentState: 'loaded',
            },
          };
        }
        return n;
      });
      const canvas = toCanvasGraph(graph);
      setNodes(canvas.nodes);
      setEdges(canvas.edges);
      // 重投影读 nodesRef 取坐标：先同步到 ref，避免以空 prev 自动布局覆盖解析出的排版。
      nodesRef.current = canvas.nodes;
      // 配置=唯一台账（§2/需求1）：工具列表一律从配置文档渲染，绑定 tab 也不例外。
      // 重启后 SE 注册表为空，但配置里的 tools 必须仍在列表（修复「保存了却丢」）；
      // SE 仅作「运行时是否可执行」的状态标注，不再定义列表（见 toolProjection 状态）。
      commitTools(graph.tools);
      requestViewport(graph && graph.viewport ? 'restore' : 'fit', graph && graph.viewport ? graph.viewport : null);
      // 期 3（决策 A · file-master）：绑定 tab → 文件内容灌进 SE。离线则暂存，连上后由 onSeConnected 补推。
      if (tab.system?.system_id) {
        const sid = tab.system.system_id;
        // 文档是打开时的布局真源：落地节点覆盖常驻表。
        layoutRef.current[String(sid)] = layoutFromNodes(canvas.nodes);
        // 配置台账（graph.tools）已在上方 commitTools；立即把工具投影进 SE。SE 注册表会持久化，
        // 这里只补台账中缺失的工具（已有同名项不重注册）；配置懒加载晚于连接时的 onSeConnected，
        // 此处补投正是「连接先于配置」时序缺口的收口。离线时返回 offline，待重连补投。
        se.projectToolsToSe(sid).catch(() => {});
        se.stashPendingPush(String(sid), graph.nodes);
        se.pushFileStreams(sid, graph.nodes)
          .then((res) => {
            if (res && res.ok) se.dropPendingPush(String(sid));
            const n =
              res && res.summary
                ? (res.summary.streams.created || 0) + (res.summary.streams.updated || 0)
                : 0;
            if (n) notify(`已按文件内容同步 ${n} 个流到 SE`, 'ok');
            // Task5：文件内容上推完成后，事件驱动地提升本地 pending 节点（在线才有效）。
            const promoting = promotePendingRef.current ? promotePendingRef.current(sid) : Promise.resolve();
            // Task6：pending 提升完成后（可能新增 s-* 端点）对齐文档 s-*↔s-* 边到 SE tags，
            // 再重投影让派生边上画布；全已对齐则静默。
            return Promise.resolve(promoting)
              .catch(() => {})
              .then(() => alignDocumentEdgesToSe(sid, collectDocumentEdges(graph)))
              .then((r) => {
                if (!r || (!r.written && !r.failed)) return;
                notify(
                  r.failed > 0
                    ? `已对齐 ${r.written} 条连线到 SE（${r.failed} 条失败）`
                    : `已对齐 ${r.written} 条连线到 SE`,
                  r.failed > 0 ? 'warn' : 'ok'
                );
              })
              .catch(() => {});
          })
          .catch(() => {});
      }
      setTabReady(true); // 标记 tab 就绪（layoutRef 已初始化）
    })();
    return () => {
      cancelled = true;
      if (loadingTabRef.current === activeId) loadingTabRef.current = null;
    };
  }, [
    activeId,
    tabs,
    hydrateNodes,
    notify,
    setNodes,
    setEdges,
    commitTools,
    migrateLocalContentIfEmpty,
    alignDocumentEdgesToSe,
    requestViewport,
    persistableNodes,
  ]);

  const confirmDialog = useCallback(async () => {
    setDlgBusy(true);
    try {
      const target = dlgPath.trim() || dlgName.trim();
      if (!target) {
        setStatus('请选择文件或输入路径');
        return;
      }
      // 加载会替换/合并画布：先提交并退出当前编辑会话。
      exitEdit(true);
      const docPath = normalizeDocTarget(target);
      const res = await fetch('/api/fs/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: docPath }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
      // 来源登记：服务端返回 resolve 后的绝对路径（可移植化后存入 tab.docPath）。
      const loadedPath = portableDocPath(
        String((data && data.path) || docPath).replace(/\\/g, '/'),
        getProjectRoot(),
        { repairGraphsResidue: false }
      );
      // 自定义路径打开成功 → 自动登记（方案 §3.1）。
      if (!isGraphsDocPath(loadedPath)) {
        loadConfigRegistry()
          .then((es) => saveConfigRegistry(registerEntry(es, loadedPath, getProjectRoot())))
          .catch(() => {});
      }
      // 同一有效工作文档只允许一个 tab 持有（含配置包 manifest_path）。
      const dup = findDocOwner(tabsRef.current, loadedPath);
      if (dup) {
        setDialog(null);
        if (dup.id !== activeId) switchTab(dup.id);
        notify(`该文档已在标签页「${dup.name || '未命名图'}」中打开，已切换`, 'info');
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(stripBom(data && data.text != null ? data.text : ''));
      } catch (e) {
        throw new Error(`JSON 解析失败：${(e && e.message) || e}`);
      }
      if (isUnifiedDocument(parsed)) {
        // v2/v1 统一文档：解析 → 按引用懒读正文水合（基准 = 该文档所在目录）→ 预览（含同名冲突统计）→ 用户三选策略。
        const canonical = parseDocument(parsed);
        const warnings = await hydrateNodes(canonical.nodes, absoluteConfigDirOf(loadedPath));
        const curNames = new Set(nodesRef.current.map((n) => String(n.data?.name || '')));
        const curTools = new Set(Object.keys(toolsRef.current || {}));
        setDocPreview({
          path: docPath,
          docPath: loadedPath,
          canonical,
          streamCount: canonical.nodes.length,
          toolCount: Object.keys(canonical.tools).length,
          streamConflicts: canonical.nodes.filter((sn) =>
            curNames.has(String(sn.data?.name || ''))
          ).length,
          toolConflicts: Object.keys(canonical.tools).filter((n) => curTools.has(n)).length,
          warnings,
        });
      } else if (loadFromParsed(parsed, `已加载：${docPath}（旧格式，已自动升级）`)) {
        setGraphName(baseName(docPath));
      }
      setDialog(null);
      refreshHistory();
    } catch (err) {
      console.warn('对话框操作失败', err);
      setStatus(`操作失败：${(err && err.message) || err}`);
    } finally {
      setDlgBusy(false);
    }
  }, [dlgPath, dlgName, loadFromParsed, refreshHistory, exitEdit, setGraphName, hydrateNodes, notify, switchTab, activeId]);

  /** 配置面板「打开」：canon 去重 → 已开则切换；否则新 tab（不标 hydrated → 懒加载 effect 读 docPath 全链水合含视口）。外部路径自动登记 .configs.json。 */
  const openConfigInTab = useCallback((rawPath) => {
    const path = String(rawPath || '').replace(/\\/g, '/');
    if (!path) return;
    // 项目内绝对 → 相对持久化（外部保持绝对）。
    const portable = portableDocPath(path, getProjectRoot());
    const dup = findDocOwner(tabsRef.current, portable);
    if (dup) {
      if (dup.id !== activeId) switchTab(dup.id);
      notify(`该文档已在标签页「${dup.name || '未命名图'}」中打开，已切换`, 'info');
      return;
    }
    exitEdit(true);
    stashActive();
    const id = genTabId();
    const base = path.split('/').pop().replace(/\.se\.json$/i, '');
    const taken = new Set(tabsRef.current.filter((t) => t.system?.system_id).map((t) => t.system.system_id));
    const tab = assignTabSystem({ id, name: base, docPath: portable }, taken);
    storeRef.current[id] = { nodes: [], edges: [], tools: {}, viewport: null };
    setTabs((ts) => [...ts, tab]);
    setActiveId(id);
    setNodes([]);
    setEdges([]);
    nodesRef.current = [];
    edgesRef.current = [];
    commitTools({});
    setGraphNameState(base);
    if (!isGraphsDocPath(portable)) {
      loadConfigRegistry()
        .then((entries) => saveConfigRegistry(registerEntry(entries, portable, getProjectRoot())))
        .catch(() => {});
    }
  }, [activeId, switchTab, stashActive, exitEdit, commitTools, setNodes, setEdges, setGraphNameState, notify]);

  const seApiBind = useMemo(
    () => ({
      listSystems: async () => {
        try {
          const res = await fetch('/api/se/systems');
          return res.ok ? await res.json() : [];
        } catch (err) {
          return [];
        }
      },
      pickPackage,
      // Tier-1 活文档优先：pickPackage 返回 reopen 标记时，对话框经此直接打开活文档。
      openConfig: async (p) => {
        notify('检测到该配置包的既有工作文档，已打开最新状态（包作为种子保持不变）', 'info');
        openConfigInTab(p);
      },
      prepareSystem: (id) => se.prepareSystem(id),
      createSystem: (payload) => se.createSystem(payload),
      endUnboundSystem: (id) => se.endUnboundSystem(id),
      bind: bindSystem,
    }),
    [pickPackage, bindSystem, notify, openConfigInTab, se]
  );

  /** 配置面板重命名后：已打开 tab 的 docPath/manifest_path 跟随新路径，并迁移 source 前缀。 */
  const handleOpenTabRenamed = useCallback((oldPath, newPath) => {
    const oc = canonDocPath(oldPath);
    const nc = portableDocPath(String(newPath || '').replace(/\\/g, '/'), getProjectRoot(), {
      repairGraphsResidue: false,
    });
    if (!oc || !nc) return;
    const oldBase = packageNameFromPath(oldPath);
    const newBase = packageNameFromPath(newPath);
    const oldSrcDir = oldBase ? `${oldBase}.streams` : '';
    const newSrcDir = newBase ? `${newBase}.streams` : '';
    const oldHashDir = oldSrcDir ? `${absoluteConfigDirOf(oldPath)}/${oldSrcDir}` : '';
    const newHashDir = newSrcDir ? `${absoluteConfigDirOf(newPath)}/${newSrcDir}` : '';
    let changed = false;
    const next = tabsRef.current.map((t) => {
      const docHit = t.docPath && canonDocPath(t.docPath) === oc;
      const manHit = t.system?.manifest_path && canonDocPath(t.system.manifest_path) === oc;
      if (!docHit && !manHit) return t;
      changed = true;
      // 只有“有效工作文档”被改名才迁移 source；legacy fork 的 manifest 改名不动 graphs 副本。
      const targetHit = !!docHit || (!t.docPath && !!manHit);
      if (targetHit && oldSrcDir && newSrcDir && oldSrcDir !== newSrcDir) {
        const nodes = storeRef.current[t.id]?.nodes;
        if (nodes) {
          storeRef.current[t.id] = {
            ...storeRef.current[t.id],
            nodes: remapSourcePrefix(nodes, oldSrcDir, newSrcDir),
          };
        }
        if (t.id === activeTabIdRef.current) {
          const live = remapSourcePrefix(nodesRef.current, oldSrcDir, newSrcDir);
          nodesRef.current = live;
          setNodes(live);
        }
        remapContentHashes(oldHashDir, newHashDir);
      }
      delete graphSyncRef.current[t.id];
      return {
        ...t,
        ...(docHit ? { docPath: nc } : {}),
        ...(manHit && t.system ? { system: { ...t.system, manifest_path: nc } } : {}),
      };
    });
    if (!changed) return;
    tabsRef.current = next;
    setTabs(next);
  }, [setNodes, remapContentHashes]);

  // 统一文档三选应用：整页替换（默认）/ 合并-跳过冲突 / 合并-覆盖冲突。
  // 合并语义：流冲突按同名判定；覆盖 = 内容+描述（tags 仅新建时应用）；
  // 非冲突流以新 id 并入（位置保留、重叠级联偏移）；工具冲突 = 跳过或覆盖。
  const applyLoadedDocument = useCallback(
    (strategy) => {
      const pv = docPreview;
      if (!pv) return;
      const { nodes: newNodes, edges: newEdges, tools: newTools, warnings } = pv.canonical;
      setDocPreview(null);
      pushHistory();
      // 期 5：绑定 tab 下 s-* 流/边以 SE 为准，文档仅作快照参考（本地 overlay 语义）。
      const bound = !!activeSystemIdRef.current;
      if (strategy === 'replace') {
        if (bound) {
          const seNodes = nodesRef.current.filter((n) => !!streamNameFromId(n.id));
          const seEdges = edgesRef.current.filter((e) => isSeEdge(e));
          const docLocalNodes = newNodes.filter((n) => streamNameFromId(n.id) == null);
          const docLocalEdges = newEdges.filter((e) => !isSeEdge(e));
          replaceGraph({ nodes: [...seNodes, ...docLocalNodes], edges: [...seEdges, ...docLocalEdges] });
        } else {
          replaceGraph({ nodes: newNodes, edges: newEdges });
        }
        requestViewport(pv.canonical.viewport ? 'restore' : 'fit', pv.canonical.viewport || null);
        commitTools(newTools);
      } else {
        const curByName = new Map(nodesRef.current.map((n) => [String(n.data?.name || ''), n]));
        const idMap = new Map();
        const overrideMap = new Map(); // existingId → incoming stream（仅 overwrite）
        const addedRaw = [];
        newNodes.forEach((sn) => {
          // 期 5：绑定 tab 下文档的 s-* 流不覆盖 SE 投影（本地 overlay 语义）。
          if (bound && streamNameFromId(sn.id) != null) return;
          const name = String(sn.data?.name || '');
          const existing = curByName.get(name);
          if (existing) {
            idMap.set(sn.id, existing.id);
            if (strategy === 'overwrite') overrideMap.set(existing.id, sn);
            return;
          }
          const freshId = `n-${nodeSeqRef.current++}`;
          idMap.set(sn.id, freshId);
          addedRaw.push({ id: freshId, position: { ...sn.position }, data: sn.data });
        });
        const pairSet = new Set(edgesRef.current.map((e) => `${e.source} ${e.target}`));
        const addedEdges = [];
        newEdges.forEach((e) => {
          const s = idMap.get(e.source);
          const t = idMap.get(e.target);
          if (!s || !t) return;
          const key = `${s} ${t}`;
          if (pairSet.has(key)) return;
          pairSet.add(key);
          addedEdges.push({
            id: `e-${edgeSeqRef.current++}`,
            source: s,
            target: t,
            ...(e.label ? { label: e.label } : {}),
          });
        });
        setNodes((nds) => {
          const updated = nds.map((n) => {
            const sn = overrideMap.get(n.id);
            if (!sn) return n;
            const data = { ...n.data };
            const content = sn.data?.content != null ? String(sn.data.content) : '';
            if (content || sn.data?.contentState === 'loaded') data.content = content;
            else delete data.content;
            if (sn.data?.source) data.source = { ...sn.data.source };
            if (sn.data?.contentState) data.contentState = sn.data.contentState;
            const desc = sn.data?.description != null ? String(sn.data.description) : '';
            if (desc) data.description = desc;
            else delete data.description;
            return { ...n, data };
          });
          const canvasAdded = toCanvasGraph({ nodes: addedRaw, edges: [] }).nodes.map((cn) => {
            // 与现有可见节点重叠时级联 +24px 防重叠
            let { x, y } = cn.position;
            for (let k = 0; k < 10; k += 1) {
              const clash = updated.some(
                (m) =>
                  isStreamVisible(m) &&
                  Math.abs(m.position.x - x) < 12 &&
                  Math.abs(m.position.y - y) < 12
              );
              if (!clash) break;
              x += 24;
              y += 24;
            }
            return { ...cn, position: { x, y } };
          });
          return [...updated, ...canvasAdded];
        });
        if (addedEdges.length) setEdges((eds) => [...eds, ...addedEdges]);
        commitTools((t) => {
          const next = { ...t };
          Object.values(newTools).forEach((def) => {
            if (strategy === 'overwrite' || !next[def.name]) next[def.name] = def;
          });
          return next;
        });
        // 合并导入新增的本地节点是 pending（n-*）：在线时立即自动提升为 SE 流（闭环）。
        if (addedRaw.length) {
          const sid = activeSystemIdRef.current;
          if (sid && boundOnlineNow()) {
            setTimeout(() => promotePendingRef.current?.(String(sid)).catch(() => {}), 0);
          }
        }
      }
      const strategyLabel =
        strategy === 'replace' ? '整页替换' : strategy === 'skip' ? '合并-跳过冲突' : '合并-覆盖冲突';
      let msg = `已加载文档（${strategyLabel}）：${pv.streamCount} 流 / ${pv.toolCount} 工具`;
      if (warnings.length) msg += `；${warnings.join('；')}`;
      setStatus(msg);
      setGraphName(baseName(pv.path));
      // 来源登记（需求 1：从哪加载就写回哪）：整页替换总是接管 docPath；
      // 合并策略仅当当前 tab 尚未落契时才接管（不抢夺已有 tab 的保存归属）。
      if (pv.docPath) {
        const cur = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
        if (strategy === 'replace' || !workDocPathOf(cur)) {
          const takeoverPath = portableDocPath(pv.docPath, getProjectRoot(), {
            repairGraphsResidue: false,
          });
          setTabs((ts) =>
            ts.map((t) => (t.id === activeTabIdRef.current ? { ...t, docPath: takeoverPath } : t))
          );
        }
      }
      // merge 策略保留用户当前视口（对方案 §2.3 的刻意收窄：合并是增量叠加，跳视口会丢上下文）。
    },
    [docPreview, pushHistory, replaceGraph, commitTools, setNodes, setEdges, setGraphName, boundOnlineNow, requestViewport]
  );

  const resetGraph = useCallback(() => {
    if (!window.confirm('确定要清空当前画布吗？')) return;
    exitEdit(true);
    pushHistory();
    // B3：用户显式清空 → 发一次性放行票，允许把含流图写成空文档（否则被空值护栏拦下）。
    explicitEmptySaveRef.current.add(activeId);
    replaceGraph({ nodes: [], edges: [] });
    setGraphName('');
    setStatus('已清空画布');
  }, [activeId, exitEdit, pushHistory, replaceGraph, setGraphName]);

  const loadDemo = useCallback(() => {
    if (!window.confirm('加载示例将覆盖当前画布，继续？')) return;
    exitEdit(true);
    pushHistory();
    replaceGraph(buildDefaultGraph());
    requestViewport('fit');
    setGraphName('示例');
    setStatus('已加载示例图');
  }, [exitEdit, pushHistory, replaceGraph, setGraphName, requestViewport]);

  const openPanel = useCallback(() => {
    clearTimeout(textTimerRef.current);
    textTimerRef.current = null;
    textFocusedRef.current = false;
    textBurstRef.current = false;
    setPanelText(logicText);
    setPanelBase(logicText);
    setPanelDirty(false);
    setPanelMsg(null);
    setPanelOpen(true);
  }, [logicText]);

  const closePanel = useCallback(() => {
    clearTimeout(textTimerRef.current);
    textTimerRef.current = null;
    textFocusedRef.current = false;
    textBurstRef.current = false;
    setPanelOpen(false);
    setPanelMsg(null);
  }, []);

  const startPanelResize = useCallback(
    (e) => {
      if (!(e.currentTarget instanceof Element)) return;
      e.preventDefault();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
      panelDragRef.current = { startX: e.clientX, startW: panelWidth };
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
    },
    [panelWidth]
  );

  const onPanelResizeMove = useCallback((e) => {
    const d = panelDragRef.current;
    if (!d) return;
    const maxW = Math.max(520, Math.round(window.innerWidth * 0.85));
    const w = Math.min(maxW, Math.max(300, d.startW - (e.clientX - d.startX)));
    setPanelWidth(w);
  }, []);

  const onPanelResizeEnd = useCallback((e) => {
    panelDragRef.current = null;
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    try {
      if (e.currentTarget instanceof Element) e.currentTarget.releasePointerCapture(e.pointerId);
    } catch (err) {
      /* ignore */
    }
  }, []);

  const copyPanel = useCallback(async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(panelText);
      ok = true;
    } catch (err) {
      console.warn('clipboard API 不可用，改用降级方案', err);
    }
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = panelText;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch (err2) {
        console.warn('降级复制失败', err2);
        ok = false;
      }
    }
    setPanelMsg({
      kind: ok ? 'ok' : 'err',
      text: ok ? '已复制到剪贴板' : '复制失败，请手动选中文本复制',
    });
  }, [panelText]);

  // 文本→画布核心：把文本中的合法 JSON 应用到画布。
  // 已有节点保留原位置/尺寸，已有连线按 source→target 复用原 id，全程不触发 fitView。
  const applyTextToCanvas = useCallback(
    (text) => {
      let parsed;
      try {
        parsed = parseTextView(text);
      } catch (err) {
        setPanelMsg({ kind: 'err', text: `YAML 解析失败：${(err && err.message) || err}` });
        return null;
      }
      let graph;
      let warnings = [];
      try {
        const r = fromLogicGraph(parsed);
        graph = r.graph;
        warnings = r.warnings;
      } catch (err) {
        setPanelMsg({ kind: 'err', text: (err && err.message) || String(err) });
        return null;
      }
      const graphCanonical = serializeTextView(graph.nodes, graph.edges);
      if (graphCanonical === logicText) {
        setPanelDirty(false);
        setPanelMsg(null);
        return {
          nextCanonical: graphCanonical,
          nodeCount: graph.nodes.length,
          edgeCount: graph.edges.length,
          warnings,
          changed: false,
        };
      }
      if (!textBurstRef.current) {
        pushHistory();
        textBurstRef.current = true;
      }
      const curById = new Map(nodes.map((n) => [String(n.id), n]));
      // 文本视图不是 SE 改名入口：s-* 的 id/name 由 SE 身份决定。
      // 允许改正文/属性，但改名或新增 s-* 会绕过 stream.rename + 边级联，直接拒绝。
      const blockedStreamEdit = graph.nodes.find((gn) => {
        const nid = String(gn.id);
        if (!nid.startsWith('s-')) return false;
        const ex = curById.get(nid);
        if (!ex) return true;
        return String(gn.data?.name ?? '') !== String(ex.data?.name ?? '');
      });
      if (blockedStreamEdit) {
        setPanelMsg({
          kind: 'err',
          text: `SE 流「${blockedStreamEdit.data?.name || blockedStreamEdit.id}」不能在文本视图改名或新增；请在画布标题/侧栏改名。`,
        });
        return null;
      }
      const pairToId = new Map();
      edges.forEach((e) => {
        if (e && e.source != null && e.target != null)
          pairToId.set(`${e.source}\u0000${e.target}`, String(e.id));
      });
      const used = new Set();
      const rawNodes = graph.nodes.map((gn) => {
        const ex = curById.get(String(gn.id));
        const node = {
          id: String(gn.id),
          position: ex ? { ...ex.position } : { ...gn.position },
          data: {
            name: gn.data.name,
            ...(gn.data.content ? { content: gn.data.content } : {}),
            ...(gn.data.description ? { description: gn.data.description } : {}),
            ...(gn.data.fields && gn.data.fields.length ? { fields: gn.data.fields } : {}),
            // 文本视图只表达 name/content/description/fields；source 与运行时元数据
            // 是前端私有绑定/状态，必须从现有节点回灌，否则一次 Apply 会丢外部文档绑定。
            ...(ex?.data?.source?.file_path ? { source: { ...ex.data.source } } : {}),
            ...(ex?.data?.contentState ? { contentState: ex.data.contentState } : {}),
            ...(ex?.data?.contentWindow ? { contentWindow: ex.data.contentWindow } : {}),
            ...(ex?.data?.scan ? { scan: ex.data.scan } : {}),
            ...(ex?.data?.processes ? { processes: ex.data.processes } : {}),
          },
        };
        if (ex && ex.style) node.style = { ...ex.style };
        return node;
      });
      // 隐藏流不出现在文本视图：应用文本时原样并回（含位置/尺寸），其连线一并保留。
      const textIds = new Set(rawNodes.map((n) => n.id));
      const keptHidden = nodes
        .filter((n) => !isStreamVisible(n) && !textIds.has(String(n.id)))
        .map((n) => {
          const node = {
            id: String(n.id),
            position: { ...n.position },
            data: {
              name: n.data?.name != null ? String(n.data.name) : n.data?.title != null ? String(n.data.title) : '',
              ...(n.data?.content ? { content: String(n.data.content) } : {}),
              ...(n.data?.contentState ? { contentState: n.data.contentState } : {}),
              ...(n.data?.description ? { description: String(n.data.description) } : {}),
              ...(normalizeFields(n.data?.fields).length
                ? { fields: normalizeFields(n.data.fields) }
                : {}),
              ...(n.data?.source?.file_path ? { source: { ...n.data.source } } : {}),
              ...(n.data?.contentWindow ? { contentWindow: n.data.contentWindow } : {}),
              ...(normalizeScan(n.data?.scan) ? { scan: normalizeScan(n.data.scan) } : {}),
              ...(normalizeProcesses(n.data?.processes).length
                ? { processes: normalizeProcesses(n.data.processes) }
                : {}),
            },
          };
          if (n.style) node.style = { ...n.style };
          return node;
        });
      const keptIds = new Set(keptHidden.map((n) => n.id));
      const rawEdges = graph.edges.map((ge) => {
        const key = `${ge.source} ${ge.target}`;
        const reuse = !used.has(key) ? pairToId.get(key) : null;
        used.add(key);
        const edge = {
          id: reuse || `e-${edgeSeqRef.current++}`,
          source: ge.source,
          target: ge.target,
        };
        if (ge.label) edge.label = ge.label;
        return edge;
      });
      // 触及隐藏流的连线不在文本里，从当前画布原样保留（两端点仍在最终集合才留）。
      const finalIds = new Set([...textIds, ...keptIds]);
      const keptEdges = edges
        .filter(
          (e) =>
            (!textIds.has(String(e.source)) || !textIds.has(String(e.target))) &&
            finalIds.has(String(e.source)) &&
            finalIds.has(String(e.target))
        )
        .map((e) => ({
          id: String(e.id),
          source: String(e.source),
          target: String(e.target),
          ...(e.label ? { label: String(e.label) } : {}),
        }));
      const allRawNodes = [...rawNodes, ...keptHidden];
      const allRawEdges = [...rawEdges, ...keptEdges];
      const canvas = toCanvasGraph({ nodes: allRawNodes, edges: allRawEdges });
      applyingTextRef.current = true;
      setNodes(canvas.nodes);
      setEdges(canvas.edges);
      refreshCounters(canvas.nodes, canvas.edges);
      const canonical = serializeTextView(rawNodes, rawEdges);
      setPanelBase(canonical);
      setPanelDirty(false);
      setPanelMsg(null);
      return {
        nextCanonical: canonical,
        nodeCount: rawNodes.length,
        edgeCount: rawEdges.length,
        warnings,
        changed: true,
      };
    },
    [logicText, nodes, edges, pushHistory, refreshCounters, setNodes, setEdges]
  );

  // 文本区输入 → 防抖自动应用（合法 JSON 才生效，非法时保留画布并提示）
  const onPanelTextChange = useCallback(
    (e) => {
      const v = e.target.value;
      setPanelText(v);
      clearTimeout(textTimerRef.current);
      if (v === panelBase) {
        setPanelDirty(false);
        setPanelMsg(null);
        return;
      }
      setPanelDirty(true);
      textTimerRef.current = setTimeout(() => {
        textTimerRef.current = null;
        if (applyTextToCanvasRef.current) applyTextToCanvasRef.current(v);
      }, 800);
    },
    [panelBase]
  );

  const applyPanel = useCallback(() => {
    clearTimeout(textTimerRef.current);
    textTimerRef.current = null;
    const res = applyTextToCanvas(panelText);
    if (!res) return;
    if (res.nextCanonical) {
      setPanelText(res.nextCanonical);
    }
    const parts = [];
    if (res.warnings.length) parts.push(`警告：${res.warnings.join('；')}`);
    parts.push(`已应用：${res.nodeCount} 个节点 / ${res.edgeCount} 条连线`);
    const msg = parts.join('，');
    setPanelMsg({ kind: res.warnings.length ? 'warn' : 'ok', text: msg });
    setStatus(msg);
  }, [panelText, applyTextToCanvas]);

  // 画布→文本：画布变化时自动刷新文本视图（用户正在文本区编辑时不覆盖，仅标记未同步）
  useEffect(() => {
    if (!panelOpen) return;
    if (applyingTextRef.current) {
      applyingTextRef.current = false;
      return;
    }
    if (textFocusedRef.current) {
      setPanelDirty(true);
      return;
    }
    textBurstRef.current = false;
    clearTimeout(textTimerRef.current);
    textTimerRef.current = null;
    setPanelText(logicText);
    setPanelBase(logicText);
    setPanelDirty(false);
    setPanelMsg(null);
  }, [logicText, panelOpen]);

  // 卸载清理：防抖定时器 + 拖拽期间残留的 body 样式
  useEffect(() => {
    return () => {
      clearTimeout(textTimerRef.current);
      textTimerRef.current = null;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, []);

  const copySelection = useCallback(() => {
    const selNodes = nodes.filter((n) => n.selected);
    if (selNodes.length === 0) {
      setStatus('没有选中的节点可复制');
      return;
    }
    const minX = Math.min(...selNodes.map((n) => n.position?.x ?? 0));
    const minY = Math.min(...selNodes.map((n) => n.position?.y ?? 0));
    const selIds = new Set(selNodes.map((n) => n.id));
    clipboardRef.current = {
      origin: { x: minX, y: minY },
      nodes: selNodes.map((n) => {
        const data = n.data || {};
        const content = data.content != null ? String(data.content) : '';
        const fields = normalizeFields(data.fields);
        const w = Number(n.style?.width);
        const h = Number(n.style?.height);
        const style = {};
        // 复制宽度与手动固定的高度；未固定的高度粘贴后仍由内容自适应。
        if (Number.isFinite(w) && w > 0) style.width = w;
        if (Number.isFinite(h) && h > 0) style.height = h;
        return {
          id: n.id,
          name: data.name != null ? String(data.name) : '',
          ...(content ? { content } : {}),
          ...(data.description ? { description: String(data.description) } : {}),
          ...(fields.length ? { fields } : {}),
          rel: { x: (n.position?.x ?? 0) - minX, y: (n.position?.y ?? 0) - minY },
          ...(style.width || style.height ? { style } : {}),
        };
      }),
      edges: edges
        .filter((e) => selIds.has(e.source) && selIds.has(e.target))
        .map((e) => ({
          source: e.source,
          target: e.target,
          ...(e.label ? { label: e.label } : {}),
        })),
    };
    pasteCountRef.current = 1;
    setStatus(`已复制 ${selNodes.length} 个节点`);
  }, [nodes, edges]);

  const pasteSelection = useCallback(() => {
    const clip = clipboardRef.current;
    if (!clip || clip.nodes.length === 0) return;
    pushHistory();
    const step = pasteCountRef.current++;
    const idMap = {};
    const rawNodes = clip.nodes.map((item) => {
      const id = `n-${nodeSeqRef.current++}`;
      idMap[item.id] = id;
      const fields = normalizeFields(item.fields);
      const node = {
        id,
        selected: true,
        position: {
          x: clip.origin.x + item.rel.x + 32 * step,
          y: clip.origin.y + item.rel.y + 32 * step,
        },
        data: {
          name: item.name,
          ...(item.content ? { content: item.content } : {}),
          ...(item.description ? { description: item.description } : {}),
          ...(fields.length ? { fields } : {}),
        },
      };
      if (item.style) node.style = { ...item.style };
      return node;
    });
    const rawEdges = clip.edges.map((e) => ({
      id: `e-${edgeSeqRef.current++}`,
      source: idMap[e.source],
      target: idMap[e.target],
      ...(e.label ? { label: e.label } : {}),
    }));
    const canvas = toCanvasGraph({ nodes: rawNodes, edges: rawEdges });
    setNodes((nds) => [...nds, ...canvas.nodes]);
    setEdges((eds) => [...eds, ...canvas.edges]);
    setStatus(`已粘贴 ${rawNodes.length} 个节点`);
    // 粘贴产生的是 pending（n-*）节点：在线时立即自动提升为 SE 流（闭环；setTimeout 等 nodesRef 同步）。
    const sid = activeSystemIdRef.current;
    if (sid && boundOnlineNow()) {
      setTimeout(() => promotePendingRef.current?.(String(sid)).catch(() => {}), 0);
    }
  }, [pushHistory, setNodes, setEdges, boundOnlineNow]);

  const selectAll = useCallback(() => {
    if (!nodes.length && !edges.length) {
      setStatus('画布为空，没有可全选的内容');
      return;
    }
    const state = storeApi.getState();
    if (nodes.length) state.addSelectedNodes(nodes.map((n) => n.id));
    if (edges.length) state.addSelectedEdges(edges.map((e) => e.id));
    setStatus(`已全选 ${nodes.length} 个节点 / ${edges.length} 条连线`);
  }, [nodes, edges, storeApi]);

  // 键盘/工具栏删除：连线真删；节点 = 从画布移除（写 canvas:false，数据保留）。
  // 返回 false 阻止 React Flow 默认删除，由这里统一处理。
  const onBeforeDelete = useCallback(
    async ({ nodes: delNodes, edges: delEdges }) => {
      if (guardOffline()) return false;
      const sid = activeSystemIdRef.current;
      const boundOnline =
        !!sid && !systemOfflineRef.current && sePool.get(String(sid)).status === SE_STATUS.ONLINE;

      if (editingIdRef.current && delNodes.some((n) => String(n.id) === editingIdRef.current)) {
        exitEdit(true);
      }

      // 可见的待删节点：绑定在线的 s-* 走 SE 可见性写路径；本地/离线节点保持本地行为。
      const visibleNodes = delNodes.filter((n) => {
        const cur = nodesRef.current.find((x) => String(x.id) === String(n.id));
        return cur && isStreamVisible(cur);
      });
      const seNames = [];
      const localIds = [];
      visibleNodes.forEach((n) => {
        const name = streamNameFromId(n.id);
        if (boundOnline && name) seNames.push(name);
        else localIds.push(String(n.id));
      });

      // 边分两类：绑定在线的 SE 边走 tag 写路径（压 se-tags 记录）；本地边保留 graph 快照。
      const seEdgeList = boundOnline ? delEdges.filter((e) => isSeEdge(e)) : [];
      const localEdgeList = delEdges.filter((e) => !(boundOnline && isSeEdge(e)));

      if (localEdgeList.length || localIds.length) pushHistory();

      if (localEdgeList.length) {
        const ids = new Set(localEdgeList.map((e) => e.id));
        setEdges((eds) => eds.filter((e) => !ids.has(e.id)));
      }
      if (seEdgeList.length) {
        const ops = [];
        seEdgeList.forEach((e) => {
          const s = streamNameFromId(e.source);
          const t = streamNameFromId(e.target);
          if (s && t) ops.push({ source: s, key: edgeTagKey(t), value: null });
        });
        const delIds = new Set(seEdgeList.map((e) => e.id));
        const localApply = () => setEdges((eds) => eds.filter((e) => !delIds.has(e.id)));
        if (ops.length) {
          seApplyTagChanges(buildEdgeEntries(ops), localApply, `删除 ${seEdgeList.length} 条连线`, {
            validate: (p) => !!p && Array.isArray(p.edges) && !p.edges.some((e) => delIds.has(e.id)),
          });
        } else {
          localApply();
        }
      }
      if (localIds.length) {
        const ids = new Set(localIds);
        setNodes((nds) =>
          nds.map((n) => {
            if (!ids.has(String(n.id)) || !isStreamVisible(n)) return n;
            const fields = normalizeFields(n.data?.fields).filter((f) => f.key !== 'canvas');
            fields.push({ key: 'canvas', value: 'false' });
            return { ...n, selected: false, data: { ...n.data, fields } };
          })
        );
      }
      if (seNames.length) {
        // 与 toggleStreamCanvas 共用同一 SE 可见性写路径（禁止复制第二份实现）。
        const localApply = () =>
          setNodes((nds) =>
            nds.map((n) => {
              const name = streamNameFromId(n.id);
              if (!name || !seNames.includes(name) || !isStreamVisible(n)) return n;
              const fields = normalizeFields(n.data?.fields).filter((f) => f.key !== 'canvas');
              fields.push({ key: 'canvas', value: 'false' });
              return { ...n, selected: false, data: { ...n.data, fields } };
            })
          );
        seApplyVisibility(
          seNames,
          false,
          localApply,
          seNames.length > 1 ? `隐藏 ${seNames.length} 个流` : `隐藏流「${seNames[0]}」`
        );
      }
      if (delNodes.length) {
        notify(
          delNodes.length > 1
            ? `已将 ${delNodes.length} 个流从画布移除（仍在左侧列表中）`
            : '已从画布移除（流仍在左侧列表中）',
          'info'
        );
      }
      return false;
    },
    [pushHistory, setNodes, setEdges, exitEdit, notify, guardOffline, seApplyVisibility, seApplyTagChanges]
  );

  useEffect(() => {
    const isTypingTarget = (t) => {
      if (!t || !(t instanceof HTMLElement)) return false;
      if (t.isContentEditable) return true;
      const tag = t.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    };
    const onKeyDown = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (isTypingTarget(e.target)) return;
      const block = blockRef.current;
      // 编辑态屏蔽画布快捷键（编辑器内由 ProseMirror/浏览器接管）
      if (block.editing) return;
      const fn = shortcutsRef.current;
      const key = e.key.toLowerCase();
      if (key === 'b') {
        e.preventDefault();
        fn.toggleSidebar();
        return;
      }
      // 存在原生文本选区时，Ctrl+C/A 还给浏览器（复制/全选节点内只读文本），不执行节点级复制/全选。
      if (key === 'c' || key === 'a') {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && String(sel).length > 0) return;
      }
      if (block.dialog || block.edgeEdit || block.panelOpen) return;
      if (key === 'c') {
        e.preventDefault();
        fn.copySelection();
      } else if (key === 'v') {
        e.preventDefault();
        fn.pasteSelection();
      } else if (key === 'a') {
        e.preventDefault();
        fn.selectAll();
      } else if (key === 'z') {
        e.preventDefault();
        if (e.shiftKey) fn.redo();
        else fn.undo();
      } else if (key === 'y') {
        e.preventDefault();
        fn.redo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // 编辑态焦点保护：非输入类 mousedown 一律 preventDefault，防止编辑器失焦；
  // 只放行表单控件/可编辑区/源面板（原型 index.html:4914-4921）。
  // 工具栏/侧栏/浮条靠自身 preventDefault 保焦点，这里的全局拦截不阻断其 click。
  useEffect(() => {
    if (!editingNodeId) return undefined;
    const onMouseDown = (e) => {
      if (e.button !== 0) return;
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t.isContentEditable) return;
      if (t.closest('input, textarea, select')) return;
      if (t.closest('.modal-overlay')) return;
      e.preventDefault();
    };
    document.addEventListener('mousedown', onMouseDown, true);
    return () => document.removeEventListener('mousedown', onMouseDown, true);
  }, [editingNodeId]);

  // Esc 级联：片段库 → ⋯菜单 → 右键菜单 → 选区浮条 → 退出编辑。
  // 前四层由 escStack 注册（顶层消费），无人消费时才退出编辑会话。
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (runTopEsc()) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (!editingIdRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      exitEdit(true);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [exitEdit]);

  shortcutsRef.current = { copySelection, pasteSelection, selectAll, undo, redo, toggleSidebar };
  blockRef.current = { dialog, edgeEdit, panelOpen, editing: !!editingNodeId };
  applyTextToCanvasRef.current = applyTextToCanvas;

  // 离线只读守卫：内容提交/元数据/可见性入口统一挂起（§5.3）。
  nodeActions.onEditText = guardWrap(updateNodeText);
  nodeActions.onEditField = guardWrap(updateNodeField);
  nodeActions.onAddField = guardWrap(addField);
  nodeActions.onRemoveField = guardWrap(removeField);
  nodeActions.onResetSize = resetNodeSize;
  nodeActions.onResize = updateNodeSize;
  nodeActions.onDelete = guardWrap(removeFromCanvas);
  nodeActions.onEditContent = guardWrap((id) => enterEdit(id));
  nodeActions.onExitEdit = () => exitEdit(true);
  nodeActions.onEditContentText = guardWrap(applyEditContent);
  nodeActions.onEditorReady = (api) => {
    editorApiRef.current = api;
  };
  nodeActions.onSnippetsChange = (next) => {
    if (Array.isArray(next)) setSnippets(next);
  };
  nodeActions.onAddSnippet = (name, text) => addSnippet(name, text);
  nodeActions.onDeleteSnippet = (index) => deleteSnippet(index);
  nodeActions.onOpenSnippetLib = () => setSnippetLibOpen(true);
  nodeActions.onNotify = (text, kind) => notify(text, kind);
  // 期 15：只读分页历史页取回。按 PAGE_CHAR_BUDGET 绝对栅格请求服务端片段，写入 pageState
  // 缓存（AgentNode 订阅后重渲染命中）。seGate 保证绑定在线；失败仅 warn，不打断视图。
  nodeActions.onFetchHistoryPage = guardWrap(async (viewScope, nodeId, absStart, length) => {
    const sid = seGate();
    if (!sid) return;
    // 只写回发起请求的那个 tab 的 scope；切换标签页后迟到的回包不得污染其它画布。
    if (String(activeTabIdRef.current) !== String(viewScope)) return;
    const name = streamNameFromId(nodeId);
    if (!name) return;
    try {
      const client = sePool.get(String(sid));
      const res = await client.call('stream.read', { name, start: absStart });
      const slice = String((res && res.text) || '').slice(0, length);
      setHistoryPage(viewScope, nodeId, Math.floor(absStart / PAGE_CHAR_BUDGET), slice);
    } catch (err) {
      notify(`历史页加载失败：${(err && err.message) || String(err)}`, 'warn');
    }
  });
  nodeActions.onScanAction = guardWrap(dispatchScan);
  // Task5：pending 角标点击 → 手动重试该节点的提升（不套离线只读 guardWrap：promote 自身
  // 在离线时保持 pending 并给一次原因，未绑定则提示）。
  nodeActions.onRetrySync = (id) => {
    const sid = activeSystemIdRef.current;
    if (!sid) {
      notify('未绑定 SE 系统，无法同步该节点', 'warn');
      return;
    }
    promoteLocalNode(String(sid), String(id)).catch(() => {});
  };
  // 期 7 + 去 mock（§3.1）：绑定在线时终端发送/停止走真实 RPC（driver 负责日志/进程投影）；
  // driver 只经 ensure(sid) 暴露，故先取 entry 再取 processes（修复静默短路）。
  nodeActions.onSendInput = guardWrap((nodeId, processName, text) => {
    const sid = seGate();
    if (!sid) return;
    se.runtimeEntry(sid)?.processes?.sendInput(nodeId, processName, text);
  });
  nodeActions.onStopProcess = guardWrap((nodeId, processName) => {
    const sid = seGate();
    if (!sid) return;
    se.runtimeEntry(sid)?.processes?.stopProcess(nodeId, processName);
  });
  edgeActions.onEdit = openEdgeEdit;
  edgeActions.onEditLabel = commitEdgeLabel;
  edgeActions.onEditCancel = cancelEdgeEdit;
  edgeActions.onDelete = removeEdge;

  const editingTitle = editingNodeId
    ? String(nodes.find((n) => n.id === editingNodeId)?.data?.name || '')
    : '';

  return (
    <div className="app">
      <div className="toolbar">
        <input
          type="text"
          className="name-input graph-title"
          placeholder="未命名图"
          title={
            activeWorkDocPath
              ? `${isGraphsDocPath(activeWorkDocPath) ? '图名（即保存文件名）' : '显示名（文件名不变）'} · 保存到 ${activeWorkDocPath}`
              : '当前图名称（首次保存时作为文件名）'
          }
          value={graphName}
          onChange={(e) => setGraphName(e.target.value)}
        />
        <button
          type="button"
          onClick={() => updatePrefs({ sidebarCollapsed: !uiPrefs.sidebarCollapsed })}
          title="折叠 / 展开文件侧栏（Ctrl+B）"
        >
          <span className="chev">{uiPrefs.sidebarCollapsed ? '▶' : '◀'}</span> 文件
        </button>
        <span className="sep">|</span>
        <button onClick={saveCurrent} title="保存当前工作文档（与自动保存同一写盘链路）">
          保存
        </button>
        <span className="sep">|</span>
        <button onClick={addNode}>+ 添加节点</button>
        <span className="sep">|</span>
        <button
          onClick={() => openPackageExport('document')}
          title="导出配置包：流 + 工具（可复刻执行目录），自包含可分享"
        >
          💾 导出配置包…
        </button>
        <button onClick={() => openDialog('load')} title="加载统一文档（旧格式自动升级）">
          📂 加载文档…
        </button>
        <span className="sep">|</span>
        <button onClick={resetGraph}>重置</button>
        <button onClick={loadDemo}>示例</button>
        <button className={panelOpen ? 'active' : ''} onClick={panelOpen ? closePanel : openPanel}>
          文本视图
        </button>
        <button onClick={() => setSnippetLibOpen(true)} title="片段库（管理内置/自定义片段）">
          片段库
        </button>
        <button
          onClick={freezeRuntimeStreams}
          title="把当前页面运行期流（终端/扫描日志）固化为文档流（显式落盘）"
        >
          固化运行时流
        </button>
        {activeSystem && (
          <span
            className="se-badge"
            title={`SE 系统 ${activeSystem.system_id} · ${SE_STATUS_LABEL[activeStatus] || activeStatus}`}
          >
            <span className={`se-dot se-dot-${activeStatus}`} />
            <span className="se-badge-name">
              {activeSystem.display_name || activeSystem.system_id}
            </span>
          </span>
        )}
        <span className="theme-switch">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              className={'theme-dot' + (t.id === themeId ? ' active' : '')}
              style={{ background: t.accent }}
              title={t.name}
              onClick={() => setThemeId(t.id)}
            />
          ))}
        </span>
      </div>
      <div className="tabbar">
        {tabs.map((t) => {
          const isClosing = closingTabIds.has(t.id);
          return (
            <div
              key={t.id}
              className={`tab${t.id === activeId ? ' active' : ''}${isClosing ? ' closing' : ''}`}
              title={
                t.system
                  ? `${t.name || '未命名图'} · SE ${t.system.system_id}`
                  : t.name || '未命名图'
              }
              aria-busy={isClosing || undefined}
              onClick={() => switchTab(t.id)}
            >
              {t.system && (
                <span
                  className={`tab-se-dot se-dot-${
                    seStatusMap[t.system.system_id] || SE_STATUS.CONNECTING
                  }`}
                  title="SE 系统状态"
                />
              )}
              <span className="tab-name">{t.name || '未命名图'}</span>
              <button
                className="tab-close"
                title={isClosing ? '正在停止 SE…' : '关闭'}
                disabled={isClosing}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
        <button className="tab-add" onClick={addTab} title="新建标签页">
          +
        </button>
      </div>
      <div className="body">
        <FileSidebar
          collapsed={uiPrefs.sidebarCollapsed}
          width={uiPrefs.sidebarWidth}
          activePanel={uiPrefs.activePanel}
          onCollapsedChange={(c) => updatePrefs({ sidebarCollapsed: c })}
          onWidthChange={(w) => updatePrefs({ sidebarWidth: w })}
          onActivePanelChange={(p) => updatePrefs({ activePanel: p })}
          configPanel={
            <ConfigPanel
              onNotify={notify}
              openPaths={openDocPaths}
              onOpenPath={openConfigInTab}
              onCreateNew={addTab}
              onOpenTabRenamed={handleOpenTabRenamed}
            />
          }
          streamPanel={
            <StreamPanel
              streams={streamList}
              onNotify={notify}
              onExport={openPackageExport}
              onImport={openPackageImport}
              canImport={!!activeSystemId}
              onToggle={guardWrap(toggleStreamCanvas)}
              onCreate={guardWrap(createStream)}
              onRename={(id, name) => {
                // 按节点实际身份 + 绑定态 dispatch：
                //  - 非 s-* 的本地 pending 节点没有 SE 流 → 本地重命名（否则 renameStreamName 静默返回）；
                //  - s-* 流且绑定 tab → 走 SE 改名级联；
                //  - s-* 流但未绑定 tab → 回退本地重命名（恢复原 else 分支行为）。
                if (streamNameFromId(id) == null || !activeSystemId) updateNodeText(id, 'name', name);
                else renameStreamName(id, name);
              }}
              onDelete={guardWrap(openDeleteStream)}
              onDeleteMany={guardWrap(openDeleteStreams)}
              onUpdateMeta={guardWrap(updateStreamMeta)}
              onFocus={(id) => focusStream(id, false)}
              onEdit={(id) => focusStream(id, true)}
              onSaveAs={saveStreamToFile}
            />
          }
          filePanel={
            <FilePanel
              prefs={uiPrefs}
              onPrefs={updatePrefs}
              onNotify={notify}
              onCreateStreamFromFile={openStreamFromFile}
              onRegisterToolFromFile={openToolFromFile}
            />
          }
          toolPanel={
            <ToolPanel
              tools={tools}
              onNotify={notify}
              onExport={openPackageExport}
              onImport={openPackageImport}
              canImport={!!activeSystemId}
              onRegister={guardWrap(dispatchToolRegister)}
              onAdopt={guardWrap(dispatchToolAdopt)}
              onUpdate={guardWrap(dispatchToolUpdate)}
              onDelete={guardWrap(dispatchToolDelete)}
              onDeleteMany={guardWrap(deleteTools)}
              onInsert={insertToolCall}
              canManageTools={!activeSystemId ? true : canManageTools}
              bound={!!activeSystemId}
              statusByName={toolStatusByName}
              seOnlyTools={seOnlyTools}
            />
          }
        />
        <FlowEditHudContext.Provider value={flowEditHudRef}>
        <div
          className={`flow${systemOffline ? ' flow-offline' : ''}`}
          title={systemOffline ? '系统离线' : undefined}
          onDoubleClick={handlePaneDoubleClick}
          onDragOver={onFlowDragOver}
          onDrop={onFlowDrop}
        >
          {preflightUnavailable && (
            <div className="se-offline-banner">
              <span>SE 不可用：{sePreflight.reason}</span>
              <span>请设置 SE_PYTHON / SE_PACKAGE_PATH 后重启</span>
            </div>
          )}
          {systemOffline && !preflightUnavailable && (
            <div className="se-starting-banner">
              <span>系统正在启动，请稍候…</span>
            </div>
          )}
          {!systemOffline && seDangling.length > 0 && (
            <div className="se-offline-banner se-dangling-banner">
              <span>发现 {seDangling.length} 条悬空边</span>
              <button type="button" onClick={() => setDanglingOpen(true)}>
                处理…
              </button>
            </div>
          )}
          {/* 关闭库内 autoPan（autoPanOnNodeDrag/Selection=false）：节点 id 变更 / 模态打断指针手势时，autoPan rAF 循环可能泄漏导致视口漂移。 */}
          <ReactFlow
            nodes={renderNodes}
            edges={renderEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            defaultEdgeOptions={defaultEdgeOptions}
            onNodesChange={handleNodesChange}
            onEdgesChange={onEdgesChange}
            onMoveEnd={(_e, vp) => {
              viewportRef.current = vp;
            }}
            onMoveStart={cancelViewportRequest}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onConnectStart={onConnectStart}
            onConnectEnd={onConnectEnd}
            onReconnect={onReconnect}
            onBeforeDelete={onBeforeDelete}
            reconnectRadius={12}
            onEdgeDoubleClick={onEdgeDoubleClick}
            deleteKeyCode={editingNodeId ? null : ['Backspace', 'Delete']}
            autoPanOnNodeDrag={false}
            autoPanOnSelection={false}
            selectionOnDrag
            snapToGrid
            snapGrid={[GRID, GRID]}
            zoomOnDoubleClick={false}
            panOnScroll={false}
            zoomOnScroll={false}
            colorMode={colorMode}
            minZoom={CANVAS_MIN_ZOOM}
            maxZoom={CANVAS_MAX_ZOOM}
          >
            <Panel position="top-left" className="flow-hint-panel">
              <div className="flow-hint">
                <div>双击节点标题/内容就地编辑（Enter 提交 / Esc 取消） · 双击属性行改键值 · 选中节点后用上方工具条加/删属性 · 拖右缘/下缘/右下角自由调宽高 · 双击连线编辑文字 · Delete 删除</div>
                <div className="flow-hint-sec">撤销 Ctrl+Z · 重做 Ctrl+Y · 复制粘贴 Ctrl+C/V · 全选 Ctrl+A · 拖动连线端点改接 · 双击空白添加节点</div>
                <div className="flow-hint-sec">滚轮平移 · Shift+滚轮横向 · Ctrl/Cmd+滚轮精细缩放 · 节点内滚动用滚动条 · 编辑与输入用键盘</div>
              </div>
              {(selCount.nodes > 0 || selCount.edges > 0) && (
                <div className="flow-sel">
                  已选 {selCount.nodes} 节点 / {selCount.edges} 连线
                </div>
              )}
            </Panel>
            <Controls fitViewOptions={{ padding: CANVAS_FIT_PADDING }} />
            <MiniMap pannable zoomable maskStrokeWidth={2} />
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
            {/* 视口请求是唯一自动动作来源；空/未测量画布绝不 fit。 */}
            <ViewportController request={viewportRequest} onConsumed={consumeViewportRequest} />
            <CanvasWheelController minZoom={CANVAS_MIN_ZOOM} maxZoom={CANVAS_MAX_ZOOM} />
          </ReactFlow>
          {/* 屏幕空间编辑条：常驻宿主，只有编辑态才由 AgentNode portal 进来。
              pointer-events 由宿主关闭、工具栏自身打开，避免遮住画布交互。 */}
          <div
            ref={(el) => {
              flowEditHudRef.current = el;
            }}
            className="flow-edit-hud"
            aria-hidden={editingNodeId ? undefined : 'true'}
          />
          {streamList.every((s) => !s.visible) && (
            <div className="flow-empty-hint">
              <span>
                {streamList.length
                  ? '从左侧流列表点击 👁 或拖拽流到此'
                  : '双击空白添加节点，或从左侧流列表 ＋新建流'}
              </span>
            </div>
          )}
        </div>
        </FlowEditHudContext.Provider>
        {panelOpen && (
          <>
            <div
              className="side-resizer"
              title="拖动调整宽度"
              onPointerDown={startPanelResize}
              onPointerMove={onPanelResizeMove}
              onPointerUp={onPanelResizeEnd}
              onPointerCancel={onPanelResizeEnd}
            />
            <aside className="side-panel" style={{ width: panelWidth, flexBasis: panelWidth }}>
              <div className="side-header">
                <strong>文本视图</strong>
                {panelDirty && <span className="side-dirty">未同步</span>}
                <button className="side-close" onClick={closePanel} title="关闭">
                  ×
                </button>
              </div>
              <div className="side-actions">
                <button onClick={copyPanel}>复制</button>
                <button className="primary" onClick={applyPanel}>
                  应用
                </button>
              </div>
              <textarea
                className="side-area"
                value={panelText}
                spellCheck={false}
                onChange={onPanelTextChange}
                onFocus={() => {
                  textFocusedRef.current = true;
                }}
                onBlur={() => {
                  textFocusedRef.current = false;
                }}
              />
              {panelMsg && <div className={`side-msg ${panelMsg.kind}`}>{panelMsg.text}</div>}
            </aside>
          </>
        )}
      </div>
      <div className="statusbar">
        <span className={'status-edit' + (editingNodeId ? ' active' : '')}>
          {`编辑中的流: ${editingNodeId ? `节点「${editingTitle}」` : '无'}`}
        </span>
        <span className={'status-target' + (bridgeTarget ? ' active' : '')}>
          {`插入目标: ${bridgeTarget ? bridgeTarget.label : '无'}`}
        </span>
        <span className="status-msg">{status}</span>
      </div>
      <div className="toast-stack">
        {toasts.map((t) => (
          <Toast key={t.id} text={t.text} kind={t.kind} />
        ))}
      </div>
      {snippetLibOpen && (
        <SnippetLibrary
          snippets={snippets}
          onChange={(next) => Array.isArray(next) && setSnippets(next)}
          onClose={() => setSnippetLibOpen(false)}
          getEditorApi={() => editorApiRef.current}
          onNotify={notify}
        />
      )}
      {docPreview && (
        <ModalOverlay onCancel={() => setDocPreview(null)} closeOnEsc>
          <div className="modal">
            <h3>加载文档预览</h3>
            <div className="dlg-note">
              含 <b>{docPreview.streamCount}</b> 流 / <b>{docPreview.toolCount}</b> 工具；
              与当前页同名冲突 <b>{docPreview.streamConflicts}</b> 流 /{' '}
              <b>{docPreview.toolConflicts}</b> 工具。
            </div>
            {activeSystemId && (
              <div className="dlg-hint">
                已绑定 SE：边/可见性以 SE 为准，文档仅作快照参考（s-* 流不会被文档覆盖）。
              </div>
            )}
            <div className="dlg-actions doc-strategy">
              <button
                type="button"
                className="primary"
                onClick={() => applyLoadedDocument('replace')}
              >
                整页替换
              </button>
              <button type="button" onClick={() => applyLoadedDocument('skip')}>
                合并-跳过冲突
              </button>
              <button type="button" onClick={() => applyLoadedDocument('overwrite')}>
                合并-覆盖冲突
              </button>
              <button type="button" onClick={() => setDocPreview(null)}>
                取消
              </button>
            </div>
            <div className="dlg-hint">
              整页替换（默认）：清空当前页后载入；合并-跳过：同名流/工具保留当前；
              合并-覆盖：同名流更新内容+描述（标签仅新建时应用），同名工具覆盖。
            </div>
          </div>
        </ModalOverlay>
      )}
      {dialog && (
        <ModalOverlay onCancel={() => setDialog(null)} busy={dlgBusy} closeOnEsc={!dlgBusy}>
          <div className="modal">
            <h3>加载文档</h3>
            <div className="dlg-row">
              <input
                type="text"
                placeholder="完整路径，如 D:\graphs\my.json；也可点下方历史路径"
                value={dlgPath}
                onChange={(e) => setDlgPath(e.target.value)}
              />
              <button onClick={browsePath} disabled={dlgBusy}>
                浏览…
              </button>
            </div>
            <div className="history">
              {history.length === 0 && <div className="history-empty">暂无历史路径</div>}
              {history.map((h) => (
                <div key={h.path} className="history-item" onClick={() => setDlgPath(h.path)}>
                  <span className="history-path">{h.path}</span>
                  <span className="history-count">{h.use_count}x</span>
                  <button className="history-del" onClick={(e) => removeHistory(e, h.path)}>
                    ×
                  </button>
                </div>
              ))}
            </div>
            <div className="dlg-actions">
              <button className="primary" onClick={confirmDialog} disabled={dlgBusy}>
                加载
              </button>
              <button onClick={() => setDialog(null)}>取消</button>
            </div>
          </div>
        </ModalOverlay>
      )}
      {pkgExport && (
        <PackageExportDialog
          streams={pkgExport.streams}
          tools={pkgExport.tools}
          scope={pkgExport.scope || 'document'}
          boundPath={activeSystem?.manifest_path || null}
          busy={pkgBusy}
          progress={pkgProgress}
          onConfirm={runPackageExport}
          onClose={() => {
            if (!pkgBusy) setPkgExport(null);
          }}
        />
      )}
      {streamDraft && (
        <StreamFormDialog
          title={streamDraft.title || '从文件新建流'}
          streams={streamList}
          initial={streamDraft}
          onNotify={notify}
          onCancel={() => setStreamDraft(null)}
          onSubmit={(v) => {
            const draft = streamDraft;
            setStreamDraft(null);
            // Task 3：双击/连线携带的落点 → 写常驻布局表（重投影按 layout[name] 落点），
            // 使新建流按交互处落点放置，而非视口中心。
            if (draft.position && boundOnlineNow()) {
              const sid = activeSystemIdRef.current;
              if (sid) {
                const key = String(sid);
                layoutRef.current[key] = { ...(layoutRef.current[key] || {}), [v.name]: draft.position };
              }
            }
            createStream(v)
              .then((res) => {
                // Task 3 入口②：拖连线松手 → 在线创建成功后补 fromId → 新流的 SE 边（在线 seam）。
                if (draft.fromId && res && res.ok && !res.local) {
                  onConnect({ source: draft.fromId, target: streamNodeId(v.name) });
                }
              })
              // 防御：createStream 现有路径均有守卫不抛，一旦未来同步路径抛错不能静默。
              .catch((err) => notify(`创建流失败：${(err && err.message) || err}`, 'warn'));
          }}
        />
      )}
      {toolDraft && (
        <ToolFormDialog
          tools={Object.values(tools || {})}
          initial={toolDraft}
          onNotify={notify}
          onCancel={() => setToolDraft(null)}
          onSubmit={(v) => {
            setToolDraft(null);
            dispatchToolRegister(v);
          }}
        />
      )}
      {pkgImportChoose && (
        <ModalOverlay
          onCancel={() => setPkgImportChoose(null)}
          busy={pkgImportBusy}
          closeOnEsc={!pkgImportBusy}
        >
          <div className="modal">
            <h3>加载配置包</h3>
            <div className="dlg-hint">
              当前标签页已绑定配置包：<code>{pkgImportChoose}</code>
            </div>
            <div className="dlg-actions">
              <button
                type="button"
                className="primary"
                disabled={pkgImportBusy}
                onClick={() => {
                  const p = pkgImportChoose;
                  setPkgImportChoose(null);
                  loadPackageIntoBound({ path: p });
                }}
              >
                重新载入绑定的配置包
              </button>
              <button
                type="button"
                disabled={pkgImportBusy}
                onClick={() => {
                  setPkgImportChoose(null);
                  loadPackageIntoBound({ pick: true });
                }}
              >
                选择其他配置包…
              </button>
              <button
                type="button"
                disabled={pkgImportBusy}
                onClick={() => setPkgImportChoose(null)}
              >
                取消
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}
      {pkgImport && (
        <PackageImportDialog
          mode={pkgImport.mode}
          targetLabel={activeSystem?.display_name || activeSystemId || ''}
          plan={pkgImport.plan}
          hasPositions={!!readManifestLayout(pkgImport.manifest)}
          boundPath={activeSystem?.manifest_path || null}
          selectedPath={pkgImport.manifestPath}
          busy={pkgImportBusy}
          progress={pkgImportProgress}
          onConfirm={runPackageImport}
          onClose={() => {
            if (!pkgImportBusy) setPkgImport(null);
          }}
        />
      )}
      {newTabOpen && <NewTabDialog api={seApiBind} onClose={() => setNewTabOpen(false)} />}
      <CasConflictDialog
        conflict={casConflict}
        onOverwrite={resolveCasOverwrite}
        onDiscard={resolveCasDiscard}
      />
      {danglingOpen && (
        <DanglingEdgesDialog
          dangling={seDangling}
          onClear={clearDangling}
          onClose={() => setDanglingOpen(false)}
        />
      )}
      {cascadeRepair && (
        <CascadeRepairDialog
          diffs={cascadeRepair.diffs}
          onRetry={retryCascade}
          onDiscard={discardCascade}
        />
      )}
      {streamDelete && (
        <DeleteStreamDialog
          title={streamDelete.title}
          inboundCount={
            Array.isArray(streamDelete.refs)
              ? streamDelete.refs.length
              : streamDelete.localInbound || 0
          }
          showFileOption={streamDelete.showFileOption !== false}
          onCancel={() => setStreamDelete(null)}
          onConfirm={(mode) => {
            const { id, refs } = streamDelete;
            setStreamDelete(null);
            deleteStream(id, refs, mode);
          }}
        />
      )}
      {streamDeleteMany && (
        <DeleteStreamDialog
          title={streamDeleteMany.title}
          inboundCount={streamDeleteMany.inboundCount || 0}
          showFileOption={streamDeleteMany.showFileOption !== false}
          onCancel={() => setStreamDeleteMany(null)}
          onConfirm={(mode) => confirmDeleteStreams(mode)}
        />
      )}
      {scanResumeMissing && (
        <ModalOverlay onCancel={() => setScanResumeMissing(null)} closeOnEsc>
          <div className="modal">
            <h3>无法定位剩余步骤</h3>
            <div className="dlg-note">
              流「{scanResumeMissing.name || scanResumeMissing.nodeId}」在暂停期间内容被整体改写，
              自动重锚未找到可靠的继续位置（{scanResumeMissing.reason || 'resume-target-missing'}）。
              请选择从哪里继续：
            </div>
            {Array.isArray(scanResumeMissing.candidates) && scanResumeMissing.candidates.length > 0 ? (
              <div className="scan-resume-candidates">
                {scanResumeMissing.candidates.map((c, i) => (
                  <div className="scan-resume-candidate" key={`${c.position}-${i}`}>
                    <div className="scan-resume-meta">
                      #{i + 1} · {c.tool || '?'} @ {c.position}
                    </div>
                    {c.context ? <div className="scan-resume-context">{c.context}</div> : null}
                    <button
                      type="button"
                      className="primary"
                      onClick={() => {
                        const target = Number(c.position) || 0;
                        const nodeId = scanResumeMissing.nodeId;
                        setScanResumeMissing(null);
                        dispatchScan(nodeId, 'resume', target);
                      }}
                    >
                      从此继续
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="dlg-note">没有可用的候选标记（剩余标记可能已被删除）。</div>
            )}
            <div className="dlg-actions">
              <button
                type="button"
                onClick={() => {
                  const nodeId = scanResumeMissing.nodeId;
                  setScanResumeMissing(null);
                  dispatchScan(nodeId, 'rescan');
                }}
              >
                从头重扫
              </button>
              <button
                type="button"
                onClick={() => {
                  const nodeId = scanResumeMissing.nodeId;
                  setScanResumeMissing(null);
                  dispatchScan(nodeId, 'stop');
                }}
              >
                停止扫描
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}
      {renameConfirm && (
        <ModalOverlay onCancel={() => setRenameConfirm(null)} closeOnEsc>
          <div className="modal">
            <h3>确认改名</h3>
            <div className="dlg-note">
              将把流「{renameConfirm.old}」改名为「{renameConfirm.newName}」，并改写 {renameConfirm.refs.length} 条引用该流的边键，不可撤销。
            </div>
            <div className="dlg-actions">
              <button type="button" onClick={() => setRenameConfirm(null)}>
                取消
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  const pending = renameConfirm;
                  setRenameConfirm(null);
                  doRenameConfirmed(pending);
                }}
              >
                确认改名
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}
      {renameConflict && (
        <ModalOverlay onCancel={() => setRenameConflict(null)} closeOnEsc>
          <div className="modal">
            <h3>改流标识失败</h3>
            <div className="dlg-note">
              目标名「{renameConflict.newName}」存在残留（journal 段），{renameConflict.message}。
              系统状态未改变，请换一个 name 重试。
            </div>
            <div className="dlg-actions">
              <button type="button" onClick={() => setRenameConflict(null)}>
                知道了
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}
    </div>
  );
}
