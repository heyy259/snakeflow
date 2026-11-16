// SE `tool.register` 参数白名单（单一真源）。
//
// 背景：ToolDefinition 含**前端私有字段**（如 `insert_template`，见需求2）——它们只随配置持久化，
// SE 不认识也无需认识。任何把工具定义发往 SE 的路径（toolDriver.register/update、配置包 applyImport）
// 都必须经此白名单裁剪，避免未知字段泄漏进 RPC（风险 #5）。
//
// 边界：纯函数、零 DOM / 零 React / 零 node:path ⇒ 浏览器与 Node 双端可导入。

import { absolutizeToolPath } from './paths.js';
import { isPlainObject } from './util.js';

/** 非空字符串（trim 后）判定。 */
const nonEmptyStr = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * 由 ToolDefinition 构造 tool.register 参数：必填三件套（name/description/tool_path）
 * + 仅非空可选字段。**未知/前端私有字段一律丢弃**。
 * `tool_path`（及 `execution_path`/`manual_path`）按 `baseDir`（manifest 所在目录）绝对化，
 * 因 SE 按自身进程 CWD 解析相对工具路径；未提供 baseDir 时保持原样。
 * @param {any} def
 * @param {string} [baseDir]
 * @returns {{name:string, description:string, tool_path:string, [k:string]:any}}
 */
export function buildRegisterParams(def, baseDir = '') {
  const d = isPlainObject(def) ? def : {};
  const params = {
    name: String(d.name == null ? '' : d.name).trim(),
    description: d.description == null ? '' : String(d.description),
    tool_path: absolutizeToolPath(d.tool_path, baseDir),
  };
  if (nonEmptyStr(d.execution_path)) params.execution_path = absolutizeToolPath(d.execution_path, baseDir);
  if (nonEmptyStr(d.manual_path)) params.manual_path = absolutizeToolPath(d.manual_path, baseDir);
  if (nonEmptyStr(d.brief_description)) params.brief_description = String(d.brief_description);
  if (nonEmptyStr(d.detailed_description)) params.detailed_description = String(d.detailed_description);
  if (nonEmptyStr(d.version)) params.version = String(d.version);
  if (isPlainObject(d.tags) && Object.keys(d.tags).length > 0) params.tags = d.tags;
  if (isPlainObject(d.input_schema) && Object.keys(d.input_schema).length > 0) {
    params.input_schema = d.input_schema;
  }
  if (Array.isArray(d.requires) && d.requires.length > 0) params.requires = d.requires;
  return params;
}
