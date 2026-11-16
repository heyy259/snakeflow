// 统一画布滚轮：renderer 上唯一的原生 wheel 监听器。
// 普通滚轮 = 平移；Ctrl/Cmd+滚轮 = 精细缩放；Shift+滚轮（非 macOS）= 横向平移。
// 监听器在捕获阶段先 preventDefault/stopImmediatePropagation，确保 d3 不再处理同一次事件。
// 所有坐标/视口/选区状态都在每个事件发生时从 store 读取，组件自身不保存手势状态。
import { useEffect, useMemo } from 'react';
import { useReactFlow, useStoreApi } from '@xyflow/react';
import { panViewportWithWheel, zoomViewportWithWheel } from './viewportWheelMath.js';

function detectMacOS() {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
}

export default function CanvasWheelController({ minZoom, maxZoom }) {
  const storeApi = useStoreApi();
  const { getViewport, setViewport } = useReactFlow();
  // 平台只在挂载时判断一次；后续事件不再做设备推断。
  const isMacOS = useMemo(detectMacOS, []);

  useEffect(() => {
    let renderer = null;

    const handleWheel = (event) => {
      // 先消费事件，再分支：任何路径都不能让 d3/浏览器默认滚动再处理一次。
      event.preventDefault();
      event.stopImmediatePropagation();

      if (storeApi.getState().userSelectionActive) return;
      if (!renderer) return;

      const previous = getViewport();
      const rect = renderer.getBoundingClientRect();
      const wheel = {
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
      };
      const next =
        event.ctrlKey || event.metaKey
          ? zoomViewportWithWheel(
              previous,
              wheel,
              { x: event.clientX - rect.left, y: event.clientY - rect.top },
              { minZoom, maxZoom, isMacOS }
            )
          : panViewportWithWheel(previous, wheel, {
              isMacOS,
              pageDeltaPixels: rect.height,
            });

      if (next !== previous) setViewport(next, { duration: 0 });
    };

    const detach = () => {
      if (!renderer) return;
      renderer.removeEventListener('wheel', handleWheel, true);
      renderer = null;
    };

    const attach = () => {
      const nextRenderer =
        storeApi.getState().domNode?.querySelector('.react-flow__renderer') || null;
      if (nextRenderer === renderer) return;
      detach();
      renderer = nextRenderer;
      if (renderer) renderer.addEventListener('wheel', handleWheel, { capture: true, passive: false });
    };

    // ReactFlow 的 domNode 可能晚于子组件挂载完成；仅在 domNode 变化时重新取样。
    attach();
    const unsubscribe = storeApi.subscribe((state, previousState) => {
      if (state.domNode !== previousState.domNode) attach();
    });

    return () => {
      unsubscribe();
      detach();
    };
  }, [storeApi, getViewport, setViewport, minZoom, maxZoom, isMacOS]);

  return null;
}
