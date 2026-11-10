import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { run } from '../utils/command.js';

const PANEL_HEIGHT = 2_400;
const SEPARATOR_WIDTH = 6;

/**
 * Some Anthropic-compatible gateways silently drop a request containing two
 * image blocks. Build one side-by-side image instead: the source phone stays
 * on the left and the target phone on the right. Both panels are scaled to a
 * common height while preserving their aspect ratio.
 */
export async function composeVisionComparison(
  source,
  target,
  { ffmpegPath = config.ffmpegPath } = {},
) {
  assertFrame(source, '来源');
  assertFrame(target, '目标');
  const directory = await mkdtemp(join(tmpdir(), 'viewphone-vision-'));
  const sourcePath = join(directory, `source.${frameExtension(source.buffer)}`);
  const targetPath = join(directory, `target.${frameExtension(target.buffer)}`);
  const outputPath = join(directory, 'comparison.jpg');
  try {
    await Promise.all([
      writeFile(sourcePath, source.buffer),
      writeFile(targetPath, target.buffer),
    ]);
    const filter = [
      `[0:v]scale=-2:${PANEL_HEIGHT}:flags=lanczos,pad=iw+${SEPARATOR_WIDTH}:ih:0:0:color=white[left]`,
      `[1:v]scale=-2:${PANEL_HEIGHT}:flags=lanczos[right]`,
      '[left][right]hstack=inputs=2[comparison]',
    ].join(';');
    await run(
      ffmpegPath,
      [
        '-v', 'error',
        '-i', sourcePath,
        '-i', targetPath,
        '-filter_complex', filter,
        '-map', '[comparison]',
        '-frames:v', '1',
        '-q:v', '2',
        outputPath,
      ],
      { timeoutMs: 15_000 },
    );
    return {
      buffer: await readFile(outputPath),
      layout: 'source-left-target-right',
      separator: 'white-vertical-line',
    };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

function assertFrame(frame, label) {
  if (!Buffer.isBuffer(frame?.buffer) || frame.buffer.length === 0) {
    throw Object.assign(new Error(`${label}截图不能为空`), {
      code: 'VISION_SYNC_SCREENSHOT_MISSING',
      statusCode: 422,
    });
  }
}

function frameExtension(buffer) {
  return buffer[0] === 0xff && buffer[1] === 0xd8 ? 'jpg' : 'png';
}
