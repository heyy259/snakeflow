// Automatic file→SE synchronization regressions (zero SE, zero DOM).
// Contract: W1 load push / W2 pending replay / W3 reconnect may create missing streams,
// but existing streams are refreshed by SE readback and are never overwritten by stale
// local text or metadata. Inactive reads must not advance baselines without node updates.
// Run: node scripts/smoke-se-stream-sync-unit.mjs
import assert from 'node:assert/strict';
import { createSeOrchestrator } from '../src/se/orchestrator.js';
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
const unknownNode = (name, extra = {}) => ({
  id: `s-${name}`,
  position: { x: 0, y: 0 },
  data: { name, contentState: 'unknown', ...extra },
});
const ownedSource = (name) => ({ file_path: `图 A.streams/${name}.md`, encoding: 'utf-8' });
const sourcedNode = (name, content, extra = {}) =>
  loadedNode(name, content, { source: ownedSource(name), ...extra });
const remoteRow = (name, text, version = 1, extra = {}) => ({
  name,
  text,
  version,
  description: '',
  tags: {},
  ...extra,
});

function makeHarness(rows, nodes, overrides = {}, options = {}) {
  const remote = new Map(rows.map((row) => [row.name, clone(row)]));
  const state = {
    activeSystemId: 'sid',
    activeTabId: 'tab-sid',
    offline: false,
    nodes: clone(nodes),
    edges: [],
  };
  const calls = [];
  let statusListener = null;
  let editingNodeId = null;

  const metadata = (row) => ({
    name: row.name,
    version: row.version,
    description: row.description || '',
    tags: clone(row.tags || {}),
  });
  const subscriptions = [];
  const client = {
    status: SE_STATUS.ONLINE,
    subscribe: (events, listener) => {
      const entry = { events: Array.isArray(events) ? events : [], listener };
      subscriptions.push(entry);
      return () => {
        const index = subscriptions.indexOf(entry);
        if (index >= 0) subscriptions.splice(index, 1);
      };
    },
    call: async (method, params = {}) => {
      calls.push({ method, params: clone(params) });
      if (overrides[method]) return overrides[method](params, remote);
      if (method === 'stream.list') {
        return [...remote.values()].map((row) => metadata(row));
      }
      if (method === 'stream.read') {
        const row = remote.get(String(params.name));
        if (!row) {
          const err = new Error('stream missing');
          err.code = -32002;
          throw err;
        }
        return { text: row.text };
      }
      if (method === 'stream.get_metadata') {
        const row = remote.get(String(params.name));
        if (!row) {
          const err = new Error('stream missing');
          err.code = -32002;
          throw err;
        }
        return metadata(row);
      }
      if (method === 'stream.create') {
        const name = String(params.name);
        if (remote.has(name)) {
          const err = new Error('already exists');
          err.code = -33002;
          throw err;
        }
        const row = remoteRow(name, '', 1, {
          description: params.description || '',
          tags: clone(params.tags || {}),
        });
        remote.set(name, row);
        return metadata(row);
      }
      if (method === 'stream.write') {
        const row = remote.get(String(params.name));
        if (!row) {
          const err = new Error('stream missing');
          err.code = -32002;
          throw err;
        }
        if (
          options.strictCas &&
          (params.expected_version == null || Number(params.expected_version) !== Number(row.version))
        ) {
          const err = new Error('stream version conflict');
          err.code = -32010;
          throw err;
        }
        row.text = params.text != null ? String(params.text) : '';
        row.version += 1;
        return { version: row.version };
      }
      if (method === 'stream.update_description') {
        const row = remote.get(String(params.name));
        if (row) row.description = params.text != null ? String(params.text) : '';
        return {};
      }
      if (method === 'stream.set_tag') {
        const row = remote.get(String(params.name));
        if (row) row.tags[String(params.key)] = params.value == null ? '' : String(params.value);
        return {};
      }
      if (method === 'stream.remove_tag') {
        const row = remote.get(String(params.name));
        if (row) delete row.tags[String(params.key)];
        return {};
      }
      if (method === 'tool.list' || method === 'tool.list_processes') return [];
      if (method === 'tool.unregister') {
        const err = new Error('name required');
        err.code = -32602;
        throw err;
      }
      return {};
    },
  };

  const setNodes = (update) => {
    state.nodes = typeof update === 'function' ? update(state.nodes) : update;
  };
  const port = {
    getActiveSystemId: () => state.activeSystemId,
    getActiveTabId: () => state.activeTabId,
    getTabs: () => [
      { id: 'tab-sid', name: '图 A', system: { system_id: 'sid' } },
      { id: 'tab-other', name: '图 B', system: { system_id: 'other' } },
    ],
    getStoreGraph: (tabId) => tabId === 'tab-sid' ? { nodes: state.nodes, edges: state.edges, tools: {} } : null,
    getNodes: () => state.nodes,
    setNodes,
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
    getEditingNodeId: () => editingNodeId,
    notify: () => {},
    setStatus: () => {},
    setSeStatus: () => {},
    setCanManageTools: () => {},
    onToolStatus: () => {},
    toolsForSystem: () => ({}),
    baseDirForSystem: () => '',
    recordToolFailures: () => 0,
    callAlignEdges: () => Promise.resolve(),
    callPromotePending: () => Promise.resolve(),
  };

  sePool.get = () => client;
  sePool.onStatus = (_sid, listener) => {
    statusListener = listener;
    return () => { if (statusListener === listener) statusListener = null; };
  };
  const se = createSeOrchestrator(() => port);
  return {
    se,
    remote,
    calls,
    state,
    setNodes,
    setEditingNodeId(nodeId) {
      editingNodeId = nodeId;
    },
    emit(status) {
      client.status = status;
      state.offline = status === SE_STATUS.OFFLINE;
      if (statusListener) statusListener(status);
    },
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

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const coldConnect = async (h) => {
  h.se.stashPendingPush('sid', h.state.nodes);
  await h.se.onConnected('sid');
  await settle();
};
const writesFor = (h, name) =>
  h.calls.filter((c) => c.method === 'stream.write' && (!name || c.params.name === name));
const nodeFor = (h, name) => h.state.nodes.find((n) => n.id === `s-${name}`);

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

const originalGet = sePool.get;
const originalOnStatus = sePool.onStatus;

async function main() {
  await runCase('W1 existing+missing: create only, read back existing text/metadata/baseline', async () => {
    const h = makeHarness(
      [remoteRow('alpha', 'server alpha', 4, { description: 'server description', tags: { role: 'server' } })],
      [
        loadedNode('alpha', 'stale local alpha', { description: 'local description', fields: [{ key: 'role', value: 'local' }] }),
        loadedNode('beta', 'new local beta'),
      ]
    );
    const res = await h.se.pushFileStreams('sid', h.state.nodes);
    await settle();
    assert.equal(res.ok, true);
    assert.equal(res.summary.streams.created, 1);
    assert.equal(res.summary.streams.updated, 0);
    assert.equal(h.remote.get('alpha').text, 'server alpha');
    assert.equal(h.remote.get('alpha').description, 'server description');
    assert.deepEqual(h.remote.get('alpha').tags, { role: 'server' });
    assert.equal(h.remote.get('beta').text, 'new local beta');
    assert.deepEqual(
      h.calls.filter((c) => c.method === 'stream.write').map((c) => c.params.name),
      ['beta']
    );
    assert.equal(h.calls.some((c) => c.method === 'stream.update_description' && c.params.name === 'alpha'), false);
    assert.equal(h.calls.some((c) => (c.method === 'stream.set_tag' || c.method === 'stream.remove_tag') && c.params.name === 'alpha'), false);
    const alpha = h.state.nodes.find((n) => n.id === 's-alpha');
    assert.equal(alpha.data.content, 'server alpha');
    assert.equal(alpha.data.description, 'server description');
    assert.deepEqual(alpha.data.fields, [{ key: 'role', value: 'server' }]);
    assert.equal(h.se.versionGet('sid', 'alpha'), 4);
    assert.deepEqual(h.se.baselineGet('sid', 'alpha'), {
      version: 4,
      text: 'server alpha',
      authoritative: true,
      source: 'read',
    });
  });

  await runCase('already-exists race: create fallback cannot write or mutate metadata', async () => {
    const h = makeHarness(
      [],
      [loadedNode('alpha', 'stale local alpha', { description: 'local', fields: [{ key: 'role', value: 'local' }] })],
      {
        'stream.create': async () => {
          const err = new Error('already exists');
          err.code = -33002;
          throw err;
        },
      }
    );
    const res = await h.se.pushFileStreams('sid', h.state.nodes);
    assert.equal(res.ok, true);
    assert.equal(res.summary.streams.skipped, 1);
    assert.equal(res.summary.streams.updated, 0);
    assert.equal(h.calls.some((c) => c.method === 'stream.write'), false);
    assert.equal(h.calls.some((c) => c.method === 'stream.update_description' || c.method === 'stream.set_tag' || c.method === 'stream.remove_tag'), false);
  });

  await runCase('unknown local content: existing stream is read back instead of skipped', async () => {
    const h = makeHarness(
      [remoteRow('alpha', 'authoritative remote', 9)],
      [{ id: 's-alpha', position: { x: 0, y: 0 }, data: { name: 'alpha', contentState: 'unknown' } }]
    );
    const res = await h.se.pushFileStreams('sid', h.state.nodes);
    await settle();
    assert.equal(res.ok, true);
    assert.equal(res.summary, null);
    assert.equal(h.calls.some((c) => c.method === 'stream.read' && c.params.name === 'alpha'), true);
    assert.equal(h.calls.some((c) => c.method === 'stream.get_metadata' && c.params.name === 'alpha'), true);
    assert.equal(h.state.nodes[0].data.content, 'authoritative remote');
    assert.equal(h.state.nodes[0].data.contentState, 'loaded');
    assert.equal(h.se.versionGet('sid', 'alpha'), 9);
    assert.equal(h.se.baselineGet('sid', 'alpha').authoritative, true);
    assert.equal(h.calls.some((c) => c.method === 'stream.write'), false);
  });

  await runCase('inactive read: no version/content baseline advance without a node update', async () => {
    const h = makeHarness(
      [remoteRow('alpha', 'remote new', 9)],
      [loadedNode('alpha', 'local old')]
    );
    const off = h.se.subscribeStatuses(['sid']);
    h.se.baselineSet('sid', 'alpha', 1, 'local old');
    h.state.activeSystemId = 'other';
    h.state.activeTabId = 'tab-other';
    await h.se.readContent('s-alpha', 'sid');
    off();
    assert.equal(h.state.nodes[0].data.content, 'local old');
    assert.equal(h.se.versionGet('sid', 'alpha'), 1);
    assert.deepEqual(h.se.baselineGet('sid', 'alpha'), {
      version: 1,
      text: 'local old',
      authoritative: true,
      source: 'commit',
    });
  });

  await runCase('reproject: existing non-authoritative local seed still triggers readback', async () => {
    const h = makeHarness(
      [remoteRow('alpha', 'remote current', 3)],
      [loadedNode('alpha', 'stale cached')]
    );
    const off = h.se.subscribeStatuses(['sid']);
    await h.se.reproject('sid');
    await settle();
    off();
    assert.equal(h.calls.some((c) => c.method === 'stream.read' && c.params.name === 'alpha'), true);
    assert.equal(h.state.nodes[0].data.content, 'remote current');
    assert.equal(h.se.versionGet('sid', 'alpha'), 3);
    assert.equal(h.se.baselineGet('sid', 'alpha').text, 'remote current');
    assert.equal(h.se.baselineGet('sid', 'alpha').authoritative, true);
  });

  await runCase('event→tab switch: discarded readback is caught up on reactivation', async () => {
    const h = makeHarness(
      [remoteRow('alpha', 'server v1', 1)],
      [loadedNode('alpha', 'server v1')]
    );
    await h.se.onConnected('sid');
    await settle();
    h.se.baselineSet('sid', 'alpha', 1, 'server v1');

    h.remote.get('alpha').text = 'server v2';
    h.remote.get('alpha').version = 2;
    h.emitStreamChange({ name: 'alpha', version: 2, change: { type: 'set' } });
    assert.equal(h.se.versionGet('sid', 'alpha'), 2);

    h.state.activeSystemId = 'other';
    h.state.activeTabId = 'tab-other';
    await new Promise((resolve) => setTimeout(resolve, 180));
    await settle();

    const stale = h.state.nodes.find((n) => n.id === 's-alpha');
    assert.equal(stale.data.content, 'server v1');
    assert.equal(h.se.versionGet('sid', 'alpha'), 2);
    assert.equal(h.se.baselineGet('sid', 'alpha').text, 'server v1');

    h.state.activeSystemId = 'sid';
    h.state.activeTabId = 'tab-sid';
    await h.se.reproject('sid');
    await waitFor(() => {
      const node = h.state.nodes.find((n) => n.id === 's-alpha');
      const baseline = h.se.baselineGet('sid', 'alpha');
      return node.data.content === 'server v2' && baseline.text === 'server v2' && baseline.version === 2;
    }, 'reactivation content catchup');

    const node = h.state.nodes.find((n) => n.id === 's-alpha');
    assert.equal(node.data.content, 'server v2');
    assert.notEqual(node.data.content, 'server v1');
    assert.deepEqual(h.se.baselineGet('sid', 'alpha'), {
      version: 2,
      text: 'server v2',
      authoritative: true,
      source: 'read',
    });
  });

  await runCase('append→tab switch before debounce: read skipped, stale authority revoked, reactivation catches up v2', async () => {
    const h = makeHarness(
      [remoteRow('alpha', 'server v1', 1)],
      [loadedNode('alpha', 'server v1')]
    );
    await h.se.onConnected('sid');
    await settle();
    h.se.baselineSet('sid', 'alpha', 1, 'server v1');

    h.remote.get('alpha').text = 'server v1-appended';
    h.remote.get('alpha').version = 2;
    h.emitStreamChange({ name: 'alpha', version: 2, change: { type: 'append' } });
    assert.equal(h.se.versionGet('sid', 'alpha'), 2);

    const readMark = h.calls.length;
    h.state.activeSystemId = 'other';
    h.state.activeTabId = 'tab-other';
    await new Promise((resolve) => setTimeout(resolve, 180));
    await settle();

    assert.equal(
      h.calls.slice(readMark).some((c) => c.method === 'stream.read' && c.params.name === 'alpha'),
      false
    );
    const stale = h.state.nodes.find((n) => n.id === 's-alpha');
    assert.equal(stale.data.content, 'server v1');
    assert.equal(h.se.versionGet('sid', 'alpha'), 2);
    assert.deepEqual(h.se.baselineGet('sid', 'alpha'), {
      version: 1,
      text: 'server v1',
      authoritative: false,
      source: 'stale',
    });

    h.state.activeSystemId = 'sid';
    h.state.activeTabId = 'tab-sid';
    await h.se.reproject('sid');
    await waitFor(() => {
      const node = h.state.nodes.find((n) => n.id === 's-alpha');
      const baseline = h.se.baselineGet('sid', 'alpha');
      return node.data.content === 'server v1-appended' && baseline.text === 'server v1-appended' && baseline.version === 2;
    }, 'append debounce reactivation content catchup');

    assert.deepEqual(h.se.baselineGet('sid', 'alpha'), {
      version: 2,
      text: 'server v1-appended',
      authoritative: true,
      source: 'read',
    });
  });

  await runCase('append→switch during RPC: response discarded, authority revoked, reactivation catches up v2', async () => {
    let harness = null;
    let switchOnRead = false;
    const h = makeHarness(
      [remoteRow('alpha', 'server v1', 1)],
      [loadedNode('alpha', 'server v1')],
      {
        'stream.read': async (params, remote) => {
          if (switchOnRead && params.name === 'alpha' && params.start !== undefined) {
            switchOnRead = false;
            harness.state.activeSystemId = 'other';
            harness.state.activeTabId = 'tab-other';
          }
          return { text: remote.get(String(params.name)).text };
        },
      }
    );
    harness = h;
    await h.se.onConnected('sid');
    await settle();
    h.se.baselineSet('sid', 'alpha', 1, 'server v1');

    h.remote.get('alpha').text = 'server v1-appended';
    h.remote.get('alpha').version = 2;
    switchOnRead = true;
    const readMark = h.calls.length;
    h.emitStreamChange({ name: 'alpha', version: 2, change: { type: 'append' } });
    await waitFor(
      () => h.calls.slice(readMark).some(
        (c) => c.method === 'stream.read' && c.params.name === 'alpha' && c.params.start !== undefined
      ),
      'append RPC started'
    );
    await settle();

    const stale = h.state.nodes.find((n) => n.id === 's-alpha');
    assert.equal(stale.data.content, 'server v1');
    assert.equal(h.se.versionGet('sid', 'alpha'), 2);
    assert.deepEqual(h.se.baselineGet('sid', 'alpha'), {
      version: 1,
      text: 'server v1',
      authoritative: false,
      source: 'stale',
    });

    h.state.activeSystemId = 'sid';
    h.state.activeTabId = 'tab-sid';
    await h.se.reproject('sid');
    await waitFor(() => {
      const node = h.state.nodes.find((n) => n.id === 's-alpha');
      const baseline = h.se.baselineGet('sid', 'alpha');
      return node.data.content === 'server v1-appended' && baseline.text === 'server v1-appended' && baseline.version === 2;
    }, 'append RPC reactivation content catchup');

    assert.deepEqual(h.se.baselineGet('sid', 'alpha'), {
      version: 2,
      text: 'server v1-appended',
      authoritative: true,
      source: 'read',
    });
  });

  await runCase('append discard without pending version gap: inactive authority is not revoked', async () => {
    const h = makeHarness(
      [remoteRow('alpha', 'server v1', 1)],
      [loadedNode('alpha', 'server v1')]
    );
    await h.se.onConnected('sid');
    await settle();
    h.se.baselineSet('sid', 'alpha', 1, 'server v1');

    h.emitStreamChange({ name: 'alpha', change: { type: 'append' } });
    assert.equal(h.se.versionGet('sid', 'alpha'), 1);

    const readMark = h.calls.length;
    h.state.activeSystemId = 'other';
    h.state.activeTabId = 'tab-other';
    await new Promise((resolve) => setTimeout(resolve, 180));
    await settle();

    assert.equal(
      h.calls.slice(readMark).some((c) => c.method === 'stream.read' && c.params.name === 'alpha'),
      false
    );
    assert.deepEqual(h.se.baselineGet('sid', 'alpha'), {
      version: 1,
      text: 'server v1',
      authoritative: true,
      source: 'commit',
    });
    assert.equal(h.se.versionGet('sid', 'alpha'), 1);
    assert.equal(h.state.nodes.find((n) => n.id === 's-alpha').data.content, 'server v1');
  });

  await runCase('W2 pending replay: missing stream is created; existing stream is not overwritten', async () => {
    const h = makeHarness(
      [remoteRow('alpha', 'server alpha', 2)],
      [loadedNode('alpha', 'server alpha')]
    );
    h.se.stashPendingPush('sid', [
      loadedNode('alpha', 'stale pending alpha'),
      loadedNode('beta', 'pending beta'),
    ]);
    await h.se.onConnected('sid');
    await waitFor(() => h.remote.get('beta')?.text === 'pending beta', 'pending beta creation');
    await settle();
    assert.equal(h.remote.get('alpha').text, 'server alpha');
    assert.equal(h.remote.get('beta').text, 'pending beta');
    assert.equal(h.calls.some((c) => c.method === 'stream.write' && c.params.name === 'alpha'), false);
  });

  await runCase('W3 reconnect: partial and empty registries both use create-only document recovery', async () => {
    const h = makeHarness(
      [remoteRow('alpha', 'server before', 2)],
      [loadedNode('alpha', 'server before')]
    );
    await h.se.onConnected('sid');
    await settle();
    const off = h.se.subscribeStatuses(['sid']);
    h.emit(SE_STATUS.ONLINE); // first status seed: ever-online, not a reconnect

    h.setNodes((nodes) => [...nodes, loadedNode('beta', 'document beta')]);
    h.remote.get('alpha').text = 'server after';
    h.remote.get('alpha').version = 5;
    h.emit(SE_STATUS.OFFLINE);
    const partialStart = h.calls.length;
    h.emit(SE_STATUS.ONLINE);
    await waitFor(() => h.remote.has('beta'), 'partial reconnect create');
    await settle();
    assert.equal(h.remote.get('alpha').text, 'server after');
    assert.equal(h.remote.get('beta').text, 'document beta');
    assert.equal(h.calls.slice(partialStart).some((c) => c.method === 'stream.write' && c.params.name === 'alpha'), false);
    assert.equal(h.state.nodes.find((n) => n.id === 's-alpha').data.content, 'server after');

    const expected = new Map(h.state.nodes.map((n) => [n.data.name, String(n.data.content || '')]));
    h.remote.clear();
    h.emit(SE_STATUS.OFFLINE);
    h.emit(SE_STATUS.ONLINE);
    await waitFor(() => h.remote.size === 2, 'empty reconnect recreate');
    await settle();
    assert.equal(h.remote.get('alpha').text, expected.get('alpha'));
    assert.equal(h.remote.get('beta').text, expected.get('beta'));
    off();
  });

  await runCase('W3b reconnect: non-loaded document stream is recreated create-only (no content write)', async () => {
    const h = makeHarness(
      [remoteRow('alpha', 'server alpha', 2)],
      [loadedNode('alpha', 'server alpha')]
    );
    await h.se.onConnected('sid');
    await settle();
    const off = h.se.subscribeStatuses(['sid']);
    h.emit(SE_STATUS.ONLINE);
    h.setNodes((nodes) => [
      ...nodes,
      { id: 's-beta', position: { x: 0, y: 0 }, data: { name: 'beta', contentState: 'unknown' } },
    ]);
    h.remote.clear();
    h.emit(SE_STATUS.OFFLINE);
    const createMark = h.calls.length;
    h.emit(SE_STATUS.ONLINE);
    await waitFor(() => h.remote.size === 2, 'non-loaded reconnect create');
    await settle();
    assert.equal(h.remote.get('alpha').text, 'server alpha');
    assert.equal(h.remote.get('beta').text, '');
    const betaCalls = h.calls.slice(createMark).filter((c) => c.params && c.params.name === 'beta');
    assert.equal(betaCalls.filter((c) => c.method === 'stream.create').length, 1);
    assert.equal(betaCalls.some((c) => c.method === 'stream.write'), false);
    off();
  });

  await runCase('W3c reconnect: reserved/foreign document names are never public-created', async () => {
    const h = makeHarness(
      [remoteRow('alpha', 'server alpha', 2)],
      [loadedNode('alpha', 'server alpha')]
    );
    await h.se.onConnected('sid');
    await settle();
    const off = h.se.subscribeStatuses(['sid']);
    h.emit(SE_STATUS.ONLINE);
    h.setNodes((nodes) => [
      ...nodes,
      loadedNode('ghost_console', 'console text'),
      loadedNode('foreign', 'foreign text', { source: { file_path: '别的图.streams/foreign.md' } }),
    ]);
    h.remote.clear();
    h.emit(SE_STATUS.OFFLINE);
    const createMark = h.calls.length;
    h.emit(SE_STATUS.ONLINE);
    await waitFor(() => h.remote.has('alpha'), 'alpha recreate');
    await settle();
    assert.equal(h.remote.has('ghost_console'), false);
    assert.equal(h.remote.has('foreign'), false);
    const created = h.calls
      .slice(createMark)
      .filter((c) => c.method === 'stream.create')
      .map((c) => c.params.name);
    assert.equal(created.includes('ghost_console'), false);
    assert.equal(created.includes('foreign'), false);
    off();
  });

  await runCase('reproject: selection survives only for still-visible same-id nodes', async () => {
    const h = makeHarness(
      [
        remoteRow('alpha', 'server alpha', 1),
        remoteRow('beta', 'server beta', 1, { tags: { canvas: 'false' } }),
      ],
      [
        { id: 's-alpha', position: { x: 0, y: 0 }, selected: true, data: { name: 'alpha', content: 'server alpha', contentState: 'loaded' } },
        { id: 's-beta', position: { x: 0, y: 0 }, selected: true, data: { name: 'beta', content: 'server beta', contentState: 'loaded' } },
      ]
    );
    const off = h.se.subscribeStatuses(['sid']);
    await h.se.reproject('sid');
    await settle();
    off();
    const alpha = h.state.nodes.find((n) => n.id === 's-alpha');
    const beta = h.state.nodes.find((n) => n.id === 's-beta');
    assert.equal(alpha.selected, true);
    assert.equal(beta.selected, undefined);
  });

  await runCase('C+ cold stash: source-backed nodes seed file-hydrated provenance only', async () => {
    const missing = sourcedNode('missing', 'missing file');
    const internal = sourcedNode('job_console', 'console file');
    const nonS = { ...sourcedNode('local', 'local file'), id: 'n-local' };
    const h = makeHarness(
      [],
      [
        sourcedNode('alpha', 'alpha file'),
        unknownNode('unknown', { source: ownedSource('unknown') }),
        missing,
        internal,
        loadedNode('inline', 'inline only'),
        unknownNode('no-source'),
        nonS,
      ],
      {},
      { strictCas: true }
    );
    h.se.stashPendingPush('sid', h.state.nodes);

    for (const [name, text] of [
      ['alpha', 'alpha file'],
      ['unknown', ''],
      ['missing', 'missing file'],
      ['job_console', 'console file'],
    ]) {
      assert.deepEqual(h.se.baselineGet('sid', name), {
        version: undefined,
        text,
        authoritative: false,
        source: 'file-hydrated',
      });
    }
    for (const name of ['inline', 'no-source', 'local']) {
      assert.equal(h.se.baselineGet('sid', name), undefined);
    }
  });

  await runCase('C+ eligible cold difference: exactly one direct strict-CAS write retains the file node', async () => {
    const h = makeHarness(
      [remoteRow('alpha', 'stale SE', 4)],
      [sourcedNode('alpha', 'fresh file')],
      {},
      { strictCas: true }
    );
    await coldConnect(h);

    const writes = writesFor(h, 'alpha');
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].params, {
      name: 'alpha',
      text: 'fresh file',
      expected_version: 4,
    });
    assert.equal(h.remote.get('alpha').text, 'fresh file');
    assert.equal(h.remote.get('alpha').version, 5);
    assert.equal(nodeFor(h, 'alpha').data.content, 'fresh file');
    assert.deepEqual(nodeFor(h, 'alpha').data.source, ownedSource('alpha'));
    assert.deepEqual(h.se.baselineGet('sid', 'alpha'), {
      version: 5,
      text: 'fresh file',
      authoritative: true,
      source: 'commit',
    });

    h.remote.get('alpha').text = 'newer SE';
    h.remote.get('alpha').version = 6;
    await h.se.readContent('s-alpha', 'sid');
    assert.equal(nodeFor(h, 'alpha').data.content, 'newer SE');
    assert.deepEqual(h.se.baselineGet('sid', 'alpha'), {
      version: 6,
      text: 'newer SE',
      authoritative: true,
      source: 'read',
    });
  });

  await runCase('C+ torn cold snapshot: external v5 between text and metadata is never overwritten', async () => {
    let firstRead = true;
    const h = makeHarness(
      [remoteRow('alpha', 'stale v4', 4)],
      [sourcedNode('alpha', 'fresh file')],
      {
        'stream.read': async (params, remote) => {
          const row = remote.get(String(params.name));
          const text = row.text;
          if (firstRead) {
            firstRead = false;
            row.text = 'concurrent v5';
            row.version = 5;
          }
          return { text };
        },
      },
      { strictCas: true }
    );
    await coldConnect(h);

    const snapshotCalls = h.calls
      .filter(
        (c) =>
          c.params.name === 'alpha' &&
          (c.method === 'stream.read' || c.method === 'stream.get_metadata')
      )
      .slice(0, 3)
      .map((c) => c.method);
    assert.deepEqual(snapshotCalls, ['stream.get_metadata', 'stream.read', 'stream.get_metadata']);
    assert.equal(writesFor(h, 'alpha').length, 0);
    assert.equal(h.remote.get('alpha').text, 'concurrent v5');
    assert.equal(h.remote.get('alpha').version, 5);
    assert.equal(nodeFor(h, 'alpha').data.content, 'fresh file');
    assert.deepEqual(h.se.baselineGet('sid', 'alpha'), {
      version: 5,
      text: 'concurrent v5',
      authoritative: true,
      source: 'file-preserved',
    });
  });

  await runCase('C+ equal cold content: zero writes and resolved readback stays normal', async () => {
    const h = makeHarness(
      [remoteRow('alpha', 'same text', 3)],
      [sourcedNode('alpha', 'same text')],
      {},
      { strictCas: true }
    );
    await coldConnect(h);

    assert.equal(writesFor(h, 'alpha').length, 0);
    assert.equal(nodeFor(h, 'alpha').data.content, 'same text');
    assert.deepEqual(h.se.baselineGet('sid', 'alpha'), {
      version: 3,
      text: 'same text',
      authoritative: true,
      source: 'read',
    });

    h.remote.get('alpha').text = 'later SE';
    h.remote.get('alpha').version = 4;
    await h.se.readContent('s-alpha', 'sid');
    assert.equal(nodeFor(h, 'alpha').data.content, 'later SE');
    assert.equal(h.se.baselineGet('sid', 'alpha').source, 'read');
    assert.equal(h.se.baselineGet('sid', 'alpha').version, 4);
  });

  await runCase('C+ excluded live nodes: zero startup writes and file-preserved raw SE baselines', async () => {
    const h = makeHarness(
      [
        remoteRow('scan', 'SE scan', 2),
        remoteRow('foreign', 'SE foreign', 3),
        remoteRow('job_console', 'SE console', 4),
        remoteRow('unknown', 'SE unknown', 5),
      ],
      [
        sourcedNode('scan', 'file scan', { scan: { state: 'scanning' } }),
        sourcedNode('foreign', 'file foreign', { source: { file_path: '别的图.streams/foreign.md' } }),
        sourcedNode('job_console', 'file console'),
        unknownNode('unknown', { source: ownedSource('unknown') }),
      ],
      {},
      { strictCas: true }
    );
    await coldConnect(h);

    assert.equal(writesFor(h).length, 0);
    for (const [name, text] of [
      ['scan', 'file scan'],
      ['foreign', 'file foreign'],
      ['job_console', 'file console'],
    ]) {
      assert.equal(nodeFor(h, name).data.content, text);
    }
    assert.equal(nodeFor(h, 'unknown').data.content, undefined);
    assert.equal(nodeFor(h, 'unknown').data.contentState, 'unknown');
    for (const [name, version, text, authoritative] of [
      ['scan', 2, 'SE scan', true],
      ['foreign', 3, 'SE foreign', true],
      ['job_console', 4, 'SE console', false],
      ['unknown', 5, 'SE unknown', true],
    ]) {
      assert.deepEqual(h.se.baselineGet('sid', name), {
        version,
        text,
        authoritative,
        source: 'file-preserved',
      });
    }
  });

  await runCase('C+ missing cold stream: create-only recovery never writes or replaces file text', async () => {
    const h = makeHarness(
      [remoteRow('anchor', 'SE anchor', 1)],
      [sourcedNode('missing', 'missing file')],
      {},
      { strictCas: true }
    );
    await coldConnect(h);

    assert.equal(
      h.calls.some((c) => c.method === 'stream.create' && c.params.name === 'missing'),
      true
    );
    assert.equal(writesFor(h, 'missing').length, 0);
    assert.equal(h.remote.get('missing').text, '');
    assert.equal(nodeFor(h, 'missing').data.content, 'missing file');
    assert.deepEqual(nodeFor(h, 'missing').data.source, ownedSource('missing'));
    assert.deepEqual(h.se.baselineGet('sid', 'missing'), {
      version: 1,
      text: '',
      authoritative: true,
      source: 'file-preserved',
    });
  });

  await runCase('C+ excluded reads: same SE version preserves, newer SE version restores readback', async () => {
    const h = makeHarness(
      [remoteRow('alpha', 'SE original', 2)],
      [unknownNode('alpha', { source: ownedSource('alpha') })],
      {},
      { strictCas: true }
    );
    await coldConnect(h);

    assert.equal(nodeFor(h, 'alpha').data.contentState, 'unknown');
    assert.equal(nodeFor(h, 'alpha').data.content, undefined);
    assert.deepEqual(h.se.baselineGet('sid', 'alpha'), {
      version: 2,
      text: 'SE original',
      authoritative: true,
      source: 'file-preserved',
    });
    await h.se.readContent('s-alpha', 'sid');
    assert.equal(nodeFor(h, 'alpha').data.contentState, 'unknown');
    assert.equal(nodeFor(h, 'alpha').data.content, undefined);
    assert.equal(h.se.baselineGet('sid', 'alpha').source, 'file-preserved');

    h.remote.get('alpha').text = 'SE newer';
    h.remote.get('alpha').version = 3;
    await h.se.readContent('s-alpha', 'sid');
    assert.equal(nodeFor(h, 'alpha').data.contentState, 'loaded');
    assert.equal(nodeFor(h, 'alpha').data.content, 'SE newer');
    assert.deepEqual(h.se.baselineGet('sid', 'alpha'), {
      version: 3,
      text: 'SE newer',
      authoritative: true,
      source: 'read',
    });
    assert.equal(writesFor(h, 'alpha').length, 0);
  });

  await runCase('C+ successful scan marker deletion: cold exclusion hands off to authoritative delete readback', async () => {
    const markedText = 'scan result\n@{tool|params}\n';
    const cleanText = 'scan result\n';
    const h = makeHarness(
      [remoteRow('job', markedText, 1)],
      [sourcedNode('job', markedText, { scan: { state: 'scanning' } })],
      {},
      { strictCas: true }
    );
    await coldConnect(h);

    assert.equal(nodeFor(h, 'job').data.content, markedText);
    assert.deepEqual(h.se.baselineGet('sid', 'job'), {
      version: 1,
      text: markedText,
      authoritative: true,
      source: 'file-preserved',
    });
    assert.equal(writesFor(h, 'job').length, 0);

    h.setNodes((nodes) =>
      nodes.map((node) =>
        node.id === 's-job'
          ? { ...node, data: { ...node.data, scan: { ...node.data.scan, state: 'idle' } } }
          : node
      )
    );
    h.remote.get('job').text = cleanText;
    h.remote.get('job').version = 2;
    h.emitStreamChange({ name: 'job', version: 2, change: { type: 'delete' } });
    await new Promise((resolve) => setTimeout(resolve, 180));
    await settle();

    assert.equal(nodeFor(h, 'job').data.content, cleanText);
    assert.equal(h.remote.get('job').text, cleanText);
    assert.equal(writesFor(h, 'job').length, 0);
    assert.deepEqual(h.se.baselineGet('sid', 'job'), {
      version: 2,
      text: cleanText,
      authoritative: true,
      source: 'read',
    });
  });

  await runCase('C+ cold CAS conflict: no stale readback injection or repeated startup write', async () => {
    const h = makeHarness(
      [remoteRow('alpha', 'stale SE', 4)],
      [sourcedNode('alpha', 'fresh file')],
      {
        'stream.write': async (params, remote) => {
          const row = remote.get(String(params.name));
          row.text = 'concurrent SE';
          row.version = 5;
          const err = new Error('cold CAS conflict');
          err.code = -32010;
          throw err;
        },
      },
      { strictCas: true }
    );
    await coldConnect(h);

    assert.equal(writesFor(h, 'alpha').length, 1);
    assert.equal(writesFor(h, 'alpha')[0].params.expected_version, 4);
    assert.equal(nodeFor(h, 'alpha').data.content, 'fresh file');
    assert.equal(h.remote.get('alpha').text, 'concurrent SE');
    assert.deepEqual(h.se.baselineGet('sid', 'alpha'), {
      version: 5,
      text: 'concurrent SE',
      authoritative: true,
      source: 'file-preserved',
    });

    h.emitStreamChange({ name: 'alpha', version: 5, change: { type: 'set' } });
    await new Promise((resolve) => setTimeout(resolve, 180));
    await settle();
    assert.equal(writesFor(h, 'alpha').length, 1);
    assert.equal(nodeFor(h, 'alpha').data.content, 'fresh file');
    assert.deepEqual(h.se.baselineGet('sid', 'alpha'), {
      version: 5,
      text: 'concurrent SE',
      authoritative: true,
      source: 'file-preserved',
    });
  });

  await runCase('C+ cold write failure: file text is preserved without readback injection', async () => {
    const h = makeHarness(
      [remoteRow('alpha', 'stale SE', 4)],
      [sourcedNode('alpha', 'fresh file')],
      {
        'stream.write': async () => {
          const err = new Error('cold write failed');
          err.code = -32001;
          throw err;
        },
      },
      { strictCas: true }
    );
    await coldConnect(h);

    assert.equal(writesFor(h, 'alpha').length, 1);
    assert.equal(writesFor(h, 'alpha')[0].params.expected_version, 4);
    assert.equal(nodeFor(h, 'alpha').data.content, 'fresh file');
    assert.equal(h.remote.get('alpha').text, 'stale SE');
  });

  await runCase('C+ cold missing version: no non-CAS write and no stale text injection', async () => {
    const h = makeHarness(
      [remoteRow('alpha', 'stale SE', 1, { version: undefined })],
      [sourcedNode('alpha', 'fresh file')],
      {},
      { strictCas: true }
    );
    await coldConnect(h);

    assert.equal(writesFor(h, 'alpha').length, 0);
    assert.equal(nodeFor(h, 'alpha').data.content, 'fresh file');
    assert.deepEqual(h.se.baselineGet('sid', 'alpha'), {
      version: undefined,
      text: 'stale SE',
      authoritative: true,
      source: 'file-preserved',
    });

    h.remote.get('alpha').text = 'SE recovered';
    h.remote.get('alpha').version = 1;
    await h.se.readContent('s-alpha', 'sid');
    assert.equal(nodeFor(h, 'alpha').data.content, 'fresh file');
    assert.deepEqual(h.se.baselineGet('sid', 'alpha'), {
      version: 1,
      text: 'SE recovered',
      authoritative: true,
      source: 'file-preserved',
    });

    h.remote.get('alpha').text = 'SE runtime';
    h.remote.get('alpha').version = 2;
    await h.se.readContent('s-alpha', 'sid');
    assert.equal(nodeFor(h, 'alpha').data.content, 'SE runtime');
    assert.deepEqual(h.se.baselineGet('sid', 'alpha'), {
      version: 2,
      text: 'SE runtime',
      authoritative: true,
      source: 'read',
    });
    assert.equal(writesFor(h, 'alpha').length, 0);
  });

  await runCase('C+ inactive cold response: no stale text injection or startup write', async () => {
    const gate = deferred();
    const h = makeHarness(
      [remoteRow('alpha', 'stale SE', 4)],
      [sourcedNode('alpha', 'fresh file')],
      {
        'stream.read': async (params, remote) => {
          const text = remote.get(String(params.name)).text;
          await gate.promise;
          return { text };
        },
      },
      { strictCas: true }
    );
    h.se.stashPendingPush('sid', h.state.nodes);
    const connecting = h.se.onConnected('sid');
    try {
      await waitFor(
        () => h.calls.some((c) => c.method === 'stream.read' && c.params.name === 'alpha'),
        'inactive cold read started'
      );
      h.state.activeSystemId = 'other';
      h.state.activeTabId = 'tab-other';
    } finally {
      gate.resolve();
    }
    await connecting;
    await settle();

    assert.equal(writesFor(h, 'alpha').length, 0);
    assert.equal(nodeFor(h, 'alpha').data.content, 'fresh file');
  });

  await runCase('C+ local edit during cold response: no stale text injection or startup write', async () => {
    const gate = deferred();
    const h = makeHarness(
      [remoteRow('alpha', 'stale SE', 4)],
      [sourcedNode('alpha', 'fresh file')],
      {
        'stream.read': async (params, remote) => {
          const text = remote.get(String(params.name)).text;
          await gate.promise;
          return { text };
        },
      },
      { strictCas: true }
    );
    h.se.stashPendingPush('sid', h.state.nodes);
    const connecting = h.se.onConnected('sid');
    try {
      await waitFor(
        () => h.calls.some((c) => c.method === 'stream.read' && c.params.name === 'alpha'),
        'local-edit cold read started'
      );
      h.setEditingNodeId('s-alpha');
    } finally {
      gate.resolve();
    }
    await connecting;
    await settle();

    assert.equal(writesFor(h, 'alpha').length, 0);
    assert.equal(nodeFor(h, 'alpha').data.content, 'fresh file');
  });

  await runCase('C+ newer SE version: stale cold response cannot write, regress version, or inject text', async () => {
    const gate = deferred();
    let readCount = 0;
    const h = makeHarness(
      [remoteRow('alpha', 'stale SE', 2)],
      [sourcedNode('alpha', 'fresh file', { scan: { state: 'scanning' } })],
      {
        'stream.read': async (params, remote) => {
          readCount += 1;
          const text = remote.get(String(params.name)).text;
          if (readCount === 1) await gate.promise;
          return { text };
        },
      },
      { strictCas: true }
    );
    h.se.stashPendingPush('sid', h.state.nodes);
    const staleRead = h.se.readContent('s-alpha', 'sid');
    await waitFor(() => readCount === 1, 'stale cold read started');
    h.remote.get('alpha').text = 'newer SE';
    h.remote.get('alpha').version = 3;
    try {
      await h.se.readContent('s-alpha', 'sid');
    } finally {
      gate.resolve();
    }
    await staleRead;
    await settle();

    assert.equal(nodeFor(h, 'alpha').data.content, 'fresh file');
    assert.equal(h.se.versionGet('sid', 'alpha'), 3);
    assert.equal(writesFor(h, 'alpha').length, 0);
    assert.deepEqual(h.se.baselineGet('sid', 'alpha'), {
      version: 3,
      text: 'newer SE',
      authoritative: true,
      source: 'file-preserved',
    });
  });

  await runCase('C+ unresolved append: single-flight plus one trailing full read after version advance', async () => {
    const gate = deferred();
    let holdEventRead = false;
    let readAttempts = 0;
    let readInFlight = 0;
    let maxReadInFlight = 0;
    const h = makeHarness(
      [remoteRow('alpha', 'stale SE', 2)],
      [sourcedNode('alpha', 'fresh file', { scan: { state: 'scanning' } })],
      {
        'stream.read': async (params, remote) => {
          const text = remote.get(String(params.name)).text;
          if (!holdEventRead) return { text };
          readAttempts += 1;
          readInFlight += 1;
          maxReadInFlight = Math.max(maxReadInFlight, readInFlight);
          try {
            await gate.promise;
            return { text };
          } finally {
            readInFlight -= 1;
          }
        },
      },
      { strictCas: true }
    );
    await coldConnect(h);

    holdEventRead = true;
    const readMark = h.calls.length;
    h.emitStreamChange({ name: 'alpha', version: 2, change: { type: 'append' } });
    await waitFor(() => readAttempts === 1, 'unresolved append full read started');
    h.remote.get('alpha').text = 'newer SE';
    h.remote.get('alpha').version = 3;
    h.emitStreamChange({ name: 'alpha', version: 3, change: { type: 'set' } });
    await new Promise((resolve) => setTimeout(resolve, 180));
    try {
      assert.equal(readAttempts, 1);
      assert.equal(maxReadInFlight, 1);
      const eventReads = h.calls.slice(readMark).filter((c) => c.method === 'stream.read');
      assert.equal(eventReads.length, 1);
      assert.equal(eventReads[0].params.start, undefined);
    } finally {
      gate.resolve();
    }

    await waitFor(
      () => readAttempts === 2 && h.se.baselineGet('sid', 'alpha').version === 3,
      'one trailing full read after version advance'
    );
    await settle();
    const eventReads = h.calls.slice(readMark).filter((c) => c.method === 'stream.read');
    assert.equal(readAttempts, 2);
    assert.equal(eventReads.length, 2);
    assert.equal(eventReads.every((c) => c.params.start === undefined), true);
    assert.equal(maxReadInFlight, 1);
    assert.equal(writesFor(h, 'alpha').length, 0);
    assert.equal(nodeFor(h, 'alpha').data.content, 'fresh file');
    assert.deepEqual(h.se.baselineGet('sid', 'alpha'), {
      version: 3,
      text: 'newer SE',
      authoritative: true,
      source: 'file-preserved',
    });
  });
}

main()
  .catch((err) => check('test execution', false, err?.stack || String(err)))
  .finally(() => {
    sePool.get = originalGet;
    sePool.onStatus = originalOnStatus;
    const failed = results.filter((r) => !r.ok);
    console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
    process.exit(failed.length ? 1 : 0);
  });
