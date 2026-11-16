// se 内部共享小工具（零依赖，浏览器与 Node 双端可导入）。

/** 取对象：仅接受非 null、非数组的普通对象。 */
export const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * 错误文本提取（唯一实现）：Error.message 优先；空 message 回退 String(err)
 * （比空串更有诊断价值）；null/undefined → ''。
 */
export function errMessage(err) {
  if (err == null) return '';
  return err.message ? String(err.message) : String(err);
}
