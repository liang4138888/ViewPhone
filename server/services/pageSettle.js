import { compareImages } from './imageDiff.js';

const LOADING_TERMS = /^(?:正在)?(?:加载中|正在加载|载入中|请稍候|请稍等|处理中|提交中|刷新中)(?:\.{0,3}|…)?$|^(?:loading|please\s+wait)(?:\.{0,3}|…)?$/i;
const LOADING_NODE = /progressbar|activityindicator|loading|skeleton|shimmer/i;

export function pageSettleLabel(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/** Ignore status-bar noise while retaining page loading indicators. */
export function visiblePageLabels(layout) {
  const width = Number(layout?.width);
  const height = Number(layout?.height);
  return (layout?.nodes || []).map((node) => {
    const label = pageSettleLabel(node?.text || node?.label || node?.hint || node?.id);
    return { label, bounds: node?.bounds };
  }).filter(({ label, bounds }) => {
    if (!label) return false;
    if (!bounds || !(width > 1 && height > 1)) return true;
    const area = Math.max(0, bounds.right - bounds.left) * Math.max(0, bounds.bottom - bounds.top);
    const inStatusBar = bounds.bottom < height * 0.06;
    return !inStatusBar && area < width * height * 0.85;
  }).map(({ label }) => label);
}

export function hasPageLoadingSignal(layout) {
  if (visiblePageLabels(layout).some((label) => LOADING_TERMS.test(label))) {
    return true;
  }
  return (layout?.nodes || []).some((node) =>
    LOADING_NODE.test(`${node?.kind || ''} ${node?.id || ''}`) &&
    (!node?.bounds || node.bounds.bottom > Number(layout?.height || 0) * 0.06),
  );
}

export function pageContentProfile(layout) {
  const labels = visiblePageLabels(layout).filter((label) => label.length >= 2);
  const actionable = (layout?.nodes || []).filter((node) =>
    node?.enabled && node?.bounds && (node.clickable || node.scrollable || node.editable) &&
    (!layout?.height || node.bounds.bottom > Number(layout.height) * 0.06),
  ).length;
  return { labels: labels.length, actionable };
}

/** Sparse screens are held for a longer loading window to reject textless skeletons. */
export function hasSubstantialPageContent(layout) {
  const { labels, actionable } = pageContentProfile(layout);
  return labels >= 4 || actionable >= 2;
}

/** A status bar or top-icon-only frame is not enough to hand to vision. */
export function hasPageContent(layout) {
  const { labels, actionable } = pageContentProfile(layout);
  return labels >= 3 || actionable > 0;
}

export function pageLabelsChanged(previous, next) {
  const a = visiblePageLabels(previous);
  const b = visiblePageLabels(next);
  if (a.length !== b.length) return true;
  const counts = new Map();
  for (const label of a) counts.set(label, (counts.get(label) || 0) + 1);
  for (const label of b) {
    const count = counts.get(label) || 0;
    if (!count) return true;
    if (count === 1) counts.delete(label);
    else counts.set(label, count - 1);
  }
  return counts.size > 0;
}

export function frameChanged(diff) {
  const ratio = Number(diff?.changedRatio);
  const delta = Number(diff?.averageDelta);
  return !Number.isFinite(ratio) || !Number.isFinite(delta) || ratio > 0.0015 || delta > 0.002;
}

/**
 * Make the inspection that passed the stability checks the screenshot saved
 * for evidence. Taking another screenshot here can capture a new transition
 * frame and makes a transient page the input to the next visual-model step.
 */
export async function publishSettledFrame({ settle, publish }) {
  const result = await settle();
  if (!result?.inspection) {
    throw new Error('页面稳定检测没有返回可用的截图');
  }
  const inspection = await publish(result.inspection);
  return { ...result, inspection };
}

/**
 * Wait for the real post-action screen. Loading indicators must disappear and
 * two observations must agree. Unchanged pages get a short transition grace
 * period instead of becoming a screenshot immediately.
 */
export async function waitForPageSettled({
  capture,
  before,
  expectChange = true,
  minimumWaitMs = 700,
  intervalMs = 400,
  transitionGraceMs = 2_200,
  // Skeleton pages often expose only the fixed header and a button. Give a
  // content-poor transition enough time for delayed app requests to finish.
  sparseContentGraceMs = 6_000,
  timeoutMs = 20_000,
  compare = compareImages,
  onObservation = () => {},
}) {
  const startedAt = Date.now();
  const maximum = Math.max(minimumWaitMs + intervalMs, Number(timeoutMs) || 20_000);
  await waitUntil(startedAt + minimumWaitMs);

  let previous;
  let changedFromBefore = false;
  let attempts = 0;
  while (Date.now() - startedAt < maximum) {
    attempts += 1;
    const inspection = await capture(attempts);
    const loading = hasPageLoadingSignal(inspection.layout);
    const visual = previous && await compareFrames(previous, inspection, compare);
    const contentReady = hasPageContent(inspection.layout);
    const contentMature = hasSubstantialPageContent(inspection.layout) ||
      Date.now() - startedAt >= sparseContentGraceMs;
    const stableWithPrevious = Boolean(
      previous && !loading && contentReady && !frameChanged(visual),
    );
    const graceElapsed = Date.now() - startedAt >= transitionGraceMs;
    onObservation({
      attempt: attempts,
      inspection,
      loading,
      contentReady,
      stable: stableWithPrevious,
      graceElapsed,
    });
    if (stableWithPrevious && contentMature &&
      (changedFromBefore || !expectChange || graceElapsed)) {
      return { inspection, attempts, waitedMs: Date.now() - startedAt, changed: changedFromBefore, settled: true };
    }
    if (previous && (
      pageLabelsChanged(previous.layout, inspection.layout) || frameChanged(visual)
    )) {
      changedFromBefore = true;
    }
    if (!previous && before?.layout && inspection.layout) {
      changedFromBefore = pageLabelsChanged(before.layout, inspection.layout)
        || frameChanged(await compareFrames(before, inspection, compare));
    }
    previous = inspection;
    await waitUntil(Math.min(Date.now() + intervalMs, startedAt + maximum));
  }
  return {
    inspection: previous,
    attempts,
    waitedMs: Date.now() - startedAt,
    changed: changedFromBefore,
    settled: false,
    timedOut: true,
  };
}

async function compareFrames(first, second, compare) {
  if (!first?.path || !second?.path) return undefined;
  return compare(first.path, second.path).catch(() => undefined);
}

async function waitUntil(deadline) {
  const remaining = deadline - Date.now();
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}
