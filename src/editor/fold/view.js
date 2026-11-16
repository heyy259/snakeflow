// `details_fold` 的 React node-view 装配（浏览器专用，单独成文件以便 schema 纯函数被 Node 测试导入）。

import { $view } from '@milkdown/kit/utils';
import { createFoldNodeView } from './FoldNodeView.jsx';
import { getFoldContext } from './context.js';
import { detailsFoldSchema } from './node.js';

export const detailsFoldView = $view(
  detailsFoldSchema.node,
  () => createFoldNodeView(getFoldContext())
);
