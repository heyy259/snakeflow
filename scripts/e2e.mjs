// 阶段8 回归 E2E（playwright-core + 系统 Chrome，免下载 chromium）
// 自动备份/还原 graphs/.workspace.json、.frecency.json、.ui.json，不污染用户数据。
// P7：本地画布逃生舱已移除，新标签页一律经 createBoundTab 绑定真实 SE。
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {
  sePreflightSkip,
  seEnv,
  createBoundTab,
  cleanupSeSystem,
  cleanupGraphArtifacts,
  purgeTestTabsFromWorkspace,
  workspaceSystemIds,
} from './se-ui-helper.mjs';

const PORT = 5199;
const BASE = `http://localhost:${PORT}`;
const SID = `e2e-${Date.now().toString(36)}`;
// 种子 tab 无 system，会被 P4 自动分配由 tab.id 派生的系统 id（'t-e2e'），finally 一并清理。
const SEED_SID = 't-e2e';
const BACKUP_FILES = [
  'graphs/.workspace.json',
  'graphs/.frecency.json',
  'graphs/.ui.json',
  'graphs/.snippets.json',
].map((p) => path.resolve(p));
const SNIPPETS_FILE = path.resolve('graphs/.snippets.json');

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

// 备份
const backups = new Map();
const originals = new Set();
function removeFile(f) {
  try {
    fs.rmSync(f, { force: true });
  } catch {
    /* ignore */
  }
  if (fs.existsSync(f)) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
}
for (const f of BACKUP_FILES) {
  if (fs.existsSync(f)) {
    fs.copyFileSync(f, f + '.e2e-bak');
    backups.set(f, true);
    originals.add(f);
  }
}
function restore() {
  for (const f of BACKUP_FILES) {
    const bak = f + '.e2e-bak';
    if (originals.has(f) && backups.get(f) && fs.existsSync(bak)) {
      fs.copyFileSync(bak, f);
    } else if (!originals.has(f)) {
      // 测试前不存在：本次 seed / 应用写入的文件属于测试产物，删除而非写回。
      removeFile(f);
    }
    removeFile(bak);
  }
}

// 测试隔离：写入确定性初始工作区（活动 tab 至少一个带非空 markdown 内容的节点，
// 保证首屏 `.md-body` 渲染断言不依赖用户当前工作区状态；finally 中 restore() 还原）。
const SEED_WORKSPACE = {
  activeId: 't-e2e',
  tabs: [{ id: 't-e2e', name: '' }],
  store: {
    't-e2e': {
      nodes: [
        {
          id: 'n-e2e',
          position: { x: 80, y: 80 },
          data: { name: 'E2E 种子节点', content: '# E2E 种子\n\n初始 **markdown** 内容' },
        },
      ],
      edges: [],
    },
  },
};
fs.mkdirSync(path.dirname(BACKUP_FILES[0]), { recursive: true });
fs.writeFileSync(BACKUP_FILES[0], JSON.stringify(SEED_WORKSPACE));
// 片段种子：[] 经 normalizeSnippets 补齐为 13 条内置、无用户片段，保证 chips 测量可复现。
fs.writeFileSync(SNIPPETS_FILE, JSON.stringify([]));

const server = spawn('npx.cmd', ['vite', '--port', String(PORT), '--strictPort'], {
  cwd: process.cwd(), stdio: 'ignore', shell: true, env: await seEnv(),
});

