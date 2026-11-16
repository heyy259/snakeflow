// 纯 Node 单测：工具复刻计划 planToolBundles + buildPackage(toolRewrites)。
// 契约：基准 = manifest 目录（绝对）；导出包禁止 `..`；dir 默认镜像执行目录；
// 同执行根多工具去重；execution_path 指向包目录/其上级时降级为 file。
import assert from 'node:assert/strict';
import { planToolBundles } from '../src/se/packageBundle.js';
import { buildPackage } from '../src/se/packageExport.js';

const BASE = 'C:/pkgs/demo';

// ── 1. dir（默认）：镜像执行目录 ─────────────────────────────────────────
{
  const plan = planToolBundles({
    baseDir: BASE,
    mode: 'dir',
    tools: [
      {
        name: 'alpha',
        description: 'd',
        tool_path: 'C:/proj/opencode_tools/oc.py',
        execution_path: 'C:/proj/opencode_tools',
      },
    ],
  });
  assert.deepEqual(plan.rewrites.alpha, {
    tool_path: 'tools/alpha/oc.py',
    execution_path: 'tools/alpha',
  });
  assert.deepEqual(plan.copies, [
    { from: 'C:/proj/opencode_tools', to: 'tools/alpha', unit: 'dir' },
  ]);
  assert.equal(plan.externals.length, 0);
}

// ── 2. 共享执行根：两个工具只复制一份 ───────────────────────────────────
{
  const plan = planToolBundles({
    baseDir: BASE,
    mode: 'dir',
    tools: [
      { name: 'a', tool_path: 'C:/proj/tools/a.py', execution_path: 'C:/proj/tools' },
      { name: 'b', tool_path: 'C:/proj/tools/b.py', execution_path: 'C:/proj/tools' },
    ],
  });
  // 排序后 a 先占 tools/a；b 复用同一 target。
  assert.equal(plan.rewrites.a.tool_path, 'tools/a/a.py');
  assert.equal(plan.rewrites.b.tool_path, 'tools/a/b.py');
  assert.equal(plan.copies.length, 1);
  assert.equal(plan.copies[0].to, 'tools/a');
}

// ── 3. file：仅脚本；同目录时 execution_path = 目标目录 ─────────────────
{
  const plan = planToolBundles({
    baseDir: BASE,
    mode: 'file',
    tools: [
      { name: 'alpha', tool_path: 'C:/proj/tools/a.py', execution_path: 'C:/proj/tools' },
    ],
  });
  assert.deepEqual(plan.rewrites.alpha, {
    tool_path: 'tools/alpha/a.py',
    execution_path: 'tools/alpha',
  });
  assert.deepEqual(plan.copies, [
    { from: 'C:/proj/tools/a.py', to: 'tools/alpha/a.py', unit: 'file' },
  ]);
}

// ── 4. external：不复制，保留绝对（不写 `..`） ─────────────────────────
{
  const plan = planToolBundles({
    baseDir: BASE,
    mode: 'external',
    tools: [
      { name: 'alpha', tool_path: 'C:/proj/tools/a.py', execution_path: 'C:/proj/tools' },
    ],
  });
  assert.equal(plan.rewrites.alpha.tool_path, 'C:/proj/tools/a.py');
  assert.equal(plan.rewrites.alpha.execution_path, 'C:/proj/tools');
  assert.equal(plan.copies.length, 0);
  assert.equal(plan.externals.length, 1);
}

// ── 5. 守卫：execution_path 指向包目录 → 降级 file ─────────────────────
{
  const plan = planToolBundles({
    baseDir: BASE,
    mode: 'dir',
    tools: [
      { name: 'alpha', tool_path: 'C:/proj/tools/a.py', execution_path: 'C:/pkgs/demo' },
    ],
  });
  assert.equal(plan.rewrites.alpha.tool_path, 'tools/alpha/a.py');
  assert.equal(plan.copies[0].unit, 'file');
  assert.ok(plan.warnings.some((w) => w.includes('禁止整体镜像')), plan.warnings.join('|'));
}

// ── 6. 包内相对路径：导出时保持相对，不复制 ─────────────────────────────
{
  const plan = planToolBundles({
    baseDir: BASE,
    mode: 'dir',
    tools: [{ name: 'alpha', tool_path: 'tools/alpha/a.py', execution_path: 'tools/alpha' }],
  });
  assert.equal(plan.rewrites.alpha.tool_path, 'tools/alpha/a.py');
  // 相对值无法确定绝对执行根 → 不应盲目复制（source 不可知）。
  assert.equal(plan.copies.length, 0);
}

// ── 7. buildPackage 使用 rewrites + copies（manifest 最后） ─────────────
{
  const bundle = planToolBundles({
    baseDir: BASE,
    mode: 'dir',
    tools: [
      { name: 'alpha', description: 'd', tool_path: 'C:/proj/tools/a.py', execution_path: 'C:/proj/tools' },
    ],
  });
  const built = buildPackage({
    displayName: 'demo',
    streams: [{ name: 's', description: '', tags: {}, content: 'x' }],
    tools: [
      { name: 'alpha', description: 'd', tool_path: 'C:/proj/tools/a.py', execution_path: 'C:/proj/tools' },
    ],
    baseDir: BASE,
    toolRewrites: bundle.rewrites,
    copies: bundle.copies,
  });
  assert.equal(built.manifest.tools.alpha.tool_path, 'tools/alpha/a.py');
  assert.equal(built.manifest.tools.alpha.execution_path, 'tools/alpha');
  assert.equal(built.copies.length, 1);
  assert.equal(built.files[built.files.length - 1].relPath, 'demo.se.json');
  assert.ok(!built.files.some((f) => f.relPath.includes('tools/alpha/a.py')), '工具文件由 copies 负责');
}

console.log('smoke-package-bundle-unit: OK');
