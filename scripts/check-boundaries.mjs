// Dependency-direction gate. This file is dev/test tooling; runtime must not import it.
//
// Allowed DAG:
//   src  ──▶ shared ◀── server ◀── scripts (dev/test only)
//
// - shared/ is isomorphic: no node:*, process.env, process.platform, or imports
//   into src/server/scripts.
// - server/ may not import src/ or scripts/.
// - src/ may not import server/ or scripts/ or node:*.
// - scripts/ is unrestricted (development, tests, operator CLIs).
//
// The allowlist is a ratchet: it may only shrink. A violation that is no longer
// present must be removed from the allowlist, otherwise the check fails stale.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['src', 'server', 'shared', 'scripts'];
const SOURCE_RE = /\.(?:js|mjs|jsx)$/;

// Legacy violations that are being removed phase by phase. Do not add entries.
const ALLOWLIST = new Set([]);

const IMPORT_RES = [
  /\bimport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bexport\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE_RE.test(entry.name)) out.push(full);
  }
  return out;
}

function layerOf(rel) {
  const top = rel.split('/')[0];
  return ['src', 'server', 'shared', 'scripts'].includes(top) ? top : 'root';
}

function resolveSpecifier(file, spec) {
  if (spec.startsWith('node:')) return { kind: 'node', target: spec };
  if (!spec.startsWith('.')) return { kind: 'package', target: spec };
  const base = path.resolve(path.dirname(file), spec);
  const candidates = [base];
  if (!SOURCE_RE.test(base)) {
    for (const ext of ['.js', '.mjs', '.jsx']) candidates.push(`${base}${ext}`);
    for (const ext of ['.js', '.mjs', '.jsx']) candidates.push(path.join(base, `index${ext}`));
  }
  const found = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!found) return { kind: 'relative', target: null };
  return { kind: 'relative', target: path.relative(ROOT, found).replace(/\\/g, '/') };
}

function violationsFor(file) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const layer = layerOf(rel);
  const text = fs.readFileSync(file, 'utf-8');
  const out = [];
  const specs = new Set();
  for (const re of IMPORT_RES) {
    for (const match of text.matchAll(re)) specs.add(match[1]);
  }
  for (const spec of specs) {
    const resolved = resolveSpecifier(file, spec);
    const record = `${rel} -> ${spec}`;
    if (resolved.kind === 'node') {
      if (layer === 'shared' || layer === 'src') out.push(record);
      continue;
    }
    if (resolved.kind !== 'relative' || !resolved.target) continue;
    const targetLayer = layerOf(resolved.target);
    if (layer === 'shared' && ['src', 'server', 'scripts'].includes(targetLayer)) out.push(record);
    if (layer === 'server' && ['src', 'scripts'].includes(targetLayer)) out.push(record);
    if (layer === 'src' && ['server', 'scripts'].includes(targetLayer)) out.push(record);
  }
  if (layer === 'shared') {
    if (/\bprocess\.env\b/.test(text)) out.push(`${rel} uses process.env`);
    if (/\bprocess\.platform\b/.test(text)) out.push(`${rel} uses process.platform`);
  }
  return out;
}

const files = SCAN_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)));
const found = new Set();
for (const file of files) {
  for (const violation of violationsFor(file)) found.add(violation);
}

const unexpected = [...found].filter((v) => !ALLOWLIST.has(v)).sort();
const stale = [...ALLOWLIST].filter((v) => !found.has(v)).sort();

if (unexpected.length) {
  console.error('New boundary violations (not in allowlist):');
  for (const violation of unexpected) console.error(`  ${violation}`);
}
if (stale.length) {
  console.error('Stale allowlist entries (violation removed; shrink the ratchet):');
  for (const violation of stale) console.error(`  ${violation}`);
}
if (!unexpected.length && !stale.length) {
  console.log(`boundary check: OK (${found.size} legacy violation(s) still allowlisted)`);
  process.exit(0);
}
process.exit(1);
