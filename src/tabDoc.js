// Tab 级“有效工作文档”解析：ReactFlow 与配置包/外部文档之间的唯一身份入口。
//
// 两个来源各司其职：
// - tab.docPath：显式外部/自定义工作文档（最高优先级）；
// - tab.system.manifest_path：配置包绑定（包即工作文档）。
// 写/读/查重/改名一律经本模块，禁止在调用点各自 `docPath || null`。

import {
  canonDocPath,
  isGraphsDocPath,
  packageNameFromPath,
  sanitizeGraphName,
} from './se/paths.js';
import { getProjectRoot } from './se/projectRoot.js';

/** 有效工作文档（写/读目标）：docPath > manifest_path > null（null = 应用内新建）。 */
export function workDocPathOf(tab) {
  const d = String(tab?.docPath || '').trim();
  if (d) return d;
  const m = String(tab?.system?.manifest_path || '').trim();
  return m || null;
}

/** 工具/包基准：包优先（工具相对路径以包为基准），其次显式外部文档。 */
export function toolBasePathOf(tab) {
  const m = String(tab?.system?.manifest_path || '').trim();
  if (m) return m;
  const d = String(tab?.docPath || '').trim();
  return d || null;
}

/** 文档身份基名：包文档取包名；外部文档取文件名；graphs/应用内新建取 tab 名。 */
export function docBaseOf(tab, projectRoot = getProjectRoot()) {
  const name = sanitizeGraphName(tab?.name || '');
  const doc = String(tab?.docPath || '').trim();
  if (doc) {
    return isGraphsDocPath(doc, projectRoot) ? name : (packageNameFromPath(doc) || name);
  }
  const manifest = String(tab?.system?.manifest_path || '').trim();
  if (manifest) return packageNameFromPath(manifest) || name;
  return name;
}

/** 按有效工作文档查重：同一物理文档只允许一个 tab 持有。 */
export function findDocOwner(tabs, target, exceptTabId, projectRoot = getProjectRoot()) {
  const key = canonDocPath(target, projectRoot);
  if (!key) return null;
  return (
    (Array.isArray(tabs) ? tabs : []).find(
      (t) => t.id !== exceptTabId && canonDocPath(workDocPathOf(t), projectRoot) === key
    ) || null
  );
}
