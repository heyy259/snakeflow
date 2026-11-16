// 历史本地节点迁移脚本单测（纯 Node，零外部依赖）。
//
// 覆盖：v3.0 顶级 edges 改写、manifest system.graph.edges 改写、非法名改名（+ / 空格 / 数字开头）、
// 重名消歧 _2、taken 不含自身名（合法名不被误加后缀）、edge.* tags 双写且幂等、
// 剪枝 guard（空白+无边→删；空白+有边→不删）、layout re-key（仅 manifest，条目整体搬移）、
// 旧 positions 字段删除、dry-run 不落盘、二次运行幂等无变更。
//
// Reviewer 追加覆盖：①边缘引用被剪枝节点 → edgeRemovals（白盒 repairEdges）；
// ②.rename 目标已存在的碰撞跳过 + file_path 按实际结果调和；③reason:'no-source'；
// ④畸形结构（streams 非数组 / 元素非对象 / tags 缺失或 null / edges 缺失）；
// ⑤pruneEmpty 开关；⑥平行边同键不同 label 的确定性（保留先见值 + 冲突计数 + tagWrites 去重）。
//
// 自隔离：全部在 os.tmpdir() 下自建临时目录，**不触碰真实 graphs/**。
// 运行：node scripts/smoke-migrate-local-nodes.mjs（全绿退出码 0）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  migrateDirectory,
  repairEdges,
  isManifest,
  isSEStreamId,
  graphContentResolve,
} from './migrate-local-nodes.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 200) : ''}`);
};

