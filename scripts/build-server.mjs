import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  absWorkingDir: appRoot,
  entryPoints: [path.join(appRoot, 'server', 'app', 'standalone.js')],
  outfile: path.join(appRoot, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'warning',
  sourcemap: false,
  minify: false,
  banner: {
    js: "import { createRequire as __esbuildCreateRequire } from 'node:module'; const require = __esbuildCreateRequire(import.meta.url);",
  },
});
console.log('built server.mjs');
