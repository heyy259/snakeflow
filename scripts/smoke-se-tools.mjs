// 期 9 工具驱动单元冒烟（纯 node，无真实 SE / vite / playwright / spawn）。
//
// 用 fake call 验证 src/se/toolDriver.js 的**纯驱动**接线语义（Oracle Q1：配置=唯一台账，
// 驱动只做 RPC + 「SE 已注册名集合 + 完整定义」回报，**绝不写配置**）：
//   1. hydrate：tool.list → 已注册名集合与 definitions（缺 name/null 丢弃；失败保留旧快照）；
//   2. register：参数白名单（前端私有字段 insert_template 不下发）、更新集合、空 tool_path fail-fast；
//   3. unregister：参数与集合移除；
//   4. tool.on_registry_change 的 registered/unregistered 增量；
//   4b. update：unregister→register（同名）、失败回滚 priorDef、恰好一次通知、字段透传、fail-fast；
//   5. probeRoot（-32602→root true / -32001→root false / 其它→null）+ canManageTools/reset；
//   6. 不变量：驱动任何路径都**不修改配置 tools**（由 App 的 commitTools 独占）。
//
// 运行：node scripts/smoke-se-tools.mjs
import { createToolDriver } from '../src/se/toolDriver.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 200) : ''}`);
};

/** 造测试上下文：fake call / 记录 calls·notifies·status；`tools` 仅用于证明驱动不写它。 */
function makeCtx({ tools = {}, active = true } = {}) {
  const ctx = {
    // 兼容旧签名保留的「配置镜像」：驱动不再读写它 —— 断言其始终不变。
    tools: { ...tools },
    active,
    calls: [],
    notifies: [],
    statusLog: [],
    status: { present: new Set(), definitions: {} },
    fake: null,
  };
  const presentNames = () => Array.from(ctx.status.present).sort();
  ctx.presentNames = presentNames;
  ctx.isActive = () => ctx.active;
  ctx.notify = (text, kind) => ctx.notifies.push({ text, kind });
  ctx.call = async (method, params) => {
    ctx.calls.push({ method, params });
    if (ctx.fake) return ctx.fake(method, params, ctx);
    return undefined;
  };
  ctx.driver = createToolDriver({
    call: ctx.call,
    notify: ctx.notify,
    onStatus: (snapshot) => {
      ctx.status = snapshot;
      ctx.statusLog.push(snapshot);
    },
  });
  return ctx;
}

// ── 契约面 ───────────────────────────────────────────────────────────────────
{
  const ctx = makeCtx();
  const d = ctx.driver;
  check(
    '契约：导出方法齐全',
    typeof d.onEvent === 'function' &&
      typeof d.hydrate === 'function' &&
      typeof d.reset === 'function' &&
      typeof d.register === 'function' &&
      typeof d.unregister === 'function' &&
      typeof d.update === 'function' &&
      typeof d.probeRoot === 'function' &&
      typeof d.canManageTools === 'function'
  );
  check(
    '契约：topics 仅 tool.on_registry_change',
    Array.isArray(d.topics) && d.topics.length === 1 && d.topics[0] === 'tool.on_registry_change'
  );
  check('契约：canManageTools 默认 false', d.canManageTools() === false);
}

// ── 1. hydrate：投影出已注册名集合（不写配置）──────────────────────────────
{
  const ctx = makeCtx();
  ctx.fake = async (m) => {
    if (m === 'tool.list') {
      return [
        {
          name: 'alpha',
          description: 'Alpha SE definition',
          tool_path: '/p/a.py',
          input_schema: { type: 'object', properties: { value: { type: 'string' } } },
          se_only_metadata: { retained: true },
        },
        { name: 'beta', tool_path: '/p/b.py', version: '1.2.3' },
        { description: '缺 name' }, // 应被丢弃
        null, // 应被丢弃
      ];
    }
    throw new Error('unexpected ' + m);
  };
  await ctx.driver.hydrate();
  check(
    'hydrate：集合 = {alpha,beta}，缺 name/null 丢弃',
    JSON.stringify(ctx.presentNames()) === JSON.stringify(['alpha', 'beta']),
    JSON.stringify(ctx.presentNames())
  );
  check(
    'hydrate：definitions 按名称保留完整 tool.list 行',
    Object.keys(ctx.status.definitions).sort().join(',') === 'alpha,beta' &&
      ctx.status.definitions.alpha.description === 'Alpha SE definition' &&
      ctx.status.definitions.alpha.input_schema.properties.value.type === 'string' &&
      ctx.status.definitions.alpha.se_only_metadata.retained === true &&
      ctx.status.definitions.beta.version === '1.2.3' &&
      ctx.status.present instanceof Set
  );
  check('hydrate：不写配置 tools', Object.keys(ctx.tools).length === 0);
  check(
    'hydrate：调用 tool.list {}',
    ctx.calls[0].method === 'tool.list' && Object.keys(ctx.calls[0].params).length === 0
  );
}

