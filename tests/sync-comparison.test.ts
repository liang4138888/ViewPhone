import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const temporaryRoot = await mkdtemp(join(tmpdir(), 'viewphone-sync-comparison-test-'));
process.env.VIEWPHONE_ARCHIVE_ROOT = join(temporaryRoot, 'archives');
process.env.VIEWPHONE_TEST_RUNS_ROOT = join(temporaryRoot, 'test-runs');
process.env.MYSQL_URL = '';
process.env.MYSQL_USER = '';
process.env.SPRING_DATASOURCE_URL = '';
process.env.SPRING_DATASOURCE_USERNAME = '';

const {
  buildSyncDevicePairs,
  createSyncPageComparison,
  retryArchivedSyncPageComparison,
  startSyncPageComparison,
  waitForSyncComparisons,
} = await import('../server/services/syncComparison.js');
const { mapDifferenceToOverviewRegion } = await import('../server/services/deviceOverview.js');
const { getArchivedRun, listArchivedRuns } = await import('../server/services/archiveStore.js');
test.after(async () => {
  await waitForSyncComparisons();
  await rm(temporaryRoot, { recursive: true, force: true });
});

test('all connected device pages produce every unordered comparison pair', () => {
  const pairs = buildSyncDevicePairs([
    { id: 'a', name: 'Android' },
    { id: 'i', name: 'iOS' },
    { id: 'h', name: 'HarmonyOS' },
    { id: 'a2', name: 'Android 2' },
  ]);
  assert.deepEqual(
    pairs.map(({ source, target }) => `${source.id}-${target.id}`),
    ['a-i', 'a-h', 'a-a2', 'i-h', 'i-a2', 'h-a2'],
  );
  assert.equal(pairs.length, 6);
});

test('difference boxes are placed on the corresponding phone in the combined image', () => {
  assert.deepEqual(
    mapDifferenceToOverviewRegion(
      { x: 100, y: 200, width: 300, height: 400 },
      { x: 500, y: 0, width: 400, height: 1_000 },
    ),
    { x: 540, y: 200, width: 120, height: 400 },
  );
  assert.equal(mapDifferenceToOverviewRegion(undefined, { x: 0, y: 0, width: 1, height: 1 }), undefined);
});

test('multi-device comparison returns all screenshots and mutual page differences', async () => {
  const source = {
    id: 'a_android',
    name: 'Android',
    platform: 'android',
    width: 1080,
    height: 2340,
  };
  const harmony = {
    id: 'h_harmony',
    name: 'HarmonyOS',
    platform: 'harmony',
    width: 1260,
    height: 2720,
  };
  const ios = {
    id: 'i_ios',
    name: 'iOS',
    platform: 'ios',
    width: 1170,
    height: 2532,
  };
  const names = new Map([
    [source.id, source.name],
    [harmony.id, harmony.name],
    [ios.id, ios.name],
  ]);
  const adapters = {
    [source.id]: {
      screenshot: async () => ({ buffer: Buffer.from('android-page'), width: 1080, height: 2340 }),
    },
    [harmony.id]: {
      screenshot: async () => ({ buffer: Buffer.from('harmony-page'), width: 1260, height: 2720 }),
    },
    [ios.id]: {
      screenshot: async () => ({ buffer: Buffer.from('ios-page'), width: 1170, height: 2532 }),
    },
  };
  const compared: string[] = [];

  const result = await createSyncPageComparison({
    source,
    targets: [harmony, ios],
    adapterFor: (device: { id: keyof typeof adapters }) => adapters[device.id],
    visionConfig: {
      configured: true,
      provider: 'openai',
      model: 'test-vision-model',
      apiKey: 'test-key',
      apiUrl: 'http://vision.invalid/v1/chat/completions',
      missing: [],
      timeoutMs: 10_000,
    },
    comparePages: async ({ sourceName, targetName, sourceFrame, targetFrame }) => {
      compared.push(`${sourceName}->${targetName}`);
      const sourceLabel = sourceFrame.buffer.toString();
      const targetLabel = targetFrame.buffer.toString();
      if (sourceLabel === targetLabel) {
        return { same: true, summary: '页面一致', differences: [] };
      }
      return {
        same: false,
        summary: `${sourceName} 与 ${targetName} 页面不同`,
        differences: [{
          type: 'text',
          title: `${sourceName} / ${targetName}`,
          description: `${sourceName} 是 ${sourceLabel}，${targetName} 是 ${targetLabel}`,
          region: { x: 100, y: 200, width: 300, height: 100 },
        }],
      };
    },
    composeOverview: async (devices: Array<{ device: { id: string }; frame: { width: number; height: number } }>) => ({
      buffer: Buffer.from('combined-overview'),
      width: 2_400,
      height: 1_600,
      devices: devices.map(({ device, frame }, index) => ({
        id: device.id,
        name: device.id,
        platform: 'android',
        x: index * 500,
        y: 0,
        width: 480,
        height: 1_000,
        frame,
      })),
    }),
  });

  assert.equal(result.devices?.length, 3);
  assert.deepEqual(result.devices?.map((device: { name: string }) => device.name), [...names.values()]);
  assert.equal(result.pairs?.length, 3);
  assert.equal(result.devices?.length, 3);
  assert.equal(result.overview?.width, 2_400);
  assert.equal(result.overview?.devices.length, 3);
  assert.match(result.overview?.imageUrl || '', /comparison-overview\.png$/);
  assert.deepEqual(compared, [
    'Android->HarmonyOS',
    'Android->iOS',
    'HarmonyOS->iOS',
  ]);
  assert.deepEqual(
    result.pairs?.map((pair: { source: { name: string }; target: { name: string } }) => (
      `${pair.source.name}-${pair.target.name}`
    )),
    ['Android-HarmonyOS', 'Android-iOS', 'HarmonyOS-iOS'],
  );
  assert.ok(result.pairs?.every((pair: { differences: unknown[] }) => pair.differences.length > 0));
  assert.deepEqual(result.targets.map((target: { target: { id: string } }) => target.target.id), [
    harmony.id,
    ios.id,
  ]);
});

