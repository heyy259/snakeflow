// 历史本地节点一次性离线迁移脚本（Task 1）。
//
// 背景：画布节点 id 分两类——`s-<流名>`（SE 投影，唯一真源）与非 `s-*`（本地草稿，
// 含 `n-<seq>` 与历史遗留纯数字 id）。`src/se/streams.js:31` 的 `streamNameFromId`
// 只认 `s-` 前缀，非 `s-*` 节点的 SE 能力（扫描等）全部失效。本脚本把 `graphs/*.se.json`
// 里的非 `s-*` 节点一次性迁移为 `s-<合规流名>`。
//
// 关键约束：
// - 纯 Node ESM，零外部依赖；只 import `../src/se/nameContract.js`（零依赖、Node 可导入）。
// - 不改动 `src/`，不写 SE 内部存储，不引入 npm 依赖。
// - 写回用 tmp + rename 原子写（Windows/OneDrive 偶发 EPERM/EBUSY 短重试），UTF-8。
//
// 运行：
//   node scripts/migrate-local-nodes.mjs [--dry-run] [--prune-empty|--no-prune-empty]
//
// 同时导出 `migrateDirectory` 供单测（`scripts/smoke-migrate-local-nodes.mjs`）在临时目录直接调用。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toStreamName } from '../src/se/nameContract.js';

/** 迁移备份目录前缀（生成于 graphs/ 下）。 */
export const BACKUP_PREFIX = '.migration-backup-';

const IS_STREAM_ID_PREFIX = 's-';

/** 与 `src/se/streams.js:streamNameFromId` 对齐：id 是否 `s-` 开头（SE 投影）。 */
export function isSEStreamId(id) {
  return String(id == null ? '' : id).startsWith(IS_STREAM_ID_PREFIX);
}

/** 判定 manifest 格式（有对象型 `system.graph`）；否则视为 v3.0。 */
export function isManifest(json) {
  return (
    json != null &&
    typeof json === 'object' &&
    json.system != null &&
    typeof json.system === 'object' &&
    json.system.graph != null &&
    typeof json.system.graph === 'object'
  );
}

/**
 * `source.file_path` → 绝对路径（镜像 vite.config.js:220-227 `graphContentResolve`，baseDir=graphs）。
 * 绝对路径原样；相对路径：`graphs/` 前缀歧义按项目根 resolve，其余按 graphs 目录 resolve。
 */
