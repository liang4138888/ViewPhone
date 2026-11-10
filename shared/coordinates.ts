export type ViewportRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type DeviceSize = { width: number; height: number };

export type ScrollDirection = 'up' | 'down';

/**
 * ADB and WDA drags can be interpreted as a tap when released immediately.
 * Keep a small gesture window even when the pointer moved quickly in the browser.
 */
export function swipeDuration(elapsedMs: number): number {
  return Math.max(450, Math.min(1_200, Math.round(elapsedMs)));
}

/** Build a page-scrolling drag inside the touch-input coordinate space. */
export function createScrollSwipe(direction: ScrollDirection, input: DeviceSize) {
  if (input.width <= 1 || input.height <= 1) {
    throw new RangeError('触控尺寸必须大于 1');
  }
  const pageDown = direction === 'down';
  return {
    type: 'swipe' as const,
    fromX: Math.round(input.width / 2),
    fromY: Math.round(input.height * (pageDown ? 0.78 : 0.22)),
    toX: Math.round(input.width / 2),
    toY: Math.round(input.height * (pageDown ? 0.22 : 0.78)),
    duration: 500,
  };
}

/** Convert a browser pointer to a coordinate in the screenshot image. */
export function browserPointToDevice(
  clientX: number,
  clientY: number,
  rect: ViewportRect,
  device: DeviceSize,
): { x: number; y: number } {
  if (rect.width <= 0 || rect.height <= 0 || device.width <= 0 || device.height <= 0) {
    throw new RangeError('画面和设备尺寸必须大于 0');
  }
  return {
    x: clamp(Math.round(((clientX - rect.left) / rect.width) * device.width), 0, device.width - 1),
    y: clamp(Math.round(((clientY - rect.top) / rect.height) * device.height), 0, device.height - 1),
  };
}

/** Map a screenshot coordinate into the touch-input coordinate space. */
export function mapInputCoordinate(
  point: { x: number; y: number },
  screenshot: DeviceSize,
  input: DeviceSize,
): { x: number; y: number } {
  if (
    screenshot.width <= 0 ||
    screenshot.height <= 0 ||
    input.width <= 0 ||
    input.height <= 0
  ) {
    throw new RangeError('画面和触控尺寸必须大于 0');
  }
  return {
    x: clamp(Math.round((point.x / screenshot.width) * input.width), 0, input.width - 1),
    y: clamp(Math.round((point.y / screenshot.height) * input.height), 0, input.height - 1),
  };
}

export function isPointInside(
  clientX: number,
  clientY: number,
  rect: ViewportRect,
): boolean {
  return (
    clientX >= rect.left &&
    clientX <= rect.left + rect.width &&
    clientY >= rect.top &&
    clientY <= rect.top + rect.height
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
