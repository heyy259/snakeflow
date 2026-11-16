// 孤儿内容清理（期 4 · D11「删除默认留孤儿 + 显式清理」）。
//
// 孤儿 = 位于 `graphs/<名>.streams/` 下、但不被任何 `graphs/*.se.json` 配置的
// `streams[].source.file_path` 引用的正文文件（含配置已删/改名后残留的整个目录）。
// 纯 Node；**默认 dry-run 只报告**，加 `--apply` 才真正删除（先删文件、再删空目录）。
//
// 用法：
//   node scripts/cleanup-graph-orphans.mjs           # 只报告
//   node scripts/cleanup-graph-orphans.mjs --apply   # 实际删除
//
// 注意：文件名为非 ASCII（中文）时避免 fs.rmSync（OneDrive/Windows 已知崩溃），
// 故用 unlinkSync + rmdirSync（仅空目录）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GRAPHS = path.join(ROOT, 'graphs');
const APPLY = process.argv.includes('--apply');
const SKIP = new Set(['.workspace.json', '.ui.json', '.frecency.json', '.snippets.json', 'history.json']);

// `source.file_path` 现为 manifest 同级相对（如 `计划.streams/x.md`）；绝对路径原样，
// 旧式 `graphs/` 前缀按项目根解析，其余同级相对按 graphs/ 解析。
const abs = (p) => {
  const s = String(p).replace(/\\/g, '/');
  if (/^([A-Za-z]:\/|\/\/|\/)/.test(s)) return path.resolve(s);
  if (s.startsWith('graphs/')) return path.resolve(ROOT, s);
  return path.resolve(GRAPHS, s);
};
const key = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

// 1. 收集所有配置引用的正文文件（跨全部 config，避免误删被别的图引用的文件）。
const referenced = new Set();
let configs = 0;
for (const f of fs.readdirSync(GRAPHS)) {
  if (!f.endsWith('.se.json') || SKIP.has(f) || f.startsWith('.')) continue;
  let j;
  try {
    j = JSON.parse(fs.readFileSync(path.join(GRAPHS, f), 'utf8'));
  } catch (err) {
    continue;
  }
  configs += 1;
  for (const s of Array.isArray(j.streams) ? j.streams : []) {
    const fp = s && s.source && s.source.file_path;
    if (fp) referenced.add(key(abs(fp)));
  }
}

// 2. 扫描所有 .streams/ 目录下的正文文件。
const orphans = [];
for (const d of fs.readdirSync(GRAPHS)) {
  if (!d.endsWith('.streams')) continue;
  const dir = path.join(GRAPHS, d);
  let st;
  try {
    st = fs.statSync(dir);
  } catch (err) {
    continue;
  }
  if (!st.isDirectory()) continue;
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    try {
      if (!fs.statSync(full).isFile()) continue;
    } catch (err) {
      continue;
    }
    if (!referenced.has(key(full))) orphans.push(full);
  }
}

console.log(`配置：${configs} 个；被引用正文：${referenced.size} 个；孤儿：${orphans.length} 个`);
for (const o of orphans) console.log(`  孤儿  ${path.relative(ROOT, o).replace(/\\/g, '/')}`);

if (!APPLY) {
  console.log('\n（DRY-RUN；加 --apply 才真正删除）');
} else {
  let removed = 0;
  for (const o of orphans) {
    try {
      fs.unlinkSync(o);
      removed += 1;
    } catch (err) {
      console.warn(`删除失败 ${o}：${err.message}`);
    }
  }
  // 删除空的 .streams 目录（只删空目录，非空跳过）。
  let dirsRemoved = 0;
  for (const d of fs.readdirSync(GRAPHS)) {
    if (!d.endsWith('.streams')) continue;
    const dir = path.join(GRAPHS, d);
    try {
      if (fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
        dirsRemoved += 1;
      }
    } catch (err) {
      /* 非空/被占用：跳过 */
    }
  }
  console.log(`\n已删除孤儿文件 ${removed} 个、空目录 ${dirsRemoved} 个`);
}
