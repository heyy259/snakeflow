// callMarkers：工具调用标记 `@{name|params}` 的纯文本切分（无 React / 无 DOM，可 Node 直接导入）。
//
// 背景（去Mock与原文写入改造方案 §4.2）：Milkdown 序列化走 remark-stringify 默认 text
// 处理器（`state.safe(node.value, info)`），其 unsafe 规则 `{character:'_', inConstruct:'phrasing'}`
// 会把 phrasing 内所有下划线转义，于是 `@{script_manager_gui|{}}` 落盘变成
// `@{script\_manager\_gui|{}}`；SE 扫描器正则为 `@\{(\w+)\|`，`\` 使标记完全不可见。
// 本模块把文本切成「完整标记（raw=true，应原文输出）」与「其余文本（raw=false，照常转义）」，
// 供 MilkdownHost 的 stringify `handlers.text` 覆写使用（一处生效，getMarkdown/片段捕获/折叠块共同受益）。
//
// 标记形态：`@` `{` + name(Unicode 字母/数字/下划线，含 CJK) + `|` + params + 与开头 `{` 配平的 `}`。
// 闭合 `}` 用「括号深度配平 + JSON 双引号字符串/转义感知」定位：字符串内的 `{`/`}` 不计深、
// `\"` 不结束字符串；不用朴素正则（JSON 字符串里含 `}` 会提前截断）。
// 不完整/畸形标记（如 `@{t|{`）绝不输出为 raw —— 降级为普通文本（照常转义），安全且可调试。
// 不变式：`splitCallMarkers(v).map((p) => p.text).join('') === v`（无损切分）。

const AT = 64;
const LBRACE = 123;
const PIPE = 124;

/**
 * name 允许字符：对齐 SE 扫描器 `\w+`（snakeeats/tools/scanner.py，Python `str` 默认
 * Unicode ⇒ 含 CJK 字母/数字）与 `nameContract` 的字符集；即 Unicode 字母/数字 + `_`。
 */
const NAME_CHAR_RE = /[\p{L}\p{N}_]/u;

/** 若 `value[start]` 处是完整标记，返回结束下标（开区间）；否则 -1。 */
function markerEndAt(value, start) {
  const n = value.length;
  if (value.charCodeAt(start) !== AT || value.charCodeAt(start + 1) !== LBRACE) return -1;
  let i = start + 2;
  const nameStart = i;
  while (i < n) {
    const cp = value.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    if (!NAME_CHAR_RE.test(ch)) break;
    i += ch.length;
  }
  if (i === nameStart) return -1; // name 至少一个字符
  if (value.charCodeAt(i) !== PIPE) return -1;
  i += 1;

  // 从紧跟 `@` 的那个 `{` 起做深度配平；JSON 字符串内的括号不参与配平。
  let depth = 1;
  let inString = false;
  let escaped = false;
  while (i < n) {
    const ch = value.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return -1; // 未闭合：畸形标记，按普通文本处理
}

/**
 * 把 value 切分为 `{ raw: boolean, text: string }[]`。
 * raw=true 是完整调用标记，应原文输出（不转义）；其余片段委托 `state.safe` 照常转义。
 * 相邻非标记字符合并为一个 raw:false 片段；拼接后与输入逐字节一致。
 * @param {string} value
 * @returns {{ raw: boolean, text: string }[]}
 */
export function splitCallMarkers(value) {
  const s = String(value == null ? '' : value);
  const parts = [];
  let plain = '';
  let i = 0;
  while (i < s.length) {
    const end = markerEndAt(s, i);
    if (end > i) {
      if (plain) {
        parts.push({ raw: false, text: plain });
        plain = '';
      }
      parts.push({ raw: true, text: s.slice(i, end) });
      i = end;
      continue;
    }
    plain += s.charAt(i);
    i += 1;
  }
  if (plain) parts.push({ raw: false, text: plain });
  return parts;
}
