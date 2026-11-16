#!/usr/bin/env node
// Rewrite user-home absolute tool paths in graphs/*.se.json to portable,
// home-relative form (e.g. C:/Users/alice/OneDrive/... -> ../../../...).
// Default is dry-run; pass --apply to write, --check to fail if changes remain.
// External absolute paths (other drives / non-home trees) are preserved.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GRAPHS_DIR = path.join(ROOT, 'graphs');
const APPLY = process.argv.includes('--apply');
const CHECK = process.argv.includes('--check');
const TOOL_PATH_KEYS = ['tool_path', 'execution_path', 'manual_path'];

function toPosix(value) {
  return String(value == null ? '' : value).replace(/\\/g, '/');
}

function userHomeParts(value) {
  const posix = toPosix(value).trim();
  const match = /^([A-Za-z]:)\/Users\/[^/]+\/(.*)$/.exec(posix);
  if (!match) return null;
  return { drive: match[1].toLowerCase(), rest: match[2] };
}

function portableValue(value, baseAbs) {
  if (typeof value !== 'string' || !value.trim()) return { value, changed: false };
  const target = userHomeParts(value);
  const base = userHomeParts(path.resolve(baseAbs));
  if (!target || !base || target.drive !== base.drive) {
    return { value, changed: false };
  }
  const targetSegments = target.rest.split('/').filter(Boolean);
  const baseSegments = base.rest.split('/').filter(Boolean);
  if (!targetSegments.length || !baseSegments.length) {
    return { value, changed: false };
  }
  if (targetSegments[0].toLowerCase() !== baseSegments[0].toLowerCase()) {
    return { value, changed: false, warning: 'different home sub-tree' };
  }
  const relative = path.posix.relative(baseSegments.join('/'), targetSegments.join('/'));
  return { value: relative || '.', changed: relative !== toPosix(value).trim() };
}

function main() {
  if (!fs.existsSync(GRAPHS_DIR)) {
    console.error(`graphs directory not found: ${GRAPHS_DIR}`);
    process.exit(1);
  }
  let changedFiles = 0;
  let changedPaths = 0;
  const warnings = [];
  const files = fs.readdirSync(GRAPHS_DIR).filter((name) => name.endsWith('.se.json'));

  for (const name of files) {
    const file = path.join(GRAPHS_DIR, name);
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (err) {
      warnings.push(`${name}: invalid JSON (${err && err.message ? err.message : err})`);
      continue;
    }
    const tools = doc && typeof doc.tools === 'object' ? doc.tools : null;
    if (!tools) continue;
    const entries = Array.isArray(tools)
      ? tools.map((def, index) => [def && def.name ? String(def.name) : `#${index}`, def])
      : Object.entries(tools);

    let fileChanged = false;
    for (const [toolName, def] of entries) {
      if (!def || typeof def !== 'object') continue;
      for (const key of TOOL_PATH_KEYS) {
        const before = def[key];
        const result = portableValue(before, GRAPHS_DIR);
        if (result.warning) {
          warnings.push(`${name} :: ${toolName}.${key}: ${result.warning}: ${before}`);
        }
        if (!result.changed) continue;
        def[key] = result.value;
        fileChanged = true;
        changedPaths += 1;
        console.log(`${APPLY ? 'FIX' : 'WOULD FIX'} ${name} :: ${toolName}.${key}: ${before} -> ${result.value}`);
      }
    }
    if (fileChanged) {
      changedFiles += 1;
      if (APPLY) {
        fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf-8');
      }
    }
  }

  for (const warning of warnings) console.warn(`WARN ${warning}`);
  console.log(
    `${APPLY ? 'Applied' : 'Dry-run'}: ${changedFiles} file(s), ${changedPaths} path(s) ${APPLY ? 'rewritten' : 'would change'}.`
  );
  if (CHECK && changedPaths > 0) process.exitCode = 1;
}

main();
