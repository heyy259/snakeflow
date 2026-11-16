// MilkdownHost：节点内就地编辑的 milkdown 薄封装。
//
// 设计要点（对齐升级改造方案 §4.2/§6）：
// - 默认导出，供 React.lazy(() => import('./editor/MilkdownHost.jsx')) 懒加载；
//   milkdown 只在进入编辑态时随本 chunk 载入，只读渲染零编辑器成本。
// - 全局单实例由 App 的 editingNodeId 保证：同一时刻只有本组件挂载一次。
// - 装配照抄 ColaMD editor.ts 的标准组合（commonmark + gfm + history + listener，
//   remarkBreaks 经 remarkPluginsCtx 注入）；**不含** math / mermaid / search。
// - 暴露命令出口给 AgentNode（浮动工具栏 / 源面板 / Bridge）：
//     undo() / redo() / getMarkdown() / setMarkdown() / clearFormat()
//     insertTextAtSavedSelection(text) / insertImage({src, alt}) / focus()
// - 图片：粘贴/拖放 → createImagePastePlugin → fileToImageDataUrl（降采样）→
//   schema.nodes.image 内联节点（data URI 随 Markdown 文本走，无资源仓库）。
// - onChange 经 listenerCtx.markdownUpdated 通知调用方置脏。

import { useEffect, useRef } from 'react';
import {
  Editor,
  rootCtx,
  defaultValueCtx,
  editorViewCtx,
  serializerCtx,
  remarkPluginsCtx,
  remarkStringifyOptionsCtx,
} from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { history, undoCommand, redoCommand } from '@milkdown/kit/plugin/history';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { callCommand, replaceAll } from '@milkdown/kit/utils';
import { lift } from '@milkdown/kit/prose/commands';
import { liftListItem } from '@milkdown/kit/prose/schema-list';
import { EditorState, Selection, TextSelection } from '@milkdown/kit/prose/state';
import { closeHistory } from '@milkdown/kit/prose/history';
import remarkBreaks from 'remark-breaks';
import { fold, foldRemark, setFoldContext, resetFoldContext, computeFoldKey } from './fold/index.js';
import { setFoldsOpen, notifyFolds } from '../foldState.js';
import { viewStateKey } from '../viewStateScope.js';
import { applySnippetToView } from './snippets.js';
import { splitCallMarkers } from './callMarkers.js';
import { createSelectionPlugin } from './selBubblePlugin.js';
import { fileToImageDataUrl } from './imageEmbed.js';
import { createImagePastePlugin } from './imagePastePlugin.js';
import { caretBridge, registerNodeEditor } from '../caretBridge.js';
import '@milkdown/kit/prose/view/style/prosemirror.css';

/** 图片 alt 文本：文件名去扩展名，缺名时退化成「图片」。 */
function altFromFileName(file) {
  const name = String((file && file.name) || '');
  const base = name.replace(/\.[^.]+$/, '');
  return base || '图片';
}

/**
 * 清除格式（还原普通正文）：选区触及的 textblock 清 marks、heading→paragraph、
 * 逐层 lift list_item/blockquote，全部合并为一个事务；details_fold 是结构屏障。
 */
