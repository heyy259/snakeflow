import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundledNode = path.join(appRoot, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
const nodeExec = fs.existsSync(bundledNode) ? bundledNode : process.execPath;

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function checkNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const ok = (major === 20 && minor >= 19) || major >= 22;
  if (!ok) {
    console.error(`SnakeFlow requires Node.js ^20.19.0 or >=22.12.0; current ${process.versions.node}`);
    process.exit(1);
  }
}

async function waitForSession(port, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/session`);
      if (res.ok) {
        const data = await res.json();
        if (data.session) return data.session;
      }
    } catch {
      // server not ready
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error('SnakeFlow server did not become ready');
}

async function runDoctor(entry, env) {
  const child = spawn(nodeExec, [entry, '--port', '5398'], {
    cwd: appRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const secret = await waitForSession(5398);
    const res = await fetch('http://127.0.0.1:5398/api/se/preflight', {
      headers: { 'X-RF-Session': secret },
    });
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
    return data.available ? 0 : 1;
  } catch (err) {
    console.error(`doctor failed: ${err && err.message ? err.message : err}`);
    return 1;
  } finally {
    child.kill('SIGTERM');
  }
}

async function main() {
  checkNodeVersion();
  const portable = hasFlag('--portable');
  const env = {
    ...process.env,
    RF_MODE: portable ? 'legacy' : 'installed',
  };
  if (hasFlag('--data-root')) env.RF_DATA_ROOT = argValue('--data-root', '');
  const entry = fs.existsSync(path.join(appRoot, 'server.mjs'))
    ? path.join(appRoot, 'server.mjs')
    : path.join(appRoot, 'server', 'app', 'standalone.js');

  if (hasFlag('--doctor') || hasFlag('--repair')) {
    const code = await runDoctor(entry, env);
    if (hasFlag('--repair') && code !== 0) {
      console.log('\n修复建议：');
      console.log('1. 安装 Python 3.10+（https://www.python.org/downloads/）。');
      console.log('2. 执行：python -m pip install "snakeeats>=0.1.0,<0.2.0"');
      console.log('3. 重新运行本启动器，或使用 --doctor 再次诊断。');
    }
    process.exit(code);
  }

  const port = argValue('--port', process.env.PORT || '5173');
  const args = [entry, '--port', String(port)];
  if (!hasFlag('--no-open')) args.push('--open');

  console.log(`SnakeFlow launcher (${portable ? 'portable' : 'installed'})`);
  if (env.RF_DATA_ROOT) console.log(`data root: ${env.RF_DATA_ROOT}`);
  const child = spawn(nodeExec, args, {
    cwd: appRoot,
    env,
    stdio: 'inherit',
  });
  const stop = () => {
    if (!child.killed) child.kill('SIGTERM');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('close', (code) => {
    process.exitCode = code ?? 0;
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
