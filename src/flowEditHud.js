// 屏幕空间编辑条宿主：App 在 `.flow` 内挂一个常驻 DOM，AgentNode 把编辑工具栏
// portal 进去。Context 只传一个稳定的 ref，不提升任何编辑状态，避免 AgentNode
// 的 dirty/sourceOpen/foldMenuOpen/addAnchor/editorApiRef 被搬到 App。
import { createContext } from 'react';

export const FlowEditHudContext = createContext(null);
