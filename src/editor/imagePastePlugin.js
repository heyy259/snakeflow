// 图片粘贴 / 拖放（ProseMirror plugin）。
//
// 只负责「识别 + 拦截 + 上报」：真正的降采样/编码/插入在 MilkdownHost 侧异步做，
// 因此 handler 内绝不 await（ProseMirror 要求同步返回是否已处理）。
//
// 依赖 milkdown/prosemirror：仅允许被懒加载的 MilkdownHost 引用；
// collectImageFiles 是纯函数，可被 Node 单测直接引用。

import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { isSupportedImageFile } from './imageEmbed.js';

export const imagePasteKey = new PluginKey('image-paste');

/**
 * 从 DataTransfer 收集可插入的图片文件：
 * - 合并 files 与 items（kind === 'file' 且 type 以 image/ 开头，走 getAsFile()）；
 * - 过滤 isSupportedImageFile（非图片、SVG、空文件、超大文件）；
 * - 按「引用」和「name|size」双重去重（浏览器常在 files 与 items 里给同一份）。
 */
export function collectImageFiles(dataTransfer) {
  if (!dataTransfer) return [];
  const out = [];
  const seenRefs = new Set();
  const seenKeys = new Set();

  const push = (file) => {
    if (!file) return;
    if (!isSupportedImageFile(file)) return;
    if (seenRefs.has(file)) return;
    const key = `${String(file.name || '')}|${Number(file.size) || 0}`;
    if (seenKeys.has(key)) return;
    seenRefs.add(file);
    seenKeys.add(key);
    out.push(file);
  };

  const files = dataTransfer.files;
  if (files) {
    for (let i = 0; i < files.length; i += 1) push(files[i]);
  }

  const items = dataTransfer.items;
  if (items) {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (!item || item.kind !== 'file') continue;
      if (!String(item.type || '').startsWith('image/')) continue;
      if (typeof item.getAsFile !== 'function') continue;
      let file = null;
      try {
        file = item.getAsFile();
      } catch (err) {
        file = null;
      }
      push(file);
    }
  }

  return out;
}

/**
 * 粘贴/拖放图片插件。
 * @param {{ onImages?: (files: File[], range: {from:number,to:number}) => void }} options
 */
export function createImagePastePlugin({ onImages } = {}) {
  return $prose(
    () =>
      new Plugin({
        key: imagePasteKey,
        props: {
          handlePaste(view, event) {
            const files = collectImageFiles(event.clipboardData);
            if (!files.length) return false; // 纯文本粘贴照常交给浏览器
            event.preventDefault();
            event.stopPropagation();
            const { from, to } = view.state.selection;
            onImages?.(files, { from, to });
            return true;
          },
          handleDrop(view, event, slice, moved) {
            if (moved) return false; // 编辑器内部拖动不算「放入外部图片」
            const files = collectImageFiles(event.dataTransfer);
            if (!files.length) return false;
            event.preventDefault();
            event.stopPropagation();
            const { from, to } = view.state.selection;
            onImages?.(files, { from, to });
            return true;
          },
        },
      })
  );
}
