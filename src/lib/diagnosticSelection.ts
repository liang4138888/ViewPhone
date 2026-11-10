import type { DeviceInfo, Platform } from '../../shared/types';

/** Resolve a platform card click to one authorized device without selecting disconnected phones. */
export function selectDiagnosticDevice(
  devices: DeviceInfo[],
  platform: Platform,
  currentDeviceId?: string,
) {
  const available = devices.filter((device) => (
    device.platform === platform && device.state === 'device'
  ));
  if (available.length === 0) return undefined;
  return (available.find((device) => device.id === currentDeviceId) || available[0]).id;
}
