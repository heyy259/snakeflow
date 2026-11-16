import { parseStorageRootBusy } from '../server/se/process.js';

const structured = parseStorageRootBusy(
  'SNAKEEATS_ERROR {"code":"storage-root-busy","message":"storage root already owned by pid 4242: /tmp/root (lock=/tmp/root/.snakeeats.lock)","pid":4242,"root":"/tmp/root","lock":"/tmp/root/.snakeeats.lock"}'
);
if (!structured || structured.holderPid !== 4242 || structured.root !== '/tmp/root' || structured.lock !== '/tmp/root/.snakeeats.lock') {
  throw new Error(`structured storage busy parse failed: ${JSON.stringify(structured)}`);
}

const legacy = parseStorageRootBusy('storage root already owned by pid 123: /tmp/root (lock=/tmp/root/.snakeeats.lock)');
if (!legacy || legacy.holderPid !== 123 || legacy.root !== '/tmp/root' || legacy.lock !== '/tmp/root/.snakeeats.lock') {
  throw new Error(`legacy storage busy parse failed: ${JSON.stringify(legacy)}`);
}

const nullHolder = parseStorageRootBusy('SNAKEEATS_ERROR {"code":"storage-root-busy","pid":null,"root":"/tmp/root","lock":"/tmp/root/.snakeeats.lock"}');
if (!nullHolder || nullHolder.holderPid !== null) {
  throw new Error(`null holder parse failed: ${JSON.stringify(nullHolder)}`);
}

if (parseStorageRootBusy('unrelated error') !== null) {
  throw new Error('unrelated error should not be classified as storage busy');
}

console.log('storage busy parsing: OK');