{
  const ctx = makeCtx();
  ctx.fake = async (m) => {
    if (m === 'tool.list') {
      return {
        'arbitrary outer key': { name: 'mapped', description: 'full row', tool_path: '/mapped.py', extra: [1, 2] },
      };
    }
    throw new Error('unexpected ' + m);
  };
  await ctx.driver.hydrate();
  check(
    'hydrate：对象形态 list 同样按 definition.name 索引完整行',
    ctx.presentNames().join(',') === 'mapped' &&
      ctx.status.definitions.mapped.description === 'full row' &&
      ctx.status.definitions.mapped.extra.join(',') === '1,2'
  );
}

// ── 1b. hydrate 失败保留旧集合 ───────────────────────────────────────────────
{
  const ctx = makeCtx();
  ctx.driver.onEvent('tool.on_registry_change', {
    type: 'registered',
    tool: { name: 'keep', description: 'cached', tool_path: '/keep.py', se_field: 42 },
  });
  ctx.statusLog.length = 0;
  ctx.fake = async () => {
    const e = new Error('list boom');
    e.code = -32000;
    throw e;
  };
  await ctx.driver.hydrate();
  check(
    'hydrate：失败保留旧集合与 definitions 且不回报',
    ctx.status.present.has('keep') &&
      ctx.status.definitions.keep.description === 'cached' &&
      ctx.status.definitions.keep.se_field === 42 &&
      ctx.statusLog.length === 0
  );
}

// ── 2. register：白名单（insert_template 不下发）+ 集合更新 ──────────────────
{
  const ctx = makeCtx();
  ctx.fake = async (m) => {
    if (m === 'tool.register') return { success: true };
    throw new Error('unexpected ' + m);
  };
  const res = await ctx.driver.register({
    name: 't1',
    description: 'desc',
    tool_path: '/t1.py',
    // 前端私有字段：必须被白名单排除。
    insert_template: '@{t1|{"a":1}}',
  });
  const p = ctx.calls[0].params;
  check(
    'register：仅发送 name/description/tool_path（insert_template 被排除）',
    ctx.calls[0].method === 'tool.register' &&
      Object.keys(p).sort().join(',') === 'description,name,tool_path',
    JSON.stringify(p)
  );
  check('register：集合加入 t1', ctx.status.present.has('t1'));
  check(
    'register：definitions 暴露实际下发参数',
    ctx.status.definitions.t1.name === 't1' &&
      ctx.status.definitions.t1.description === 'desc' &&
      ctx.status.definitions.t1.tool_path === '/t1.py' &&
      !('insert_template' in ctx.status.definitions.t1)
  );
  check('register：不写配置 tools', Object.keys(ctx.tools).length === 0);
  check('register：成功通知 ok', ctx.notifies.some((n) => n.kind === 'ok' && /已注册工具/.test(n.text)));
  check('register：返回调用结果', res && res.success === true);
}

