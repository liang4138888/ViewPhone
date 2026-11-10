import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { archiveTestRun, getArchivedRun } from './archiveStore.js';
import { compareImages } from './imageDiff.js';
import {
  compareVisionSyncPages,
  getVisionModelConfig,
} from './visionModel.js';
import { composeDeviceOverview } from './deviceOverview.js';
import { imageDimensions } from '../utils/image.js';

const records = new Map();
const images = new Map();
const analysisContexts = new Map();
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifactRoot = config.testRunsRoot
  ? resolve(config.testRunsRoot)
  : join(root, '.artifacts/test-runs');
const RECORD_TTL_MS = 60 * 60 * 1_000;
const MAX_RECORDS = 20;
const MAX_IMAGES = MAX_RECORDS * 16;
const activeComparisons = new Set();

/** Build every unordered pair so all connected pages are compared mutually. */
export function buildSyncDevicePairs(items) {
  const pairs = [];
  for (let sourceIndex = 0; sourceIndex < items.length; sourceIndex += 1) {
    for (let targetIndex = sourceIndex + 1; targetIndex < items.length; targetIndex += 1) {
      pairs.push({ source: items[sourceIndex], target: items[targetIndex] });
    }
  }
  return pairs;
}

export async function startSyncPageComparison(options) {
  const record = await captureSyncPageComparison(options);
  activeComparisons.add(record.id);
  void analyzeSyncPageComparison(record.id, options)
    .catch(async (error) => {
      record.status = 'failed';
      record.error = error instanceof Error ? error.message : String(error);
      record.finishedAt = new Date().toISOString();
      for (const pair of record.pairs || []) {
        if (pair.status === 'pending') {
          pair.status = 'error';
          pair.error = record.error;
          pair.summary = '页面差异分析未完成';
        }
      }
      updateTargetResults(record);
      await checkpointComparisonRecord(record).catch(() => undefined);
    })
    .finally(() => {
      analysisContexts.delete(record.id);
      activeComparisons.delete(record.id);
    });
  return record;
}

/** Tests and graceful shutdown can wait for background visual analysis. */
export async function waitForSyncComparisons() {
  while (activeComparisons.size > 0) await pause(20);
}

export async function createSyncPageComparison(options) {
  const record = await captureSyncPageComparison(options);
  try {
    return await analyzeSyncPageComparison(record.id, options);
  } finally {
    analysisContexts.delete(record.id);
  }
}

