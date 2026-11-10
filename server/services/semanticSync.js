import { pointInBounds } from './uiLayout.js';

const layoutCache = new Map();
const LAYOUT_CACHE_MS = 250;
const MAX_LAYOUTS = 12;

/**
 * Resolve one source gesture against the same UI element on a target phone.
 * Return `unmatched` when there is no safe identity match. This is intentional:
 * a coordinate fallback on a differently sized layout can tap unrelated UI.
 */
export function resolveSemanticAction(action, sourceLayout, targetLayout) {
  if (action.type === 'key') return { action: { ...action }, match: 'native' };
  if (!hasSpatialCoordinates(action)) return { action: { ...action }, match: 'native' };
  if (!sourceLayout?.nodes?.length || !targetLayout?.nodes?.length) {
    return {
      action: { ...action },
      match: 'unmatched',
      reason: '无法读取来源或目标手机的界面控件，未执行操作',
    };
  }

  const mapped = matchSpatialAction(action, sourceLayout, targetLayout);
  if (mapped) return { action: mapped, match: 'semantic' };
  return {
    action: { ...action },
    match: 'unmatched',
    reason: '未在目标手机找到对应控件或滚动区域，未执行坐标兜底操作',
  };
}

/** Also used by the server for relative and raw-pixel fallback requests. */
export function mapActionToCoordinates(action, source, target, mode = 'relative') {
  const sourceWidth = Number(source?.width);
  const sourceHeight = Number(source?.height);
  const targetWidth = Number(target?.width);
  const targetHeight = Number(target?.height);
  if (!validSize(sourceWidth, sourceHeight) || !validSize(targetWidth, targetHeight)) {
    throw new RangeError('同步画面尺寸无效，无法换算坐标');
  }
  const point = (x, y) => ({
    x: clamp(
      mode === 'pixel' ? x : Math.round((x / sourceWidth) * targetWidth),
      0,
      targetWidth - 1,
    ),
    y: clamp(
      mode === 'pixel' ? y : Math.round((y / sourceHeight) * targetHeight),
      0,
      targetHeight - 1,
    ),
  });
  if (action.type === 'tap') return { ...action, ...point(action.x, action.y) };
  if (action.type === 'longPress') return { ...action, ...point(action.x, action.y) };
  if (action.type === 'swipe') {
    const from = point(action.fromX, action.fromY);
    const to = point(action.toX, action.toY);
    return { ...action, fromX: from.x, fromY: from.y, toX: to.x, toY: to.y };
  }
  if (action.type === 'text' && Number.isFinite(action.x) && Number.isFinite(action.y)) {
    return { ...action, ...point(action.x, action.y) };
  }
  return { ...action };
}

export async function loadLayout(device, adapter) {
  const now = Date.now();
  const cached = layoutCache.get(device.id);
  if (cached && cached.expiresAt > now) return cached.promise;
  const promise = Promise.resolve(adapter.layout()).catch((error) => {
    // Do not cache a transient uiautomator/dumpLayout failure.
    layoutCache.delete(device.id);
    throw error;
  });
  layoutCache.set(device.id, { promise, expiresAt: now + LAYOUT_CACHE_MS });
  if (layoutCache.size > MAX_LAYOUTS) {
    const oldest = [...layoutCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0]?.[0];
    if (oldest) layoutCache.delete(oldest);
  }
  return promise;
}

export function clearLayoutCache(deviceId) {
  if (deviceId) layoutCache.delete(deviceId);
  else layoutCache.clear();
}

function matchSpatialAction(action, source, target) {
  if (action.type === 'swipe') {
    // A page scroll has no stable identity at its exact start and end points.
    // Map the gesture inside the corresponding scrollable container instead.
    const containerGesture = matchScrollGesture(action, source, target);
    if (containerGesture) return containerGesture;
    const visualGesture = matchVisualAnchorGesture(action, source, target, true);
    if (visualGesture) return visualGesture;

    const start = findElementMatch({ x: action.fromX, y: action.fromY }, source, target);
    const end = findElementMatch({ x: action.toX, y: action.toY }, source, target);
    if (!start || !end) return undefined;
    const from = pointInsideMatchingNode({ x: action.fromX, y: action.fromY }, start.source, start.target);
    const to = pointInsideMatchingNode({ x: action.toX, y: action.toY }, end.source, end.target);
    return { ...action, fromX: from.x, fromY: from.y, toX: to.x, toY: to.y };
  }
  if (action.type === 'text' && (!Number.isFinite(action.x) || !Number.isFinite(action.y))) {
    return undefined;
  }
  const point = { x: action.x, y: action.y };
  const match = findElementMatch(point, source, target);
  if (match) {
    const mapped = pointInsideMatchingNode(point, match.source, match.target);
    return { ...action, ...mapped };
  }
  // Text recognition has no scroll-container metadata. If several visible
  // labels agree on one affine transform, the page itself is aligned and a
  // spatial gesture can be mapped without assuming equal raw coordinates.
  return matchVisualAnchorGesture(action, source, target);
}

