export type Platform = 'android' | 'ios' | 'harmony';

export type ConnectionState = 'device' | 'unauthorized' | 'offline';

export type DeviceInfo = {
  /** Stable platform-local key, encoded in the public device ID. */
  nativeId: string;
  id: string;
  platform: Platform;
  name: string;
  model?: string;
  osVersion?: string;
  state: ConnectionState;
  /** Input coordinates, not necessarily screenshot pixels (iOS is Retina aware). */
  width?: number;
  height?: number;
  inputWidth?: number;
  inputHeight?: number;
  detail?: string;
};

export type ToolAvailability = {
  available: boolean;
  path?: string;
  version?: string;
  message: string;
};

export type WdaAvailability = {
  available: boolean;
  url: string;
  message: string;
  appBuilder?: boolean;
  xcode?: string;
};

export type Diagnostics = {
  platform: Platform;
  tools: {
    adb?: ToolAvailability;
    hdc?: ToolAvailability;
    ffmpeg?: ToolAvailability;
    wda?: WdaAvailability;
  };
  deviceCount: number;
  warnings: string[];
};

export type DeviceListResponse = {
  devices: DeviceInfo[];
  diagnostics: Diagnostics[];
  refreshedAt: string;
};

export type ActionRequest =
  | { type: 'tap'; x: number; y: number }
  | { type: 'longPress'; x: number; y: number; duration?: number }
  | { type: 'swipe'; fromX: number; fromY: number; toX: number; toY: number; duration?: number }
  | { type: 'text'; text: string; x?: number; y?: number }
  | { type: 'key'; key: 'back' | 'home' | 'recents' | 'volumeUp' | 'volumeDown' | 'power' };

export type ActionResult = {
  ok: true;
  platform: Platform;
  deviceId: string;
  action: ActionRequest['type'];
};

export type NativeTouchEvent = {
  sequence: number;
  action: ActionRequest;
  at: number;
};

export type NativeTouchStatus = {
  enabled: boolean;
  state: 'starting' | 'listening' | 'error' | 'stopped';
  error?: string;
  eventPath?: string;
  sourceWidth?: number;
  sourceHeight?: number;
  events: NativeTouchEvent[];
  sequence: number;
};

export type SyncMode = 'vision' | 'semantic' | 'relative' | 'pixel';

export type SyncResolution = {
  action: ActionRequest;
  match: 'vision' | 'semantic' | 'unmatched' | 'coordinate' | 'native';
  reason?: string;
  sourceId: string;
  targetId: string;
};

export type SyncCapture = {
  captureId: string;
  expiresAt: string;
};

export type SyncExecutionResult = SyncResolution & {
  /** True only after the receiving device accepted the mapped action. */
  executed: boolean;
};

export type UiDifferenceType = 'missing' | 'extra' | 'text' | 'layout' | 'style' | 'other';

export type UiDifference = {
  type: UiDifferenceType;
  title: string;
  description: string;
  /** Normalized coordinates relative to the target screenshot (0-1000). */
  region?: { x: number; y: number; width: number; height: number };
};

export type SyncComparisonDevice = {
  id: string;
  name: string;
  platform: Platform;
  imageUrl: string;
};

export type SyncTargetComparison = {
  status: 'compared' | 'error';
  target: SyncComparisonDevice;
  same?: boolean;
  summary?: string;
  pixelChangedRatio?: number;
  differences: UiDifference[];
  error?: string;
};

export type SyncPagePairComparison = {
  status: 'pending' | 'compared' | 'error';
  /** True only while a failed pair is being retried from an existing archive. */
  retrying?: boolean;
  source: SyncComparisonDevice;
  target: SyncComparisonDevice;
  same?: boolean;
  summary?: string;
  pixelChangedRatio?: number;
  /** Regions are normalized to the target (right-hand) device page. */
  differences: UiDifference[];
  error?: string;
};

