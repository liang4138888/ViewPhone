import type { DeviceInfo, Diagnostics, Platform } from '../../shared/types';

export type DeviceSlot = {
  key: string;
  platform: Platform;
  device?: DeviceInfo;
  detail?: string;
};

const platformOrder: Platform[] = ['android', 'ios', 'harmony'];

const emptyDetail: Record<Platform, string> = {
  android: '未检测到 Android 设备，请连接 USB 并允许调试。',
  ios: '未检测到 iOS 设备，请启动 WebDriverAgent 后重新扫描。',
  harmony: '未检测到 HarmonyOS 设备，请连接 USB 并允许 HDC 调试。',
};

/** Build one stable panel per device and a status panel for any missing platform. */
export function buildDeviceSlots(
  devices: DeviceInfo[],
  diagnostics: Diagnostics[] = [],
): DeviceSlot[] {
  const slots: DeviceSlot[] = devices.map((device) => ({
    key: device.id,
    platform: device.platform,
    device,
    detail:
      device.detail ||
      diagnostics.find((entry) => entry.platform === device.platform)?.warnings[0],
  }));

  for (const platform of platformOrder) {
    if (slots.some((slot) => slot.platform === platform)) continue;
    const detail =
      diagnostics.find((entry) => entry.platform === platform)?.warnings[0] || emptyDetail[platform];
    slots.push({ key: `platform-${platform}`, platform, detail });
  }

  return slots.sort(
    (left, right) =>
      platformOrder.indexOf(left.platform) - platformOrder.indexOf(right.platform) ||
      left.key.localeCompare(right.key),
  );
}

/** Only devices that are currently connected and authorized. */
export function buildConnectedDeviceSlots(devices: DeviceInfo[]): DeviceSlot[] {
  return devices
    .filter((device) => device.state === 'device')
    .map((device) => ({
      key: device.id,
      platform: device.platform,
      device,
      detail: device.detail,
    }))
    .sort((left, right) => (
      platformOrder.indexOf(left.platform) - platformOrder.indexOf(right.platform) ||
      left.key.localeCompare(right.key)
    ));
}
