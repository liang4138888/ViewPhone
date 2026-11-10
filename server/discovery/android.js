import { run } from '../utils/command.js';
import { config } from '../config.js';
import { encodeDeviceId } from '../utils/ids.js';

const states = new Set(['device', 'unauthorized', 'offline']);

export async function discoverAndroid() {
  let output;
  try {
    output = (await run(config.adbPath, ['devices', '-l'], { timeoutMs: 5_000 })).stdout;
  } catch (error) {
    return {
      devices: [],
      warning: `ADB 不可用：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const entries = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('List of devices') && !line.startsWith('*'))
    .map((line) => {
      const [nativeId, rawState, ...details] = line.split(/\s+/);
      const metadata = Object.fromEntries(
        details
          .filter((item) => item.includes(':'))
          .map((item) => item.split(/:(.*)/s).slice(0, 2)),
      );
      return { nativeId, state: rawState, metadata };
    })
    .filter(({ nativeId, state }) => nativeId && states.has(state));

  const devices = await Promise.all(
    entries.map(async ({ nativeId, state, metadata }) => {
      const base = {
        nativeId,
        id: encodeDeviceId('android', nativeId),
        platform: 'android',
        name: metadata.model?.replaceAll('_', ' ') || metadata.device || 'Android 设备',
        model: metadata.product || metadata.model,
        state,
        detail:
          state === 'unauthorized'
            ? '请在手机上允许 USB 调试'
            : state === 'offline'
              ? '设备离线，请重新插拔数据线'
              : undefined,
      };
      if (state !== 'device') return base;

      const [version, size] = await Promise.all([
        shell(nativeId, ['getprop', 'ro.build.version.release']).catch(() => ''),
        shell(nativeId, ['wm', 'size']).catch(() => ''),
      ]);
      const dimensions = parseAndroidSize(size);
      return { ...base, osVersion: version.trim() || undefined, ...dimensions };
    }),
  );

  return {
    devices,
    warning: devices.some((device) => device.state === 'unauthorized')
      ? '有 Android 设备尚未授权 USB 调试'
      : undefined,
  };
}

async function shell(deviceId, args) {
  const result = await run(config.adbPath, ['-s', deviceId, 'shell', ...args], {
    timeoutMs: 4_000,
  });
  return result.stdout;
}

export function parseAndroidSize(output) {
  const override = output.match(/Override size:\s*(\d+)x(\d+)/i);
  const physical = output.match(/Physical size:\s*(\d+)x(\d+)/i);
  const match = override || physical;
  return match ? { width: Number(match[1]), height: Number(match[2]) } : {};
}
