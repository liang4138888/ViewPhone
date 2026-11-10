import { run } from '../utils/command.js';

const SAMPLE_WIDTH = 180;
const SAMPLE_HEIGHT = 360;
const PIXEL_DELTA = 28;

/** Compare frames after normalization so Retina and phone resolutions remain comparable. */
export async function compareImages(beforePath, afterPath, ffmpegPath = 'ffmpeg') {
  const [before, after] = await Promise.all([
    sampleImage(beforePath, ffmpegPath),
    sampleImage(afterPath, ffmpegPath),
  ]);
  let changedPixels = 0;
  let contentPixels = 0;
  let totalDelta = 0;
  let minX = SAMPLE_WIDTH;
  let minY = SAMPLE_HEIGHT;
  let maxX = 0;
  let maxY = 0;
  const statusRows = Math.round(SAMPLE_HEIGHT * 0.03);
  for (let index = 0; index < before.length; index += 3) {
    const delta =
      (Math.abs(before[index] - after[index]) +
        Math.abs(before[index + 1] - after[index + 1]) +
        Math.abs(before[index + 2] - after[index + 2])) /
      3;
    totalDelta += delta;
    const pixel = index / 3;
    const y = Math.floor(pixel / SAMPLE_WIDTH);
    const x = pixel % SAMPLE_WIDTH;
    // Ignore only the clock/battery strip for the content ratio.
    if (y < statusRows) continue;
    contentPixels += 1;
    if (delta <= PIXEL_DELTA) continue;
    changedPixels += 1;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return {
    changedRatio: round(changedPixels / Math.max(1, contentPixels)),
    averageDelta: round(totalDelta / (before.length / 3) / 255),
    changedRegions: changedPixels === 0
      ? []
      : [{
          left: round(minX / SAMPLE_WIDTH),
          top: round(minY / SAMPLE_HEIGHT),
          right: round((maxX + 1) / SAMPLE_WIDTH),
          bottom: round((maxY + 1) / SAMPLE_HEIGHT),
        }],
  };
}

async function sampleImage(path, ffmpegPath) {
  const result = await run(
    ffmpegPath,
    [
      '-v', 'error',
      '-i', path,
      '-vf', `scale=${SAMPLE_WIDTH}:${SAMPLE_HEIGHT}:flags=area,format=rgb24`,
      '-frames:v', '1',
      '-f', 'rawvideo',
      'pipe:1',
    ],
    { timeoutMs: 12_000, encoding: 'buffer' },
  );
  const expected = SAMPLE_WIDTH * SAMPLE_HEIGHT * 3;
  if (result.stdout.length !== expected) {
    throw new Error(`截图采样结果不完整（${result.stdout.length}/${expected} 字节）`);
  }
  return result.stdout;
}

function round(value) {
  return Math.round(Number(value) * 10_000) / 10_000;
}