function runClearFormat(view) {
  const { state } = view;
  const { schema } = state;
  const sel = state.selection;

  const inDetailsFold = ($pos) => {
    for (let d = $pos.depth; d > 0; d -= 1) {
      if ($pos.node(d).type.name === 'details_fold') return true;
    }
    return false;
  };

  const targets = [];
  const addTarget = (node, pos) => {
    if (inDetailsFold(state.doc.resolve(pos + 1))) return;
    const contentStart = pos + 1;
    const contentEnd = contentStart + node.content.size;
    targets.push({
      pos,
      from: sel.empty ? contentStart : Math.max(contentStart, sel.from),
      to: sel.empty ? contentEnd : Math.min(contentEnd, sel.to),
    });
  };

  const hasCurrentMarks =
    sel.empty &&
    ((Array.isArray(state.storedMarks) && state.storedMarks.length > 0) ||
      sel.$from.marks().length > 0);

  if (sel.empty) {
    const $from = sel.$from;
    if (!inDetailsFold($from) && $from.parent.isTextblock) {
      addTarget($from.parent, $from.before($from.depth));
    }
  } else {
    state.doc.nodesBetween(sel.from, sel.to, (node, pos) => {
      if (node.type.name === 'details_fold') return false;
      if (!node.isTextblock) return true;
      addTarget(node, pos);
      return false;
    });
  }
  if (!targets.length) return false;
  targets.sort((a, b) => b.pos - a.pos);

  const tr = state.tr;

  // 命令在 working state 上计算；dispatch 时把 steps 追加进主事务并推进 working。
  const runCommand = (command, pos) => {
    const doc = tr.doc;
    const at = Math.max(0, Math.min(pos + 1, doc.content.size));
    let selection;
    try {
      selection = TextSelection.create(doc, at);
    } catch (err) {
      selection = Selection.near(doc.resolve(at));
    }
    let working = EditorState.create({ doc, selection });
    let progressed = false;
    const dispatch = (stepTr) => {
      if (!stepTr) return;
      if (stepTr.docChanged) {
        for (const step of stepTr.steps) tr.step(step);
        progressed = true;
      }
      working = working.apply(stepTr);
    };
    let ok = false;
    try {
      ok = command(working, dispatch);
    } catch (err) {
      ok = false;
    }
    return ok && progressed;
  };

  for (const target of targets) {
    const pos = tr.mapping.map(target.pos, -1);
    const block = tr.doc.nodeAt(pos);
    if (!block || !block.isTextblock) continue;

    const blockStart = pos + 1;
    const blockEnd = blockStart + block.content.size;
    const markFrom = Math.max(blockStart, Math.min(tr.mapping.map(target.from, 1), blockEnd));
    const markTo = Math.max(blockStart, Math.min(tr.mapping.map(target.to, -1), blockEnd));
    if (markTo > markFrom) tr.removeMark(markFrom, markTo, null);

    const current = tr.doc.nodeAt(pos);
    if (current && current.type.name === 'heading' && schema.nodes.paragraph) {
      tr.setNodeMarkup(pos, schema.nodes.paragraph);
    }

    for (;;) {
      const p = tr.mapping.map(target.pos, -1);
      const node = tr.doc.nodeAt(p);
      if (!node || !node.isTextblock) break;
      const $pos = tr.doc.resolve(p + 1);
      let wrapper = null;
      for (let d = $pos.depth - 1; d > 0; d -= 1) {
        const name = $pos.node(d).type.name;
        if (name === 'details_fold') break;
        if (name === 'list_item' || name === 'blockquote') {
          wrapper = name;
          break;
        }
      }
      if (!wrapper) break;
      let lifted = false;
      if (wrapper === 'list_item' && schema.nodes.list_item) {
        lifted = runCommand(liftListItem(schema.nodes.list_item), p);
      }
      if (!lifted) lifted = runCommand(lift, p);
      if (!lifted) break;
    }
  }

  if (sel.empty) {
    const head = Math.max(0, Math.min(tr.mapping.map(sel.head), tr.doc.content.size));
    try {
      tr.setSelection(Selection.near(tr.doc.resolve(head)));
    } catch (err) {
      /* ignore */
    }
  } else {
    let next = null;
    try {
      next = sel.getBookmark().map(tr.mapping).resolve(tr.doc);
    } catch (err) {
      next = null;
    }
    if (!next || next.empty) {
      const head = Math.max(0, Math.min(tr.mapping.map(sel.head), tr.doc.content.size));
      try {
        next = Selection.near(tr.doc.resolve(head));
      } catch (err) {
        next = null;
      }
    }
    if (next) tr.setSelection(next);
  }

  // addStep 会清 storedMarks，所以空选区的 storedMarks 必须最后设。
  if (hasCurrentMarks) tr.setStoredMarks([]);

  const changed = tr.docChanged || tr.storedMarksSet;
  if (changed) {
    // 空 closeHistory：不产生 history 事件、不改文档，只隔离本次清除的 undo 分组。
    view.dispatch(closeHistory(view.state.tr));
    view.dispatch(tr);
    view.dispatch(closeHistory(view.state.tr));
  }
  return changed;
}

