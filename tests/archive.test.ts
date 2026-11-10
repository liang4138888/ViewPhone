import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import test from 'node:test';

const temporaryRoot = await mkdtemp(join(tmpdir(), 'viewphone-archive-test-'));
const archiveRoot = join(temporaryRoot, 'archives');
const runRoot = join(temporaryRoot, 'test-runs');
process.env.VIEWPHONE_ARCHIVE_ROOT = archiveRoot;
process.env.VIEWPHONE_TEST_RUNS_ROOT = runRoot;
process.env.MYSQL_URL = '';
process.env.MYSQL_USER = '';
process.env.SPRING_DATASOURCE_URL = '';
process.env.SPRING_DATASOURCE_USERNAME = '';

const { createApiRouter } = await import('../server/routes/api.js');
const {
  categoryCounts,
  classifyRun,
  runMatchesQuery,
} = await import('../server/services/archiveCategories.js');
const {
  archiveTestRun,
  closeArchiveStore,
  getArchivedRun,
  getSharedRun,
  listArchivedRuns,
  parseMysqlConnection,
  shareArchivedRun,
} = await import('../server/services/archiveStore.js');

const runId = '12345678-1234-4234-9234-123456789abc';
const secondRunId = '87654321-4321-4321-8321-cba987654321';
const classifiedRunId = '34567890-3456-4345-8345-345678901234';
const activeRunId = '45678901-4567-4456-8456-456789012345';

test.after(async () => {
  await closeArchiveStore();
  await rm(temporaryRoot, { recursive: true, force: true });
});

test('parses the Spring JDBC connection without exposing query options as the database', () => {
  assert.deepEqual(parseMysqlConnection({
    mysqlUrl: 'jdbc:mysql://localhost:3306/viewPhone?useUnicode=true&characterEncoding=utf8&useSSL=false',
    mysqlUser: 'root',
    mysqlPassword: 'not-in-output',
  }), {
    host: 'localhost',
    port: 3306,
    user: 'root',
    password: 'not-in-output',
    database: 'viewPhone',
  });
  assert.throws(() => parseMysqlConnection({
    mysqlUrl: 'postgresql://localhost/viewPhone',
    mysqlUser: 'root',
  }), /MySQL 地址/);
});

test('archives to local storage and survives a fresh read', async () => {
  await seedRun(runId, '点击打开商品详情', 'step-01.png');
  const result = await archiveTestRun(testRun(runId, '点击打开商品详情'));
  assert.equal(result.storage, 'file');

  const stored = await getArchivedRun(runId);
  assert.equal(stored?.storage, 'file');
  assert.equal(stored?.run.flow, '点击打开商品详情');
  assert.equal(stored?.run.steps[0].image?.startsWith('/api/test-runs/'), true);

  const records = await listArchivedRuns({ query: '商品' });
  assert.equal(records.length, 1);
  assert.equal(records[0].storage, 'file');
  assert.equal(records[0].deviceName, 'Android Test');
});

test('classifies multi-page natural language and keeps compatibility with old archives', () => {
  const classified = testRun(
    classifiedRunId,
    '从首页搜索牛奶，打开商品详情，加入购物车，去结算并使用微信支付',
  );
  classified.steps[0].thought = '已到达结算页';
  classified.steps[0].elementDiff = {
    added: [{ text: '订单提交成功', bounds: { x: 1, y: 1, width: 10, height: 10 } }],
    removed: [],
    moved: [],
  } as any;
  assert.deepEqual(classifyRun(classified), ['首页', '搜索', '商品', '购物车', '结算', '支付']);
  assert.equal(classifyRun({ flow: '点击页面中央' })[0], '其他');

  const legacy = testRun(activeRunId, '完成购物车结算');
  delete legacy.categories;
  assert.deepEqual(classifyRun(legacy), ['购物车', '结算']);

  assert.deepEqual(classifyRun({ ...classified, categories: ['首页', '分类'] }), [
    '首页', '分类', '搜索', '商品', '购物车', '结算', '支付',
  ]);
  const counts = categoryCounts([{ flow: '首页', categories: ['首页', '分类'] }]);
  assert.equal(counts.find((item) => item.name === '首页')?.count, 1);
  assert.equal(counts.find((item) => item.name === '分类')?.count, 1);
  assert.equal(counts.find((item) => item.name === '支付')?.count, 0);

  assert.equal(runMatchesQuery(classified, '结算页'), true);
  assert.equal(runMatchesQuery(classified, '订单提交成功'), true);
  assert.equal(runMatchesQuery(classified, '不存在的自然语言'), false);

  const myCheckpoint = {
    id: '87654321-4321-4321-8321-cba987654322',
    flow: '页面打点：我的',
    comparison: { checkpointName: '我的' },
  };
  assert.equal(classifyRun(myCheckpoint).includes('我的'), true);
  assert.equal(runMatchesQuery(myCheckpoint, '我的'), true);
});