test('asynchronous comparison saves screenshots first and exposes live progress', async () => {
  const source = {
    id: 'a_live',
    name: 'Android live',
    platform: 'android',
    width: 1080,
    height: 2340,
  };
  const harmony = {
    id: 'h_live',
    name: 'Harmony live',
    platform: 'harmony',
    width: 1260,
    height: 2720,
  };
  const ios = {
    id: 'i_live',
    name: 'iOS live',
    platform: 'ios',
    width: 1170,
    height: 2532,
  };
  const adapters = new Map([
    [source.id, { screenshot: async () => ({ buffer: Buffer.from('android-live'), width: 1080, height: 2340 }) }],
    [harmony.id, { screenshot: async () => ({ buffer: Buffer.from('harmony-live'), width: 1260, height: 2720 }) }],
    [ios.id, { screenshot: async () => ({ buffer: Buffer.from('ios-live'), width: 1170, height: 2532 }) }],
  ]);
  let release!: () => void;
  const analysisGate = new Promise<void>((resolve) => { release = resolve; });
  let compared = 0;

  const started = await startSyncPageComparison({
    source,
    targets: [harmony, ios],
    adapterFor: (device: { id: string }) => adapters.get(device.id),
    comparePages: async () => {
      await analysisGate;
      compared += 1;
      return { same: false, summary: '页面不同', differences: [] };
    },
    composeOverview: async (devices: Array<{ device: { id: string }; frame: { width: number; height: number } }>) => ({
      buffer: Buffer.from('live-overview'),
      width: 2_400,
      height: 1_600,
      devices: devices.map(({ device, frame }, index) => ({
        id: device.id,
        name: device.id,
        platform: 'android',
        x: index * 500,
        y: 0,
        width: 480,
        height: 1_000,
        frame,
      })),
    }),
  });

  assert.equal(started.status, 'running');
  assert.equal(started.devices?.length, 3);
  assert.equal(started.pairs?.length, 3);
  assert.ok(started.pairs?.every((pair: { status: string }) => pair.status === 'pending'));
  assert.match(started.overview?.imageUrl || '', /comparison-overview\.png$/);
  assert.equal(started.progress?.analyzed, 0);
  release();
  await waitFor(() => compared === 3);
  await waitForSyncComparisons();
  assert.equal(started.status, 'completed');
  assert.equal(started.progress?.analyzed, 3);
});

test('a named page checkpoint is compareable, archived and searchable by page name', async () => {
  const source = {
    id: 'a_checkpoint',
    name: 'Android checkpoint',
    platform: 'android',
    width: 1080,
    height: 2340,
  };
  const harmony = {
    id: 'h_checkpoint',
    name: 'Harmony checkpoint',
    platform: 'harmony',
    width: 1260,
    height: 2720,
  };
  const ios = {
    id: 'i_checkpoint',
    name: 'iOS checkpoint',
    platform: 'ios',
    width: 1170,
    height: 2532,
  };
  const adapters = new Map([
    [source.id, { screenshot: async () => ({ buffer: Buffer.from('checkpoint-android'), width: 1080, height: 2340 }) }],
    [harmony.id, { screenshot: async () => ({ buffer: Buffer.from('checkpoint-harmony'), width: 1260, height: 2720 }) }],
    [ios.id, { screenshot: async () => ({ buffer: Buffer.from('checkpoint-ios'), width: 1170, height: 2532 }) }],
  ]);
  const screenshotCalls = new Map([[source.id, 0], [harmony.id, 0], [ios.id, 0]]);
  for (const device of [source, harmony, ios]) {
    const adapter = adapters.get(device.id)!;
    const screenshot = adapter.screenshot;
    adapter.screenshot = async () => {
      screenshotCalls.set(device.id, (screenshotCalls.get(device.id) || 0) + 1);
      return screenshot();
    };
  }
  let compared = 0;

  const started = await startSyncPageComparison({
    source,
    targets: [harmony, ios],
    checkpointName: '  首页  ',
    adapterFor: (device: { id: string }) => adapters.get(device.id),
    comparePages: async () => {
      compared += 1;
      return { same: false, summary: '页面不同', differences: [] };
    },
    composeOverview: async (devices: Array<{ device: { id: string }; frame: { width: number; height: number } }>) => ({
      buffer: Buffer.from('checkpoint-overview'),
      width: 2_400,
      height: 1_600,
      devices: devices.map(({ device, frame }, index) => ({
        id: device.id,
        name: device.id,
        platform: 'android',
        x: index * 500,
        y: 0,
        width: 480,
        height: 1_000,
        frame,
      })),
    }),
  });

  assert.equal(started.trigger, 'checkpoint');
  assert.equal(started.checkpointName, '首页');
  assert.equal(started.pairs?.length, 3);
  assert.deepEqual([...screenshotCalls.values()], [1, 1, 1]);
  assert.match(started.overview?.imageUrl || '', /comparison-overview\.png$/);
  await waitFor(() => compared === 3);
  await waitForSyncComparisons();

  const archived = await getArchivedRun(started.id);
  assert.equal(archived?.run.flow, '页面打点：首页');
  assert.equal(archived?.run.comparison?.checkpointName, '首页');
  const matching = await listArchivedRuns({ query: '首页', category: '首页' });
  assert.ok(matching.some((record) => (
    record.id === started.id && record.comparison?.checkpointName === '首页'
  )));
});

