// 期 7 SE 运行数据重置（SE中文名同步改造方案 §6.8）。
//
// 背景：SE 的 journal/scan 游标文件名 = `base64url(流名)-sha1[:12]`，snapshot 以**流名为键**，
// journal 首行含 `base_version` 并参与对账。手改脆弱（等同重写 SE 的 stream.rename）。
// 决策（D5，用户拍板）：SE 当前未运行 ⇒ **文件级纠正**——修正 `graphs/`（migrate-names-to-cjk）
// 后，重置受影响系统的运行数据；下次 app 启动时 SE 为空 → `migrateLocalContentIfEmpty`
// 自动把修正后的本地图（中文名）回灌。等价于「用修正后的 graphs 重建 SE」。
//
// 删除范围：`snapshots/`、`journal/`、`scan/`。**保留**：`.se-token`/`.owner.json`/`registry/`/
// `control/`（凭据、端口注册、控制面受限态——不随流名变化）。
//
// 纯 Node、**默认 dry-run**；执行须显式 `--apply`。
//
// 用法：
//   node scripts/reset-se-storage.mjs                 # 预演（读 graphs/.workspace.json 绑定系统）
//   node scripts/reset-se-storage.mjs --all           # 预演全部 se-systems/*
//   node scripts/reset-se-storage.mjs --system AI --system SE --apply
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeRecursiveWithRetry } from '../server/resilientFs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SE_ROOT = path.join(ROOT, 'se-systems');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ALL = args.includes('--all');
const systemArgs = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--system' && args[i + 1]) systemArgs.push(args[i + 1]);
}

/** 从 workspace 读绑定系统的 storage_dir 末段（system_id）。 */
function boundSystems() {
  try {
    const ws = JSON.parse(fs.readFileSync(path.join(ROOT, 'graphs', '.workspace.json'), 'utf8'));
    return (Array.isArray(ws.tabs) ? ws.tabs : [])
      .map((t) => (t && t.system && t.system.storage_dir ? String(t.system.storage_dir) : ''))
      .map((d) => d.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '')
      .filter(Boolean);
  } catch (err) {
    return [];
  }
}

const DELETE_ENTRIES = ['snapshots', 'journal', 'scan'];

function main() {
  if (!fs.existsSync(SE_ROOT)) {
    console.error(`目录不存在：${SE_ROOT}`);
    process.exit(1);
  }
  const available = fs.readdirSync(SE_ROOT).filter((n) => fs.statSync(path.join(SE_ROOT, n)).isDirectory());
  let targets;
  if (ALL) targets = available;
  else if (systemArgs.length) targets = systemArgs;
  else targets = boundSystems();

  if (!targets.length) {
    console.log('未指定系统：用 --all 或 --system <id>（或让 graphs/.workspace.json 有绑定）。');
    return;
  }
  console.log(`se-systems/ 现有：${available.join(', ')}`);
  console.log(`目标系统：${targets.join(', ')}${APPLY ? '（应用）' : '（预演）'}\n`);

  let removed = 0;
  const failures = [];
  for (const id of targets) {
    const dir = path.join(SE_ROOT, id);
    if (!fs.existsSync(dir)) {
      console.log(`跳过（不存在）：${id}`);
      continue;
    }
    const hits = DELETE_ENTRIES.filter((e) => fs.existsSync(path.join(dir, e)));
    if (!hits.length) {
      console.log(`${id}：无运行数据（已空）`);
      continue;
    }
    for (const e of hits) {
      const abs = path.join(dir, e);
      console.log(`${id}：删除 ${e}/`);
      if (APPLY) {
        try {
          removeRecursiveWithRetry(abs, { recursive: true, cmdFallback: true });
        } catch (err) {
          console.error(`删除失败 ${abs}：${(err && err.message) || err}`);
        }
        if (fs.existsSync(abs)) {
          failures.push(abs);
          console.error(`残留 ${abs}`);
          continue;
        }
      }
      removed += 1;
    }
  }
  console.log(`\n==== ${APPLY ? '已重置' : '预演'} ${removed} 个目录 ====`);
  if (failures.length) {
    console.error(`FAIL：${failures.length} 个目录删除后仍残留`);
    for (const p of failures) console.error(`  ${p}`);
    process.exitCode = 1;
    return;
  }
  if (!APPLY && removed) console.log('（dry-run；加 --apply 执行删除）');
  console.log('提示：下次启动 app 时，空 SE 将由修正后的 graphs 自动回灌中文流。');
}

main();
