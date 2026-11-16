// 服务端组合根：显式创建 AppPaths / Supervisor / 插件，不在模块导入期做启动副作用。
import { migrateLegacyFlows } from './store.js';
import { migrateLegacyLayout } from './migrate.js';
import { seApi } from './se/api.js';
import { graphsApi } from './graphsApi.js';
import { createAppPaths, setAppPaths, readAppConfig } from './paths.js';
import { sweepSeRuntime } from './se/cleanup.js';
import { createSeSupervisor } from './se/supervisor.js';
import { createSecurityGate } from './security.js';

export function createAppRuntime(options = {}) {
  const initialPaths = createAppPaths(options);
  const config = options.config || readAppConfig({
    configFile: options.configFile || (initialPaths.mode === 'installed' ? initialPaths.configFile : undefined),
  });
  const mode = options.mode || (config.portable === true ? 'legacy' : config.portable === false ? 'installed' : undefined);
  const dataRoot = options.dataRoot || (config.dataRoot && config.dataRoot !== 'auto' ? config.dataRoot : undefined);
  const paths = mode !== initialPaths.mode || dataRoot !== initialPaths.dataRoot
    ? createAppPaths({ ...options, mode, dataRoot })
    : initialPaths;
  setAppPaths(paths);
  migrateLegacyLayout(paths);
  if (paths.mode !== 'installed') migrateLegacyFlows();
  if (process.env.SE_CLEANUP !== '0') {
    const maxAgeDays = Number(process.env.SE_CLEANUP_DAYS) || 30;
    sweepSeRuntime({
      runtimeDir: paths.runtimeDir,
      storageDir: paths.seSystemsDir,
      workspaceFile: paths.workspaceFile,
      maxAgeDays,
      dryRun: false,
      log: (message) => console.log(`[se-cleanup] ${message}`),
    }).catch(() => {
      // cleanup must never prevent the app from starting
    });
  }
  const supervisor = createSeSupervisor({ paths });
  const security = options.security || createSecurityGate({
    port: options.port || (config.server && config.server.port) || 5173,
  });
  return {
    paths,
    supervisor,
    security,
    plugins: [seApi({ supervisor, paths, security }), graphsApi({ paths, security })],
  };
}

export function createServerPlugins(options = {}) {
  return createAppRuntime(options).plugins;
}

export function bootServerSide(options = {}) {
  return createAppRuntime(options);
}