// ── 2b. register：含全部非空可选字段（空值不发） ─────────────────────────────
{
  const ctx = makeCtx();
  ctx.fake = async (m) => {
    if (m === 'tool.register') return { success: true };
    throw new Error('unexpected ' + m);
  };
  await ctx.driver.register({
    name: 't2',
    description: 'd',
    tool_path: '/t2.py',
    execution_path: '/e',
    manual_path: '/m',
    brief_description: 'b',
    detailed_description: 'dd',
    version: '2.0.0',
    tags: { a: '1' },
    input_schema: { type: 'object' },
    requires: ['x'],
  });
  const p2 = ctx.calls[0].params;
  check(
    'register：非空可选全部下发',
    ['execution_path', 'manual_path', 'brief_description', 'detailed_description', 'version', 'tags', 'input_schema', 'requires'].every(
      (k) => k in p2
    ),
    JSON.stringify(p2)
  );
  check(
    'register：definitions 含可选 schema/requires',
    ctx.status.definitions.t2.input_schema.type === 'object' &&
      ctx.status.definitions.t2.requires[0] === 'x' &&
      ctx.status.definitions.t2.execution_path === '/e'
  );

  const ctx3 = makeCtx();
  ctx3.fake = async (m) => {
    if (m === 'tool.register') return { success: true };
    throw new Error('unexpected ' + m);
  };
  await ctx3.driver.register({
    name: 't3',
    description: 'd',
    tool_path: '/t3.py',
    execution_path: '',
    manual_path: '   ',
    brief_description: '',
    version: '',
    tags: {},
    input_schema: {},
    requires: [],
  });
  const p3 = ctx3.calls[0].params;
  check(
    'register：空可选字段不下发',
    !('execution_path' in p3) &&
      !('manual_path' in p3) &&
      !('brief_description' in p3) &&
      !('version' in p3) &&
      !('tags' in p3) &&
      !('input_schema' in p3) &&
      !('requires' in p3),
    JSON.stringify(p3)
  );
}

// ── 2c. register：空 tool_path fail-fast（无 RPC / 无状态变更）───────────────
{
  const ctx = makeCtx();
  ctx.fake = async () => {
    throw new Error('should not be called');
  };
  let threw = null;
  try {
    await ctx.driver.register({ name: 'x', description: 'd', tool_path: '' });
  } catch (e) {
    threw = e;
  }
  check('register：空 tool_path 抛错', !!threw && /tool_path/.test(String(threw.message)));
  check('register：fail-fast 无 RPC', ctx.calls.length === 0 && ctx.statusLog.length === 0);
}

// ── 2d. register：显式失败 → warn + 抛错 + 不入集合 ─────────────────────────
{
  const ctx = makeCtx();
  ctx.fake = async (m) => {
    if (m === 'tool.register') return { success: false, error: 'name exists' };
    throw new Error('unexpected ' + m);
  };
  let threw = null;
  try {
    await ctx.driver.register({ name: 'dup', description: 'd', tool_path: '/d.py' });
  } catch (e) {
    threw = e;
  }
  check('register：失败抛错', !!threw && /name exists/.test(String(threw.message)));
  check('register：失败 warn 通知', ctx.notifies.some((n) => n.kind === 'warn' && /注册工具失败/.test(n.text)));
  check(
    'register：失败不入集合/definitions',
    !ctx.status.present.has('dup') && !ctx.status.definitions.dup && ctx.statusLog.length === 0
  );
}

// ── 3. unregister ────────────────────────────────────────────────────────────
{
  const ctx = makeCtx();
  ctx.driver.onEvent('tool.on_registry_change', {
    type: 'registered',
    tool: { name: 'gone', description: 'old', tool_path: '/gone.py' },
  });
  ctx.driver.onEvent('tool.on_registry_change', {
    type: 'registered',
    tool: { name: 'stay', description: 'keep', tool_path: '/stay.py' },
  });
  ctx.fake = async (m) => {
    if (m === 'tool.unregister') return { success: true };
    throw new Error('unexpected ' + m);
  };
  await ctx.driver.unregister('gone');
  check('unregister：发送 {name}', ctx.calls[0].method === 'tool.unregister' && ctx.calls[0].params.name === 'gone');
  check('unregister：集合移除 gone、保留 stay', !ctx.status.present.has('gone') && ctx.status.present.has('stay'));
  check(
    'unregister：definitions 同步移除且保留其它完整定义',
    !ctx.status.definitions.gone && ctx.status.definitions.stay.description === 'keep'
  );
  check('unregister：info 通知', ctx.notifies.some((n) => n.kind === 'info' && /已删除工具/.test(n.text)));
}
{
  const ctx = makeCtx();
  ctx.driver.onEvent('tool.on_registry_change', { type: 'registered', tool: { name: 'stay' } });
  ctx.statusLog.length = 0;
  ctx.fake = async (m) => {
    if (m === 'tool.unregister') return { success: false, error: 'not found' };
    throw new Error('unexpected ' + m);
  };
  let threw = null;
  try {
    await ctx.driver.unregister('nope');
  } catch (e) {
    threw = e;
  }
  check('unregister：失败抛错 + warn', !!threw && ctx.notifies.some((n) => n.kind === 'warn' && /删除工具失败/.test(n.text)));
  check('unregister：失败不改集合', ctx.status.present.has('stay') && ctx.statusLog.length === 0);
}

