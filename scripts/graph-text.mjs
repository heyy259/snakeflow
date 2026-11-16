// 脚本入口：获取某图的只读文本视图（Y1 逻辑图）。
// 用法：node scripts/graph-text.mjs <图名> [--yaml] [--port 5173]
// 依赖已运行的 vite dev server（端点 GET /api/graphs/text）。
const [name, ...rest] = process.argv.slice(2);
if (!name) {
  console.error('用法：node scripts/graph-text.mjs <图名> [--yaml] [--port 5173]');
  process.exit(2);
}
const fmt = rest.includes('--yaml') ? 'yaml' : 'json';
const portIdx = rest.indexOf('--port');
const port = (portIdx >= 0 ? rest[portIdx + 1] : null) || '5173';

const res = await fetch(
  `http://127.0.0.1:${port}/api/graphs/text?name=${encodeURIComponent(name)}&format=${fmt}`
);
if (!res.ok) {
  console.error('HTTP', res.status);
  process.exit(1);
}
process.stdout.write(await res.text());
