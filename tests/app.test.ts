import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { createApiRouter } from '../server/routes/api.js';
import { clearDiscoveryCache } from '../server/services/devices.js';

test('the local app serves a healthy API and real diagnostics', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter());
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const healthResponse = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3_000) });
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.equal(health.ok, true);

    const configResponse = await fetch(`${base}/api/config`, {
      signal: AbortSignal.timeout(3_000),
    });
    assert.equal(configResponse.status, 200);
    const clientConfig = await configResponse.json();
    assert.equal(typeof clientConfig.vision?.configured, 'boolean');
    assert.ok(['anthropic', 'openai'].includes(clientConfig.vision?.provider));

    clearDiscoveryCache();
    const devicesResponse = await fetch(`${base}/api/devices?refresh=1`, {
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(devicesResponse.status, 200);
    const result = await devicesResponse.json();
    assert.ok(Array.isArray(result.devices));
    assert.equal(result.diagnostics.length, 3);
    assert.ok(result.diagnostics.some((entry) => entry.platform === 'android'));
    assert.ok(result.diagnostics.some((entry) => entry.platform === 'ios'));
    assert.ok(result.diagnostics.some((entry) => entry.platform === 'harmony'));
    const android = result.diagnostics.find((entry) => entry.platform === 'android');
    for (const device of result.devices) {
      assert.ok(['android', 'ios', 'harmony'].includes(device.platform));
      assert.ok(['device', 'unauthorized', 'offline'].includes(device.state));
    }
    assert.ok(android?.tools.adb?.available);
  } finally {
    server.close();
  }
});

test('unknown and malformed device requests fail with client errors', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter());
  app.use((error, _request, response, _next) => {
    response.status(error.statusCode || 500).json({ error: error.message });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const notFound = await fetch(`${base}/api/devices/not-a-device/frame`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(notFound.status, 404);
    const malformed = await fetch(`${base}/api/devices/not-a-device/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'tap', x: -1, y: 1 }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(malformed.status, 404);
  } finally {
    server.close();
  }
});
