// 图谱 / 文档 / 工作区 / 文件系统 / store 端点（graphs 世界 + fs 通道）。
import fs from 'node:fs';
import path from 'node:path';
import { stringify } from 'yaml';
import { GRAPH_CONFIG_EXT } from '../shared/paths.js';
import { parseDocument } from '../shared/document.js';
import { toLogicGraph, isStreamVisible } from '../shared/graph.js';
import {
  projectRoot,
  graphsDir,
  workspaceFile,
  STORE_WHITELIST,
  EXEC_EXTS,
  MAX_DEPTH,
  MAX_VISIT,
  sanitizeName,
  resolveUserPath,
  graphContentResolve,
  isWithinDrives,
} from './paths.js';
import {
  sendJson,
  readBody,
  parseDialogOpts,
  runDialog,
  listDrives,
  entryMeta,
  probeIsDir,
  realDirKey,
  openPath,
} from './util.js';
import {
  atomicWriteFileSync,
  renameSyncWithRetry,
  removeRecursiveWithRetry,
  copyRecursiveWithRetry,
} from './resilientFs.js';
import {
  loadHistory,
  saveHistory,
  loadFrecency,
  saveFrecency,
  refreshFrecencyTypes,
} from './store.js';
import { applyPackagePlan } from './packageApply.js';

// ── 图片资产通道（P2 /api/fs/asset）────────────────────────────────────────
// 只回流二进制图片本体（供前端压缩成内联 data URI）。扩展名白名单 + magic bytes
// 双重校验；SVG 刻意不在白名单（可携带脚本）。
const ASSET_MIME_BY_EXT = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
]);
const MAX_ASSET_BYTES = 32 * 1024 * 1024;