test('a failed archived checkpoint can re-run from its saved device screenshots', async () => {
  const source = {
    id: 'a_retry',
    name: 'Android retry',
    platform: 'android',
    width: 1080,
    height: 2340,
  };
  const harmony = {
    id: 'h_retry',
    name: 'Harmony retry',
    platform: 'harmony',
    width: 1260,
    height: 2720,
  };
  const ios = {
    id: 'i_retry',
    name: 'iOS retry',
    platform: 'ios',
    width: 1170,
    height: 2532,
  };
  const adapters = new Map([
    [source.id, { screenshot: async () => pngFrame(1080, 2340) }],
    [harmony.id, { screenshot: async () => pngFrame(1260, 2720) }],
    [ios.id, { screenshot: async () => pngFrame(1170, 2532) }],
  ]);
  const screenshotCalls = new Map([[source.id, 0], [harmony.id, 0], [ios.id, 0]]);
  for (const device of [source, harmony, ios]) {
    const adapter = adapters.get(device.id)!;
    const screenshot = adapter.screenshot;
    adapter.screenshot = async () => {
      screenshotCalls.set(device.id, (screenshotCalls.get(device.id) || 0) + 1);
      return screenshot();
    };
  }

  const failed = await createSyncPageComparison({
    source,
    targets: [harmony, ios],
    checkpointName: '首页',
    adapterFor: (device: { id: string }) => adapters.get(device.id),
    comparePages: async () => {
      throw new Error('视觉模型返回了空结果');
    },
    composeOverview: async (devices: Array<{ device: { id: string }; frame: { width: number; height: number } }>) => ({
      buffer: pngBuffer(source.width * 3, source.height),
      width: source.width * 3,
      height: source.height,
      devices: devices.map(({ device, frame }, index) => ({
        id: device.id,
        name: device.id,
        platform: 'android',
        x: index * 330,
        y: 0,
        width: 320,
        height: 1_000,
        frame,
      })),
    }),
  });
  assert.equal(failed.status, 'failed');
  assert.ok(failed.pairs?.every((pair: { status: string }) => pair.status === 'error'));
  assert.deepEqual([...screenshotCalls.values()], [1, 1, 1]);

  let releaseRetry!: () => void;
  const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
  let retriedPairs = 0;
  const retrying = await retryArchivedSyncPageComparison(failed.id, {
    comparePages: async () => {
      await retryGate;
      retriedPairs += 1;
      return { same: false, summary: '重新分析完成', differences: [] };
    },
  });

  assert.equal(retrying.status, 'running');
  assert.equal(retrying.retryCount, 1);
  assert.equal(retrying.progress?.retrying, 3);
  assert.ok(retrying.pairs?.every((pair: { status: string; retrying?: boolean }) => (
    pair.status === 'pending' && pair.retrying === true
  )));
  assert.deepEqual([...screenshotCalls.values()], [1, 1, 1]);
  releaseRetry();
  await waitFor(() => retriedPairs === 3);
  await waitForSyncComparisons();

  const archived = await getArchivedRun(failed.id);
  const comparison = archived?.run.comparison;
  assert.equal(comparison?.status, 'completed');
  assert.equal(comparison?.checkpointName, '首页');
  assert.equal(archived?.run.flow, '页面打点：首页');
  assert.ok(comparison?.pairs?.every((pair: { status: string; retrying?: boolean }) => (
    pair.status === 'compared' && pair.retrying === false
  )));
  assert.deepEqual([...screenshotCalls.values()], [1, 1, 1]);
});

function pngFrame(width: number, height: number) {
  return { buffer: pngBuffer(width, height), width, height };
}

function pngBuffer(width: number, height: number) {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(png);
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

async function waitFor(check: () => boolean, timeoutMs = 5_000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待异步页面对比完成超时');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