test('filters archives by natural-language step evidence, category and active status', async () => {
  const classified = testRun(
    classifiedRunId,
    '从首页搜索牛奶，打开商品详情，加入购物车，去结算并使用微信支付',
  );
  classified.steps[0].thought = '已到达结算页';
  classified.steps[0].elementDiff = {
    added: [{ text: '订单提交成功' }],
    removed: [],
    moved: [],
  } as any;
  await archiveTestRun(classified);

  const active = testRun(activeRunId, '从首页进入分类并筛选牛奶');
  Object.assign(active, {
    status: 'running',
    finishedAt: undefined,
    verdict: undefined,
  });
  await archiveTestRun(active);

  assert.equal((await listArchivedRuns({ query: '结算页', category: '结算' })).length, 1);
  assert.equal((await listArchivedRuns({ query: '订单提交成功', category: '购物车' })).length, 1);
  assert.equal((await listArchivedRuns({ category: '支付' })).some((item) => item.id === classifiedRunId), true);
  assert.equal((await listArchivedRuns({ category: '分类' })).some((item) => item.id === activeRunId), true);
  assert.deepEqual((await listArchivedRuns({ status: 'active' })).map((item) => item.id), [activeRunId]);
});

test('share is reusable before expiry and only exposes its own rewritten screenshot', async () => {
  const share = await shareArchivedRun(runId);
  const duplicate = await shareArchivedRun(runId);
  assert.equal(share.token, duplicate.token);
  assert.match(share.token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(share.path, `/share/${share.token}`);

  const shared = await getSharedRun(share.token);
  assert.equal(shared?.flow, '点击打开商品详情');
  assert.equal(shared?.steps[0].image, `/api/shares/${share.token}/assets/step-01.png`);
  assert.equal(shared?.steps[0].beforeImage, undefined);
  assert.equal(shared?.steps[0].afterImage, undefined);
  assert.equal(await getSharedRun('x'.repeat(32)), undefined);
});

test('expired share tokens cannot reopen an archive', async () => {
  const share = await shareArchivedRun(runId);
  const file = join(archiveRoot, 'runs', `${runId}.json`);
  const archived = JSON.parse(await readFile(file, 'utf8'));
  archived.share.expiresAt = new Date(Date.now() - 1_000).toISOString();
  await writeFile(file, JSON.stringify(archived), 'utf8');

  assert.equal(await getSharedRun(share.token), undefined);
  await archiveTestRun(testRun(runId, '点击打开商品详情'));
});

test('share assets reject another test run and archive routes are read-only', async () => {
  await seedRun(secondRunId, '其他流程', 'step-01.png');
  await archiveTestRun(testRun(secondRunId, '其他流程'));
  const share = await shareArchivedRun(runId);

  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter());
  app.use((error: any, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error.statusCode || 500).json({ error: error.message, code: error.code });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const report = await fetch(`${base}/api/shares/${share.token}`);
    assert.equal(report.status, 200);
    const body = await report.json();
    assert.equal(body.flow, '点击打开商品详情');
    assert.equal(body.deviceId, undefined);
    assert.equal(body.maxSteps, undefined);
    assert.equal(body.share?.token, share.token);

    const ownAsset = await fetch(`${base}/api/shares/${share.token}/assets/step-01.png`);
    assert.equal(ownAsset.status, 200);
    assert.equal(ownAsset.headers.get('content-type'), 'image/png');

    await shareArchivedRun(secondRunId);
    const crossAsset = await fetch(`${base}/api/shares/${share.token}/assets/step-01.png?run=${secondRunId}`);
    assert.equal(crossAsset.status, 200);
    const invalidName = await fetch(`${base}/api/shares/${share.token}/assets/../${runId}/step-01.png`);
    assert.ok([400, 404].includes(invalidName.status));
  } finally {
    server.close();
  }
});

async function seedRun(id: string, flow: string, screenshot: string) {
  const directory = join(runRoot, id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, screenshot), Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]));
}

function testRun(id: string, flow: string) {
  return {
    id,
    deviceId: 'device-secret',
    deviceName: 'Android Test',
    platform: 'android',
    status: 'completed',
    engine: 'steps',
    flow,
    maxSteps: 30,
    createdAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    verdict: { passed: true, reason: '测试目标已达到' },
    steps: [{
      index: 1,
      source: flow,
      type: 'tap',
      description: flow,
      status: 'passed',
      stage: 'done',
      stageLabel: '完成',
      logs: [],
      image: `/api/test-runs/${id}/assets/step-01.png`,
      beforeImage: `/api/test-runs/${id}/assets/step-01-before.png`,
      afterImage: `/api/test-runs/${id}/assets/step-01-after.png`,
      imageDiff: { changedRatio: 0.25, averageDelta: 0.1, changedRegions: [] },
    }],
  };
}