/** 按文件头判断真实图片类型（不信任扩展名）；无法识别返回 null。 */
function sniffImageMime(buf) {
  if (!buf || buf.length < 3) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  // GIF: "GIF87a" / "GIF89a"
  if (buf.length >= 6) {
    const head = buf.toString('latin1', 0, 6);
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    buf.length >= 12 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export function createGraphsApiMiddleware(options = {}) {
  const isAllowed = options.security && options.security.isAllowedHttp;
  let ensuredDir = '';
  return async (req, res, next) => {
        const url = new URL(req.url, 'http://localhost');
        if (!url.pathname.startsWith('/api/')) return next();
        if (isAllowed && !isAllowed(req)) return sendJson(res, 403, { error: 'forbidden' });

        try {
          if (ensuredDir !== graphsDir) {
            fs.mkdirSync(graphsDir, { recursive: true });
            ensuredDir = graphsDir;
          }

          if (req.method === 'GET' && url.pathname === '/api/session') {
            return sendJson(res, 200, { session: options.security ? options.security.sessionSecret : null });
          }

          if (req.method === 'GET' && url.pathname === '/api/graphs') {
            const files = fs
              .readdirSync(graphsDir)
              .filter((f) => f.endsWith(GRAPH_CONFIG_EXT) && !f.startsWith('.'))
              .map((name) => {
                const st = fs.statSync(path.join(graphsDir, name));
                return { name, path: `graphs/${name}`, mtime: st.mtimeMs, size: st.size };
              })
              .sort((a, b) => b.mtime - a.mtime);
            return sendJson(res, 200, files);
          }

          if (req.method === 'GET' && url.pathname === '/api/graphs/file') {
            const name = sanitizeName(path.basename(url.searchParams.get('name') || '')) + GRAPH_CONFIG_EXT;
            const file = path.join(graphsDir, name);
            if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'not found' });
            res.setHeader('Content-Type', 'application/json');
            return fs.createReadStream(file).pipe(res);
          }

          // GET /api/graphs/text?name=<名>&format=json|yaml：只读文本视图（Y1 逻辑图，仅可见流）。
          // 反映**已保存态**：按 source.file_path 回填正文后投影；不写盘、不触发 SE。
          if (req.method === 'GET' && url.pathname === '/api/graphs/text') {
            const name = sanitizeName(path.basename(url.searchParams.get('name') || ''));
            const cfgPath = path.join(graphsDir, name + GRAPH_CONFIG_EXT);
            if (!fs.existsSync(cfgPath)) return sendJson(res, 404, { error: 'not found' });
            let raw;
            try {
              raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^﻿/, ''));
            } catch (err) {
              return sendJson(res, 400, { error: `invalid config: ${(err && err.message) || err}` });
            }
            const { nodes, edges } = parseDocument(raw);
            for (const n of nodes) {
              const fp = n?.data?.source?.file_path;
              if (!fp) continue;
              const abs = graphContentResolve(fp, graphsDir);
              try {
                if (abs && fs.existsSync(abs)) {
                  n.data.content = fs.readFileSync(abs, 'utf8').replace(/^﻿/, '');
                  n.data.contentState = 'loaded';
                }
              } catch {
                /* 正文读取失败不阻断端点 */
              }
            }
            const vis = nodes.filter(isStreamVisible);
            const ids = new Set(vis.map((n) => String(n.id)));
            const visEdges = edges.filter((e) => ids.has(String(e.source)) && ids.has(String(e.target)));
            const logic = toLogicGraph(vis, visEdges);
            const format = (url.searchParams.get('format') || 'json').toLowerCase();
            if (format === 'yaml') {
              res.setHeader('Content-Type', 'text/yaml; charset=utf-8');
              res.end(stringify(logic, { version: '1.2', aliasDuplicateObjects: false }));
            } else {
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify(logic, null, 2));
            }
            return;
          }

          if (req.method === 'POST' && url.pathname === '/api/graphs/sync') {
            const body = JSON.parse(await readBody(req));
            const graphs = body && typeof body.graphs === 'object' ? body.graphs : null;
            if (!graphs) return sendJson(res, 400, { error: 'invalid sync payload' });
            const written = [];
            for (const [rawName, graph] of Object.entries(graphs)) {
              if (!graph || typeof graph !== 'object') continue;
              const name = sanitizeName(String(rawName || '')) + GRAPH_CONFIG_EXT;
              const file = path.join(graphsDir, name);
              fs.writeFileSync(file, JSON.stringify(graph, null, 2));
              written.push(name);
            }
            return sendJson(res, 200, { ok: true, written });
          }

          // 配置包原子落盘：流正文 → 工具复刻（文件/目录） → manifest 最后写。
          // 目标路径必须落在可访问盘符内；目录复刻有 excludes/大小上限（见 packageApply.js）。
          if (req.method === 'POST' && url.pathname === '/api/package/apply') {
            const body = JSON.parse(await readBody(req));
            const manifest = body && body.manifest;
            if (!manifest || typeof manifest.path !== 'string' || typeof manifest.text !== 'string') {
              return sendJson(res, 400, { error: 'invalid package payload' });
            }
            const toAbs = (raw) => {
              const p = String(raw == null ? '' : raw).trim();
              if (!p) throw Object.assign(new Error('empty path'), { code: 'EINVAL' });
              if (!isWithinDrives(p)) throw Object.assign(new Error(`forbidden: ${p}`), { code: 'EFORBIDDEN' });
              return resolveUserPath(p);
            };
            try {
              const files = (Array.isArray(body.files) ? body.files : []).map((f) => ({
                path: toAbs(f && f.path),
                text: f && f.text != null ? String(f.text) : '',
              }));
              const copies = (Array.isArray(body.copies) ? body.copies : []).map((c) => ({
                from: toAbs(c && c.from),
                to: toAbs(c && c.to),
                unit: c && c.unit === 'dir' ? 'dir' : 'file',
              }));
              const manifestPath = toAbs(manifest.path);
              const result = applyPackagePlan({
                files,
                copies,
                manifest: { path: manifestPath, text: String(manifest.text) },
                options: body.options || {},
              });
              return sendJson(res, 200, { ok: true, ...result, manifestPath });
            } catch (err) {
              const code = err && err.code;
              const status = code === 'EFORBIDDEN' ? 403
                : code === 'EPLANLIMIT' ? 413
                  : code === 'EEXIST' ? 409
                    : code === 'EINVAL' ? 400
                      : 500;
              return sendJson(res, status, { error: String((err && err.message) || err) });
            }
          }

          // 统一文档 v2 保存：**正文文件先行、配置最后**（配置=提交点）。不变量集中在服务端一处：
          // 任一正文写失败 → 直接返回错误、**不写配置**；前端无需编排写序，也不会写出半成品。
          // 请求：{ name, doc, files?: [{path, text}], configPath? }；configPath 缺省时
          // name = 标签页名（→ graphs/<净化名>.se.json），显式 configPath = 外部文档写回路径。
          // 正文 path 支持相对项目根 / 绝对（与 /api/fs/write 同盘符守卫）。
          if (req.method === 'POST' && url.pathname === '/api/document/save') {
            const body = JSON.parse(await readBody(req));
            const doc = body && body.doc;
            if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.streams)) {
              return sendJson(res, 400, { error: 'invalid document payload' });
            }
            // 显式 configPath（外部文档写回）：盘符守卫 + resolveUserPath，跳过名称净化；
            // 缺省维持 graphs/<净化名>.se.json（应用内新建语义不变）。
            const explicitConfig = String(body.configPath == null ? '' : body.configPath).trim();
            let configPath;
            let configName;
            if (explicitConfig) {
              if (!isWithinDrives(explicitConfig)) {
                return sendJson(res, 403, { error: `forbidden: ${explicitConfig}` });
              }
              configPath = resolveUserPath(explicitConfig);
              configName = path.basename(configPath);
            } else {
              configName = sanitizeName(String(body.name == null ? '' : body.name)) + GRAPH_CONFIG_EXT;
              configPath = path.join(graphsDir, configName);
            }
            const files = Array.isArray(body.files) ? body.files : [];
            const written = [];
            try {
              for (const f of files) {
                if (!f || typeof f !== 'object') continue;
                const target = String(f.path == null ? '' : f.path).trim();
                if (!target) continue;
                if (!isWithinDrives(target)) return sendJson(res, 403, { error: `forbidden: ${target}` });
                const resolved = resolveUserPath(target);
                atomicWriteFileSync(resolved, f.text == null ? '' : String(f.text));
                written.push(resolved);
              }
              // 配置最后写（提交点）。
              atomicWriteFileSync(configPath, JSON.stringify(doc, null, 2));
              return sendJson(res, 200, { ok: true, path: configPath, name: configName, written });
            } catch (err) {
              const code = err && err.code;
              const status = code === 'EACCES' || code === 'EPERM' ? 403 : 500;
              return sendJson(res, status, { error: String((err && err.message) || err) });
            }
          }

          if (req.method === 'GET' && url.pathname === '/api/workspace') {
            if (!fs.existsSync(workspaceFile)) return sendJson(res, 404, { error: 'not found' });
            const parsed = JSON.parse(fs.readFileSync(workspaceFile, 'utf-8'));
            return sendJson(res, 200, parsed);
          }

          if (req.method === 'POST' && url.pathname === '/api/workspace') {
            const body = await readBody(req);
            const parsed = JSON.parse(body);
            if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tabs)) {
              return sendJson(res, 400, { error: 'invalid workspace payload' });
            }
            const tmp = workspaceFile + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(parsed));
            fs.renameSync(tmp, workspaceFile);
            return sendJson(res, 200, { ok: true, path: workspaceFile });
          }

          if (req.method === 'GET' && url.pathname === '/api/history') {
            // 只返回仍存在的文件：悬空条目（被删/外部路径）不外泄。
            return sendJson(
              res,
              200,
              loadHistory()
                .filter((e) => e && e.path && fs.existsSync(e.path))
                .slice(0, 10)
            );
          }

          if (req.method === 'POST' && url.pathname === '/api/history/delete') {
            const body = JSON.parse(await readBody(req));
            saveHistory(loadHistory().filter((e) => e.path !== body.path));
            return sendJson(res, 200, { ok: true });
          }

          if (req.method === 'POST' && url.pathname === '/api/dialog/save') {
            const opts = parseDialogOpts(await readBody(req));
            return sendJson(res, 200, { path: await runDialog('save', opts) });
          }

          if (req.method === 'POST' && url.pathname === '/api/dialog/open') {
            const opts = parseDialogOpts(await readBody(req));
            return sendJson(res, 200, { path: await runDialog('open', opts) });
          }

          if (req.method === 'GET' && url.pathname === '/api/fs/drives') {
            return sendJson(res, 200, listDrives());
          }

          // 项目根（posix）：客户端 docPath 相对化基准。
          if (req.method === 'GET' && url.pathname === '/api/project/info') {
            return sendJson(res, 200, { projectRoot: projectRoot.replace(/\\/g, '/').replace(/\/+$/, '') });
          }

          if (req.method === 'GET' && url.pathname === '/api/fs/list') {
            const raw = url.searchParams.get('path');
            if (!raw) return sendJson(res, 400, { error: 'path required' });
            if (!isWithinDrives(raw)) return sendJson(res, 403, { error: 'forbidden' });
            const resolved = resolveUserPath(raw);
            try {
              const dirents = fs.readdirSync(resolved, { withFileTypes: true });
              const entries = dirents.map((dirent) => {
                const entryPath = path.join(resolved, dirent.name);
                return { name: dirent.name, path: entryPath, ...entryMeta(entryPath, dirent) };
              });
              entries.sort((a, b) => {
                if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
                return a.name.localeCompare(b.name, 'zh-CN');
              });
              const truncated = entries.length > 2000;
              const limited = truncated ? entries.slice(0, 2000) : entries;
              const parentDir = path.dirname(resolved);
              const payload = {
                path: resolved,
                parent: parentDir === resolved ? null : parentDir,
                entries: limited,
              };
              if (truncated) payload.truncated = true;
              return sendJson(res, 200, payload);
            } catch (err) {
              const code = err && err.code;
              const status =
                code === 'ENOENT' ? 404 : code === 'EACCES' || code === 'EPERM' ? 403 : 400;
              return sendJson(res, status, { error: String((err && err.message) || err) });
            }
          }

          // 目录搜索：默认一层；recursive=1 时迭代式递归（不跟进符号链接），按文件名包含匹配（不区分大小写）。
          if (req.method === 'GET' && url.pathname === '/api/fs/search') {
            const raw = url.searchParams.get('path');
            if (!raw) return sendJson(res, 400, { error: 'path required' });
            if (!isWithinDrives(raw)) return sendJson(res, 403, { error: 'forbidden' });
            const resolved = resolveUserPath(raw);
            const q = (url.searchParams.get('q') || '').trim();
            const recursive = url.searchParams.get('recursive') === '1';
            const limitRaw = Number.parseInt(url.searchParams.get('limit') || '', 10);
            const limit = Number.isFinite(limitRaw)
              ? Math.min(2000, Math.max(1, limitRaw))
              : (recursive ? 300 : 2000);
            try {
              const ql = q.toLowerCase();
              let entries;
              let truncated = false;
              if (recursive) {
                // 显式栈迭代遍历：单目录读取失败跳过；junction/符号链接目录同样跟进，realpath 去环。
                const stack = [{ dir: resolved, depth: 0 }];
                const visitedDirs = new Set([realDirKey(resolved)]);
                const results = [];
                let visited = 0;
                let stopped = false;
                while (stack.length > 0 && !stopped) {
                  const frame = stack.pop();
                  let dirents;
                  try {
                    dirents = fs.readdirSync(frame.dir, { withFileTypes: true });
                  } catch (err) {
                    continue;
                  }
                  for (const dirent of dirents) {
                    visited += 1;
                    const entryPath = path.join(frame.dir, dirent.name);
                    if (q === '' || dirent.name.toLowerCase().includes(ql)) {
                      results.push({
                        name: dirent.name,
                        path: entryPath,
                        dir: frame.dir,
                        ...entryMeta(entryPath, dirent),
                      });
                    }
                    if (results.length >= limit || visited >= MAX_VISIT) {
                      stopped = true;
                      break;
                    }
                    if (frame.depth + 1 <= MAX_DEPTH) {
                      if (dirent.isDirectory()) {
                        stack.push({ dir: entryPath, depth: frame.depth + 1 });
                      } else if (dirent.isSymbolicLink() && probeIsDir(entryPath)) {
                        const key = realDirKey(entryPath);
                        if (!visitedDirs.has(key)) {
                          visitedDirs.add(key);
                          stack.push({ dir: entryPath, depth: frame.depth + 1 });
                        }
                      }
                    }
                  }
                }
                entries = results;
                truncated = stopped;
              } else {
                const dirents = fs.readdirSync(resolved, { withFileTypes: true });
                entries = dirents
                  .filter((dirent) => q === '' || dirent.name.toLowerCase().includes(ql))
                  .map((dirent) => {
                    const entryPath = path.join(resolved, dirent.name);
                    return {
                      name: dirent.name,
                      path: entryPath,
                      dir: resolved,
                      ...entryMeta(entryPath, dirent),
                    };
                  });
                truncated = entries.length > limit;
              }
              entries.sort((a, b) => {
                if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
                return a.name.localeCompare(b.name, 'zh-CN');
              });
              const limited = truncated ? entries.slice(0, limit) : entries;
              const parentDir = path.dirname(resolved);
              const payload = {
                path: resolved,
                parent: parentDir === resolved ? null : parentDir,
                query: q,
                recursive,
                entries: limited,
              };
              if (truncated) payload.truncated = true;
              return sendJson(res, 200, payload);
            } catch (err) {
              const code = err && err.code;
              const status =
                code === 'ENOENT' ? 404 : code === 'EACCES' || code === 'EPERM' ? 403 : 400;
              return sendJson(res, status, { error: String((err && err.message) || err) });
            }
          }

          if (req.method === 'POST' && url.pathname === '/api/fs/open') {
            const body = JSON.parse(await readBody(req));
            const target = String(body.path || '').trim();
            if (!target) return sendJson(res, 400, { error: 'empty path' });
            if (!isWithinDrives(target)) return sendJson(res, 403, { error: 'forbidden' });
            const reveal = !!body.reveal;
            if (!reveal && EXEC_EXTS.has(path.extname(resolveUserPath(target)).toLowerCase())) {
              return sendJson(res, 403, { error: 'exec-blocked' });
            }
            await openPath(resolveUserPath(target), reveal);
            return sendJson(res, 200, { ok: true });
          }

          // 原始文本读写（内容文件 / SE 配置包兄弟文件通道）：
          // 盘符守卫 + 递归建目录 + UTF-8，**不强制扩展名、不做 JSON 包裹**。
          if (req.method === 'POST' && url.pathname === '/api/fs/read') {
            const body = JSON.parse(await readBody(req));
            const target = String(body.path || '').trim();
            if (!target) return sendJson(res, 400, { error: 'empty path' });
            if (!isWithinDrives(target)) return sendJson(res, 403, { error: 'forbidden' });
            const resolved = resolveUserPath(target);
            try {
              const text = fs.readFileSync(resolved, 'utf-8');
              return sendJson(res, 200, { path: resolved, text });
            } catch (err) {
              const code = err && err.code;
              const status =
                code === 'ENOENT' ? 404 : code === 'EACCES' || code === 'EPERM' ? 403 : 400;
              return sendJson(res, status, { error: String((err && err.message) || err) });
            }
          }

          // 图片资产（P2 图片支持）：返回二进制本体，**不走 sendJson**。
          // 扩展名白名单（无 SVG）+ magic bytes 双重校验；超 32 MiB → 413。
          if (req.method === 'POST' && url.pathname === '/api/fs/asset') {
            const body = JSON.parse(await readBody(req));
            const target = String(body.path || '').trim();
            if (!target) return sendJson(res, 400, { error: 'empty path' });
            if (!isWithinDrives(target)) return sendJson(res, 403, { error: 'forbidden' });
            const resolved = resolveUserPath(target);
            const ext = path.extname(resolved).toLowerCase();
            if (!ASSET_MIME_BY_EXT.has(ext)) {
              const msg =
                ext === '.svg' ? 'SVG 不支持，请先转成 PNG/WebP' : 'unsupported image type';
              return sendJson(res, 415, { error: msg });
            }
            try {
              const stat = fs.statSync(resolved);
              if (!stat.isFile()) return sendJson(res, 400, { error: 'not a regular file' });
              if (stat.size > MAX_ASSET_BYTES) return sendJson(res, 413, { error: 'file too large' });
              const buf = fs.readFileSync(resolved);
              if (buf.length > MAX_ASSET_BYTES) {
                return sendJson(res, 413, { error: 'file too large' });
              }
              const mime = sniffImageMime(buf);
              if (!mime) return sendJson(res, 415, { error: 'unsupported image content' });
              res.writeHead(200, {
                'Content-Type': mime,
                'Content-Length': buf.length,
                'Cache-Control': 'no-store',
              });
              res.end(buf);
              return undefined;
            } catch (err) {
              const code = err && err.code;
              const status =
                code === 'ENOENT' ? 404 : code === 'EACCES' || code === 'EPERM' ? 403 : 400;
              return sendJson(res, status, { error: String((err && err.message) || err) });
            }
          }

          if (req.method === 'POST' && url.pathname === '/api/fs/write') {
            const body = JSON.parse(await readBody(req));
            const target = String(body.path || '').trim();
            if (!target) return sendJson(res, 400, { error: 'empty path' });
            if (!isWithinDrives(target)) return sendJson(res, 403, { error: 'forbidden' });
            const resolved = resolveUserPath(target);
            const text = body.text == null ? '' : String(body.text);
            try {
              fs.mkdirSync(path.dirname(resolved), { recursive: true });
              if (body.atomic) {
                const tmp = resolved + '.tmp';
                fs.writeFileSync(tmp, text, 'utf-8');
                fs.renameSync(tmp, resolved);
              } else {
                fs.writeFileSync(resolved, text, 'utf-8');
              }
              return sendJson(res, 200, { ok: true, path: resolved });
            } catch (err) {
              const code = err && err.code;
              const status = code === 'EACCES' || code === 'EPERM' ? 403 : 400;
              return sendJson(res, status, { error: String((err && err.message) || err) });
            }
          }

          // 文件/目录移动（tab/node 重命名）：盘符守卫 + 递归建目录 + rename（OneDrive 重试）。
          // from 缺失 → 200 {moved:false}（草稿/无内容属正常态，非错误），让前端幂等调用。
          if (req.method === 'POST' && url.pathname === '/api/fs/move') {
            const body = JSON.parse(await readBody(req));
            const from = String(body.from == null ? '' : body.from).trim();
            const to = String(body.to == null ? '' : body.to).trim();
            if (!from || !to) return sendJson(res, 400, { error: 'from/to required' });
            if (!isWithinDrives(from) || !isWithinDrives(to)) return sendJson(res, 403, { error: 'forbidden' });
            const src = resolveUserPath(from);
            const dst = resolveUserPath(to);
            const targetExists = fs.existsSync(dst);
            if (!fs.existsSync(src)) {
              // 源缺失是正常态（草稿/已移动），但调用方必须用 targetExists 判断
              // 是「已到位」还是「真缺失」，绝不能把 moved:false 当成功。
              return sendJson(res, 200, {
                ok: true,
                moved: false,
                sourceExists: false,
                targetExists,
                from: src,
                to: dst,
              });
            }
            const caseOnly =
              process.platform === 'win32' &&
              path.resolve(src).toLowerCase() === path.resolve(dst).toLowerCase() &&
              path.resolve(src) !== path.resolve(dst);
            if (targetExists && !caseOnly) {
              return sendJson(res, 409, {
                error: 'target-exists',
                code: 'EEXIST',
                targetExists: true,
                from: src,
                to: dst,
              });
            }
            try {
              fs.mkdirSync(path.dirname(dst), { recursive: true });
              if (caseOnly) {
                // Windows 仅大小写改名：先迁到临时名，再落到目标名，避免
                // MoveFileEx 对“同一文件不同大小写”的兼容行为不确定。
                const tmp = `${dst}.rename-${process.pid}-${Date.now()}`;
                renameSyncWithRetry(src, tmp);
                try {
                  renameSyncWithRetry(tmp, dst);
                } catch (err) {
                  try {
                    renameSyncWithRetry(tmp, src);
                  } catch {
                    /* 回滚失败：保留 tmp，交由上层告警 */
                  }
                  throw err;
                }
              } else {
                renameSyncWithRetry(src, dst);
              }
              return sendJson(res, 200, { ok: true, moved: true, caseOnly, from: src, to: dst });
            } catch (err) {
              const code = err && err.code;
              const status = code === 'EACCES' || code === 'EPERM' ? 403 : 500;
              return sendJson(res, status, { error: String((err && err.message) || err), code });
            }
          }

          // 文件/目录删除（配置面板清理）：盘符守卫 + 递归 rm（force）。
          // 目标缺失 → 200 {deleted:false}（缺失是正常态，同 fs/move 幂等哲学）。
          if (req.method === 'POST' && url.pathname === '/api/fs/delete') {
            const body = JSON.parse(await readBody(req));
            const target = String(body.path == null ? '' : body.path).trim();
            const recursive = !!body.recursive;
            if (!target) return sendJson(res, 400, { error: 'empty path' });
            if (!isWithinDrives(target)) return sendJson(res, 403, { error: 'forbidden' });
            const resolved = resolveUserPath(target);
            if (!fs.existsSync(resolved)) return sendJson(res, 200, { ok: true, deleted: false });
            if (fs.statSync(resolved).isDirectory() && !recursive) return sendJson(res, 400, { error: 'recursive required' });
            try {
              removeRecursiveWithRetry(resolved, recursive);
              return sendJson(res, 200, { ok: true, deleted: true });
            } catch (err) {
              const code = err && err.code;
              const status = code === 'EACCES' || code === 'EPERM' ? 403 : 500;
              return sendJson(res, status, { error: String((err && err.message) || err) });
            }
          }

          // 文件/目录复制（配置面板导出）：盘符守卫 + 递归建目录 + cp（recursive）。
          // 目标已存在 → 409（覆盖非预期，拒绝静默替换）。
          if (req.method === 'POST' && url.pathname === '/api/fs/copy') {
            const body = JSON.parse(await readBody(req));
            const from = String(body.from == null ? '' : body.from).trim();
            const to = String(body.to == null ? '' : body.to).trim();
            if (!from || !to) return sendJson(res, 400, { error: 'from/to required' });
            if (!isWithinDrives(from) || !isWithinDrives(to)) return sendJson(res, 403, { error: 'forbidden' });
            const src = resolveUserPath(from);
            const dst = resolveUserPath(to);
            if (!fs.existsSync(src)) return sendJson(res, 404, { error: 'source not found' });
            if (fs.existsSync(dst)) return sendJson(res, 409, { error: 'target exists' });
            try {
              fs.mkdirSync(path.dirname(dst), { recursive: true });
              copyRecursiveWithRetry(src, dst);
              return sendJson(res, 200, { ok: true, from: src, to: dst });
            } catch (err) {
              const code = err && err.code;
              const status = code === 'EACCES' || code === 'EPERM' ? 403 : 500;
              return sendJson(res, status, { error: String((err && err.message) || err) });
            }
          }

          // 文件存在探针（期 11 配置包导入预览：tool_path 路径缺失预警）：
          // 盘符守卫；ENOENT → 200 {exists:false}（"缺失"是正常态，非错误）。
          if (req.method === 'POST' && url.pathname === '/api/fs/stat') {
            const body = JSON.parse(await readBody(req));
            const target = String(body.path || '').trim();
            if (!target) return sendJson(res, 400, { error: 'empty path' });
            if (!isWithinDrives(target)) return sendJson(res, 403, { error: 'forbidden' });
            const resolved = resolveUserPath(target);
            try {
              const st = fs.statSync(resolved);
              return sendJson(res, 200, {
                exists: true,
                isFile: st.isFile(),
                isDirectory: st.isDirectory(),
                size: st.size,
              });
            } catch (err) {
              const code = err && err.code;
              if (code === 'ENOENT') return sendJson(res, 200, { exists: false });
              const status = code === 'EACCES' || code === 'EPERM' ? 403 : 400;
              return sendJson(res, status, { error: String((err && err.message) || err) });
            }
          }

          if (url.pathname === '/api/fs/frecency') {
            if (req.method === 'GET') {
              return sendJson(res, 200, refreshFrecencyTypes(loadFrecency()));
            }
            if (req.method === 'POST') {
              const body = JSON.parse(await readBody(req));
              const target = String(body.path || '').trim();
              if (!target) return sendJson(res, 400, { error: 'empty path' });
              const list = loadFrecency();
              const entry = list.find((e) => e && e.path === target);
              if (entry) {
                entry.score = (Number(entry.score) || 0) + 1;
                if (body.name !== undefined) entry.name = body.name;
                if (body.type !== undefined) entry.type = body.type;
                entry.lastUsed = Date.now();
              } else {
                list.push({
                  path: target,
                  name: body.name || path.basename(target),
                  type: body.type || 'file',
                  score: 1,
                  lastUsed: Date.now(),
                });
              }
              list.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
              const trimmed = list.slice(0, 50);
              saveFrecency(trimmed);
              return sendJson(res, 200, trimmed);
            }
          }

          if (url.pathname.startsWith('/api/store/')) {
            const name = decodeURIComponent(url.pathname.slice('/api/store/'.length));
            if (!STORE_WHITELIST.has(name)) return sendJson(res, 400, { error: 'invalid name' });
            const file = path.join(graphsDir, `.${name}.json`);
            if (req.method === 'GET') {
              if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'not found' });
              res.setHeader('Content-Type', 'application/json');
              return fs.createReadStream(file).pipe(res);
            }
            if (req.method === 'POST') {
              const body = await readBody(req);
              let parsed;
              try {
                parsed = JSON.parse(body);
              } catch (err) {
                return sendJson(res, 400, { error: 'invalid json' });
              }
              const tmp = file + '.tmp';
              fs.writeFileSync(tmp, JSON.stringify(parsed));
              fs.renameSync(tmp, file);
              return sendJson(res, 200, { ok: true, path: file });
            }
            return sendJson(res, 405, { error: 'method not allowed' });
          }

          return sendJson(res, 404, { error: 'not found' });
        } catch (err) {
          return sendJson(res, 500, { error: String((err && err.message) || err) });
        }
  };
}

export function graphsApi(options = {}) {
  return {
    name: 'graphs-api',
    configureServer(server) {
      server.middlewares.use(createGraphsApiMiddleware(options));
    },
  };
}
