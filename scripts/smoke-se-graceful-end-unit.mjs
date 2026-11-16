// Tier-1 单测：shutdown ack 不是终态；只有同一 PID + 启动时间退出才算 exited。
import {
  tryGracefulSeShutdown,
  waitSameProcessExit,
  SE_GRACEFUL_TIMEOUT_MS,
  SE_SHUTDOWN_ACK_TIMEOUT_MS,
} from '../server/se/gracefulEnd.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 220) : ''}`);
};

async function main() {
  {
    const calls = [];
    const r = await tryGracefulSeShutdown({
      port: 1234,
      token: 'tok',
      rpcOnce: async (p, tok, m, _params, timeout) => {
        calls.push([p, tok, m, timeout]);
        return { status: 'shutting-down', accepted: true };
      },
      pid: 4321,
      startedAt: 'start-a',
      isAlive: () => false,
      startTime: () => null,
      timeoutMs: 500,
    });
    check('shutdown 受理 + 同进程退出 → graceful', r.attempted && r.exited && r.graceful, JSON.stringify(r));
    check(
      'shutdown 使用短 ack 超时',
      calls.length === 1 && calls[0][2] === 'system.shutdown' && calls[0][3] === SE_SHUTDOWN_ACK_TIMEOUT_MS,
      JSON.stringify(calls)
    );
  }
  {
    let n = 0;
    const r = await tryGracefulSeShutdown({
      port: 1234,
      token: 'tok',
      rpcOnce: async () => ({}),
      pid: 4321,
      startedAt: 'start-a',
      isAlive: () => ++n < 3,
      startTime: () => 'start-a',
      timeoutMs: 2000,
    });
    check('等待轮询直到同进程退出', r.exited === true && r.graceful === true && n >= 3, JSON.stringify({ ...r, polls: n }));
  }
  {
    const t0 = Date.now();
    const r = await tryGracefulSeShutdown({
      port: 1234,
      token: 'tok',
      rpcOnce: async () => ({}),
      pid: 4321,
      startedAt: 'start-a',
      isAlive: () => true,
      startTime: () => 'start-a',
      timeoutMs: 250,
    });
    check('进程不退出 → exited=false 且有界', r.exited === false && /timeout-process/.test(r.reason || ''), JSON.stringify(r));
    check('等待有界', Date.now() - t0 < 1200, `elapsed=${Date.now() - t0}`);
  }
  {
    const r = await tryGracefulSeShutdown({
      port: 1234,
      token: 'tok',
      rpcOnce: async () => { throw new Error('auth failed'); },
      pid: 4321,
      startedAt: 'start-a',
      isAlive: () => false,
      startTime: () => null,
      timeoutMs: 1000,
    });
    check('RPC 失败但进程已退出 → exited=true, graceful=false', r.exited === true && r.graceful === false, JSON.stringify(r));
  }
  {
    const r = await tryGracefulSeShutdown({
      port: 0,
      token: '',
      rpcOnce: async () => { throw new Error('must-not-run'); },
      pid: 0,
      startedAt: '',
      timeoutMs: 50,
    });
    check('缺端口/token/进程 → attempted=false', r.attempted === false && r.exited === false, JSON.stringify(r));
  }
  {
    let polls = 0;
    const exited = await waitSameProcessExit({
      pid: 1,
      startedAt: 'start-a',
      isAlive: () => true,
      startTime: () => (polls++ === 0 ? 'start-a' : 'start-reused'),
      timeoutMs: 1000,
      pollMs: 10,
    });
    check('PID 被复用（启动时间变化）→ 原进程视为退出', exited === true);
  }
  check('优雅预算覆盖 SnakeEats 默认 10s 停机', SE_GRACEFUL_TIMEOUT_MS >= 10000, `=${SE_GRACEFUL_TIMEOUT_MS}`);
  check('停机阶段预算小于前端 30s abort', SE_GRACEFUL_TIMEOUT_MS < 30000, `=${SE_GRACEFUL_TIMEOUT_MS}`);

  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `\nFAIL ${failed.length}/${results.length}` : `\nALL PASS ${results.length}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