export async function captureSyncPageComparison({
  source,
  targets,
  action,
  checkpointName,
  adapterFor,
  composeOverview = composeDeviceOverview,
}) {
  if (!(targets?.length > 0)) {
    throw comparisonError('至少需要一台已同步的目标设备', 'SYNC_COMPARE_TARGETS_MISSING', 400);
  }
  const sourceAdapter = adapterFor(source);
  const targetAdapters = targets.map((target) => ({ target, adapter: adapterFor(target) }));
  const directories = [];
  try {
    const normalizedCheckpoint = normalizeCheckpointName(checkpointName);
    let capturedFrames;
    if (normalizedCheckpoint) {
      // A checkpoint captures the page the tester is looking at now. Capture
      // every physical device in parallel instead of waiting for several
      // sequential stability samples.
      capturedFrames = await Promise.all([
        sourceAdapter.screenshot().then((frame) => ({ device: source, frame })),
        ...targetAdapters.map(({ target, adapter }) =>
          adapter.screenshot().then((frame) => ({ device: target, frame }))),
      ]);
    } else {
      const sourceFrame = await settleSyncFrame(sourceAdapter, true);
      directories.push(sourceFrame.temporaryDirectory);
      const settledTargets = await Promise.all(targetAdapters.map(async ({ target, adapter }) => {
        const frame = await settleSyncFrame(adapter, false);
        directories.push(frame.temporaryDirectory);
        return { target, frame };
      }));
      capturedFrames = [
        { device: source, frame: sourceFrame },
        ...settledTargets.map(({ target, frame }) => ({ device: target, frame })),
      ];
    }

    const id = randomUUID();
    const captured = await Promise.all(capturedFrames.map(async ({ device, frame }, index) => {
      const role = `device-${index + 1}`;
      putImage(`${id}-${role}`, frame.buffer, frame);
      const imageUrl = await persistComparisonImage(id, `device-${index + 1}`, frame.buffer);
      return {
        device,
        frame,
        size: frameInputSize(device, frame),
        view: comparisonDevice(device, imageUrl),
      };
    }));

    const combined = await composeOverview(captured);
    putImage(`${id}-overview`, combined.buffer, {
      width: combined.width,
      height: combined.height,
    });
    const overviewImageUrl = await persistComparisonImage(id, 'overview', combined.buffer);
    const overview = {
      imageUrl: overviewImageUrl,
      width: combined.width,
      height: combined.height,
      devices: combined.devices.map((device) => {
        const capturedDevice = captured.find((item) => item.device.id === device.id);
        return {
          ...device,
          imageUrl: capturedDevice?.view.imageUrl || '',
        };
      }),
    };

    const sourceView = captured[0].view;
    const pairs = buildSyncDevicePairs(captured).map((pair) => ({
      status: 'pending',
      source: pair.source.view,
      target: pair.target.view,
      differences: [],
    }));
    const capturedAt = new Date().toISOString();
    const record = {
      id,
      status: 'running',
      trigger: normalizedCheckpoint ? 'checkpoint' : action ? 'sync' : 'manual',
      ...(normalizedCheckpoint ? { checkpointName: normalizedCheckpoint } : {}),
      ...(action ? { action: action.type } : {}),
      createdAt: capturedAt,
      captureCompletedAt: capturedAt,
      source: sourceView,
      devices: captured.map((item) => item.view),
      pairs,
      progress: { analyzed: 0, total: pairs.length },
      overview,
      targets: [],
    };
    updateTargetResults(record);
    pruneRecords();
    records.set(id, record);
    analysisContexts.set(id, { captured, action, composeOverview });
    await checkpointComparisonRecord(record);
    return record;
  } finally {
    await Promise.all(directories.map((directory) =>
      rm(directory, { recursive: true, force: true }).catch(() => {}),
    ));
  }
}

export function getSyncPageComparison(id) {
  return records.get(String(id || ''));
}

/** Read an old comparison from its automatic archive after a server restart. */
export async function restoreSyncPageComparison(archivedRun) {
  const comparison = archivedRun?.comparison;
  if (!comparison?.id || archivedRun.recordType !== 'comparison') return undefined;
  return comparison;
}

