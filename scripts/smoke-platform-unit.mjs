import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seSpawnPlatformOptions, killProcessTree, isPidAlive } from '../server/platform/process.js';
import { EXEC_EXTS, isAbsolutePath } from '../server/platform/paths.js';
import { parseDialogOpts } from '../server/platform/dialog.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, condition) => {
  results.push({ name, ok: !!condition });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`);
};

const spawnOptions = seSpawnPlatformOptions();
check('spawn options hide the console window', spawnOptions.windowsHide === true);
check('Windows spawn does not create a POSIX process group', process.platform !== 'win32' || spawnOptions.detached === false);
check('POSIX spawn would create a process group', process.platform === 'win32' || spawnOptions.detached === true);

for (const ext of ['.app', '.command', '.sh', '.exe', '.bat']) {
  check(`executable extension blocked: ${ext}`, EXEC_EXTS.has(ext));
}
check('POSIX absolute path accepted', isAbsolutePath('/Users/example/project') === true);
check('Windows absolute path accepted', isAbsolutePath('C:/Users/example') === true);
check('UNC path accepted', isAbsolutePath('\\\\server\\share') === true);
check('relative path rejected', isAbsolutePath('graphs/demo') === false);
check('invalid pid is not alive', isPidAlive(999999) === false);
killProcessTree(999999);
check('killing an invalid pid does not throw', true);
check('dialog options parse JSON', parseDialogOpts('{"title":"demo"}').title === 'demo');
check('invalid dialog options return an empty object', Object.keys(parseDialogOpts('{bad')).length === 0);

const startCommand = fs.readFileSync(path.join(root, 'start.command'), 'utf-8');
const startSh = fs.readFileSync(path.join(root, 'start.sh'), 'utf-8');
const startCmd = fs.readFileSync(path.join(root, 'start.cmd'), 'utf-8');
check('start.command uses /bin/sh', startCommand.startsWith('#!/bin/sh'));
check('start.sh uses /bin/sh', startSh.startsWith('#!/bin/sh'));
check('start.command prefers the bundled Node binary', startCommand.includes('node/node'));
check('start.cmd prefers the bundled Node binary', startCmd.includes('node\\node.exe'));
check('start.command has LF line endings', !startCommand.includes('\r'));
check('start.sh has LF line endings', !startSh.includes('\r'));

const launcher = fs.readFileSync(path.join(root, 'launcher', 'launcher.mjs'), 'utf-8');
check('launcher prefers the bundled Node binary', launcher.includes('bundledNode'));

const staging = path.join(root, 'release', 'staging-win-x64');
for (const name of ['node/node.exe', 'server.mjs', 'dist/index.html', 'start.cmd', 'start.command', 'start.sh', 'se.config.example.json', 'launcher/launcher.mjs']) {
  check(`packaged file exists: ${name}`, fs.existsSync(path.join(staging, name)));
}
check('release zip exists', fs.existsSync(path.join(root, 'release', 'snakeflow-0.1.0-win-x64.zip')));

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
