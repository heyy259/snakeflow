// 临时冒烟：工具面板（阶段 6 验证，非正式 e2e）。
// 本地画布逃生舱已移除：标签页必须绑定真实 SE，工具 CRUD 走 SE 注册表（不再有「未绑定 → 请先绑定」）。
// 更细的 SE 工具生命周期由 scripts/smoke-se-tools.mjs 覆盖。
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { toToolName } from '../src/se/nameContract.js';
import { isValidToolName, normalizeToolDef, normalizeTools } from '../src/tools.js';
import { buildToolsOnlyManifest } from '../src/se/manifest.js';
import {
  sePreflightSkip,
  seEnv,
  createBoundTab,
  cleanupSeSystem,
  cleanupGraphArtifacts,
  purgeTestTabsFromWorkspace,
} from './se-ui-helper.mjs';
import { connectSeRpc } from './se-test-helper.mjs';

// Task 6「选文件即命名」纯 Node 守卫（与 ToolFormDialog 的 fileBaseNameNoExt 同口径，零 React）：
// 即使本机无 SE（下方 sePreflightSkip 会 exit 0），也验证「去扩展名 basename → 合规工具名」。
const sanitizeToolNameFromPath = (p) =>
  toToolName(String(p).split(/[\\/]/).pop().replace(/\.[^.]+$/, ''), []);
if (sanitizeToolNameFromPath('C:/tools/Weather Tool.py') !== 'Weather_Tool') {
  console.error('FAIL  选文件即命名（纯 Node 命名转换守卫）');
  process.exit(1);
}
console.log('PASS  选文件即命名（纯 Node 命名转换守卫）：Weather Tool.py → Weather_Tool');

const appSource = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
// createOnly 接线守卫：工具新建、建流、本地节点提升三条 create 通路都必须显式 createOnly，
// 且 create 成功门不得再接受 updated，版本播种不得回退到假 0。
assert.ok(
  (appSource.match(/createOnly:\s*true,/g) || []).length >= 3,
  'createStream / promoteLocalNode / dispatchToolRegister 未全部接线 createOnly'
);
assert.match(
  appSource,
  /createOnly,\s*\n\s*isScanActive: scanActiveForName/,
  'registerEntries 未把 createOnly 透传给 applyImport'
);
assert.ok(
  !/st\.registered > 0 \|\| st\.updated > 0/.test(appSource),
  'dispatchToolRegister 仍把 updated 当作创建成功'
);
assert.ok(
  !/versions\[(?:trimmed|name)\]\)\s*\|\|\s*0/.test(appSource),
  'createStream / promoteLocalNode 仍在版本缺失时播种假基线 0'
);
const persistToolConfigMatch = appSource.match(
  /const persistToolConfig = useCallback\(\s*(async \(\{[\s\S]*?\n    \}),\s*\[([^\]]+)\]\s*\);/
);
assert.ok(persistToolConfigMatch, '无法提取 persistToolConfig 回归测试目标');
const persistToolConfigDeps = persistToolConfigMatch[2].split(',').map((dep) => dep.trim());
for (const dep of ['commitTools', 'stashActive', 'syncGraphFiles']) {
  assert.ok(persistToolConfigDeps.includes(dep), `persistToolConfig 缺少回调依赖 ${dep}`);
}
const createPersistToolConfig = new Function(
  'commitTools',
  'stashActive',
  'syncGraphFiles',
  'storeRef',
  'saveTimerRef',
  `return (${persistToolConfigMatch[1]});`
);

const registerCallbackMatch = appSource.match(
  /const dispatchToolRegister = useCallback\(\s*(async \(def\) => \{[\s\S]*?\n    \}),\s*\[([^\]]+)\]\s*\);/
);
assert.ok(registerCallbackMatch, '无法提取 dispatchToolRegister 回归测试目标');
const registerCallbackDeps = registerCallbackMatch[2].split(',').map((dep) => dep.trim());
for (const dep of ['activeId', 'persistToolConfig', 'recordToolFailures']) {
  assert.ok(registerCallbackDeps.includes(dep), `dispatchToolRegister 缺少回调依赖 ${dep}`);
}
const createToolRegisterDispatch = new Function(
  'seGate',
  'normalizeToolDef',
  'notify',
  'sePool',
  'buildToolsOnlyManifest',
  'commitTools',
  'activeId',
  'activeTabIdRef',
  'activeSystemIdRef',
  'stashActive',
  'storeRef',
  'syncGraphFiles',
  'registerEntries',
  'recordToolFailures',
  'se',
  'persistToolConfig',
  'toolOpsInflightRef',
  `return (${registerCallbackMatch[1]});`
);

const adoptCallbackMatch = appSource.match(
  /const dispatchToolAdopt = useCallback\(\s*(async \(name\) => \{[\s\S]*?\n    \}),\s*\[([^\]]+)\]\s*\);/
);
assert.ok(adoptCallbackMatch, '无法提取 dispatchToolAdopt 回归测试目标');
const adoptCallbackDeps = adoptCallbackMatch[2].split(',').map((dep) => dep.trim());
for (const dep of ['activeId', 'commitTools', 'stashActive', 'persistToolConfig']) {
  assert.ok(adoptCallbackDeps.includes(dep), `dispatchToolAdopt 缺少回调依赖 ${dep}`);
}
const createToolAdoptDispatch = new Function(
  'seGate',
  'isValidToolName',
  'notify',
  'sePool',
  'activeId',
  'activeTabIdRef',
  'activeSystemIdRef',
  'toolsRef',
  'storeRef',
  'normalizeToolDef',
  'commitTools',
  'stashActive',
  'syncGraphFiles',
  'persistToolConfig',
  'toolOpsInflightRef',
  `return (${adoptCallbackMatch[1]});`
);

const REGISTER_TAB_ID = 't-register-intent';
const REGISTER_SYSTEM_ID = 'sys-register-intent';
const REGISTER_DEF = {
  name: 'intent_tool',
  description: 'config intent regression',
  tool_path: '/tmp/intent_tool.py',
};
const successfulRegisterResult = () => ({
  ok: true,
  summary: {
    tools: { registered: 1, updated: 0, skipped: 0, failed: 0 },
    errors: [],
    warnings: [],
  },
});
const makeRegisterHarness = ({ saveResult, saveError, registerResult, listResult, listError } = {}) => {
  const events = [];
  const notifications = [];
  const failures = [];
  const registrations = [];
  const activeTabIdRef = { current: REGISTER_TAB_ID };
  const activeSystemIdRef = { current: REGISTER_SYSTEM_ID };
  const toolOpsInflightRef = { current: new Set() };
  const saveTimerRef = { current: null };
  let tools = {};
  const storeRef = {
    current: { [REGISTER_TAB_ID]: { nodes: [], edges: [], tools: {} } },
  };
  const commitTools = (updater) => {
    events.push('commit');
    tools = typeof updater === 'function' ? updater(tools) : updater;
  };
  const stashActive = () => {
    events.push('stash');
    storeRef.current[REGISTER_TAB_ID] = { ...storeRef.current[REGISTER_TAB_ID], tools };
  };
  const syncGraphFiles = async (snapshot) => {
    events.push('save');
    assert.equal(snapshot[REGISTER_TAB_ID].tools[REGISTER_DEF.name].tool_path, REGISTER_DEF.tool_path);
    if (saveError) throw saveError;
    return saveResult || { ok: true, results: { [REGISTER_TAB_ID]: { ok: true } } };
  };
  const persistToolConfig = createPersistToolConfig(
    commitTools,
    stashActive,
    syncGraphFiles,
    storeRef,
    saveTimerRef
  );
  const registerEntries = async (args) => {
    events.push('register');
    registrations.push(args);
    return registerResult || successfulRegisterResult();
  };
  const dispatch = createToolRegisterDispatch(
    () => REGISTER_SYSTEM_ID,
    normalizeToolDef,
    (text, kind) => notifications.push({ text, kind }),
    {
      get: () => ({
        call: async (method) => {
          events.push(method);
          assert.equal(method, 'tool.list');
          if (listError) throw listError;
          return listResult || [];
        },
      }),
    },
    buildToolsOnlyManifest,
    commitTools,
    REGISTER_TAB_ID,
    activeTabIdRef,
    activeSystemIdRef,
    stashActive,
    storeRef,
    syncGraphFiles,
    registerEntries,
    (sid, rows) => failures.push({ sid, rows }),
    {
      runtimeEntry: () => ({
        tools: { hydrate: async () => events.push('hydrate') },
      }),
    },
    persistToolConfig,
    toolOpsInflightRef
  );
  return {
    events,
    notifications,
    failures,
    registrations,
    storeRef,
    activeTabIdRef,
    activeSystemIdRef,
    toolOpsInflightRef,
    get tools() {
      return tools;
    },
    run: () => dispatch(REGISTER_DEF),
  };
};

