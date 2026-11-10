import { run } from '../utils/command.js';
import { config } from '../config.js';
import { encodeDeviceId } from '../utils/ids.js';
import { assertHarmonyCommand } from '../adapters/harmony.js';

export async function discoverHarmony() {
  let output;
  try {
    output = (await run(config.hdcPath, ['list', 'targets'], { timeoutMs: 5_000 })).stdout;
  } catch (error) {
    return {
      devices: [],
      warning: `HDC 不可用：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const ids = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('[') && !line.startsWith('W'))
    .map((line) => line.split(/\s+/)[0])
    .filter(Boolean);

  const devices = await Promise.all(
    [...new Set(ids)].map(async (nativeId) => {
      const [modelResult, versionResult, sizeResult] = await Promise.allSettled([
        shell(nativeId, 'param get const.product.model'),
        shell(nativeId, 'param get const.product.software.version'),
        shell(nativeId, 'hidumper -s RenderService -a screen'),
      ]);
      const model = settledOutput(modelResult).replace(/^OHOS_/, '').replaceAll('_', ' ');
      const version = settledOutput(versionResult);
      const sizeOutput = settledOutput(sizeResult);
      const failure = [modelResult, versionResult, sizeResult].find(
        (result) => result.status === 'rejected',
      );
      const detail =
        failure?.status === 'rejected' ? errorMessage(failure.reason) : undefined;
      return {
        nativeId,
        id: encodeDeviceId('harmony', nativeId),
        platform: 'harmony',
        name: model || 'HarmonyOS 设备',
        model: model || undefined,
        osVersion: version || undefined,
        state: detail ? 'offline' : 'device',
        detail,
        ...parseHarmonySize(sizeOutput),
      };
    }),
  );

  const failed = devices.find((device) => device.state !== 'device');
  return { devices, warning: failed?.detail ? `HarmonyOS 连接异常：${failed.detail}` : undefined };
}

async function shell(deviceId, command) {
  const result = await run(config.hdcPath, ['-t', deviceId, 'shell', command], {
    timeoutMs: 12_000,
  });
  assertHarmonyCommand(result);
  return result.stdout;
}

function settledOutput(result) {
  return result.status === 'fulfilled' ? result.value.trim() : '';
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function parseHarmonySize(output) {
  const active = output.match(/foldScreenId:(\d+),\s*isConnected:\d+,\s*isPowerOn:1/);
  if (active) {
    const match = output.match(
      new RegExp(`screen\\[\\d+\\]:\\s*id=${active[1]}.*?render\\s+(?:size|resolution)\\s*[:=]\\s*(\\d{3,5})x(\\d{3,5})`, 's'),
    );
    if (match) return { width: Number(match[1]), height: Number(match[2]) };
  }
  const match = output.match(/render\s+(?:size|resolution)\s*[:=]\s*(\d{3,5})x(\d{3,5})/);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : {};
}