export function graphContentResolve(fp, graphsDir, rootDir) {
  const p = String(fp == null ? '' : fp).replace(/\\/g, '/').trim();
  if (!p) return '';
  if (/^[A-Za-z]:\//.test(p) || p.startsWith('//') || p.startsWith('/')) return p;
  if (p.startsWith('graphs/')) return path.resolve(rootDir, p);
  return path.resolve(graphsDir, p);
}

/** .md 是否存在且「非全空白」（缺失视为空白）。 */
function mdBlankOrMissing(abs) {
  if (!abs) return { blank: true, exists: false };
  let text;
  try {
    text = fs.readFileSync(abs, 'utf-8');
  } catch {
    return { blank: true, exists: false };
  }
  return { blank: text.trim() === '', exists: true };
}

const normText = (t) => String(t).replace(/\r\n/g, '\n').replace(/\s+$/, '');

/** 保留原文件是否带尾随换行，序列化风格与现有文件一致（2 空格缩进）。 */
function serializeJson(json, originalText) {
  const body = JSON.stringify(json, null, 2);
  return originalText.endsWith('\n') ? body + '\n' : body;
}

/** renameSync + Windows/OneDrive 偶发 EPERM/EBUSY 短重试（镜像 vite.config.js:230-244）。 */
function renameWithRetry(src, dst) {
  let lastErr = null;
  for (let i = 0; i < 5; i += 1) {
    try {
      fs.renameSync(src, dst);
      return;
    } catch (err) {
      lastErr = err;
      if (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES') throw err;
      const until = Date.now() + 20 * (i + 1);
      while (Date.now() < until) {
        /* 短暂退避重试 */
      }
    }
  }
  throw lastErr;
}

/** 原子写：tmp + rename，失败回退直接写（镜像 vite.config.js:310-324）。 */
function atomicWriteFileSync(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf-8');
  try {
    renameWithRetry(tmp, file);
  } catch (err) {
    try {
      fs.writeFileSync(file, text, 'utf-8');
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    } catch (err2) {
      throw err || err2;
    }
  }
}

/** 收集 JSON 内全部边数组（v3.0 顶级 `edges` 与 manifest `system.graph.edges` 的并集来源）。 */
function edgeArraysOf(json) {
  const arrays = [];
  if (Array.isArray(json.edges)) arrays.push(json.edges);
  if (isManifest(json) && Array.isArray(json.system.graph.edges)) arrays.push(json.system.graph.edges);
  return arrays;
}

/**
 * 计算单个图的迁移方案并就地改写传入的 `json`（纯内存；文件 IO 由调用方按 dryRun 决定）。
 * @returns {{changed:boolean, renames:Array, prunes:Array, edgeFixes:Array, tagWrites:Array, mdRenames:Array, positionReKeys:Array, edgeRemovals:Array}}
 */
function planGraph(json, { graphsDir, rootDir, pruneEmpty }) {
  const streams = Array.isArray(json.streams) ? json.streams : [];
  const manifest = isManifest(json);
  const edgeArrays = edgeArraysOf(json);
  const allEdges = [];
  for (const arr of edgeArrays) {
    for (const e of arr) {
      if (e != null && typeof e === 'object') allEdges.push(e);
    }
  }

  // 边引用计数（判定剪枝「无任何边引用」用原始 id）。
  const refCount = new Map();
  for (const e of allEdges) {
    for (const end of [e.source, e.target]) {
      const key = String(end);
      refCount.set(key, (refCount.get(key) || 0) + 1);
    }
  }

  // taken = 仅保留的 s-* 流名集合（绝不含待迁移节点自身名，否则合法名会被误判冲突加 _2）。
  const taken = new Set();
  for (const s of streams) {
    if (s != null && typeof s === 'object' && !Array.isArray(s) && isSEStreamId(s.id)) {
      taken.add(String(s.name));
    }
  }

  // ── 分类：keep / migrate / prune / skip ───────────────────────────────
  const decisions = [];
  const idMap = new Map();
  const removedIds = new Set();
  const prunes = [];
  for (const s of streams) {
    // 畸形结构：streams 数组元素非对象 → 跳过（不崩溃、不改写）。
    if (s == null || typeof s !== 'object' || Array.isArray(s)) {
      decisions.push({ stream: s, action: 'skip' });
      continue;
    }
    const id = String(s.id);
    if (isSEStreamId(id)) {
      decisions.push({ stream: s, action: 'keep' });
      continue;
    }
    if (pruneEmpty) {
      const mdAbs = graphContentResolve(s.source && s.source.file_path, graphsDir, rootDir);
      const { blank, exists } = mdBlankOrMissing(mdAbs);
      const referenced = (refCount.get(id) || 0) > 0;
      if (blank && !referenced) {
        removedIds.add(id);
        prunes.push({
          id,
          name: String(s.name),
          reason: !mdAbs ? 'no-source' : exists ? 'blank' : 'missing',
          md: mdAbs,
        });
        continue;
      }
    }
    const oldName = String(s.name);
    const newName = toStreamName(oldName, taken);
    taken.add(newName);
    const newId = `${IS_STREAM_ID_PREFIX}${newName}`;
    idMap.set(id, newId);
    decisions.push({ stream: s, action: 'migrate', id, newId, oldName, newName });
  }

  // ── 应用流改写：id / name / tags.original_name / description 前缀 / source.file_path ──
  const renames = [];
  const mdRenames = [];
  for (const d of decisions) {
    if (d.action !== 'migrate') continue;
    const s = d.stream;
    s.id = d.newId;
    const nameChanged = d.newName !== d.oldName;
    if (nameChanged) {
      s.name = d.newName;
      if (!s.tags || typeof s.tags !== 'object' || Array.isArray(s.tags)) s.tags = {};
      s.tags.original_name = d.oldName;
      const oldDesc = s.description == null ? '' : String(s.description);
      s.description = `（原名：${d.oldName}）${oldDesc}`;

      // 重命名内容 .md（以 source.file_path 实际指向为准）。此处先写「意图新名」，
      // 执行阶段按实际结果调和（目标已存在/源缺失时回退原名）。
      const oldFp = s.source && s.source.file_path ? String(s.source.file_path) : '';
      if (oldFp) {
        const normalized = oldFp.replace(/\\/g, '/');
        const slash = normalized.lastIndexOf('/');
        const dir = slash >= 0 ? normalized.slice(0, slash) : '';
        const newFp = dir ? `${dir}/${d.newName}.md` : `${d.newName}.md`;
        const oldAbs = graphContentResolve(normalized, graphsDir, rootDir);
        const newAbs = oldAbs ? path.join(path.dirname(oldAbs), `${d.newName}.md`) : '';
        mdRenames.push({ id: d.id, from: oldAbs, to: newAbs, oldFilePath: oldFp, newFilePath: newFp, stream: s });
        s.source = Object.assign({}, s.source, { file_path: newFp });
      }
    }
    renames.push({
      id: d.id,
      newId: d.newId,
      oldName: d.oldName,
      newName: d.newName,
      nameChanged,
    });
  }

  // ── 剪枝：从 streams 移除；manifest positions 同步清理 ─────────────────
  if (removedIds.size) {
    json.streams = streams.filter(
      (s) => !(s != null && typeof s === 'object' && !Array.isArray(s) && removedIds.has(String(s.id)))
    );
  }

  // ── manifest layout re-key（仅 manifest；v3.0 position 随流对象）────────
  // 条目对象整体搬移（width/height 随条目走），规则同原 positions：改名 → 旧键删、新键写，
  // 保留未改名键；剪枝 → 删对应键。
  const positionReKeys = [];
  const layout =
    manifest && json.system.graph.layout && typeof json.system.graph.layout === 'object'
      ? json.system.graph.layout
      : null;
  if (layout) {
    for (const r of renames) {
      if (!r.nameChanged) continue;
      if (Object.prototype.hasOwnProperty.call(layout, r.oldName)) {
        layout[r.newName] = layout[r.oldName];
        delete layout[r.oldName];
        positionReKeys.push({ from: r.oldName, to: r.newName });
      }
    }
    for (const pr of prunes) {
      if (Object.prototype.hasOwnProperty.call(layout, pr.name)) delete layout[pr.name];
    }
  }

  // 旧布局载体 positions（{name:{x,y}}）已废弃：buildDocument（format_version '5.0'）停写、
  // 只写 layout。迁移时若仍存在则删除，doc 重存后由 buildDocument 以 layout 重写，避免旧键残留。
  const positionsRemoved = Boolean(manifest && json.system.graph.positions != null);
  if (positionsRemoved) delete json.system.graph.positions;

  // ── 边修复 + edge.* tags 双写 ─────────────────────────────────────────
  const idToStream = new Map();
  for (const s of Array.isArray(json.streams) ? json.streams : []) {
    if (s != null && typeof s === 'object' && !Array.isArray(s)) idToStream.set(String(s.id), s);
  }

  const { edgeFixes, tagWrites, tagConflicts, edgeRemovals } = repairEdges({
    allEdges,
    edgeArrays,
    idMap,
    removedIds,
    idToStream,
  });

  const changed =
    renames.length > 0 ||
    prunes.length > 0 ||
    edgeFixes.length > 0 ||
    tagWrites.length > 0 ||
    mdRenames.length > 0 ||
    positionReKeys.length > 0 ||
    positionsRemoved ||
    edgeRemovals.length > 0;
  return {
    changed,
    renames,
    prunes,
    edgeFixes,
    tagWrites,
    tagConflicts,
    mdRenames,
    positionReKeys,
    edgeRemovals,
  };
}

/**
 * 边修复 + `edge.*` tags 双写（独立纯函数，便于白盒单测）：
 * - 端点命中 `removedIds`（被剪枝）→ 收集待删边；
 * - 端点命中 `idMap` → 改写为新 `s-*` id，并向 source 流 `tags` 写 `edge.<targetNewName>`；
 * - tags 幂等：已存在相同键值 → 跳过；同键不同值（平行边或既存值）→ **保留先见值**、记 tagConflicts
 *   （确定性：按文件边出现顺序首值优先），tagWrites 仅计实际写入。
 */
export function repairEdges({ allEdges, edgeArrays, idMap, removedIds, idToStream }) {
  const edgeFixes = [];
  const tagWrites = [];
  const tagConflicts = [];
  const edgeRemovals = [];
  const toRemove = new Set();
  const handled = new Map(); // `${sourceId}\u0000${key}` → 本次已确定保留的值

  for (const e of allEdges) {
    const oldS = String(e.source);
    const oldT = String(e.target);
    if (removedIds.has(oldS) || removedIds.has(oldT)) {
      toRemove.add(e);
      edgeRemovals.push({ source: oldS, target: oldT, label: e.label == null ? '' : String(e.label) });
      continue;
    }
    const endpointRewritten = idMap.has(oldS) || idMap.has(oldT);
    const newS = idMap.get(oldS) ?? oldS;
    const newT = idMap.get(oldT) ?? oldT;
    if (idMap.has(oldS)) e.source = newS;
    if (idMap.has(oldT)) e.target = newT;
    if (!endpointRewritten) continue;

    const srcStream = idToStream.get(newS);
    const tgtStream = idToStream.get(newT);
    if (!srcStream || !tgtStream) continue; // 防御：端点流不存在（不应发生）
    const targetNewName = String(tgtStream.name);
    const key = `edge.${targetNewName}`;
    const value = e.label == null ? '' : String(e.label);
    edgeFixes.push({
      source: newS,
      target: newT,
      label: value,
      sourceName: String(srcStream.name),
      targetNewName,
    });
    if (!srcStream.tags || typeof srcStream.tags !== 'object' || Array.isArray(srcStream.tags)) {
      srcStream.tags = {};
    }
    const handleId = `${newS}\u0000${key}`;
    if (handled.has(handleId)) {
      const kept = handled.get(handleId);
      if (kept !== value) {
        tagConflicts.push({ stream: String(srcStream.name), key, kept, ignored: value });
      }
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(srcStream.tags, key)) {
      const kept = srcStream.tags[key];
      handled.set(handleId, kept);
      if (kept !== value) {
        tagConflicts.push({ stream: String(srcStream.name), key, kept, ignored: value });
      }
      continue; // 既存键：相同值幂等跳过 / 不同值保留既有（确定性）
    }
    srcStream.tags[key] = value;
    handled.set(handleId, value);
    tagWrites.push({ stream: String(srcStream.name), key, value });
  }

  if (toRemove.size) {
    for (const arr of edgeArrays) {
      for (let i = arr.length - 1; i >= 0; i -= 1) {
        if (toRemove.has(arr[i])) arr.splice(i, 1);
      }
    }
  }
  return { edgeFixes, tagWrites, tagConflicts, edgeRemovals };
}

/** .md 改名可行性（只读判断）：源存在、目标不存在、且非同一路径。 */
function canRenameMd(from, to) {
  return Boolean(from) && Boolean(to) && from !== to && fs.existsSync(from) && !fs.existsSync(to);
}

/**
 * 应用（或预演）.md 重命名，并按**实际结果**调和 source.file_path：
 * - 成功改名 → 保持 planGraph 写入的新名；
 * - 跳过（源缺失 / 目标已存在碰撞）→ 回退原名，避免配置指向错误/不存在的文件。
 * dry-run 仅做只读判断，不落盘；报告口径（applied 计数）与正式跑一致。
 * @returns {number} 实际（或将要）改名的数量。
 */
function applyMdRenames(mdRenames, dryRun) {
  let applied = 0;
  for (const mr of mdRenames) {
    const ok = canRenameMd(mr.from, mr.to);
    mr.applied = ok;
    if (ok) {
      applied += 1;
      if (!dryRun) {
        fs.mkdirSync(path.dirname(mr.to), { recursive: true });
        renameWithRetry(mr.from, mr.to);
      }
    } else if (mr.stream && mr.stream.source) {
      // 调和：改名未发生 → file_path 保持原实际路径。
      mr.stream.source.file_path = mr.oldFilePath;
    }
  }
  return applied;
}

/** 备份文件的目标路径（保持相对 graphs/ 的结构；越界路径落到 backup/external/）。 */
function backupTarget(backupDir, graphsDir, absPath) {
  const rel = path.relative(graphsDir, absPath);
  const safeRel = rel.startsWith('..') ? path.join('external', path.basename(absPath)) : rel;
  return path.join(backupDir, safeRel);
}

/**
 * 迁移一个 graphs 目录下的全部 `*.se.json`。
 *
 * @param {object} opts
 * @param {string} [opts.rootDir] 项目根（默认 process.cwd()）。
 * @param {string} [opts.graphsDir] graphs 目录（默认 `<rootDir>/graphs`）。
 * @param {boolean} [opts.dryRun] 只计算与报告，不写文件、不改名 .md。
 * @param {boolean} [opts.pruneEmpty] 是否剪枝（空白/缺失且无边引用的本地流），默认 true。
 * @param {number} [opts.now] 备份时间戳（测试可注入）。
 * @returns {object} 迁移报告。
 */
export function migrateDirectory({
  rootDir = process.cwd(),
  graphsDir = null,
  dryRun = false,
  pruneEmpty = true,
  now = Date.now(),
} = {}) {
  const gDir = graphsDir || path.join(rootDir, 'graphs');
  const fileNames = fs
    .readdirSync(gDir)
    .filter((n) => n.endsWith('.se.json'))
    .sort();

  const report = {
    dryRun: Boolean(dryRun),
    pruneEmpty: Boolean(pruneEmpty),
    graphsDir: gDir,
    backupDir: null,
    files: [],
    totals: {
      filesScanned: fileNames.length,
      filesChanged: 0,
      streamsRenamed: 0,
      nameChanges: 0,
      streamsPruned: 0,
      edgesFixed: 0,
      edgesRemoved: 0,
      tagsWritten: 0,
      tagConflicts: 0,
      mdRenamed: 0,
      positionReKeys: 0,
    },
  };

  let backupDir = null;
  const ensureBackupDir = () => {
    if (!backupDir) {
      backupDir = path.join(gDir, `${BACKUP_PREFIX}${now}`);
      fs.mkdirSync(backupDir, { recursive: true });
      report.backupDir = backupDir;
    }
    return backupDir;
  };

  for (const name of fileNames) {
    const filePath = path.join(gDir, name);
    let originalText;
    try {
      originalText = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    let json;
    try {
      json = JSON.parse(originalText.replace(/^\uFEFF/, ''));
    } catch {
      report.files.push({ file: name, changed: false, error: 'invalid-json', renames: [], prunes: [], edgeFixes: [], tagWrites: [], tagConflicts: [], mdRenames: [], positionReKeys: [], edgeRemovals: [] });
      continue;
    }

    const plan = planGraph(json, { graphsDir: gDir, rootDir, pruneEmpty });

    // 1) 备份（仅正式跑）：在任何落盘/改名之前，备份原配置 + 候选将被改名的 .md（原始路径）。
    if (plan.changed && !dryRun) {
      const bDir = ensureBackupDir();
      const toBackup = [filePath];
      for (const mr of plan.mdRenames) if (mr.from && fs.existsSync(mr.from)) toBackup.push(mr.from);
      for (const src of toBackup) {
        const dst = backupTarget(bDir, gDir, src);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      }
    }

    // 2) 应用/预演 .md 改名，并按实际结果调和 source.file_path（dry-run 只读，口径一致）。
    const mdRenamedApplied = applyMdRenames(plan.mdRenames, dryRun);

    const entry = {
      file: name,
      path: filePath,
      changed: plan.changed,
      wrote: false,
      renames: plan.renames,
      prunes: plan.prunes,
      edgeFixes: plan.edgeFixes,
      tagWrites: plan.tagWrites,
      tagConflicts: plan.tagConflicts,
      mdRenames: plan.mdRenames.map((mr) => ({
        id: mr.id,
        from: mr.from,
        to: mr.to,
        oldFilePath: mr.oldFilePath,
        newFilePath: mr.newFilePath,
        applied: Boolean(mr.applied),
      })),
      positionReKeys: plan.positionReKeys,
      edgeRemovals: plan.edgeRemovals,
    };

    if (plan.changed) {
      report.totals.filesChanged += 1;
      report.totals.streamsRenamed += plan.renames.length;
      report.totals.nameChanges += plan.renames.filter((r) => r.nameChanged).length;
      report.totals.streamsPruned += plan.prunes.length;
      report.totals.edgesFixed += plan.edgeFixes.length;
      report.totals.edgesRemoved += plan.edgeRemovals.length;
      report.totals.tagsWritten += plan.tagWrites.length;
      report.totals.tagConflicts += plan.tagConflicts.length;
      report.totals.positionReKeys += plan.positionReKeys.length;
      // 实际（或将要）改名数——跳过碰撞后与按计划数的差异在此体现，dry-run 与正式跑一致。
      report.totals.mdRenamed += mdRenamedApplied;

      if (!dryRun) {
        // 3) 原子写回配置（仅在序列化结果确有变化时落盘）。
        const newText = serializeJson(json, originalText);
        const wroteConfig = normText(newText) !== normText(originalText);
        if (wroteConfig) atomicWriteFileSync(filePath, newText);
        entry.wrote = wroteConfig || mdRenamedApplied > 0;
      }
    }

    report.files.push(entry);
  }

  return report;
}

/** 生成 CLI 报告文本（stdout）。 */
export function formatReport(report) {
  const lines = [];
  const head = report.dryRun ? '[DRY-RUN] 迁移预览（未写任何文件）' : '迁移执行完成';
  lines.push(head);
  lines.push(`graphs 目录: ${report.graphsDir}`);
  if (report.backupDir) lines.push(`备份目录: ${report.backupDir}`);
  lines.push('');

  for (const f of report.files) {
    if (f.error) {
      lines.push(`── ${f.file}  [跳过：${f.error}]`);
      continue;
    }
    if (!f.changed) {
      lines.push(`── ${f.file}  （无需迁移）`);
      continue;
    }
    lines.push(`── ${f.file}`);
    if (f.renames.length) {
      lines.push(`   改名对照 (${f.renames.length}):`);
      for (const r of f.renames) {
        const nameNote = r.nameChanged ? `  name "${r.oldName}" → "${r.newName}"` : `  name "${r.oldName}" 不变`;
        lines.push(`     ${r.id} → ${r.newId}${nameNote}`);
      }
    }
    if (f.prunes.length) {
      lines.push(`   剪枝 (${f.prunes.length}):`);
      for (const p of f.prunes) lines.push(`     ${p.id} "${p.name}"  (${p.reason})`);
    }
    if (f.mdRenames.length) {
      lines.push(`   重命名 .md (${f.mdRenames.length}):`);
      for (const m of f.mdRenames) {
        lines.push(`     ${m.oldFilePath} → ${m.newFilePath}${m.applied ? '' : '  [跳过：目标已存在或源缺失，file_path 保持原名]'}`);
      }
    }
    if (f.positionReKeys.length) {
      lines.push(`   positions re-key (${f.positionReKeys.length}):`);
      for (const k of f.positionReKeys) lines.push(`     ${k.from} → ${k.to}`);
    }
    if (f.edgeFixes.length) {
      lines.push(`   边修复 (${f.edgeFixes.length}):`);
      for (const e of f.edgeFixes) {
        lines.push(`     ${e.source} → ${e.target}  [tag edge.${e.targetNewName} = "${e.label}"]`);
      }
    }
    if (f.edgeRemovals.length) {
      lines.push(`   边删除（端点已剪枝）(${f.edgeRemovals.length}):`);
      for (const e of f.edgeRemovals) lines.push(`     ${e.source} → ${e.target}`);
    }
    if (f.tagWrites.length) {
      lines.push(`   edge.* tags 写入 (${f.tagWrites.length}):`);
      for (const t of f.tagWrites) lines.push(`     ${t.stream}.tags["${t.key}"] = "${t.value}"`);
    }
    if (f.tagConflicts.length) {
      lines.push(`   edge.* tags 冲突（保留先见值，跳过重复键）(${f.tagConflicts.length}):`);
      for (const c of f.tagConflicts) {
        lines.push(`     ${c.stream}.tags["${c.key}"] 保留 "${c.kept}"，忽略 "${c.ignored}"`);
      }
    }
    lines.push('');
  }

  const t = report.totals;
  lines.push('==== 汇总 ====');
  lines.push(
    `扫描 ${t.filesScanned} 文件 / 变更 ${t.filesChanged} 文件 / 改名 ${t.streamsRenamed}（其中 name 变更 ${t.nameChanges}）/ 剪枝 ${t.streamsPruned}`
  );
  lines.push(
    `边修复 ${t.edgesFixed} / 边删除 ${t.edgesRemoved} / tags 写入 ${t.tagsWritten}（冲突跳过 ${t.tagConflicts}）/ .md 重命名 ${t.mdRenamed} / positions re-key ${t.positionReKeys}`
  );
  if (t.filesChanged === 0) lines.push('无需迁移。');
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  let pruneEmpty = true;
  if (args.includes('--no-prune-empty')) pruneEmpty = false;
  else if (args.includes('--prune-empty')) pruneEmpty = true;

  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const report = migrateDirectory({
    rootDir,
    graphsDir: path.join(rootDir, 'graphs'),
    dryRun,
    pruneEmpty,
  });
  console.log(formatReport(report));
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
