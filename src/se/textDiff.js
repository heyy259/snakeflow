// 纯文本差分（SE 编辑最小提交）：按 **Unicode 码点** 计算多 hunk 差异。
//
// 契约：
// - `diffCodePoints(oldText, newText)` → `null`（过大/过于昂贵，调用方回退整篇 `stream.write`）
//   或按 OLD 文本码点偏移升序排列的 hunk 数组：
//     `{type:'insert'|'delete'|'replace', start, end, text}`
//   区间为半开 `[start,end)`；insert 恒有 `start===end`，delete 恒有 `text===''`。
// - 位置计算只用码点数组下标；绝不使用 UTF-16 `.length`/`.slice`/`.substring`。
//   因此 emoji / 非 BMP 字符与 Python 服务端的码点偏移一致。
// - 使用 Myers O(ND)（逐码点）求最短编辑脚本，再把连续编辑合并为 hunk；
//   多个分散编辑产生多个 hunk，绝不跨过未改动的中间文本。
//
// 零依赖、无 IO、无 React/DOM，可在 Node 侧直接 import 单测。

/** 单侧码点上限；超过即返回 null（调用方整篇写）。 */
export const MAX_DIFF_CODE_POINTS = 2_000_000;
/** 编辑距离上限；超过即返回 null（调用方整篇写）。 */
export const MAX_DIFF_EDIT_DISTANCE = 2000;
/**
 * Myers 工作量预算（码点数）：有效编辑距离上限还受 `MAX_DIFF_WORK / (n + m)` 约束，
 * 避免「超大公共前缀（如内联 data URI）+ 末尾小改动」把 O(ND) 拖进病态区间。
 */
export const MAX_DIFF_WORK = 20_000_000;

/**
 * Myers O(ND)：返回编辑脚本，或 null（距离超过 limit）。
 * 每行只保留 k∈[-d,d] 的 x 值，避免 length>200000 时 trace 快照爆内存。
 */
function myers(a, b, limit) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const trace = [];
  const maxD = Math.min(max, limit);

  for (let d = 0; d <= maxD; d += 1) {
    const row = new Int32Array(2 * d + 1);
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      row[k + d] = x;
      if (x >= n && y >= m) {
        trace.push(row);
        return { trace, distance: d };
      }
    }
    trace.push(row);
  }
  return null;
}

/** 从 trace 回溯出编辑脚本（按执行顺序的 equal/delete/insert）。 */
function backtrack(trace, distance, a, b) {
  const ops = [];
  let x = a.length;
  let y = b.length;

  for (let d = distance; d > 0; d -= 1) {
    const prev = trace[d - 1];
    const base = -(d - 1);
    const get = (k) => {
      const idx = k - base;
      return idx >= 0 && idx < prev.length ? prev[idx] : -1;
    };
    const k = x - y;
    const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      ops.push({ type: 'equal', ch: a[x - 1] });
      x -= 1;
      y -= 1;
    }
    if (x === prevX) {
      ops.push({ type: 'insert', ch: b[y - 1] });
      y -= 1;
    } else {
      ops.push({ type: 'delete', ch: a[x - 1] });
      x -= 1;
    }
  }

  // d=0 的剩余前缀（完全相同，或空串）。
  while (x > 0 && y > 0) {
    ops.push({ type: 'equal', ch: a[x - 1] });
    x -= 1;
    y -= 1;
  }
  while (x > 0) {
    ops.push({ type: 'delete', ch: a[x - 1] });
    x -= 1;
  }
  while (y > 0) {
    ops.push({ type: 'insert', ch: b[y - 1] });
    y -= 1;
  }

  ops.reverse();
  return ops;
}

/** 连续编辑 → hunk；相邻 hunk 合并，保持升序与类型语义。 */
function buildHunks(ops) {
  const hunks = [];
  let oldPos = 0;
  let cur = null;
  const flush = () => {
    if (cur) hunks.push(cur);
    cur = null;
  };

  for (const op of ops) {
    if (op.type === 'equal') {
      flush();
      oldPos += 1;
    } else if (op.type === 'delete') {
      if (!cur) cur = { start: oldPos, end: oldPos, text: '' };
      oldPos += 1;
      cur.end = oldPos;
    } else {
      if (!cur) cur = { start: oldPos, end: oldPos, text: '' };
      cur.text += op.ch;
    }
  }
  flush();

  const merged = [];
  for (const h of hunks) {
    const prev = merged[merged.length - 1];
    if (prev && prev.end === h.start) {
      prev.end = h.end;
      prev.text += h.text;
    } else {
      merged.push({ ...h });
    }
  }

  return merged.map((h) => {
    let type = 'replace';
    if (h.start === h.end) type = 'insert';
    else if (h.text === '') type = 'delete';
    return { type, start: h.start, end: h.end, text: h.text };
  });
}

/**
 * 计算 oldText → newText 的最小多 hunk 差异。
 * @param {string} oldText 权威基线文本（服务端当前文本）
 * @param {string} newText 目标文本
 * @returns {null|Array<{type:'insert'|'delete'|'replace',start:number,end:number,text:string}>}
 */
export function diffCodePoints(oldText, newText) {
  const a = Array.from(oldText == null ? '' : String(oldText));
  const b = Array.from(newText == null ? '' : String(newText));
  if (a.length > MAX_DIFF_CODE_POINTS || b.length > MAX_DIFF_CODE_POINTS) return null;

  if (a.length === b.length) {
    let same = true;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) {
        same = false;
        break;
      }
    }
    if (same) return [];
  }

  // 工作量预算：超大公共前缀时收紧可接受的编辑距离，避免 Myers 病态耗时。
  const limit = Math.min(
    MAX_DIFF_EDIT_DISTANCE,
    Math.max(16, Math.floor(MAX_DIFF_WORK / Math.max(a.length + b.length, 1)))
  );
  const result = myers(a, b, limit);
  if (!result) return null;
  return buildHunks(backtrack(result.trace, result.distance, a, b));
}