function matchVisualAnchorGesture(action, source, target, requiresDistinctAnchors = false) {
  const transform = detectVisualAnchorTransform(source, target);
  if (!transform) return undefined;
  const required = requiresDistinctAnchors ? 4 : 3;
  if (transform.count < required) return undefined;
  if (action.type === 'swipe') {
    const from = applyTransform({ x: action.fromX, y: action.fromY }, transform);
    const to = applyTransform({ x: action.toX, y: action.toY }, transform);
    return { ...action, fromX: from.x, fromY: from.y, toX: to.x, toY: to.y };
  }
  if (!Number.isFinite(action.x) || !Number.isFinite(action.y)) return undefined;
  return { ...action, ...applyTransform({ x: action.x, y: action.y }, transform) };
}

/**
 * Match only unique OCR/accessibility labels. A handful of labels spread over
 * the screen is enough to fit scale and translation; repeated row labels are
 * excluded so one wrong pairing cannot move the entire gesture.
 */
function detectVisualAnchorTransform(source, target) {
  const sourceGroups = visualTextGroups(source);
  const targetGroups = visualTextGroups(target);
  const pairs = [];
  for (const [text, sourceNodes] of sourceGroups) {
    if (sourceNodes.length !== 1) continue;
    const targetNodes = targetGroups.get(text);
    if (targetNodes?.length !== 1) continue;
    pairs.push({
      source: center(sourceNodes[0].bounds),
      target: center(targetNodes[0].bounds),
      sourceBounds: sourceNodes[0].bounds,
      targetBounds: targetNodes[0].bounds,
    });
  }
  if (pairs.length < 3) return undefined;

  const fitX = fitAxis(pairs, 'x');
  const fitY = fitAxis(pairs, 'y');
  if (!fitX || !fitY) return undefined;
  if (fitX.scale < 0.3 || fitX.scale > 3 || fitY.scale < 0.3 || fitY.scale > 3) return undefined;
  if (fitX.spread < source.width * 0.18 || fitY.spread < source.height * 0.18) return undefined;

  const transform = {
    xScale: fitX.scale,
    xOffset: fitX.offset,
    yScale: fitY.scale,
    yOffset: fitY.offset,
    count: pairs.length,
  };
  const residuals = pairs.map((pair) => {
    const mapped = applyTransform(pair.source, transform);
    return {
      x: Math.abs(mapped.x - pair.target.x),
      y: Math.abs(mapped.y - pair.target.y),
    };
  });
  const medianX = median(residuals.map((item) => item.x));
  const medianY = median(residuals.map((item) => item.y));
  const maxX = Math.max(...residuals.map((item) => item.x));
  const maxY = Math.max(...residuals.map((item) => item.y));
  if (
    medianX > source.width * 0.022 ||
    medianY > source.height * 0.022 ||
    maxX > source.width * 0.09 ||
    maxY > source.height * 0.09
  ) {
    return undefined;
  }

  // A second-screen ad or status bar can produce a spurious unique label.
  // Reject transforms whose residual pattern suggests two unrelated pages.
  const inliers = residuals.filter(
    (item) => item.x <= source.width * 0.09 && item.y <= source.height * 0.09,
  ).length;
  if (inliers / residuals.length < 0.7) return undefined;
  return transform;
}

function visualTextGroups(layout) {
  const groups = new Map();
  for (const node of layout?.nodes || []) {
    const text = normalize(node.text) || normalize(node.label);
    if (!text || text.length < 2) continue;
    const list = groups.get(text) || [];
    list.push(node);
    groups.set(text, list);
  }
  return groups;
}

function fitAxis(pairs, axis) {
  const values = pairs.map((pair) => ({
    x: pair.source[axis],
    y: pair.target[axis],
  }));
  const meanX = values.reduce((sum, value) => sum + value.x, 0) / values.length;
  const meanY = values.reduce((sum, value) => sum + value.y, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value.x - meanX) ** 2, 0);
  if (variance < 1) return undefined;
  const covariance = values.reduce(
    (sum, value) => sum + (value.x - meanX) * (value.y - meanY),
    0,
  );
  const scale = covariance / variance;
  const offset = meanY - scale * meanX;
  const spread = Math.max(...values.map((value) => value.x)) -
    Math.min(...values.map((value) => value.x));
  return { scale, offset, spread };
}

function applyTransform(point, transform) {
  return {
    x: Math.round(transform.xScale * point.x + transform.xOffset),
    y: Math.round(transform.yScale * point.y + transform.yOffset),
  };
}

