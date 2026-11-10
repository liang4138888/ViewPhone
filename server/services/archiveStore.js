import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { config } from '../config.js';
import {
  ARCHIVE_CATEGORIES,
  categoryCounts,
  classifyRun,
  runMatchesQuery,
  withArchiveCategories,
} from './archiveCategories.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const archiveRoot = config.archive.root
  ? resolve(config.archive.root)
  : join(root, '.artifacts/archives');
const runDirectory = join(archiveRoot, 'runs');
const RUN_ID = /^[a-f0-9-]{20,40}$/i;
const SHARE_TOKEN = /^[A-Za-z0-9_-]{32,80}$/;

let pool;
let poolInitialized = false;
let database;
let mysqlFailure;
let retryMysqlAt = 0;

export function parseMysqlConnection(source = config.archive) {
  const raw = String(source?.mysqlUrl || '').trim();
  const user = String(source?.mysqlUser || '').trim();
  const password = String(source?.mysqlPassword || '');
  if (!raw || !user) return undefined;

  let parsed;
  try {
    const candidate = raw.startsWith('jdbc:mysql:')
      ? raw.replace(/^jdbc:mysql:/, 'mysql:')
      : raw;
    parsed = new URL(candidate);
  } catch {
    throw archiveError('MySQL 地址配置无效', 'INVALID_MYSQL_URL');
  }
  if (!['mysql:', 'mysqls:'].includes(parsed.protocol)) {
    throw archiveError('MySQL 地址必须以 jdbc:mysql:// 开头', 'INVALID_MYSQL_URL');
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, '')).split('/')[0];
  if (!databaseName || !/^[A-Za-z0-9_]+$/.test(databaseName)) {
    throw archiveError('MySQL 地址必须包含有效的数据库名称', 'INVALID_MYSQL_URL');
  }
  return {
    host: parsed.hostname || '127.0.0.1',
    port: Number(parsed.port || 3306),
    user,
    password,
    database: databaseName,
  };
}

export async function archiveTestRun(run) {
  if (!run?.id) throw archiveError('测试记录不完整，无法归档', 'INVALID_TEST_RUN');
  const archivedAt = run.archivedAt || new Date().toISOString();
  const updatedAt = new Date().toISOString();
  const record = {
    ...run,
    archivedAt,
    updatedAt,
    categories: classifyRun(run),
    archiveStorage: run.archiveStorage,
  };
  const mysqlPool = await getMysqlPool();
  if (mysqlPool) {
    try {
      record.archiveStorage = 'mysql';
      await upsertMysqlRun(mysqlPool, record);
      Object.assign(run, {
        archivedAt,
        updatedAt,
        categories: record.categories,
        archiveStorage: 'mysql',
      });
      return { archivedAt, updatedAt, categories: record.categories, storage: 'mysql' };
    } catch (error) {
      recordMysqlFailure(error);
    }
  }
  record.archiveStorage = 'file';
  await writeFileArchive(record);
  Object.assign(run, {
    archivedAt,
    updatedAt,
    categories: record.categories,
    archiveStorage: 'file',
  });
  return { archivedAt, updatedAt, categories: record.categories, storage: 'file' };
}

export async function getArchivedRun(runId) {
  if (!RUN_ID.test(runId)) return undefined;
  const mysqlPool = await getMysqlPool();
  if (mysqlPool) {
    try {
      const [rows] = await mysqlPool.execute(
        'SELECT run_json FROM test_run_archives WHERE id = ? LIMIT 1',
        [runId],
      );
      if (rows[0]?.run_json) {
        return { run: withArchiveCategories(parseJson(rows[0].run_json)), storage: 'mysql' };
      }
    } catch (error) {
      recordMysqlFailure(error);
    }
  }
  const stored = await readFileArchive(runId);
  return stored ? { run: withArchiveCategories(stored), storage: 'file' } : undefined;
}

