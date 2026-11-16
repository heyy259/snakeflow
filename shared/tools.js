// 工具集合（当前标签页文档的一部分）：字段对齐 SE ToolDefinition，接 SE 零改名。
// canonical 存储形态为 dict：{ [name]: ToolDefinition }（对齐 §3.12 统一文档格式）。

import { toolNameError } from './nameContract.js';

/** 工具名契约校验（镜像 SE `tool_name_error`：字符集 + 用户上限 55/119；允许 CJK）。 */
export function isValidToolName(name) {
  return toolNameError(String(name || '')) === null;
}

/** 规范化单个工具定义；无效（缺名 / 缺 tool_path）返回 null。 */
export function normalizeToolDef(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim();
  if (!name || !String(raw.tool_path || '').trim()) return null;
  const str = (v) => (v == null ? '' : String(v));
  const tags = {};
  if (raw.tags && typeof raw.tags === 'object' && !Array.isArray(raw.tags)) {
    Object.entries(raw.tags).forEach(([k, v]) => {
      const key = String(k || '').trim();
      if (key) tags[key] = str(v).trim();
    });
  }
  const schema =
    raw.input_schema && typeof raw.input_schema === 'object' && !Array.isArray(raw.input_schema)
      ? raw.input_schema
      : {};
  // 期 8（D1=(a)）：tool.register 必填 `name`/`description`/`tool_path`，另可带
  // `execution_path`/`manual_path`。本函数是**唯一丢弃点**（document.js 的 build/parse
  // 与 workspace 重载都经 normalizeTools）：若在此丢弃，带路径的工具经统一文档保存/重载
  // 后路径即丢失。故原样保真透传（不校验存在性——RPC 侧亦不校验）。
  const optionalPaths = {};
  if (raw.execution_path != null && String(raw.execution_path) !== '') {
    optionalPaths.execution_path = String(raw.execution_path);
  }
  if (raw.manual_path != null && String(raw.manual_path) !== '') {
    optionalPaths.manual_path = String(raw.manual_path);
  }
  const requires =
    Array.isArray(raw.requires) && raw.requires.length ? raw.requires.map((x) => String(x)) : undefined;
  return {
    name,
    description: str(raw.description),
    tool_path: str(raw.tool_path),
    ...optionalPaths,
    ...(requires ? { requires } : {}),
    brief_description: str(raw.brief_description),
    detailed_description: str(raw.detailed_description),
    version: str(raw.version),
    tags,
    input_schema: schema,
    // 前端私有字段（不进 SE）：插入内容定制。为空 = 使用 buildCallStub 自动生成（行为零变化）。
    // 本函数是配置持久化的唯一闸：必须在此显式透传，否则经统一文档保存/重载即丢。
    insert_template: str(raw.insert_template),
  };
}

/** 规范化工具集合：接受 dict 或数组，返回 dict { [name]: def }。 */
export function normalizeTools(raw) {
  const out = {};
  const push = (item) => {
    const def = normalizeToolDef(item);
    if (def) out[def.name] = def;
  };
  if (Array.isArray(raw)) raw.forEach(push);
  else if (raw && typeof raw === 'object') Object.values(raw).forEach(push);
  return out;
}

/** tags dict ↔ TagsEditor 行数组互转。 */
export function tagsToRows(tags) {
  return Object.entries(tags || {}).map(([key, value]) => ({ key, value }));
}
export function rowsToTags(rows) {
  const out = {};
  (Array.isArray(rows) ? rows : []).forEach((f) => {
    const key = String(f?.key || '').trim();
    if (key) out[key] = String(f?.value || '').trim();
  });
  return out;
}

function stubValue(prop) {
  switch (prop?.type) {
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return '';
  }
}

/** 生成双击插入的调用文本：@{name|{json}}，参数 stub 由 input_schema 的 required（缺省则全量 properties）生成。 */
export function buildCallStub(tool) {
  const schema = tool?.input_schema || {};
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const keys = required.length ? required : Object.keys(props);
  const args = {};
  keys.forEach((k) => {
    if (typeof k === 'string' && k) args[k] = stubValue(props[k]);
  });
  return `@{${tool.name}|${JSON.stringify(args)}}`;
}

/**
 * 工具插入文本（需求2）：优先用户定制的 `insert_template`（trim 后非空），
 * 否则回落到 `buildCallStub(tool)` 自动生成 —— 留空时与改造前逐字节一致。
 * @param {{name:string, input_schema?:object, insert_template?:string}} tool
 * @returns {string} 要插入光标处的完整文本（见即所得）
 */
export function resolveInsertText(tool) {
  const custom = typeof tool?.insert_template === 'string' ? tool.insert_template.trim() : '';
  return custom || buildCallStub(tool);
}

