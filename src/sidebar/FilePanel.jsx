import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { caretBridge } from '../caretBridge.js';
import { fileToImageDataUrl } from '../editor/imageEmbed.js';
import { toToolName } from '../se/nameContract.js';

// 图片扩展名：插入时走 /api/fs/asset 取字节 → 压缩成内联 data URI → image 节点；
// 插入/复制路径的分隔符统一为正斜杠 /（非图片文件仍按路径文本插入）
const IMG_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
// 安全策略：可执行文件不在侧栏内打开（真闸在 vite.config.js 的 open 端点）
const EXEC_EXT = /\.(exe|bat|cmd|ps1|lnk|msi|scr|com|vbs|dll)$/i;
// R-3 文件分类（仅按扩展名判定；FilePanel 绝不读文件内容）
const CODE_EXT = /\.(py|js|mjs|cjs|ts|sh|bat|ps1|rb|go|rs|java|c|cpp)$/i;
const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|svg|ico|bmp|pdf|docx?|xlsx?|pptx?|zip|7z|rar|gz|tar|mp[34]|avi|mov|mkv|wav|flac|woff2?|ttf|otf|exe|dll|msi|so|dylib|pyc|class|wasm|bin)$/i;

const isExecPath = (p) => EXEC_EXT.test(String(p || ''));
const basename = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
const toForwardSlash = (p) => String(p || '').replace(/\\/g, '/');
const stripExt = (n) => String(n || '').replace(/\.[^.]+$/, '') || String(n || '');
// 从文件名推荐工具名：保留 CJK（契约合法字符），非法字符折叠 `_`；仅用于预填，用户可改。
const sanitizeToolName = (n) => toToolName(n);
// 文件条目（非目录 / 非盘符且有路径）；文档 = 非代码、非已知二进制（含显式文本扩展名）
const isFileRow = (row) => !!row && row.type !== 'dir' && row.role !== 'drive' && !!row.path;
const isCodeRow = (row) => isFileRow(row) && CODE_EXT.test(row.path);
const isDocRow = (row) => isFileRow(row) && !CODE_EXT.test(row.path) && !BINARY_EXT.test(row.path);
// 绝对路径判定：盘符（C:\ / C:/）或 UNC（\\server\share）
const isAbsPath = (s) => /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(String(s || '').trim());
const byScore = (a, b) => (Number(b.score) || 0) - (Number(a.score) || 0);

const reduceMotion = () =>
  !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

/** 行图标：按扩展名（照原型 entryIcon） */
function entryIcon(entry) {
  if (entry.type === 'dir' || entry.role === 'drive') return '📁';
  const ext = String(entry.name || '').split('.').pop().toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return '🖼';
  if (['md', 'txt'].includes(ext)) return '📄';
  if (ext === 'json') return '🧩';
  if (['xlsx', 'csv'].includes(ext)) return '📊';
  if (['docx', 'pdf'].includes(ext)) return '📕';
  return '📎';
}

function fmtSize(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 后端 mtime 为毫秒数；格式化成原型口径 YYYY-MM-DD HH:MM */
function fmtTime(v) {
  if (v == null || v === '') return '—';
  const d = new Date(Number(v));
  if (Number.isNaN(d.getTime())) return '—';
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function shortPath(p) {
  const s = String(p || '');
  if (s.length <= 28) return s;
  return `${s.slice(0, 11)}…${s.slice(-15)}`;
}

/** 目录排序：目录恒在前；名称 localeCompare(zh-CN) / 大小 / 修改时间（数字） */
function sortEntries(entries, key, dir) {
  const mul = dir === 'desc' ? -1 : 1;
  return entries.slice().sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    let r = 0;
    if (key === 'size') r = (Number(a.size) || 0) - (Number(b.size) || 0);
    else if (key === 'mtime') r = (Number(a.mtime) || 0) - (Number(b.mtime) || 0);
    else r = String(a.name).localeCompare(String(b.name), 'zh-CN');
    return r * mul;
  });
}

/**
 * 文件面板（自 FileSidebar 平移，逻辑不动）。
 * props:
 * - prefs：{ sortKey, sortDir, colW } 排序与列宽偏好（App 持有并持久化）
 * - onPrefs(partial)：合并写回偏好
 * - onNotify(text, kind)：状态栏消息 + toast
 * - onCreateStreamFromFile({path,suggestedName})：R-3.1 文档文件 → 新建流（读取在 App 层）
 * - onRegisterToolFromFile({path,name})：R-3.2 代码文件 → 注册工具（仅路径引用）
 */
