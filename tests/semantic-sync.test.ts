import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAndroidLayout, parseHarmonyLayout } from '../server/services/uiLayout.js';
import {
  resolveSemanticAction,
  mapActionToCoordinates,
} from '../server/services/semanticSync.js';
import { hasUsefulSemanticNodes, parseOcrLayout } from '../server/services/ocrLayout.js';
import { resolveSyncAction } from '../server/services/sync.js';
import { AndroidAdapter } from '../server/adapters/android.js';

const androidXml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node text="" resource-id="" class="android.widget.FrameLayout" bounds="[0,0][1080,2340]" clickable="false" enabled="true">
    <node text="搜索" resource-id="com.example:id/search" class="android.widget.Button" bounds="[40,80][280,160]" clickable="true" enabled="true"/>
    <node text="商品 A" resource-id="" class="android.widget.TextView" bounds="[40,600][700,760]" clickable="false" enabled="true"/>
    <node text="立即购买" resource-id="com.example:id/buy" class="android.widget.Button" bounds="[40,1800][420,1940]" clickable="true" enabled="true"/>
    <node text="立即购买" resource-id="com.example:id/buy_bottom" class="android.widget.Button" bounds="[660,2100][1040,2240]" clickable="true" enabled="true"/>
    <node text="123456" resource-id="com.example:id/password" class="android.widget.EditText" bounds="[40,1200][1040,1300]" password="true" clickable="true" enabled="true"/>
  </node>
</hierarchy>`;

const harmonyLayout = {
  attributes: { bounds: '[0,0][1260,2720]', type: 'root' },
  children: [
    { attributes: { text: '搜索', bounds: '[80,180][450,290]', clickable: 'true', type: 'Button' } },
    { attributes: { text: '商品 A', bounds: '[80,900][1000,1100]', clickable: 'false', type: 'Text' } },
    { attributes: { text: '立即购买', bounds: '[80,2100][520,2220]', clickable: 'true', type: 'Button' } },
    { attributes: { text: '立即购买', bounds: '[720,2250][1180,2370]', clickable: 'true', type: 'Button' } },
    { attributes: { text: '', bounds: '[80,1400][1180,1520]', type: 'TextInput', password: 'true' } },
  ],
};

const scrollingAndroidXml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node text="" resource-id="" class="android.widget.FrameLayout" bounds="[0,0][1080,2340]" clickable="false" enabled="true">
    <node text="" resource-id="com.example:id/feed" class="androidx.recyclerview.widget.RecyclerView" bounds="[0,300][1080,2000]" clickable="false" scrollable="true" enabled="true">
      <node text="商品 A" resource-id="com.example:id/product_a" class="android.widget.TextView" bounds="[100,600][900,760]" clickable="true" enabled="true"/>
      <node text="商品 B" resource-id="com.example:id/product_b" class="android.widget.TextView" bounds="[100,1100][900,1260]" clickable="true" enabled="true"/>
    </node>
  </node>
</hierarchy>`;

const scrollingHarmonyLayout = {
  attributes: { bounds: '[0,0][1260,2720]', type: 'root' },
  children: [
    {
      attributes: {
        bounds: '[0,500][1260,2500]',
        type: 'Scroll',
        scrollable: 'true',
      },
      children: [
        { attributes: { text: '商品 A', bounds: '[100,900][1100,1100]', clickable: 'true', type: 'Text' } },
        { attributes: { text: '商品 B', bounds: '[100,1600][1100,1800]', clickable: 'true', type: 'Text' } },
      ],
    },
  ],
};

test('screen-size differences use matching UI nodes rather than raw percentages', () => {
  const source = parseAndroidLayout(androidXml);
  const target = parseHarmonyLayout(harmonyLayout);
  const resolved = resolveSemanticAction({ type: 'tap', x: 160, y: 120 }, source, target);
  assert.equal(resolved.match, 'semantic');
  assert.deepEqual(resolved.action, { type: 'tap', x: 265, y: 235 });
});

