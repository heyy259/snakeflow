// 一次性迁移：graphs/*.json -> graphs/*.se.json
// - 跳过 store 文件（history.json / .*）与备份目录
// - 重写 history.json / .frecency.json 中的绝对路径
// - 重写每个图配置内 streams[].source.file_path（去 "graphs/" 前缀，改 manifest 同级相对）
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const GRAPHS = path.join(ROOT, 'graphs');
const RESERVED = new Set(['history.json']); // autospawn.json 亦为图配置，随之一并迁移

const isGraphConfig = (n) =>
  n.endsWith('.json') && !n.endsWith('.se.json') && !n.startsWith('.') && !RESERVED.has(n);

let moved = 0;
for (const name of fs.readdirSync(GRAPHS)) {
  if (!isGraphConfig(name)) continue;
  const from = path.join(GRAPHS, name);
  const to = path.join(GRAPHS, name.replace(/\.json$/, '.se.json'));
  // 重写 source.file_path：去 "graphs/" 前缀
  const doc = JSON.parse(fs.readFileSync(from, 'utf8'));
  for (const s of doc.streams || []) {
    const fp = s?.source?.file_path;
    if (typeof fp === 'string' && fp.startsWith('graphs/')) {
      s.source.file_path = fp.slice('graphs/'.length);
    }
  }
  fs.writeFileSync(to, JSON.stringify(doc, null, 2) + '\n');
  fs.rmSync(from);
  moved++;
}

// 重写历史/频率表中指向**图配置**的引用（`graphs/<名>.json`）。
// 其它 `.json`（如 `.config` 下的无关文件）未迁移，引用保持原样；已为 `.se.json` 的天然跳过（幂等）。
function rewriteJson(p, fn) {
  if (!fs.existsSync(p)) return;
  const raw = fs.readFileSync(p, 'utf8');
  try { const data = JSON.parse(raw); fs.writeFileSync(p, fn(data)); } catch {}
}
const isGraphRef = (p) => {
  const s = String(p == null ? '' : p);
  return /(^|[\\/])graphs[\\/][^\\/]*\.json$/i.test(s) && !/\.se\.json$/i.test(s);
};
const swap = (s) => String(s).replace(/\.json$/i, '.se.json');
rewriteJson(path.join(GRAPHS, 'history.json'), (d) =>
  JSON.stringify(Array.isArray(d) ? d.map((e) => (isGraphRef(e?.path) ? { ...e, path: swap(e.path) } : e)) : d));
rewriteJson(path.join(GRAPHS, '.frecency.json'), (d) =>
  JSON.stringify(Array.isArray(d) ? d.map((e) => (isGraphRef(e?.path) ? { ...e, path: swap(e.path), name: swap(e.name) } : e)) : d));

console.log(`migrated ${moved} graph configs`);
