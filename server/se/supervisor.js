import { installSeExitHooks, spawnSeSystem, listSeSystems } from './process.js';

export function createSeSupervisor({ paths } = {}) {
  return {
    paths,
    spawnSeSystem,
    listSeSystems,
    installExitHooks: installSeExitHooks,
  };
}
