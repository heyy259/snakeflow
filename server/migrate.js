import fs from 'node:fs';
import path from 'node:path';

function copyEntry(from, to) {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    if (!fs.existsSync(to)) fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) {
      copyEntry(path.join(from, entry), path.join(to, entry));
    }
    return;
  }
  if (!fs.existsSync(to)) fs.copyFileSync(from, to);
}

function copyDirContents(source, target) {
  let copied = false;
  try {
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) return false;
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      const from = path.join(source, entry.name);
      const to = path.join(target, entry.name);
      try {
        copyEntry(from, to);
        copied = true;
      } catch (err) {
        console.warn(`[migrate] skip ${from}: ${err && err.message ? err.message : err}`);
      }
    }
  } catch (err) {
    console.warn(`[migrate] unable to copy ${source}: ${err && err.message ? err.message : err}`);
  }
  return copied;
}

export function migrateLegacyLayout(paths) {
  if (paths.mode !== 'installed') return { migrated: false };
  const copied = [];
  if (copyDirContents(path.join(paths.appRoot, 'graphs'), paths.workspaceRoot)) copied.push('graphs');
  if (copyDirContents(path.join(paths.appRoot, 'flows'), paths.workspaceRoot)) copied.push('flows');
  if (copyDirContents(path.join(paths.appRoot, 'se-systems'), paths.seSystemsDir)) copied.push('se-systems');
  if (!copied.length) return { migrated: false };
  fs.mkdirSync(paths.dataRoot, { recursive: true });
  const record = { at: new Date().toISOString(), copied, sourceAppRoot: paths.appRoot };
  fs.writeFileSync(path.join(paths.dataRoot, 'migration.json'), JSON.stringify(record, null, 2));
  return { migrated: true, copied };
}
