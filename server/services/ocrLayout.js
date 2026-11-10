import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../utils/command.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const defaultOcrExecutable = join(root, '.artifacts/runtime/vision-ocr');
const OCR_CACHE_MS = 350;
const layoutCache = new Map();

/**
 * Android's uiautomator can return a root node without child content while
 * the screen is busy or the app does not expose accessibility nodes. OCR is a
 * safe fallback for finding the same visible text on another phone; OCR nodes
 * are deliberately not treated as scroll containers.
 */
export async function loadOcrLayout(device, adapter, executable = defaultOcrExecutable) {
  if (process.platform !== 'darwin' || !existsSync(executable)) {
    throw new Error('当前系统没有可用的截图文字识别工具');
  }

  const cached = layoutCache.get(device.id);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const promise = loadOcrLayoutUncached(device, adapter, executable).catch((error) => {
    layoutCache.delete(device.id);
    throw error;
  });
  layoutCache.set(device.id, { promise, expiresAt: Date.now() + OCR_CACHE_MS });
  return promise;
}

async function loadOcrLayoutUncached(device, adapter, executable) {
  const frame = await adapter.screenshot();
  return recognizeOcrFrame(device, frame, executable);
}

/** Recognize an already captured frame so saved evidence matches its OCR result. */
export async function recognizeOcrFrame(device, frame, executable = defaultOcrExecutable) {
  if (process.platform !== 'darwin' || !existsSync(executable)) {
    throw new Error('当前系统没有可用的截图文字识别工具');
  }
  const directory = await mkdtemp(join(tmpdir(), 'viewphone-ocr-'));
  const imagePath = join(directory, 'screen.png');
  try {
    await writeFile(imagePath, frame.buffer, { mode: 0o600 });
    const result = await run(executable, [imagePath], { timeoutMs: 20_000 });
    const payload = JSON.parse(String(result.stdout || '{}'));
    return parseOcrLayout(payload, {
      width: device.inputWidth ?? device.width ?? frame.width,
      height: device.inputHeight ?? device.height ?? frame.height,
      imageWidth: frame.width,
      imageHeight: frame.height,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function clearOcrLayoutCache(deviceId) {
  if (deviceId) layoutCache.delete(deviceId);
  else layoutCache.clear();
}

export function parseOcrLayout(payload, screen = {}) {
  const imageWidth = positive(screen.imageWidth) || positive(payload.width);
  const imageHeight = positive(screen.imageHeight) || positive(payload.height);
  const width = positive(screen.width) || imageWidth;
  const height = positive(screen.height) || imageHeight;
  const scaleX = imageWidth > 1 && width > 1 ? width / imageWidth : 1;
  const scaleY = imageHeight > 1 && height > 1 ? height / imageHeight : 1;

  const nodes = [];
  for (const item of Array.isArray(payload.nodes) ? payload.nodes : []) {
    const text = String(item?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
    const bounds = numericBounds(item?.bounds);
    const confidence = Number(item?.confidence);
    if (!text || !bounds || (Number.isFinite(confidence) && confidence < 0.2)) continue;
    nodes.push({
      text,
      label: '',
      hint: '',
      id: '',
      kind: 'OCRText',
      bounds: {
        left: Math.round(bounds.left * scaleX),
        top: Math.round(bounds.top * scaleY),
        right: Math.round(bounds.right * scaleX),
        bottom: Math.round(bounds.bottom * scaleY),
      },
      depth: 0,
      clickable: false,
      scrollable: false,
      enabled: true,
    });
  }
  return { width, height, nodes };
}

export function hasUsefulSemanticNodes(layout) {
  return Boolean(layout?.nodes?.some((node) =>
    [node.text, node.label, node.hint, node.id].some((value) =>
      String(value ?? '').trim().length > 0,
    ),
  ));
}

export async function readMaybeOcrLayout(device, adapter, executable) {
  try {
    return await loadOcrLayout(device, adapter, executable);
  } catch {
    return undefined;
  }
}

function numericBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') return undefined;
  const left = Number(bounds.left);
  const top = Number(bounds.top);
  const right = Number(bounds.right);
  const bottom = Number(bounds.bottom);
  if (![left, top, right, bottom].every(Number.isFinite)) return undefined;
  if (right <= left || bottom <= top) return undefined;
  return { left, top, right, bottom };
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 1 ? number : 0;
}
