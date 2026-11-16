import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV_PORT = 5173;
const STANDALONE_PORT = 5399;

function getJson(port, pathname, secret) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers: secret ? { 'X-RF-Session': secret } : {},
  }).then(async (res) => {
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data };
  });
}

async function waitForSession(port, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await getJson(port, '/api/session');
      if (result.status === 200 && result.data && result.data.session) return result.data.session;
    } catch {
      // server not ready
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`server on ${port} did not become ready`);
}

function startProcess(args, env) {
  return spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function main() {
  const children = [];
  try {
    const vite = startProcess(['node_modules/vite/bin/vite.js', '--port', String(DEV_PORT), '--strictPort'], { RF_MODE: 'legacy' });
    children.push(vite);
    const standalone = startProcess(['server/app/standalone.js', '--port', String(STANDALONE_PORT)], { RF_MODE: 'legacy' });
    children.push(standalone);

    const [devSecret, standaloneSecret] = await Promise.all([
      waitForSession(DEV_PORT),
      waitForSession(STANDALONE_PORT),
    ]);

    const failures = [];
    const compare = async (pathname, pick) => {
      const [dev, prod] = await Promise.all([
        getJson(DEV_PORT, pathname, devSecret),
        getJson(STANDALONE_PORT, pathname, standaloneSecret),
      ]);
      const devValue = JSON.stringify(pick(dev.data));
      const prodValue = JSON.stringify(pick(prod.data));
      if (dev.status !== prod.status || devValue !== prodValue) {
        failures.push(`${pathname}: dev=${dev.status}/${devValue} standalone=${prod.status}/${prodValue}`);
      }
    };

    await compare('/api/graphs', (data) => data);
    await compare('/api/se/preflight', (data) => ({
      available: data.available,
      mode: data.mode,
      python: data.python,
      packageParent: data.packageParent,
    }));

    const [devForbidden, prodForbidden] = await Promise.all([
      getJson(DEV_PORT, '/api/graphs'),
      getJson(STANDALONE_PORT, '/api/graphs'),
    ]);
    if (devForbidden.status !== 403 || prodForbidden.status !== 403) {
      failures.push(`security gate mismatch: dev=${devForbidden.status} standalone=${prodForbidden.status}`);
    }

    if (failures.length) {
      console.error(failures.join('\n'));
      process.exitCode = 1;
      return;
    }
    console.log('standalone parity: OK (graphs, preflight, security gate)');
  } finally {
    for (const child of children) {
      try {
        child.kill('SIGTERM');
      } catch {
        // best effort
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