const listFailed = makeRegisterHarness({ listError: new Error('tool.list denied') });
await listFailed.run();
assert.deepEqual(listFailed.events, ['tool.list']);
assert.deepEqual(listFailed.tools, {});
assert.deepEqual(listFailed.storeRef.current[REGISTER_TAB_ID].tools, {});
assert.equal(listFailed.registrations.length, 0);
assert.equal(listFailed.failures.length, 0);
assert.deepEqual(listFailed.notifications, [
  { text: `读取工具清单失败：tool.list denied；未注册「${REGISTER_DEF.name}」`, kind: 'warn' },
]);
console.log('PASS  新建工具：tool.list 失败时零配置/运行时写入');

let releaseList;
const pendingList = new Promise((resolve) => { releaseList = resolve; });
const switchedDuringList = makeRegisterHarness({ listResult: pendingList });
const switchedListRun = switchedDuringList.run();
assert.deepEqual(switchedDuringList.events, ['tool.list']);
switchedDuringList.activeTabIdRef.current = 't-switched-during-list';
switchedDuringList.activeSystemIdRef.current = 'sys-switched-during-list';
releaseList([]);
await switchedListRun;
assert.deepEqual(switchedDuringList.events, ['tool.list']);
assert.deepEqual(switchedDuringList.tools, {});
assert.deepEqual(switchedDuringList.storeRef.current[REGISTER_TAB_ID].tools, {});
assert.equal(switchedDuringList.registrations.length, 0);
assert.equal(switchedDuringList.failures.length, 0);
assert.deepEqual(switchedDuringList.notifications, [
  { text: `标签页或系统已切换，未注册「${REGISTER_DEF.name}」`, kind: 'warn' },
]);
console.log('PASS  新建工具：tool.list 期间切换标签页/系统后零配置/保存/注册副作用');

const duplicateNew = makeRegisterHarness({ listResult: [REGISTER_DEF] });
await duplicateNew.run();
assert.deepEqual(duplicateNew.events, ['tool.list']);
assert.deepEqual(duplicateNew.tools, {});
assert.equal(duplicateNew.registrations.length, 0);
assert.match(duplicateNew.notifications[0].text, /SE 已注册（未纳入配置）.*纳入配置/);
console.log('PASS  新建同名工具：拒绝覆盖并指向 SE-only 显式纳入入口');

const registerSuccess = makeRegisterHarness();
await registerSuccess.run();
assert.deepEqual(registerSuccess.events, ['tool.list', 'commit', 'stash', 'save', 'register', 'hydrate']);
assert.ok(registerSuccess.tools[REGISTER_DEF.name]);
assert.ok(registerSuccess.storeRef.current[REGISTER_TAB_ID].tools[REGISTER_DEF.name]);
assert.equal(registerSuccess.registrations.length, 1);
assert.equal(registerSuccess.registrations[0].createOnly, true);
assert.equal(registerSuccess.failures.length, 0);
console.log('PASS  新建工具：createOnly 透传且配置提交并完成当前标签页保存后才注册');

let releaseDupList;
const pendingDupList = new Promise((resolve) => { releaseDupList = resolve; });
const duplicateInFlight = makeRegisterHarness({ listResult: pendingDupList });
const firstRegisterRun = duplicateInFlight.run();
for (let i = 0; i < 20 && !duplicateInFlight.events.includes('tool.list'); i += 1) {
  await Promise.resolve();
}
assert.deepEqual(duplicateInFlight.events, ['tool.list']);
await duplicateInFlight.run();
assert.equal(duplicateInFlight.events.filter((e) => e === 'tool.list').length, 1);
assert.match(duplicateInFlight.notifications.at(-1).text, /正在注册，请勿重复提交/);
releaseDupList([]);
await firstRegisterRun;
assert.deepEqual(duplicateInFlight.events, ['tool.list', 'commit', 'stash', 'save', 'register', 'hydrate']);
assert.equal(duplicateInFlight.registrations.length, 1);
assert.equal(duplicateInFlight.toolOpsInflightRef.current.size, 0);
console.log('PASS  新建工具：重复提交在飞时直接 no-op，只发一次 tool.list');

const saveFailed = makeRegisterHarness({
  saveResult: {
    ok: true,
    results: { [REGISTER_TAB_ID]: { ok: false, reason: 'save-error', error: 'disk full' } },
  },
});
await saveFailed.run();
assert.deepEqual(saveFailed.events, ['tool.list', 'commit', 'stash', 'save']);
assert.equal(saveFailed.registrations.length, 0);
assert.ok(saveFailed.tools[REGISTER_DEF.name]);
assert.ok(saveFailed.storeRef.current[REGISTER_TAB_ID].tools[REGISTER_DEF.name]);
assert.match(saveFailed.notifications[saveFailed.notifications.length - 1].text, /disk full/);
console.log('PASS  新建工具：外层保存 ok=true 但当前标签页失败时零注册副作用');

const saveRejected = makeRegisterHarness({ saveError: new Error('save rejected') });
await saveRejected.run();
assert.deepEqual(saveRejected.events, ['tool.list', 'commit', 'stash', 'save']);
assert.equal(saveRejected.registrations.length, 0);
assert.ok(saveRejected.tools[REGISTER_DEF.name]);
assert.match(saveRejected.notifications[saveRejected.notifications.length - 1].text, /save rejected/);
console.log('PASS  新建工具：保存异常时零注册副作用');