function median(values) {
  if (!values.length) return Infinity;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function matchScrollGesture(action, source, target) {
  const vertical = Math.abs(action.toY - action.fromY) >= Math.abs(action.toX - action.fromX);
  const sourceContainer = scrollContainerAt(source, { x: action.fromX, y: action.fromY }, vertical);
  if (!sourceContainer) return undefined;

  const start = findElementMatch({ x: action.fromX, y: action.fromY }, source, target);
  const end = findElementMatch({ x: action.toX, y: action.toY }, source, target);
  const endpointAnchor = [start, end].find((match) => {
    if (!match) return false;
    const point = center(match.target.bounds);
    return Boolean(scrollContainerAt(target, point, vertical));
  });

  let targetContainer;
  if (endpointAnchor) {
    targetContainer = scrollContainerAt(target, center(endpointAnchor.target.bounds), vertical);
  } else {
    targetContainer = findScrollContainerWithAnchor(action, source, target, vertical, sourceContainer);
  }
  if (!targetContainer) return undefined;

  const from = pointInsideMatchingNode(
    { x: action.fromX, y: action.fromY },
    sourceContainer,
    targetContainer,
  );
  const to = pointInsideMatchingNode(
    { x: action.toX, y: action.toY },
    sourceContainer,
    targetContainer,
  );
  return { ...action, fromX: from.x, fromY: from.y, toX: to.x, toY: to.y };
}

function findScrollContainerWithAnchor(action, source, target, vertical, sourceContainer) {
  const targetContainers = target.nodes
    .filter((node) => isScrollContainer(node, vertical))
    .sort((a, b) => area(b.bounds) - area(a.bounds))
    .slice(0, 8);
  if (targetContainers.length === 0) return undefined;

  const gestureBounds = {
    left: Math.min(action.fromX, action.toX),
    top: Math.min(action.fromY, action.toY),
    right: Math.max(action.fromX, action.toX),
    bottom: Math.max(action.fromY, action.toY),
  };
  const sourceNodes = source.nodes
    .filter((node) => identity(node) && intersects(node.bounds, gestureBounds) && pointInBounds(center(node.bounds), sourceContainer.bounds))
    .sort((a, b) => identityStrength(b) - identityStrength(a) || area(a.bounds) - area(b.bounds))
    .slice(0, 80);
  const targetNodes = target.nodes.filter((node) => identity(node));

  let best;
  for (const sourceNode of sourceNodes) {
    for (const targetNode of targetNodes) {
      const targetContainer = targetContainers.find((container) =>
        pointInBounds(center(targetNode.bounds), container.bounds),
      );
      if (!targetContainer) continue;
      const score = identityScore(sourceNode, targetNode);
      if (score < 75) continue;
      if (!best || score > best.score) {
        best = { score, targetContainer };
        if (score >= 100) return targetContainer;
      }
    }
  }
  return best?.targetContainer;
}

function scrollContainerAt(layout, point, vertical) {
  return layout.nodes
    .filter((node) => isScrollContainer(node, vertical) && pointInBounds(point, node.bounds))
    .sort((a, b) => area(a.bounds) - area(b.bounds) || b.depth - a.depth)[0];
}

function isScrollContainer(node, vertical) {
  if (!node.scrollable) return false;
  const nodeWidth = width(node.bounds);
  const nodeHeight = height(node.bounds);
  return vertical ? nodeHeight >= nodeWidth * 1.15 : nodeWidth >= nodeHeight * 1.15;
}

function identityStrength(node) {
  if (normalizeId(node.id)) return 4;
  if (normalize(node.text)) return 3;
  if (normalize(node.label)) return 2;
  return 1;
}

export function findElementMatch(point, source, target) {
  const sourceNode = bestNodeAt(source, point);
  if (!sourceNode || !isActionableIdentity(sourceNode, source)) return undefined;
  const candidates = target.nodes
    .filter((node) => node.bounds.right > node.bounds.left && node.bounds.bottom > node.bounds.top)
    .filter((node) => isActionableIdentity(node, target))
    .map((node) => ({ node, score: identityScore(sourceNode, node) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || area(a.node) - area(b.node));
  if (candidates.length === 0) return undefined;
  const sourceCenter = center(sourceNode.bounds);
  const targetBest = candidates[0].score;
  const best = candidates
    // A weaker generic label such as "确定" must never steal a stable text or
    // accessibility-id match. Kind/clickability bonuses are smaller than this.
    .filter((candidate) => candidate.score >= targetBest - 4)
    .sort((a, b) => {
      const aDistance = normalizedDistance(sourceCenter, source, center(a.node.bounds), target);
      const bDistance = normalizedDistance(sourceCenter, source, center(b.node.bounds), target);
      return aDistance - bDistance || area(a.node) - area(b.node);
    })[0];
  return best ? { source: sourceNode, target: best.node } : undefined;
}

function bestNodeAt(layout, point) {
  const contained = layout.nodes.filter((node) => pointInBounds(point, node.bounds));
  if (contained.length === 0) return undefined;
  return contained
    .sort((a, b) => {
      const aMeaningful = isActionableIdentity(a, layout) ? 1 : 0;
      const bMeaningful = isActionableIdentity(b, layout) ? 1 : 0;
      return bMeaningful - aMeaningful || area(a) - area(b) || b.depth - a.depth;
    })[0];
}

function identity(node) {
  return normalize(node.text) || normalize(node.label) || normalizeId(node.id) || normalize(node.hint);
}

function isActionableIdentity(node, layout) {
  if (!identity(node)) return false;
  // A WebView/ScrollView page title is not a tap target. It can span almost
  // the whole display while the actual button is missing from the native
  // accessibility tree. Let OCR resolve the click instead of tapping an
  // arbitrary percentage point inside this container.
  const nodeArea = area(node.bounds);
  const layoutArea = Math.max(1, Number(layout.width) * Number(layout.height));
  const fullPageContainer =
    nodeArea >= layoutArea * 0.55 &&
    !node.clickable &&
    (node.scrollable || /WebView|Scroll|List|Recycler|ViewGroup|FrameLayout|Layout/i.test(node.kind || ''));
  return !fullPageContainer;
}

function identityScore(source, target) {
  const sourceText = normalize(source.text);
  const targetText = normalize(target.text);
  const sourceLabel = normalize(source.label);
  const targetLabel = normalize(target.label);
  const sourceId = normalizeId(source.id);
  const targetId = normalizeId(target.id);
  const sourceHint = normalize(source.hint);
  const targetHint = normalize(target.hint);
  let score = 0;
  if (sourceId && sourceId === targetId) score += 100;
  if (sourceText && sourceText === targetText) score += 90;
  if (sourceLabel && sourceLabel === targetLabel) score += 90;
  if (sourceText && sourceText === targetLabel) score += 75;
  if (sourceLabel && sourceLabel === targetText) score += 75;
  if (sourceHint && sourceHint === targetHint) score += 60;
  if (score === 0 && sourceText.length >= 3 && targetText.length >= 3) {
    if (targetText.includes(sourceText) || sourceText.includes(targetText)) score += 24;
  }
  if (score === 0 && sourceText.length >= 3 && targetLabel.length >= 3) {
    if (targetLabel.includes(sourceText) || sourceText.includes(targetLabel)) score += 20;
  }
  if (score > 0 && source.kind && target.kind && source.kind === target.kind) score += 3;
  if (score > 0 && source.clickable === target.clickable) score += 2;
  return score;
}

function pointInsideMatchingNode(point, sourceNode, targetNode) {
  const sourceBounds = sourceNode.bounds;
  const targetBounds = targetNode.bounds;
  const ratioX = clamp((point.x - sourceBounds.left) / Math.max(1, width(sourceBounds)), 0, 1);
  const ratioY = clamp((point.y - sourceBounds.top) / Math.max(1, height(sourceBounds)), 0, 1);
  return {
    x: clamp(Math.round(targetBounds.left + ratioX * width(targetBounds)), 0, Number.MAX_SAFE_INTEGER),
    y: clamp(Math.round(targetBounds.top + ratioY * height(targetBounds)), 0, Number.MAX_SAFE_INTEGER),
  };
}

function hasSpatialCoordinates(action) {
  if (action.type === 'tap' || action.type === 'longPress') return Number.isFinite(action.x) && Number.isFinite(action.y);
  if (action.type === 'swipe') return [action.fromX, action.fromY, action.toX, action.toY].every(Number.isFinite);
  if (action.type === 'text') return Number.isFinite(action.x) && Number.isFinite(action.y);
  return false;
}

function normalizedDistance(a, aLayout, b, bLayout) {
  const ax = a.x / Math.max(1, aLayout.width);
  const ay = a.y / Math.max(1, aLayout.height);
  const bx = b.x / Math.max(1, bLayout.width);
  const by = b.y / Math.max(1, bLayout.height);
  return Math.hypot(ax - bx, ay - by);
}

function center(bounds) {
  return { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 };
}

function intersects(a, b) {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

function area(bounds) {
  return Math.max(0, bounds.right - bounds.left) * Math.max(0, bounds.bottom - bounds.top);
}

function width(bounds) {
  return bounds.right - bounds.left;
}

function height(bounds) {
  return bounds.bottom - bounds.top;
}

function validSize(width, height) {
  return Number.isFinite(width) && width > 1 && Number.isFinite(height) && height > 1;
}

function normalize(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\uE000-\uF8FF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase();
}

function normalizeId(value) {
  return normalize(value).replace(/^[^/]+\/id\//, '').replace(/^[^:]+:id\//, '');
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
