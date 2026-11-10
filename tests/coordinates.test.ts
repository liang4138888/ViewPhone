import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserPointToDevice,
  createScrollSwipe,
  isPointInside,
  mapInputCoordinate,
  swipeDuration,
} from '../shared/coordinates.ts';

test('browser coordinates scale from the visible phone image to the screenshot', () => {
  assert.deepEqual(
    browserPointToDevice(
      260,
      450,
      { left: 100, top: 100, width: 400, height: 800 },
      { width: 1200, height: 2400 },
    ),
    { x: 480, y: 1050 },
  );
});

test('browser coordinates are clamped at the lower edge', () => {
  assert.deepEqual(
    browserPointToDevice(
      500,
      900,
      { left: 100, top: 100, width: 400, height: 800 },
      { width: 1200, height: 2400 },
    ),
    { x: 1199, y: 2399 },
  );
});

test('Retina screenshots map to iOS logical touch points', () => {
  assert.deepEqual(
    mapInputCoordinate(
      { x: 600, y: 1200 },
      { width: 1200, height: 2400 },
      { width: 390, height: 844 },
    ),
    { x: 195, y: 422 },
  );
});

test('screenshot and touch sizes remain independent', () => {
  assert.deepEqual(
    mapInputCoordinate(
      { x: 0, y: 0 },
      { width: 1179, height: 2556 },
      { width: 393, height: 852 },
    ),
    { x: 0, y: 0 },
  );
});

test('only pointers inside the phone screen are accepted', () => {
  const rect = { left: 10, top: 20, width: 100, height: 200 };
  assert.equal(isPointInside(10, 20, rect), true);
  assert.equal(isPointInside(110, 220, rect), true);
  assert.equal(isPointInside(9, 20, rect), false);
  assert.equal(isPointInside(110, 221, rect), false);
});

test('zero size viewport is rejected', () => {
  assert.throws(
    () => browserPointToDevice(0, 0, { left: 0, top: 0, width: 0, height: 100 }, { width: 1, height: 1 }),
    RangeError,
  );
});

test('quick drags remain long enough for the phone to recognize a swipe', () => {
  assert.equal(swipeDuration(120), 450);
  assert.equal(swipeDuration(700), 700);
  assert.equal(swipeDuration(2_000), 1_200);
});

test('page scroll gestures use safe vertical bounds and reliable duration', () => {
  assert.deepEqual(createScrollSwipe('down', { width: 1080, height: 2340 }), {
    type: 'swipe',
    fromX: 540,
    fromY: 1825,
    toX: 540,
    toY: 515,
    duration: 500,
  });
  assert.deepEqual(createScrollSwipe('up', { width: 400, height: 800 }), {
    type: 'swipe',
    fromX: 200,
    fromY: 176,
    toX: 200,
    toY: 624,
    duration: 500,
  });
});