let releaseSave;
const pendingSave = new Promise((resolve) => { releaseSave = resolve; });
const switchedDuringSave = makeRegisterHarness({ saveResult: pendingSave });
const switchedSaveRun = switchedDuringSave.run();
for (let i = 0; i < 20 && !switchedDuringSave.events.includes('save'); i += 1) {
  await Promise.resolve();
}
assert.deepEqual(switchedDuringSave.events, ['tool.list', 'commit', 'stash', 'save']);
switchedDuringSave.activeTabIdRef.current = 't-switched-during-save';
switchedDuringSave.activeSystemIdRef.current = 'sys-switched-during-save';
releaseSave({ ok: true, results: { [REGISTER_TAB_ID]: { ok: true } } });
await switchedSaveRun;
assert.deepEqual(switchedDuringSave.events, ['tool.list', 'commit', 'stash', 'save']);
assert.equal(switchedDuringSave.registrations.length, 0);
assert.equal(switchedDuringSave.failures.length, 0);
assert.deepEqual(switchedDuringSave.notifications, [
  { text: `标签页或系统已切换，未注册「${REGISTER_DEF.name}」`, kind: 'warn' },
]);
console.log('PASS  新建工具：保存期间切换标签页/系统后不触发 SE 注册');

const registrationFailed = makeRegisterHarness({
  registerResult: {
    ok: true,
    summary: {
      tools: { registered: 0, updated: 0, skipped: 0, failed: 1 },
      errors: ['tool.register denied'],
      warnings: [],
    },
  },
});
await registrationFailed.run();
assert.deepEqual(registrationFailed.events, ['tool.list', 'commit', 'stash', 'save', 'register']);
assert.ok(registrationFailed.tools[REGISTER_DEF.name]);
assert.ok(registrationFailed.storeRef.current[REGISTER_TAB_ID].tools[REGISTER_DEF.name]);
assert.deepEqual(registrationFailed.failures, [
  {
    sid: REGISTER_SYSTEM_ID,
    rows: [{ name: REGISTER_DEF.name, error: 'tool.register denied' }],
  },
]);
assert.match(registrationFailed.notifications[registrationFailed.notifications.length - 1].text, /denied/);
console.log('PASS  新建工具：SE 注册失败保留可见配置并记录失败原因');

const registrationSkipped = makeRegisterHarness({
  registerResult: {
    ok: true,
    summary: {
      tools: { registered: 0, updated: 0, skipped: 1, failed: 0 },
      errors: [],
      warnings: ['tool.register skipped'],
    },
  },
});
await registrationSkipped.run();
assert.deepEqual(registrationSkipped.events, ['tool.list', 'commit', 'stash', 'save', 'register']);
assert.ok(registrationSkipped.tools[REGISTER_DEF.name]);
assert.ok(registrationSkipped.storeRef.current[REGISTER_TAB_ID].tools[REGISTER_DEF.name]);
assert.deepEqual(registrationSkipped.failures, [
  {
    sid: REGISTER_SYSTEM_ID,
    rows: [{ name: REGISTER_DEF.name, error: '注册工具失败：未发生注册（请检查名称/定义）' }],
  },
]);
assert.deepEqual(registrationSkipped.notifications, [
  { text: '注册工具失败：未发生注册（请检查名称/定义）', kind: 'warn' },
]);
console.log('PASS  新建工具：仅 skipped 不算成功，保留可见配置并记录失败原因');

// createOnly 语义：竞态下摘要若仍报 updated（替换了已有注册），绝不能当作创建成功。
const updatedOnly = makeRegisterHarness({
  registerResult: {
    ok: true,
    summary: {
      tools: { registered: 0, updated: 1, skipped: 0, failed: 0 },
      errors: [],
      warnings: [],
    },
  },
});
await updatedOnly.run();
assert.deepEqual(updatedOnly.events, ['tool.list', 'commit', 'stash', 'save', 'register']);
assert.ok(updatedOnly.tools[REGISTER_DEF.name]);
assert.ok(updatedOnly.storeRef.current[REGISTER_TAB_ID].tools[REGISTER_DEF.name]);
assert.deepEqual(updatedOnly.failures, [
  {
    sid: REGISTER_SYSTEM_ID,
    rows: [
      {
        name: REGISTER_DEF.name,
        error: `注册工具失败：检测到同名工具已被更新而非新建；请改用编辑或纳入配置（${REGISTER_DEF.name}）`,
      },
    ],
  },
]);
assert.match(updatedOnly.notifications.at(-1).text, /已被更新而非新建/);
console.log('PASS  新建工具：createOnly 下 updated>0 不算成功，保留可见配置并显式失败');

// 竞态碰撞：tool.list 后同名工具被他人注册 → applyImport createOnly 失败且零替换；
// 本地配置保持可见，但必须记录/告知冲突，绝不伪装注册成功。
const raceCollision = makeRegisterHarness({
  registerResult: {
    ok: true,
    summary: {
      tools: { registered: 0, updated: 0, skipped: 0, failed: 1 },
      errors: [`工具 ${REGISTER_DEF.name}：已存在同名注册；createOnly 模式拒绝替换。`],
      warnings: [],
    },
  },
});
await raceCollision.run();
assert.deepEqual(raceCollision.events, ['tool.list', 'commit', 'stash', 'save', 'register']);
assert.ok(raceCollision.tools[REGISTER_DEF.name]);
assert.ok(raceCollision.storeRef.current[REGISTER_TAB_ID].tools[REGISTER_DEF.name]);
assert.deepEqual(raceCollision.failures, [
  {
    sid: REGISTER_SYSTEM_ID,
    rows: [
      {
        name: REGISTER_DEF.name,
        error: `工具 ${REGISTER_DEF.name}：已存在同名注册；createOnly 模式拒绝替换。`,
      },
    ],
  },
]);
assert.match(raceCollision.notifications.at(-1).text, /createOnly 模式拒绝替换/);
console.log('PASS  新建工具：竞态同名碰撞显式冲突，配置保留且零替换成功');

const registrationUnavailable = makeRegisterHarness({
  registerResult: { ok: false, error: 'runtime unavailable' },
});
await registrationUnavailable.run();
assert.equal(registrationUnavailable.registrations.length, 1);
assert.ok(registrationUnavailable.tools[REGISTER_DEF.name]);
assert.deepEqual(registrationUnavailable.failures[0].rows, [
  { name: REGISTER_DEF.name, error: 'runtime unavailable' },
]);
console.log('PASS  新建工具：SE 运行时不就绪仍保留配置并记录失败原因');

