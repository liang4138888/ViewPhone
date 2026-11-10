import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import {
  loadLayout,
  mapActionToCoordinates,
  resolveSemanticAction,
} from './semanticSync.js';
import {
  hasUsefulSemanticNodes,
  readMaybeOcrLayout,
} from './ocrLayout.js';
import {
  getVisionModelConfig,
  mapVisionSyncAction,
} from './visionModel.js';

const visualCaptures = new Map();
const CAPTURE_TTL_MS = 30_000;
const MAX_CAPTURES = 24;

export async function captureSyncSource(device, adapter) {
  const frame = await adapter.screenshot();
  const captureId = randomUUID();
  const width = Number(frame.inputWidth ?? device.inputWidth ?? device.width ?? frame.width);
  const height = Number(frame.inputHeight ?? device.inputHeight ?? device.height ?? frame.height);
  const now = Date.now();
  for (const [id, capture] of visualCaptures) {
    if (capture.expiresAt <= now) visualCaptures.delete(id);
  }
  while (visualCaptures.size >= MAX_CAPTURES) {
    visualCaptures.delete(visualCaptures.keys().next().value);
  }
  visualCaptures.set(captureId, {
    sourceId: device.id,
    frame: {
      buffer: frame.buffer,
      width: frame.width,
      height: frame.height,
      inputWidth: width,
      inputHeight: height,
    },
    expiresAt: now + CAPTURE_TTL_MS,
  });
  return {
    captureId,
    expiresAt: new Date(now + CAPTURE_TTL_MS).toISOString(),
  };
}

export function getSyncCapture(captureId, sourceId) {
  const capture = visualCaptures.get(String(captureId || ''));
  if (!capture) {
    throw Object.assign(new Error('视觉同步的前置截图不存在，请重新操作'), {
      statusCode: 409,
      code: 'SYNC_CAPTURE_NOT_FOUND',
    });
  }
  if (capture.expiresAt <= Date.now()) {
    visualCaptures.delete(String(captureId));
    throw Object.assign(new Error('视觉同步的前置截图已过期，请重新操作'), {
      statusCode: 409,
      code: 'SYNC_CAPTURE_EXPIRED',
    });
  }
  if (capture.sourceId !== sourceId) {
    throw Object.assign(new Error('视觉同步截图不属于当前来源手机'), {
      statusCode: 400,
      code: 'SYNC_CAPTURE_SOURCE_MISMATCH',
    });
  }
  return capture;
}

