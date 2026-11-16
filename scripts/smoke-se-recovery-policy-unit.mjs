// 自动恢复策略纯单测：保留后缀与跨图谱 source 不得走公共 stream.create。
import assert from 'node:assert/strict';
import { canAutoCreateStream } from '../src/se/recoveryPolicy.js';

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    throw err;
  }
};

check('ordinary stream is creatable', () => {
  assert.equal(canAutoCreateStream('普通流', '', '图 A'), true);
  assert.equal(canAutoCreateStream('ordinary', '图 A.streams/ordinary.md', '图 A'), true);
});

check('reserved suffixes are never public-creatable', () => {
  assert.equal(canAutoCreateStream('run_console', '', '图 A'), false);
  assert.equal(canAutoCreateStream('run_scan_log', '图 A.streams/run_scan_log.md', '图 A'), false);
});

check('cross-graph source is not auto-created', () => {
  assert.equal(canAutoCreateStream('流', '别的图.streams/流.md', '图 A'), false);
  assert.equal(canAutoCreateStream('流', 'graphs/别的图.streams/流.md', '图 A'), false);
});

check('external absolute source remains creatable', () => {
  assert.equal(canAutoCreateStream('流', 'D:/docs/流.md', '图 A'), true);
});

check('missing name is rejected', () => {
  assert.equal(canAutoCreateStream('', '', '图 A'), false);
  assert.equal(canAutoCreateStream(null, '', '图 A'), false);
});

check('missing docBase skips cross-graph check', () => {
  assert.equal(canAutoCreateStream('流', '别的图.streams/流.md', ''), true);
});

console.log(`\n==== ${passed}/${passed} PASS ====`);