test('matching a target node adapts a button that moved vertically between screens', () => {
  const source = parseAndroidLayout(androidXml);
  const target = parseHarmonyLayout(harmonyLayout);
  const resolved = resolveSemanticAction({ type: 'tap', x: 230, y: 1870 }, source, target);
  assert.deepEqual(resolved.action, { type: 'tap', x: 300, y: 2160 });
});

test('duplicate labels select the same relative UI position', () => {
  const source = parseAndroidLayout(androidXml);
  const target = parseHarmonyLayout(harmonyLayout);
  const resolved = resolveSemanticAction({ type: 'tap', x: 850, y: 2170 }, source, target);
  assert.deepEqual(resolved.action, { type: 'tap', x: 950, y: 2310 });
});

test('a missing target node does not fall back to an unsafe coordinate click', () => {
  const source = parseAndroidLayout(androidXml);
  const target = parseHarmonyLayout({
    attributes: { bounds: '[0,0][1260,2720]' },
    children: [{ attributes: { text: '不同页面', bounds: '[0,0][1260,200]' } }],
  });
  const resolved = resolveSemanticAction({ type: 'tap', x: 160, y: 120 }, source, target);
  assert.equal(resolved.match, 'unmatched');
  assert.deepEqual(resolved.action, { type: 'tap', x: 160, y: 120 });
});

test('password values are never used as cross-device UI identities', () => {
  const source = parseAndroidLayout(androidXml);
  const password = source.nodes.find((node) => node.id.endsWith('/password'));
  assert.ok(password);
  assert.equal(password.text, '');
  const target = parseHarmonyLayout(harmonyLayout);
  const resolved = resolveSemanticAction({ type: 'tap', x: 540, y: 1250 }, source, target);
  assert.notEqual(resolved.match, 'semantic');
});

test('explicit coordinate modes remain available as a deliberate fallback', () => {
  assert.deepEqual(
    mapActionToCoordinates(
      { type: 'tap', x: 540, y: 1170 },
      { width: 1080, height: 2340 },
      { width: 1260, height: 2720 },
      'relative',
    ),
    { type: 'tap', x: 630, y: 1360 },
  );
});

test('a swipe is mapped inside the corresponding scrollable container on different screen sizes', () => {
  const source = parseAndroidLayout(scrollingAndroidXml);
  const target = parseHarmonyLayout(scrollingHarmonyLayout);
  const resolved = resolveSemanticAction(
    { type: 'swipe', fromX: 540, fromY: 1700, toX: 540, toY: 500, duration: 500 },
    source,
    target,
  );
  assert.equal(resolved.match, 'semantic');
  assert.deepEqual(resolved.action, {
    type: 'swipe',
    fromX: 630,
    fromY: 2147,
    toX: 630,
    toY: 735,
    duration: 500,
  });
});

test('a swipe is skipped when the target has no matching scrollable region', () => {
  const source = parseAndroidLayout(scrollingAndroidXml);
  const target = parseHarmonyLayout({
    attributes: { bounds: '[0,0][1260,2720]' },
    children: [
      {
        attributes: { bounds: '[0,500][1260,2500]', type: 'Scroll', scrollable: 'true' },
        children: [
          { attributes: { text: '不同页面', bounds: '[100,900][1100,1100]', type: 'Text' } },
        ],
      },
    ],
  });
  const resolved = resolveSemanticAction(
    { type: 'swipe', fromX: 540, fromY: 1700, toX: 540, toY: 500, duration: 500 },
    source,
    target,
  );
  assert.equal(resolved.match, 'unmatched');
});

test('OCR text nodes can safely match a visible target label', () => {
  const source = parseOcrLayout({
    width: 1080,
    height: 2340,
    nodes: [
      { text: '立即购买', confidence: 0.95, bounds: { left: 40, top: 1800, right: 420, bottom: 1940 } },
    ],
  });
  const target = parseHarmonyLayout(harmonyLayout);
  const resolved = resolveSemanticAction({ type: 'tap', x: 230, y: 1870 }, source, target);
  assert.equal(resolved.match, 'semantic');
  assert.deepEqual(resolved.action, { type: 'tap', x: 300, y: 2160 });
});

