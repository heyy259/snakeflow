// 项目根缓存（fetch 失败降级为空串 = 不相对化，行为同改造前）。
//
// 服务端 `GET /api/project/info` → `{ projectRoot: "<posix 绝对路径>" }`。
// 客户端 `portableDocPath` / `absolutizeDocPath` 依靠它把项目内路径持久化为相对形式；
// 拿不到根时一律以空串降级（不相对化），使行为与改造前逐字节等价。

let cached = '';
let inflight = null;

/**
 * 拉取并缓存项目根（posix，去尾斜杠）。并发调用共享同一 in-flight Promise，避免重复请求。
 * 失败（网络 / 非 2xx / 解析失败）→ 缓存空串（intentional degradation：保持绝对路径）。
 * @returns {Promise<string>} 缓存的项目根（失败时 `''`）
 */
export async function ensureProjectRoot() {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch('/api/project/info');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      cached = String((data && data.projectRoot) || '')
        .replace(/\\/g, '/')
        .replace(/\/+$/, '');
    } catch (err) {
      // 降级：项目根未知 → 空串，调用方保持绝对路径（行为同改造前）。
      cached = '';
    } finally {
      inflight = null;
    }
    return cached;
  })();
  return inflight;
}

/** 同步读取已缓存的项目根（空串 = 未就绪 / 降级）。 */
export function getProjectRoot() {
  return cached;
}
