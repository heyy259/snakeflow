// 纯 Node 单测：配置包落盘（服务端 applyPackagePlan）+ 已打包工具再导出不复制。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyPackagePlan } from '../server/packageApply.js';
import { planToolBundles } from '../src/se/packageBundle.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'se-pkg-apply-'));
try {
  const srcTools = path.join(root, 'src', 'tools');
  fs.mkdirSync(path.join(srcTools, '__pycache__'), { recursive: true });
  fs.writeFileSync(path.join(srcTools, 't.py'), 'print("ok")\n', 'utf-8');
  fs.writeFileSync(path.join(srcTools, 'data.csv'), 'a,b\n1,2\n', 'utf-8');
  fs.writeFileSync(path.join(srcTools, '__pycache__', 't.pyc'), 'junk', 'utf-8');

  const pkg = path.join(root, 'pkg');
  const manifestPath = path.join(pkg, 'demo.se.json');
  const streamPath = path.join(pkg, 'demo.streams', 's.md');
  const toolTarget = path.join(pkg, 'tools', 'demo');

  const result = applyPackagePlan({
    files: [{ path: streamPath, text: 'hello' }],
    copies: [{ from: srcTools, to: toolTarget, unit: 'dir' }],
    manifest: { path: manifestPath, text: '{"$schema":"snake-manifest-v1"}' },
    options: { overwrite: true },
  });

  assert.equal(fs.readFileSync(streamPath, 'utf-8'), 'hello');
  assert.equal(fs.readFileSync(path.join(toolTarget, 't.py'), 'utf-8'), 'print("ok")\n');
  assert.equal(fs.readFileSync(path.join(toolTarget, 'data.csv'), 'utf-8'), 'a,b\n1,2\n');
  assert.equal(fs.existsSync(path.join(toolTarget, '__pycache__')), false, '缓存目录应被排除');
  assert.equal(fs.readFileSync(manifestPath, 'utf-8'), '{"$schema":"snake-manifest-v1"}');
  assert.ok(result.written.includes(manifestPath));
  assert.ok(result.copied.includes(toolTarget));

  // 已打包的工具再导出：保持相对、不复制（避免把包复制进自己）。
  const again = planToolBundles({
    baseDir: pkg,
    mode: 'dir',
    tools: [{ name: 'demo', tool_path: 'tools/demo/t.py', execution_path: 'tools/demo' }],
  });
  assert.equal(again.rewrites.demo.tool_path, 'tools/demo/t.py');
  assert.equal(again.rewrites.demo.execution_path, 'tools/demo');
  assert.equal(again.copies.length, 0);

  // 上限守卫：超文件数直接拒绝。
  assert.throws(
    () =>
      applyPackagePlan({
        files: [],
        copies: [{ from: srcTools, to: path.join(pkg, 'tools', 'too-many'), unit: 'dir' }],
        manifest: { path: path.join(pkg, 'too-many.se.json'), text: '{}' },
        options: { overwrite: true, maxFiles: 1 },
      }),
    (err) => err && err.code === 'EPLANLIMIT'
  );

  console.log('smoke-package-apply-unit: OK');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