export async function listArchivedRuns({ query = '', category, status, limit = 100 } = {}) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100));
  const normalizedStatus = ['active', 'queued', 'running', 'completed', 'failed'].includes(status)
    ? status
    : '';
  const normalizedCategory = ARCHIVE_CATEGORIES.includes(category) ? category : '';
  const records = new Map();
  const mysqlPool = await getMysqlPool();
  if (mysqlPool) {
    try {
      // Search and classify inside the persisted run JSON. The larger candidate
      // window is intentional: step-level natural language is not available in
      // the legacy summary columns, and old rows have no categories field.
      const [rows] = normalizedStatus === 'active'
        ? await mysqlPool.query(
          `SELECT id, run_json FROM test_run_archives
            WHERE status IN ('queued', 'running') ORDER BY archived_at DESC LIMIT 2000`,
        )
        : normalizedStatus
        ? await mysqlPool.execute(
          `SELECT id, run_json FROM test_run_archives
            WHERE status = ? ORDER BY archived_at DESC LIMIT 2000`,
          [normalizedStatus],
        )
        : await mysqlPool.query(
          'SELECT id, run_json FROM test_run_archives ORDER BY archived_at DESC LIMIT 2000',
        );
      for (const row of rows) {
        const run = withArchiveCategories(parseJson(row.run_json));
        if (!runMatchesQuery(run, query)) continue;
        if (normalizedCategory && !run.categories.includes(normalizedCategory)) continue;
        records.set(row.id, summaryFromRun(run, 'mysql'));
      }
    } catch (error) {
      recordMysqlFailure(error);
    }
  }
  for (const item of await readFileArchives()) {
    if (records.has(item.id)) continue;
    const run = withArchiveCategories(item);
    if (!matchesStatus(run.status, normalizedStatus)) continue;
    if (!runMatchesQuery(run, query)) continue;
    if (normalizedCategory && !run.categories.includes(normalizedCategory)) continue;
    records.set(item.id, summaryFromRun(run, 'file'));
  }
  return [...records.values()]
    .sort((a, b) => Date.parse(b.updatedAt || b.archivedAt) - Date.parse(a.updatedAt || a.archivedAt))
    .slice(0, safeLimit);
}

function matchesStatus(status, filter) {
  if (!filter) return true;
  if (filter === 'active') return ['queued', 'running'].includes(status);
  return status === filter;
}

export async function archiveCategoryCatalog({ query = '', status } = {}) {
  const records = await listArchivedRuns({ query, status, limit: 200 });
  return categoryCounts(records);
}

export async function shareArchivedRun(runId) {
  const archived = await getArchivedRun(runId);
  if (!archived) throw archiveError('归档记录不存在', 'ARCHIVE_NOT_FOUND', 404);
  const current = archived.run.share;
  if (current?.token && (!current.expiresAt || Date.parse(current.expiresAt) > Date.now())) {
    return current;
  }
  const token = randomBytes(24).toString('base64url');
  const expiresAt = new Date(
    Date.now() + config.archive.shareTtlDays * 24 * 60 * 60 * 1_000,
  ).toISOString();
  archived.run.share = { token, path: `/share/${token}`, expiresAt };
  archived.run.archiveStorage = archived.storage;
  if (archived.storage === 'mysql') {
    const mysqlPool = await getMysqlPool();
    if (!mysqlPool) throw archiveError('MySQL 当前不可用，请稍后重试', 'MYSQL_UNAVAILABLE', 503);
    await upsertMysqlRun(mysqlPool, archived.run);
  } else {
    await writeFileArchive(archived.run);
  }
  return archived.run.share;
}

export async function getSharedRun(token) {
  if (!SHARE_TOKEN.test(String(token || ''))) return undefined;
  const record = await findByShareToken(token);
  if (!record) return undefined;
  const run = record.run;
  if (run.share?.expiresAt && Date.parse(run.share.expiresAt) <= Date.now()) return undefined;
  return {
    id: run.id,
    recordType: run.recordType,
    comparison: run.comparison
      ? comparisonForShare(run.comparison, token)
      : undefined,
    deviceName: run.deviceName,
    platform: run.platform,
    status: run.status,
    engine: run.engine,
    flow: run.flow,
    categories: classifyRun(run),
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    archivedAt: run.archivedAt,
    updatedAt: run.updatedAt,
    termination: run.termination,
    error: run.error,
    verdict: run.verdict,
    share: run.share,
    steps: (run.steps || []).map((step) => ({
      index: step.index,
      source: step.source,
      type: step.type,
      description: step.description,
      status: step.status,
      stage: step.stage,
      stageLabel: step.stageLabel,
      startedAt: step.startedAt,
      finishedAt: step.finishedAt,
      thought: step.thought,
      error: step.error,
      resolvedElement: step.resolvedElement,
      snapshot: step.snapshot,
      imageDiff: step.imageDiff,
      elementDiff: step.elementDiff,
      image: step.image && shareAssetUrl(token, step.image, `step-${String(step.index || 1).padStart(2, '0')}.png`),
      logs: [],
    })),
  };
}

