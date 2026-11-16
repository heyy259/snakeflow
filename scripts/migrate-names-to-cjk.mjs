// 期 7 数据迁移（SE中文名同步改造方案 §6.8 / §8）：把 `graphs/*.se.json` 统一升级到
// 「单一中文 name」schema —— 去 `title`、`name` 走契约（含 CJK）、`s-<旧名>` id 与 edges
// 一并改写、`.streams/` 文件名与 `source.file_path` 同步纠正。
//
// 纯 Node、幂等、**默认 dry-run**（只打印 diff，不写盘）。执行须显式 `--apply`。
//
// 用法：
//   node scripts/migrate-names-to-cjk.mjs            # 预演（dry-run）
//   node scripts/migrate-names-to-cjk.mjs --apply    # 实际写盘
//   node scripts/migrate-names-to-cjk.mjs --dir graphs --apply
//
// 迁移算法（与方案 §8 一致）：
//   desired = toStreamName(title || name || basename(source.file_path))
//   newId   = id.startsWith('s-') ? 's-' + desired : id
//   edges[].source/target 经 idMap 改写；title 删除；source.file_path 按新名纠正。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toStreamName } from '../src/se/nameContract.js';
import { sanitizeStreamFilename } from '../src/se/paths.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const dirArgIdx = args.indexOf('--dir');
const GRAPHS_DIR = path.resolve(ROOT, dirArgIdx >= 0 && args[dirArgIdx + 1] ? args[dirArgIdx + 1] : 'graphs');

const posix = (p) => String(p == null ? '' : p).replace(/\\/g, '/');

/** 解析 `file_path`（相对项目根或绝对）为绝对路径。 */
function resolveProjectRel(fp) {
  const p = String(fp == null ? '' : fp);
  if (/^([A-Za-z]:[\\/]|\/\/|\/)/.test(p)) return p;
  return path.join(ROOT, p);
}

/** 迁移单个文档对象；返回 diff 列表 + 是否有变更。
 *
 * 口径（方案 §8，二次检查后收敛）：
 * - **SE 投影流（id 形如 `s-*`）**：`name` 即 SE 名，走命名契约（含 CJK）+ 去重；
 *   `id` 改写为 `s-<name>`；文件名按新名纠正。
 * - **本地流（`n-*` / 数字 id）**：`name` 只是显示名，**原样保留**（不做契约净化、不参与
 *   去重、不改 id/文件名）；其 SE 名在回灌时由 `buildMigrationDataFrom` 现场派生并去重。
 * 两路共同：删除 `title`、重写 edges 引用。
 */