const ADOPT_TAB_ID = 't-adopt-intent';
const ADOPT_SYSTEM_ID = 'sys-adopt-intent';
const ADOPT_DEF = {
  name: 'adopt_fake',
  description: 'fresh SE definition',
  tool_path: '/tmp/adopt_fresh.py',
  tags: { origin: 'se-test' },
};
const makeAdoptHarness = ({
  getResult = ADOPT_DEF,
  getError,
  initialTools = {},
  configDuringGet,
  save,
} = {}) => {
  const events = [];
  const notifications = [];
  const getCalls = [];
  const saveCalls = [];
  const toolsRef = { current: normalizeTools(initialTools) };
  const activeTabIdRef = { current: ADOPT_TAB_ID };
  const activeSystemIdRef = { current: ADOPT_SYSTEM_ID };
  const toolOpsInflightRef = { current: new Set() };
  const saveTimerRef = { current: null };
  const storeRef = {
    current: { [ADOPT_TAB_ID]: { nodes: [], edges: [], tools: toolsRef.current } },
  };
  const applyConfig = (next) => {
    toolsRef.current = normalizeTools(next);
  };
  const commitTools = (updater) => {
    events.push('commit');
    applyConfig(typeof updater === 'function' ? updater(toolsRef.current) : updater);
  };
  const stashActive = () => {
    events.push('stash');
    storeRef.current[ADOPT_TAB_ID] = { ...storeRef.current[ADOPT_TAB_ID], tools: toolsRef.current };
  };
  const syncGraphFiles = async (snapshot) => {
    events.push('save');
    const attempt = saveCalls.length;
    const target = snapshot[ADOPT_TAB_ID];
    saveCalls.push({
      hasAdopted: !!(target && target.tools && target.tools[ADOPT_DEF.name]),
      tools: target && target.tools ? { ...target.tools } : null,
    });
    if (save) {
      return save({ attempt, snapshot, events, storeRef, activeTabIdRef, toolsRef, applyConfig });
    }
    return { ok: true, results: { [ADOPT_TAB_ID]: { ok: true } } };
  };
  const persistToolConfig = createPersistToolConfig(
    commitTools,
    stashActive,
    syncGraphFiles,
    storeRef,
    saveTimerRef
  );
  const dispatch = createToolAdoptDispatch(
    () => ADOPT_SYSTEM_ID,
    isValidToolName,
    (text, kind) => notifications.push({ text, kind }),
    {
      get: () => ({
        call: async (method, params) => {
          events.push(method);
          assert.equal(method, 'tool.get');
          getCalls.push(params);
          if (configDuringGet) {
            applyConfig({ ...toolsRef.current, [configDuringGet.name]: configDuringGet });
            storeRef.current[ADOPT_TAB_ID].tools = toolsRef.current;
          }
          if (getError) throw getError;
          return getResult;
        },
      }),
    },
    ADOPT_TAB_ID,
    activeTabIdRef,
    activeSystemIdRef,
    toolsRef,
    storeRef,
    normalizeToolDef,
    commitTools,
    stashActive,
    syncGraphFiles,
    persistToolConfig,
    toolOpsInflightRef
  );
  return {
    events,
    notifications,
    getCalls,
    saveCalls,
    storeRef,
    toolsRef,
    activeTabIdRef,
    toolOpsInflightRef,
    run: (name = ADOPT_DEF.name) => dispatch(name),
  };
};

const adoptSuccess = makeAdoptHarness();
assert.equal(await adoptSuccess.run(), true);
assert.deepEqual(adoptSuccess.events, ['tool.get', 'commit', 'stash', 'save']);
assert.deepEqual(adoptSuccess.getCalls, [{ name: ADOPT_DEF.name }]);
assert.equal(adoptSuccess.saveCalls.length, 1);
assert.equal(adoptSuccess.saveCalls[0].hasAdopted, true);
assert.equal(adoptSuccess.toolsRef.current[ADOPT_DEF.name].tool_path, ADOPT_DEF.tool_path);
assert.equal(adoptSuccess.storeRef.current[ADOPT_TAB_ID].tools[ADOPT_DEF.name].description, ADOPT_DEF.description);
assert.equal(adoptSuccess.notifications.at(-1).kind, 'ok');
assert.equal(adoptSuccess.toolOpsInflightRef.current.size, 0);
console.log('PASS  SE-only 纳入：恰好一次 tool.get，零 register/unregister，保存最新定义');

const adoptGetFailed = makeAdoptHarness({ getError: new Error('get denied') });
assert.equal(await adoptGetFailed.run(), false);
assert.deepEqual(adoptGetFailed.events, ['tool.get']);
assert.deepEqual(adoptGetFailed.toolsRef.current, {});
assert.deepEqual(adoptGetFailed.storeRef.current[ADOPT_TAB_ID].tools, {});
assert.match(adoptGetFailed.notifications[0].text, /get denied.*未纳入配置/);
assert.equal(adoptGetFailed.toolOpsInflightRef.current.size, 0);
console.log('PASS  SE-only 纳入：tool.get 失败时配置不变且可重试');

const adoptSaveFailed = makeAdoptHarness({
  save: ({ attempt }) => (attempt === 0
    ? { ok: true, results: { [ADOPT_TAB_ID]: { ok: false, reason: 'save-error', error: 'disk full' } } }
    : { ok: true, results: { [ADOPT_TAB_ID]: { ok: true } } }),
});
assert.equal(await adoptSaveFailed.run(), false);
assert.deepEqual(adoptSaveFailed.events, ['tool.get', 'commit', 'stash', 'save', 'commit', 'stash', 'save']);
assert.deepEqual(adoptSaveFailed.toolsRef.current, {});
assert.deepEqual(adoptSaveFailed.storeRef.current[ADOPT_TAB_ID].tools, {});
assert.equal(adoptSaveFailed.saveCalls.length, 2);
assert.equal(adoptSaveFailed.saveCalls[0].hasAdopted, true);
assert.equal(adoptSaveFailed.saveCalls[1].hasAdopted, false);
assert.match(adoptSaveFailed.notifications.at(-1).text, /disk full.*未纳入配置/);
assert.match(adoptSaveFailed.notifications.at(-1).text, /已回滚并保存还原态/);
assert.equal(adoptSaveFailed.toolOpsInflightRef.current.size, 0);
console.log('PASS  SE-only 纳入：保存失败回滚后经串行链 corrective save 写回还原态');

const adoptSaveRejected = makeAdoptHarness({
  save: ({ attempt }) => {
    if (attempt === 0) throw new Error('save rejected');
    return { ok: true, results: { [ADOPT_TAB_ID]: { ok: true } } };
  },
});
assert.equal(await adoptSaveRejected.run(), false);
assert.deepEqual(adoptSaveRejected.toolsRef.current, {});
assert.deepEqual(adoptSaveRejected.storeRef.current[ADOPT_TAB_ID].tools, {});
assert.equal(adoptSaveRejected.saveCalls.length, 2);
assert.match(adoptSaveRejected.notifications.at(-1).text, /save rejected.*未纳入配置/);
assert.match(adoptSaveRejected.notifications.at(-1).text, /已回滚并保存还原态/);
console.log('PASS  SE-only 纳入：保存异常同样回滚并 corrective save 写回还原态');

const adoptCorrectiveFailed = makeAdoptHarness({
  save: ({ attempt }) => (attempt === 0
    ? { ok: true, results: { [ADOPT_TAB_ID]: { ok: false, reason: 'save-error', error: 'disk full' } } }
    : { ok: true, results: { [ADOPT_TAB_ID]: { ok: false, reason: 'save-error', error: 'corrective denied' } } }),
});
assert.equal(await adoptCorrectiveFailed.run(), false);
assert.deepEqual(adoptCorrectiveFailed.events, ['tool.get', 'commit', 'stash', 'save', 'commit', 'stash', 'save']);
assert.deepEqual(adoptCorrectiveFailed.toolsRef.current, {});
assert.equal(adoptCorrectiveFailed.saveCalls.length, 2);
const correctiveFailToast = adoptCorrectiveFailed.notifications.at(-1).text;
assert.match(correctiveFailToast, /disk full/);
assert.match(correctiveFailToast, /未纳入配置/);
assert.match(correctiveFailToast, /回滚态未能保存/);
assert.match(correctiveFailToast, /corrective denied/);
assert.ok(!/已回滚并保存还原态/.test(correctiveFailToast), 'corrective 失败时不得宣称回滚态已持久化');
console.log('PASS  SE-only 纳入：corrective save 失败时如实报告回滚态未持久化');

