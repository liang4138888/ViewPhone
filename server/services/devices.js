import { discoverAndroid } from '../discovery/android.js';
import { discoverHarmony } from '../discovery/harmony.js';
import { discoverIos, IosAdapter } from '../adapters/ios.js';
import { AndroidAdapter } from '../adapters/android.js';
import { HarmonyAdapter } from '../adapters/harmony.js';
import { config } from '../config.js';
import { diagnosticTools } from './tools.js';
import { decodeDeviceId } from '../utils/ids.js';

let discoveryCache;
let discoveryInFlight;
const adapters = new Map();

export async function listAllDevices({ refresh = false } = {}) {
  if (!refresh && discoveryCache && Date.now() - discoveryCache.time < 1_500) {
    return discoveryCache.value;
  }
  if (!refresh && discoveryInFlight) return discoveryInFlight;
  discoveryInFlight = discoverAll()
    .then((value) => {
      discoveryCache = { time: Date.now(), value };
      return value;
    })
    .finally(() => {
      discoveryInFlight = undefined;
    });
  return discoveryInFlight;
}

async function discoverAll() {
  const [android, harmony, ios, tools] = await Promise.all([
    discoverAndroid(),
    discoverHarmony(),
    discoverIos(),
    diagnosticTools(),
  ]);

  const devices = [...android.devices, ...ios.devices, ...harmony.devices].map((device) => ({
    ...device,
    adb: config.adbPath,
    hdc: config.hdcPath,
  }));
  const diagnostics = [
    {
      platform: 'android',
      tools: { adb: tools.adb, ffmpeg: tools.ffmpeg },
      deviceCount: android.devices.length,
      warnings: android.warning ? [android.warning] : [],
    },
    {
      platform: 'ios',
      tools: { wda: tools.wda },
      deviceCount: ios.devices.length,
      warnings: ios.warning ? [ios.warning] : [],
    },
    {
      platform: 'harmony',
      tools: { hdc: tools.hdc },
      deviceCount: harmony.devices.length,
      warnings: harmony.warning ? [harmony.warning] : [],
    },
  ];
  return { devices, diagnostics, refreshedAt: new Date().toISOString() };
}

export async function findDevice(id) {
  const decoded = decodeDeviceId(id);
  if (!decoded) return undefined;
  const all = await listAllDevices();
  const device = all.devices.find((item) => item.id === id);
  if (!device || device.state !== 'device') return undefined;
  if (decoded.platform !== device.platform) return undefined;
  return { device, decoded };
}

export function clearDiscoveryCache() {
  discoveryCache = undefined;
}

export function createAdapter(device) {
  const cached = adapters.get(device.id);
  if (cached) return cached;
  let adapter;
  if (device.platform === 'android') adapter = new AndroidAdapter(device);
  else if (device.platform === 'harmony') adapter = new HarmonyAdapter(device);
  else if (device.platform === 'ios') adapter = new IosAdapter(device);
  if (adapter) {
    adapters.set(device.id, adapter);
    return adapter;
  }
  throw new Error(`不支持的设备平台：${device.platform}`);
}
