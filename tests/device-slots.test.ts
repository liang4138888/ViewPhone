import assert from 'node:assert/strict';
import test from 'node:test';
import type { Diagnostics } from '../shared/types.ts';
import { buildConnectedDeviceSlots, buildDeviceSlots } from '../src/lib/deviceSlots.ts';
import { selectDiagnosticDevice } from '../src/lib/diagnosticSelection.ts';

const online = {
  nativeId: 'device-1',
  id: 'a_device-1',
  platform: 'android' as const,
  name: 'Android 1',
  state: 'device' as const,
};

test('multi-device workbench always reserves a panel for all three platforms', () => {
  const slots = buildDeviceSlots([online]);
  assert.deepEqual(
    slots.map((slot) => slot.platform),
    ['android', 'ios', 'harmony'],
  );
  assert.equal(slots[0].device?.id, online.id);
  assert.equal(slots[1].device, undefined);
  assert.match(slots[1].detail || '', /iOS/);
});

test('multiple devices on one platform keep their own panels and stable keys', () => {
  const second = { ...online, nativeId: 'device-2', id: 'a_device-2' };
  const slots = buildDeviceSlots([second, online]);
  const android = slots.filter((slot) => slot.platform === 'android');
  assert.deepEqual(android.map((slot) => slot.key), [online.id, second.id]);
  assert.deepEqual(slots.map((slot) => slot.platform), ['android', 'android', 'ios', 'harmony']);
});

test('platform diagnostics are shown inside the missing-device panel', () => {
  const diagnostics: Diagnostics[] = [
    {
      platform: 'ios',
      tools: { wda: { available: false, url: 'http://127.0.0.1:8100', message: 'offline' } },
      deviceCount: 0,
      warnings: ['无法连接 WebDriverAgent'],
    },
  ];
  const slots = buildDeviceSlots([], diagnostics);
  assert.equal(slots.find((slot) => slot.platform === 'ios')?.detail, '无法连接 WebDriverAgent');
});

test('sync workbench only renders authorized connected device panels', () => {
  const unauthorized = {
    ...online,
    nativeId: 'device-2',
    id: 'a_device-2',
    state: 'unauthorized' as const,
  };
  const offlineHarmony = {
    ...online,
    nativeId: 'device-3',
    id: 'h_device-3',
    platform: 'harmony' as const,
    state: 'offline' as const,
  };
  const slots = buildConnectedDeviceSlots([unauthorized, offlineHarmony, online]);
  assert.deepEqual(slots.map((slot) => slot.device?.id), [online.id]);
});

test('an online platform card selects its device and keeps the same device highlighted', () => {
  const harmony = {
    ...online,
    nativeId: 'harmony-1',
    id: 'h_harmony-1',
    platform: 'harmony' as const,
    name: 'Harmony 1',
  };
  const unauthorized = {
    ...online,
    nativeId: 'ios-1',
    id: 'i_ios-1',
    platform: 'ios' as const,
    state: 'unauthorized' as const,
  };
  const devices = [online, harmony, unauthorized];
  assert.equal(selectDiagnosticDevice(devices, 'harmony', online.id), harmony.id);
  assert.equal(selectDiagnosticDevice(devices, 'harmony', harmony.id), harmony.id);
  assert.equal(selectDiagnosticDevice(devices, 'ios', online.id), undefined);
  assert.equal(selectDiagnosticDevice(devices, 'harmony'), harmony.id);
});
