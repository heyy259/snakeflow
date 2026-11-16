// OS 进程证据单测：启动时间可比较，listener 三态不会把命令失败伪装成“无监听”。
import net from 'node:net';
import {
  getProcessStartTime,
  isSameProcess,
  findListeningProcess,
} from '../server/util.js';

let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) console.log(`ok - ${name}`);
  else {
    failed += 1;
    console.error(`NOT OK - ${name}${detail ? ` :: ${detail}` : ''}`);
  }
};

async function main() {
  const startedAt = getProcessStartTime(process.pid);
  check('当前进程启动时间可读取', !!startedAt, String(startedAt));
  check('同进程启动时间匹配', !!startedAt && isSameProcess(process.pid, startedAt));
  check('错误启动时间不匹配', !isSameProcess(process.pid, 'not-the-start-time'));

  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  try {
    let found = null;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const result = findListeningProcess(port);
      if (result.status === 'found') {
        found = result;
        break;
      }
      if (process.platform === 'win32' && result.status === 'not-listening') {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      if (process.platform !== 'win32' && result.status === 'unknown') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (process.platform === 'win32') {
      check(
        'Windows listener 反查命中当前进程',
        !!found && found.pid === process.pid && !!found.startedAt,
        JSON.stringify(found)
      );
    } else if (found) {
      check('POSIX listener 反查命中当前进程', found.pid === process.pid && !!found.startedAt, JSON.stringify(found));
    } else {
      console.log('skip - 当前平台 lsof 不可用，跳过 listener 反查断言');
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main()
  .then(() => {
    if (failed) {
      console.error(`\n${failed} check(s) failed`);
      process.exit(1);
    }
    console.log('\nprocess evidence unit: all checks passed');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
