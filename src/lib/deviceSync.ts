import type { ActionRequest, DeviceInfo } from '../../shared/types';
import type { DeviceSize } from '../../shared/coordinates';

export type SyncMapping = 'relative' | 'pixel';

export function getDeviceInputSize(device: DeviceInfo): DeviceSize | undefined {
  const width = device.inputWidth ?? device.width;
  const height = device.inputHeight ?? device.height;
  return width && height ? { width, height } : undefined;
}

/** The source controls every other online device; disconnected phones are excluded. */
export function getSyncTargets(devices: DeviceInfo[], sourceId: string): DeviceInfo[] {
  return devices.filter((device) => device.state === 'device' && device.id !== sourceId);
}

/**
 * Preserve the position's screen percentage when devices have different resolutions.
 * Actions without coordinates, such as home and text, are sent unchanged.
 */
export function mapActionToDevice(
  action: ActionRequest,
  source: DeviceSize,
  target: DeviceSize,
  mapping: SyncMapping = 'relative',
): ActionRequest {
  assertSize(source);
  assertSize(target);
  const point = (x: number, y: number) => ({
    x:
      mapping === 'relative'
        ? Math.min(target.width - 1, Math.round((x / source.width) * target.width))
        : Math.min(target.width - 1, Math.round(x)),
    y:
      mapping === 'relative'
        ? Math.min(target.height - 1, Math.round((y / source.height) * target.height))
        : Math.min(target.height - 1, Math.round(y)),
  });

  if (action.type === 'tap') return { ...action, ...point(action.x, action.y) };
  if (action.type === 'longPress') return { ...action, ...point(action.x, action.y) };
  if (action.type === 'swipe') {
    const from = point(action.fromX, action.fromY);
    const to = point(action.toX, action.toY);
    return {
      ...action,
      fromX: from.x,
      fromY: from.y,
      toX: to.x,
      toY: to.y,
    };
  }
  if (action.type === 'text') {
    if (!Number.isFinite(action.x) || !Number.isFinite(action.y)) return { ...action };
    return { ...action, ...point(action.x!, action.y!) };
  }
  return { ...action };
}

function assertSize(size: DeviceSize) {
  if (size.width <= 1 || size.height <= 1) {
    throw new RangeError('同步画面尺寸必须大于 1');
  }
}