export async function archiveStorageStatus() {
  const configured = Boolean(config.archive.mysqlUrl && config.archive.mysqlUser);
  const mysqlPool = await getMysqlPool();
  if (mysqlPool) {
    return {
      active: 'mysql',
      configured,
      database,
      host: mysqlConnection?.host,
      message: `归档已连接 MySQL · ${database}`,
    };
  }
  return {
    active: 'file',
    configured,
    message: configured
      ? `MySQL 暂不可用，归档已保存在本机${mysqlFailure ? `（${sanitizeMysqlError(mysqlFailure)}）` : ''}`
      : '尚未配置 MySQL，归档保存在本机',
  };
}

export async function closeArchiveStore() {
  if (pool) await pool.end().catch(() => undefined);
  pool = undefined;
  poolInitialized = false;
  mysqlConnection = undefined;
  retryMysqlAt = 0;
}

let mysqlConnection;

async function getMysqlPool() {
  if (pool) return pool;
  if (poolInitialized && Date.now() < retryMysqlAt) return undefined;
  poolInitialized = true;
  try {
    mysqlConnection = parseMysqlConnection();
    if (!mysqlConnection) return undefined;
    database = mysqlConnection.database;
    const databaseName = database;
    const admin = await mysql.createConnection({
      host: mysqlConnection.host,
      port: mysqlConnection.port,
      user: mysqlConnection.user,
      password: mysqlConnection.password,
      connectTimeout: 2_000,
    });
    await admin.query(
      `CREATE DATABASE IF NOT EXISTS \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await admin.end();
    pool = mysql.createPool({
      ...mysqlConnection,
      waitForConnections: true,
      connectionLimit: 4,
      enableKeepAlive: true,
      charset: 'utf8mb4',
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS test_run_archives (
        id CHAR(36) NOT NULL PRIMARY KEY,
        device_name VARCHAR(255) NOT NULL,
        platform VARCHAR(20) NOT NULL,
        engine VARCHAR(20) NOT NULL,
        status VARCHAR(20) NOT NULL,
        flow TEXT NOT NULL,
        created_at DATETIME(3) NOT NULL,
        finished_at DATETIME(3) NULL,
        archived_at DATETIME(3) NOT NULL,
        step_count INT NOT NULL,
        verdict_passed BOOLEAN NULL,
        verdict_reason TEXT NULL,
        run_json LONGTEXT NOT NULL,
        share_token VARCHAR(80) NULL UNIQUE,
        share_expires_at DATETIME(3) NULL,
        INDEX idx_archive_created (archived_at),
        INDEX idx_archive_device (device_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    mysqlFailure = undefined;
    return pool;
  } catch (error) {
    recordMysqlFailure(error);
    return undefined;
  }
}

async function upsertMysqlRun(mysqlPool, run) {
  const share = run.share;
  await mysqlPool.execute(`
    INSERT INTO test_run_archives
      (id, device_name, platform, engine, status, flow, created_at, finished_at,
       archived_at, step_count, verdict_passed, verdict_reason, run_json,
       share_token, share_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      status = VALUES(status), finished_at = VALUES(finished_at), archived_at = VALUES(archived_at),
      step_count = VALUES(step_count), verdict_passed = VALUES(verdict_passed),
      verdict_reason = VALUES(verdict_reason), run_json = VALUES(run_json),
      share_token = VALUES(share_token), share_expires_at = VALUES(share_expires_at)
  `, [
    run.id, run.deviceName, run.platform, run.engine, run.status, run.flow || '',
    dateValue(run.createdAt), dateValue(run.finishedAt), dateValue(run.archivedAt),
    run.steps?.length || 0,
    typeof run.verdict?.passed === 'boolean' ? run.verdict.passed : null,
    run.verdict?.reason || null,
    JSON.stringify(run),
    share?.token || null,
    share?.expiresAt ? dateValue(share.expiresAt) : null,
  ]);
}

async function findByShareToken(token) {
  const mysqlPool = await getMysqlPool();
  if (mysqlPool) {
    try {
      const [rows] = await mysqlPool.execute(
        'SELECT run_json FROM test_run_archives WHERE share_token = ? AND (share_expires_at IS NULL OR share_expires_at > NOW(3)) LIMIT 1',
        [token],
      );
      if (rows[0]?.run_json) return { run: parseJson(rows[0].run_json), storage: 'mysql' };
    } catch (error) {
      recordMysqlFailure(error);
    }
  }
  const archived = await readFileArchives();
  const run = archived.find((item) => item.share?.token === token);
  return run ? { run, storage: 'file' } : undefined;
}

async function writeFileArchive(run) {
  await mkdir(runDirectory, { recursive: true });
  await writeFile(join(runDirectory, `${run.id}.json`), JSON.stringify(run, null, 2), 'utf8');
}

async function readFileArchive(runId) {
  try {
    return JSON.parse(await readFile(join(runDirectory, `${runId}.json`), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function readFileArchives() {
  await mkdir(runDirectory, { recursive: true });
  const files = (await readdir(runDirectory)).filter((name) => /^[a-f0-9-]+\.json$/i.test(name));
  const runs = [];
  for (const file of files) {
    const run = await readFileArchive(file.replace(/\.json$/i, ''));
    if (run?.id) runs.push(run);
  }
  return runs;
}

function summaryFromRun(run, storage) {
  const comparison = run.comparison;
  const comparisonPairs = comparison?.pairs || [];
  const comparisonSummary = comparison
    ? {
        status: comparison.status || 'completed',
        checkpointName: comparison.checkpointName,
        deviceCount: comparison.devices?.length || comparison.overview?.devices.length || 1,
        pairCount: comparisonPairs.length || comparison.targets?.length || 0,
        differenceCount: comparisonPairs.length > 0
          ? comparisonPairs.reduce((total, pair) => total + (pair.differences?.length || 0), 0)
          : (comparison.targets || []).reduce(
              (total, target) => total + (target.differences?.length || 0),
              0,
            ),
        analyzed: comparison.progress?.analyzed
          ?? comparison.pairs?.filter((pair) => pair.status !== 'pending').length
          ?? 0,
      }
    : undefined;
  return {
    id: run.id,
    recordType: run.recordType,
    comparison: comparisonSummary,
    deviceName: run.deviceName,
    platform: run.platform,
    engine: run.engine,
    status: run.status,
    flow: run.flow,
    categories: classifyRun(run),
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    archivedAt: run.archivedAt,
    updatedAt: run.updatedAt,
    stepCount: run.steps?.length || 0,
    verdict: run.verdict,
    quality: run.quality
      ? {
          status: run.quality.status,
          issueCount: run.quality.issueCount || 0,
          summary: run.quality.summary || '',
        }
      : undefined,
    storage,
    share: run.share,
  };
}

function comparisonForShare(comparison, token) {
  const rewriteDevice = (device) => ({
    ...device,
    imageUrl: shareAssetUrl(token, device.imageUrl, 'comparison-overview.png'),
  });
  return {
    ...comparison,
    source: rewriteDevice(comparison.source),
    devices: comparison.devices?.map(rewriteDevice),
    pairs: comparison.pairs?.map((pair) => ({
      ...pair,
      source: rewriteDevice(pair.source),
      target: rewriteDevice(pair.target),
    })),
    targets: comparison.targets?.map((target) => ({
      ...target,
      target: rewriteDevice(target.target),
    })),
    overview: comparison.overview && {
      ...comparison.overview,
      imageUrl: shareAssetUrl(token, comparison.overview.imageUrl, 'comparison-overview.png'),
      devices: comparison.overview.devices.map(rewriteDevice),
    },
  };
}

function shareAssetUrl(token, url, fallback) {
  const matched = String(url || '').split('?')[0]
    .match(/\/assets\/((?:step-\d{2,3}|comparison-(?:device-\d+|overview))\.(?:png|jpe?g))$/i);
  return `/api/shares/${token}/assets/${matched?.[1] || fallback}`;
}

function dateValue(value) {
  return value ? new Date(value) : null;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw archiveError('归档数据损坏', 'ARCHIVE_DATA_INVALID');
  }
}

function recordMysqlFailure(error) {
  mysqlFailure = sanitizeMysqlError(error);
  retryMysqlAt = Date.now() + 15_000;
  pool = undefined;
}

function sanitizeMysqlError(error) {
  return String(error?.code || error?.message || '连接失败')
    .replace(/password[^,}]*/gi, 'password=***')
    .slice(0, 180);
}

function archiveError(message, code, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}
