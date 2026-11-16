// 纯 Node 生命周期测试：新持久凭证文件 `<storage>/control/credentials.json` 在 reset / cleanup
// 两套既有 storage 策略下的处理（方案 §9.1/§9.2、P5-QA4）。
//
// 为什么不起真 SE：reset 与 cleanup 都是纯文件系统逻辑。本测试只使用 os.tmpdir() 下的
// 临时目录伪造 se-systems 结构，不连 snakeeats、不起进程/端口/网络、不依赖第三方包、不碰真实
// `se-systems/` 或开发数据。
//
// 覆盖的不变量：
//   A. reset（scripts/reset-se-storage.mjs）——
//      - 默认 dry-run 不删除任何东西；
//      - `--apply` 删除 snapshots/ journal/ scan/；
//      - 保留 control/credentials.json（含内容）、registry/.registry.json、.se-token；
//      - 不误删未指定系统（无关数据）。
//   B. cleanup（scripts/se-cleanup.mjs sweepSeSystems）——
//      - 超龄系统即便 credentials.json 是「最新」文件也整目录删除（凭证随之删除）；
//      - 新鲜系统保留；
//      - 仅含 control/credentials.json 的系统不会因凭证文件存在而被判为 active
//        （无真实活跃标记 → `no activity marker` 保守跳过，不删除、不激活）。
//
// 运行：node scripts/smoke-se-storage-lifecycle.mjs（全绿退出码 0，任一断言失败退出码 1）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sweepSeSystems } from './se-cleanup.mjs';
import { removeRecursiveWithRetry } from '../server/resilientFs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY_MS = 86400000;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 200) : ''}`);
};

const tmpRoots = [];

function newTmpRoot(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `se-storage-lifecycle-${tag}-`));
  tmpRoots.push(root);
  return root;
}

function write(file, content = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

/** 把目录下所有文件的 mtime 统一回拨 days 天（造「老」fixture）。 */
function ageDir(dir, days) {
  if (!fs.existsSync(dir)) return;
  const t = new Date(Date.now() - days * DAY_MS);
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else fs.utimesSync(p, t, t);
    }
  }
}

function ageFile(file, days) {
  const t = new Date(Date.now() - days * DAY_MS);
  fs.utimesSync(file, t, t);
}

/** 测试自清理：复用 server/resilientFs.js 唯一安全删除原语（规避 fs.rmSync no-op/崩溃）。 */
function rmrf(dir) {
  removeRecursiveWithRetry(dir, { recursive: true, bestEffort: true, cmdFallback: true });
}

/**
 * 最小但结构完整的持久凭证文档（方案 §3.2/§3.3）：
 * schema version + 非 root CredentialRecord 元数据（不存 token 原文）。
 */
function credentialsDoc(label = 'agent') {
  return {
    schema_version: 1,
    credentials: [
      {
        label,
        token_hash: `sha256:${'a'.repeat(64)}`,
        authority_ceiling: 'workspace-write',
        stream_scope: ['main'],
        namespace: 'smoke-storage-lifecycle',
        status: 'active',
        expires_at: '2099-01-01T00:00:00.000Z',
        policy_version: 1,
        depth: 0,
        spawn_seq: 0,
      },
    ],
  };
}

/** 结构校验：确认 fixture 本身是「有效最小凭证文档」。 */
function isValidCredentialsDoc(doc) {
  if (!doc || doc.schema_version !== 1 || !Array.isArray(doc.credentials) || !doc.credentials.length) return false;
  const rec = doc.credentials[0];
  return (
    !!rec &&
    typeof rec.label === 'string' &&
    typeof rec.token_hash === 'string' &&
    typeof rec.authority_ceiling === 'string' &&
    Array.isArray(rec.stream_scope) &&
    rec.stream_scope.length > 0 &&
    typeof rec.namespace === 'string' &&
    (rec.status === 'active' || rec.status === 'revoked') &&
    typeof rec.expires_at === 'string' &&
    typeof rec.policy_version === 'number'
  );
}

function runReset(root, extraArgs) {
  const script = path.join(root, 'scripts', 'reset-se-storage.mjs');
  return spawnSync(process.execPath, [script, ...extraArgs], {
    cwd: root,
    encoding: 'utf-8',
    windowsHide: true,
    timeout: 30000,
  });
}

