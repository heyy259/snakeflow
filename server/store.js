// 历史 / frecency 持久化与旧数据一次性迁移（graphs 世界）。
import fs from 'node:fs';
import path from 'node:path';
import { graphsDir, legacyFlowsDir, historyFile, frecencyFile, isWithinDrives } from './paths.js';
import { removeFileBestEffort } from './resilientFs.js';

/**
 * 一次性迁移：旧的 flows/ 目录 → graphs/，并把 history.json 中
 * 指向 ...reactflow\flows\ 的绝对路径改写为 ...reactflow\graphs\。
 * 幂等；失败不阻塞启动。
 */
export function migrateLegacyFlows() {
  try {
    if (fs.existsSync(legacyFlowsDir)) {
      fs.mkdirSync(graphsDir, { recursive: true });
      for (const name of fs.readdirSync(legacyFlowsDir)) {
        const src = path.join(legacyFlowsDir, name);
        const dst = path.join(graphsDir, name);
        if (!fs.existsSync(dst)) fs.renameSync(src, dst);
      }
      if (fs.readdirSync(legacyFlowsDir).length === 0) fs.rmdirSync(legacyFlowsDir);
    }
    if (fs.existsSync(historyFile)) {
      const list = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
      if (Array.isArray(list)) {
        let changed = false;
        for (const entry of list) {
          if (entry && typeof entry.path === 'string' && /reactflow[\\/]flows[\\/]/i.test(entry.path)) {
            entry.path = entry.path.replace(/(reactflow[\\/])flows([\\/])/i, '$1graphs$2');
            changed = true;
          }
        }
        if (changed) fs.writeFileSync(historyFile, JSON.stringify(list, null, 2));
      }
    }
  } catch (err) {
    /* 迁移失败不应阻塞 dev server 启动 */
  }
}

export function loadHistory() {
  try {
    const list = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
    if (Array.isArray(list)) return list;
  } catch (err) {
    if (err.code !== 'ENOENT') removeFileBestEffort(historyFile);
  }
  return [];
}

export function saveHistory(list) {
  fs.mkdirSync(graphsDir, { recursive: true });
  // 落盘即裁剪：丢弃已不存在文件的悬空条目（测试用完即删的临时图不会长期堆积）。
  const pruned = (Array.isArray(list) ? list : []).filter((e) => e && e.path && fs.existsSync(e.path));
  fs.writeFileSync(historyFile, JSON.stringify(pruned.slice(0, 50), null, 2));
}

export function loadFrecency() {
  try {
    const parsed = JSON.parse(fs.readFileSync(frecencyFile, 'utf-8'));
    if (Array.isArray(parsed)) return parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') removeFileBestEffort(frecencyFile);
  }
  return [];
}

export function saveFrecency(list) {
  fs.mkdirSync(graphsDir, { recursive: true });
  fs.writeFileSync(frecencyFile, JSON.stringify(list.slice(0, 50), null, 2));
}

// GET 自愈：按磁盘现状重判 type，修正历史上被误存为 file 的目录。
export function refreshFrecencyTypes(list) {
  return list.map((entry) => {
    if (!entry || typeof entry.path !== 'string' || !isWithinDrives(entry.path)) return entry;
    let stat = null;
    try {
      stat = fs.statSync(entry.path);
    } catch (err) {
      stat = null;
    }
    if (stat) return { ...entry, type: stat.isDirectory() ? 'dir' : 'file' };
    try {
      return { ...entry, type: fs.lstatSync(entry.path).isDirectory() ? 'dir' : 'file' };
    } catch (err) {
      return entry;
    }
  });
}