export type SyncComparisonOverview = {
  imageUrl: string;
  width: number;
  height: number;
  devices: Array<SyncComparisonDevice & {
    /** Normalized position within the combined overview image (0-1000). */
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
};

export type SyncPageComparison = {
  id: string;
  /** Screenshots are captured before the slower visual analysis starts. */
  status?: 'running' | 'completed' | 'failed';
  trigger: 'sync' | 'manual' | 'checkpoint';
  /** User-assigned page name for a checkpoint, such as 首页 or 分类. */
  checkpointName?: string;
  /** Present for an automatic post-sync comparison, omitted for manual comparison. */
  action?: ActionRequest['type'];
  createdAt: string;
  captureCompletedAt?: string;
  analysisStartedAt?: string;
  finishedAt?: string;
  error?: string;
  /** Incremented whenever failed device pairs are re-analyzed. */
  retryCount?: number;
  retryStartedAt?: string;
  source: SyncComparisonDevice;
  /** Every captured device page, including the reference device. */
  devices?: SyncComparisonDevice[];
  /** Every unordered device pair, so three devices produce A↔B, A↔C and B↔C. */
  pairs?: SyncPagePairComparison[];
  /** Incremental progress for the background visual analysis. */
  progress?: { analyzed: number; total: number; retrying?: number };
  /** One combined image containing every connected phone page. */
  overview?: SyncComparisonOverview;
  /** Kept for automatic post-sync comparisons and older stored results. */
  targets: SyncTargetComparison[];
};

export type ClientConfig = {
  frameIntervalMs: number;
  playback: 'polling';
  limits: { textLength: number };
  vision: VisionModelStatus;
};

export type TestFlowStep = {
  index: number;
  source: string;
  type: 'tap' | 'input' | 'swipe' | 'key' | 'wait' | 'waitFor' | 'assert' | 'screenshot' | 'vision' | 'noop';
  description: string;
  target?: string;
  value?: string;
  direction?: '向上' | '向下' | '向左' | '向右';
  key?: 'back' | 'home' | 'recents' | 'volumeUp' | 'volumeDown' | 'power';
  durationMs?: number;
  timeoutMs?: number;
  thought?: string;
  /** Visible outcome expected after this action. */
  expected?: string;
};

export type TestFlowEngine = 'vision' | 'steps';

export type VisionModelStatus = {
  configured: boolean;
  provider: 'anthropic' | 'openai';
  model: string;
  missing: string[];
};

export type TestElement = {
  text: string;
  kind: string;
  bounds: { left: number; top: number; right: number; bottom: number };
  score?: number;
};

export type TestImageDiff = {
  changedRatio: number;
  averageDelta: number;
  changedRegions: Array<{ left: number; top: number; right: number; bottom: number }>;
};

export type TestElementDiff = {
  added: TestElement[];
  removed: TestElement[];
  moved: Array<{
    text: string;
    before: TestElement['bounds'];
    after: TestElement['bounds'];
    distance: number;
  }>;
};

export type TestStepStage =
  | 'pending'
  | 'preparing'
  | 'readingScreen'
  | 'recognizing'
  | 'thinking'
  | 'locating'
  | 'acting'
  | 'stabilizing'
  | 'capturingResult'
  | 'comparing'
  | 'verifying'
  | 'done'
  | 'failed';

export type TestStepLog = {
  at: string;
  stage: TestStepStage;
  message: string;
};

export type TestIssueCategory =
  | 'navigation'
  | 'no_response'
  | 'repeat_action'
  | 'unexpected_dialog'
  | 'ui_mismatch'
  | 'data_mismatch'
  | 'assertion'
  | 'recovery'
  | 'other';

export type TestIssueSeverity = 'critical' | 'major' | 'minor';

export type TestStepAudit = {
  status: 'passed' | 'issue' | 'unverified';
  expected: string;
  actual: string;
  title?: string;
  reason?: string;
  category?: TestIssueCategory;
  severity?: TestIssueSeverity;
};

export type TestIssue = {
  stepIndex: number;
  category: TestIssueCategory;
  severity: TestIssueSeverity;
  title: string;
  expected: string;
  actual: string;
  evidence?: string;
  recovered?: boolean;
};

export type TestQuality = {
  status: 'passed' | 'issues' | 'unverified';
  issueCount: number;
  summary: string;
  issues: TestIssue[];
};

export type TestExplorationPage = {
  key: string;
  title: string;
  /** Actions executed while this page was current. */
  actions: number;
  /** Click / long-press / input executed on this page. */
  interactions: number;
};

/** What one exploration run actually reached, separate from the verdict. */
export type TestExploration = {
  pageCount: number;
  interactionCount: number;
  scrollCount: number;
  actionCount: number;
  pages: TestExplorationPage[];
};

export type TestStepResult = TestFlowStep & {
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  stage: TestStepStage;
  stageLabel: string;
  stageMessage?: string;
  startedAt?: string;
  finishedAt?: string;
  logs: TestStepLog[];
  /** Stable post-action screen, reused directly as the next step's start. */
  image?: string;
  resolvedElement?: TestElement;
  imageDiff?: TestImageDiff;
  elementDiff?: TestElementDiff;
  snapshot?: { width: number; height: number; nodeCount: number };
  /** Page the action was decided on, so the report can show coverage. */
  pageKey?: string;
  pageTitle?: string;
  error?: string;
  /** Independent check of what this action was supposed to produce. */
  audit?: TestStepAudit;
};

export type TestRun = {
  id: string;
  /** Semantic tests and asynchronous page comparisons share the archive UI. */
  recordType?: 'test' | 'comparison';
  comparison?: SyncPageComparison;
  deviceId: string;
  deviceName: string;
  platform: Platform;
  status: 'queued' | 'running' | 'completed' | 'failed';
  engine: TestFlowEngine;
  /** Natural-language goal supplied to semantic testing. */
  flow: string;
  maxSteps: number;
  historyRounds?: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  steps: TestStepResult[];
  termination?: 'finished' | 'max_steps' | 'stopped';
  verdict?: {
    passed: boolean;
    reason: string;
  };
  /** Tester-style findings are separate from whether the overall task finished. */
  quality?: TestQuality;
  /** Pages and interactions reached during a vision-driven run. */
  exploration?: TestExploration;
  archivedAt?: string;
  updatedAt?: string;
  archiveStorage?: 'mysql' | 'file';
  categories?: ArchiveCategoryName[];
  share?: TestRunShare;
};

export type TestRunShare = {
  token: string;
  path: string;
  expiresAt?: string;
  url?: string;
};

export type ArchiveStorageStatus = {
  active: 'mysql' | 'file';
  configured: boolean;
  database?: string;
  host?: string;
  message: string;
};

export type ArchiveCategoryName =
  | '首页'
  | '分类'
  | '搜索'
  | '商品'
  | '购物车'
  | '结算'
  | '订单'
  | '支付'
  | '我的'
  | '其他';

export type ArchiveCategoryCount = {
  name: ArchiveCategoryName;
  count: number;
};

export type TestArchiveSummary = {
  id: string;
  recordType?: 'test' | 'comparison';
  comparison?: {
    status: NonNullable<SyncPageComparison['status']>;
    checkpointName?: string;
    deviceCount: number;
    pairCount: number;
    differenceCount: number;
    analyzed: number;
  };
  deviceName: string;
  platform: Platform;
  engine: TestFlowEngine;
  status: TestRun['status'];
  flow: string;
  createdAt: string;
  finishedAt?: string;
  archivedAt: string;
  updatedAt?: string;
  stepCount: number;
  verdict?: TestRun['verdict'];
  quality?: Pick<TestQuality, 'status' | 'issueCount' | 'summary'>;
  storage: 'mysql' | 'file';
  categories: ArchiveCategoryName[];
  share?: TestRunShare;
};

export type TestArchiveList = {
  records: TestArchiveSummary[];
  categories: ArchiveCategoryCount[];
  storage: ArchiveStorageStatus;
};

export type TestFlowPreview = {
  steps: TestFlowStep[];
  engine: TestFlowEngine;
  vision: VisionModelStatus;
  notice?: string;
};

export type ApiError = {
  error: string;
  code?: string;
  details?: string;
};