function migrateDoc(doc) {
  const diffs = [];
  const idMap = new Map();
  const nameMap = new Map(); // 旧 name → 新 name（仅实际改名的流），供位置类字段 re-key 用
  const taken = [];
  const streams = Array.isArray(doc.streams) ? doc.streams : [];

  // v3：统一文档版本号（与 `src/document.js` DOC_VERSION 对齐）。
  if (doc.version !== '3.0') {
    diffs.push(`  文档 version ${JSON.stringify(doc.version)} → "3.0"`);
    doc.version = '3.0';
  }

  for (const s of streams) {
    if (!s || typeof s !== 'object') continue;
    const oldId = String(s.id);
    const isProjected = oldId.startsWith('s-');
    const titleVal = s.title != null && String(s.title) !== '' ? String(s.title) : '';
    const nameVal = s.name != null && String(s.name) !== '' ? String(s.name) : '';
    const source = s.source && typeof s.source === 'object' ? s.source : null;
    const baseFromFile = source && source.file_path
      ? posix(source.file_path).split('/').pop().replace(/\.[^.]+$/, '')
      : '';
    const hadTitle = Object.prototype.hasOwnProperty.call(s, 'title');

    let desired;
    let newId;
    if (isProjected) {
      // SE 投影流：title（旧中文显示名）优先提升为 name；否则用现 name / 文件名派生。
      desired = toStreamName(titleVal || nameVal || baseFromFile, taken);
      taken.push(desired);
      newId = `s-${desired}`;
    } else {
      desired = titleVal || nameVal; // 本地：仅把旧 title 提升为 name（如有）
      newId = oldId;
    }
    idMap.set(oldId, newId);

    if (newId !== oldId || nameVal !== desired || hadTitle) {
      diffs.push(`  流 id=${oldId} name=${JSON.stringify(nameVal)} title=${JSON.stringify(s.title)} → id=${newId} name=${desired}${hadTitle ? '（删 title）' : ''}`);
    }
    s.id = newId;
    s.name = desired;
    delete s.title;
    if (String(nameVal) !== String(desired)) nameMap.set(String(nameVal), String(desired));
  }

  // 既有遗漏修复（历史 bug）：本脚本升级流名后整体重写配置，但从不 re-key 位置类字段，
  // 导致改名后 system.graph.positions 键与新流名脱节、画布位置静默丢失。
  // 重写前对 layout（新载体，{name:{x,y,width?,height?}}）与旧 positions 都做 re-key：
  // 旧名键 → 新名键，条目对象整个搬移（width/height 随条目走），规则与 migrate-local-nodes 一致。
  if (
    nameMap.size &&
    doc.system != null && typeof doc.system === 'object' &&
    doc.system.graph != null && typeof doc.system.graph === 'object'
  ) {
    for (const field of ['layout', 'positions']) {
      const bucket = doc.system.graph[field];
      if (!bucket || typeof bucket !== 'object') continue;
      for (const [oldName, newName] of nameMap) {
        if (Object.prototype.hasOwnProperty.call(bucket, oldName)) {
          bucket[newName] = bucket[oldName];
          delete bucket[oldName];
          diffs.push(`  ${field} re-key：${oldName} → ${newName}`);
        }
      }
    }
  }

  // 文件名纠正：仅 SE 投影流（其 name 变更会影响 SE 兄弟文件名）。
  const renames = [];
  for (const s of streams) {
    if (!s || typeof s !== 'object' || !s.source || !s.source.file_path) continue;
    if (!String(s.id).startsWith('s-')) continue;
    const fp = posix(s.source.file_path);
    const slash = fp.lastIndexOf('/');
    const dir = slash >= 0 ? fp.slice(0, slash) : '';
    const oldBase = fp.slice(slash + 1);
    const ext = path.extname(oldBase) || '.md';
    const newBase = sanitizeStreamFilename(String(s.name), ext);
    if (newBase === oldBase) continue;
    const oldAbs = resolveProjectRel(fp);
    const newRel = dir ? `${dir}/${newBase}` : newBase;
    const newAbs = resolveProjectRel(newRel);
    // 目标文件名已被别的流占用 → 不抢名，保留原引用（避免内容错配）。
    if (posix(newAbs) !== posix(oldAbs) && fs.existsSync(newAbs)) {
      diffs.push(`  文件 ${fp}（目标名 ${newBase} 已被占用，保留原引用）`);
      continue;
    }
    s.source.file_path = newRel;
    renames.push({ oldAbs, newAbs });
    diffs.push(`  文件 ${fp} → ${newRel}${fs.existsSync(oldAbs) ? '' : '（源文件缺失，仅改引用）'}`);
  }

  // edges 重写。
  const edges = Array.isArray(doc.edges) ? doc.edges : [];
  for (const e of edges) {
    if (!e || typeof e !== 'object') continue;
    const oldS = String(e.source);
    const oldT = String(e.target);
    const ns = idMap.has(oldS) ? idMap.get(oldS) : oldS;
    const nt = idMap.has(oldT) ? idMap.get(oldT) : oldT;
    if (ns !== oldS || nt !== oldT) {
      diffs.push(`  边 ${oldS}→${oldT} ⇒ ${ns}→${nt}`);
      e.source = ns;
      e.target = nt;
    }
  }

  return { diffs, renames };
}

function main() {
  if (!fs.existsSync(GRAPHS_DIR)) {
    console.error(`目录不存在：${GRAPHS_DIR}`);
    process.exit(1);
  }
  const files = fs.readdirSync(GRAPHS_DIR).filter((n) => n.toLowerCase().endsWith('.se.json') && !n.startsWith('.'));
  let changedFiles = 0;
  let changedStreams = 0;

  for (const name of files) {
    const abs = path.join(GRAPHS_DIR, name);
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch (err) {
      console.log(`跳过（JSON 解析失败）${name}：${err.message}`);
      continue;
    }
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.streams)) {
      console.log(`跳过（非统一文档）：${name}`);
      continue;
    }
    const before = JSON.stringify(doc);
    const { diffs, renames } = migrateDoc(doc);
    const after = JSON.stringify(doc);
    if (before === after) continue;

    changedFiles += 1;
    changedStreams += diffs.filter((d) => d.startsWith('  流')).length;
    console.log(`\n${name}${APPLY ? '（应用）' : '（预演）'}：`);
    diffs.forEach((d) => console.log(d));

    if (APPLY) {
      // 文件改名（引用已在 migrateDoc 更新；冲突项已跳过）。
      for (const r of renames) {
        try {
          if (fs.existsSync(r.oldAbs)) fs.renameSync(r.oldAbs, r.newAbs);
        } catch (err) {
          console.log(`  ! 文件改名失败（引用已指新名，请手工核对）：${r.oldAbs} → ${r.newAbs}：${err.message}`);
        }
      }
      const tmp = `${abs}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, abs);
    }
  }

  console.log(`\n==== ${APPLY ? '已迁移' : '预演'} ${changedFiles} 个文件 / ${changedStreams} 条流 ====`);
  if (!APPLY && changedFiles) console.log('（dry-run；加 --apply 执行写盘）');
}

main();
