import { build } from 'esbuild';

await build({
  entryPoints: ['server/app/standalone.js'],
  outfile: 'server.mjs',
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
