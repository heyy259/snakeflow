import { useMemo } from 'react';

/**
 * 键值对行编辑器（流元数据 / 工具元数据对话框共用）。
 * value: [{key, value}]；onChange(next) 原样透传行数据（校验在调用方）。
 * excludeKeys: 不展示也不允许输入的系统保留键（如 canvas，精确匹配）。
 * excludePredicate: 保留键谓词（如 isReservedTagKey，覆盖 canvas + edge. 前缀），与 excludeKeys 叠加。
 */
export default function TagsEditor({ value, onChange, excludeKeys = [], excludePredicate }) {
  const rows = useMemo(
    () =>
      Array.isArray(value)
        ? value.filter(
            (f) => f && !excludeKeys.includes(f.key) && !(typeof excludePredicate === 'function' && excludePredicate(f.key))
          )
        : [],
    [value, excludeKeys, excludePredicate]
  );

  const setRow = (i, part, v) => {
    const next = rows.map((f, j) => (j === i ? { ...f, [part]: v } : f));
    onChange(next);
  };
  const removeRow = (i) => onChange(rows.filter((_, j) => j !== i));
  const addRow = () => onChange([...rows, { key: '', value: '' }]);

  return (
    <div className="tags-editor">
      {rows.map((f, i) => (
        <div className="tag-row" key={i}>
          <input
            type="text"
            className="tag-key"
            placeholder="键"
            value={f.key}
            spellCheck={false}
            onChange={(e) => setRow(i, 'key', e.target.value)}
          />
          <input
            type="text"
            className="tag-value"
            placeholder="值"
            value={f.value}
            spellCheck={false}
            onChange={(e) => setRow(i, 'value', e.target.value)}
          />
          <button type="button" className="tag-del" title="删除该行" onClick={() => removeRow(i)}>
            ×
          </button>
        </div>
      ))}
      <button type="button" className="tag-add" onClick={addRow}>
        ＋ 添加标签
      </button>
    </div>
  );
}

/**
 * 校验标签行：key 非空、不重复、不含保留键；返回错误文案或 null。
 * excludeKeys 精确匹配；excludePredicate 覆盖前缀族（如 `edge.`），文案区分前缀。
 */
export function validateTags(rows, excludeKeys = [], excludePredicate) {
  const seen = new Set();
  const list = Array.isArray(rows) ? rows : [];
  for (let i = 0; i < list.length; i += 1) {
    const key = String(list[i]?.key || '').trim();
    if (!key && !String(list[i]?.value || '').trim()) continue;
    if (!key) return `第 ${i + 1} 行：键不能为空`;
    if (excludeKeys.includes(key)) return `「${key}」是系统保留键，不能在此编辑`;
    if (typeof excludePredicate === 'function' && excludePredicate(key)) {
      return key.startsWith('edge.')
        ? `「${key}」是系统保留键前缀，不能在此编辑`
        : `「${key}」是系统保留键，不能在此编辑`;
    }
    if (seen.has(key)) return `键「${key}」重复`;
    seen.add(key);
  }
  return null;
}

/** 清洗标签行：trim、去空行、去重复（保留首个）。 */
export function cleanTags(rows) {
  const seen = new Set();
  const out = [];
  (Array.isArray(rows) ? rows : []).forEach((f) => {
    const key = String(f?.key || '').trim();
    const value = String(f?.value || '').trim();
    if (!key && !value) return;
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ key, value });
  });
  return out;
}
