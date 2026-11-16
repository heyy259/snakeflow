// 自动恢复策略（纯函数）：某个文档流名是否允许经 SE **公共** API 创建。
//
// 两条硬边界：
// 1. `_console` / `_scan_log` 是 SE 保留后缀：公共 `stream.create` 返回
//    -32602 invalid-params（naming.user_name_error），只有进程内派生 seam
//    可建。自动修复/上推若继续调用公共 create，会永久失败并被静默重试。
// 2. 跨图谱 `.streams/` 的 source 不属于本文档：不得自动物化到 SE
//    （避免把历史污染/他图流写进当前系统）。
//
// 纯逻辑：无 DOM / React / 网络依赖，Node 可直接 import 做单测。

import { isInternalStream } from './procAssoc.js';
import { isCrossGraphSource } from './ownedSource.js';

/**
 * 是否允许通过公共 `stream.create` / `applyImport` 新建该流。
 *
 * @param {string} name 流名
 * @param {string} [sourcePath] 节点 `data.source.file_path`（可空）
 * @param {string} [docBase] 当前文档 base（可空；缺失时不判定跨图）
 * @returns {boolean}
 */
export function canAutoCreateStream(name, sourcePath, docBase) {
  const n = String(name == null ? '' : name);
  if (!n) return false;
  if (isInternalStream(n)) return false;
  if (sourcePath && docBase && isCrossGraphSource(sourcePath, docBase)) return false;
  return true;
}
