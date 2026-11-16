// 扫描条共享换算：显示层用行号/行列，通信口径为字符偏移（对齐 scan.move{position:int}）。

/** 字符偏移 → "Ln X, Col Y"（1-based）。 */
export function scanPosText(src, offset) {
  const o = Math.max(0, Math.min(Number(offset) || 0, src.length));
  const up = src.slice(0, o).split('\n');
  return `Ln ${up.length}, Col ${up[up.length - 1].length + 1}`;
}

/** 偏移 → 1-based 行号。 */
export function offsetToLine(src, offset) {
  const o = Math.max(0, Math.min(Number(offset) || 0, src.length));
  return src.slice(0, o).split('\n').length;
}

/** 1-based 行号 → 该行起始字符偏移（越界夹取到末行）。 */
export function lineStartOffset(src, line) {
  const total = src.split('\n').length;
  const ln = Math.max(1, Math.min(Math.floor(Number(line) || 1), total));
  let off = 0;
  for (let i = 1; i < ln; i += 1) {
    const idx = src.indexOf('\n', off);
    if (idx < 0) break;
    off = idx + 1;
  }
  return off;
}

/** 偏移附近 ±12 字符上下文预览：换行显式化为 ⏎，光标位插 ▼。 */
export function nearContext(src, offset) {
  const radius = 12;
  const o = Math.max(0, Math.min(Number(offset) || 0, src.length));
  const s = Math.max(0, o - radius);
  const e = Math.min(src.length, o + radius);
  const before = src.slice(s, o).replace(/\n/g, '⏎');
  const after = src.slice(o + 1, e).replace(/\n/g, '⏎');
  const at = src.slice(o, o + 1);
  return before + (at ? '▼' : '') + after;
}
