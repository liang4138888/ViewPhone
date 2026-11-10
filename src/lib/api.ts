import type {
  ActionRequest,
  ActionResult,
  ApiError,
  DeviceListResponse,
  NativeTouchStatus,
  ClientConfig,
  SyncMode,
  SyncCapture,
  SyncExecutionResult,
  SyncPageComparison,
  TestArchiveList,
  TestFlowPreview,
  TestRun,
  TestRunShare,
} from '../../shared/types';

export class ApiRequestError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => undefined)) as T | ApiError | undefined;
  if (!response.ok) {
    const error = payload as ApiError | undefined;
    throw new ApiRequestError(
      error?.error || `请求失败（HTTP ${response.status}）`,
      response.status,
      error?.code,
    );
  }
  return payload as T;
}

export async function fetchDevices(refresh = false): Promise<DeviceListResponse> {
  const response = await fetch(`/api/devices${refresh ? '?refresh=1' : ''}`, {
    cache: 'no-store',
  });
  return parseResponse<DeviceListResponse>(response);
}

export async function fetchClientConfig(): Promise<ClientConfig> {
  const response = await fetch('/api/config', { cache: 'no-store' });
  return parseResponse<ClientConfig>(response);
}

export async function sendAction(deviceId: string, action: ActionRequest): Promise<ActionResult> {
  const response = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(action),
  });
  return parseResponse<ActionResult>(response);
}

export async function sendSyncAction(
  sourceId: string,
  targetId: string,
  action: ActionRequest,
  mode: SyncMode,
  captureId?: string,
): Promise<SyncExecutionResult> {
  const response = await fetch('/api/sync/actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceId, targetId, action, mode, captureId, execute: true }),
  });
  return parseResponse<SyncExecutionResult>(response);
}

export async function captureSyncSource(sourceId: string): Promise<SyncCapture> {
  const response = await fetch('/api/sync/captures', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceId }),
  });
  return parseResponse<SyncCapture>(response);
}

export async function startSyncPageComparison(
  sourceId: string,
  targetIds: string[],
  action?: ActionRequest,
  checkpointName?: string,
): Promise<SyncPageComparison> {
  const normalizedCheckpointName = checkpointName?.trim();
  const response = await fetch('/api/sync/comparisons', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceId,
      targetIds,
      ...(action ? { action } : {}),
      ...(normalizedCheckpointName ? { checkpointName: normalizedCheckpointName } : {}),
    }),
  });
  return parseResponse<SyncPageComparison>(response);
}

export async function fetchSyncPageComparison(id: string): Promise<SyncPageComparison> {
  const response = await fetch(`/api/sync/comparisons/${encodeURIComponent(id)}`, {
    cache: 'no-store',
  });
  return parseResponse<SyncPageComparison>(response);
}

export async function retrySyncPageComparison(id: string): Promise<SyncPageComparison> {
  const response = await fetch(`/api/archives/${encodeURIComponent(id)}/comparison/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return parseResponse<SyncPageComparison>(response);
}

export async function openDeveloperSettings(deviceId: string): Promise<{ ok: true }> {
  const response = await fetch(
    `/api/devices/${encodeURIComponent(deviceId)}/open-developer-settings`,
    { method: 'POST' },
  );
  return parseResponse<{ ok: true }>(response);
}

export async function startNativeTouch(deviceId: string): Promise<NativeTouchStatus> {
  const response = await fetch(
    `/api/devices/${encodeURIComponent(deviceId)}/native-touch/start`,
    { method: 'POST' },
  );
  return parseResponse<NativeTouchStatus>(response);
}

export async function stopNativeTouch(deviceId: string): Promise<NativeTouchStatus> {
  const response = await fetch(
    `/api/devices/${encodeURIComponent(deviceId)}/native-touch/stop`,
    { method: 'POST' },
  );
  return parseResponse<NativeTouchStatus>(response);
}

export async function previewTestFlow(
  flow: string,
  engine: 'vision' | 'steps' = 'vision',
): Promise<TestFlowPreview> {
  const response = await fetch('/api/test-flows/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ flow, engine }),
  });
  return parseResponse<TestFlowPreview>(response);
}

export async function startTestRun(
  deviceId: string,
  flow: string,
  engine: 'vision' | 'steps' = 'vision',
): Promise<TestRun> {
  const response = await fetch('/api/test-runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, flow, engine }),
  });
  return parseResponse<TestRun>(response);
}

export async function fetchTestRun(runId: string): Promise<TestRun> {
  const response = await fetch(`/api/test-runs/${encodeURIComponent(runId)}`, {
    cache: 'no-store',
  });
  return parseResponse<TestRun>(response);
}

export async function fetchArchives(
  query = '',
  options: { category?: string; status?: 'active' | TestRun['status'] | '' } = {},
): Promise<TestArchiveList> {
  const search = new URLSearchParams();
  if (query.trim()) search.set('q', query.trim());
  if (options.category) search.set('category', options.category);
  if (options.status) search.set('status', options.status);
  const suffix = search.size ? `?${search.toString()}` : '';
  const response = await fetch(`/api/archives${suffix}`, { cache: 'no-store' });
  return parseResponse<TestArchiveList>(response);
}

export async function fetchArchivedRun(runId: string): Promise<TestRun> {
  const response = await fetch(`/api/archives/${encodeURIComponent(runId)}`, {
    cache: 'no-store',
  });
  const payload = await parseResponse<{ run: TestRun }>(response);
  return payload.run;
}

export async function archiveTestRun(runId: string): Promise<TestRun> {
  const response = await fetch(`/api/test-runs/${encodeURIComponent(runId)}/archive`, {
    method: 'POST',
  });
  const payload = await parseResponse<{ record: TestRun }>(response);
  return payload.record;
}

export async function shareArchivedTestRun(runId: string): Promise<TestRunShare> {
  const response = await fetch(`/api/archives/${encodeURIComponent(runId)}/share`, {
    method: 'POST',
  });
  return parseResponse<TestRunShare>(response);
}

export async function fetchSharedTestRun(token: string): Promise<TestRun> {
  const response = await fetch(`/api/shares/${encodeURIComponent(token)}`, {
    cache: 'no-store',
  });
  return parseResponse<TestRun>(response);
}

export async function fetchNativeTouch(
  deviceId: string,
  after: number,
): Promise<NativeTouchStatus> {
  const response = await fetch(
    `/api/devices/${encodeURIComponent(deviceId)}/native-touch?after=${after}`,
    { cache: 'no-store' },
  );
  return parseResponse<NativeTouchStatus>(response);
}

export function frameUrl(deviceId: string): string {
  return `/api/devices/${encodeURIComponent(deviceId)}/frame`;
}