const adoptTabClosed = makeAdoptHarness({
  save: ({ attempt, storeRef, activeTabIdRef }) => {
    if (attempt === 0) {
      activeTabIdRef.current = 't-other-after-close';
      delete storeRef.current[ADOPT_TAB_ID];
      return { ok: true, results: { [ADOPT_TAB_ID]: { ok: false, reason: 'save-error', error: 'tab closed' } } };
    }
    return { ok: true, results: {} };
  },
});
let closedThrew = false;
let closedResult = true;
try {
  closedResult = await adoptTabClosed.run();
} catch (err) {
  closedThrew = true;
}
assert.equal(closedThrew, false, '目标 tab 关闭后的回滚不得抛错');
assert.equal(closedResult, false);
assert.equal(adoptTabClosed.saveCalls.length, 2);
assert.equal(adoptTabClosed.saveCalls[1].tools, null);
assert.match(adoptTabClosed.notifications.at(-1).text, /目标标签页已关闭.*未纳入配置/);
assert.equal(adoptTabClosed.toolOpsInflightRef.current.size, 0);
console.log('PASS  SE-only 纳入：目标 tab 关闭时回滚 null-safe，不抛错且如实报告');

let releaseAdoptGet;
const pendingAdoptGet = new Promise((resolve) => { releaseAdoptGet = resolve; });
const adoptDouble = makeAdoptHarness({ getResult: pendingAdoptGet });
const firstAdoptRun = adoptDouble.run();
for (let i = 0; i < 20 && !adoptDouble.events.includes('tool.get'); i += 1) {
  await Promise.resolve();
}
assert.deepEqual(adoptDouble.events, ['tool.get']);
const secondAdopt = await adoptDouble.run();
assert.equal(secondAdopt, false);
assert.equal(adoptDouble.events.filter((e) => e === 'tool.get').length, 1);
assert.match(adoptDouble.notifications.at(-1).text, /正在纳入配置，请勿重复提交/);
releaseAdoptGet(ADOPT_DEF);
assert.equal(await firstAdoptRun, true);
assert.deepEqual(adoptDouble.events, ['tool.get', 'commit', 'stash', 'save']);
assert.equal(adoptDouble.toolOpsInflightRef.current.size, 0);
console.log('PASS  SE-only 纳入：双击/并发在飞时第二次直接 no-op，不并发发 tool.get');

const concurrentDef = { ...ADOPT_DEF, description: 'user config wins', tool_path: '/tmp/user_config.py' };
const adoptConcurrent = makeAdoptHarness({ configDuringGet: concurrentDef });
assert.equal(await adoptConcurrent.run(), false);
assert.deepEqual(adoptConcurrent.events, ['tool.get']);
assert.equal(adoptConcurrent.toolsRef.current[ADOPT_DEF.name].tool_path, concurrentDef.tool_path);
assert.equal(adoptConcurrent.storeRef.current[ADOPT_TAB_ID].tools[ADOPT_DEF.name].description, concurrentDef.description);
assert.match(adoptConcurrent.notifications[0].text, /保留现有定义/);
console.log('PASS  SE-only 纳入：RPC 期间出现的同名配置优先，绝不覆盖');

const adoptWrongName = makeAdoptHarness({ getResult: { ...ADOPT_DEF, name: 'other_tool' } });
assert.equal(await adoptWrongName.run(), false);
assert.deepEqual(adoptWrongName.events, ['tool.get']);
assert.deepEqual(adoptWrongName.toolsRef.current, {});
assert.match(adoptWrongName.notifications[0].text, /定义或名称无效/);
console.log('PASS  SE-only 纳入：fresh definition 名称不匹配时 fail-closed');

const PORT = 5197;
const BASE = `http://localhost:${PORT}`;
const SID = `smoke-tools-${Date.now().toString(36)}`;
const BACKUP_FILES = ['graphs/.workspace.json', 'graphs/.frecency.json', 'graphs/.ui.json'].map((p) => path.resolve(p));

await sePreflightSkip();

