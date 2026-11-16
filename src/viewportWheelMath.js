// Pure wheel-to-viewport math for the React adapter. No DOM, React, or d3.
// Both functions return the original viewport object for a no-op so callers can
// skip a viewport write with `next === previous`; effective changes return a
// new { x, y, zoom } object. Inputs are never mutated.

// Wheel policy lives here, not in React Flow's panOnScroll defaults (that path
// is disabled in App.jsx). Changing these numbers is the only tuning knob.
const LINE_DELTA_PIXELS = 40; // 3 lines ≈ 120px, matching Chrome's ~100px notch
const PAGE_DELTA_PIXELS = 800; // fallback when the renderer height is unavailable
const DEFAULT_PAN_SPEED = 1.15; // screen px per wheel px (native is 1, RF defaults to 0.5)
const PIXEL_ZOOM_COEFFICIENT = 0.001;
const LINE_ZOOM_COEFFICIENT = 0.025;
const OTHER_ZOOM_COEFFICIENT = 0.5;
const MAC_CTRL_PINCH_MULTIPLIER = 10;
const MAX_LOGARITHMIC_DELTA = 0.1;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * Apply a pan-on-scroll wheel event to a fresh viewport.
 * Every deltaMode is normalized to rendered pixels first (lines to 40px, pages
 * to pageDeltaPixels), then both axes are divided by the current zoom before
 * applying panSpeed (default 1.15). XY movement remains free except that
 * non-macOS Shift+wheel maps deltaY to horizontal movement.
 *
 * @param {{x: number, y: number, zoom: number}} viewport
 * @param {{deltaX: number, deltaY: number, deltaMode: number, shiftKey: boolean}} wheel
 * @param {{panSpeed?: number, isMacOS?: boolean, pageDeltaPixels?: number}} options
 * @returns {{x: number, y: number, zoom: number}} original identity on no-op
 */
export function panViewportWithWheel(viewport, wheel, {
  panSpeed = DEFAULT_PAN_SPEED,
  isMacOS = false,
  pageDeltaPixels = PAGE_DELTA_PIXELS,
} = {}) {
  // deltaMode: 0 = pixels, 1 = lines, 2 = pages. Normalizing all three keeps
  // the same physical gesture moving the same screen distance on any device.
  const deltaUnit =
    wheel.deltaMode === 1
      ? LINE_DELTA_PIXELS
      : wheel.deltaMode === 2
        ? (pageDeltaPixels > 0 ? pageDeltaPixels : PAGE_DELTA_PIXELS)
        : 1;
  const normalizedX = wheel.deltaX * deltaUnit;
  const normalizedY = wheel.deltaY * deltaUnit;
  const deltaX = normalizedX / viewport.zoom;
  const deltaY = normalizedY / viewport.zoom;
  const shiftToHorizontal = wheel.shiftKey && !isMacOS;
  const panX = shiftToHorizontal ? -deltaY : -deltaX;
  const panY = shiftToHorizontal ? 0 : -deltaY;
  const x = viewport.x + panX * panSpeed;
  const y = viewport.y + panY * panSpeed;

  if (x === viewport.x && y === viewport.y) return viewport;
  return { x, y, zoom: viewport.zoom };
}

/**
 * Apply fine-grained wheel zoom while keeping the flow point under a
 * renderer-relative pointer fixed. Pixel, line, and other-mode coefficients
 * are half React Flow's installed values. macOS Ctrl pinch retains its x10
 * multiplier; metaKey is accepted in the wheel shape but has no effect.
 * The logarithmic delta is capped to [-0.1, 0.1] before zoom is clamped.
 *
 * @param {{x: number, y: number, zoom: number}} viewport
 * @param {{deltaY: number, deltaMode: number, ctrlKey: boolean, metaKey: boolean}} wheel
 * @param {{x: number, y: number}} point renderer-relative pointer coordinates
 * @param {{minZoom: number, maxZoom: number, isMacOS?: boolean}} options
 * @returns {{x: number, y: number, zoom: number}} original identity on no-op
 */
export function zoomViewportWithWheel(viewport, wheel, point, { minZoom, maxZoom, isMacOS = false }) {
  const coefficient = wheel.deltaMode === 1
    ? LINE_ZOOM_COEFFICIENT
    : wheel.deltaMode === 0
      ? PIXEL_ZOOM_COEFFICIENT
      : OTHER_ZOOM_COEFFICIENT;
  const pinchMultiplier = isMacOS && wheel.ctrlKey ? MAC_CTRL_PINCH_MULTIPLIER : 1;
  const logarithmicDelta = clamp(
    -wheel.deltaY * coefficient * pinchMultiplier,
    -MAX_LOGARITHMIC_DELTA,
    MAX_LOGARITHMIC_DELTA
  );

  if (logarithmicDelta === 0) return viewport;

  const zoom = clamp(
    viewport.zoom * 2 ** logarithmicDelta,
    minZoom,
    maxZoom
  );
  if (zoom === viewport.zoom) return viewport;

  const scale = zoom / viewport.zoom;
  return {
    x: point.x - (point.x - viewport.x) * scale,
    y: point.y - (point.y - viewport.y) * scale,
    zoom,
  };
}