// ── 3b. update：始终 unregister→register（SE 不 upsert） ──────────────────────
{
  const ctx = makeCtx();
  ctx.fake = async (m) => {
    if (m === 'tool.unregister') return { success: true };
    if (m === 'tool.register') return { success: true };
    throw new Error('unexpected ' + m);
  };
  const res = await ctx.driver.update('t', { name: 't', description: 'd', tool_path: '/new.py' }, { name: 't', tool_path: '/old.py' });
  check(
    'update：同名 → 先 unregister 后 register',
    ctx.calls.length === 2 &&
      ctx.calls[0].method === 'tool.unregister' &&
      ctx.calls[0].params.name === 't' &&
      ctx.calls[1].method === 'tool.register' &&
      ctx.calls[1].params.tool_path === '/new.py',
    JSON.stringify(ctx.calls.map((c) => c.method))
  );
  check('update：成功恰好一次 ok 通知', ctx.notifies.length === 1 && ctx.notifies[0].kind === 'ok' && /已更新工具/.test(ctx.notifies[0].text), JSON.stringify(ctx.notifies));
  check('update：无中间删除/注册 toast', !ctx.notifies.some((n) => /已删除工具|已注册工具/.test(n.text)));
  check('update：集合含新名 t', ctx.status.present.has('t'));
  check(
    'update：definitions 更新为实际新参数',
    ctx.status.definitions.t.description === 'd' && ctx.status.definitions.t.tool_path === '/new.py'
  );
  check('update：返回调用结果', res && res.success === true);
}

{
  const ctx = makeCtx();
  ctx.driver.onEvent('tool.on_registry_change', {
    type: 'registered',
    tool: { name: 'old', description: 'old', tool_path: '/old.py', stale: true },
  });
  ctx.fake = async (m) => {
    if (m === 'tool.unregister' || m === 'tool.register') return { success: true };
    throw new Error('unexpected ' + m);
  };
  await ctx.driver.update(
    'old',
    { name: 'renamed', description: 'new', tool_path: '/new.py' },
    { name: 'old', description: 'old', tool_path: '/old.py' }
  );
  check(
    'update：改名同步移动 definition 且不残留旧字段',
    !ctx.status.present.has('old') &&
      ctx.status.present.has('renamed') &&
      !ctx.status.definitions.old &&
      ctx.status.definitions.renamed.tool_path === '/new.py' &&
      !('stale' in ctx.status.definitions.renamed)
  );
}