try {
  // ── A. reset 生命周期（dry-run + apply）────────────────────────────────
  {
    const root = newTmpRoot('reset');
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(root, 'server'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'scripts', 'reset-se-storage.mjs'), path.join(root, 'scripts', 'reset-se-storage.mjs'));
    fs.copyFileSync(path.join(ROOT, 'server', 'resilientFs.js'), path.join(root, 'server', 'resilientFs.js'));

    const live = path.join(root, 'se-systems', 'live');
    const other = path.join(root, 'se-systems', 'other');
    write(path.join(live, 'snapshots', 'live', 'registry.json'), '{"streams":[]}');
    write(path.join(live, 'journal', 'main.jsonl'), '{"base_version":0}\n');
    write(path.join(live, 'scan', 'cursor.json'), '{"cursor":0}');
    write(path.join(live, 'control', 'credentials.json'), JSON.stringify(credentialsDoc('live-agent'), null, 2));
    write(path.join(live, 'registry', '.registry.json'), '{"live":{"port":59999}}');
    write(path.join(live, '.se-token'), 'live-token');
    // 无关系统：reset --system live 不应触碰它。
    write(path.join(other, 'snapshots', 'other', 'registry.json'), '{"streams":[]}');

    const credPath = path.join(live, 'control', 'credentials.json');
    const credBefore = fs.readFileSync(credPath, 'utf-8');
    let credDoc = null;
    try {
      credDoc = JSON.parse(credBefore);
    } catch (err) {
      /* 由下方 check 报告 */
    }
    check('A0 fixture 凭证文档为有效最小结构', isValidCredentialsDoc(credDoc), credDoc ? '' : 'JSON 解析失败');

    // A1 · dry-run（无 --apply）不得删除任何东西。
    const dry = runReset(root, ['--system', 'live']);
    check('A1 dry-run 退出码为 0', dry.status === 0, dry.stderr || '');
    const dryKept = [
      path.join(live, 'snapshots', 'live', 'registry.json'),
      path.join(live, 'journal', 'main.jsonl'),
      path.join(live, 'scan', 'cursor.json'),
      credPath,
      path.join(live, 'registry', '.registry.json'),
      path.join(live, '.se-token'),
    ];
    check(
      'A2 dry-run 保留 snapshots/journal/scan 与凭证/注册/token',
      dryKept.every((p) => fs.existsSync(p)),
      dryKept.filter((p) => !fs.existsSync(p)).join(', ')
    );

    // A3 · apply 仅删除运行数据。
    const apply = runReset(root, ['--system', 'live', '--apply']);
    check('A3 apply 退出码为 0', apply.status === 0, apply.stderr || '');
    const gone = ['snapshots', 'journal', 'scan'].map((d) => path.join(live, d));
    check('A4 apply 删除 snapshots/ journal/ scan/ 目录', gone.every((p) => !fs.existsSync(p)), gone.filter((p) => fs.existsSync(p)).join(', '));
    check('A5 apply 保留 control/credentials.json', fs.existsSync(credPath));
    let credAfter = '';
    try {
      credAfter = fs.readFileSync(credPath, 'utf-8');
    } catch (err) {
      /* 由 A5 报告 */
    }
    check('A6 凭证内容在 apply 后逐字节不变', credAfter === credBefore);
    check(
      'A7 apply 保留 registry/.registry.json 与 .se-token',
      fs.existsSync(path.join(live, 'registry', '.registry.json')) && fs.existsSync(path.join(live, '.se-token'))
    );
    check(
      'A8 apply 不误删未指定系统（无关数据）',
      fs.existsSync(path.join(other, 'snapshots', 'other', 'registry.json'))
    );
  }

  // ── C. reset CJK 回归（非 ASCII 系统 id / 文件 basename）────────────────
  {
    const root = newTmpRoot('reset-cjk');
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(root, 'server'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'scripts', 'reset-se-storage.mjs'), path.join(root, 'scripts', 'reset-se-storage.mjs'));
    fs.copyFileSync(path.join(ROOT, 'server', 'resilientFs.js'), path.join(root, 'server', 'resilientFs.js'));

    const id = '中文系统-蛇';
    const dir = path.join(root, 'se-systems', id);
    write(path.join(dir, 'snapshots', '快照目录', '注册表-中文.json'), '{"streams":[]}');
    write(path.join(dir, 'journal', '主日志.jsonl'), '{"base_version":0}\n');
    write(path.join(dir, 'scan', '游标-中文.json'), '{"cursor":0}');
    write(path.join(dir, 'control', 'credentials.json'), JSON.stringify(credentialsDoc('中文-agent'), null, 2));
    write(path.join(dir, 'registry', '.registry.json'), JSON.stringify({ [id]: { port: 59998 } }));
    write(path.join(dir, '.se-token'), '中文-token');

    const res = runReset(root, ['--system', id, '--apply']);
    check('C1 CJK 系统 reset --apply 退出码为 0（无残留）', res.status === 0, res.stderr || '');
    const cjkGone = ['snapshots', 'journal', 'scan'].map((e) => path.join(dir, e));
    check('C2 CJK basename 运行数据目录删净', cjkGone.every((p) => !fs.existsSync(p)), cjkGone.filter((p) => fs.existsSync(p)).join(', '));
    check(
      'C3 CJK 系统凭证/注册/token 保留',
      fs.existsSync(path.join(dir, 'control', 'credentials.json')) &&
        fs.existsSync(path.join(dir, 'registry', '.registry.json')) &&
        fs.existsSync(path.join(dir, '.se-token'))
    );
  }

  // ── B. cleanup 生命周期（stale / fresh / credentials-only）─────────────
  {
    const root = newTmpRoot('cleanup');
    const systemsDir = path.join(root, 'se-systems');
    const workspaceFile = path.join(root, 'graphs', '.workspace.json'); // 不存在 → 引用集为空

    // B1 · 超龄系统：真实活跃标记都 >30 天；credentials.json 是最新文件（40 天，仍超龄）。
    const stale = path.join(systemsDir, 'stale-creds');
    write(path.join(stale, 'snapshots', 'live', 'registry.json'), '{"streams":[]}');
    write(path.join(stale, 'journal', 'main.jsonl'), '{"base_version":0}\n');
    write(path.join(stale, 'registry', '.registry.json'), '{}');
    write(path.join(stale, 'control', 'credentials.json'), JSON.stringify(credentialsDoc('stale-agent')));
    ageDir(stale, 80);
    ageFile(path.join(stale, 'registry', '.registry.json'), 70);
    ageFile(path.join(stale, 'control', 'credentials.json'), 40); // 最新，但依然 > 30 天

    // B2 · 新鲜系统：最近活动 → 保留。
    const fresh = path.join(systemsDir, 'fresh-live');
    write(path.join(fresh, 'snapshots', 'live', 'registry.json'), '{"streams":[]}');
    write(path.join(fresh, 'registry', '.registry.json'), '{}');
    // 故意放一个无关文件，验证保留期间整目录无损坏。
    write(path.join(fresh, 'control', 'credentials.json'), JSON.stringify(credentialsDoc('fresh-agent')));

    // B3 · 仅 credentials.json（新鲜）：无任何真实活跃标记，不得被判为 active。
    const credsOnly = path.join(systemsDir, 'creds-only');
    const credsOnlyFile = path.join(credsOnly, 'control', 'credentials.json');
    write(credsOnlyFile, JSON.stringify(credentialsDoc('creds-only-agent')));

    const staleCredPath = path.join(stale, 'control', 'credentials.json');
    check('B0 stale fixture 凭证存在且是超龄系统的最新文件', fs.existsSync(staleCredPath));

    const r = await sweepSeSystems({
      systemsDir,
      workspaceFile,
      dryRun: false,
      probeTimeoutMs: 100,
      log: () => {},
    });

    check('B1 清理器未中止', r.aborted === false, String(r.aborted));
    check(
      'B2 超龄系统的 storage 保留（不会自动删除）',
      !r.deleted.includes('stale-creds') && fs.existsSync(stale) && fs.existsSync(staleCredPath)
    );
    check(
      'B3 新鲜系统保留（快照/注册/凭证仍在）',
      r.deleted.includes('fresh-live') === false &&
        fs.existsSync(path.join(fresh, 'snapshots', 'live', 'registry.json')) &&
        fs.existsSync(path.join(fresh, 'control', 'credentials.json'))
    );

    const credsOnlySkip = r.skipped.find((s) => s.id === 'creds-only');
    check(
      'B4 仅含 credentials.json 的系统不因凭证存在而 active（no activity marker）',
      !!credsOnlySkip && credsOnlySkip.reason === 'no activity marker',
      credsOnlySkip ? credsOnlySkip.reason : '未出现在 skipped'
    );
    check(
      'B5 仅含 credentials.json 的超龄证据不足 → 保守保留、不误删',
      !r.deleted.includes('creds-only') && fs.existsSync(credsOnlyFile)
    );
  }
} catch (err) {
  check('生命周期测试执行', false, String((err && err.stack) || err));
} finally {
  for (const root of tmpRoots) rmrf(root);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
