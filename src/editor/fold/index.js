// 折叠块编辑插件集（阶段 6）。
// 装配顺序（MilkdownHost）：`.use(foldRemark).use(commonmark).use(gfm).use(fold)...`
// - foldRemark 须先于 commonmark：让我们的 remark 转换先于 commonmark 的
//   remarkHtmlTransformer 看到块级 html。
// - details_fold 的 schema 必须在 commonmark 之后注册：否则它排在 paragraph 前面，
//   空文档 createAndFill 会把它当默认块递归填充（Maximum call stack size exceeded）。

import { detailsFoldSchema } from './node.js';
import { detailsFoldView } from './view.js';
import { remarkFold } from './remarkFold.js';
import { foldInputRule, foldReconcile, foldKeymap } from './reconcile.js';

// remark 转换：必须先于 commonmark 装配。
export const foldRemark = [remarkFold];

// schema / node-view / input rule / keymap：必须在 commonmark 之后装配。
export const fold = [
  detailsFoldSchema,
  detailsFoldView,
  foldInputRule,
  foldReconcile,
  foldKeymap,
];

export { detailsFoldSchema } from './node.js';
export { detailsFoldView } from './view.js';
export { remarkFold } from './remarkFold.js';
export { foldInputRule, foldReconcile, foldKeymap } from './reconcile.js';
export { setFoldContext, getFoldContext, resetFoldContext } from './context.js';
export { computeFoldKey, foldTitle } from './patterns.js';
