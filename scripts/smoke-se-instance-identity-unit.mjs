// E1/E2 身份证据单测：unknown 与 mismatch 必须分开，未知永不进入 kill 路径。
import { verifySpawnedInstance, verifyOwnedOrphan } from '../server/se/instanceIdentity.js';

let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) console.log(`ok - ${name}`);
  else {
    failed += 1;
    console.error(`NOT OK - ${name}${detail ? ` :: ${detail}` : ''}`);
  }
};

const listenerFound = (pid = 100, startedAt = 'start-100') => () => ({
  status: 'found',
  pid,
  startedAt,
  pids: [pid],
});

async function main() {
  {
    const r = await verifySpawnedInstance({
      systemId: 'a_4',
      port: 14502,
      token: 'spawn-token',
      rpcOnce: async () => ({ system_id: 'a_4', port: 14502 }),
      listenerFn: listenerFound(),
      startTimeFn: () => 'start-100',
    });
    check('E1 token+auth+listener → verified', r.ok && r.pid === 100 && r.startedAt === 'start-100', JSON.stringify(r));
  }
  {
    const r = await verifySpawnedInstance({
      systemId: 'a_4',
      port: 14502,
      token: 'spawn-token',
      rpcOnce: async () => { throw new Error('auth failed'); },
      listenerFn: listenerFound(),
      startTimeFn: () => 'start-100',
    });
    check('E1 auth 失败 → unknown（不是 mismatch）', !r.ok && r.status === 'unknown', JSON.stringify(r));
  }
  {
    const r = await verifySpawnedInstance({
      systemId: 'a_4',
      port: 14502,
      token: 'spawn-token',
      rpcOnce: async () => ({ system_id: 'other', port: 14502 }),
      listenerFn: listenerFound(),
      startTimeFn: () => 'start-100',
    });
    check('E1 非默认 system_id 不符 → mismatch', !r.ok && r.status === 'mismatch', JSON.stringify(r));
  }
  {
    const r = await verifySpawnedInstance({
      systemId: 'a_4',
      port: 14502,
      token: 'spawn-token',
      rpcOnce: async () => ({ system_id: 'a_4', port: 14503 }),
      listenerFn: listenerFound(),
      startTimeFn: () => 'start-100',
    });
    check('E1 system.info 端口不符 → mismatch', !r.ok && r.status === 'mismatch', JSON.stringify(r));
  }
  {
    const r = await verifySpawnedInstance({
      systemId: 'a_4',
      port: 14502,
      token: 'spawn-token',
      rpcOnce: async () => ({ system_id: 'a_4', port: 14502 }),
      listenerFn: () => ({ status: 'unknown', reason: 'listener-query-failed', pids: [] }),
      startTimeFn: () => null,
    });
    check('E1 listener 查询失败 → unknown', !r.ok && r.status === 'unknown', JSON.stringify(r));
  }
  {
    const r = await verifySpawnedInstance({
      systemId: 'a_4',
      port: 14502,
      token: 'spawn-token',
      rpcOnce: async () => ({ system_id: 'a_4', port: 14502 }),
      listenerFn: () => ({ status: 'found', pid: 100, startedAt: null, pids: [100] }),
      startTimeFn: () => null,
    });
    check('E1 启动时间不可得 → unknown', !r.ok && r.status === 'unknown', JSON.stringify(r));
  }

  const owner = {
    pid: 100,
    vitePid: 7,
    port: 14502,
    listenerPid: 100,
    listenerStartedAt: 'start-100',
  };
  {
    const r = verifyOwnedOrphan({
      owner,
      expectedPort: 14502,
      currentVitePid: 8,
      isAlive: (pid) => Number(pid) === 100,
      isViteProcess: () => false,
      listenerFn: listenerFound(),
      startTimeFn: () => 'start-100',
    });
    check('E2 己方 owner + listener/start 匹配 → verified', r.ok && r.pid === 100, JSON.stringify(r));
  }
  {
    const r = verifyOwnedOrphan({
      owner: { ...owner, listenerStartedAt: undefined },
      expectedPort: 14502,
      currentVitePid: 8,
      isAlive: () => false,
      isViteProcess: () => false,
      listenerFn: listenerFound(),
      startTimeFn: () => 'start-100',
    });
    check('E2 旧 owner 缺 listener 启动时间 → unknown', !r.ok && r.status === 'unknown', JSON.stringify(r));
  }
  {
    const at = Date.parse('2026-10-27T00:00:10.000Z');
    const startedAt = '2026-10-27T00:00:00.000Z';
    const r = verifyOwnedOrphan({
      owner: { pid: 100, vitePid: 7, port: 14502, at },
      expectedPort: 14502,
      currentVitePid: 8,
      isAlive: (pid) => Number(pid) === 100,
      isViteProcess: () => false,
      listenerFn: () => ({ status: 'found', pid: 100, startedAt, pids: [100] }),
      startTimeFn: () => startedAt,
    });
    check('E2 旧 owner 且进程启动早于 owner 写入 → 可迁移验证', r.ok && r.legacyOwner === true, JSON.stringify(r));
  }
  {
    const at = Date.parse('2026-10-27T00:00:10.000Z');
    const startedAt = '2026-10-27T00:00:20.000Z';
    const r = verifyOwnedOrphan({
      owner: { pid: 100, vitePid: 7, port: 14502, at },
      expectedPort: 14502,
      currentVitePid: 8,
      isAlive: (pid) => Number(pid) === 100,
      isViteProcess: () => false,
      listenerFn: () => ({ status: 'found', pid: 100, startedAt, pids: [100] }),
      startTimeFn: () => startedAt,
    });
    check('E2 旧 owner 遇到 PID 复用（启动晚于写入）→ unknown', !r.ok && r.status === 'unknown', JSON.stringify(r));
  }
  {
    const r = verifyOwnedOrphan({
      owner: { ...owner, vitePid: 999 },
      expectedPort: 14502,
      currentVitePid: 8,
      isAlive: () => true,
      isViteProcess: () => true,
      listenerFn: listenerFound(),
      startTimeFn: () => 'start-100',
    });
    check('E2 另一活 Vite 持有 → owned-by-other-vite', !r.ok && r.status === 'owned-by-other-vite', JSON.stringify(r));
  }
  {
    const r = verifyOwnedOrphan({
      owner,
      expectedPort: 14502,
      currentVitePid: 8,
      isAlive: () => false,
      isViteProcess: () => false,
      listenerFn: listenerFound(200, 'start-200'),
      startTimeFn: () => 'start-200',
    });
    check('E2 listener PID 不符 → mismatch', !r.ok && r.status === 'mismatch', JSON.stringify(r));
  }
  {
    const r = verifyOwnedOrphan({
      owner,
      expectedPort: 14502,
      currentVitePid: 8,
      isAlive: () => false,
      isViteProcess: () => false,
      listenerFn: listenerFound(100, 'start-reused'),
      startTimeFn: () => 'start-reused',
    });
    check('E2 启动时间不符 → mismatch', !r.ok && r.status === 'mismatch', JSON.stringify(r));
  }
  {
    const r = verifyOwnedOrphan({
      owner,
      expectedPort: 14503,
      currentVitePid: 8,
      isAlive: () => false,
      isViteProcess: () => false,
      listenerFn: listenerFound(),
      startTimeFn: () => 'start-100',
    });
    check('E2 registry/owner 端口不符 → mismatch', !r.ok && r.status === 'mismatch', JSON.stringify(r));
  }
}

main()
  .then(() => {
    if (failed) {
      console.error(`\n${failed} check(s) failed`);
      process.exit(1);
    }
    console.log('\ninstance identity unit: all checks passed');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