export async function resolveSyncAction(
  source,
  target,
  action,
  adapterSource,
  adapterTarget,
  mode,
  options = {},
) {
  const [sourceSize, targetSize] = await Promise.all([
    resolveInputSize(source, adapterSource),
    resolveInputSize(target, adapterTarget),
  ]);
  if (!(sourceSize.width > 1) || !(sourceSize.height > 1)) {
    throw Object.assign(new Error(`${source.name} 缺少触控尺寸，无法同步`), {
      statusCode: 422,
      code: 'SYNC_SOURCE_SIZE_UNAVAILABLE',
    });
  }
  if (!(targetSize.width > 1) || !(targetSize.height > 1)) {
    throw Object.assign(new Error(`${target.name} 缺少触控尺寸，无法同步`), {
      statusCode: 422,
      code: 'SYNC_TARGET_SIZE_UNAVAILABLE',
    });
  }
  if (mode !== 'semantic') {
    if (mode === 'vision') {
      return resolveVisionAction(
        source,
        target,
        action,
        adapterSource,
        adapterTarget,
        sourceSize,
        targetSize,
        options,
      );
    }
    return {
      action: mapActionToCoordinates(action, sourceSize, targetSize, mode),
      match: 'coordinate',
    };
  }

  // These actions have no spatial mapping to resolve. Reading Android's UI
  // tree can take many seconds on MIUI and must not turn a reliable Home/Back
  // key into an "unmatched" no-op.
  if (action.type === 'key') {
    return { action: { ...action }, match: 'native' };
  }
  if (action.type === 'text' && (!Number.isFinite(action.x) || !Number.isFinite(action.y))) {
    return { action: { ...action }, match: 'native' };
  }

  try {
    const [nativeSourceLayout, nativeTargetLayout] = await Promise.all([
      loadLayout(source, adapterSource).catch(() => undefined),
      loadLayout(target, adapterTarget).catch(() => undefined),
    ]);
    const sourceNeedsOcr = !hasUsefulSemanticNodes(nativeSourceLayout);
    const targetNeedsOcr = !hasUsefulSemanticNodes(nativeTargetLayout);
    const [ocrSourceLayout, ocrTargetLayout] = await Promise.all([
      sourceNeedsOcr ? readMaybeOcrLayout(source, adapterSource) : undefined,
      targetNeedsOcr ? readMaybeOcrLayout(target, adapterTarget) : undefined,
    ]);
    const sourceLayout = sourceNeedsOcr ? ocrSourceLayout : nativeSourceLayout;
    const targetLayout = targetNeedsOcr ? ocrTargetLayout : nativeTargetLayout;
    if (sourceLayout?.nodes?.length && !targetLayout?.nodes?.length) {
      const visualFallback = resolveVisualPageAction(
        action,
        sourceLayout,
        await readMaybeOcrLayout(target, adapterTarget),
        targetSize,
      );
      if (visualFallback) return visualFallback;
    }
    if (!sourceLayout?.nodes?.length || !targetLayout?.nodes?.length) {
      const missing = [
        !sourceLayout?.nodes?.length ? `${source.name} 来源` : '',
        !targetLayout?.nodes?.length ? `${target.name} 目标` : '',
      ].filter(Boolean).join('、');
      throw new Error(`${missing || '手机'}界面控件读取失败，截图文字识别也未找到可用文字`);
    }
    let result = resolveSemanticAction(action, sourceLayout, targetLayout);
    if (result.match === 'unmatched' && action.type !== 'key') {
      // Some Android WebViews expose only their page container in uiautomator.
      // Treating that full-page node as a control maps a button gesture to an
      // arbitrary point and reports a false success. Prefer visible text that
      // has a real bounds before declaring that the action cannot be matched.
      const [ocrSourceLayout, ocrTargetLayout] = await Promise.all([
        readMaybeOcrLayout(source, adapterSource),
        readMaybeOcrLayout(target, adapterTarget),
      ]);
      const visualFallback = resolveVisualPageAction(
        action,
        ocrSourceLayout,
        ocrTargetLayout,
        targetSize,
      );
      if (visualFallback) result = visualFallback;
    }
    return {
      ...result,
      action: clampToTarget(result.action, targetSize),
    };
  } catch (error) {
    // A slow native tree on the target must not prevent OCR from finding the
    // same visible label. This is especially important for a first click after
    // the target has just changed screens.
    if (action.type !== 'key') {
      const [sourceLayout, targetLayout] = await Promise.all([
        readMaybeOcrLayout(source, adapterSource),
        readMaybeOcrLayout(target, adapterTarget),
      ]);
      const visualFallback = resolveVisualPageAction(
        action,
        sourceLayout,
        targetLayout,
        targetSize,
      );
      if (visualFallback) return visualFallback;
    }
    return {
      action: { ...action },
      match: 'unmatched',
      reason: `无法匹配界面控件，未执行操作：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function resolveVisionAction(
  source,
  target,
  action,
  adapterSource,
  adapterTarget,
  sourceSize,
  targetSize,
  options,
) {
  if (action.type === 'key') return { action: { ...action }, match: 'native' };
  if (action.type === 'text' && (!Number.isFinite(action.x) || !Number.isFinite(action.y))) {
    return { action: { ...action }, match: 'native' };
  }

  const modelConfig = options.visionConfig || getVisionModelConfig();
  const config = {
    ...modelConfig,
    timeoutMs: Math.min(modelConfig.timeoutMs, options.timeoutMs || 60_000),
  };
  if (!config.configured) {
    return {
      action: { ...action },
      match: 'unmatched',
      reason: `视觉同步尚未配置：${config.missing.join('、') || '缺少模型参数'}`,
    };
  }

  let sourceFrame = options.sourceFrame;
  let targetFrame = options.targetFrame;
  let temporaryDirectory;
  try {
    if (!sourceFrame || !targetFrame) {
      [sourceFrame, targetFrame] = await Promise.all([
        sourceFrame ? Promise.resolve(sourceFrame) : adapterSource.screenshot(),
        targetFrame ? Promise.resolve(targetFrame) : adapterTarget.screenshot(),
      ]);
    }
    temporaryDirectory = targetFrame?.temporaryDirectory;
    const mapped = await mapVisionSyncAction({
      action,
      sourceSize,
      targetSize,
      sourceFrame,
      targetFrame,
      config,
    });
    if (!mapped.matched) {
      return {
        action: { ...action },
        match: 'unmatched',
        reason: `${target.name}：${mapped.reason}`,
      };
    }
    return {
      action: clampToTarget(mapped.action, targetSize),
      match: 'vision',
      reason: `${target.name}：${mapped.reason}`,
    };
  } catch (error) {
    return {
      action: { ...action },
      match: 'unmatched',
      reason: `${target.name}：视觉识别失败，未执行操作：${errorMessage(error)}`,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

function resolveVisualPageAction(action, sourceLayout, targetLayout, targetSize) {
  if (!sourceLayout?.nodes?.length || !targetLayout?.nodes?.length) return undefined;
  const result = resolveSemanticAction(action, sourceLayout, targetLayout);
  if (result.match === 'unmatched') return undefined;
  return {
    ...result,
    action: clampToTarget(result.action, targetSize),
  };
}

export async function executeSyncAction(
  source,
  target,
  action,
  adapterSource,
  adapterTarget,
  mode,
  options = {},
) {
  const result = await resolveSyncAction(
    source,
    target,
    action,
    adapterSource,
    adapterTarget,
    mode,
    options,
  );
  if (result.match === 'unmatched') return { ...result, executed: false };

  await adapterTarget.prepareForInput?.();
  await adapterTarget.perform(result.action);
  return { ...result, executed: true };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function resolveInputSize(device, adapter) {
  if (typeof adapter.ensureInputSize === 'function') {
    const ensured = await adapter.ensureInputSize();
    if (ensured?.width > 1 && ensured?.height > 1) return ensured;
  }
  const current = inputSize(device);
  if (current.width > 1 && current.height > 1) return current;
  return inputSize(adapter.device ?? device);
}

function inputSize(device) {
  return {
    width: device.inputWidth ?? device.width,
    height: device.inputHeight ?? device.height,
  };
}

function clampToTarget(action, size) {
  if (!(size.width > 1) || !(size.height > 1)) return action;
  const point = (x, y) => ({
    x: Math.min(size.width - 1, Math.max(0, Math.round(x))),
    y: Math.min(size.height - 1, Math.max(0, Math.round(y))),
  });
  if (action.type === 'tap' || action.type === 'longPress') {
    return { ...action, ...point(action.x, action.y) };
  }
  if (action.type === 'swipe') {
    const from = point(action.fromX, action.fromY);
    const to = point(action.toX, action.toY);
    return { ...action, fromX: from.x, fromY: from.y, toX: to.x, toY: to.y };
  }
  if (action.type === 'text' && Number.isFinite(action.x) && Number.isFinite(action.y)) {
    return { ...action, ...point(action.x, action.y) };
  }
  return action;
}
