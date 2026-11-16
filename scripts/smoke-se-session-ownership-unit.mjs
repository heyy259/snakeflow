// Per-SID session ownership regressions (zero SE, zero DOM).
// Contract: confirmed final close drops all close-sensitive state (version/synced/tags/
// stale/self-write/tombstones/pending push); failed close keeps it; a shared SID keeps it;
// delayed completions from a dropped session cannot mutate a reopened same-SID session.
// Run: node scripts/smoke-se-session-ownership-unit.mjs
import assert from 'node:assert/strict';
import { createSeOrchestrator } from '../src/se/orchestrator.js';
import { createSessionStore } from '../src/se/sessionState.js';
import { sePool, SE_STATUS } from '../src/se/pool.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 500) : ''}`);
};

const clone = (value) => JSON.parse(JSON.stringify(value));
const loadedNode = (name, content, extra = {}) => ({
  id: `s-${name}`,
  position: { x: 0, y: 0 },
  data: { name, content, contentState: 'loaded', ...extra },
});
const remoteRow = (name, text, version = 1, extra = {}) => ({
  name,
  text,
  version,
  description: '',
  tags: {},
  ...extra,
});

const original = { get: sePool.get, onStatus: sePool.onStatus, release: sePool.release, fetch: globalThis.fetch };

function makeHarness({ rows = [], nodes = [], tabs, closeResult = () => ({ ok: true, killed: true }), overrides = {} } = {}) {
  const remote = new Map(rows.map((row) => [row.name, clone(row)]));
  const tabList = tabs || [
    { id: 'tab-sid', name: 'A', system: { system_id: 'sid' } },
    { id: 'tab-other', name: 'B', system: { system_id: 'other' } },
  ];
  const state = {
    activeSystemId: 'sid',
    activeTabId: 'tab-sid',
    offline: false,
    nodes: clone(nodes),
    edges: [],
    editingNodeId: null,
  };
  const calls = [];
  const released = [];
  const subscriptions = [];
  let statusListener = null;

  const metadata = (row) => ({
    name: row.name,
    version: row.version,
    description: row.description || '',
    tags: clone(row.tags || {}),
  });
  const client = {
    status: SE_STATUS.ONLINE,
    subscribe(events, listener) {
      const entry = { events: Array.isArray(events) ? events : [], listener };
      subscriptions.push(entry);
      return () => {
        const index = subscriptions.indexOf(entry);
        if (index >= 0) subscriptions.splice(index, 1);
      };
    },
    async call(method, params = {}) {
      calls.push({ method, params: clone(params) });
      if (overrides[method]) return overrides[method](params, remote);
      if (method === 'stream.list') return [...remote.values()].map(metadata);
      if (method === 'stream.read') {
        const row = remote.get(String(params.name));
        if (!row) throw new Error('stream missing');
        return { text: row.text };
      }
      if (method === 'stream.get_metadata') {
        const row = remote.get(String(params.name));
        if (!row) throw new Error('stream missing');
        return metadata(row);
      }
      if (method === 'stream.create') {
        const name = String(params.name);
        if (remote.has(name)) throw new Error('already exists');
        const row = remoteRow(name, '', 1, { tags: clone(params.tags || {}) });
        remote.set(name, row);
        return metadata(row);
      }
      if (method === 'stream.write') {
        const row = remote.get(String(params.name));
        if (!row) throw new Error('stream missing');
        row.text = params.text != null ? String(params.text) : '';
        row.version += 1;
        return { version: row.version };
      }
      if (method === 'stream.set_tag') {
        const row = remote.get(String(params.name));
        if (row) row.tags[String(params.key)] = params.value == null ? '' : String(params.value);
        return {};
      }
      if (method === 'tool.list' || method === 'tool.list_processes') return [];
      return {};
    },
  };

  const port = {
    getActiveSystemId: () => state.activeSystemId,
    getActiveTabId: () => state.activeTabId,
    getTabs: () => tabList,
    getStoreGraph: () => ({ nodes: state.nodes, edges: state.edges, tools: {} }),
    getNodes: () => state.nodes,
    setNodes: (update) => {
      state.nodes = typeof update === 'function' ? update(state.nodes) : update;
    },
    getEdges: () => state.edges,
    setEdges: (edges) => { state.edges = edges; },
    setDangling: () => {},
    isSeEdge: (edge) => edge?.data?.state === 'se',
    toCanvasGraph: ({ nodes: projected, edges }) => ({ nodes: projected, edges }),
    screenToFlowCenter: () => ({ x: 100, y: 100 }),
    getLayout: () => null,
    pruneLayout: () => {},
    isTabReady: () => true,
    isOffline: () => state.offline,
    getEditingNodeId: () => state.editingNodeId,
    notify: () => {},
    setStatus: () => {},
    setSeStatus: () => {},
    setCanManageTools: () => {},
    seErrorMessage: (res) => String((res && (res.error || res.status || res.code)) || 'failed'),
    onToolStatus: () => {},
    toolsForSystem: () => ({}),
    baseDirForSystem: () => '',
    recordToolFailures: () => 0,
    callAlignEdges: () => Promise.resolve(),
    callPromotePending: () => Promise.resolve(),
  };

  sePool.get = () => client;
  sePool.release = (sid) => { released.push(String(sid)); };
  sePool.onStatus = (_sid, listener) => {
    statusListener = listener;
    return () => { if (statusListener === listener) statusListener = null; };
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => clone(closeResult()) });

  let reopenSeq = 0;
  const replaceOwnerTab = () => {
    reopenSeq += 1;
    const newId = `tab-sid-reopen-${reopenSeq}`;
    const owner = tabList.find((t) => t.system?.system_id === 'sid');
    if (owner) owner.id = newId;
    state.activeTabId = newId;
    return newId;
  };

  return {
    se: createSeOrchestrator(() => port),
    remote,
    calls,
    state,
    released,
    replaceOwnerTab,
    emitStreamChange(params) {
      subscriptions
        .filter(({ events }) => events.length === 0 || events.includes('stream.on_change'))
        .forEach(({ listener }) => listener(params));
    },
  };
}

