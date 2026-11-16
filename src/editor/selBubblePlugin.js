// 选区浮条的 ProseMirror plugin（非空选区变化 → 通知 React）。
// 单独成文件：本文件依赖 milkdown/prosemirror，只允许被懒加载的 MilkdownHost 引用，
// 以免把编辑器依赖打进主包（SelBubble.jsx 主包组件不含本文件）。

import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';

export const selBubbleKey = new PluginKey('snippet-sel-bubble');

/** 清除格式可用性：有选区恒可；空选区时看光标 mark / 所在块是否为可降级块。 */
function isClearable(state) {
  const sel = state.selection;
  if (!sel || !sel.empty) return true;
  const $from = sel.$from;
  const marks = state.storedMarks || $from.marks();
  if (marks && marks.length) return true;
  for (let d = $from.depth; d > 0; d -= 1) {
    const name = $from.node(d).type.name;
    if (name === 'heading' || name === 'blockquote' || name === 'list_item') return true;
  }
  return false;
}

function sameStoredMarks(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!a[i].eq(b[i])) return false;
  }
  return true;
}

function readSelection(view) {
  try {
    const sel = view.state.selection;
    const focused = view.hasFocus();
    if (!sel || sel.empty || !focused) {
      return { empty: true, clearable: focused ? isClearable(view.state) : undefined };
    }
    return { empty: false, from: sel.from, to: sel.to, clearable: true };
  } catch (err) {
    return { empty: true };
  }
}

/** 选区变化 plugin：把「是否非空」通知给 React（防抖/定位/抑制在组件侧）。 */
export function createSelectionPlugin(onChange) {
  return $prose(
    () =>
      new Plugin({
        key: selBubbleKey,
        props: {
          handleDOMEvents: {
            blur: () => {
              onChange({ empty: true });
              return false;
            },
            focus: (view) => {
              onChange(readSelection(view));
              return false;
            },
          },
        },
        view() {
          return {
            update(view, prev) {
              if (
                view.state.selection.eq(prev.selection) &&
                view.state.doc.eq(prev.doc) &&
                sameStoredMarks(view.state.storedMarks, prev.storedMarks)
              ) {
                return;
              }
              onChange(readSelection(view));
            },
          };
        },
      })
  );
}
