// 删除错误策略纯单测：只把「目标已不存在」识别为删除后置条件已满足。
import assert from 'node:assert/strict';
import { isStreamNotFoundError, STREAM_NOT_FOUND_CODE } from '../src/se/deletePolicy.js';

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

check('SE stream not-found code', () => {
  assert.equal(STREAM_NOT_FOUND_CODE, -32002);
  assert.equal(isStreamNotFoundError({ code: -32002 }), true);
});

check('kind=not-found', () => {
  assert.equal(isStreamNotFoundError({ data: { kind: 'not-found' } }), true);
});

check('message-only variants', () => {
  assert.equal(isStreamNotFoundError(new Error('not_found')), true);
  assert.equal(isStreamNotFoundError(new Error('not-found')), true);
  assert.equal(isStreamNotFoundError(new Error('not found')), true);
  assert.equal(isStreamNotFoundError(new Error(' NOT_FOUND ')), true);
});

check('tool-domain code is not stream not-found', () => {
  assert.equal(isStreamNotFoundError({ code: -33001 }), false);
});

check('transport/auth/timeout stay failures', () => {
  assert.equal(isStreamNotFoundError(new Error('SE request timed out: stream.delete')), false);
  assert.equal(isStreamNotFoundError(new Error('SE client closed')), false);
  assert.equal(isStreamNotFoundError({ code: -32001, data: { kind: 'auth-required' } }), false);
  assert.equal(isStreamNotFoundError(new Error('unsupported operation')), false);
});

check('descriptive message without code stays failure', () => {
  assert.equal(isStreamNotFoundError(new Error("Stream 'x' not found")), false);
});

check('non-object input', () => {
  assert.equal(isStreamNotFoundError(null), false);
  assert.equal(isStreamNotFoundError(undefined), false);
  assert.equal(isStreamNotFoundError('not_found'), false);
});

console.log(`\n==== ${passed}/${passed} PASS ====`);
