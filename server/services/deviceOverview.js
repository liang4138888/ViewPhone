import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { run } from '../utils/command.js';
import { imageDimensions } from '../utils/image.js';

const PANEL_HEIGHT = 1_600;
const PANEL_GAP = 14;

/**
 * Put every connected phone into one wide overview image. Individual screens
 * are scaled to a common height so pages with different resolutions can still
 * be inspected side by side.
 */
export async function composeDeviceOverview(
  devices,
  { ffmpegPath = config.ffmpegPath } = {},
) {
  if (!Array.isArray(devices) || devices.length === 0) {
    throw overviewError('没有可拼接的设备截图');
  }
  const directory = await mkdtemp(join(tmpdir(), 'viewphone-overview-'));
  const inputs = [];
  const panels = [];
  let totalWidth = 0;
  try {
    for (let index = 0; index < devices.length; index += 1) {
      const item = devices[index];
      const buffer = item?.frame?.buffer;
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw overviewError(`设备 ${item?.device?.name || index + 1} 缺少截图`);
      }
      const sourceSize = imageDimensions(buffer) || {
        width: Number(item.frame.width),
        height: Number(item.frame.height),
      };
      if (!(sourceSize.width > 1) || !(sourceSize.height > 1)) {
        throw overviewError(`设备 ${item.device?.name || index + 1} 的截图尺寸无效`);
      }
      const width = evenWidth(sourceSize.width * PANEL_HEIGHT / sourceSize.height);
      const path = join(directory, `device-${index}.${extension(buffer)}`);
      await writeFile(path, buffer);
      inputs.push(path);
      panels.push({
        device: item.device,
        x: totalWidth,
        width,
      });
      totalWidth += width + PANEL_GAP;
    }

    const filters = [];
    for (let index = 0; index < panels.length; index += 1) {
      const panel = panels[index];
      filters.push(
        `[${index}:v]scale=${panel.width}:${PANEL_HEIGHT}:flags=lanczos,` +
        `pad=${panel.width + PANEL_GAP}:${PANEL_HEIGHT}:0:0:color=0x20251f[panel${index}]`,
      );
    }
    filters.push(
      `${panels.map((_panel, index) => `[panel${index}]`).join('')}` +
      `hstack=inputs=${panels.length}[overview]`,
    );
    const outputPath = join(directory, 'overview.jpg');
    await run(
      ffmpegPath,
      [
        '-v', 'error',
        ...inputs.flatMap((path) => ['-i', path]),
        '-filter_complex', filters.join(';'),
        '-map', '[overview]',
        '-frames:v', '1',
        '-q:v', '3',
        outputPath,
      ],
      { timeoutMs: 30_000 },
    );
    return {
      buffer: await readFile(outputPath),
      width: totalWidth,
      height: PANEL_HEIGHT,
      devices: panels.map((panel) => ({
        id: panel.device.id,
        name: panel.device.name,
        platform: panel.device.platform,
        x: normalize(panel.x, totalWidth),
        y: 0,
        width: normalize(panel.width, totalWidth),
        height: 1_000,
      })),
    };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

export function mapDifferenceToOverviewRegion(region, panel) {
  if (!region || !panel) return undefined;
  return {
    x: Math.round(panel.x + panel.width * region.x / 1_000),
    y: Math.round(panel.y + panel.height * region.y / 1_000),
    width: Math.max(1, Math.round(panel.width * region.width / 1_000)),
    height: Math.max(1, Math.round(panel.height * region.height / 1_000)),
  };
}

function evenWidth(value) {
  return Math.max(2, Math.round(value / 2) * 2);
}

function normalize(value, total) {
  return Math.round(Math.max(0, Math.min(total, value)) / total * 1_000);
}

function extension(buffer) {
  return buffer?.[0] === 0xff && buffer?.[1] === 0xd8 ? 'jpg' : 'png';
}

function overviewError(message) {
  return Object.assign(new Error(message), {
    code: 'SYNC_OVERVIEW_INVALID',
    statusCode: 500,
  });
}
