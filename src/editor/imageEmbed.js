// 图片嵌入（浏览器侧）：把原始图片文件降采样 + 压成有界的内联 data URI。
//
// 设计约束（P2）：
// - 不引入资源仓库：图片字节全部以内联 data: URI 走 Markdown 文本，随内容一起保存。
// - 有界：最长边 ≤ 1280，编码后 ≤ 256 KiB；源文件 ≤ 32 MiB。
// - 不放大：scale = min(1, maxEdge / 长边)。
// - 只信任位图格式（png/jpeg/gif/webp）；SVG 可携带脚本，一律拒绝。
//
// 本模块只在浏览器里跑（canvas / createImageBitmap）。纯函数（MIME 判定、
// data URI 字节估算）可在 Node 单测里直接引用。

export const MAX_IMAGE_EDGE = 1280;
export const MAX_IMAGE_BYTES = 256 * 1024;
export const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
export const SUPPORTED_IMAGE_MIME = /^image\/(png|jpe?g|gif|webp)$/i;

/** 文件是否是 SVG（type 或扩展名任一命中即算）。 */
export function isSvgFile(file) {
  if (!file) return false;
  const type = String(file.type || '').toLowerCase();
  if (type === 'image/svg+xml' || type === 'image/svg') return true;
  const name = String(file.name || '');
  return /\.svg$/i.test(name);
}

/**
 * 源文件准入：非空、有大小、不超过 32 MiB、非 SVG、MIME 在白名单内。
 * 注意：只是「值得尝试压缩」，最终大小由 fileToImageDataUrl 保证。
 */
export function isSupportedImageFile(file) {
  if (!file) return false;
  const size = Number(file.size);
  if (!Number.isFinite(size) || size <= 0) return false;
  if (size > MAX_SOURCE_BYTES) return false;
  if (isSvgFile(file)) return false;
  return SUPPORTED_IMAGE_MIME.test(String(file.type || ''));
}

/**
 * 估算 data URI 的原始字节数（base64 解码后的长度）。
 * 非法 / 空 payload 返回 0。容忍 base64 里的换行与空白。
 */
export function estimateDataUrlBytes(dataUrl) {
  if (typeof dataUrl !== 'string') return 0;
  const marker = ';base64,';
  const at = dataUrl.indexOf(marker);
  if (at < 0 || !dataUrl.startsWith('data:')) return 0;
  const payload = dataUrl.slice(at + marker.length).replace(/\s+/g, '');
  if (!payload) return 0;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return 0;
  let pad = 0;
  if (payload.endsWith('==')) pad = 2;
  else if (payload.endsWith('=')) pad = 1;
  const bytes = Math.floor((payload.length * 3) / 4) - pad;
  return bytes > 0 ? bytes : 0;
}

/** 在 canvas 上按长边上限绘制（永不放大）。返回绘制后的尺寸。 */
function drawScaled(ctx, source, width, height, maxEdge, opaque) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = ctx.canvas;
  canvas.width = w;
  canvas.height = h;
  ctx.clearRect(0, 0, w, h);
  if (opaque) {
    // JPEG 无 alpha：先铺白底，避免透明区域变成黑块。
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(source, 0, 0, w, h);
  return { width: w, height: h };
}

/** 把 blob/file 解码成可绘制的位图源；优先 createImageBitmap（带 EXIF 朝向）。 */
async function decodeSource(file) {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      dispose: () => {
        try {
          bitmap.close();
        } catch (err) {
          /* ignore */
        }
      },
    };
  }
  // 回退：<img> + object URL（老浏览器 / 无 createImageBitmap）。
  const objectUrl = URL.createObjectURL(file);
  const img = new Image();
  img.decoding = 'async';
  try {
    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('图片解码失败'));
      img.src = objectUrl;
    });
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) throw new Error('图片解码失败');
    return {
      source: img,
      width,
      height,
      dispose: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (err) {
    URL.revokeObjectURL(objectUrl);
    throw err;
  }
}

/**
 * 图片文件 → 有界 data URI。
 *
 * 编码候选顺序：WebP 0.82 / 0.70 / 0.55，然后 JPEG 0.80 / 0.60（后两个逐步降到
 * 1024 / 896 长边）。命中第一个 ≤ maxBytes 就返回；全都不行则报错。
 *
 * @returns {Promise<{dataUrl: string, mime: string, bytes: number, width: number, height: number}>}
 */
export async function fileToImageDataUrl(
  file,
  { maxEdge = MAX_IMAGE_EDGE, maxBytes = MAX_IMAGE_BYTES } = {}
) {
  if (isSvgFile(file)) throw new Error('SVG 不支持，请先转成 PNG/WebP');
  if (!file) throw new Error('没有可插入的图片');

  if (typeof document === 'undefined') throw new Error('当前环境不支持图片压缩');

  const decoded = await decodeSource(file);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    decoded.dispose();
    throw new Error('浏览器不支持图片压缩（canvas 2d 不可用）');
  }

  const candidates = [
    { mime: 'image/webp', quality: 0.82, edge: maxEdge },
    { mime: 'image/webp', quality: 0.7, edge: maxEdge },
    { mime: 'image/webp', quality: 0.55, edge: maxEdge },
    { mime: 'image/jpeg', quality: 0.8, edge: maxEdge },
    { mime: 'image/jpeg', quality: 0.6, edge: Math.min(1024, maxEdge) },
    { mime: 'image/jpeg', quality: 0.6, edge: Math.min(896, maxEdge) },
  ];

  try {
    for (const candidate of candidates) {
      const size = drawScaled(
        ctx,
        decoded.source,
        decoded.width,
        decoded.height,
        candidate.edge,
        candidate.mime === 'image/jpeg'
      );
      let dataUrl = canvas.toDataURL(candidate.mime, candidate.quality);
      let mime = candidate.mime;
      // toDataURL 静默回退成 PNG（旧 Safari / 不支持 WebP）时改走 JPEG（先铺白底）。
      if (mime === 'image/webp' && !dataUrl.startsWith('data:image/webp')) {
        const jpegSize = drawScaled(
          ctx,
          decoded.source,
          decoded.width,
          decoded.height,
          candidate.edge,
          true
        );
        dataUrl = canvas.toDataURL('image/jpeg', candidate.quality);
        mime = 'image/jpeg';
        if (!dataUrl.startsWith('data:image/jpeg')) continue;
        const bytes = estimateDataUrlBytes(dataUrl);
        if (bytes > 0 && bytes <= maxBytes) {
          return { dataUrl, mime, bytes, width: jpegSize.width, height: jpegSize.height };
        }
        continue;
      }
      if (!dataUrl || !dataUrl.startsWith('data:')) continue;
      const bytes = estimateDataUrlBytes(dataUrl);
      if (bytes > 0 && bytes <= maxBytes) {
        return { dataUrl, mime, bytes, width: size.width, height: size.height };
      }
    }
  } finally {
    decoded.dispose();
  }

  throw new Error('图片压缩后仍超过 256 KiB，请换更小的截图');
}
