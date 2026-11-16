// 快捷文本片段（需求 8）——纯数据与解析工具（无编辑器依赖，供主包 UI 直接引用）。
//
// 权威定义见《升级改造方案.md》§4.3 与原型 prototype/index.html:2860-3804。
// 应用侧（PM transaction）在 editor/snippets.js；本文件只放主包需要的轻量逻辑：
// 数据格式、内置 13 条、合并/排序/显隐、占位符解析、类型判定。

export const BUILTIN_SNIPPETS = [
  { group: 'builtin', name: '加粗', text: '**{sel}**' },
  { group: 'builtin', name: '斜体', text: '*{sel}*' },
  { group: 'builtin', name: '删除线', text: '~~{sel}~~' },
  { group: 'builtin', name: '标题1', text: '# {sel}' },
  { group: 'builtin', name: '标题2', text: '## {sel}' },
  { group: 'builtin', name: '列表', text: '- {sel}' },
  { group: 'builtin', name: '任务', text: '- [ ] {sel}' },
  { group: 'builtin', name: '引用', text: '> {sel}' },
  { group: 'builtin', name: '代码块', text: '```\n{sel}\n```' },
  { group: 'builtin', name: '链接', text: '[{sel}](url)' },
  { group: 'builtin', name: '图片', text: '![{sel}](url)' },
  { group: 'builtin', name: '分割线', text: '---' },
  { group: 'builtin', name: '折叠', text: '<details>\n<summary>{sel:2}</summary>\n{sel}\n</details>' },
];

export const BUILTIN_DEFAULT_ORDER = BUILTIN_SNIPPETS.map((s) => s.name);
const BUILTIN_BY_NAME = new Map(BUILTIN_SNIPPETS.map((s) => [s.name, s]));

/**
 * 合并持久化数据与内置：内置内容以代码为准（只继承 hidden；未知内置丢弃），
 * 缺失内置按默认顺序补在内置段末尾，用户片段保持。
 */
export function normalizeSnippets(raw) {
  const stored = Array.isArray(raw) ? raw : [];
  const out = [];
  const seenBuiltin = new Set();
  stored.forEach((s) => {
    if (!s || typeof s !== 'object') return;
    const name = String(s.name == null ? '' : s.name).trim();
    if (!name) return;
    const group = s.group === 'builtin' ? 'builtin' : 'user';
    if (group === 'builtin') {
      const base = BUILTIN_BY_NAME.get(name);
      if (!base || seenBuiltin.has(name)) return;
      seenBuiltin.add(name);
      out.push({ group: 'builtin', name, text: base.text, hidden: !!s.hidden });
    } else {
      const text = s.text == null ? '' : String(s.text);
      if (!text.trim()) return;
      out.push({ group: 'user', name, text, hidden: !!s.hidden });
    }
  });
  const missing = BUILTIN_SNIPPETS.filter((b) => !seenBuiltin.has(b.name));
  if (missing.length) {
    let insertAt = 0;
    for (let i = out.length - 1; i >= 0; i -= 1) {
      if (out[i].group === 'builtin') {
        insertAt = i + 1;
        break;
      }
    }
    out.splice(
      insertAt,
      0,
      ...missing.map((b) => ({ group: 'builtin', name: b.name, text: b.text, hidden: false }))
    );
  }
  return out;
}

/** 分组取用于工具栏 chips / 选区浮条的片段（隐藏项剔除），i 为原数组下标。 */
export function visibleSnippets(snippets, group) {
  const out = [];
  (snippets || []).forEach((s, i) => {
    if ((s.group || 'user') === group && !s.hidden) out.push({ s, i });
  });
  return out;
}

/** 片段库内拖拽排序（同组约束由调用方保证插入槽位）。返回新数组。 */
export function moveSnippet(arr, from, to) {
  if (from == null || from < 0 || from >= arr.length) return arr;
  let dest = to == null ? arr.length - 1 : Math.max(0, Math.min(to, arr.length));
  if (dest > from) dest -= 1;
  if (dest === from) return arr;
  const next = arr.slice();
  const [item] = next.splice(from, 1);
  next.splice(dest, 0, item);
  return next;
}

/* ---- 占位符解析（照原型 :3255-3306） ---- */

export function snippetHeadChars(text, n) {
  return Array.from(String(text == null ? '' : text).trim()).slice(0, n).join('');
}

/** {sel:N} → 选区去空白前 N 字（无选区回退「标题」）。 */
export function resolveSelN(text, selText, hasSel) {
  return String(text == null ? '' : text).replace(/\{sel:(\d{1,2})\}/g, (_, d) => {
    if (!hasSel) return '标题';
    return snippetHeadChars(selText, parseInt(d, 10)) || '标题';
  });
}

/** 包裹两端占位符统一解析（{sel:N} 先于 {sel}，模式不重叠）。 */
export function resolveWrapFragment(text, selText, hasSel) {
  return resolveSelN(text, selText, hasSel).replace(/\{sel\}/g, () => (hasSel ? selText : '内容'));
}

/* ---- 类型判定（照原型 :3307-3319） ---- */

export function snippetType(text) {
  const t = String(text == null ? '' : text);
  const at = t.indexOf('{sel}');
  if (at === -1) return /\{sel:\d{1,2}\}/.test(t) ? 'wrap' : 'insert';
  const prefix = t.slice(0, at);
  const suffix = t.slice(at + 5);
  if (prefix !== '' && prefix.indexOf('\n') === -1 && suffix === '') return 'prefix';
  return 'wrap';
}

export function snippetTypeLabel(text) {
  const ty = snippetType(text);
  return ty === 'prefix' ? '行前缀' : ty === 'wrap' ? '包裹' : '插入';
}

/**
 * 选区浮条候选（builtin/user 两簇）：
 * - 内置：产品策划的"选区编辑"集合，只收 wrap/prefix（分割线等 insert 不进浮条）。
 * - 用户：用户自己的片段全量可见；insert 型在非空选区上按"替换"应用。
 * hidden 一律剔除；返回的 i 始终指向原数组，供 ⋯ 菜单 / onApply 使用。
 */
export function bubbleSnippetGroups(snippets) {
  const builtin = [];
  const user = [];
  (snippets || []).forEach((s, i) => {
    if (s.hidden) return;
    const ty = snippetType(s.text);
    const isBuiltin = (s.group || 'user') === 'builtin';
    if (isBuiltin && ty !== 'wrap' && ty !== 'prefix') return;
    (isBuiltin ? builtin : user).push({ s, i });
  });
  return { builtin, user };
}

/** 恢复内置：显隐复位 + 默认顺序（用户片段不移动）。返回新数组。 */
export function restoreBuiltins(snippets) {
  const byName = new Map();
  (snippets || []).forEach((s) => {
    if ((s.group || 'user') === 'builtin') byName.set(s.name, s);
  });
  const builtins = BUILTIN_DEFAULT_ORDER.map(
    (n) =>
      byName.get(n) || { group: 'builtin', name: n, text: BUILTIN_BY_NAME.get(n).text, hidden: false }
  ).filter(Boolean);
  (snippets || []).forEach((s) => {
    if ((s.group || 'user') === 'builtin' && !BUILTIN_DEFAULT_ORDER.includes(s.name)) builtins.push(s);
  });
  const users = (snippets || []).filter((s) => (s.group || 'user') !== 'builtin');
  return [...builtins.map((s) => ({ ...s, hidden: false })), ...users.map((s) => ({ ...s }))];
}
