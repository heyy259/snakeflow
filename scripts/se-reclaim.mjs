// 期 5 SE 遗留回收（独立脚本，未接入 .bat / npm script）。
// 仅回收 E2 可验证的己方 owner；无 owner、旧 owner 不可验证、PID 复用、端口不符一律跳过。
//
// 运行：node scripts/se-reclaim.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyOwnedOrphan } from '../server/se/instanceIdentity.js';
import { killSameProcess } from '../server/se/process.js';
import { removeSeRegistryEntry } from '../server/se/registry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SYSTEMS_DIR = path.join(ROOT, 'se-systems');
const OWNER_NAME = '.owner.json';

function readOwner(systemId) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(SYSTEMS_DIR, systemId, OWNER_NAME), 'utf-8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch (err) {
    return null;
  }
}

function main() {
  let names = [];
  try {
    names = fs
      .readdirSync(SYSTEMS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    console.log(`se-reclaim: 无 se-systems 目录（${SYSTEMS_DIR}），跳过。`);
    return;
  }

  let scanned = 0;
  let noOwner = 0;
  let skipped = 0;
  let reclaimed = 0;

  for (const systemId of names) {
    const ownerPath = path.join(SYSTEMS_DIR, systemId, OWNER_NAME);
    if (!fs.existsSync(ownerPath)) {
      noOwner += 1;
      continue;
    }
    scanned += 1;
    const owner = readOwner(systemId);
    if (!owner) {
      noOwner += 1;
      continue;
    }
    const verified = verifyOwnedOrphan({
      owner,
      expectedPort: Number(owner.port),
      currentVitePid: process.pid,
    });
    if (!verified.ok) {
      skipped += 1;
      console.log(
        `SKIP   ${systemId}: ${verified.status}/${verified.reason || 'unverified'}（未杀、未清账）`
      );
      continue;
    }
    if (!killSameProcess(systemId, verified.pid, verified.startedAt)) {
      skipped += 1;
      console.log(`SKIP   ${systemId}: same-process kill 未确认`);
      continue;
    }
    removeSeRegistryEntry(systemId);
    reclaimed += 1;
    console.log(
      `RECLAIM ${systemId}: 已杀已验证遗留 snakeeats pid ${verified.pid}（端口 ${owner.port}）`
    );
  }

  console.log(
    `\nse-reclaim 汇总：扫描 owner 文件 ${scanned}，回收 ${reclaimed}，` +
      `跳过 ${skipped}，无 owner ${noOwner}。`
  );
}

main();
