import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import { findDevice, listAllDevices, createAdapter } from '../services/devices.js';
import { validateAction } from '../services/actions.js';
import {
  nativeTouchStatus,
  startNativeTouch,
  stopNativeTouch,
} from '../services/nativeTouch.js';
import {
  captureSyncSource,
  executeSyncAction,
  getSyncCapture,
  resolveSyncAction,
} from '../services/sync.js';
import { clearLayoutCache } from '../services/semanticSync.js';
import { clearOcrLayoutCache } from '../services/ocrLayout.js';
import { config } from '../config.js';
import {
  assetContentType,
  archiveCompletedTestRun,
  createTestRun,
  getTestRun,
  parseTestFlow,
  placeholderSteps,
  testRunAssetPath,
} from '../services/testFlow.js';
import {
  archiveCategoryCatalog,
  archiveStorageStatus,
  getArchivedRun,
  getSharedRun,
  listArchivedRuns,
  shareArchivedRun,
} from '../services/archiveStore.js';
import { publicVisionModelConfig } from '../services/visionModel.js';
import {
  getSyncComparisonImage,
  getSyncPageComparison,
  retryArchivedSyncPageComparison,
  startSyncPageComparison,
} from '../services/syncComparison.js';

export function createApiRouter() {
  const api = Router();

api.get('/health', (_request, response) => {
  response.json({ ok: true, service: 'ViewPhone', version: '0.1.0' });
});

api.get('/config', (_request, response) => {
  const vision = publicVisionModelConfig();
  response.json({
    frameIntervalMs: config.frameIntervalMs,
    playback: 'polling',
    limits: { textLength: 4_000 },
    vision,
  });
});

api.get('/devices', async (request, response, next) => {
  try {
    const result = await listAllDevices({ refresh: request.query.refresh === '1' });
    response.set('Cache-Control', 'no-store');
    response.json(result);
  } catch (error) {
    next(error);
  }
});

api.get('/devices/:id/frame', async (request, response, next) => {
  try {
    const { device } = await findRequiredDevice(request.params.id);
    const frame = await createAdapter(device).screenshot();
    response.set({
      'Content-Type': imageType(frame.buffer),
      'Content-Length': String(frame.buffer.length),
      'Cache-Control': 'no-store, max-age=0',
      'X-Device-Width': String(frame.width),
      'X-Device-Height': String(frame.height),
      'X-Input-Width': String(device.inputWidth ?? device.width ?? frame.width),
      'X-Input-Height': String(device.inputHeight ?? device.height ?? frame.height),
      'Access-Control-Expose-Headers':
        'X-Device-Width, X-Device-Height, X-Input-Width, X-Input-Height, X-Device-Platform',
      'X-Device-Platform': device.platform,
    });
    response.send(frame.buffer);
  } catch (error) {
    next(error);
  }
});

api.post('/devices/:id/actions', async (request, response, next) => {
  try {
    const { device } = await findRequiredDevice(request.params.id);
    const action = validateAction(request.body);
    if (!insideInputBounds(action, device)) {
      throw Object.assign(new Error('点击位置超出手机画面'), {
        statusCode: 400,
        code: 'OUT_OF_BOUNDS',
      });
    }
    await createAdapter(device).perform(action);
    clearLayoutCache(device.id);
    clearOcrLayoutCache(device.id);
    console.log(
      `[操作] ${device.platform} ${device.name}: ${action.type}` +
        (action.x !== undefined ? ` (${action.x}, ${action.y})` : ''),
    );
    response.json({ ok: true, platform: device.platform, deviceId: device.id, action: action.type });
  } catch (error) {
    next(error);
  }
});

api.post('/sync/captures', async (request, response, next) => {
  try {
    const source = await findRequiredDevice(request.body?.sourceId);
    const capture = await captureSyncSource(source.device, createAdapter(source.device));
    response.set('Cache-Control', 'no-store');
    response.json(capture);
  } catch (error) {
    next(error);
  }
});

api.post('/sync/actions', async (request, response, next) => {
  try {
    const source = await findRequiredDevice(request.body?.sourceId);
    const target = await findRequiredDevice(request.body?.targetId);
    if (source.device.id === target.device.id) {
      throw Object.assign(new Error('同步来源和目标不能是同一台手机'), {
        statusCode: 400,
        code: 'SAME_SYNC_DEVICE',
      });
    }
    const action = validateAction(request.body?.action);
    const mode = request.body?.mode;
    if (!['vision', 'semantic', 'relative', 'pixel'].includes(mode)) {
      throw Object.assign(new Error('不支持的同步定位方式'), {
        statusCode: 400,
        code: 'INVALID_SYNC_MODE',
      });
    }
    const execute = request.body?.execute !== false;
    const sourceAdapter = createAdapter(source.device);
    const targetAdapter = createAdapter(target.device);
    const capture = request.body?.captureId
      ? getSyncCapture(request.body.captureId, source.device.id)
      : undefined;
    const options = {
      sourceFrame: capture?.frame,
      timeoutMs: Number(request.body?.visionTimeoutMs) || 60_000,
    };
    const result = execute
      ? await executeSyncAction(
          source.device,
          target.device,
          action,
          sourceAdapter,
          targetAdapter,
          mode,
          options,
        )
      : {
          ...(await resolveSyncAction(
            source.device,
            target.device,
            action,
            sourceAdapter,
            targetAdapter,
            mode,
            options,
          )),
          executed: false,
        };
    if (result.executed) {
      clearLayoutCache(target.device.id);
      clearOcrLayoutCache(target.device.id);
      console.log(
        `[同步] ${source.device.name} -> ${target.device.name}: ${action.type}` +
          (result.action.x !== undefined ? ` (${result.action.x}, ${result.action.y})` : ''),
      );
    }
    response.json({
      ...result,
      sourceId: source.device.id,
      targetId: target.device.id,
    });
  } catch (error) {
    next(error);
  }
});

api.post('/sync/comparisons', async (request, response, next) => {
  try {
    const source = await findRequiredDevice(request.body?.sourceId);
    const targetIds = Array.isArray(request.body?.targetIds)
      ? [...new Set(request.body.targetIds.filter((id) => typeof id === 'string'))]
      : [];
    if (targetIds.length === 0) {
      throw Object.assign(new Error('请选择至少一台目标设备进行页面对比'), {
        statusCode: 400,
        code: 'SYNC_COMPARE_TARGETS_MISSING',
      });
    }
    if (targetIds.includes(source.device.id)) {
      throw Object.assign(new Error('页面来源和目标不能是同一台手机'), {
        statusCode: 400,
        code: 'SAME_SYNC_COMPARE_DEVICE',
      });
    }
    const targets = await Promise.all(targetIds.map(async (targetId) => {
      const found = await findRequiredDevice(targetId);
      return found.device;
    }));
    // Automatic comparisons carry the synchronized action. Manual comparisons
    // intentionally omit it and only capture the current pages without input.
    const action = request.body?.action
      ? validateAction(request.body.action)
      : undefined;
    const checkpointName = typeof request.body?.checkpointName === 'string'
      ? request.body.checkpointName.trim().slice(0, 80)
      : '';
    const comparison = await startSyncPageComparison({
      source: source.device,
      targets,
      action,
      checkpointName,
      adapterFor: createAdapter,
    });
    response.status(201).json(comparison);
  } catch (error) {
    next(error);
  }
});

api.get('/sync/comparisons/:comparisonId', async (request, response, next) => {
  try {
    const archived = await getArchivedRun(request.params.comparisonId);
    let comparison = archived?.run?.recordType === 'comparison'
      ? archived.run.comparison
      : getSyncPageComparison(request.params.comparisonId);
    if (!comparison) {
      comparison = undefined;
    }
    if (!comparison) {
      throw Object.assign(new Error('页面差异记录不存在或已过期'), {
        statusCode: 404,
        code: 'SYNC_COMPARE_NOT_FOUND',
      });
    }
    response.set('Cache-Control', 'no-store');
    response.json(comparison);
  } catch (error) {
    next(error);
  }
});

api.post('/archives/:runId/comparison/retry', async (request, response, next) => {
  try {
    const comparison = await retryArchivedSyncPageComparison(request.params.runId);
    response.status(202).json(comparison);
  } catch (error) {
    next(error);
  }
});

api.get('/sync/comparisons/:comparisonId/images/:variant', (request, response, next) => {
  try {
    const image = getSyncComparisonImage(request.params.comparisonId, request.params.variant);
    response.set({
      'Content-Type': image.contentType,
      'Content-Length': String(image.buffer.length),
      'Cache-Control': 'private, max-age=3600, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    response.send(image.buffer);
  } catch (error) {
    next(error);
  }
});

api.post('/devices/:id/native-touch/start', async (request, response, next) => {
  try {
    const { device } = await findRequiredDevice(request.params.id);
    const status = await startNativeTouch(device);
    response.set('Cache-Control', 'no-store');
    response.json(status);
  } catch (error) {
    next(error);
  }
});

api.post('/devices/:id/native-touch/stop', (request, response) => {
  stopNativeTouch(request.params.id);
  response.set('Cache-Control', 'no-store');
  response.json({ enabled: false, state: 'stopped', events: [], sequence: 0 });
});

api.get('/devices/:id/native-touch', (request, response) => {
  const parsedAfter = Number(request.query.after);
  const after = Number.isSafeInteger(parsedAfter) && parsedAfter >= 0 ? parsedAfter : 0;
  response.set('Cache-Control', 'no-store');
  response.json(nativeTouchStatus(request.params.id, after));
});

api.post('/devices/:id/open-developer-settings', async (request, response, next) => {
  try {
    const { device } = await findRequiredDevice(request.params.id);
    await createAdapter(device).openDeveloperSettings();
    response.json({ ok: true, platform: device.platform });
  } catch (error) {
    next(error);
  }
});

api.post('/test-flows/preview', (request, response, next) => {
  try {
    const vision = publicVisionModelConfig();
    const requestedEngine = request.body?.engine === 'steps' ? 'steps' : 'vision';
    if (requestedEngine === 'vision' && vision.configured) {
      response.json({
        steps: placeholderSteps(request.body?.flow),
        engine: 'vision',
        vision,
        notice: '视觉智能不会预先拆成固定脚本；系统将逐轮查看截图、执行一个动作并重新识别。',
      });
      return;
    }
    const steps = parseTestFlow(request.body?.flow);
    response.json({
      steps,
      engine: 'steps',
      vision,
      notice: requestedEngine === 'vision'
        ? `视觉模型尚未配置：${vision.missing.join('、') || '缺少模型参数'}。已切换为离线步骤，只支持固定句式。`
        : '离线模式只解析固定句式，不支持条件判断或自由自然语言流程。',
    });
  } catch (error) {
    next(error);
  }
});

api.post('/test-runs', async (request, response, next) => {
  try {
    const run = await createTestRun({
      deviceId: request.body?.deviceId,
      flow: request.body?.flow,
      engine: request.body?.engine,
    });
    response.status(202).json(run);
  } catch (error) {
    next(error);
  }
});

api.get('/archives/status', async (_request, response, next) => {
  try {
    response.set('Cache-Control', 'no-store');
    response.json(await archiveStorageStatus());
  } catch (error) {
    next(error);
  }
});

api.get('/archives/categories', async (request, response, next) => {
  try {
    const query = typeof request.query.q === 'string' ? request.query.q.slice(0, 200) : '';
    const status = typeof request.query.status === 'string' ? request.query.status : '';
    response.set('Cache-Control', 'no-store');
    response.json(await archiveCategoryCatalog({ query, status }));
  } catch (error) {
    next(error);
  }
});

api.get('/archives', async (request, response, next) => {
  try {
    const query = typeof request.query.q === 'string' ? request.query.q.slice(0, 200) : '';
    const category = typeof request.query.category === 'string' ? request.query.category : '';
    const status = typeof request.query.status === 'string' ? request.query.status : '';
    const [records, categories, storage] = await Promise.all([
      listArchivedRuns({ query, category, status, limit: request.query.limit }),
      archiveCategoryCatalog({ query, status }),
      archiveStorageStatus(),
    ]);
    response.set('Cache-Control', 'no-store');
    response.json({ records, categories, storage });
  } catch (error) {
    next(error);
  }
});

api.get('/archives/:runId', async (request, response, next) => {
  try {
    const archived = await getArchivedRun(request.params.runId);
    if (!archived) {
      throw Object.assign(new Error('归档记录不存在或已过期'), {
        statusCode: 404,
        code: 'ARCHIVE_NOT_FOUND',
      });
    }
    response.set('Cache-Control', 'no-store');
    response.json({
      run: { ...archived.run, archiveStorage: archived.storage },
      storage: await archiveStorageStatus(),
    });
  } catch (error) {
    next(error);
  }
});

api.post('/test-runs/:runId/archive', async (request, response, next) => {
  try {
    response.json(await archiveCompletedTestRun(request.params.runId));
  } catch (error) {
    next(error);
  }
});

api.post('/archives/:runId/share', async (request, response, next) => {
  try {
    const share = await shareArchivedRun(request.params.runId);
    response.json({
      ...share,
      url: `${request.protocol}://${request.get('host')}${share.path}`,
    });
  } catch (error) {
    next(error);
  }
});

api.get('/test-runs/:runId', async (request, response, next) => {
  let run = getTestRun(request.params.runId);
  if (!run) {
    const archived = await getArchivedRun(request.params.runId).catch((error) => {
      next(error);
      return undefined;
    });
    run = archived?.run;
  }
  if (!run) {
    throw Object.assign(new Error('测试记录不存在或服务已重启'), {
      statusCode: 404,
      code: 'TEST_RUN_NOT_FOUND',
    });
  }
  response.set('Cache-Control', 'no-store');
  response.json(run);
});

api.get('/test-runs/:runId/assets/:fileName', async (request, response, next) => {
  try {
    const filePath = testRunAssetPath(request.params.runId, request.params.fileName);
    if (!filePath) throw Object.assign(new Error('截图资源名称无效'), { statusCode: 400 });
    const content = await readFile(filePath);
    response.set({
      'Content-Type': assetContentType(request.params.fileName),
      'Content-Length': String(content.length),
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    response.send(content);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      response.status(404).json({ error: '截图尚未生成或已被删除', code: 'TEST_ASSET_NOT_FOUND' });
      return;
    }
    next(error);
  }
});

api.get('/shares/:token', async (request, response, next) => {
  try {
    const run = await getSharedRun(request.params.token);
    if (!run) {
      throw Object.assign(new Error('分享链接不存在或已过期'), {
        statusCode: 404,
        code: 'SHARE_NOT_FOUND',
      });
    }
    response.set('Cache-Control', 'no-store');
    response.json(run);
  } catch (error) {
    next(error);
  }
});

api.get('/shares/:token/assets/:fileName', async (request, response, next) => {
  try {
    const run = await getSharedRun(request.params.token);
    if (!run) {
      throw Object.assign(new Error('分享链接不存在或已过期'), {
        statusCode: 404,
        code: 'SHARE_NOT_FOUND',
      });
    }
    const fileName = request.params.fileName;
    const comparisonAssets = run.comparison
      ? [
          run.comparison.overview?.imageUrl,
          ...(run.comparison.devices || []).map((device) => device.imageUrl),
        ]
      : [];
    if (
      !(run.steps || []).some((step) => step.image?.endsWith(`/${fileName}`)) &&
      !comparisonAssets.some((url) => url?.endsWith(`/${fileName}`))
    ) {
      throw Object.assign(new Error('截图不属于该分享记录'), {
        statusCode: 404,
        code: 'SHARE_ASSET_NOT_FOUND',
      });
    }
    const filePath = testRunAssetPath(run.id, fileName);
    if (!filePath) throw Object.assign(new Error('截图资源名称无效'), { statusCode: 400 });
    const content = await readFile(filePath);
    response.set({
      'Content-Type': assetContentType(fileName),
      'Content-Length': String(content.length),
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    response.send(content);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      response.status(404).json({ error: '分享截图不存在', code: 'SHARE_ASSET_NOT_FOUND' });
      return;
    }
    next(error);
  }
});

  return api;
}

async function findRequiredDevice(id) {
  const result = await findDevice(id);
  if (!result) {
    throw Object.assign(new Error('手机未连接、已断开或尚未授权'), {
      statusCode: 404,
      code: 'DEVICE_NOT_FOUND',
    });
  }
  return result;
}

function insideInputBounds(action, device) {
  const width = device.inputWidth ?? device.width;
  const height = device.inputHeight ?? device.height;
  const points = [];
  if ('x' in action && 'y' in action) points.push([action.x, action.y]);
  if ('fromX' in action && 'toX' in action) {
    points.push([action.fromX, action.fromY], [action.toX, action.toY]);
  }
  return points.every(([x, y]) => x < (width ?? Infinity) && y < (height ?? Infinity));
}

function imageType(buffer) {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  return 'application/octet-stream';
}
