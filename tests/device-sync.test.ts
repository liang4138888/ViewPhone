import assert from 'node:assert/strict';
import test from 'node:test';
import { getSyncTargets, mapActionToDevice } from '../src/lib/deviceSync.ts';
import type { DeviceInfo } from '../shared/types.ts';

const android = {
  nativeId: 'android-1',
  id: 'a_android',
  platform: 'android' as const,
  name: 'Android',
  state: 'device' as const,
  width: 1080,
  height: 2340,
};

const harmony = {
  nativeId: 'harmony-1',
  id: 'h_harmony',
  platform: 'harmony' as const,
  name: 'HarmonyOS',
  state: 'device' as const,
  width: 1320,
  height: 2120,
};

test('sync targets exclude the controller and disconnected devices', () => {
  const devices: DeviceInfo[] = [
    android,
    harmony,
    { ...harmony, nativeId: 'offline', id: 'h_offline', state: 'offline' },
  ];
  assert.deepEqual(getSyncTargets(devices, android.id).map((device) => device.id), [harmony.id]);
});

test('relative sync preserves screen position across different resolutions', () => {
  assert.deepEqual(
    mapActionToDevice(
      { type: 'tap', x: 540, y: 1170 },
      { width: 1080, height: 2340 },
      { width: 1320, height: 2120 },
    ),
    { type: 'tap', x: 660, y: 1060 },
  );
});

test('relative sync maps both ends of a swipe', () => {
  assert.deepEqual(
    mapActionToDevice(
      { type: 'swipe', fromX: 540, fromY: 1825, toX: 540, toY: 515, duration: 500 },
      { width: 1080, height: 2340 },
      { width: 1320, height: 2120 },
    ),
    {
      type: 'swipe',
      fromX: 660,
      fromY: 1653,
      toX: 660,
      toY: 467,
      duration: 500,
    },
  );
});

test('pixel sync keeps raw coordinates within the receiver screen', () => {
  assert.deepEqual(
    mapActionToDevice(
      { type: 'tap', x: 700, y: 1800 },
      { width: 1080, height: 2340 },
      { width: 1320, height: 2120 },
      'pixel',
    ),
    { type: 'tap', x: 700, y: 1800 },
  );
  assert.deepEqual(
    mapActionToDevice(
      { type: 'tap', x: 2400, y: 3300 },
      { width: 2400, height: 3300 },
      { width: 1320, height: 2120 },
      'pixel',
    ),
    { type: 'tap', x: 1319, y: 2119 },
  );
});

test('keyboard actions stay unchanged while targeted text moves with the tap', () => {
  const source = { width: 1080, height: 2340 };
  const target = { width: 1320, height: 2120 };
  assert.deepEqual(
    mapActionToDevice({ type: 'key', key: 'home' }, source, target),
    { type: 'key', key: 'home' },
  );
  assert.deepEqual(
    mapActionToDevice(
      { type: 'text', text: 'hello', x: 540, y: 1170 },
      source,
      target,
    ),
    { type: 'text', text: 'hello', x: 660, y: 1060 },
  );
});