test('a full-page WebView title cannot be used as a click target', () => {
  const source = parseAndroidLayout(
    `<hierarchy><node text="ViewPhone Sync Test" class="android.webkit.WebView" bounds="[0,250][1080,2162]" scrollable="true" enabled="true"/></hierarchy>`,
    { width: 1080, height: 2340 },
  );
  const target = parseAndroidLayout(
    `<hierarchy>
      <node text="ViewPhone Sync Test" class="android.webkit.WebView" bounds="[0,255][1080,1794]" scrollable="true" enabled="true"/>
      <node text="" resource-id="sync-button" class="android.widget.Button" bounds="[68,328][1013,570]" clickable="true" enabled="true"/>
    </hierarchy>`,
    { width: 1080, height: 1920 },
  );
  const resolved = resolveSemanticAction({ type: 'tap', x: 542, y: 1197 }, source, target);
  assert.equal(resolved.match, 'unmatched');
});

test('a root-only native hierarchy is not treated as a useful semantic layout', () => {
  const rootOnly = parseAndroidLayout(`<hierarchy><node bounds="[0,0][1080,2340]" enabled="true"/></hierarchy>`);
  assert.equal(hasUsefulSemanticNodes(rootOnly), false);
  assert.equal(hasUsefulSemanticNodes(parseAndroidLayout(androidXml)), true);
});

test('key and unpositioned text actions do not wait for a UI hierarchy', async () => {
  const failLayout = () => Promise.reject(new Error('layout unavailable'));
  const source = { id: 'source', name: 'Source', width: 1080, height: 2340 };
  const target = { id: 'target', name: 'Target', width: 1260, height: 2720 };
  const sourceAdapter = { layout: failLayout, screenshot: failLayout };
  const targetAdapter = { layout: failLayout, screenshot: failLayout };
  assert.equal(
    (await resolveSyncAction(
      source,
      target,
      { type: 'key', key: 'home' },
      sourceAdapter,
      targetAdapter,
      'semantic',
    )).match,
    'native',
  );
  assert.equal(
    (await resolveSyncAction(
      source,
      target,
      { type: 'text', text: 'hello' },
      sourceAdapter,
      targetAdapter,
      'semantic',
    )).match,
    'native',
  );
});

test('visual anchors map a swipe when OCR has no scrollable container', () => {
  const sourceLabels = [
    ['搜索', 100, 240],
    ['会员码', 805, 160],
    ['立即领取', 240, 1200],
    ['购物车', 643, 2260],
  ];
  const targetLabels = sourceLabels.map(([text, x, y]) => [
    text,
    Math.round(Number(x) * 1260 / 1080),
    Math.round(Number(y) * 2720 / 2340),
  ]);
  const layout = (labels: Array<(string | number)[]>, width: number, height: number) => parseHarmonyLayout({
    attributes: { bounds: `[0,0][${width},${height}]`, type: 'root' },
    children: labels.map(([text, x, y]) => ({
      attributes: {
        text,
        bounds: `[${x},${y}][${Number(x) + 120},${Number(y) + 60}]`,
        type: 'Text',
      },
    })),
  }, { width, height });
  const source = layout(sourceLabels, 1080, 2340);
  const target = layout(targetLabels, 1260, 2720);
  const resolved = resolveSemanticAction(
    { type: 'swipe', fromX: 540, fromY: 1800, toX: 540, toY: 500, duration: 350 },
    source,
    target,
  );
  assert.equal(resolved.match, 'semantic');
  assert.deepEqual(resolved.action, {
    type: 'swipe',
    fromX: 620,
    fromY: 2087,
    toX: 620,
    toY: 576,
    duration: 350,
  });
});

