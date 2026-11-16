// 工具复刻计划（纯函数，零 IO / 零 node:path）——导出配置包时把「执行目录/脚本」搬进包内。
//
// 语义与路径原语一致：基准 = manifest 所在目录（baseDir，绝对）。
// - dir（默认）：镜像 execution_path（缺省 = tool_path 所在目录）到 `tools/<工具名>/`；
//   同目录多工具共享同一份复刻（按真实执行根去重）。
// - file：只复制 tool_path（+ manual_path），execution_path 保持外部绝对。
// - external：不复制，写绝对路径 + 标记 external。
//
// 导出包内**不允许 `..`**：能相对（严格在 baseDir 之下）才写相对，否则写绝对。
// 这是与 live 保存的刻意差异：包一旦被拷走，`..` 会指向接收方的无关目录。

import {
  toPosix,
  isAbsolutePath,
  rootKey,
  segmentsOf,
  relativePosix,
  resolveResourcePath,
  normalizeResourcePath,
  manifestDirOf,
} from './paths.js';

const MODES = new Set(['dir', 'file', 'external']);
const RESERVED_SEGMENT_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** base 是否为 target 的祖先（或相等）。大小写不敏感；跨根 false。 */
function isUnder(base, target) {
  const b = String(base || '');
  const t = String(target || '');
  if (!b || !t || rootKey(b) !== rootKey(t)) return false;
  const bs = segmentsOf(b);
  const ts = segmentsOf(t);
  if (bs.length > ts.length) return false;
  for (let i = 0; i < bs.length; i += 1) {
    if (bs[i].toLowerCase() !== ts[i].toLowerCase()) return false;
  }
  return true;
}

