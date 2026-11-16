import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeRecursiveWithRetry } from '../server/resilientFs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const NODE_VERSION = '22.16.0';

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const platform = argValue('--platform', `${process.platform}-${process.arch}`);
const skipNode = process.argv.includes('--skip-node');
const skipBuild = process.argv.includes('--skip-build');
const outDir = path.join(ROOT, 'release');
const staging = path.join(outDir, `staging-${platform}`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with ${result.status}`);
}

function copy(source, target) {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copy(path.join(source, entry), path.join(target, entry));
    }
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function download(url, target) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        download(response.headers.location, target).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`download ${url} failed: HTTP ${response.statusCode}`));
        return;
      }
      const file = fs.createWriteStream(target);
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    });
    request.on('error', reject);
  });
}

async function includeNodeRuntime() {
  const targets = {
    'win-x64': { archive: `node-v${NODE_VERSION}-win-x64.zip`, binary: 'node.exe', subdir: '' },
    'mac-arm64': { archive: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`, binary: 'node', subdir: 'bin' },
    'mac-x64': { archive: `node-v${NODE_VERSION}-darwin-x64.tar.gz`, binary: 'node', subdir: 'bin' },
    'linux-x64': { archive: `node-v${NODE_VERSION}-linux-x64.tar.xz`, binary: 'node', subdir: 'bin' },
  };
  const target = targets[platform];
  if (!target) throw new Error(`unsupported platform for bundled Node: ${platform}`);
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${target.archive}`;
  const archive = path.join(os.tmpdir(), target.archive);
  if (!fs.existsSync(archive)) await download(url, archive);
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snakeflow-node-'));
  run('tar', ['-xf', archive, '-C', extractDir]);
  const base = path.join(extractDir, `node-v${NODE_VERSION}-${platform === 'win-x64' ? 'win' : platform === 'mac-arm64' || platform === 'mac-x64' ? 'darwin' : 'linux'}-${platform.endsWith('arm64') ? 'arm64' : 'x64'}`);
  const nodeDir = path.join(staging, 'node');
  fs.mkdirSync(nodeDir, { recursive: true });
  const binary = path.join(base, target.subdir, target.binary);
  fs.copyFileSync(binary, path.join(nodeDir, target.binary));
  if (platform !== 'win-x64') fs.chmodSync(path.join(nodeDir, target.binary), 0o755);
}

async function main() {
  if (!skipBuild) {
    run('npm', ['run', 'build'], { cwd: ROOT, shell: process.platform === 'win32' });
    run('npm', ['run', 'build:server'], { cwd: ROOT, shell: process.platform === 'win32' });
  }
  removeRecursiveWithRetry(staging, { recursive: true, bestEffort: true, cmdFallback: true });
  fs.mkdirSync(staging, { recursive: true });
  for (const name of ['dist', 'server.mjs', 'launcher', 'start.cmd', 'start.command', 'start.sh', 'package.json', 'README.md', 'LICENSE', 'COMPATIBILITY.md', 'SECURITY.md', 'CHANGELOG.md', 'se.config.example.json']) {
    copy(path.join(ROOT, name), path.join(staging, name));
  }
  for (const name of ['start.command', 'start.sh']) {
    fs.chmodSync(path.join(staging, name), 0o755);
  }
  if (!skipNode) await includeNodeRuntime();

  fs.mkdirSync(outDir, { recursive: true });
  const archive = path.join(outDir, `snakeflow-${pkg.version}-${platform}.zip`);
  fs.rmSync(archive, { force: true });
  run('tar', ['-a', '-c', '-f', archive, '-C', staging, '.']);
  console.log(`assembled ${archive}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