export default function MilkdownHost({
  markdown,
  nodeId,
  viewScope,
  onDirty,
  onReady,
  onSelectionChange,
  onNotify,
}) {
  const hostRef = useRef(null);
  // 回调最新值放 ref，避免把回调写进建编辑器的 effect 依赖导致重建。
  const cbsRef = useRef({ onDirty, onReady, onSelectionChange, onNotify });
  cbsRef.current = { onDirty, onReady, onSelectionChange, onNotify };
  const nodeIdRef = useRef(nodeId);
  nodeIdRef.current = nodeId;
  const viewScopeRef = useRef(viewScope);
  viewScopeRef.current = viewScope;
  // 粘贴/拖放插件在 .create() 之前装配，此时 handleImageFiles 还不存在；
  // 用 ref 转接，等 api 就绪后再填真正的处理函数。
  const imageHandlerRef = useRef(null);
  // 初始 markdown 快照：编辑会话期间 data.content 会随防抖回写变化，
  // 但编辑器只在挂载时读一次初值，后续写入不能反过来重建编辑器。
  const initialRef = useRef(markdown);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let disposed = false;
    let editor = null;
    let unregisterNodeEditor = null;

    // 折叠 node-view 通过模块级上下文取渲染归属（全局单实例编辑会话）
    setFoldContext({ nodeId: nodeIdRef.current, viewScope: viewScopeRef.current });

    const mount = document.createElement('div');
    mount.className = 'md-body milkdown-editor';
    host.appendChild(mount);

    const instance = Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, mount);
        ctx.set(defaultValueCtx, initialRef.current != null ? String(initialRef.current) : '');
        // remark-breaks：单换行按硬换行解析（与显示层 remarkGfm + remarkBreaks 一致）。
        ctx.set(remarkPluginsCtx, [{ plugin: remarkBreaks, options: {} }]);
        // 默认 stringify 会把 break 节点写成反斜杠+换行；改回纯换行，
        // 保证「单换行」文本 parse→serialize 往返逐字节一致（§9 保真红线）。
        // bullet/rule 固定为 '-'：与旧 graphs 常见写法一致，避免 '-' → '*' 的无谓改写。
        const stringifyOptions = ctx.get(remarkStringifyOptionsCtx);
        ctx.set(remarkStringifyOptionsCtx, {
          ...stringifyOptions,
          bullet: '-',
          rule: '-',
          handlers: {
            ...stringifyOptions.handlers,
            break: () => '\n',
            // 原文保真（改造方案 §4.2）：完整 `@{name|params}` 标记原样输出，避免默认
            // unsafe 规则把 phrasing 内的 `_` 等转义成 `\_`（扫描器随之失明）；其余文本
            // 仍走 state.safe，与默认处理器逐字节等价。
            text: (node, parent, state, info) => {
              const value = String(node.value == null ? '' : node.value);
              const parts = splitCallMarkers(value);
              if (!parts.some((p) => p.raw)) return state.safe(value, info); // 快速路径：等价默认处理器
              let out = '';
              for (let i = 0; i < parts.length; i += 1) {
                const p = parts[i];
                if (p.raw) {
                  out += p.text;
                  continue;
                }
                const next = parts[i + 1];
                const before = out ? out.charAt(out.length - 1) : info.before;
                const after = next ? next.text.charAt(0) : info.after;
                out += state.safe(p.text, { ...info, before, after });
              }
              return out;
            },
          },
        });
        ctx.get(listenerCtx).markdownUpdated(() => {
          if (disposed) return;
          cbsRef.current.onDirty?.();
        });
      })
      // foldRemark 须先于 commonmark：让 remark 插件在 commonmark 的 remarkHtmlTransformer 之前看到块级 html；
      // fold 的 schema 须在 commonmark 之后：否则 details_fold 抢在 paragraph 前成为默认块，空文档递归填充爆栈。
      .use(foldRemark)
      .use(commonmark)
      .use(gfm)
      .use(fold)
      .use(history)
      .use(listener)
      // 选区浮条：非空选区通知（防抖/抑制/定位在 React 组件侧）
      .use(createSelectionPlugin((info) => cbsRef.current.onSelectionChange?.(info)))
      // 图片：粘贴 / 拖放 → 收集文件 → 交给 handleImageFiles（异步压缩 + 插入节点）
      .use(
        createImagePastePlugin({
          onImages: (files, range) => {
            imageHandlerRef.current?.(files, range);
          },
        })
      );

    instance
      .create()
      .then((ed) => {
        if (disposed) {
          ed.destroy();
          return;
        }
        editor = ed;

        const getMarkdown = () => {
          let md = '';
          try {
            ed.action((ctx) => {
              const serializer = ctx.get(serializerCtx);
              const view = ctx.get(editorViewCtx);
              md = serializer(view.state.doc);
            });
          } catch (err) {
            console.warn('milkdown 序列化失败', err);
          }
          // remark-stringify 恒定在文末补一个换行；旧 graphs 的 content 均为 trim 后文本，
          // 去掉它才能满足「未改动/编辑后 content 不额外长出一个换行」（§9 红线）。
          return md.endsWith('\n') ? md.slice(0, -1) : md;
        };

        // ── 图片 ─────────────────────────────────────────────────────────
        const notify = (msg, kind) => {
          const fn = cbsRef.current.onNotify;
          if (typeof fn === 'function') fn(msg, kind);
          else console.warn(msg);
        };

        // 在给定区间插入真实 image 节点（src 是内联 data URI）；越界一律 clamp。
        const insertImageAt = (src, alt, from, to) => {
          ed.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const imageType = view.state.schema.nodes.image;
            if (!imageType) {
              throw new Error('当前编辑器不支持图片节点（schema.nodes.image 缺失）');
            }
            const node = imageType.create({ src, alt: alt == null ? '' : String(alt) });
            const size = view.state.doc.content.size;
            const start = Math.max(0, Math.min(from ?? view.state.selection.from, size));
            const end = Math.max(start, Math.min(to ?? start, size));
            view.dispatch(view.state.tr.replaceWith(start, end, node).scrollIntoView());
            view.focus();
          });
        };

        // Bridge 插入图片：沿用 PM state 里的选区（侧栏点击会抢走 DOM 焦点，
        // 但 PM selection 仍在 state.selection 上）。
        const insertImage = ({ src, alt } = {}) => {
          insertImageAt(src, alt);
        };

        // 粘贴/拖放多张图：顺序压缩、顺序插入；单张失败不影响其余，错误经 onNotify 上报。
        const handleImageFiles = async (files, range) => {
          const list = Array.isArray(files) ? files : [];
          if (!list.length) return;
          let insertRange = null;
          if (range && Number.isFinite(range.from)) {
            const from = Math.max(0, Math.floor(range.from));
            const to = Number.isFinite(range.to) ? Math.max(from, Math.floor(range.to)) : from;
            insertRange = { from, to };
          }
          let inserted = 0;
          for (const file of list) {
            let dataUrl;
            try {
              ({ dataUrl } = await fileToImageDataUrl(file));
            } catch (err) {
              notify(`图片插入失败：${(err && err.message) || err}`, 'err');
              continue;
            }
            try {
              insertImageAt(dataUrl, altFromFileName(file), insertRange?.from, insertRange?.to);
              inserted += 1;
              // 首次插入后原区间已失效：后续插到当前选区（即刚插入节点的末尾）。
              insertRange = null;
            } catch (err) {
              notify(`图片插入失败：${(err && err.message) || err}`, 'err');
            }
          }
          if (inserted > 0) notify(`已插入 ${inserted} 张图片`, 'ok');
        };

        imageHandlerRef.current = (files, range) => {
          void handleImageFiles(files, range);
        };
        // 让 caretBridge 的节点目标（含 AgentNode 后续用 legacy 方式重建的）都带图片插入能力。
        caretBridge.setImageInserter(insertImage);

        const api = {
          undo: () => {
            try {
              ed.action(callCommand(undoCommand.key));
            } catch (err) {
              console.warn('撤销失败', err);
            }
          },
          redo: () => {
            try {
              ed.action(callCommand(redoCommand.key));
            } catch (err) {
              console.warn('重做失败', err);
            }
          },
          getMarkdown,
          // 源码模式灌回：整篇替换（milkdown replaceAll，保留插件与 fold 上下文）。
          setMarkdown: (md) => {
            try {
              ed.action(replaceAll(String(md == null ? '' : md)));
            } catch (err) {
              console.warn('源码灌回编辑器失败', err);
            }
          },
          // 清除格式：全清 inline marks + heading→paragraph + 包裹块 lift。
          clearFormat: () => {
            let changed = false;
            try {
              ed.action((ctx) => {
                const view = ctx.get(editorViewCtx);
                changed = runClearFormat(view);
                view.focus();
              });
            } catch (err) {
              console.warn('清除格式失败', err);
            }
            return changed;
          },
          focus: () => {
            try {
              ed.action((ctx) => ctx.get(editorViewCtx).focus());
            } catch (err) {
              /* ignore */
            }
          },
          // 全部展开/收起：遍历文档 fold 节点，写共享 Map 并广播（不改文档，故不置脏）。
          foldAll: (expand) => {
            try {
              ed.action((ctx) => {
                const view = ctx.get(editorViewCtx);
                const doc = view.state.doc;
                const owner = viewStateKey(viewScopeRef.current, nodeIdRef.current);
                const keys = [];
                doc.descendants((node, pos) => {
                  if (node.type.name !== 'details_fold') return true;
                  keys.push(computeFoldKey(doc, pos, node, owner));
                  return false; // 不进折叠内部
                });
                setFoldsOpen(viewScopeRef.current, nodeIdRef.current, keys, !!expand);
                notifyFolds();
              });
            } catch (err) {
              console.warn('折叠全部收展失败', err);
            }
          },
          // Bridge 插入：在 ProseMirror 当前（保存的）选区处插入文本。
          // 编辑器失焦不注销，PM selection 仍保留在 state 里。
          insertTextAtSavedSelection: (text) => {
            try {
              ed.action((ctx) => {
                const view = ctx.get(editorViewCtx);
                const { state } = view;
                const value = String(text == null ? '' : text);
                view.dispatch(
                  state.tr.insertText(value, state.selection.from, state.selection.to)
                );
                view.focus();
              });
            } catch (err) {
              console.warn('插入到编辑器失败', err);
            }
          },
          // Bridge 插入图片（FilePanel 图片路径）：src 为内联 data URI。
          insertImage: ({ src, alt }) => insertImage({ src, alt }),
          // 片段应用（四类 + toggle 剥离），全部走 PM transaction。
          applySnippet: (snippet) => {
            let result = null;
            try {
              ed.action((ctx) => {
                const view = ctx.get(editorViewCtx);
                result = applySnippetToView(ctx, view, snippet);
                view.focus();
              });
            } catch (err) {
              console.warn('应用片段失败', err);
            }
            return result;
          },
          // 当前选区纯文本（供「存为片段」预填）。
          getSelectionText: () => {
            let text = '';
            try {
              ed.action((ctx) => {
                const view = ctx.get(editorViewCtx);
                const sel = view.state.selection;
                if (!sel.empty) {
                  text = view.state.doc.textBetween(sel.from, sel.to, '\n', '\n');
                }
              });
            } catch (err) {
              /* ignore */
            }
            return text;
          },
          // 当前选区视口矩形（coordsAtPos 首尾并集），供浮条定位。
          selectionRect: () => {
            let rect = null;
            try {
              ed.action((ctx) => {
                const view = ctx.get(editorViewCtx);
                const sel = view.state.selection;
                if (sel.empty) return;
                const a = view.coordsAtPos(sel.from);
                const b = view.coordsAtPos(sel.to);
                const left = Math.min(a.left, b.left);
                const right = Math.max(a.right, b.right);
                const top = Math.min(a.top, b.top);
                const bottom = Math.max(a.bottom, b.bottom);
                rect = { left, right, top, bottom, width: right - left, height: bottom - top };
              });
            } catch (err) {
              rect = null;
            }
            return rect;
          },
          // 关闭弹层后还原编辑器选区（PM selection 仍在 state，focus 即可）。
          restoreSelection: () => {
            try {
              ed.action((ctx) => ctx.get(editorViewCtx).focus());
            } catch (err) {
              /* ignore */
            }
          },
          getElement: () => mount,
        };

        // 兜底注册：AgentNode 的 onReady 里会用真实节点名再注册一次（覆盖本 target，
        // 并从 _imageInserter 继承 insertImage）；没有 onReady 的调用方也能直接插图。
        unregisterNodeEditor = registerNodeEditor('节点编辑器', {
          insert: (text) => api.insertTextAtSavedSelection(text),
          insertImage,
        });

        cbsRef.current.onReady?.(api);
      })
      .catch((err) => {
        console.error('milkdown 编辑器创建失败', err);
      });

    return () => {
      disposed = true;
      imageHandlerRef.current = null;
      try {
        unregisterNodeEditor?.();
      } catch (err) {
        /* ignore */
      }
      unregisterNodeEditor = null;
      caretBridge.setImageInserter(null);
      try {
        if (editor) editor.destroy();
      } catch (err) {
        console.warn('milkdown 编辑器销毁失败', err);
      }
      editor = null;
      resetFoldContext();
      host.replaceChildren();
    };
  }, []);

  return <div ref={hostRef} className="milkdown-host nodrag nopan" />;
}
