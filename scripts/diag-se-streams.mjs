// 诊断工具：判定某 SE system 里 {base} / {base}_console / {base}_scan_log 是否存在。
// 权威来源 = snapshots/<sid>/snapshot.json 的 streams 键（SE 事实：stream.create 不写 journal，
// journal 可能是孤儿；snapshot 不会过滤内部流）。journal 仅用于交叉检查孤儿。
// 用法：
//   node scripts/diag-se-streams.mjs                        列出 workspace 全部 system 的流清单
//   node scripts/diag-se-streams.mjs plan                   只看 system plan
//   node scripts/diag-se-streams.mjs plan oc_agent自追问    检查 base 的三条派生流
//   node scripts/diag-se-streams.mjs plan --live            追加经 vite 代理的实时 stream.list
//   node scripts/diag-se-streams.mjs plan --live --vite-port 5173

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const pos = argv.filter((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--vite-port');
const [wantSystem, wantBase] = pos;
const live = flag('--live');
const vitePort = opt('--vite-port', '5173');

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

function workspaceTabs() {
  const ws = readJson(path.join(ROOT, 'graphs', '.workspace.json'));
  return (ws?.tabs || []).map((t) => ({
    name: t.name,
    systemId: t.system?.system_id || t.name,
    storageDir: t.system?.storage_dir || `se-systems/${t.system?.system_id || t.name}`,
  }));
}

function decodeJournalName(file) {
  const stem = file.replace(/\.jsonl$/, '');
  const segs = stem.split('-');
  const i = segs.findIndex((s) => /^[0-9a-f]{12}$/.test(s));
  if (i <= 0) return null;
  const b64 = segs.slice(0, i).join('-');
  try {
    return Buffer.from(b64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

function snapshotKeys(sid) {
  const dir = path.join(ROOT, 'se-systems', sid, 'snapshots', sid);
  const out = { canonical: null, devices: {}, files: [] };
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!/^snapshot.*\.json$/.test(f)) continue;
    const j = readJson(path.join(dir, f));
    if (!j || !j.streams) continue;
    const keys = Object.keys(j.streams);
    out.files.push({ file: f, timestamp: j.timestamp, count: keys.length });
    if (f === 'snapshot.json') out.canonical = keys;
    else out.devices[f] = keys;
  }
  return out;
}

function journalNames(sid) {
  const dir = path.join(ROOT, 'se-systems', sid, 'journal');
  const set = new Set();
  if (!fs.existsSync(dir)) return set;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const n = decodeJournalName(f);
    if (n) set.add(n);
  }
  return set;
}

function report(sid, base) {
  const snap = snapshotKeys(sid);
  const jrn = journalNames(sid);
  const authoritative = new Set(snap.canonical || []);
  console.log(`\n===== system: ${sid} =====`);
  console.log(
    `snapshot 文件: ${snap.files.map((f) => `${f.file}(${f.count} @ ${f.timestamp || '?'})`).join(', ') || '(无)'}`
  );
  console.log(`权威清单 snapshot.json streams (${authoritative.size}):`);
  [...authoritative]
    .sort()
    .forEach((n) => console.log(`  - ${n}`));
  for (const [f, keys] of Object.entries(snap.devices)) {
    console.log(`设备快照 ${f} (${keys.length}): ${keys.join(', ')}`);
  }
  const orphan = [...jrn].filter((n) => !authoritative.has(n));
  if (orphan.length) console.log(`仅存在于 journal（孤儿/未在权威快照）: ${orphan.join(', ')}`);
  if (base) {
    console.log(`\n--- base 检查: ${base} ---`);
    for (const n of [base, `${base}_console`, `${base}_scan_log`]) {
      const inSnap = authoritative.has(n);
      const inJrn = jrn.has(n);
      console.log(`  ${inSnap ? 'YES' : 'NO '}  ${n}   (snapshot=${inSnap}, journal=${inJrn})`);
    }
  }
}

async function liveList(sid) {
  const url = `ws://localhost:${vitePort}/api/se/ws?system_id=${encodeURIComponent(sid)}`;
  return new Promise((resolve) => {
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      resolve({ error: String(e) });
      return;
    }
    const to = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      resolve({ error: 'timeout（vite 未运行？端口不对？）' });
    }, 8000);
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'stream.list', params: {}, id: 1 }));
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.id !== 1) return;
      clearTimeout(to);
      try {
        ws.close();
      } catch {}
      resolve(m.error ? { error: m.error } : { names: (m.result || []).map((r) => r.name) });
    };
    ws.onerror = () => {
      clearTimeout(to);
      resolve({ error: `WS 错误（vite 未运行 / system 未 spawn / 端口 ${vitePort} 不通）` });
    };
  });
}

const tabs = workspaceTabs();
const systems = wantSystem ? [wantSystem] : tabs.map((t) => t.systemId);
for (const sid of systems) {
  report(sid, wantBase);
  if (live) {
    const res = await liveList(sid);
    if (res.error) {
      console.log(`实时 stream.list: 失败 -> ${JSON.stringify(res.error)}`);
    } else {
      console.log(`实时 stream.list (${res.names.length}):`);
      res.names.sort().forEach((n) => console.log(`  - ${n}`));
      if (wantBase) {
        for (const n of [wantBase, `${wantBase}_console`, `${wantBase}_scan_log`]) {
          console.log(`  ${res.names.includes(n) ? 'YES' : 'NO '}  ${n}`);
        }
      }
    }
  }
}