export async function analyzeSyncPageComparison(id, options = {}) {
  const record = records.get(String(id || ''));
  const context = analysisContexts.get(String(id || ''));
  if (!record || !context) {
    throw comparisonError('页面差异记录不存在或已过期', 'SYNC_COMPARE_NOT_FOUND', 404);
  }
  const visionConfig = options.visionConfig || getVisionModelConfig();
  const comparePages = options.comparePages || compareVisionSyncPages;
  record.status = 'running';
  record.analysisStartedAt = new Date().toISOString();
  for (const pair of record.pairs || []) {
    if (pair.status !== 'pending') continue;
    const source = context.captured.find((item) => item.device.id === pair.source.id);
    const target = context.captured.find((item) => item.device.id === pair.target.id);
    if (!source || !target) {
      pair.status = 'error';
      pair.error = '截图数据不存在';
      continue;
    }
    const pixelDiff = await compareFrameBuffers(
      source.frame.buffer,
      target.frame.buffer,
    ).catch(() => undefined);
    try {
      const result = await comparePages({
        action: context.action,
        sourceName: source.device.name,
        targetName: target.device.name,
        sourceSize: source.size,
        targetSize: target.size,
        sourceFrame: source.frame,
        targetFrame: target.frame,
        config: visionConfig,
      });
      Object.assign(pair, {
        status: 'compared',
        ...result,
        pixelChangedRatio: pixelDiff?.changedRatio,
        differences: result.differences || [],
      });
    } catch (error) {
      Object.assign(pair, {
        status: 'error',
        summary: '视觉对比未完成，但两台设备的页面截图已保存',
        differences: [],
        pixelChangedRatio: pixelDiff?.changedRatio,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    record.progress = {
      analyzed: (record.progress?.analyzed || 0) + 1,
      total: record.progress?.total || record.pairs?.length || 1,
    };
    updateTargetResults(record);
    await checkpointComparisonRecord(record).catch((error) => {
      console.warn(`[页面对比] 临时归档更新失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }
  const pairs = record.pairs || [];
  record.status = pairs.length > 0 && pairs.every((pair) => pair.status === 'error')
    ? 'failed'
    : 'completed';
  record.finishedAt = new Date().toISOString();
  updateTargetResults(record);
  await checkpointComparisonRecord(record);
  analysisContexts.delete(record.id);
  return record;
}

/** Re-run only failed pairs from the screenshots already stored in an archive. */
export async function retryArchivedSyncPageComparison(
  id,
  options = {},
) {
  const archived = await getArchivedRun(String(id || ''));
  if (!archived || archived.run?.recordType !== 'comparison') {
    throw comparisonError('页面差异归档记录不存在或已过期', 'SYNC_COMPARE_NOT_FOUND', 404);
  }
  const record = archived.run.comparison;
  if (!record?.pairs?.length) {
    throw comparisonError('这条记录没有可重跑的页面对比结果', 'SYNC_COMPARE_RETRY_UNAVAILABLE', 400);
  }
  if (record.status === 'running' || activeComparisons.has(record.id)) {
    throw comparisonError('页面差异分析正在进行中，请稍后重试', 'SYNC_COMPARE_BUSY', 409);
  }
  const retryPairs = record.pairs.filter((pair) => pair.status === 'error');
  if (retryPairs.length === 0) {
    throw comparisonError('这条记录没有失败的设备对比项', 'SYNC_COMPARE_RETRY_NOT_NEEDED', 400);
  }
  const captured = await readArchivedComparisonFrames(record);
  const retryIds = new Set(retryPairs.map((pair) => `${pair.source.id}\u0000${pair.target.id}`));
  const pendingPairs = record.pairs.filter((pair) =>
    retryIds.has(`${pair.source.id}\u0000${pair.target.id}`));
  for (const pair of pendingPairs) {
    pair.status = 'pending';
    pair.retrying = true;
    pair.error = undefined;
    pair.summary = undefined;
    pair.differences = [];
  }
  record.status = 'running';
  record.error = undefined;
  record.finishedAt = undefined;
  record.retryCount = (record.retryCount || 0) + 1;
  record.retryStartedAt = new Date().toISOString();
  updateArchiveRetryProgress(record);
  activeComparisons.add(record.id);
  await checkpointComparisonRecord(record);
  void analyzeRetriedPairs(record, captured, options)
    .catch(async (error) => {
      record.status = 'failed';
      record.error = error instanceof Error ? error.message : String(error);
      record.finishedAt = new Date().toISOString();
      for (const pair of record.pairs || []) {
        if (pair.status === 'pending') {
          pair.status = 'error';
          pair.retrying = false;
          pair.error = record.error;
          pair.summary = '页面差异重新分析未完成';
        }
      }
      updateTargetResults(record);
      await checkpointComparisonRecord(record).catch(() => undefined);
    })
    .finally(() => activeComparisons.delete(record.id));
  return structuredClone(record);
}

/** Rebuild visual-model frames from screenshots in the same archive record. */
async function readArchivedComparisonFrames(record) {
  return Promise.all((record.devices || []).map(async (device) => {
    let fileName;
    try {
      const pathname = String(device.imageUrl || '').split('?')[0];
      fileName = decodeURIComponent(basename(pathname));
    } catch {
      fileName = '';
    }
    if (!/^comparison-device-\d+\.(?:png|jpe?g)$/i.test(fileName)) {
      throw comparisonError(
        `${device.name || '设备'}的归档截图地址无效`,
        'SYNC_COMPARE_IMAGE_NOT_FOUND',
        404,
      );
    }
    const buffer = await readFile(join(artifactRoot, record.id, fileName))
      .catch(() => undefined);
    const dimensions = buffer && imageDimensions(buffer);
    if (!buffer || !dimensions) {
      throw comparisonError(
        `${device.name || '设备'}的归档截图不存在或无法读取`,
        'SYNC_COMPARE_IMAGE_NOT_FOUND',
        404,
      );
    }
    return {
      device: {
        id: device.id,
        name: device.name,
        platform: device.platform,
      },
      frame: { buffer, ...dimensions },
      size: dimensions,
    };
  }));
}

async function analyzeRetriedPairs(record, captured, options = {}) {
  const visionConfig = options.visionConfig || getVisionModelConfig();
  const comparePages = options.comparePages || compareVisionSyncPages;
  for (const pair of record.pairs || []) {
    if (!pair.retrying) continue;
    const source = captured.find((item) => item.device.id === pair.source.id);
    const target = captured.find((item) => item.device.id === pair.target.id);
    if (!source || !target) {
      pair.status = 'error';
      pair.retrying = false;
      pair.error = '归档截图数据不存在，无法重新分析';
      continue;
    }
    try {
      const result = await comparePages({
        action: record.action,
        sourceName: source.device.name,
        targetName: target.device.name,
        sourceSize: source.size,
        targetSize: target.size,
        sourceFrame: source.frame,
        targetFrame: target.frame,
        config: visionConfig,
      });
      Object.assign(pair, {
        status: 'compared',
        retrying: false,
        ...result,
        differences: result.differences || [],
      });
    } catch (error) {
      Object.assign(pair, {
        status: 'error',
        retrying: false,
        summary: '视觉对比重新分析未完成，但原始截图已保留',
        differences: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
    updateArchiveRetryProgress(record);
    await checkpointComparisonRecord(record).catch((error) => {
      console.warn(`[页面对比] 重跑归档更新失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  const pairs = record.pairs || [];
  record.status = pairs.length > 0 && pairs.every((pair) => pair.status === 'error')
    ? 'failed'
    : 'completed';
  record.finishedAt = new Date().toISOString();
  updateTargetResults(record);
  await checkpointComparisonRecord(record);
}

function updateArchiveRetryProgress(record) {
  const retrying = record.pairs?.filter((pair) => pair.retrying).length || 0;
  const completed = record.pairs?.filter((pair) => pair.status !== 'pending').length || 0;
  record.progress = {
    analyzed: completed,
    total: record.pairs?.length || 1,
    ...(retrying ? { retrying } : {}),
  };
}

export function getSyncComparisonImage(id, variant) {
  const record = records.get(String(id || ''));
  if (!record) {
    throw comparisonError('页面差异记录不存在或已过期', 'SYNC_COMPARE_NOT_FOUND', 404);
  }
  const key = `${id}-${variant}`;
  const image = images.get(key);
  if (!image) {
    throw comparisonError('页面差异截图不存在或已过期', 'SYNC_COMPARE_IMAGE_NOT_FOUND', 404);
  }
  return image;
}

async function settleSyncFrame(adapter, source) {
  // The receiving input has already returned, but SPA content often appears a
  // little later. Keep polling until two full-frame observations agree.
  await pause(source ? 250 : 500);
  const directory = await mkdtemp(join(tmpdir(), 'viewphone-sync-compare-'));
  try {
    let previous;
    let latest;
    for (let attempt = 0; attempt < 9; attempt += 1) {
      latest = await adapter.screenshot();
      const currentPath = join(directory, `${attempt}.${imageExtension(latest.buffer)}`);
      await writeFile(currentPath, latest.buffer);
      if (previous) {
        const diff = await compareImages(previous.path, currentPath, config.ffmpegPath)
          .catch(() => undefined);
        if (diff && !frameChanged(diff)) {
          return { ...latest, path: currentPath, temporaryDirectory: directory };
        }
      }
      previous = { ...latest, path: currentPath };
      await pause(450);
    }
    return { ...latest, path: previous?.path, temporaryDirectory: directory };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function frameChanged(diff) {
  return Number(diff?.changedRatio) > 0.002 || Number(diff?.averageDelta) > 0.003;
}

async function compareFrameBuffers(source, target) {
  const directory = await mkdtemp(join(tmpdir(), 'viewphone-sync-pixel-'));
  const sourcePath = join(directory, `source.${imageExtension(source)}`);
  const targetPath = join(directory, `target.${imageExtension(target)}`);
  try {
    await Promise.all([writeFile(sourcePath, source), writeFile(targetPath, target)]);
    return await compareImages(sourcePath, targetPath, config.ffmpegPath);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

function comparisonDevice(device, imageUrl) {
  return { id: device.id, name: device.name, platform: device.platform, imageUrl };
}

function updateTargetResults(record) {
  const pairs = record.pairs || [];
  record.targets = (record.devices || [])
    .filter((device) => device.id !== record.source.id)
    .map((target) => {
      const pair = pairs.find((item) => (
        item.source.id === record.source.id && item.target.id === target.id
      )) || pairs.find((item) => item.target.id === target.id);
      return {
        status: pair?.status === 'compared' ? 'compared' : 'error',
        target,
        same: pair?.same,
        summary: pair?.summary,
        differences: pair?.differences || [],
        pixelChangedRatio: pair?.pixelChangedRatio,
        error: pair?.error,
      };
    });
}

async function persistComparisonImage(id, role, buffer) {
  const extension = imageExtension(buffer);
  const name = `comparison-${role}.${extension}`;
  const directory = join(artifactRoot, id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name), buffer);
  return `/api/test-runs/${encodeURIComponent(id)}/assets/${encodeURIComponent(name)}`;
}

async function checkpointComparisonRecord(record) {
  const comparison = record;
  const deviceNames = (comparison.devices || []).map((device) => device.name);
  const pairCount = comparison.pairs?.length || 0;
  const differences = (comparison.pairs || [])
    .reduce((total, pair) => total + pair.differences.length, 0);
  const status = comparison.status === 'running'
    ? 'running'
    : comparison.status === 'failed'
      ? 'failed'
      : 'completed';
  await archiveTestRun({
    id: comparison.id,
    recordType: 'comparison',
    deviceId: comparison.source.id,
    deviceName: deviceNames.length > 1 ? `${deviceNames.length} 台设备` : comparison.source.name,
    platform: comparison.source.platform,
    engine: 'vision',
    flow: comparison.checkpointName
      ? `页面打点：${comparison.checkpointName}`
      : `实时页面差异对比：${deviceNames.join('、')}`,
    maxSteps: pairCount,
    status,
    createdAt: comparison.createdAt,
    startedAt: comparison.analysisStartedAt || comparison.captureCompletedAt,
    finishedAt: comparison.finishedAt,
    steps: [],
    comparison,
    verdict: comparison.status === 'completed'
      ? {
          passed: differences === 0,
          reason: differences === 0
            ? `${deviceNames.length} 台设备当前页面未发现明显 UI 差异`
            : `${deviceNames.length} 台设备共识别出 ${differences} 项 UI 差异`,
        }
      : undefined,
  });
}

function frameInputSize(device, frame) {
  return {
    width: Number(device.inputWidth ?? device.width ?? frame.width),
    height: Number(device.inputHeight ?? device.height ?? frame.height),
  };
}

function normalizeCheckpointName(value) {
  if (typeof value !== 'string') return undefined;
  const name = value.trim().slice(0, 80);
  return name || undefined;
}

function putImage(key, buffer, frame) {
  images.set(key, {
    buffer,
    contentType: imageExtension(buffer) === 'jpg' ? 'image/jpeg' : 'image/png',
    expiresAt: Date.now() + RECORD_TTL_MS,
    frame,
  });
  while (images.size > MAX_IMAGES) images.delete(images.keys().next().value);
}

function pruneRecords() {
  const now = Date.now();
  for (const [id, record] of records) {
    if (Date.parse(record.createdAt) + RECORD_TTL_MS <= now) records.delete(id);
  }
  while (records.size >= MAX_RECORDS) {
    const id = records.keys().next().value;
    records.delete(id);
  }
  for (const [key, image] of images) {
    if (image.expiresAt <= now) images.delete(key);
  }
}

function imageExtension(buffer) {
  return buffer?.[0] === 0xff && buffer?.[1] === 0xd8 ? 'jpg' : 'png';
}

function comparisonError(message, code, statusCode) {
  return Object.assign(new Error(message), { code, statusCode });
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
