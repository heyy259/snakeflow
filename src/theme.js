import { useEffect, useState } from 'react';

/**
 * 主题皮肤定义。
 * - id：写入 document.documentElement.dataset.theme 的值，对应 index.css 的 [data-theme="<id>"] 覆盖块。
 * - name：工具栏色点的 title（中文）。
 * - accent：色点填充色，必须与 index.css 中该皮肤的 --tf-accent 完全一致。
 * - dark：是否为深色皮肤。
 * - colorMode：传给 <ReactFlow colorMode> 的值。
 */
export const THEMES = [
  { id: 'ocean', name: '深海蓝', accent: '#38bdf8', dark: true, colorMode: 'dark' },
  { id: 'violet', name: '暗紫罗兰', accent: '#ff0072', dark: true, colorMode: 'dark' },
  { id: 'forest', name: '森林墨绿', accent: '#34d399', dark: true, colorMode: 'dark' },
  { id: 'beige', name: '护眼米色', accent: '#b45309', dark: false, colorMode: 'light' },
];

export const DEFAULT_THEME = 'violet';
export const STORAGE_KEY = 'agentgraph-theme';

const THEME_IDS = THEMES.map((t) => t.id);

/**
 * 读取初始皮肤：localStorage 中的值必须是已知 id，否则回退默认。
 * 对无 localStorage / SSR 环境安全。
 */
export function getInitialTheme() {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved && THEME_IDS.includes(saved)) return saved;
  } catch (err) {
    /* localStorage 不可用时回退默认皮肤 */
  }
  return DEFAULT_THEME;
}

/**
 * 应用皮肤：把 id 写到 <html data-theme>，返回匹配到的主题对象。
 * 非法 id 回退默认皮肤。
 */
export function applyTheme(id) {
  const theme = THEMES.find((t) => t.id === id) || THEMES.find((t) => t.id === DEFAULT_THEME);
  try {
    document.documentElement.dataset.theme = theme.id;
  } catch (err) {
    /* document 不可用时忽略 */
  }
  return theme;
}

/**
 * 主题 hook：返回 [themeId, setThemeId]。
 * - 首次渲染读取初始皮肤；
 * - 挂载时应用初始皮肤；
 * - 切换时更新 state、应用皮肤并持久化到 localStorage。
 */
export function useTheme() {
  const [themeId, setThemeIdState] = useState(getInitialTheme);

  useEffect(() => {
    applyTheme(themeId);
  }, [themeId]);

  const setThemeId = (id) => {
    const theme = THEMES.find((t) => t.id === id);
    if (!theme) return;
    setThemeIdState(theme.id);
    applyTheme(theme.id);
    try {
      window.localStorage.setItem(STORAGE_KEY, theme.id);
    } catch (err) {
      /* localStorage 不可用时忽略持久化 */
    }
  };

  return [themeId, setThemeId];
}