// ── 3c. update：register 失败 → 回滚 priorDef + 恰好一次 warn ─────────────────
{
  const priorDef = { name: 't', tool_path: '/old.py', requires: ['r1'] };
  const ctx = makeCtx();
  ctx.driver.onEvent('tool.on_registry_change', { type: 'registered', tool: priorDef });
  ctx.fake = async (m) => {
    if (m === 'tool.unregister') return { success: true };
    if (m === 'tool.register') return { success: false, error: 'boom' };
    throw new Error('unexpected ' + m);
  };
  let threw = null;
  try {
    await ctx.driver.update('t', { name: 't', tool_path: '/new.py' }, priorDef);
  } catch (e) {
    threw = e;
  }
  check('update：register 失败抛错', !!threw && /boom/.test(String(threw.message)));
  check(
    'update：失败回滚 re-register priorDef',
    ctx.calls.length === 3 &&
      ctx.calls[2].method === 'tool.register' &&
      ctx.calls[2].params.tool_path === '/old.py' &&
      Array.isArray(ctx.calls[2].params.requires) &&
      ctx.calls[2].params.requires[0] === 'r1',
    JSON.stringify(ctx.calls.map((c) => c.method))
  );
  check('update：失败恰好一次 warn', ctx.notifies.length === 1 && ctx.notifies[0].kind === 'warn', JSON.stringify(ctx.notifies));
  check('update：失败无成功 toast', !ctx.notifies.some((n) => n.kind === 'ok'));
  check(
    'update：失败回滚保留旧 definition',
    ctx.status.present.has('t') &&
      ctx.status.definitions.t.tool_path === '/old.py' &&
      ctx.status.definitions.t.requires[0] === 'r1'
  );
}

// ── 3d. update：requires/execution_path/manual_path 透传 ─────────────────────
{
  const ctx = makeCtx();
  ctx.fake = async (m) => {
    if (m === 'tool.unregister') return { success: true };
    if (m === 'tool.register') return { success: true };
    throw new Error('unexpected ' + m);
  };
  await ctx.driver.update(
    't',
    { name: 't', description: 'd', tool_path: '/new.py', execution_path: '/e', manual_path: '/m', requires: ['r1'] },
    { name: 't', tool_path: '/old.py' }
  );
  const p = ctx.calls[1].params;
  check(
    'update：requires/execution_path/manual_path 透传',
    p.execution_path === '/e' && p.manual_path === '/m' && Array.isArray(p.requires) && p.requires[0] === 'r1',
    JSON.stringify(p)
  );
}

// ── 3e. update：空 tool_path fail-fast（无 RPC） ──────────────────────────────
{
  const ctx = makeCtx();
  ctx.fake = async () => {
    throw new Error('should not be called');
  };
  let threw = null;
  try {
    await ctx.driver.update('x', { name: 'x', description: 'd', tool_path: '' }, null);
  } catch (e) {
    threw = e;
  }
  check('update：空 tool_path 抛错', !!threw && /tool_path/.test(String(threw.message)));
  check('update：fail-fast 无 RPC/无通知', ctx.calls.length === 0 && ctx.notifies.length === 0 && ctx.statusLog.length === 0);
}

// ── 3f. update：unregister not-found 容忍（幂等重编辑） ───────────────────────
{
  const ctx = makeCtx();
  ctx.fake = async (m) => {
    if (m === 'tool.unregister') {
      return { success: false, error: { code: -33001, kind: 'not-found', message: 'not found' } };
    }
    if (m === 'tool.register') return { success: true };
    throw new Error('unexpected ' + m);
  };
  const res = await ctx.driver.update('gone', { name: 'gone', description: 'd', tool_path: '/g.py' }, null);
  check(
    'update：unregister not-found 容忍并继续 register',
    ctx.calls.length === 2 && ctx.calls[0].method === 'tool.unregister' && ctx.calls[1].method === 'tool.register' && res && res.success === true
  );
  check('update：not-found 成功恰好一次 ok 通知', ctx.notifies.length === 1 && ctx.notifies[0].kind === 'ok');
}