let browser;
try {
  await waitForServer(BASE);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  const consoleErrors = [];
  // 采集 SE WS 帧：证明绑定节点的扫描确实路由到 SE（而非已移除的本地 mock）。
  const seFrames = [];
  page.on('websocket', (ws) => {
    if (!/\/api\/se\/ws/.test(ws.url())) return;
    ws.on('framesent', (f) => seFrames.push(String(f.payload)));
  });
  page.on('console', (m) => {
    // 网络类报错没有 URL，由下方 response 监听统一按 URL 过滤，这里跳过避免重复误报
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + (e.stack || e.message)));
  // 资源级 404 过滤：/api/store/* 首访 404 是设计内行为（无文件即 404）
  page.on('response', (r) => {
    if (r.status() >= 400 && !/\/api\/store\//.test(r.url())) {
      consoleErrors.push(`HTTP ${r.status()} ${r.url()}`);
    }
  });

  // ---- 1. 首屏 ----
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow', { timeout: 15000 });
  await page.waitForTimeout(800);
  check('页面加载·画布节点渲染', true);
  check('文件侧栏存在', !!(await page.$('aside, .file-sidebar, .file-pane')));
  const sb = await page.$('.statusbar');
  check('状态栏双指示灯', !!sb && /编辑中的流/.test(await sb.innerText()) && /插入目标/.test(await sb.innerText()));
  check('节点 md 渲染（.md-body）', !!(await page.$('.md-body')));

  // Task 3 门控后：绑定在线 tab 双击空白 = 唤起「新建流」对话框（不再直接落 n-* 本地节点）。
  // 故双击后若出现 .modal：填唯一流名 → 提交 → 等重投影出 s-<name> 节点，按 data-id 精确返回。
  // 未绑定的本地逃生舱仍回退「最后追加的节点」。
  let e2eSeq = 0;
  const newNodeAt = async () => {
    const name = `e2e节点${Date.now().toString(36)}${e2eSeq++}`;
    const pane = await page.$('.react-flow__pane');
    const box = await pane.boundingBox();
    await page.mouse.dblclick(box.x + box.width * 0.15, box.y + box.height * 0.85);
    const modalInput = await page
      .waitForSelector('.modal input[type="text"]', { timeout: 5000 })
      .catch(() => null);
    if (modalInput) {
      await page.fill('.modal input[type="text"]', name);
      await page.click('.dlg-actions .primary');
      await page.waitForSelector('.modal', { state: 'detached', timeout: 10000 }).catch(() => {});
      await page.waitForSelector(`.react-flow__node[data-id="s-${name}"]`, { timeout: 20000 });
      return `s-${name}`;
    }
    await page.waitForTimeout(500);
    const n = (await page.$$('.react-flow__node')).at(-1);
    return n ? await n.getAttribute('data-id') : null;
  };
  // 选中指定节点并按 Delete。绑定在线的 s-* 走 SE 可见性写路径（= 从画布隐藏，非物理删除），
  // 本地节点走本地隐藏；两者都表现为节点从画布移除，故统一按「detached」等待。
  const deleteNode = async (id) => {
    if (!id) return;
    const n = await page.$(`.react-flow__node[data-id="${id}"]`);
    if (!n) return;
    // 选中会展开终端面板，抬高节点 bbox 使中心点击落到状态栏下方而超时；先收起（se-edges 同款）。
    await page.evaluate(() => {
      document.querySelectorAll('.react-flow__node .terminal-panel.expanded .term-bar').forEach((b) => b.click());
    });
    await page.waitForTimeout(250);
    try {
      await n.click({ timeout: 8000 });
    } catch (err) {
      // 兜底：点内容区/标题（均在节点顶部）选中，避免 bbox 中心被遮挡。
      const target = (await n.$('.agent-content')) || (await n.$('.agent-title')) || n;
      await target.click({ timeout: 8000 });
    }
    await page.waitForTimeout(250);
    await page.keyboard.press('Delete');
    await page.waitForSelector(`.react-flow__node[data-id="${id}"]`, { state: 'detached', timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(200);
  };
  const nodeById = (id) => page.$(`.react-flow__node[data-id="${id}"]`);

  // 种子 tab 无 system，会被 P4 自动绑定并自动 spawn SE；等其转 online，使「双击→新建流对话框」
  // 的新 UX（Task 3）成为确定性路径（否则首屏时 SE 未就绪会落到本地行为）。
  await page
    .waitForFunction(
      () => {
        const a = document.querySelector('.tab.active');
        return !!(a && a.querySelector('.tab-se-dot.se-dot-online'));
      },
      null,
      { timeout: 90000 }
    )
    .catch(() => {});
  await page.waitForTimeout(500);

  // ---- 2. 编辑骨架：新建节点 → 就地编辑 → 防抖回写 → Esc ----
  const id1 = await newNodeAt();
  const n1 = await nodeById(id1);
  const c1 = n1 ? await n1.$('.agent-content') : null;
  check('新建节点为 SE 流节点（s-*）', !!id1 && id1.startsWith('s-'), `id=${id1}`);
  await c1.dblclick();
  const pm = await page.waitForSelector('.ProseMirror', { timeout: 15000 }).catch(() => null);
  check('双击进入就地编辑（ProseMirror 挂载）', !!pm);
  check('浮动工具栏出现', !!(await page.$('.node-toolbar')));
  check('工具栏已移到屏幕空间编辑条', !!(await page.$('.flow-edit-hud .node-toolbar')));
  check('工具栏已移出节点 DOM', !(await page.$('.react-flow__node .node-toolbar')));
  check('「编辑中」徽章', !!(await page.$('.edit-badge')));
  check('片段 chips 两行', (await page.$$('.ntb-snips')).length >= 2);
  // ---- 2.1 片段测量回归：种子 13 内置 → 真值测量 → 溢出/可达性 ----
  const BUILTIN_ROW = '.flow-edit-hud .ntb-snips[data-snip-group="builtin"]';
  const chipSnapshot = () =>
    page.evaluate((sel) => {
      const row = document.querySelector(sel);
      const toolbar = document.querySelector('.flow-edit-hud .node-toolbar');
      const hud = document.querySelector('.flow-edit-hud');
      if (!row || !toolbar || !hud) return null;
      const chips = Array.from(row.querySelectorAll('.snip-chip[data-snip]'));
      const visibleChips = chips.filter((c) => !c.classList.contains('snip-hidden'));
      const hiddenChips = chips.filter((c) => c.classList.contains('snip-hidden'));
      const more = row.querySelector('.snip-more');
      const firstRow = toolbar.querySelector('.ntb-row');
      const dirty = firstRow ? firstRow.querySelector('.edit-dirty') : null;
      const tb = toolbar.getBoundingClientRect();
      const hr = hud.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const firstRect = firstRow ? firstRow.getBoundingClientRect() : null;
      const dirtyRect = dirty ? dirty.getBoundingClientRect() : null;
      const cs = getComputedStyle(toolbar);
      return {
        total: chips.length,
        visible: visibleChips.length,
        hidden: hiddenChips.length,
        hiddenNames: hiddenChips.map((c) => c.textContent.trim()),
        moreTitle: more ? more.title : '',
        moreVisible: !!more && !more.classList.contains('hidden'),
        sourceBtn: !!toolbar.querySelector('[data-tb-source="1"]'),
        doneText: (toolbar.querySelector('.ntb-done')?.textContent || '').trim(),
        toolbar: {
          width: tb.width,
          left: tb.left,
          right: tb.right,
          scrollWidth: toolbar.scrollWidth,
          clientWidth: toolbar.clientWidth,
          boxSizing: cs.boxSizing,
          paddingX: parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight),
        },
        hud: { width: hr.width, left: hr.left, right: hr.right },
        row: { scrollWidth: row.scrollWidth, clientWidth: row.clientWidth, width: rowRect.width },
        dirty: dirty
          ? {
              marginLeft: getComputedStyle(dirty).marginLeft,
              right: dirtyRect.right,
              rowRight: firstRect.right,
              rowWidth: firstRect.width,
              doneRight: firstRow.querySelector('.ntb-done')?.getBoundingClientRect().right ?? 0,
            }
          : null,
      };
    }, BUILTIN_ROW);

  // SnippetChips 的测量是 setTimeout(0) + ResizeObserver 驱动的异步布局：连续两次取样
  // 的 (总数/可见/隐藏/标题/行宽) 完全一致，且行无横向溢出，才视为测量已收敛。
  const waitChipsSettled = async (timeout = 8000) => {
    await page.evaluate(() => {
      window.__e2eChipSig = null;
    });
    await page.waitForFunction(
      (sel) => {
        const row = document.querySelector(sel);
        if (!row) return false;
        const chips = Array.from(row.querySelectorAll('.snip-chip[data-snip]'));
        const more = row.querySelector('.snip-more');
        if (!chips.length || !more) return false;
        const visible = chips.filter((c) => !c.classList.contains('snip-hidden')).length;
        const hidden = chips.length - visible;
        const moreVisible = !more.classList.contains('hidden');
        const consistent =
          more.title === `还有 ${hidden} 个片段` &&
          (hidden > 0 ? moreVisible : !moreVisible) &&
          row.scrollWidth <= row.clientWidth + 1;
        if (!consistent) {
          window.__e2eChipSig = null;
          return false;
        }
        const sig = [chips.length, visible, hidden, more.title, moreVisible, row.clientWidth].join('|');
        const stable = window.__e2eChipSig === sig;
        window.__e2eChipSig = sig;
        return stable;
      },
      BUILTIN_ROW,
      { timeout, polling: 50 }
    );
  };

  // 真点击「⋯」，校验菜单项与隐藏 chip 名称逐一一致、菜单完整落在视口内（可点可达）。
  const openBuiltinMore = async () => {
    await page.click(`${BUILTIN_ROW} .snip-more`, { timeout: 5000 });
    await page.waitForSelector('.snip-more-menu .snip-more-item', { state: 'visible', timeout: 5000 });
    const menu = await page.evaluate(() => {
      const el = document.querySelector('.snip-more-menu');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        names: Array.from(el.querySelectorAll('.snip-more-item .snip-more-name')).map((n) =>
          n.textContent.trim()
        ),
        count: el.querySelectorAll('.snip-more-item').length,
        inViewport:
          r.left >= -0.5 &&
          r.top >= -0.5 &&
          r.right <= window.innerWidth + 0.5 &&
          r.bottom <= window.innerHeight + 0.5,
      };
    });
    // 再点锚点关闭（SnippetMoreMenu 的 mousedown 白名单放行 anchorEl）。
    await page.evaluate((sel) => document.querySelector(`${sel} .snip-more`)?.click(), BUILTIN_ROW);
    await page.waitForSelector('.snip-more-menu', { state: 'detached', timeout: 5000 }).catch(() => {});
    return menu;
  };

  const chipsBrief = (s) => (s ? { total: s.total, visible: s.visible, hidden: s.hidden } : null);

  await waitChipsSettled();
  const wide = await chipSnapshot();
  check('片段种子：13 条内置全部渲染', !!wide && wide.total === 13, JSON.stringify(chipsBrief(wide)));
  check(
    '1600 视口：内置片段可见 8–9 个（阈值而非精确值）',
    !!wide && wide.visible >= 8 && wide.visible <= 9,
    JSON.stringify(chipsBrief(wide))
  );
  check(
    '内置片段 hidden 与「⋯」标题/显隐一致',
    !!wide &&
      wide.hidden === wide.total - wide.visible &&
      wide.moreTitle === `还有 ${wide.hidden} 个片段` &&
      (wide.hidden > 0 ? wide.moreVisible : !wide.moreVisible),
    wide ? `${wide.moreTitle} / hidden=${wide.hidden}` : ''
  );
  check(
    '工具栏与内置片段行无横向溢出、不越出 HUD',
    !!wide &&
      wide.toolbar.scrollWidth <= wide.toolbar.clientWidth + 1 &&
      wide.row.scrollWidth <= wide.row.clientWidth + 1 &&
      wide.toolbar.left >= wide.hud.left - 0.5 &&
      wide.toolbar.right <= wide.hud.right + 0.5 &&
      wide.toolbar.width <= wide.hud.width + 0.5,
    wide
      ? `tb ${Math.round(wide.toolbar.left)}–${Math.round(wide.toolbar.right)} / hud ${Math.round(
          wide.hud.left
        )}–${Math.round(wide.hud.right)}`
      : ''
  );
  check(
    '宽视口工具栏 ≥480px 且 box-sizing:border-box',
    !!wide &&
      wide.toolbar.boxSizing === 'border-box' &&
      (wide.hud.width < 512 || wide.toolbar.width >= 479.5),
    wide ? `${Math.round(wide.toolbar.width)}px / ${wide.toolbar.boxSizing}` : ''
  );
  check(
    '第一行余量由 .edit-dirty 的 margin-left:auto 吃掉（尾按钮贴右）',
    !!wide &&
      !!wide.dirty &&
      (wide.dirty.marginLeft === 'auto' ||
        (Number.isFinite(parseFloat(wide.dirty.marginLeft)) && parseFloat(wide.dirty.marginLeft) > 1)) &&
      wide.dirty.doneRight >= wide.dirty.rowRight - 1.5 &&
      wide.dirty.rowWidth >= wide.toolbar.clientWidth - wide.toolbar.paddingX - 1.5,
    wide && wide.dirty
      ? `dirty.right=${Math.round(wide.dirty.right)} / done.right=${Math.round(
          wide.dirty.doneRight
        )} / row.right=${Math.round(wide.dirty.rowRight)} / margin-left=${wide.dirty.marginLeft}`
      : ''
  );
  check(
    '源码/完成按钮仍在 HUD 工具栏内',
    !!wide && wide.sourceBtn && wide.doneText.includes('完成'),
    wide ? `source=${wide.sourceBtn} done=${wide.doneText}` : ''
  );

  const wideMenu = wide && wide.hidden > 0 ? await openBuiltinMore() : null;
  check(
    '1600 视口：内置「⋯」隐藏项名称一致且全部在视口内可达',
    !!wide &&
      !!wideMenu &&
      wideMenu.count === wide.hidden &&
      JSON.stringify(wideMenu.names) === JSON.stringify(wide.hiddenNames) &&
      wideMenu.inViewport,
    wideMenu ? JSON.stringify(wideMenu.names) : ''
  );

  // 窄视口：允许少于 8 个可见（阈值放宽），但绝不横向溢出；隐藏项仍须全部可达。
  await page.setViewportSize({ width: 720, height: 700 });
  await waitChipsSettled();
  const narrow = await chipSnapshot();
  check(
    '窄视口：允许 <8 个内置可见，且无横向溢出/HUD 越界',
    !!narrow &&
      narrow.visible <= 9 &&
      narrow.toolbar.scrollWidth <= narrow.toolbar.clientWidth + 1 &&
      narrow.row.scrollWidth <= narrow.row.clientWidth + 1 &&
      narrow.toolbar.left >= narrow.hud.left - 0.5 &&
      narrow.toolbar.right <= narrow.hud.right + 0.5 &&
      narrow.toolbar.width <= narrow.hud.width + 0.5,
    JSON.stringify(chipsBrief(narrow))
  );
  const narrowMenu = narrow && narrow.hidden > 0 ? await openBuiltinMore() : null;
  check(
    '窄视口：全部隐藏内置片段可经「⋯」到达',
    !!narrow &&
      (narrow.hidden === 0 ||
        (!!narrowMenu &&
          narrowMenu.count === narrow.hidden &&
          JSON.stringify(narrowMenu.names) === JSON.stringify(narrow.hiddenNames) &&
          narrowMenu.inViewport)),
    narrowMenu ? JSON.stringify(narrowMenu.names) : `hidden=${narrow ? narrow.hidden : '?'}`
  );

  await page.setViewportSize({ width: 1600, height: 950 });
  await waitChipsSettled();
  const restored = await chipSnapshot();
  check(
    '恢复 1600 视口：内置片段可见数回到 8–9',
    !!restored && restored.visible >= 8 && restored.visible <= 9,
    JSON.stringify(chipsBrief(restored))
  );
  if (pm) {
    await pm.click();
    await page.keyboard.type('回归测试abc123');
    await page.waitForTimeout(900);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
    check('Esc 退出编辑', !(await page.$('.ProseMirror')));
    // SE 流节点回写经 RPC + 重投影，比本地节点慢：轮询等待只读渲染出现。
    let persisted = false;
    const tp = Date.now();
    while (Date.now() - tp < 12000) {
      persisted = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.react-flow__node .md-body')).some((b) =>
          b.innerText.includes('回归测试abc123')
        )
      );
      if (persisted) break;
      await page.waitForTimeout(300);
    }
    check('编辑内容回写并只读渲染', persisted);
  }

  // ---- 2.2 清除格式回归：一次 Clear 归一折叠外结构/marks，折叠块是结构屏障 ----
  // 结构断言统一排除 .md-fold-edit 子树：折叠块内部允许有列表/marks，且必须原样保留。
  const pmStructure = () =>
    page.evaluate(() => {
      const root = document.querySelector('.ProseMirror');
      if (!root) return null;
      const outsideFold = (el) => !el.closest('.md-fold-edit');
      const outside = (sel) => Array.from(root.querySelectorAll(sel)).filter(outsideFold);
      const fold = root.querySelector('.md-fold-edit');
      return {
        headings: outside('h1,h2,h3,h4,h5,h6').length,
        lists: outside('ul,ol').length,
        listItems: outside('li').length,
        quotes: outside('blockquote').length,
        marks: outside('strong,em,s,del').length,
        pre: outside('pre').length,
        tables: outside('table').length,
        paragraphs: outside('p').length,
        fold: fold
          ? {
              count: root.querySelectorAll('.md-fold-edit').length,
              strongText: (fold.querySelector('.md-fold-body strong')?.textContent || '').trim(),
              listText: (fold.querySelector('.md-fold-body li')?.textContent || '').trim(),
            }
          : null,
        text: root.innerText,
      };
    });
  const CLEAR_FIXTURE = [
    '# 标题一',
    '',
    '普通段落 **加粗** 与 *斜体* 和 ~~删除~~ 文本。',
    '',
    '## 标题二',
    '',
    '- 外层项目',
    '  - 内层项目',
    '- [ ] 任务项',
    '',
    '> 引用第一行',
    '>',
    '> 引用第二行',
    '',
    '```js',
    'const codeLine = 1;',
    '```',
    '',
    '<details>',
    '<summary>折叠标题</summary>',
    '',
    '**正文**',
    '',
    '- 折叠列表',
    '',
    '</details>',
    '',
    '| 列A | 列B |',
    '| --- | --- |',
    '| 值一 | 值二 |',
  ].join('\n');

  const n1Clear = await nodeById(id1);
  const c1Clear = n1Clear ? await n1Clear.$('.agent-content') : null;
  check('清除格式：可重新进入 id1 编辑', !!c1Clear);
  if (c1Clear) {
    await c1Clear.dblclick();
    const pmClear = await page.waitForSelector('.ProseMirror', { timeout: 15000 }).catch(() => null);
    check('清除格式：ProseMirror 重新挂载', !!pmClear);
    if (pmClear) {
      // 源码模式灌入夹具；Esc 只关闭源码（closeSource），随后等 PM 重建。
      await page.click('.flow-edit-hud [data-tb-source="1"]');
      await page.waitForSelector('.node-source-edit', { state: 'visible', timeout: 10000 });
      await page.fill('.node-source-edit', CLEAR_FIXTURE);
      await page.waitForTimeout(650); // 500ms 防抖回写
      await page.keyboard.press('Escape');
      await page.waitForSelector('.node-source-edit', { state: 'detached', timeout: 10000 });
      await page.waitForSelector('.wysiwyg-pane:not(.is-hidden) .ProseMirror', { timeout: 10000 });
      await page.waitForSelector('.ProseMirror .md-fold-edit', { timeout: 15000 });
      await page.waitForTimeout(400);

      const beforeClear = await pmStructure();
      check(
        '清除格式：夹具包含双标题/嵌套列表/任务/引用/代码/折叠/表格',
        !!beforeClear &&
          beforeClear.headings >= 2 &&
          beforeClear.lists >= 2 &&
          beforeClear.listItems >= 3 &&
          beforeClear.quotes === 1 &&
          beforeClear.pre === 1 &&
          beforeClear.tables === 1 &&
          !!beforeClear.fold &&
          beforeClear.fold.strongText === '正文' &&
          beforeClear.fold.listText === '折叠列表',
        beforeClear ? JSON.stringify({ ...beforeClear, text: undefined }) : ''
      );

      if (beforeClear) {
        await page.click('.ProseMirror p');
        await page.keyboard.press('Control+a');
        await page.waitForFunction(
          () => {
            const b = document.querySelector('.flow-edit-hud [data-tb-clear="1"]');
            return !!b && !b.disabled;
          },
          null,
          { timeout: 5000 }
        );
        const clearEnabledForAll = await page.evaluate(() => {
          const b = document.querySelector('.flow-edit-hud [data-tb-clear="1"]');
          return !!b && !b.disabled;
        });
        check('清除格式：Ctrl+A 全选后 Clear 可用', clearEnabledForAll);
        await page.click('.flow-edit-hud [data-tb-clear="1"]');
        await page.waitForTimeout(500);
        const afterClear = await pmStructure();
        check(
          '清除格式：折叠外标题全部归一为正文',
          !!afterClear && afterClear.headings === 0,
          afterClear ? `headings=${afterClear.headings}` : ''
        );
        check(
          '清除格式：折叠外列表/任务项全部归一为正文',
          !!afterClear && afterClear.lists === 0 && afterClear.listItems === 0,
          afterClear ? `lists=${afterClear.lists} li=${afterClear.listItems}` : ''
        );
        check(
          '清除格式：折叠外引用全部归一为正文',
          !!afterClear && afterClear.quotes === 0,
          afterClear ? `quotes=${afterClear.quotes}` : ''
        );
        check(
          '清除格式：折叠外 inline marks 清空',
          !!afterClear && afterClear.marks === 0,
          afterClear ? `marks=${afterClear.marks}` : ''
        );
        check(
          '清除格式：代码块与 GFM 表格保留',
          !!afterClear &&
            afterClear.pre === beforeClear.pre &&
            afterClear.tables === beforeClear.tables &&
            afterClear.text.includes('const codeLine = 1;') &&
            afterClear.text.includes('值一'),
          afterClear ? `pre=${afterClear.pre} table=${afterClear.tables}` : ''
        );
        check(
          '清除格式：折叠块保留且内部加粗/列表文本不变',
          !!afterClear &&
            !!afterClear.fold &&
            afterClear.fold.count === 1 &&
            afterClear.fold.strongText === beforeClear.fold.strongText &&
            afterClear.fold.listText === beforeClear.fold.listText,
          afterClear && afterClear.fold
            ? `strong=${afterClear.fold.strongText} li=${afterClear.fold.listText}`
            : ''
        );

        // closeHistory 隔离本次 Clear：一次 Undo 必须恰好撤销它，不得靠多次点击兜底。
        await page.click('.flow-edit-hud .node-toolbar button[title="撤销（编辑器内）"]');
        await page.waitForTimeout(500);
        const undoClear = await pmStructure();
        check(
          '清除格式：一次工具栏 Undo 恢复折叠外标题/列表/引用',
          !!undoClear &&
            undoClear.headings === beforeClear.headings &&
            undoClear.lists === beforeClear.lists &&
            undoClear.listItems === beforeClear.listItems &&
            undoClear.quotes === beforeClear.quotes,
          undoClear
            ? `headings=${undoClear.headings} lists=${undoClear.lists} quotes=${undoClear.quotes}`
            : ''
        );

        // 一次 Redo 再次原子地清空（不追加额外 undo）。
        await page.click('.flow-edit-hud .node-toolbar button[title="重做（编辑器内）"]');
        await page.waitForTimeout(500);
        const redoClear = await pmStructure();
        check(
          '清除格式：一次工具栏 Redo 再次清空折叠外标题/列表/引用',
          !!redoClear &&
            redoClear.headings === 0 &&
            redoClear.lists === 0 &&
            redoClear.listItems === 0 &&
            redoClear.quotes === 0 &&
            redoClear.marks === 0,
          redoClear
            ? `headings=${redoClear.headings} lists=${redoClear.lists} quotes=${redoClear.quotes}`
            : ''
        );

        // 幂等：内容已干净时再点一次不得 dispatch 空事务、不得重新置脏。
        await page.waitForTimeout(800); // 等首次 Clear 的 500ms 防抖回写结束
        const savedBeforeReclick = await page.evaluate(
          () => (document.querySelector('.flow-edit-hud .edit-dirty')?.textContent || '').trim()
        );
        await page.click('.flow-edit-hud [data-tb-clear="1"]');
        await page.waitForTimeout(250);
        const savedAfterReclick = await page.evaluate(
          () => (document.querySelector('.flow-edit-hud .edit-dirty')?.textContent || '').trim()
        );
        check(
          '清除格式：重复点击 Clear 保持已保存（无空事务置脏）',
          savedBeforeReclick.includes('已保存') && savedAfterReclick.includes('已保存'),
          `${savedBeforeReclick} → ${savedAfterReclick}`
        );

        // storedMarks 路径：空选区 Ctrl+B 设 marks → Clear 必须清掉，随后输入不得继承 strong。
        await page.click('.ProseMirror p');
        // 单击后 PM state 的 selection 同步是异步的：等一拍再 Ctrl+B，避免仍在 AllSelection 上落 mark。
        await page.waitForTimeout(250);
        await page.keyboard.press('Control+b');
        await page.waitForTimeout(150);
        const afterBold = await pmStructure();
        check(
          '清除格式：Ctrl+B 在空选区只设 storedMarks（未把 strong 应用到全文）',
          !!afterBold && afterBold.marks === 0,
          afterBold ? `marks=${afterBold.marks}` : ''
        );
        await page.waitForFunction(
          () => {
            const b = document.querySelector('.flow-edit-hud [data-tb-clear="1"]');
            return !!b && !b.disabled;
          },
          null,
          { timeout: 5000 }
        );
        await page.click('.flow-edit-hud [data-tb-clear="1"]');
        await page.keyboard.type('CLEARMARK');
        await page.waitForTimeout(250);
        const markState = await page.evaluate(() => {
          const root = document.querySelector('.ProseMirror');
          if (!root) return { found: false, strong: false };
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          let node = walker.nextNode();
          while (node) {
            if ((node.nodeValue || '').includes('CLEARMARK')) {
              return { found: true, strong: !!node.parentElement?.closest('strong') };
            }
            node = walker.nextNode();
          }
          return { found: false, strong: false };
        });
        check(
          '清除格式：Ctrl+B 的 storedMarks 被清除，后续输入不在 strong 内',
          markState.found && !markState.strong,
          markState.found ? (markState.strong ? '输入仍在 strong 内' : '普通文本') : '未找到输入文本'
        );

        // 清除后源码 Markdown：折叠块未编辑 → 原样回写 **正文** / - 折叠列表。
        await page.waitForTimeout(700); // 500ms 防抖回写
        await page.click('.flow-edit-hud [data-tb-source="1"]');
        await page.waitForSelector('.node-source-edit', { state: 'visible', timeout: 10000 });
        const mdAfterClear = await page.inputValue('.node-source-edit');
        check(
          '清除格式：源码 Markdown 保留折叠块原始 **正文** 与 - 折叠列表',
          /<details>/.test(mdAfterClear) &&
            mdAfterClear.includes('**正文**') &&
            mdAfterClear.includes('- 折叠列表'),
          mdAfterClear.slice(0, 160).replace(/\n/g, '⏎')
        );
        const sourceClearDisabled = await page.evaluate(() => {
          const b = document.querySelector('.flow-edit-hud [data-tb-clear="1"]');
          return !!b && b.disabled;
        });
        check('清除格式：源码模式禁用 Clear 按钮', sourceClearDisabled);

        // 源码 Esc 只 closeSource；再按一次 Esc 才退出编辑。
        await page.keyboard.press('Escape');
        await page.waitForSelector('.node-source-edit', { state: 'detached', timeout: 10000 });
        await page.waitForSelector('.wysiwyg-pane:not(.is-hidden) .ProseMirror', { timeout: 10000 });
        await page.waitForTimeout(400);
        check('清除格式：源码 Esc 仅关闭源码、未退出编辑', !!(await page.$('.ProseMirror')));
        await page.keyboard.press('Escape');
        await page.waitForSelector('.ProseMirror', { state: 'detached', timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(400);
        check('清除格式：退出编辑', !(await page.$('.ProseMirror')));
      }
    }
  }
  await deleteNode(id1);

  // ---- 3. 折叠块：新节点输入 details 标记 ----
  const id2 = await newNodeAt();
  const n2 = await nodeById(id2);
  const c2 = n2 ? await n2.$('.agent-content') : null;
  await c2.dblclick();
  const pm2 = await page.waitForSelector('.ProseMirror', { timeout: 15000 }).catch(() => null);
  if (pm2) {
    await pm2.click();
    const lines = ['<details>', '<summary>折叠标题</summary>', '折叠正文内容', '</details>'];
    for (let i = 0; i < lines.length; i++) {
      await page.keyboard.type(lines[i]);
      if (i < lines.length - 1) await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(1000);
    check('输入 </details> 自动构建折叠块', !!(await page.$('.ProseMirror .md-fold-edit')));
    await page.keyboard.press('Escape');
    // SE 回写 + 重投影异步：轮询等待折叠卡只读渲染。
    let foldCards = 0;
    const tf = Date.now();
    while (Date.now() - tf < 12000) {
      foldCards = await page.evaluate(() => document.querySelectorAll('.react-flow__node .md-fold').length);
      if (foldCards > 0) break;
      await page.waitForTimeout(300);
    }
    check('退出后折叠卡只读渲染', foldCards > 0, `折叠卡 ${foldCards} 个`);
    if (foldCards > 0) {
      // 折叠卡展开/收起交互
      const sum = await page.$('.react-flow__node .md-fold > summary, .react-flow__node .md-fold .md-fold-sum');
      if (sum) {
        await sum.click();
        await page.waitForTimeout(300);
        const opened = await page.evaluate(() => !!document.querySelector('.react-flow__node .md-fold[open], .react-flow__node .md-fold.open, .react-flow__node .md-fold[data-open]'));
        check('折叠卡点击展开', opened);
      }
    }
  } else {
    check('折叠块测试', false, '编辑器未挂载');
  }
  await deleteNode(id2);

  // ---- 4. 侧栏目录浏览（先切到文件面板：默认面板已是流） ----
  for (const b of await page.$$('.rail-btn')) {
    if ((await b.textContent()).includes('📁')) {
      if ((await b.getAttribute('aria-pressed')) !== 'true') await b.click();
      break;
    }
  }
  await page.waitForTimeout(500);
  const driveRow = await page.$('.drive-row');
  if (driveRow) {
    await driveRow.dblclick();
    await page.waitForTimeout(1200);
    const asideText = await page.evaluate(() => document.querySelector('aside').innerText);
    check('侧栏双击盘符进入目录', /名称/.test(asideText) && /修改时间/.test(asideText));
    const crumbHome = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('aside .crumb-bar *, aside button'));
      const home = els.find((e) => (e.textContent || '').trim() === '此电脑');
      if (home) { home.click(); return true; }
      return false;
    });
    await page.waitForTimeout(500);
    check('面包屑返回主页', crumbHome);
  } else {
    check('侧栏目录浏览', false, '未找到 .drive-row');
  }

  // ---- 5. 流可见性（需求 9 核心用例，新建独立标签页隔离） ----
  // 本地画布逃生舱已移除：新标签页必须绑定真实 SE（独占 system id，互不串台）。
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
  await activateRail('🌊');
  // SE 往返 + 对账投影为异步：等待列表实际新增再返回；带正文以便第 6 节扫描能真实路由到 SE。
  const createStream = async (name, content = '') => {
    const before = (await page.$$('.stream-item')).length;
    await page.click('.sidebar-head .head-btn');
    await page.waitForSelector('.modal input[type="text"]', { timeout: 8000 });
    await page.fill('.modal input[type="text"]', name);
    if (content) {
      const tas = await page.$$('.modal .dlg-textarea');
      await tas[tas.length - 1].fill(content);
    }
    await page.click('.dlg-actions .primary');
    await page.waitForFunction(
      (n) => document.querySelectorAll('.stream-item').length > n,
      before,
      { timeout: 20000 }
    );
    await page.waitForTimeout(200);
  };
  await createStream('回归流A', '内容甲\n内容乙\n');
  await createStream('回归流B', '内容丙\n内容丁\n');
  const visOk = (await page.$$('.react-flow__node')).length === 2 && (await page.$$('.stream-item')).length === 2;
  check('流面板新建 2 流（画布=列表）', visOk);
  // 眼睛隐藏 + 恢复
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('.stream-item')).find(
      (e) => e.querySelector('.stream-name')?.textContent === '回归流B'
    );
    el.querySelector('.stream-actions button').click();
  });
  await page.waitForTimeout(400);
  check('眼睛隐藏：画布 -1 且列表保留', (await page.$$('.react-flow__node')).length === 1 && (await page.$$('.stream-item')).length === 2 && !!(await page.$('.stream-item.is-hidden')));
  // 拖拽隐藏流上画布
  await page.evaluate(() => {
    const paneBox = document.querySelector('.react-flow__pane').getBoundingClientRect();
    const dt = new DataTransfer();
    const item = document.querySelector('.stream-item.is-hidden');
    item.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const flow = document.querySelector('.flow');
    const x = paneBox.x + paneBox.width * 0.25;
    const y = paneBox.y + paneBox.height * 0.25;
    flow.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientX: x, clientY: y }));
    flow.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientX: x, clientY: y }));
  });
  await page.waitForTimeout(400);
  check('拖拽上画布：隐藏流回到画布', (await page.$$('.react-flow__node')).length === 2);
  // 键盘 Delete = 从画布移除（语义分层）
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('.stream-item')).find(
      (e) => e.querySelector('.stream-name')?.textContent === '回归流B'
    ).click();
  });
  await page.waitForTimeout(500);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(400);
  check('Delete 语义分层：画布移除、列表保留', (await page.$$('.react-flow__node')).length === 1 && (await page.$$('.stream-item')).length === 2);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(500);
  check('undo 撤销隐藏', (await page.$$('.react-flow__node')).length === 2);

  // ---- 6. 扫描条 / 终端状态机（精简） ----
  await page.evaluate(() => {
    const el = document.querySelector('.react-flow__node');
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, view: window }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, view: window }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, view: window }));
  });
  await page.waitForTimeout(500);
  check('扫描条常驻 + 选中展开控制行', !!(await page.$('.scan-strip')) && !!(await page.$('.scan-controls')));
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('.scan-controls > button')).find((b) => b.textContent.includes('开始')).click();
  });
  // 旧断言「未绑定禁扫 → 请先绑定 toast」在强制绑定后不可达；改为验证扫描经真实 SE 路由
  // （scan.start WS 帧），且不再出现本地拒绝。
  let scanRoutedToSe = false;
  const tScan = Date.now();
  while (Date.now() - tScan < 10000) {
    if (seFrames.some((f) => /scan\.start/.test(f))) { scanRoutedToSe = true; break; }
    await page.waitForTimeout(150);
  }
  check('绑定节点开始扫描 → 经 SE scan.start（WS 帧）', scanRoutedToSe);
  check('无「请先绑定」toast（已绑定，能力门放行）', await page.evaluate(() =>
    !Array.from(document.querySelectorAll('.toast')).some((t) => t.textContent.includes('请先绑定'))
  ));
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('.scan-controls > button')).find((b) => b.textContent.includes('停止'));
    if (btn && !btn.disabled) btn.click();
  });
  await page.waitForTimeout(300);
  check('终端无 demo 进程兜底', await page.evaluate(() =>
    (document.querySelector('.term-summary')?.textContent || '').includes('无后台进程')
  ));

  // ---- 7. 控制台/网络无异常 ----
  const realErrors = consoleErrors.filter((e) => !/favicon|React DevTools/i.test(e));
  check('控制台无错误', realErrors.length === 0, realErrors.slice(0, 3).join(' || '));

  await page.screenshot({ path: '.sisyphus/e2e-final.png' });
} catch (err) {
  check('E2E 执行', false, String((err && err.message) || err));
} finally {
  if (browser) await browser.close();
  // Windows 下 shell:true 的 kill() 只杀 npx 壳，必须 taskkill /T 杀整棵树防 vite 孤儿
  try { spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 尽力而为 */ }
  cleanupSeSystem(SID);
  cleanupSeSystem(SEED_SID);
  // seed 工作区里全是测试 tab：运行时派生的 SE 也按工作区回收。
  for (const id of workspaceSystemIds(BACKUP_FILES[0])) cleanupSeSystem(id);
  restore();
  purgeTestTabsFromWorkspace(BACKUP_FILES[0]);
  cleanupGraphArtifacts(SID);
  cleanupGraphArtifacts(SEED_SID);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
