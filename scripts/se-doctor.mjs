// SE 运行时只读诊断 CLI：定位配置 → 解析运行时 → 打印结果与可粘贴配置模板。
// 不写文件、不改状态、不启动 SE（probe 只跑 `import`/`serve --help`）。退出码：可用 0，不可用 1。
import path from 'node:path';
import { projectRoot, seSystemsDir } from '../server/paths.js';
import {
  loadSeConfig,
  resolveSeConfigPath,
  resolveSeRuntime,
} from '../server/se/runtime/seRuntime.js';

function oneDriveWarning() {
  const isOnOneDrive = (target) => {
    const normalized = path.resolve(String(target || '')).replace(/\//g, '\\');
    if (/\\onedrive\\/i.test(normalized)) return true;
    for (const key of ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer']) {
      const root = String(process.env[key] || '').trim();
      if (!root) continue;
      const base = path.resolve(root).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
      const folded = normalized.toLowerCase();
      if (folded === base || folded.startsWith(`${base}\\`)) return true;
    }
    return false;
  };
  const hits = [];
  if (isOnOneDrive(projectRoot)) hits.push(`projectRoot=${projectRoot}`);
  if (isOnOneDrive(seSystemsDir)) hits.push(`se-systems=${seSystemsDir}`);
  return hits.length ? hits : null;
}

async function printConfigSection() {
  console.log('== 配置 ==');
  let configPath = '(无法定位)';
  try {
    configPath = resolveSeConfigPath({});
  } catch (err) {
    configPath = `(无法定位：${err && err.message ? err.message : String(err)})`;
  }
  console.log(`配置文件：${configPath}`);
  const loaded = await loadSeConfig({});
  console.log(`  存在：${loaded.exists ? '是' : '否'}`);
  if (loaded.path && loaded.path !== configPath) console.log(`  实际解析路径：${loaded.path}`);
  if (!loaded.ok) console.log(`  解析错误：${loaded.reason}`);
  return loaded;
}

function printRuntimeSection(runtime) {
  console.log('== 运行时 ==');
  console.log(`结果：${runtime.ok ? 'OK' : 'UNAVAILABLE'}`);
  if (!runtime.ok) {
    console.log(`原因：${runtime.reason}`);
    console.log(`python：${runtime.python || '(未解析)'}（来源：${runtime.sources.python}）`);
    console.log(`packageParent：${runtime.packageParent || '(未解析)'}（来源：${runtime.sources.packageParent}）`);
    console.log('提示：修复上面的原因后重新运行；显式值无效时不会自动回退（置空或改为 "auto" 可启用自动探测）。');
    return;
  }
  console.log(`mode：${runtime.mode || 'auto'}`);
  console.log(`python：${runtime.python}（来源：${runtime.sources.python}）`);
  console.log(`packageParent：${runtime.packageParent || '(pip)'}（来源：${runtime.sources.packageParent}）`);
  console.log(`探测：${runtime.probe.reason}`);
  if (runtime.probe.version) console.log(`SnakeEats 版本：${runtime.probe.version}`);
  if (runtime.probe.pythonVersion) console.log(`Python 版本：${runtime.probe.pythonVersion}`);
  if (runtime.probe.moduleFile) console.log(`模块文件：${runtime.probe.moduleFile}`);
}

function printPasteSection(runtime) {
  console.log('== 可粘贴配置（app.config.json 或 SE_CONFIG 指向的文件）==');
  const template = {
    schemaVersion: 2,
    mode: runtime.mode || 'auto',
    python: runtime.python || 'auto',
    packagePath: runtime.packageParent || '',
    versionRange: runtime.versionRange || '>=0.1.0 <0.2.0',
  };
  console.log(JSON.stringify(template, null, 2));
  console.log('注意：上述绝对路径与机器相关，迁移到另一台机器时请改用相对路径或重新运行本诊断。');
}

try {
  console.log('SE 运行时诊断（只读）');
  console.log(`项目根：${projectRoot}`);
  console.log('');

  await printConfigSection();
  console.log('');

  const runtime = await resolveSeRuntime({ projectRoot });
  printRuntimeSection(runtime);
  console.log('');

  console.log('== 存储 ==');
  console.log(`se-systems：${seSystemsDir}`);
  const oneDrive = oneDriveWarning();
  if (oneDrive) {
    console.log(`WARNING: storage on OneDrive: single-writer lock is same-machine only（${oneDrive.join('；')}）`);
  } else {
    console.log('未检测到 OneDrive 存储路径。');
  }
  console.log('');

  printPasteSection(runtime);

  process.exitCode = runtime.ok ? 0 : 1;
} catch (err) {
  console.error(`SE 诊断失败（未预期的异常）：${err && err.message ? err.message : String(err)}`);
  process.exitCode = 1;
}