// ── 工具 ────────────────────────────────────────────────────────────────
const ROOTS = [];
function makeRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const graphs = path.join(root, 'graphs');
  fs.mkdirSync(graphs, { recursive: true });
  ROOTS.push(root);
  return { root, graphs };
}
function writeAt(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  return abs;
}
function writeJsonAt(root, rel, obj) {
  return writeAt(root, rel, JSON.stringify(obj, null, 2));
}
function readJsonAt(root, rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf-8'));
}
function rmrf(p) {
  if (!fs.existsSync(p)) return;
  if (fs.statSync(p).isDirectory()) {
    for (const n of fs.readdirSync(p)) rmrf(path.join(p, n));
    fs.rmdirSync(p);
  } else {
    fs.unlinkSync(p);
  }
}
const isBackup = (p) => p.split(/[\\/]/).some((seg) => seg.startsWith('.migration-backup-'));
function snapshot(dir, base = dir, out = new Map()) {
  if (!fs.existsSync(dir)) return out;
  for (const n of fs.readdirSync(dir)) {
    const abs = path.join(dir, n);
    if (isBackup(abs)) continue;
    const st = fs.statSync(abs);
    if (st.isDirectory()) snapshot(abs, base, out);
    else out.set(path.relative(base, abs), fs.readFileSync(abs, 'utf-8'));
  }
  return out;
}
function snapEq(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
const findFile = (report, name) => report.files.find((f) => f.file === name);
const streamByName = (root, rel, name) =>
  (readJsonAt(root, rel).streams || []).find((s) => s && String(s.name) === name);

// ════════════════════════════════════════════════════════════════════════
// 根 A：v3.0 + manifest（主用例）
// ════════════════════════════════════════════════════════════════════════
const A = makeRoot('migrate-A-');
const V3_REL = 'graphs/v3.se.json';
const MANIFEST_REL = 'graphs/manifest.se.json';

function buildA() {
  writeJsonAt(A.root, V3_REL, {
    version: '3.0',
    system: { name: 'v3' },
    streams: [
      { id: 's-keep', name: 'keep', description: '', tags: {}, position: { x: 0, y: 0 }, source: { file_path: 'v3.streams/keep.md', encoding: 'utf-8' } },
      { id: 'n-1', name: '合法名', description: '', tags: {}, position: { x: 1, y: 1 }, source: { file_path: 'v3.streams/合法名.md', encoding: 'utf-8' } },
      { id: 'n-2', name: '40分钟计划+40', description: '', tags: {}, position: { x: 2, y: 2 }, source: { file_path: 'v3.streams/40分钟计划+40.md', encoding: 'utf-8' } },
      { id: 'n-3', name: '处理 B', description: '', tags: {}, position: { x: 3, y: 3 }, source: { file_path: 'v3.streams/处理 B.md', encoding: 'utf-8' } },
      { id: 'n-4', name: '合法名', description: '', tags: {}, position: { x: 4, y: 4 }, source: { file_path: 'v3.streams/合法名-n-4.md', encoding: 'utf-8' } },
      { id: 'n-5', name: '空白无边', description: '', tags: {}, position: { x: 5, y: 5 }, source: { file_path: 'v3.streams/空白无边.md', encoding: 'utf-8' } },
      { id: 'n-6', name: '空白有边', description: '', tags: {}, position: { x: 6, y: 6 }, source: { file_path: 'v3.streams/空白有边.md', encoding: 'utf-8' } },
    ],
    edges: [
      { source: 'n-1', target: 'n-2', label: '' },
      { source: 'n-2', target: 'n-3', label: 'L23' },
      { source: 'n-1', target: 'n-6', label: '' },
      { source: 's-keep', target: 'n-1', label: 'Lk' },
    ],
    tools: {},
  });
  writeAt(A.root, 'graphs/v3.streams/keep.md', 'keep 正文');
  writeAt(A.root, 'graphs/v3.streams/合法名.md', '合法名正文');
  writeAt(A.root, 'graphs/v3.streams/40分钟计划+40.md', '计划正文');
  writeAt(A.root, 'graphs/v3.streams/处理 B.md', '处理正文');
  writeAt(A.root, 'graphs/v3.streams/合法名-n-4.md', '重复名正文');
  writeAt(A.root, 'graphs/v3.streams/空白无边.md', ''); // 空白 + 无边 → 剪枝
  writeAt(A.root, 'graphs/v3.streams/空白有边.md', '   \n\t  '); // 空白 + 有边 → 不剪枝

  writeJsonAt(A.root, MANIFEST_REL, {
    $schema: 'snake-manifest-v1',
    id: 'manifest#x',
    namespace: 'manifest',
    streams: [
      { id: 's-base', name: 'base', description: '', tags: {}, position: { x: 1, y: 1 }, source: { file_path: 'manifest.streams/base.md', encoding: 'utf-8' } },
      { id: 'n-1', name: '坏 名', description: '', tags: {}, position: { x: 2, y: 2 }, source: { file_path: 'manifest.streams/坏 名.md', encoding: 'utf-8' } },
    ],
    tools: {},
    system: {
      name: 'manifest',
      graph: {
        format_version: '5.0',
        edges: [{ source: 's-base', target: 'n-1', label: 'L' }],
        // v5 单一载体：改名 re-key / 剪枝删键的目标（条目对象整体搬移，宽高随条目走）。
        layout: { base: { x: 1, y: 1, width: 220 }, '坏 名': { x: 2, y: 2, height: 64 } },
        // 旧布局载体残留：迁移应删除（buildDocument 重存后由 layout 重写）。
        positions: { base: { x: 99, y: 99 }, '坏 名': { x: 99, y: 99 } },
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    },
  });
  writeAt(A.root, 'graphs/manifest.streams/base.md', 'base 正文');
  writeAt(A.root, 'graphs/manifest.streams/坏 名.md', '坏名正文');
}

try {
  buildA();

  // ── 0. 纯函数探测 ─────────────────────────────────────────────────────
  check('0a isSEStreamId 口径与 streamNameFromId 对齐', isSEStreamId('s-x') && !isSEStreamId('n-1') && !isSEStreamId('1') && !isSEStreamId(undefined));
  check('0b isManifest 识别 manifest / v3.0', isManifest(readJsonAt(A.root, MANIFEST_REL)) && !isManifest(readJsonAt(A.root, V3_REL)));
  check(
    '0c graphContentResolve：相对路径按 graphs 目录解析',
    graphContentResolve('v3.streams/a.md', A.graphs, A.root) === path.join(A.graphs, 'v3.streams', 'a.md') &&
      graphContentResolve('graphs/v3.streams/a.md', A.graphs, A.root) === path.join(A.graphs, 'v3.streams', 'a.md')
  );

  // ── 1. dry-run：不落盘 ────────────────────────────────────────────────
  const before = snapshot(A.graphs);
  const dry = migrateDirectory({ rootDir: A.root, graphsDir: A.graphs, dryRun: true, pruneEmpty: true });
  const afterDry = snapshot(A.graphs);
  check('1a dry-run：文件零改动', snapEq(before, afterDry) && before.size === afterDry.size, `size ${before.size}→${afterDry.size}`);
  check('1b dry-run：无备份目录', dry.backupDir === null && fs.readdirSync(A.graphs).every((n) => !n.startsWith('.migration-backup-')));
  check('1c dry-run：报告仍显示计划变更', dry.totals.filesChanged === 2 && dry.totals.streamsPruned === 1, JSON.stringify(dry.totals));
  check('1d dry-run：.md 未改名', fs.existsSync(path.join(A.graphs, 'v3.streams/40分钟计划+40.md')) && !fs.existsSync(path.join(A.graphs, 'v3.streams/分钟计划_40.md')));
  check('1e dry-run：.md 重命名计划数与正式跑口径一致（applied 计数）', dry.totals.mdRenamed === 4, String(dry.totals.mdRenamed));

  // ── 2. 正式运行 ───────────────────────────────────────────────────────
  const rep = migrateDirectory({ rootDir: A.root, graphsDir: A.graphs, dryRun: false, pruneEmpty: true });
  const v3 = findFile(rep, 'v3.se.json');
  const mf = findFile(rep, 'manifest.se.json');

  check('2a 汇总：2 文件变更', rep.totals.filesChanged === 2 && rep.totals.filesScanned === 2, JSON.stringify(rep.totals));
  check('2b 备份目录已建立且含原配置', Boolean(rep.backupDir) && fs.existsSync(path.join(rep.backupDir, 'v3.se.json')) && fs.existsSync(path.join(rep.backupDir, 'v3.streams', '40分钟计划+40.md')));

  const renames = new Map(v3.renames.map((r) => [r.id, r]));
  check('2c v3 改名：n-1→s-合法名（taken 不含自身名，未误加后缀）', renames.get('n-1')?.newId === 's-合法名' && renames.get('n-1')?.nameChanged === false, JSON.stringify(renames.get('n-1')));
  check('2d v3 改名：数字开头 + `+` → 分钟计划_40', renames.get('n-2')?.newId === 's-分钟计划_40' && renames.get('n-2')?.nameChanged === true);
  check('2e v3 改名：含空格 → 处理_B', renames.get('n-3')?.newId === 's-处理_B');
  check('2f v3 改名：重名消歧 → s-合法名_2', renames.get('n-4')?.newId === 's-合法名_2');
  check('2g v3 改名：空白有边 → s-空白有边', renames.get('n-6')?.newId === 's-空白有边' && v3.renames.length === 5, `renames=${v3.renames.length}`);

  check('2h 剪枝：空白+无边 n-5 被删', v3.prunes.length === 1 && v3.prunes[0].id === 'n-5' && v3.prunes[0].reason === 'blank', JSON.stringify(v3.prunes));
  check('2i 剪枝 guard：空白+有边 n-6 不删（.md 仍在）', fs.existsSync(path.join(A.graphs, 'v3.streams/空白有边.md')));

  const v3doc = readJsonAt(A.root, V3_REL);
  check('2j 所有 stream id 均为 s-*', v3doc.streams.every((s) => isSEStreamId(s.id)), JSON.stringify(v3doc.streams.map((s) => s.id)));
  check('2k 被剪枝流已从 streams 移除', !v3doc.streams.some((s) => s.id === 'n-5' || s.name === '空白无边'));
  check('2l name 变更流写入 original_name + description 前缀',
    streamByName(A.root, V3_REL, '分钟计划_40')?.tags?.original_name === '40分钟计划+40' &&
      streamByName(A.root, V3_REL, '分钟计划_40')?.description === '（原名：40分钟计划+40）');
  check('2m 未改名流不写 original_name', streamByName(A.root, V3_REL, '合法名')?.tags?.original_name === undefined);

  check('2n .md 改名落盘：分钟计划_40.md / 处理_B.md / 合法名_2.md',
    fs.existsSync(path.join(A.graphs, 'v3.streams/分钟计划_40.md')) &&
      fs.existsSync(path.join(A.graphs, 'v3.streams/处理_B.md')) &&
      fs.existsSync(path.join(A.graphs, 'v3.streams/合法名_2.md')) &&
      !fs.existsSync(path.join(A.graphs, 'v3.streams/40分钟计划+40.md')) &&
      !fs.existsSync(path.join(A.graphs, 'v3.streams/处理 B.md')) &&
      !fs.existsSync(path.join(A.graphs, 'v3.streams/合法名-n-4.md')));
  check('2o source.file_path 已更新为新名',
    streamByName(A.root, V3_REL, '分钟计划_40')?.source?.file_path === 'v3.streams/分钟计划_40.md' &&
      streamByName(A.root, V3_REL, '合法名_2')?.source?.file_path === 'v3.streams/合法名_2.md');
  check('2o2 报告 mdRenames.applied 与实际一致', v3.mdRenames.length === 3 && v3.mdRenames.every((m) => m.applied === true), JSON.stringify(v3.mdRenames.map((m) => m.applied)));

  const v3edges = v3doc.edges;
  check('2p v3 顶级 edges 端点全部为 s-*', v3edges.every((e) => isSEStreamId(e.source) && isSEStreamId(e.target)));
  check('2q 边改写正确（含 label）',
    v3edges.some((e) => e.source === 's-合法名' && e.target === 's-分钟计划_40') &&
      v3edges.some((e) => e.source === 's-分钟计划_40' && e.target === 's-处理_B' && e.label === 'L23') &&
      v3edges.some((e) => e.source === 's-keep' && e.target === 's-合法名' && e.label === 'Lk'));

  const s1 = streamByName(A.root, V3_REL, '合法名');
  const s2 = streamByName(A.root, V3_REL, '分钟计划_40');
  const sk = streamByName(A.root, V3_REL, 'keep');
  check('2r tags 双写：s-合法名', s1?.tags?.['edge.分钟计划_40'] === '' && s1?.tags?.['edge.空白有边'] === '');
  check('2s tags 双写：s-分钟计划_40（label 传递）', s2?.tags?.['edge.处理_B'] === 'L23');
  check('2t tags 双写：s-keep（source 未改名但 target 改写）', sk?.tags?.['edge.合法名'] === 'Lk');

  const mfdoc = readJsonAt(A.root, MANIFEST_REL);
  check('3a manifest system.graph.edges 改写',
    mfdoc.system.graph.edges.length === 1 &&
      mfdoc.system.graph.edges[0].source === 's-base' &&
      mfdoc.system.graph.edges[0].target === 's-坏_名' &&
      mfdoc.system.graph.edges[0].label === 'L');
  check('3b manifest layout re-key（旧键删除、新键写入、宽高随条目搬移）',
    mfdoc.system.graph.layout['坏_名']?.x === 2 &&
      mfdoc.system.graph.layout['坏_名']?.height === 64 &&
      mfdoc.system.graph.layout['坏 名'] === undefined &&
      mfdoc.system.graph.layout.base?.x === 1 &&
      mfdoc.system.graph.layout.base?.width === 220);
  check('3b2 manifest 旧 positions 字段被删除（v5 单一载体收口）',
    mfdoc.system.graph.positions === undefined &&
      !Object.prototype.hasOwnProperty.call(mfdoc.system.graph, 'positions'));
  check('3c manifest edge.* tag 双写', streamByName(A.root, MANIFEST_REL, 'base')?.tags?.['edge.坏_名'] === 'L');
  check('3d manifest .md 改名', fs.existsSync(path.join(A.graphs, 'manifest.streams/坏_名.md')) && !fs.existsSync(path.join(A.graphs, 'manifest.streams/坏 名.md')));
  check('3e manifest 报告 re-key 条目', mf.positionReKeys.length === 1 && mf.positionReKeys[0].from === '坏 名' && mf.positionReKeys[0].to === '坏_名');

  // ── 4. 二次运行幂等 ───────────────────────────────────────────────────
  const afterFirst = snapshot(A.graphs);
  const rep2 = migrateDirectory({ rootDir: A.root, graphsDir: A.graphs, dryRun: false, pruneEmpty: true });
  const afterSecond = snapshot(A.graphs);
  check('4a 二次运行：0 文件变更 / 无需迁移', rep2.totals.filesChanged === 0 && rep2.files.every((f) => !f.changed), JSON.stringify(rep2.totals));
  check('4b 二次运行：文件内容逐字节一致', snapEq(afterFirst, afterSecond));
  check('4c 二次运行：无 tags 追加/边修复', rep2.totals.tagsWritten === 0 && rep2.totals.edgesFixed === 0 && rep2.totals.mdRenamed === 0);
  check('4d 二次运行：未再建备份目录', rep2.backupDir === null);

  // ══════════════════════════════════════════════════════════════════════
  // 根 B：.md 改名目标已存在的碰撞 → 跳过 + file_path 调和
  // ══════════════════════════════════════════════════════════════════════
  const B = makeRoot('migrate-B-');
  writeJsonAt(B.root, 'graphs/c.se.json', {
    version: '3.0',
    system: { name: 'c' },
    streams: [
      { id: 'n-1', name: '有 空格', description: '', tags: {}, position: { x: 0, y: 0 }, source: { file_path: 'c.streams/有 空格.md', encoding: 'utf-8' } },
    ],
    edges: [],
    tools: {},
  });
  writeAt(B.root, 'graphs/c.streams/有 空格.md', 'SRC-正文');
  writeAt(B.root, 'graphs/c.streams/有_空格.md', 'TARGET-已存在，不可覆盖'); // 碰撞目标
  const repB = migrateDirectory({ rootDir: B.root, graphsDir: B.graphs, dryRun: false, pruneEmpty: true });
  const cEntry = findFile(repB, 'c.se.json');
  const cStream = streamByName(B.root, 'graphs/c.se.json', '有_空格');
  check('5a 碰撞：改名被跳过（applied=false）', cEntry.mdRenames.length === 1 && cEntry.mdRenames[0].applied === false, JSON.stringify(cEntry.mdRenames));
  check('5b 碰撞：file_path 调和为原名（不指向不存在的新名）', cStream?.source?.file_path === 'c.streams/有 空格.md', cStream?.source?.file_path);
  check('5c 碰撞：源 .md 保持、目标 .md 未被覆盖',
    fs.readFileSync(path.join(B.graphs, 'c.streams/有 空格.md'), 'utf-8') === 'SRC-正文' &&
      fs.readFileSync(path.join(B.graphs, 'c.streams/有_空格.md'), 'utf-8') === 'TARGET-已存在，不可覆盖');
  check('5d 碰撞：mdRenamed 计实际（0）', repB.totals.mdRenamed === 0);
  check('5e 碰撞：流仍完成 id/name 迁移（id=s-有_空格，original_name 保留）',
    cStream?.id === 's-有_空格' && cStream?.tags?.original_name === '有 空格');

  // ══════════════════════════════════════════════════════════════════════
  // 根 C：畸形结构（streams 元素非对象 / tags null / edges 缺失）+ reason:'no-source'
  // ══════════════════════════════════════════════════════════════════════
  const C = makeRoot('migrate-C-');
  writeJsonAt(C.root, 'graphs/m.se.json', {
    version: '3.0',
    system: { name: 'm' },
    streams: [
      null,
      'garbage-string',
      { id: 'n-1', name: '无源无叶' }, // 无 source → reason:'no-source'
      { id: 'n-2', name: '空tags', tags: null, position: { x: 0, y: 0 }, source: { file_path: 'm.streams/空tags.md', encoding: 'utf-8' } },
      { id: 'n-3', name: '缺tags字段', position: { x: 1, y: 1 }, source: { file_path: 'm.streams/缺tags.md', encoding: 'utf-8' } },
    ],
    edges: [{ source: 'n-2', target: 'n-3', label: '' }],
    tools: {},
  });
  writeAt(C.root, 'graphs/m.streams/空tags.md', '空tags 正文');
  writeAt(C.root, 'graphs/m.streams/缺tags.md', '缺tags 正文');
  writeJsonAt(C.root, 'graphs/m2.se.json', {
    version: '3.0',
    system: { name: 'm2' },
    streams: 'not-an-array',
    edges: 'not-an-array',
    tools: {},
  });
  let repC;
  let crashed = false;
  try {
    repC = migrateDirectory({ rootDir: C.root, graphsDir: C.graphs, dryRun: false, pruneEmpty: true });
  } catch (err) {
    crashed = true;
    check('6x 畸形结构未崩溃', false, String(err && err.stack ? err.stack : err));
  }
  if (!crashed) {
    const mEntry = findFile(repC, 'm.se.json');
    const m2Entry = findFile(repC, 'm2.se.json');
    const mDoc = readJsonAt(C.root, 'graphs/m.se.json');
    check('6a no-source：无 source 流被剪枝且 reason=no-source',
      mEntry.prunes.length === 1 && mEntry.prunes[0].id === 'n-1' && mEntry.prunes[0].reason === 'no-source',
      JSON.stringify(mEntry.prunes));
    check('6b 畸形：streams 非对象元素被跳过而非崩溃（null 与字符串仍在）',
      mDoc.streams.some((s) => s === null) && mDoc.streams.some((s) => s === 'garbage-string'));
    check('6c 畸形：tags:null 流可迁移且 repairEdges 建 tags 对象',
      streamByName(C.root, 'graphs/m.se.json', '空tags')?.tags?.['edge.缺tags字段'] === '');
    check('6d 畸形：合法名流全部迁移为 s-*',
      streamByName(C.root, 'graphs/m.se.json', '空tags')?.id === 's-空tags' &&
        streamByName(C.root, 'graphs/m.se.json', '缺tags字段')?.id === 's-缺tags字段');
    check('6e 畸形：streams 非数组顶层文件未崩溃且无变更', Boolean(m2Entry) && m2Entry.changed === false);
  }

  // ══════════════════════════════════════════════════════════════════════
  // 根 D：pruneEmpty 开关
  // ══════════════════════════════════════════════════════════════════════
  const D = makeRoot('migrate-D-');
  const buildD = () => {
    rmrf(path.join(D.graphs, 'p.se.json'));
    rmrf(path.join(D.graphs, 'p.streams'));
    writeJsonAt(D.root, 'graphs/p.se.json', {
      version: '3.0',
      system: { name: 'p' },
      streams: [
        { id: 'n-1', name: '空白节点', description: '', tags: {}, position: { x: 0, y: 0 }, source: { file_path: 'p.streams/空白节点.md', encoding: 'utf-8' } },
      ],
      edges: [],
      tools: {},
    });
    writeAt(D.root, 'graphs/p.streams/空白节点.md', '');
  };
  buildD();
  const dOn = migrateDirectory({ rootDir: D.root, graphsDir: D.graphs, dryRun: true, pruneEmpty: true });
  check('7a pruneEmpty=true：空白+无边被剪枝', findFile(dOn, 'p.se.json').prunes.length === 1 && dOn.totals.streamsPruned === 1);
  buildD();
  const dOff = migrateDirectory({ rootDir: D.root, graphsDir: D.graphs, dryRun: true, pruneEmpty: false });
  check('7b pruneEmpty=false：空白+无边不剪枝（迁移）', findFile(dOff, 'p.se.json').prunes.length === 0 && findFile(dOff, 'p.se.json').renames.length === 1);
  buildD();
  const dOffReal = migrateDirectory({ rootDir: D.root, graphsDir: D.graphs, dryRun: false, pruneEmpty: false });
  check('7c pruneEmpty=false 正式跑：流保留为 s-空白节点', Boolean(streamByName(D.root, 'graphs/p.se.json', '空白节点')) && dOffReal.totals.streamsPruned === 0);

  // ══════════════════════════════════════════════════════════════════════
  // 根 E：平行边（同 source→target 不同 label）确定性 + 既存 tag 冲突
  // ══════════════════════════════════════════════════════════════════════
  const E = makeRoot('migrate-E-');
  writeJsonAt(E.root, 'graphs/pe.se.json', {
    version: '3.0',
    system: { name: 'pe' },
    streams: [
      { id: 's-a', name: 'a', description: '', tags: {}, position: { x: 0, y: 0 }, source: { file_path: 'pe.streams/a.md', encoding: 'utf-8' } },
      { id: 's-c', name: 'c', description: '', tags: { 'edge.d': 'OLD' }, position: { x: 1, y: 1 }, source: { file_path: 'pe.streams/c.md', encoding: 'utf-8' } },
      { id: 'n-1', name: 'b', description: '', tags: {}, position: { x: 2, y: 2 }, source: { file_path: 'pe.streams/b.md', encoding: 'utf-8' } },
      { id: 'n-2', name: 'd', description: '', tags: {}, position: { x: 3, y: 3 }, source: { file_path: 'pe.streams/d.md', encoding: 'utf-8' } },
    ],
    edges: [
      { source: 's-a', target: 'n-1', label: 'L1' },
      { source: 's-a', target: 'n-1', label: 'L2' },
      { source: 's-c', target: 'n-2', label: 'NEW' },
    ],
    tools: {},
  });
  writeAt(E.root, 'graphs/pe.streams/a.md', 'a');
  writeAt(E.root, 'graphs/pe.streams/c.md', 'c');
  writeAt(E.root, 'graphs/pe.streams/b.md', 'b');
  writeAt(E.root, 'graphs/pe.streams/d.md', 'd');
  const repE = migrateDirectory({ rootDir: E.root, graphsDir: E.graphs, dryRun: false, pruneEmpty: true });
  const eEntry = findFile(repE, 'pe.se.json');
  const aStream = streamByName(E.root, 'graphs/pe.se.json', 'a');
  const cStreamE = streamByName(E.root, 'graphs/pe.se.json', 'c');
  check('8a 平行边：三条边都被改写（edgeFixes=3，含平行 2 条）', eEntry.edgeFixes.length === 3, String(eEntry.edgeFixes.length));
  check('8b 平行边：同键仅写一次（tagWrites=1，保留先见值 L1）',
    eEntry.tagWrites.length === 1 && eEntry.tagWrites[0].value === 'L1' && aStream.tags['edge.b'] === 'L1',
    JSON.stringify({ w: eEntry.tagWrites, tags: aStream.tags }));
  check('8c 平行边：冲突计数 2（平行边 1 + 既存值 1）', eEntry.tagConflicts.length === 2, JSON.stringify(eEntry.tagConflicts));
  check('8d 既存 tag 不同值：保留既有（OLD），不覆盖', cStreamE.tags['edge.d'] === 'OLD');
  check('8e tags 计数与实际写入一致', repE.totals.tagsWritten === eEntry.tagWrites.length && repE.totals.tagConflicts === eEntry.tagConflicts.length);
  const repE2 = migrateDirectory({ rootDir: E.root, graphsDir: E.graphs, dryRun: false, pruneEmpty: true });
  check('8f 平行边二次运行幂等', repE2.totals.filesChanged === 0 && repE2.totals.tagsWritten === 0);

  // ══════════════════════════════════════════════════════════════════════
  // 9. edgeRemovals 白盒：端点被剪枝 → 边删除
  // ══════════════════════════════════════════════════════════════════════
  {
    const kx = { id: 's-x', name: 'x', tags: {} };
    const kz = { id: 's-z', name: 'z', tags: {} };
    const idToStream = new Map([['s-x', kx], ['s-z', kz]]);
    const edges = [
      { source: 's-x', target: 's-y', label: '' }, // s-y 被剪枝 → 删
      { source: 's-x', target: 's-z', label: '' }, // 保留（无端点改写 → 不处理）
    ];
    const r = repairEdges({ allEdges: edges, edgeArrays: [edges], idMap: new Map(), removedIds: new Set(['s-y']), idToStream });
    check('9a edgeRemovals：端点命中 removedIds 的边被收集', r.edgeRemovals.length === 1 && r.edgeRemovals[0].target === 's-y', JSON.stringify(r.edgeRemovals));
    check('9b edgeRemovals：边已从数组删除', edges.length === 1 && edges[0].target === 's-z');
    check('9c edgeRemovals：不触发 tags/edgeFixes', r.tagWrites.length === 0 && r.edgeFixes.length === 0);

    const edges2 = [{ source: 's-p', target: 's-q', label: 'e' }];
    const r2 = repairEdges({ allEdges: edges2, edgeArrays: [edges2], idMap: new Map(), removedIds: new Set(['s-p', 's-q']), idToStream: new Map() });
    check('9d edgeRemovals：两端被剪枝仅记一次', r2.edgeRemovals.length === 1 && edges2.length === 0);
  }
} catch (err) {
  check('单测执行', false, err && err.stack ? err.stack : String(err));
} finally {
  for (const r of ROOTS) {
    try {
      rmrf(r);
    } catch {
      /* ignore */
    }
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
