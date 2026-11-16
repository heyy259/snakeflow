// Pure Node unit smoke test for React Flow-compatible wheel viewport math.
// Covers pan normalization/direction, fine zoom coefficients/caps/clamps,
// pointer anchoring, no-op identity, and input immutability. No DOM or React.
// Run: node scripts/smoke-viewport-wheel-math-unit.mjs (exit 0 when all pass).

import { panViewportWithWheel, zoomViewportWithWheel } from '../src/viewportWheelMath.js';

const results = [];
const TOLERANCE = 1e-12;
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 180) : ''}`);
};
const near = (actual, expected, tolerance = TOLERANCE) =>
  Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
const viewportDetail = (viewport) => JSON.stringify(viewport);
const flowPointAt = (viewport, point) => ({
  x: (point.x - viewport.x) / viewport.zoom,
  y: (point.y - viewport.y) / viewport.zoom,
});

try {
  // ── 1. Pan: zoom normalization, direction, free XY, and speed ─────────
  const panBase = { x: 100, y: -40, zoom: 1.5 };
  const panOptions = { isMacOS: false };
  const vertical = panViewportWithWheel(
    panBase,
    { deltaX: 0, deltaY: 24, deltaMode: 0, shiftKey: false }
  );
  check(
    '1 pan vertical: default speed 1.15 divides delta by zoom and preserves zoom',
    vertical !== panBase &&
      near(vertical.x, 100) &&
      near(vertical.y, -58.4) &&
      vertical.zoom === 1.5,
    viewportDetail(vertical)
  );

  const horizontal = panViewportWithWheel(
    panBase,
    { deltaX: 18, deltaY: 0, deltaMode: 0, shiftKey: false },
    panOptions
  );
  check(
    '2 pan horizontal: normalized deltaX moves X only',
    near(horizontal.x, 86.2) && near(horizontal.y, -40) && horizontal.zoom === 1.5,
    viewportDetail(horizontal)
  );

  const xy = panViewportWithWheel(
    panBase,
    { deltaX: 18, deltaY: 24, deltaMode: 0, shiftKey: false },
    panOptions
  );
  check(
    '3 pan free XY: both zoom-normalized wheel axes apply simultaneously',
    near(xy.x, 86.2) && near(xy.y, -58.4) && xy.zoom === 1.5,
    viewportDetail(xy)
  );

  const shifted = panViewportWithWheel(
    panBase,
    { deltaX: 7, deltaY: 24, deltaMode: 0, shiftKey: true },
    panOptions
  );
  check(
    '4 non-Mac Shift+wheel: normalized vertical wheel becomes horizontal and ignores deltaX',
    near(shifted.x, 81.6) && near(shifted.y, -40) && shifted.zoom === 1.5,
    viewportDetail(shifted)
  );

  const shiftedMac = panViewportWithWheel(
    panBase,
    { deltaX: 7, deltaY: 24, deltaMode: 0, shiftKey: true },
    { panSpeed: 0.5, isMacOS: true }
  );
  check(
    '5 Mac Shift+wheel: retains free XY instead of axis remapping',
    near(shiftedMac.x, 97.66666666666667) && near(shiftedMac.y, -48) && shiftedMac.zoom === 1.5,
    viewportDetail(shiftedMac)
  );

  const lines = panViewportWithWheel(
    panBase,
    { deltaX: 2, deltaY: -3, deltaMode: 1, shiftKey: false },
    panOptions
  );
  check(
    '6 pan line mode: normalize lines to 40 pixels, then divide by zoom before speed',
    near(lines.x, 38.66666666666667) && near(lines.y, 52) && lines.zoom === 1.5,
    viewportDetail(lines)
  );

  const lowZoomViewport = { x: 20, y: -10, zoom: 0.75 };
  const highZoomViewport = { x: 20, y: -10, zoom: 2 };
  const invariantWheel = { deltaX: 12, deltaY: -18, deltaMode: 0, shiftKey: false };
  const lowZoomPan = panViewportWithWheel(lowZoomViewport, invariantWheel);
  const highZoomPan = panViewportWithWheel(highZoomViewport, invariantWheel);
  const lowScreenDelta = {
    x: (lowZoomPan.x - lowZoomViewport.x) * lowZoomViewport.zoom,
    y: (lowZoomPan.y - lowZoomViewport.y) * lowZoomViewport.zoom,
  };
  const highScreenDelta = {
    x: (highZoomPan.x - highZoomViewport.x) * highZoomViewport.zoom,
    y: (highZoomPan.y - highZoomViewport.y) * highZoomViewport.zoom,
  };
  check(
    '6b pan zoom invariance: translation × zoom is identical at different zoom levels',
    near(lowScreenDelta.x, -13.8) &&
      near(lowScreenDelta.y, 20.7) &&
      near(highScreenDelta.x, lowScreenDelta.x) &&
      near(highScreenDelta.y, lowScreenDelta.y),
    `low=${JSON.stringify(lowScreenDelta)} high=${JSON.stringify(highScreenDelta)}`
  );

  const pageViewport = { x: 10, y: 20, zoom: 2 };
  const pagePan = panViewportWithWheel(
    pageViewport,
    { deltaX: 0, deltaY: 1, deltaMode: 2, shiftKey: false },
    { pageDeltaPixels: 600 }
  );
  check(
    '6c page mode: one page maps to pageDeltaPixels, divided by zoom, then speed',
    near(pagePan.x, 10) && near(pagePan.y, -325) && pagePan.zoom === 2,
    viewportDetail(pagePan)
  );

  const pageFallback = panViewportWithWheel(
    { x: 0, y: 0, zoom: 1 },
    { deltaX: 0, deltaY: 1, deltaMode: 2, shiftKey: false },
    { pageDeltaPixels: 0 }
  );
  check(
    '6d page mode: non-positive pageDeltaPixels falls back to 800px',
    near(pageFallback.x, 0) && near(pageFallback.y, -920) && pageFallback.zoom === 1,
    viewportDetail(pageFallback)
  );

  // ── 2. Zoom: halved coefficients and logarithmic exponent caps ─────────
  const zoomBase = { x: 80, y: -30, zoom: 1 };
  const pointer = { x: 300, y: 200 };
  const zoomOptions = { minZoom: 0.5, maxZoom: 4, isMacOS: false };
  const zoomIn = zoomViewportWithWheel(
    zoomBase,
    { deltaY: -100, deltaMode: 0, ctrlKey: false, metaKey: false },
    pointer,
    zoomOptions
  );
  const expectedIn = 2 ** 0.1;
  check(
    '7 pixel zoom: deltaY -100 produces z1 = z0 * 2^0.1 with pointer anchor',
    near(zoomIn.zoom, expectedIn) &&
      near(zoomIn.x, 300 - 220 * expectedIn) &&
      near(zoomIn.y, 200 - 230 * expectedIn),
    viewportDetail(zoomIn)
  );

  const zoomOut = zoomViewportWithWheel(
    zoomBase,
    { deltaY: 100, deltaMode: 0, ctrlKey: false, metaKey: false },
    pointer,
    zoomOptions
  );
  const expectedOut = 2 ** -0.1;
  check(
    '8 reverse zoom: positive deltaY produces z1 = z0 * 2^-0.1',
    near(zoomOut.zoom, expectedOut) &&
      near(zoomOut.x, 300 - 220 * expectedOut) &&
      near(zoomOut.y, 200 - 230 * expectedOut),
    viewportDetail(zoomOut)
  );

  const cappedIn = zoomViewportWithWheel(
    zoomBase,
    { deltaY: -1000, deltaMode: 0, ctrlKey: false, metaKey: false },
    pointer,
    zoomOptions
  );
  const cappedOut = zoomViewportWithWheel(
    zoomBase,
    { deltaY: 1000, deltaMode: 0, ctrlKey: false, metaKey: false },
    pointer,
    zoomOptions
  );
  check(
    '9 exponent caps: large deltas clamp to +0.1 and -0.1 respectively',
    near(cappedIn.zoom, expectedIn) && near(cappedOut.zoom, expectedOut),
    `${viewportDetail(cappedIn)} ${viewportDetail(cappedOut)}`
  );

  const lineZoom = zoomViewportWithWheel(
    zoomBase,
    { deltaY: -4, deltaMode: 1, ctrlKey: false, metaKey: false },
    pointer,
    zoomOptions
  );
  const pageZoom = zoomViewportWithWheel(
    zoomBase,
    { deltaY: -0.2, deltaMode: 2, ctrlKey: false, metaKey: false },
    pointer,
    zoomOptions
  );
  check(
    '10 zoom modes: line coefficient 0.025 and other-mode coefficient 0.5',
    near(lineZoom.zoom, expectedIn) && near(pageZoom.zoom, expectedIn),
    `${viewportDetail(lineZoom)} ${viewportDetail(pageZoom)}`
  );

  const tinyZoom = zoomViewportWithWheel(
    zoomBase,
    { deltaY: -0.001, deltaMode: 0, ctrlKey: false, metaKey: false },
    pointer,
    zoomOptions
  );
  check(
    '11 small-delta continuity: no dead zone or premature cap/rounding',
    near(tinyZoom.zoom, 2 ** 0.000001) &&
      tinyZoom.zoom > zoomBase.zoom &&
      tinyZoom.zoom - zoomBase.zoom < 0.00001,
    viewportDetail(tinyZoom)
  );

  const macPinch = zoomViewportWithWheel(
    zoomBase,
    { deltaY: -1, deltaMode: 0, ctrlKey: true, metaKey: false },
    pointer,
    { minZoom: 0.5, maxZoom: 4, isMacOS: true }
  );
  const macMetaOnly = zoomViewportWithWheel(
    zoomBase,
    { deltaY: -1, deltaMode: 0, ctrlKey: false, metaKey: true },
    pointer,
    { minZoom: 0.5, maxZoom: 4, isMacOS: true }
  );
  check(
    '12 macOS Ctrl pinch: applies x10 coefficient; metaKey alone does not',
    near(macPinch.zoom, 2 ** 0.01) && near(macMetaOnly.zoom, 2 ** 0.001),
    `${viewportDetail(macPinch)} ${viewportDetail(macMetaOnly)}`
  );

  // ── 3. Zoom limits preserve the exact flow point under the cursor ──────
  const nearMax = { x: 40, y: -70, zoom: 3.9 };
  const atMax = zoomViewportWithWheel(
    nearMax,
    { deltaY: -1000, deltaMode: 0, ctrlKey: false, metaKey: false },
    pointer,
    { minZoom: 0.5, maxZoom: 4, isMacOS: false }
  );
  const beforeMax = flowPointAt(nearMax, pointer);
  const afterMax = flowPointAt(atMax, pointer);
  check(
    '13 maxZoom clamp: zoom stops at max and clamped anchor remains exact',
    atMax.zoom === 4 && near(afterMax.x, beforeMax.x) && near(afterMax.y, beforeMax.y),
    `${viewportDetail(atMax)} flow=${JSON.stringify(afterMax)}`
  );

  const nearMin = { x: -12, y: 55, zoom: 0.51 };
  const atMin = zoomViewportWithWheel(
    nearMin,
    { deltaY: 1000, deltaMode: 0, ctrlKey: false, metaKey: false },
    pointer,
    { minZoom: 0.5, maxZoom: 4, isMacOS: false }
  );
  const beforeMin = flowPointAt(nearMin, pointer);
  const afterMin = flowPointAt(atMin, pointer);
  check(
    '14 minZoom clamp: zoom stops at min and clamped anchor remains exact',
    atMin.zoom === 0.5 && near(afterMin.x, beforeMin.x) && near(afterMin.y, beforeMin.y),
    `${viewportDetail(atMin)} flow=${JSON.stringify(afterMin)}`
  );

  // ── 4. No-op identity lets the React adapter skip viewport writes ──────
  const zeroPan = panViewportWithWheel(
    panBase,
    { deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false },
    panOptions
  );
  const zeroZoom = zoomViewportWithWheel(
    zoomBase,
    { deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false },
    pointer,
    zoomOptions
  );
  check('15 zero wheel deltas: return original viewport identity', zeroPan === panBase && zeroZoom === zoomBase);

  const maxBoundary = { x: 40, y: -70, zoom: 4 };
  const minBoundary = { x: -12, y: 55, zoom: 0.5 };
  const noMaxWrite = zoomViewportWithWheel(
    maxBoundary,
    { deltaY: -1000, deltaMode: 0, ctrlKey: false, metaKey: false },
    pointer,
    zoomOptions
  );
  const noMinWrite = zoomViewportWithWheel(
    minBoundary,
    { deltaY: 1000, deltaMode: 0, ctrlKey: false, metaKey: false },
    pointer,
    zoomOptions
  );
  check(
    '16 clamp boundaries: outward zoom returns original viewport identity',
    noMaxWrite === maxBoundary && noMinWrite === minBoundary
  );

  // ── 5. Inputs stay untouched; changed results own fresh viewport objects ─
  const immutableViewport = { x: 12, y: -8, zoom: 1.25 };
  const immutableWheel = { deltaX: 4, deltaY: -6, deltaMode: 0, shiftKey: false };
  const immutableOptions = { panSpeed: 0.75, isMacOS: false };
  const panSnapshot = JSON.stringify([immutableViewport, immutableWheel, immutableOptions]);
  const changedPan = panViewportWithWheel(immutableViewport, immutableWheel, immutableOptions);
  check(
    '17 pan non-mutation: input snapshots unchanged and effective change returns new viewport',
    JSON.stringify([immutableViewport, immutableWheel, immutableOptions]) === panSnapshot &&
      changedPan !== immutableViewport &&
      changedPan.zoom === immutableViewport.zoom,
    viewportDetail(changedPan)
  );

  const zoomWheel = { deltaY: -20, deltaMode: 0, ctrlKey: false, metaKey: false };
  const immutablePoint = { x: 90, y: 120 };
  const immutableZoomOptions = { minZoom: 0.5, maxZoom: 4, isMacOS: false };
  const zoomSnapshot = JSON.stringify([
    immutableViewport,
    zoomWheel,
    immutablePoint,
    immutableZoomOptions,
  ]);
  const changedZoom = zoomViewportWithWheel(
    immutableViewport,
    zoomWheel,
    immutablePoint,
    immutableZoomOptions
  );
  check(
    '18 zoom non-mutation: viewport/wheel/point/options unchanged and output is finite',
    JSON.stringify([immutableViewport, zoomWheel, immutablePoint, immutableZoomOptions]) === zoomSnapshot &&
      changedZoom !== immutableViewport &&
      Number.isFinite(changedZoom.x) &&
      Number.isFinite(changedZoom.y) &&
      Number.isFinite(changedZoom.zoom),
    viewportDetail(changedZoom)
  );
} catch (err) {
  check('unit execution', false, err.stack || String(err));
}

const failed = results.filter((result) => !result.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