const settle = async (turns = 10) => {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
async function waitFor(predicate, label) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timeout: ${label}`);
}

async function runCase(name, fn) {
  try {
    await fn();
    check(name, true);
  } catch (err) {
    check(name, false, err?.stack || String(err));
  }
}

async function main() {
  await runCase('session disposer clears every close-sensitive field', async () => {
    const store = createSessionStore();
    const session = store.ensure('sid');
    session.version.set('k', 1);
    session.synced.set('k', { version: 1 });
    session.consoleTailOffset.set('k', 1);
    session.stale.add('k');
    session.selfWrite.set('k', Date.now() + 1000);
    session.tags.set('n', {});
    session.internalMark.add('n');
    session.internalMarking.add('n');
    session.prevStatus = 'online';
    session.hadOffline = true;
    session.everOnline = true;
    session.pendingPush = [{}];
    session.deletedTombstones.set('n', { at: 1, cause: 'user' });
    session.unconfirmedMissing.add('n');
    session.repairing.add('n');
    session.repairCooldown.set('n', 1);
    session.missingNotice = { sig: 'x', at: 1 };
    session.projectionEpoch = 3;
    session.reading.add('k');
    session.subscribed = true;
    let timerFired = false;
    session.readTimers.set('k', setTimeout(() => { timerFired = true; }, 0));

    store.drop('sid');
    assert.equal(store.peek('sid'), null);
    assert.equal(store.owns('sid', session), false);
    for (const map of [
      session.version,
      session.synced,
      session.consoleTailOffset,
      session.selfWrite,
      session.tags,
      session.deletedTombstones,
      session.repairCooldown,
      session.readTimers,
    ]) {
      assert.equal(map.size, 0);
    }
    for (const set of [
      session.stale,
      session.internalMark,
      session.internalMarking,
      session.unconfirmedMissing,
      session.repairing,
      session.reading,
    ]) {
      assert.equal(set.size, 0);
    }
    assert.equal(session.prevStatus, undefined);
    assert.equal(session.hadOffline, false);
    assert.equal(session.everOnline, false);
    assert.equal(session.pendingPush, null);
    assert.equal(session.missingNotice, null);
    assert.equal(session.projectionEpoch, 0);
    assert.equal(session.subscribed, false);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(timerFired, false);
  });

  await runCase('confirmed final close drops version/synced/tags/stale/self-write/tombstone/pending', async () => {
    const h = makeHarness({
      rows: [remoteRow('alpha', 'server', 3, { tags: { role: 'server' } })],
      nodes: [loadedNode('alpha', 'server'), loadedNode('ghost', 'local ghost')],
    });
    await h.se.onConnected('sid');
    await settle();
    h.state.editingNodeId = 's-alpha';
    h.emitStreamChange({ name: 'alpha', version: 4, change: { type: 'set' } });
    h.state.editingNodeId = null;
    h.se.baselineSet('sid', 'alpha', 3, 'server');
    h.se.markSelfWrite('sid', 'alpha');
    h.se.noteDeleted('sid', 'ghost', 'user');
    h.se.stashPendingPush('sid', [loadedNode('beta', 'pending beta')]);

    assert.equal(h.se.versionGet('sid', 'alpha'), 3);
    assert.deepEqual(h.se.tagsGet('alpha'), { role: 'server' });
    assert.equal(h.se.staleHas('sid', 'alpha'), true);
    assert.equal(h.se.isSelfWrite('sid', 'alpha'), true);

    const res = await h.se.closeSystem('sid');
    assert.equal(res.killed, true);
    assert.deepEqual(h.released, ['sid']);

    assert.equal(h.se.versionGet('sid', 'alpha'), undefined);
    assert.equal(h.se.baselineGet('sid', 'alpha'), undefined);
    assert.equal(h.se.tagsGet('alpha'), undefined);
    assert.equal(h.se.staleHas('sid', 'alpha'), false);
    assert.equal(h.se.isSelfWrite('sid', 'alpha'), false);

    // Reopen the same SID with a new owner tab: dropped tombstone must not delete ghost;
    // dropped pending must not push.
    h.replaceOwnerTab();
    await h.se.onConnected('sid');
    await settle();
    assert.equal(h.state.nodes.some((n) => n.id === 's-ghost'), true);
    assert.equal(h.remote.has('beta'), false);
    assert.equal(h.calls.some((c) => c.method === 'stream.write' && c.params.name === 'beta'), false);
  });

  await runCase('failed close retains version/baseline/self-write and pending push replays', async () => {
    const h = makeHarness({
      rows: [remoteRow('alpha', 'server', 2)],
      nodes: [loadedNode('alpha', 'server')],
      closeResult: () => ({ ok: false, status: 'failed', error: 'not stopped' }),
    });
    await h.se.onConnected('sid');
    await settle();
    h.se.baselineSet('sid', 'alpha', 2, 'server');
    h.se.markSelfWrite('sid', 'alpha');
    h.se.stashPendingPush('sid', [loadedNode('beta', 'pending beta')]);

    const res = await h.se.closeSystem('sid');
    assert.notEqual(res.ok, true);
    assert.equal(h.se.versionGet('sid', 'alpha'), 2);
    assert.equal(h.se.baselineGet('sid', 'alpha').text, 'server');
    assert.equal(h.se.isSelfWrite('sid', 'alpha'), true);

    await h.se.onConnected('sid');
    await waitFor(() => h.remote.has('beta'), 'pending push replay after failed close');
    assert.equal(h.remote.get('beta').text, 'pending beta');
  });

  await runCase('shared SID retains the session after a confirmed stop', async () => {
    const h = makeHarness({
      rows: [remoteRow('alpha', 'server', 7)],
      nodes: [loadedNode('alpha', 'server')],
      tabs: [
        { id: 'tab-sid', name: 'A', system: { system_id: 'sid' } },
        { id: 'tab-sid-2', name: 'A2', system: { system_id: 'sid' } },
      ],
    });
    await h.se.onConnected('sid');
    await settle();
    h.se.baselineSet('sid', 'alpha', 7, 'server');
    const res = await h.se.closeSystem('sid');
    assert.equal(res.ok, true);
    assert.equal(h.se.versionGet('sid', 'alpha'), 7);
    assert.equal(h.se.baselineGet('sid', 'alpha').text, 'server');
  });

  await runCase('confirmed final close: late public calls neither recreate nor seed a session', async () => {
    const h = makeHarness({
      rows: [remoteRow('alpha', 'server', 3)],
      nodes: [loadedNode('alpha', 'server'), loadedNode('ghost', 'local ghost')],
    });
    await h.se.onConnected('sid');
    await settle();

    const res = await h.se.closeSystem('sid');
    assert.equal(res.ok, true);
    assert.equal(res.killed, true);

    // 确认最终关闭后，所有普通公开读写都不得创建/复活会话。
    h.se.stashPendingPush('sid', [loadedNode('beta', 'late pending')]);
    h.se.baselineSet('sid', 'alpha', 99, 'late baseline');
    h.se.baselineDelete('sid', 'alpha');
    h.se.baselineRekey('sid', 'alpha', 'alpha-renamed');
    h.se.noteCasResolved('sid', 'alpha', 77, 'late cas');
    h.se.markSelfWrite('sid', 'alpha');
    h.se.staleDelete('sid', 'alpha');
    h.se.noteDeleted('sid', 'ghost', 'user');
    h.se.clearDeleted('sid', 'ghost');
    h.se.bumpProjectionEpoch('sid');
    h.se.dropPendingPush('sid');

    assert.equal(h.se.versionGet('sid', 'alpha'), undefined);
    assert.equal(h.se.baselineGet('sid', 'alpha'), undefined);
    assert.equal(h.se.tagsGet('alpha'), undefined);
    assert.equal(h.se.staleHas('sid', 'alpha'), false);
    assert.equal(h.se.isSelfWrite('sid', 'alpha'), false);
    assert.equal(h.se.hasUnconfirmedMissing('sid'), false);

    // 旧 tab 尚未移除时，迟到 onConnected 也不得复活会话。
    await h.se.onConnected('sid');
    await settle();
    assert.equal(h.se.versionGet('sid', 'alpha'), undefined);
    assert.equal(h.se.baselineGet('sid', 'alpha'), undefined);

    // 新 tab 所有者出现后才是真正的生命周期重开：状态只来自服务端，迟到调用没有种入任何东西。
    h.replaceOwnerTab();
    await h.se.onConnected('sid');
    await settle();
    assert.equal(h.se.versionGet('sid', 'alpha'), 3);
    assert.equal(h.se.baselineGet('sid', 'alpha').text, 'server');
    assert.equal(h.se.isSelfWrite('sid', 'alpha'), false);
    assert.equal(h.state.nodes.some((n) => n.id === 's-ghost'), true);
    assert.equal(h.remote.has('beta'), false);
    assert.equal(h.calls.some((c) => c.method === 'stream.write' && c.params.name === 'beta'), false);
  });

  await runCase('pre-connect pending push still replays on first lifecycle connect', async () => {
    const h = makeHarness({
      rows: [remoteRow('alpha', 'server', 1)],
      nodes: [loadedNode('alpha', 'server')],
    });
    h.se.stashPendingPush('sid', [loadedNode('beta', 'pending beta')]);
    await h.se.onConnected('sid');
    await waitFor(() => h.remote.has('beta'), 'pending beta created on first connect');
    assert.equal(h.remote.get('beta').text, 'pending beta');
    assert.equal(h.remote.get('alpha').text, 'server');
  });

  await runCase('delayed read completion cannot mutate a reopened session', async () => {
    let releaseRead = null;
    const gate = new Promise((resolve) => { releaseRead = resolve; });
    const h = makeHarness({
      rows: [remoteRow('alpha', 'server old', 1)],
      nodes: [loadedNode('alpha', 'local old')],
      overrides: {
        'stream.read': async () => {
          await gate;
          return { text: 'late old text' };
        },
        'stream.get_metadata': async () => ({ version: 9, description: '', tags: {} }),
      },
    });
    const pending = h.se.readContent('s-alpha', 'sid');
    await settle();
    await h.se.closeSystem('sid');
    // 新 tab 所有者 + 显式生命周期重开（订阅）建立全新会话；迟到的旧回包只能作废。
    h.replaceOwnerTab();
    const off = h.se.subscribeStatuses(['sid']);
    h.se.baselineSet('sid', 'alpha', 50, 'new baseline');
    releaseRead();
    await pending;
    off();

    assert.equal(h.se.versionGet('sid', 'alpha'), 50);
    assert.equal(h.se.baselineGet('sid', 'alpha').text, 'new baseline');
    assert.equal(h.state.nodes[0].data.content, 'local old');
  });

  await runCase('delayed projection completion cannot mutate a reopened session', async () => {
    let releaseList = null;
    const gate = new Promise((resolve) => { releaseList = resolve; });
    const h = makeHarness({
      rows: [remoteRow('alpha', 'server old', 1)],
      nodes: [loadedNode('alpha', 'local old')],
      overrides: {
        'stream.list': async () => {
          await gate;
          return [remoteRow('alpha', 'late remote', 99)];
        },
      },
    });
    const pending = h.se.reproject('sid');
    await settle();
    await h.se.closeSystem('sid');
    // 新 tab 所有者 + 显式生命周期重开（订阅）建立全新会话；迟到的旧投影不得落地。
    h.replaceOwnerTab();
    const off = h.se.subscribeStatuses(['sid']);
    h.se.baselineSet('sid', 'alpha', 50, 'new baseline');
    releaseList();
    await pending;
    off();

    assert.equal(h.se.versionGet('sid', 'alpha'), 50);
    assert.equal(h.se.baselineGet('sid', 'alpha').text, 'new baseline');
    assert.equal(h.state.nodes[0].data.content, 'local old');
  });
}

main()
  .catch((err) => check('test execution', false, err?.stack || String(err)))
  .finally(() => {
    sePool.get = original.get;
    sePool.onStatus = original.onStatus;
    sePool.release = original.release;
    globalThis.fetch = original.fetch;
    const failed = results.filter((r) => !r.ok);
    console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
    process.exit(failed.length ? 1 : 0);
  });
