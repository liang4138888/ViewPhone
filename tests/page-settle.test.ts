import assert from 'node:assert/strict';
import test from 'node:test';
import {
  frameChanged,
  hasPageContent,
  hasPageLoadingSignal,
  hasSubstantialPageContent,
  pageLabelsChanged,
  publishSettledFrame,
  waitForPageSettled,
} from '../server/services/pageSettle.js';

const screen = { width: 1080, height: 2340 };

test('loading labels are detected without mistaking ordinary content for loading', () => {
  assert.equal(hasPageLoadingSignal(layout(screen, ['正在加载...', '返回'])), true);
  assert.equal(hasPageLoadingSignal(layout(screen, ['Please wait', 'Back'])), true);
  assert.equal(hasPageLoadingSignal(layout(screen, ['商品详情', '加入购物车', '¥10/盒'])), false);
});

test('a status-bar-only frame is not treated as page content', () => {
  const statusOnly = layout(screen, ['14:41', '100'], undefined, 50);
  assert.equal(hasPageContent(statusOnly), false);
  assert.equal(hasPageContent(layout(screen, ['商品详情', '加入购物车', '¥10/盒'])), true);
});

test('a sparse skeleton is not considered fully loaded content', () => {
  const skeleton = layout(screen, ['加载时序验收', '商品详情加载测试', '打开商品详情']);
  const loaded = layout(screen, ['加载时序验收', '商品详情', '澳牛进口纯牛奶', '¥10/盒', '加入购物车']);
  assert.equal(hasPageContent(skeleton), true);
  assert.equal(hasSubstantialPageContent(skeleton), false);
  assert.equal(hasSubstantialPageContent(loaded), true);
});

test('unchanged frames are identical while changed content is distinguishable', () => {
  const first = layout(screen, ['商品详情', '加入购物车', '¥10/盒']);
  assert.equal(pageLabelsChanged(first, first), false);
  assert.equal(pageLabelsChanged(first, layout(screen, ['商品详情', '立即购买', '¥10/盒'])), true);
  assert.equal(frameChanged({ changedRatio: 0, averageDelta: 0 }), false);
  assert.equal(frameChanged({ changedRatio: 0.2, averageDelta: 0.1 }), true);
});

test('skeleton frames remain loading until later content becomes stable', async () => {
  const observations = [
    layout(screen, ['正在加载...']),
    layout(screen, ['正在加载...']),
    layout(screen, ['商品详情', '加入购物车', '¥10/盒']),
    layout(screen, ['商品详情', '加入购物车', '¥10/盒']),
  ];
  let index = 0;
  const result = await waitForPageSettled({
    capture: async () => ({ path: `screenshot-${index}.png`, layout: observations[index++] }),
    minimumWaitMs: 0,
    intervalMs: 0,
    transitionGraceMs: 10,
    sparseContentGraceMs: 0,
    timeoutMs: 1_000,
    compare: async (first, second) => {
      const firstIndex = Number(first.match(/(\d+)\.png$/)?.[1]);
      const secondIndex = Number(second.match(/(\d+)\.png$/)?.[1]);
      const sameContent = firstIndex >= 2 && secondIndex >= 2;
      return {
        changedRatio: sameContent ? 0 : 0.2,
        averageDelta: sameContent ? 0 : 0.1,
      };
    },
  });
  assert.equal(result.settled, true);
  assert.equal(result.inspection.layout.nodes[1].text, '加入购物车');
  assert.equal(index, 4);
});

test('a static status-bar-only skeleton is not accepted as page content', async () => {
  const skeleton = layout(screen, ['14:41', '100'], undefined, 50);
  const loaded = layout(screen, ['商品详情', '澳牛进口纯牛奶', '加入购物车']);
  const observations = [skeleton, skeleton, loaded, loaded];
  let index = 0;
  const result = await waitForPageSettled({
    capture: async () => ({ path: `skeleton-${index}.png`, layout: observations[index++] }),
    minimumWaitMs: 0,
    intervalMs: 0,
    transitionGraceMs: 10,
    sparseContentGraceMs: 0,
    timeoutMs: 1_000,
    compare: async (first, second) => {
      const firstIndex = Number(first.match(/(\d+)\.png$/)?.[1]);
      const secondIndex = Number(second.match(/(\d+)\.png$/)?.[1]);
      const sameContent = firstIndex >= 2 && secondIndex >= 2;
      return {
        changedRatio: sameContent ? 0 : 0.2,
        averageDelta: sameContent ? 0 : 0.1,
      };
    },
  });
  assert.equal(result.settled, true);
  assert.equal(result.inspection.layout.nodes[2].text, '加入购物车');
  assert.equal(index, 4);
});

test('a stable textless skeleton is held until the sparse-content grace period', async () => {
  const skeleton = layout(screen, ['加载时序验收', '商品详情加载测试', '打开商品详情']);
  const loaded = layout(screen, ['加载时序验收', '商品详情', '澳牛进口纯牛奶', '¥10/盒', '加入购物车']);
  const startedAt = Date.now();
  const result = await waitForPageSettled({
    capture: async () => ({
      path: `sparse-${Date.now()}.png`,
      layout: Date.now() - startedAt < 80 ? skeleton : loaded,
    }),
    minimumWaitMs: 0,
    intervalMs: 10,
    transitionGraceMs: 0,
    sparseContentGraceMs: 120,
    timeoutMs: 1_000,
    compare: async () => ({ changedRatio: 0, averageDelta: 0 }),
  });
  assert.equal(result.settled, true);
  assert.equal(result.inspection.layout.nodes[2].text, '澳牛进口纯牛奶');
});

test('the settled frame is published without taking another screenshot', async () => {
  const stableFrame = {
    path: 'settled-frame.png',
    layout: layout(screen, ['商品详情', '澳牛进口纯牛奶', '加入购物车']),
  };
  let settleCalls = 0;
  let publishCalls = 0;
  let publishedFrame;
  const result = await publishSettledFrame({
    settle: async () => {
      settleCalls += 1;
      return { inspection: stableFrame, settled: true };
    },
    publish: async (inspection) => {
      publishCalls += 1;
      publishedFrame = inspection;
      return { ...inspection, publishedName: 'step-06.png' };
    },
  });
  assert.equal(settleCalls, 1);
  assert.equal(publishCalls, 1);
  assert.equal(publishedFrame, stableFrame);
  assert.equal(result.inspection.publishedName, 'step-06.png');
});

function layout(size, labels, loading, top = 600) {
  return {
    ...size,
    nodes: labels.map((text, index) => ({
      text,
      bounds: { left: 40, top: top + index * 100, right: 1040, bottom: top + index * 100 + 80 },
      clickable: false,
      scrollable: false,
      enabled: true,
    })),
  };
}