/** 路径末段（跨 `/` `\`）。 */
function basenameOf(p) {
  const s = toPosix(p);
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

/** 目录段（复用 manifestDirOf 的盘符/分隔符语义）。 */
function dirOf(p) {
  return toPosix(manifestDirOf(p));
}

/** 文件/目录名净化（Windows 非法字符 + 设备名）。 */
function safeSegment(name) {
  let base = String(name == null ? '' : name).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim();
  base = base.replace(/[. ]+$/g, '');
  if (!base) base = 'tool';
  if (RESERVED_SEGMENT_RE.test(base.replace(/\.[^.]*$/, ''))) base = `_${base}`;
  return base;
}

/** 导出包内的路径：严格在 baseDir 之下 → 相对；否则绝对（绝不写 `..`）。 */
function exportPath(value, baseDir) {
  const abs = resolveResourcePath(value, baseDir);
  if (!isAbsolutePath(abs)) return abs;
  if (isUnder(baseDir, abs)) return normalizeResourcePath(abs, baseDir);
  return abs;
}

/**
 * @param {{tools:Array|Object, baseDir:string, mode?:'dir'|'file'|'external',
 *          toolModes?:Object<string,'dir'|'file'|'external'>}} input
 * @returns {{
 *   rewrites: Object<string,{tool_path?:string,execution_path?:string|null,manual_path?:string|null}>,
 *   copies: Array<{from:string,to:string,unit:'file'|'dir'}>,
 *   externals: Array<{name:string,reason:string}>,
 *   warnings: string[]
 * }}
 */
export function planToolBundles(input = {}) {
  const tools = input.tools && typeof input.tools === 'object' ? input.tools : [];
  const baseDir = String(input.baseDir || '');
  const defaultMode = MODES.has(input.mode) ? input.mode : 'dir';
  const toolModes = input.toolModes && typeof input.toolModes === 'object' ? input.toolModes : {};

  const list = Array.isArray(tools) ? tools : Object.values(tools);
  const defs = list
    .filter((d) => d && typeof d === 'object' && d.name)
    .map((d) => ({ ...d, name: String(d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const rewrites = {};
  const copies = [];
  const externals = [];
  const warnings = [];
  const copySeen = new Set();
  const rootTargets = new Map();
  const claimedTargets = new Set();

  const addCopy = (from, to, unit) => {
    const key = `${unit}:${from}->${to}`;
    if (copySeen.has(key)) return;
    copySeen.add(key);
    copies.push({ from, to, unit });
  };
  const claimTarget = (baseTarget) => {
    let target = baseTarget;
    let n = 2;
    while (claimedTargets.has(target.toLowerCase())) {
      target = `${baseTarget}_${n}`;
      n += 1;
    }
    claimedTargets.add(target.toLowerCase());
    return target;
  };
  const markExternal = (name, reason) => externals.push({ name, reason });

  for (const def of defs) {
    const name = def.name;
    const declaredTool = typeof def.tool_path === 'string' ? def.tool_path : '';
    const toolAbs = resolveResourcePath(declaredTool, baseDir);
    const mode = MODES.has(toolModes[name]) ? toolModes[name] : defaultMode;

    if (!declaredTool || !isAbsolutePath(toolAbs)) {
      // 无法解析为绝对路径：原样保留 + 外部标记（不猜测）。
      rewrites[name] = { tool_path: declaredTool };
      markExternal(name, '路径无法解析为绝对路径');
      warnings.push(`工具 ${name}：路径无法解析为绝对路径，已保留原值。`);
      continue;
    }

    const execDeclared = typeof def.execution_path === 'string' ? def.execution_path : '';
    const execAbs = execDeclared ? resolveResourcePath(execDeclared, baseDir) : dirOf(toolAbs);
    const manualDeclared = typeof def.manual_path === 'string' ? def.manual_path : '';
    const manualAbs = manualDeclared ? resolveResourcePath(manualDeclared, baseDir) : '';

    // 已在包内（重复导出 / 打开导出的包再导出）：保持相对，不复制，避免把包复制进自己。
    if (isUnder(baseDir, toolAbs)) {
      const rewrite = { tool_path: normalizeResourcePath(toolAbs, baseDir) };
      if (execDeclared) {
        rewrite.execution_path = isUnder(baseDir, execAbs)
          ? normalizeResourcePath(execAbs, baseDir)
          : exportPath(execDeclared, baseDir);
      }
      if (manualDeclared) {
        rewrite.manual_path = isUnder(baseDir, manualAbs)
          ? normalizeResourcePath(manualAbs, baseDir)
          : exportPath(manualDeclared, baseDir);
      }
      rewrites[name] = rewrite;
      continue;
    }

    if (mode === 'external') {
      rewrites[name] = {
        tool_path: exportPath(declaredTool, baseDir),
        ...(execDeclared ? { execution_path: exportPath(execDeclared, baseDir) } : {}),
        ...(manualDeclared ? { manual_path: exportPath(manualDeclared, baseDir) } : {}),
      };
      markExternal(name, '按 external 模式保留原路径');
      continue;
    }

    const execNorm = execAbs.replace(/\/+$/, '');
    const baseNorm = baseDir.replace(/\/+$/, '');
    const execIsBaseOrAncestor = !!execNorm && (execNorm === baseNorm || isUnder(execAbs, baseDir));
    const toolInsideExec = isUnder(execAbs, toolAbs);
    const canMirrorDir = mode === 'dir' && isAbsolutePath(execAbs) && toolInsideExec && !execIsBaseOrAncestor;

    if (mode === 'dir' && !canMirrorDir) {
      warnings.push(
        `工具 ${name}：execution_path 指向包目录或其上级（或不在其中），禁止整体镜像，已降级为仅复刻脚本。`
      );
    }

    if (canMirrorDir) {
      const targetDir =
        rootTargets.get(execNorm) || claimTarget(`tools/${safeSegment(name)}`);
      rootTargets.set(execNorm, targetDir);
      const rel = relativePosix(execAbs, toolAbs);
      if (rel.startsWith('..')) {
        // 理论不可达（isUnder 已保证），兜底降级。
        warnings.push(`工具 ${name}：脚本不在执行目录内，已降级为仅复刻脚本。`);
      } else {
        addCopy(execAbs, targetDir, 'dir');
        const rewrite = {
          // rel === '' ⇒ tool_path 本身是执行目录（目录型工具）→ 指向镜像根。
          tool_path: rel ? `${targetDir}/${rel}` : targetDir,
          execution_path: targetDir,
        };
        if (manualDeclared && manualAbs && isUnder(execAbs, manualAbs)) {
          rewrite.manual_path = `${targetDir}/${relativePosix(execAbs, manualAbs)}`;
        } else if (manualDeclared && manualAbs && isAbsolutePath(manualAbs)) {
          const manualTarget = `${targetDir}/manual/${basenameOf(manualAbs)}`;
          addCopy(manualAbs, manualTarget, 'file');
          rewrite.manual_path = manualTarget;
        }
        rewrites[name] = rewrite;
        continue;
      }
    }

    // file 模式（含 dir 降级）
    const targetDir = claimTarget(`tools/${safeSegment(name)}`);
    const target = `${targetDir}/${basenameOf(toolAbs)}`;
    addCopy(toolAbs, target, 'file');
    const rewrite = { tool_path: target };
    const sameExec = !execDeclared || dirOf(toolAbs) === execAbs.replace(/\/+$/, '');
    if (sameExec) {
      rewrite.execution_path = targetDir;
    } else {
      // 执行目录与脚本目录不同：只复刻脚本会缺同目录数据 → 保留外部绝对 + 告警。
      rewrite.execution_path = exportPath(execDeclared, baseDir);
      markExternal(name, '执行目录未随包复制');
      warnings.push(
        `工具 ${name}：执行目录与脚本目录不同，仅复刻脚本；execution_path 保留外部路径。`
      );
    }
    if (manualDeclared) {
      if (manualAbs && isAbsolutePath(manualAbs)) {
        const manualTarget = `${targetDir}/manual/${basenameOf(manualAbs)}`;
        addCopy(manualAbs, manualTarget, 'file');
        rewrite.manual_path = manualTarget;
      } else {
        rewrite.manual_path = exportPath(manualDeclared, baseDir);
        markExternal(name, 'manual_path 无法复制');
      }
    }
    rewrites[name] = rewrite;
  }

  return { rewrites, copies, externals, warnings };
}

