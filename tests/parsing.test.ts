import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAndroidSize } from '../server/discovery/android.js';
import { parseHarmonySize } from '../server/discovery/harmony.js';
import { decodeDeviceId, encodeDeviceId } from '../server/utils/ids.js';
import { imageDimensions } from '../server/utils/image.js';

test('Android physical and override screen sizes are parsed', () => {
  assert.deepEqual(parseAndroidSize('Physical size: 1080x2400'), {
    width: 1080,
    height: 2400,
  });
  assert.deepEqual(
    parseAndroidSize('Physical size: 1080x2400\nOverride size: 720x1600'),
    { width: 720, height: 1600 },
  );
});

test('HarmonyOS render size is parsed', () => {
  assert.deepEqual(
    parseHarmonySize('render size: 1260x2720\n'),
    { width: 1260, height: 2720 },
  );
});

test('device IDs preserve platform and native identifiers', () => {
  for (const [platform, nativeId] of [
    ['android', 'R58M123ABC'],
    ['ios', 'wda'],
    ['harmony', '012345:6789'],
  ] as const) {
    assert.deepEqual(decodeDeviceId(encodeDeviceId(platform, nativeId)), {
      platform,
      nativeId,
    });
  }
  assert.equal(decodeDeviceId('not-a-device-id'), undefined);
});

test('PNG dimensions are read from image headers', () => {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(png);
  png.writeUInt32BE(750, 16);
  png.writeUInt32BE(1334, 20);
  assert.deepEqual(imageDimensions(png), { width: 750, height: 1334 });
});
