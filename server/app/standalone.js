import http from 'node:http';
import path from 'node:path';
import { createAppRuntime } from '../index.js';
import { createApiRouter, attachSeWebSocket } from '../api/router.js';
import { createStaticHandler } from './static.js';

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

export async function startStandalone(options = {}) {
  const runtime = createAppRuntime({
    mode: options.mode || process.env.RF_MODE || 'legacy',
    dataRoot: options.dataRoot || process.env.RF_DATA_ROOT || undefined,
  });
  const host = options.host || process.env.HOST || '127.0.0.1';
  let port = Number(options.port || argValue('--port', process.env.PORT || 5173));
  const router = createApiRouter({ supervisor: runtime.supervisor, paths: runtime.paths, security: runtime.security });
  const staticHandler = createStaticHandler({ rootDir: path.join(runtime.paths.appRoot, 'dist') });
  const server = http.createServer((req, res) => {
    if (req.url && req.url.startsWith('/api/')) {
      router(req, res, () => {
        res.statusCode = 404;
        res.end('not found');
      });
      return;
    }
    staticHandler(req, res);
  });
  attachSeWebSocket(server, { supervisor: runtime.supervisor, paths: runtime.paths, security: runtime.security });
  runtime.supervisor.installExitHooks();

  await new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err && err.code === 'EADDRINUSE') {
        port += 1;
        server.listen(port, host);
        return;
      }
      reject(err);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  const url = `http://${host}:${port}`;
  if (runtime.security && typeof runtime.security.setPort === 'function') runtime.security.setPort(port);
  console.log(`SnakeFlow listening on ${url}`);
  console.log(`data root: ${runtime.paths.dataRoot}`);
  if (options.open || process.argv.includes('--open')) {
    const { openPath } = await import('../util.js');
    openPath(url, false).catch(() => {});
  }
  return { server, runtime, url, port };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  startStandalone().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