function waitForServer(url, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      http.get(url, (res) => { res.resume(); resolve(); }).on('error', () => {
        if (Date.now() - t0 > timeout) reject(new Error('server timeout'));
        else setTimeout(tick, 400);
      });
    };
    tick();
  });
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 140) : ''}`);
};

const backups = new Map();
for (const f of BACKUP_FILES) {
  if (fs.existsSync(f)) { fs.copyFileSync(f, f + '.smk-bak'); backups.set(f, true); }
}
// 隔离：备份用户工作区后，覆盖成「单一空 tab」的确定性宿主工作区，
// 避免恢复出的用户 tab 携带 React 工具状态干扰本测试的严格行数断言。
const HOST_TAB_ID = 't-smoke-tools-host';
fs.writeFileSync(BACKUP_FILES[0], JSON.stringify({
  workspaceVersion: 2,
  activeId: HOST_TAB_ID,
  tabs: [{ id: HOST_TAB_ID, name: '' }],
  store: { [HOST_TAB_ID]: { nodes: [], edges: [], tools: {} } },
}, null, 2));
function restore() {
  for (const f of BACKUP_FILES) {
    const bak = f + '.smk-bak';
    if (backups.get(f) && fs.existsSync(bak)) { fs.copyFileSync(bak, f); fs.rmSync(bak, { force: true }); }
    else if (fs.existsSync(bak)) fs.rmSync(bak, { force: true });
  }
}

const server = spawn('npx.cmd', ['vite', '--port', String(PORT), '--strictPort'], { cwd: process.cwd(), stdio: 'ignore', shell: true, env: await seEnv() });
let browser;
let testRpc;
try {
  await waitForServer(BASE);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.react-flow', { timeout: 15000 });
  await page.waitForTimeout(600);

  // 0. 新建绑定真实 SE 的标签页 + 切到工具面板（本地草稿逃生舱已移除）
  await createBoundTab(page, SID);
  const activateRail = async (icon) => {
    for (const b of await page.$$('.rail-btn')) {
      if ((await b.textContent()).includes(icon)) {
        if ((await b.getAttribute('aria-pressed')) !== 'true') await b.click();
        break;
      }
    }
    await page.waitForTimeout(250);
    if (await page.$('.file-sidebar.collapsed')) {
      for (const b of await page.$$('.rail-btn')) {
        if ((await b.textContent()).includes(icon)) { await b.click(); break; }
      }
    }
    await page.waitForTimeout(350);
  };
  await activateRail('🧰');

  // 1. 新标签页无预置工具（假工具预设已移除）→ 空态提示
  const rowCount = (await page.$$('.tool-row')).length;
  check('新标签页无预置工具（空态）', rowCount === 0, `rows=${rowCount}`);
  check('空态提示 + 注册 CTA', await page.evaluate(() =>
    /还没有工具/.test(document.querySelector('.tool-list')?.textContent || '') &&
    !![...document.querySelectorAll('.tool-list button')].find((b) => b.textContent.includes('注册第一个工具'))
  ));
  check('头部 ＋💾📂 三按钮', (await page.$$('.sidebar-head .head-btn')).length === 3);
  // 去本地逃生舱后：绑定在线 → canImport=已绑定 → 📂 导入启用（不再是「未绑定禁用」态）。
  check('绑定在线：📂 导入启用（SE 真源）', await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('.sidebar-head .head-btn')).find((b) =>
      /📂/.test(b.textContent || '')
    );
    return !!btn && !btn.disabled;
  }));

  // 2. 注册表单客户端校验（与绑定态无关，仍应可用）
  const addToolButton = page.locator('.sidebar-head .head-btn').first();
  await page.waitForFunction(() => {
    const button = document.querySelector('.sidebar-head .head-btn');
    return !!button && !button.disabled;
  });
  await addToolButton.click(); // ＋
  await page.waitForSelector('.modal input[type="text"]', { timeout: 8000 });
  check('注册对话框出现', !!(await page.$('.modal')));
  await page.fill('.modal input[type="text"]', 'my_tool-1'); // 含连字符非法
  await page.waitForTimeout(200);
  check('非法名称禁用注册', await page.evaluate(() => document.querySelector('.dlg-actions .primary').disabled));
  await page.fill('.modal input[type="text"]', 'my_tool');
  await page.fill('.modal input[placeholder*="tool_path"]', '/tmp/my_tool.py');
  // P7：description 现为必填，补齐后表单才合法（否则「放行」断言不再成立）。
  await page.fill('.modal textarea[placeholder*="description"]', '冒烟工具');
  await page.waitForTimeout(150);
  check('合法名称放行注册', await page.evaluate(() => !document.querySelector('.dlg-actions .primary').disabled));

  // 3. 绑定在线提交：真实写入 SE 注册表并投影出工具行（不再是「请先绑定」本地拒绝）
  await page.click('.dlg-actions .primary');
  await page.waitForFunction(
    (n) => document.querySelectorAll('.tool-row').length > n,
    rowCount,
    { timeout: 20000 }
  );
  check('绑定注册 → SE 注册表新增工具行', (await page.$$('.tool-row')).length === rowCount + 1);
  check('新增工具行名 = my_tool', await page.evaluate(() =>
    Array.from(document.querySelectorAll('.tool-row .tool-name')).some((e) => e.textContent === 'my_tool')
  ));

  // 4. ToolRow 单击 / 双击语义（方案 §6.5 / AC-9）：
  //    单击 = 弹出编辑窗口；双击 = 插入调用标记，且**双击不弹窗**（修 DOM click/dblclick 竞态）。
  const clickToolRow = async (dbl) => {
    const handle = await page.evaluateHandle(() =>
      [...document.querySelectorAll('.tool-row')].find(
        (r) => r.querySelector('.tool-name') && r.querySelector('.tool-name').textContent === 'my_tool'
      )
    );
    const el = handle.asElement();
    if (!el) return false;
    if (dbl) await el.dblclick();
    else await el.click();
    return true;
  };
  const editModalOpen = () =>
    page.evaluate(() =>
      !![...document.querySelectorAll('.modal h3')].find((h) => /编辑工具/.test(h.textContent || ''))
    );

  await clickToolRow(false);
  await page.waitForTimeout(450); // 单击有 250ms 延迟（区分双击）
  check('工具行单击 → 弹出编辑窗口', await editModalOpen());
  // Range 只测量真实字形坐标；选择本身仍由真实 mouse drag 完成。
  const schemaDrag = await page.locator('.modal .schema-view').evaluate((schema) => {
    const walker = document.createTreeWalker(schema, NodeFilter.SHOW_TEXT);
    const textNode = walker.nextNode();
    if (!textNode || !textNode.nodeValue.trim()) throw new Error('input_schema 无可见文本');
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, textNode.nodeValue.length);
    const rect = range.getBoundingClientRect();
    return { x1: rect.left + 1, x2: rect.right - 1, y: rect.top + rect.height / 2 };
  });
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await page.mouse.move(schemaDrag.x1, schemaDrag.y);
  await page.mouse.down();
  await page.mouse.move(schemaDrag.x2, schemaDrag.y, { steps: 16 });
  await page.mouse.up();
  check('只读 input_schema 可通过真实鼠标拖选', await page.evaluate(() => {
    const selection = window.getSelection();
    const schema = document.querySelector('.modal .schema-view');
    if (!selection || !schema || selection.rangeCount === 0) return false;
    return !selection.isCollapsed &&
      selection.toString().trim().length > 0 &&
      schema.contains(selection.getRangeAt(0).commonAncestorContainer);
  }));
  await page.evaluate(() => {
    const cancel = [...document.querySelectorAll('.modal .dlg-actions button')].find((b) =>
      /取消/.test(b.textContent || '')
    );
    if (cancel) cancel.click();
  });
  await page.waitForTimeout(300);

  await clickToolRow(true);
  await page.waitForTimeout(450); // 若竞态未修，单击排程会在 250ms 后弹窗
  check('工具行双击 → 不弹出编辑窗口（竞态已修）', !(await editModalOpen()));

  // 5. 需求2：插入内容定制对话框往返（留空 = 默认；定制随配置保存）。
  await clickToolRow(false);
  await page.waitForTimeout(450);
  check(
    '编辑窗口含「插入内容」字段（placeholder = buildCallStub 默认）',
    (await page.$('textarea[placeholder*="@{my_tool"]')) !== null
  );
  const CUSTOM_INSERT = '@{my_tool|{"path":"C:/x"}} #custom';
  await page.fill('textarea[placeholder*="@{my_tool"]', CUSTOM_INSERT);
  await page.evaluate(() => {
    const save = [...document.querySelectorAll('.modal .dlg-actions button')].find((b) =>
      /保存/.test(b.textContent || '')
    );
    if (save) save.click();
  });
  await page.waitForTimeout(500);
  await clickToolRow(false);
  await page.waitForTimeout(450);
  check(
    '插入内容定制往返保真',
    (await page.inputValue('textarea[placeholder*="@{my_tool"]')) === CUSTOM_INSERT
  );
  await page.evaluate(() => {
    const reset = [...document.querySelectorAll('.modal button')].find((b) =>
      /恢复默认/.test(b.textContent || '')
    );
    if (reset) reset.click();
  });
  await page.waitForTimeout(200);
  check('「恢复默认」清空定制', (await page.inputValue('textarea[placeholder*="@{my_tool"]')) === '');
  await page.evaluate(() => {
    const cancel = [...document.querySelectorAll('.modal .dlg-actions button')].find((b) =>
      /取消/.test(b.textContent || '')
    );
    if (cancel) cancel.click();
  });
  await page.waitForTimeout(300);

  // 6. Task 6「选文件即命名」：mock 系统对话框 → tool_path 浏览自动回填合规 name 并锁定。
  await page.route('**/api/dialog/open', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ path: 'C:/tools/Weather Tool.py' }),
    })
  );
  await page.click('.sidebar-head .head-btn'); // ＋ 新注册对话框
  await page.waitForSelector('.modal input[placeholder*="tool_path"]', { timeout: 8000 });
  await page.evaluate(() => {
    const input = document.querySelector('.modal input[placeholder*="tool_path"]');
    const btn = input?.closest('.dlg-row')?.querySelector('button');
    if (btn) btn.click();
  });
  await page.waitForTimeout(400);
  const autoName = await page.inputValue('.modal input[placeholder*="名称"]');
  check(
    '选文件即命名：去扩展名 + 净化 basename 回填 name',
    autoName === 'Weather_Tool',
    `name=${autoName}`
  );
  check(
    '选文件后 name 锁定（readOnly）',
    await page.evaluate(
      () => document.querySelector('.modal input[placeholder*="名称"]')?.readOnly === true
    )
  );
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.modal button')].find((b) =>
      /解锁名称/.test(b.textContent || '')
    );
    if (btn) btn.click();
  });
  await page.waitForTimeout(150);
  check(
    '点「解锁名称」→ readOnly 解除',
    await page.evaluate(
      () => document.querySelector('.modal input[placeholder*="名称"]')?.readOnly === false
    )
  );
  await page.evaluate(() => {
    const cancel = [...document.querySelectorAll('.modal .dlg-actions button')].find((b) =>
      /取消/.test(b.textContent || '')
    );
    if (cancel) cancel.click();
  });
  await page.waitForTimeout(300);

  // 7. R2：工具多选清理（复选框 + 选择工具条 + 真实 SE 批量注销）
  const selectBarState = () =>
    page.evaluate(() => document.querySelector('.tool-select-bar .sidebar-state')?.textContent || '');
  const clickSelectBarBtn = (re) =>
    page.evaluate((src) => {
      const rx = new RegExp(src);
      const btn = [...document.querySelectorAll('.tool-select-bar button')].find((b) => rx.test(b.textContent || ''));
      if (btn) btn.click();
    }, re);
  const selectBarBtnDisabled = (re) =>
    page.evaluate((src) => {
      const rx = new RegExp(src);
      const btn = [...document.querySelectorAll('.tool-select-bar button')].find((b) => rx.test(b.textContent || ''));
      return !btn || btn.disabled === true;
    }, re);

  const toolRows0 = (await page.$$('.tool-row')).length;
  check('工具选择工具条渲染', !!(await page.$('.tool-select-bar')));
  check('每行含复选框', (await page.$$('.tool-row .tool-check')).length === toolRows0 && toolRows0 > 0, `rows=${toolRows0}`);
  check('初始已选 0', /已选 0 \/ \d+/.test(await selectBarState()), await selectBarState());
  check('0 选中时清理按钮禁用', await selectBarBtnDisabled('清理'));

  // 勾选复选框 → 已选 1；等待 > 250ms 验证事件隔离未触发 ToolRow 的单击计时器（不弹编辑窗）。
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.tool-row')].find(
      (r) => r.querySelector('.tool-name')?.textContent === 'my_tool'
    );
    row?.querySelector('.tool-check')?.click();
  });
  await page.waitForTimeout(400);
  check('勾选后已选 1', /已选 1 \/ \d+/.test(await selectBarState()), await selectBarState());
  check('勾选复选框不触发编辑弹窗（事件隔离）', !(await editModalOpen()));
  check('选中行带 checked 样式', await page.evaluate(() =>
    !!document.querySelector('.tool-row.checked') && !!document.querySelector('.tool-check.on')));

  // 全选（作用于全部）→ 已选 = 全部
  await clickSelectBarBtn('全选');
  await page.waitForTimeout(150);
  const toolRows1 = (await page.$$('.tool-row')).length;
  check(
    '全选后已选 = 全部',
    new RegExp(`已选 ${toolRows1} / ${toolRows1}`).test(await selectBarState()),
    await selectBarState()
  );

  // 批量清理：确认对话框 → 删除 → SE 注销 + 行移除 + 选择归零
  await clickSelectBarBtn('清理');
  await page.waitForSelector('.modal h3', { timeout: 8000 });
  check(
    '批量删除确认对话框',
    await page.evaluate(() =>
      !![...document.querySelectorAll('.modal h3')].find((h) => /批量删除工具/.test(h.textContent || ''))
    )
  );
  await page.evaluate(() => {
    const del = [...document.querySelectorAll('.modal .dlg-actions button')].find((b) => /删除/.test(b.textContent || ''));
    if (del) del.click();
  });
  await page
    .waitForFunction((n) => document.querySelectorAll('.tool-row').length < n, toolRows1, { timeout: 15000 })
    .catch(() => {});
  const toolRows2 = (await page.$$('.tool-row')).length;
  check('批量清理后工具行移除', toolRows2 === 0, `rows=${toolRows2}`);
  check('清理后已选归零（选择被裁剪）', /已选 0 \/ 0/.test(await selectBarState()), await selectBarState());

  // 8. SE-only：只注册隔离的假定义，不执行任何工具；显式纳入只改当前配置。
  const SE_ONLY_FIXTURES = [
    {
      name: 'adopt_persist',
      description: 'fake adoption persistence fixture',
      tool_path: '/tmp/adopt_persist.py',
      tags: { fixture: 'se-only' },
    },
    {
      name: 'adopt_save_fail',
      description: 'fake adoption save failure fixture',
      tool_path: '/tmp/adopt_save_fail.py',
      tags: { fixture: 'se-only' },
    },
  ];
  testRpc = await connectSeRpc({ vitePort: PORT, systemId: SID });
  for (const def of SE_ONLY_FIXTURES) {
    const registered = await testRpc.call('tool.register', def);
    assert.notEqual(registered && registered.success, false);
  }
  await page.waitForFunction(
    () => document.querySelectorAll('.tool-row[data-tool-scope="se-only"]').length === 2,
    null,
    { timeout: 15000 }
  );
  check('SE-only 定义可见且绝不自动进入配置', await page.evaluate(() =>
    document.querySelectorAll('.tool-row[data-tool-scope="se-only"]').length === 2 &&
    document.querySelectorAll('.tool-row[data-tool-scope="config"]').length === 0 &&
    document.querySelector('.tool-se-only-section')?.textContent.includes('SE 已注册（未纳入配置）')
  ));
  check('SE-only 不改变配置选择计数', /已选 0 \/ 0/.test(await selectBarState()), await selectBarState());
  check('SE-only 行无选择/编辑/删除/插入，仅显式纳入', await page.evaluate(() =>
    [...document.querySelectorAll('.tool-row[data-tool-scope="se-only"]')].every((row) =>
      !row.querySelector('.tool-check') &&
      row.querySelectorAll('.tool-actions button').length === 1 &&
      row.querySelector('.tool-actions button')?.textContent === '纳入配置'
    )
  ));

  check('SE-only 区复用名称排序', await page.evaluate(() => {
    const names = [...document.querySelectorAll('.tool-se-only-section .tool-name')].map((el) => el.textContent);
    return JSON.stringify(names) === JSON.stringify(['adopt_persist', 'adopt_save_fail']);
  }));
  await page.fill('.tfbar-search input', 'adopt_save_fail');
  await page.waitForTimeout(250);
  check('SE-only 区复用现有搜索过滤', await page.evaluate(() =>
    document.querySelectorAll('.tool-row[data-tool-scope="se-only"]').length === 1 &&
    !!document.querySelector('.tool-row[data-tool-scope="se-only"][data-tool-name="adopt_save_fail"]')
  ));
  await page.fill('.tfbar-search input', '');
  await page.waitForTimeout(250);

  const persistSeRow = page.locator('.tool-row[data-tool-scope="se-only"][data-tool-name="adopt_persist"]');
  check('SE-only 纳入配置入口默认可见、占位且可聚焦（无需悬停）', await page.evaluate(() => {
    const row = document.querySelector('.tool-row[data-tool-scope="se-only"][data-tool-name="adopt_persist"]');
    const actions = row?.querySelector('.tool-actions');
    const button = actions?.querySelector('button');
    if (!row || !actions || !button) return false;
    if (getComputedStyle(actions).display === 'none') return false;
    const actionsRect = actions.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    if (!(actionsRect.width > 0 && actionsRect.height > 0 && buttonRect.width > 0 && buttonRect.height > 0)) return false;
    const tagsRect = row.querySelector('.tool-tags')?.getBoundingClientRect();
    if (tagsRect && tagsRect.right > actionsRect.left + 1) return false;
    button.focus();
    return document.activeElement === button;
  }));
  await page.focus('.tool-row[data-tool-scope="se-only"] .tool-actions button');
  await page.keyboard.press('Tab');
  check('SE-only 纳入配置按钮键盘 Tab 可达且显示 focus-visible 焦点环', await page.evaluate(() => {
    const active = document.activeElement;
    const focusedSeAction = [...document.querySelectorAll('.tool-row[data-tool-scope="se-only"] .tool-actions button')].includes(active);
    if (!focusedSeAction) return false;
    const style = getComputedStyle(active);
    return style.outlineStyle === 'solid' && style.outlineWidth === '2px';
  }));

  await persistSeRow.hover();
  await page.screenshot({ path: '.sisyphus/smoke-tools-se-only-desktop.png' });
  await page.setViewportSize({ width: 900, height: 800 });
  await page.waitForTimeout(250);
  await persistSeRow.hover();
  await page.screenshot({ path: '.sisyphus/smoke-tools-se-only-narrow.png' });
  await page.setViewportSize({ width: 1600, height: 950 });
  await page.waitForTimeout(250);

  await persistSeRow.click();
  await page.waitForTimeout(350);
  await persistSeRow.dblclick();
  await page.waitForTimeout(450);
  check('SE-only 单击/双击均不自动纳入、不弹编辑、不插入', await page.evaluate(() =>
    !!document.querySelector('.tool-row[data-tool-scope="se-only"][data-tool-name="adopt_persist"]') &&
    !document.querySelector('.tool-row[data-tool-scope="config"][data-tool-name="adopt_persist"]') &&
    !document.querySelector('.modal')
  ));

  await page.click('.sidebar-head .head-btn');
  await page.waitForSelector('.modal input[placeholder*="名称"]');
  await page.fill('.modal input[placeholder*="名称"]', 'adopt_persist');
  await page.fill('.modal input[placeholder*="tool_path"]', '/tmp/duplicate_attempt.py');
  await page.fill('.modal textarea[placeholder*="description"]', 'duplicate attempt');
  await page.click('.modal .dlg-actions .primary');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.toast')].some((toast) =>
      /SE 已注册（未纳入配置）/.test(toast.textContent || '') && /纳入配置/.test(toast.textContent || '')
    )
  );
  check('duplicate-new 文案指向 SE-only 恢复入口且不覆盖配置', await page.evaluate(() =>
    !document.querySelector('.tool-row[data-tool-scope="config"][data-tool-name="adopt_persist"]') &&
    !!document.querySelector('.tool-row[data-tool-scope="se-only"][data-tool-name="adopt_persist"]')
  ));

  const registryBeforeAdoption = await testRpc.call('tool.list', {});
  await persistSeRow.hover();
  await page.getByRole('button', { name: '纳入配置 adopt_persist', exact: true }).click();
  await page.waitForSelector('.tool-row[data-tool-scope="config"][data-tool-name="adopt_persist"]', { timeout: 15000 });
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.toast')].some((toast) =>
      /已将 SE 工具「adopt_persist」纳入配置并保存/.test(toast.textContent || '')
    )
  );
  check('显式纳入后从 SE-only 区移到配置区', await page.evaluate(() =>
    !!document.querySelector('.tool-row[data-tool-scope="config"][data-tool-name="adopt_persist"]') &&
    !document.querySelector('.tool-se-only-section [data-tool-name="adopt_persist"]') &&
    !!document.querySelector('.tool-row[data-tool-scope="se-only"][data-tool-name="adopt_save_fail"]')
  ));
  check('纳入只增加配置选择总数，不选中该行', /已选 0 \/ 1/.test(await selectBarState()), await selectBarState());
  const registryAfterAdoption = await testRpc.call('tool.list', {});
  check(
    '纳入前后 SE 注册表逐字节不变（无 register/unregister）',
    JSON.stringify(registryAfterAdoption) === JSON.stringify(registryBeforeAdoption)
  );

  await page.waitForTimeout(800);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.react-flow', { timeout: 15000 });
  await page.waitForTimeout(600);
  await activateRail('🧰');
  await page.waitForSelector('.tool-row[data-tool-scope="config"][data-tool-name="adopt_persist"]', { timeout: 20000 });
  await page.waitForSelector('.tool-row[data-tool-scope="se-only"][data-tool-name="adopt_save_fail"]', { timeout: 20000 });
  check('reload 后已纳入工具仍在配置区，未纳入工具仍属 SE-only', await page.evaluate(() =>
    !!document.querySelector('.tool-row[data-tool-scope="config"][data-tool-name="adopt_persist"]') &&
    !document.querySelector('.tool-se-only-section [data-tool-name="adopt_persist"]') &&
    !!document.querySelector('.tool-row[data-tool-scope="se-only"][data-tool-name="adopt_save_fail"]')
  ));
  check('reload 后选择计数仍只统计配置', /已选 0 \/ 1/.test(await selectBarState()), await selectBarState());

  let saveBlocked = false;
  const failSaveRoute = async (route) => {
    saveBlocked = true;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'save blocked by smoke test' }),
    });
  };
  await page.route('**/api/document/save', failSaveRoute);
  const failSeRow = page.locator('.tool-row[data-tool-scope="se-only"][data-tool-name="adopt_save_fail"]');
  await failSeRow.hover();
  await page.getByRole('button', { name: '纳入配置 adopt_save_fail', exact: true }).click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.toast')].some((toast) =>
      /save blocked by smoke test/.test(toast.textContent || '') && /未纳入配置/.test(toast.textContent || '')
    )
  );
  await page.unroute('**/api/document/save', failSaveRoute);
  await page.waitForTimeout(500);
  check('保存失败诚实回滚为 SE-only，且确实拦截了一次保存', saveBlocked && await page.evaluate(() =>
    !!document.querySelector('.tool-row[data-tool-scope="se-only"][data-tool-name="adopt_save_fail"]') &&
    !document.querySelector('.tool-row[data-tool-scope="config"][data-tool-name="adopt_save_fail"]') &&
    !![...document.querySelectorAll('.toast')].some((toast) => /save blocked by smoke test/.test(toast.textContent || ''))
  ));
  check('保存失败后配置选择计数不受影响', /已选 0 \/ 1/.test(await selectBarState()), await selectBarState());
  const registryAfterFailedSave = await testRpc.call('tool.list', {});
  check(
    '保存失败路径也不改 SE 注册表',
    JSON.stringify(registryAfterFailedSave) === JSON.stringify(registryBeforeAdoption)
  );
  testRpc.close();
  testRpc = null;

  check('控制台无错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' || '));
  await page.screenshot({ path: '.sisyphus/smoke-tools.png' });
} catch (err) {
  check('冒烟执行', false, String((err && err.message) || err));
} finally {
  if (testRpc) testRpc.close();
  if (browser) await browser.close();
  // Windows 下 shell:true 的 kill() 只杀 npx 壳，必须 taskkill /T 杀整棵树防 vite 孤儿
  try { spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 尽力而为 */ }
  cleanupSeSystem(SID);
  restore();
  // 测试 tab 在真实 graphs/ 下生成的配置 / .streams 目录一并清掉，避免逐轮堆积。
  purgeTestTabsFromWorkspace();
  cleanupGraphArtifacts(SID);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