// ── 4. onEvent 增量（维护集合与 definitions）────────────────────────────────
{
  const ctx = makeCtx();
  ctx.driver.onEvent('tool.on_registry_change', {
    type: 'registered',
    tool: {
      name: 'ev1',
      description: 'event definition',
      tool_path: '/ev1.py',
      input_schema: { type: 'object' },
      se_event_field: 'retained',
    },
  });
  check('onEvent registered：集合加入 ev1', ctx.status.present.has('ev1'));
  check(
    'onEvent registered：完整事件 definition 入库且无需额外 RPC',
    ctx.status.definitions.ev1.description === 'event definition' &&
      ctx.status.definitions.ev1.input_schema.type === 'object' &&
      ctx.status.definitions.ev1.se_event_field === 'retained' &&
      ctx.calls.length === 0
  );

  ctx.driver.onEvent('tool.on_registry_change', { type: 'registered', tool: { name: 'ev1' } });
  check(
    'onEvent registered：仅名称事件不抹掉已有完整 definition',
    ctx.status.definitions.ev1.description === 'event definition' &&
      ctx.status.definitions.ev1.se_event_field === 'retained'
  );

  ctx.driver.onEvent('tool.on_registry_change', { type: 'registered', tool: { description: '缺 name' } });
  check('onEvent registered：缺 name 忽略', ctx.presentNames().length === 1);

  ctx.driver.onEvent('tool.on_registry_change', { type: 'unregistered', name: 'ev1' });
  check(
    'onEvent unregistered：集合与 definition 同步移除',
    !ctx.status.present.has('ev1') && !ctx.status.definitions.ev1
  );

  const before = ctx.statusLog.length;
  ctx.driver.onEvent('tool.on_registry_change', { type: 'unregistered', name: '' });
  ctx.driver.onEvent('tool.on_registry_change', { type: 'other' });
  ctx.driver.onEvent('other.topic', { type: 'registered', tool: { name: 'z' } });
  check('onEvent：空 name / 未知 type / 未知主题均忽略', ctx.statusLog.length === before && !ctx.status.present.has('z'));
}

// ── 5. probeRoot / canManageTools / reset ────────────────────────────────────
{
  const ctx = makeCtx();
  ctx.fake = async (m) => {
    if (m === 'tool.unregister') {
      const e = new Error('invalid params');
      e.code = -32602;
      throw e;
    }
    throw new Error('unexpected ' + m);
  };
  const r = await ctx.driver.probeRoot();
  check('probeRoot：-32602 → true', r === true && ctx.driver.canManageTools() === true);
  check('probeRoot：不动集合', ctx.statusLog.length === 0 && ctx.status.present.size === 0);
  ctx.driver.onEvent('tool.on_registry_change', { type: 'registered', tool: { name: 'x' } });
  ctx.driver.reset();
  check(
    'reset：清缓存 → canManage false + 集合/definitions 清空',
    ctx.driver.canManageTools() === false &&
      ctx.status.present.size === 0 &&
      Object.keys(ctx.status.definitions).length === 0
  );
}
{
  const ctx = makeCtx();
  ctx.fake = async () => {
    const e = new Error('unauthorized');
    e.code = -32001;
    throw e;
  };
  const r = await ctx.driver.probeRoot();
  check('probeRoot：-32001 → false', r === false && ctx.driver.canManageTools() === false);
}
{
  const ctx = makeCtx();
  ctx.fake = async () => {
    const e = new Error('other');
    e.code = -32000;
    throw e;
  };
  const r = await ctx.driver.probeRoot();
  check('probeRoot：未知错误 → null', r === null && ctx.driver.canManageTools() === false);
}
{
  const ctx = makeCtx();
  ctx.fake = async () => ({ success: true }); // 字面成功（意外）
  const r = await ctx.driver.probeRoot();
  check('probeRoot：意外成功 → null', r === null);
}

// ── 6. 不变量：驱动任何路径都不写配置 tools ─────────────────────────────────
{
  const seed = { existing: { name: 'existing', tool_path: '/e.py' } };
  const ctx = makeCtx({ tools: seed });
  ctx.fake = async (m) => {
    if (m === 'tool.list') return [{ name: 'existing' }, { name: 'extra' }];
    if (m === 'tool.register') return { success: true };
    if (m === 'tool.unregister') return { success: true };
    throw new Error('unexpected ' + m);
  };
  await ctx.driver.hydrate();
  await ctx.driver.register({ name: 'new1', description: 'd', tool_path: '/n.py' });
  await ctx.driver.unregister('new1');
  check(
    '不变量：hydrate/register/unregister 后配置 tools 逐字节不变',
    JSON.stringify(ctx.tools) === JSON.stringify(seed),
    JSON.stringify(ctx.tools)
  );
}

// ── 汇总 ─────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