export default function FilePanel({
  prefs,
  onPrefs,
  onNotify,
  onCreateStreamFromFile,
  onRegisterToolFromFile,
}) {
  const [drives, setDrives] = useState([]);
  const [common, setCommon] = useState([]);
  const commonRef = useRef([]);
  const [mode, setMode] = useState('home');
  const [dirPath, setDirPath] = useState('');
  const [entries, setEntries] = useState([]);
  const [truncated, setTruncated] = useState(false);
  const [selectedPath, setSelectedPath] = useState(null);
  const [loading, setLoading] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [spin, setSpin] = useState(false);
  const [ctx, setCtx] = useState(null);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const [blocked, setBlocked] = useState(null);
  const [flashPath, setFlashPath] = useState(null);
  const [removingPath, setRemovingPath] = useState(null);
  const [dragWhich, setDragWhich] = useState(null);
  // 当前目录 / 范围搜索：查询词 / 范围 / 结果 / 截断标记 / 加载中
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState(''); // 搜索范围：空 = 当前目录；非空 = 绝对路径（递归）
  const [recursive, setRecursive] = useState(false); // 递归搜索中（由后端响应回填）
  const [searchEntries, setSearchEntries] = useState([]);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);

  const sortKey = prefs.sortKey || 'name';
  const sortDir = prefs.sortDir || 'asc';
  const scopeTrim = scope.trim();
  const scopeValid = scopeTrim === '' || isAbsPath(scopeTrim);
  const searching = query.trim().length > 0 || scopeTrim.length > 0; // 搜索态：列表数据源切换为搜索结果

  const [colW, setColW] = useState(() => prefs.colW || { size: 74, time: 122 });
  const colWRef = useRef(colW);
  colWRef.current = colW;

  const commonElsRef = useRef(new Map());
  const flipRef = useRef(null);
  const pendingFlashRef = useRef(null);
  const colDragRef = useRef(null);
  const suppressSortRef = useRef(0);
  const blockTimerRef = useRef(null);
  const menuRef = useRef(null);
  // 范围非法的警告只发一次；范围转为有效 / 清空后复位
  const scopeWarnRef = useRef(false);

  /* ---------------- 数据加载 ---------------- */

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/fs/drives');
        if (res.ok && !cancelled) setDrives(await res.json());
      } catch (err) {
        console.warn('读取盘符失败', err);
      }
    })();
    (async () => {
      try {
        const res = await fetch('/api/fs/frecency');
        if (res.ok) {
          const list = await res.json();
          const norm = (Array.isArray(list) ? list : [])
            .map((c) => ({
              path: c.path,
              name: c.name || basename(c.path),
              type: c.type || 'file',
              score: Number(c.score) || 0,
            }))
            .filter((c) => c.path)
            .sort(byScore);
          if (!cancelled) {
            commonRef.current = norm;
            setCommon(norm);
          }
        }
      } catch (err) {
        console.warn('读取常用失败', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 目录详情：进入目录 / 刷新时拉取
  useEffect(() => {
    if (mode !== 'dir' || !dirPath) return undefined;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/fs/list?path=${encodeURIComponent(dirPath)}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (cancelled) return;
        setEntries(Array.isArray(data.entries) ? data.entries : []);
        setTruncated(!!data.truncated);
      } catch (err) {
        if (!cancelled) {
          setEntries([]);
          setTruncated(false);
          onNotify(`读取目录失败：${(err && err.message) || err}`, 'err');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, dirPath, reloadTick, onNotify]);

  // 搜索：范围留空 = 当前目录一层；填绝对路径 = 递归整棵子树。180ms 防抖；空查询 + 空范围只清状态、不发请求；cancelled 防止旧响应覆盖新查询
  useEffect(() => {
    if (mode !== 'dir' || !dirPath) return undefined;
    const q = query.trim();
    if (scopeTrim && !scopeValid) {
      // 范围非空但不是绝对路径：不发请求，清空结果并提示一次
      setSearchEntries([]);
      setSearchTruncated(false);
      setSearchLoading(false);
      setRecursive(false);
      if (!scopeWarnRef.current) {
        scopeWarnRef.current = true;
        onNotify('搜索范围需为绝对路径（如 C:\\... 或 \\\\server\\share）', 'warn');
      }
      return undefined;
    }
    scopeWarnRef.current = false;
    if (!q && !scopeTrim) {
      setSearchEntries([]);
      setSearchTruncated(false);
      setSearchLoading(false);
      setRecursive(false);
      return undefined;
    }
    const root = scopeTrim && isAbsPath(scopeTrim) ? scopeTrim : dirPath;
    const rec = scopeTrim.length > 0 && isAbsPath(scopeTrim);
    let cancelled = false;
    const timer = setTimeout(() => {
      (async () => {
        setSearchLoading(true);
        try {
          const res = await fetch(
            `/api/fs/search?path=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}&recursive=${rec ? 1 : 0}`
          );
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          if (cancelled) return;
          setSearchEntries(Array.isArray(data.entries) ? data.entries : []);
          setSearchTruncated(!!data.truncated);
          setRecursive(!!data.recursive);
        } catch (err) {
          if (!cancelled) {
            setSearchEntries([]);
            setSearchTruncated(false);
            setRecursive(false);
            onNotify(`搜索失败：${(err && err.message) || err}`, 'err');
          }
        } finally {
          if (!cancelled) setSearchLoading(false);
        }
      })();
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mode, dirPath, scope, query, reloadTick, onNotify]);

  // 偏好里的列宽可能在挂载后异步到达；拖拽中不打断本地值
  useEffect(() => {
    if (!prefs.colW || colDragRef.current) return;
    if (prefs.colW.size !== colWRef.current.size || prefs.colW.time !== colWRef.current.time) {
      setColW(prefs.colW);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.colW]);

  /* ---------------- 常用计分 + FLIP ---------------- */

  const captureCommonRects = useCallback(() => {
    const map = new Map();
    if (mode !== 'home') return map;
    commonElsRef.current.forEach((el, p) => {
      if (el) map.set(p, el.getBoundingClientRect());
    });
    return map;
  }, [mode]);

  const bumpCommon = useCallback(
    (path, name, type) => {
      if (!path) return;
      const prevRects = captureCommonRects();
      const list = commonRef.current.slice();
      let isNew = false;
      const idx = list.findIndex((c) => c.path === path);
      if (idx >= 0) {
        list[idx] = { ...list[idx], score: (Number(list[idx].score) || 0) + 1 };
      } else {
        list.push({ path, name: name || basename(path), type: type || 'file', score: 1 });
        isNew = true;
      }
      list.sort(byScore);
      let final = list;
      if (final.length > 8) {
        if (isNew) {
          // 新条目必须可见：挤掉当前最低分的那条，而不是把刚加进来的挤掉
          final = final.slice();
          for (let k = final.length - 1; k >= 0; k -= 1) {
            if (final[k].path !== path) {
              final.splice(k, 1);
              break;
            }
          }
        } else {
          final = final.slice(0, 8);
        }
      }
      commonRef.current = final;
      setCommon(final);
      if (mode === 'home') {
        flipRef.current = { prev: prevRects };
        if (isNew) setFlashPath(path);
      } else if (isNew) {
        pendingFlashRef.current = path;
      }
      // 异步持久化计分（不计入 UI 关键路径）
      fetch('/api/fs/frecency', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, name: name || basename(path), type: type || 'file' }),
      }).catch((err) => console.warn('计分写入失败', err));
    },
    [captureCommonRects, mode]
  );

  // FLIP：在常用列表变化后，对位移的行做 translateY 动画
  useLayoutEffect(() => {
    const flip = flipRef.current;
    if (!flip) return;
    flipRef.current = null;
    if (reduceMotion() || mode !== 'home') return;
    commonElsRef.current.forEach((el, p) => {
      if (!el) return;
      const prev = flip.prev && flip.prev.get(p);
      if (!prev) return;
      const dy = prev.top - el.getBoundingClientRect().top;
      if (Math.abs(dy) > 1) {
        try {
          el.animate(
            [{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }],
            { duration: 280, easing: 'cubic-bezier(.2,.8,.2,1)' }
          );
        } catch (err) {
          /* ignore */
        }
      }
    });
  }, [common, mode]);

  // 返回主页时补闪「在目录详情里新增的常用项」
  useEffect(() => {
    if (mode !== 'home') return;
    const p = pendingFlashRef.current;
    if (p) {
      pendingFlashRef.current = null;
      setFlashPath(p);
    }
  }, [mode, common]);

  // 新条目闪烁 900ms 后移除
  useEffect(() => {
    if (!flashPath) return undefined;
    const t = setTimeout(() => setFlashPath(null), 900);
    return () => clearTimeout(t);
  }, [flashPath]);

  /* ---------------- 操作 ---------------- */

  const enterDir = useCallback((path) => {
    setMode('dir');
    setDirPath(path);
    setSelectedPath(null);
    setEntries([]);
    setTruncated(false);
    setQuery('');
    setScope('');
  }, []);

  const goHome = useCallback(() => {
    setMode('home');
    setDirPath('');
    setSelectedPath(null);
    setQuery('');
    setScope('');
  }, []);

  const refreshDir = useCallback(() => {
    setSpin(true);
    setTimeout(() => setSpin(false), 600);
    setReloadTick((t) => t + 1);
    onNotify('已刷新目录', 'ok');
  }, [onNotify]);

  const blockExec = useCallback(
    (path) => {
      onNotify('安全策略：可执行文件不通过此处打开（可用「在资源管理器中显示」）', 'warn');
      setBlocked(null);
      requestAnimationFrame(() => setBlocked(path));
      clearTimeout(blockTimerRef.current);
      blockTimerRef.current = setTimeout(() => setBlocked(null), 950);
    },
    [onNotify]
  );

  // 图片路径插入：取原始字节（/api/fs/asset）→ 浏览器压缩成有界 data URI → 编辑器 image 节点。
  // 绝不插入绝对路径（图片必须随 Markdown 文本自包含）。
  const insertImagePath = useCallback(
    async (path, name, type) => {
      if (!caretBridge.target || typeof caretBridge.target.insertImage !== 'function') {
        onNotify('请先进入节点编辑器再插入图片', 'warn');
        return;
      }
      const label = name || basename(path);
      try {
        const res = await fetch('/api/fs/asset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path }),
        });
        if (!res.ok) {
          let detail = `HTTP ${res.status}`;
          try {
            const data = await res.json();
            if (data && data.error) detail = String(data.error);
          } catch (err) {
            /* 错误体不是 JSON：沿用状态码 */
          }
          throw new Error(detail);
        }
        const blob = await res.blob();
        const file = new File([blob], label, {
          type: blob.type || 'application/octet-stream',
        });
        const { dataUrl } = await fileToImageDataUrl(file);
        if (!caretBridge.insertImage({ src: dataUrl, alt: stripExt(label) })) {
          throw new Error('当前编辑位置不支持插入图片');
        }
        onNotify('已插入图片', 'ok');
        bumpCommon(path, name, type);
      } catch (err) {
        onNotify(`插入图片失败：${(err && err.message) || err}`, 'err');
      }
    },
    [onNotify, bumpCommon]
  );

  const insertPath = useCallback(
    (path, name, type) => {
      if (!caretBridge.target) {
        onNotify('请先点击要插入的文本位置', 'warn');
        return;
      }
      if (IMG_EXT.test(path)) {
        // 图片走异步资产通道；调用方忽略返回的 Promise 也不影响。
        void insertImagePath(path, name, type);
        return;
      }
      const text = toForwardSlash(path);
      caretBridge.insert(text);
      onNotify(`已插入: ${text}`, 'ok');
      bumpCommon(path, name, type);
    },
    [onNotify, bumpCommon, insertImagePath]
  );

  const openRow = useCallback(
    async (row) => {
      const { path, name, type, role } = row;
      if (isExecPath(path)) {
        blockExec(path);
        return;
      }
      const dir = role === 'drive' || type === 'dir';
      if (dir) {
        enterDir(path);
        onNotify(`已打开文件夹: ${name || basename(path)}`, 'info');
        bumpCommon(path, name || basename(path), 'dir');
        return;
      }
      try {
        const res = await fetch('/api/fs/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path }),
        });
        if (res.status === 403) {
          const body = await res.json().catch(() => ({}));
          if (body.error === 'exec-blocked') {
            blockExec(path);
            return;
          }
          onNotify('打开失败：路径不在允许范围', 'err');
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        onNotify(`已调用系统默认程序打开: ${name || basename(path)}`, 'info');
        bumpCommon(path, name || basename(path), 'file');
      } catch (err) {
        onNotify(`打开失败：${(err && err.message) || err}`, 'err');
      }
    },
    [blockExec, bumpCommon, enterDir, onNotify]
  );

  const revealPath = useCallback(
    async (path, name) => {
      try {
        const res = await fetch('/api/fs/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path, reveal: true }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        onNotify(`已在资源管理器中定位: ${name || basename(path)}`, 'info');
      } catch (err) {
        onNotify(`定位失败：${(err && err.message) || err}`, 'err');
      }
    },
    [onNotify]
  );

  const copyText = useCallback(
    async (text) => {
      let ok = false;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch (err) {
        /* 降级 */
      }
      if (!ok) {
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          ok = document.execCommand('copy');
          document.body.removeChild(ta);
        } catch (err2) {
          ok = false;
        }
      }
      onNotify(ok ? `已复制: ${text}` : '复制失败，请手动复制', ok ? 'ok' : 'err');
    },
    [onNotify]
  );

  const removeCommon = useCallback(
    (path) => {
      setRemovingPath(path);
      setTimeout(() => {
        setRemovingPath(null);
        const list = commonRef.current.filter((c) => c.path !== path);
        commonRef.current = list;
        setCommon(list);
        onNotify('已从常用中移除', 'info');
      }, 200);
    },
    [onNotify]
  );

  /* ---------------- 排序 / 列宽 ---------------- */

  const onSort = useCallback(
    (key) => {
      if (Date.now() < suppressSortRef.current) return;
      if (sortKey === key) onPrefs({ sortKey: key, sortDir: sortDir === 'asc' ? 'desc' : 'asc' });
      else onPrefs({ sortKey: key, sortDir: 'asc' });
    },
    [sortKey, sortDir, onPrefs]
  );

  const setColWidth = useCallback((next) => {
    colWRef.current = next;
    setColW(next);
  }, []);

  const onColPointerDown = useCallback(
    (which, e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const grip = e.currentTarget;
      const head = grip.closest('.dir-head');
      const avail = head ? head.clientWidth - 32 - 12 : 0; // 扣掉操作列与 3 个 4px 间距
      colDragRef.current = {
        which,
        id: e.pointerId,
        sx: e.clientX,
        size0: colWRef.current.size,
        time0: colWRef.current.time,
        avail,
        moved: false,
      };
      try {
        grip.setPointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
      setDragWhich(which);
      document.documentElement.classList.add('col-resizing');
    },
    []
  );

  const onColPointerMove = useCallback(
    (e) => {
      const d = colDragRef.current;
      if (!d || e.pointerId !== d.id) return;
      const dx = e.clientX - d.sx;
      if (!d.moved && Math.abs(dx) < 3) return; // 阈值内视为点击
      d.moved = true;
      let { size, time } = colWRef.current;
      if (d.which === 'name-size') {
        const maxSize = Math.max(60, d.avail - d.time0 - 100);
        size = Math.round(Math.max(60, Math.min(maxSize, d.size0 - dx)));
      } else {
        const sum = d.size0 + d.time0; // 成对调整，保证名称列不变
        let ns = Math.max(60, Math.min(d.size0 + dx, sum - 90));
        let nt = sum - ns;
        if (nt < 90) {
          nt = 90;
          ns = sum - 90;
        }
        if (ns < 60) {
          ns = 60;
          nt = sum - 60;
        }
        size = Math.round(ns);
        time = Math.round(nt);
      }
      setColWidth({ size, time });
    },
    [setColWidth]
  );

  const onColPointerUp = useCallback(
    (e) => {
      const d = colDragRef.current;
      if (!d || e.pointerId !== d.id) return;
      const grip = e.currentTarget;
      try {
        if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
      setDragWhich(null);
      document.documentElement.classList.remove('col-resizing');
      colDragRef.current = null;
      if (d.moved) {
        suppressSortRef.current = Date.now() + 160;
        onPrefs({ colW: colWRef.current });
      }
    },
    [onPrefs]
  );

  const onColKeyDown = useCallback(
    (which, e) => {
      const step = e.shiftKey ? 1 : 16;
      let handled = true;
      let { size, time } = colWRef.current;
      if (which === 'name-size') {
        if (e.key === 'ArrowRight') size = Math.max(60, size - step);
        else if (e.key === 'ArrowLeft') size = Math.min(400, size + step);
        else handled = false;
      } else if (e.key === 'ArrowRight') {
        size = Math.min(400, size + step);
        time = Math.max(90, time - step);
      } else if (e.key === 'ArrowLeft') {
        size = Math.max(60, size - step);
        time = Math.min(500, time + step);
      } else {
        handled = false;
      }
      if (!handled) return;
      e.preventDefault();
      const next = { size, time };
      setColWidth(next);
      onPrefs({ colW: next });
    },
    [onPrefs, setColWidth]
  );

  // 卸载清理：列宽拖拽残留的 document 样式与拦截定时器
  useEffect(
    () => () => {
      document.documentElement.classList.remove('col-resizing');
      clearTimeout(blockTimerRef.current);
    },
    []
  );

  /* ---------------- 右键菜单 ---------------- */

  const openCtx = useCallback((e, row) => {
    e.preventDefault();
    e.stopPropagation();
    const pos = { x: e.clientX, y: e.clientY };
    setMenuPos(pos);
    setCtx({ ...pos, row });
  }, []);

  useLayoutEffect(() => {
    if (!ctx || !menuRef.current) return;
    const w = menuRef.current.offsetWidth;
    const h = menuRef.current.offsetHeight;
    setMenuPos({
      x: Math.max(6, Math.min(ctx.x, window.innerWidth - w - 8)),
      y: Math.max(6, Math.min(ctx.y, window.innerHeight - h - 8)),
    });
  }, [ctx]);

  useEffect(() => {
    if (!ctx) return undefined;
    const onDocDown = (e) => {
      if (e.target instanceof Element && e.target.closest('.context-menu')) return;
      setCtx(null);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setCtx(null);
    };
    const onScroll = () => setCtx(null);
    document.addEventListener('mousedown', onDocDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [ctx]);

  const runCtx = useCallback(
    (act) => {
      const row = ctx && ctx.row;
      setCtx(null);
      if (!row) return;
      if (act === 'open') openRow(row);
      else if (act === 'reveal') revealPath(row.path, row.name);
      else if (act === 'copy') copyText(toForwardSlash(row.path));
      else if (act === 'insert')
        insertPath(row.path, row.name, row.type || (row.role === 'drive' ? 'dir' : 'file'));
      else if (act === 'uncommon') removeCommon(row.path);
      else if (act === 'createStream')
        onCreateStreamFromFile?.({
          path: row.path,
          suggestedName: stripExt(row.name || basename(row.path)),
        });
      else if (act === 'registerTool')
        onRegisterToolFromFile?.({
          path: row.path,
          name: sanitizeToolName(stripExt(row.name || basename(row.path))),
        });
    },
    [
      ctx,
      openRow,
      revealPath,
      copyText,
      insertPath,
      removeCommon,
      onCreateStreamFromFile,
      onRegisterToolFromFile,
    ]
  );

  /* ---------------- 派生渲染数据 ---------------- */

  const topCommon = useMemo(() => common.slice().sort(byScore).slice(0, 8), [common]);
  const sourceEntries = searching ? searchEntries : entries;
  const sortedEntries = useMemo(
    () => sortEntries(sourceEntries, sortKey, sortDir),
    [sourceEntries, sortKey, sortDir]
  );

  const crumbs = useMemo(() => {
    const out = [{ label: '此电脑', target: '__home__', current: false }];
    if (mode !== 'dir') return out;
    const drive = drives.find((d) => String(dirPath).indexOf(d.path) === 0);
    if (drive) {
      out.push({ label: drive.name, target: drive.path, current: dirPath === drive.path });
      const rel = String(dirPath).slice(drive.path.length).split(/[\\/]/).filter(Boolean);
      let acc = drive.path;
      rel.forEach((seg, i) => {
        acc += acc.endsWith('\\') || acc.endsWith('/') ? '' : '\\';
        acc += seg;
        out.push({ label: seg, target: acc, current: i === rel.length - 1 });
      });
    } else {
      out.push({ label: dirPath, target: dirPath, current: true });
    }
    return out;
  }, [mode, dirPath, drives]);

  const ind = (key) => {
    if (sortKey !== key) return <span className="sort-ind">↕</span>;
    return <span className="sort-ind on">{sortDir === 'asc' ? '▲' : '▼'}</span>;
  };

  const setCommonEl = (path) => (el) => {
    if (el) commonElsRef.current.set(path, el);
    else commonElsRef.current.delete(path);
  };

  /* ---------------- 渲染：主页 ---------------- */
  const homeView = (
    <div className="home-view">
      <div className="home-group">
        <div className="home-group-title">
          常用<span className="count">{topCommon.length}</span>
        </div>
        <div className="common-list">
          {topCommon.length ? (
            topCommon.map((c) => (
              <div
                key={c.path}
                ref={setCommonEl(c.path)}
                className={
                  'common-row' +
                  (selectedPath === c.path ? ' selected' : '') +
                  (blocked === c.path ? ' blocked' : '') +
                  (flashPath === c.path ? ' common-new' : '') +
                  (removingPath === c.path ? ' removing' : '')
                }
                onClick={() => setSelectedPath(c.path)}
                onDoubleClick={() => openRow({ path: c.path, name: c.name, type: c.type, role: 'common' })}
                onContextMenu={(e) =>
                  openCtx(e, { path: c.path, name: c.name, type: c.type, role: 'common' })
                }
              >
                <span className="row-icon">{entryIcon(c)}</span>
                <div className="common-meta">
                  <div className="common-name">{c.name}</div>
                  <div className="common-path" title={c.path}>
                    {shortPath(c.path)}
                  </div>
                </div>
                <span className="common-score" title="使用次数（插入 / 打开自动累计）">
                  ×{c.score}
                </span>
                <button
                  type="button"
                  className="row-insert"
                  title="插入路径到光标处（并计入常用）"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    insertPath(c.path, c.name, c.type);
                  }}
                >
                  +
                </button>
                <button
                  type="button"
                  className="row-remove"
                  title="移出常用"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeCommon(c.path);
                  }}
                >
                  ×
                </button>
              </div>
            ))
          ) : (
            <div className="common-empty">插入或打开过的文件 / 目录会自动出现在这里</div>
          )}
        </div>
      </div>

      <div className="home-group">
        <div className="home-group-title">
          此电脑<span className="count">{drives.length}</span>
        </div>
        <div className="drive-list">
          {drives.map((d) => (
            <div
              key={d.path}
              className={
                'drive-row' +
                (selectedPath === d.path ? ' selected' : '') +
                (blocked === d.path ? ' blocked' : '')
              }
              onClick={() => setSelectedPath(d.path)}
              onDoubleClick={() => openRow({ path: d.path, name: d.name, type: 'dir', role: 'drive' })}
              onContextMenu={(e) =>
                openCtx(e, { path: d.path, name: d.name, type: 'dir', role: 'drive' })
              }
            >
              <span className="row-icon">💽</span>
              <div className="common-meta">
                <div className="common-name">{d.name}</div>
                <div className="common-path">{d.label}</div>
              </div>
              <button
                type="button"
                className="row-insert"
                title="插入该盘符路径"
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  insertPath(d.path, d.name, 'dir');
                }}
              >
                +
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  /* ---------------- 渲染：目录详情 ---------------- */
  const dirView = (
    <div className="dir-view" style={{ '--w-size': `${colW.size}px`, '--w-time': `${colW.time}px` }}>
      <div className="crumb-bar">
        <button type="button" className="crumb-back" onClick={goHome}>
          ← 此电脑
        </button>
        <span className="crumbs">
          {crumbs.map((cr, i) => (
            <Fragment key={`${cr.target}-${i}`}>
              {i > 0 && <span className="crumb-sep">/</span>}
              <span
                className={'crumb' + (cr.current ? ' current' : '')}
                onClick={() => {
                  if (cr.current) return;
                  if (cr.target === '__home__') goHome();
                  else enterDir(cr.target);
                }}
              >
                {cr.label}
              </span>
            </Fragment>
          ))}
        </span>
        <button
          type="button"
          className={'crumb-refresh' + (spin ? ' spin' : '')}
          title="刷新"
          onClick={refreshDir}
        >
          ⟳
        </button>
      </div>

      <div className="dir-search">
        <span className="dir-search-icon">🔍</span>
        <input
          type="search"
          className="dir-search-input dir-search-scope"
          placeholder="范围：留空=当前目录，可填绝对路径递归搜索"
          aria-label="搜索范围（绝对路径）"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setScope('');
          }}
        />
        <input
          type="search"
          className="dir-search-input dir-search-term"
          placeholder="搜索词（可空）"
          aria-label="搜索词"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('');
          }}
        />
        {searching && (
          <span className="dir-search-count">{searchLoading ? '…' : `${searchEntries.length} 项`}</span>
        )}
        {searching && (
          <button
            type="button"
            className="dir-search-clear"
            title="清除搜索"
            onClick={() => {
              setQuery('');
              setScope('');
            }}
          >
            ×
          </button>
        )}
      </div>

      {truncated && !searching && (
        <div className="dir-trunc">
          ⚠ 条目过多，已截断显示（仅展示前 {sortedEntries.length} 条）
        </div>
      )}

      {searching && searchTruncated && (
        <div className="dir-trunc">⚠ 匹配结果过多，仅展示前 {sortedEntries.length} 条</div>
      )}

      <div className="dir-body">
        <div className="dir-head">
          <span className="col" onClick={() => onSort('name')}>
            名称 {ind('name')}
            <span
              className={'col-resizer' + (dragWhich === 'name-size' ? ' dragging' : '')}
              role="separator"
              tabIndex={0}
              aria-orientation="vertical"
              aria-label="调整名称列宽"
              aria-valuemin="60"
              aria-valuemax="400"
              aria-valuenow={Math.round(colW.size)}
              title="拖动调整名称列宽"
              onPointerDown={(e) => onColPointerDown('name-size', e)}
              onPointerMove={onColPointerMove}
              onPointerUp={onColPointerUp}
              onPointerCancel={onColPointerUp}
              onKeyDown={(e) => onColKeyDown('name-size', e)}
              onClick={(e) => e.stopPropagation()}
            />
          </span>
          <span className="col" onClick={() => onSort('size')}>
            大小 {ind('size')}
            <span
              className={'col-resizer' + (dragWhich === 'size-time' ? ' dragging' : '')}
              role="separator"
              tabIndex={0}
              aria-orientation="vertical"
              aria-label="调整大小列宽"
              aria-valuemin="90"
              aria-valuemax="500"
              aria-valuenow={Math.round(colW.time)}
              title="拖动调整大小列宽"
              onPointerDown={(e) => onColPointerDown('size-time', e)}
              onPointerMove={onColPointerMove}
              onPointerUp={onColPointerUp}
              onPointerCancel={onColPointerUp}
              onKeyDown={(e) => onColKeyDown('size-time', e)}
              onClick={(e) => e.stopPropagation()}
            />
          </span>
          <span className="col" onClick={() => onSort('mtime')}>
            修改时间 {ind('mtime')}
          </span>
          <span className="col col-act" />
        </div>

        {sortedEntries.length ? (
          sortedEntries.map((en) => (
            <div
              key={en.path}
              className={
                'row' +
                (selectedPath === en.path ? ' selected' : '') +
                (blocked === en.path ? ' blocked' : '')
              }
              onClick={() => setSelectedPath(en.path)}
              onDoubleClick={() =>
                openRow({ path: en.path, name: en.name, type: en.type, role: 'entry' })
              }
              onContextMenu={(e) =>
                openCtx(e, { path: en.path, name: en.name, type: en.type, role: 'entry' })
              }
            >
              <span className="col col-name">
                <span className="row-icon">{entryIcon(en)}</span>
                <span className="row-name-wrap">
                  <span className="row-name" title={en.name}>
                    {en.name}
                  </span>
                  {recursive && en.dir && (
                    <span className="row-loc" title={en.dir}>
                      {shortPath(en.dir)}
                    </span>
                  )}
                </span>
              </span>
              <span className="col col-size">{en.type === 'dir' ? '—' : fmtSize(en.size)}</span>
              <span className="col col-time">{fmtTime(en.mtime)}</span>
              <span className="col col-act">
                <button
                  type="button"
                  className="row-insert"
                  title="插入路径到光标处"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    insertPath(en.path, en.name, en.type);
                  }}
                >
                  +
                </button>
              </span>
            </div>
          ))
        ) : (
          <div className="dir-empty">
            {searching ? (searchLoading ? '搜索中…' : '无匹配结果') : loading ? '加载中…' : '（空目录）'}
          </div>
        )}
      </div>
    </div>
  );

  const blockedExec = ctx ? isExecPath(ctx.row.path) : false;

  return (
    <>
      <div className="sidebar-head">
        <strong>文件</strong>
        <span className="sidebar-state">
          {mode === 'home' ? '此电脑' : basename(dirPath) || dirPath}
        </span>
      </div>
      <div className="file-pane">{mode === 'home' ? homeView : dirView}</div>
      <div
        className="secure-note"
        title="open 端点拒绝可执行扩展名（.exe .bat .cmd .ps1 .lnk .msi .scr .com .vbs .dll）。"
      >
        <span className="secure-shield">🛡</span>
        <span>
          <b>安全策略已启用</b> · 可执行文件拦截中
        </span>
      </div>

      {ctx && (
        <div
          className="context-menu"
          ref={menuRef}
          style={{ left: menuPos.x, top: menuPos.y }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="ctx-title">{ctx.row.name}</div>
          <button
            type="button"
            disabled={blockedExec}
            title={blockedExec ? '可执行文件已被安全策略拦截' : undefined}
            onClick={() => runCtx('open')}
          >
            <span className="ctx-ico">{blockedExec ? '🛡' : '↗'}</span>打开
            {blockedExec && <span className="ctx-info">🛈</span>}
          </button>
          <button type="button" onClick={() => runCtx('reveal')}>
            <span className="ctx-ico">📂</span>在资源管理器中显示
          </button>
          <div className="ctx-sep" />
          <button type="button" onClick={() => runCtx('copy')}>
            <span className="ctx-ico">⧉</span>复制路径
          </button>
          <button type="button" onClick={() => runCtx('insert')}>
            <span className="ctx-ico">⌖</span>插入路径
          </button>
          {onCreateStreamFromFile && isDocRow(ctx.row) && (
            <button type="button" onClick={() => runCtx('createStream')}>
              <span className="ctx-ico">📝</span>从文件新建流…
            </button>
          )}
          {onRegisterToolFromFile && isCodeRow(ctx.row) && (
            <button type="button" onClick={() => runCtx('registerTool')}>
              <span className="ctx-ico">🔧</span>注册为工具…
            </button>
          )}
          {ctx.row.role === 'common' && (
            <>
              <div className="ctx-sep" />
              <button type="button" onClick={() => runCtx('uncommon')}>
                <span className="ctx-ico">✕</span>从常用中移除
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
