import { useCallback, useEffect, useState } from 'react';
import type {
  ArchiveCategoryName,
  Platform,
  TestArchiveList,
  TestArchiveSummary,
  TestRun,
  TestRunShare,
  TestStepResult,
} from '../../shared/types';
import {
  fetchArchivedRun,
  fetchArchives,
  retrySyncPageComparison,
  shareArchivedTestRun,
} from '../lib/api';
import { Icon } from './Icon';
import { ScreenshotViewer } from './ScreenshotViewer';
import { ComparisonEvidence, type ComparisonPreview } from './ComparisonEvidence';
import { TestQualitySummary } from './TestQualitySummary';

type StatusFilter = 'active' | TestRun['status'] | '';

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: '', label: '全部' },
  { value: 'active', label: '执行中' },
  { value: 'completed', label: '通过' },
  { value: 'failed', label: '失败' },
];

const DEFAULT_CATEGORIES: Array<{ name: ArchiveCategoryName; count: number }> = [
  { name: '首页', count: 0 },
  { name: '分类', count: 0 },
  { name: '搜索', count: 0 },
  { name: '商品', count: 0 },
  { name: '购物车', count: 0 },
  { name: '结算', count: 0 },
  { name: '订单', count: 0 },
  { name: '支付', count: 0 },
  { name: '我的', count: 0 },
  { name: '其他', count: 0 },
];

export function ExecutionRecords({ initialRunId = '', embedded = false }: { initialRunId?: string; embedded?: boolean }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<ArchiveCategoryName | ''>('');
  const [status, setStatus] = useState<StatusFilter>('');
  const [list, setList] = useState<TestArchiveList>();
  const [selectedId, setSelectedId] = useState(initialRunId);
  const [selectedRun, setSelectedRun] = useState<TestRun>();
  const [error, setError] = useState<string>();
  const [detailError, setDetailError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(Boolean(initialRunId));
  const [share, setShare] = useState<TestRunShare>();
  const [notice, setNotice] = useState<string>();
  const [image, setImage] = useState<ComparisonPreview>();
  const [retryingComparison, setRetryingComparison] = useState(false);

  const loadList = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError(undefined);
    try {
      const result = await fetchArchives(query, { category, status });
      setList(result);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [category, query, status]);

  const loadDetail = useCallback(async (runId: string, quiet = false) => {
    if (!runId) return;
    if (!quiet) setDetailLoading(true);
    setDetailError(undefined);
    try {
      const run = await fetchArchivedRun(runId);
      setSelectedRun(run);
      setShare(run.share && !expired(run.share) ? withShareUrl(run.share) : undefined);
    } catch (reason) {
      if (!quiet) setSelectedRun(undefined);
      setDetailError(messageOf(reason));
    } finally {
      if (!quiet) setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    document.title = '执行记录 · ViewPhone';
  }, []);

  useEffect(() => {
    setQuery(new URLSearchParams(window.location.search).get('q') || '');
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadList(), 180);
    return () => window.clearTimeout(timer);
  }, [loadList]);

  useEffect(() => {
    if (!selectedId) {
      setSelectedRun(undefined);
      setDetailError(undefined);
      return;
    }
    void loadDetail(selectedId);
  }, [loadDetail, selectedId]);

  useEffect(() => {
    const hasActive = Boolean(
      list?.records.some((record) => ['queued', 'running'].includes(record.status)) ||
      (selectedRun && ['queued', 'running'].includes(selectedRun.status)),
    );
    if (!hasActive) return;
    const timer = window.setInterval(() => {
      void loadList(true);
      if (selectedId) void loadDetail(selectedId, true);
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [list?.records, loadDetail, loadList, selectedId, selectedRun?.status]);

  useEffect(() => {
    if (!image) return;
    const close = (event: KeyboardEvent) => event.key === 'Escape' && setImage(undefined);
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [image]);

  const openRecord = (record: TestArchiveSummary) => {
    setSelectedId(record.id);
    setStatus(record.status === 'queued' || record.status === 'running' ? '' : status);
    if (!embedded) {
      window.history.pushState({ record: record.id }, '', `/records/${record.id}`);
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const closeDetail = () => {
    setSelectedId('');
    setSelectedRun(undefined);
    setShare(undefined);
    if (!embedded) window.history.pushState({}, '', '/records');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const createShare = async () => {
    if (!selectedRun || !['completed', 'failed'].includes(selectedRun.status)) return;
    setNotice(undefined);
    try {
      const linked = withShareUrl(await shareArchivedTestRun(selectedRun.id));
      setShare(linked);
      setSelectedRun((current) => current && { ...current, share: linked });
      setNotice('只读分享链接已生成');
    } catch (reason) {
      setDetailError(messageOf(reason));
    }
  };

  const copyShare = async () => {
    if (!share?.url) return;
    try {
      await navigator.clipboard.writeText(share.url);
      setNotice('分享链接已复制');
    } catch {
      setNotice(`请手动复制：${share.url}`);
    }
  };

  const retryComparison = async () => {
    if (!selectedRun || retryingComparison) return;
    setRetryingComparison(true);
    setDetailError(undefined);
    setNotice(undefined);
    try {
      const comparison = await retrySyncPageComparison(selectedRun.id);
      setSelectedRun((current) => current && {
        ...current,
        status: 'running',
        finishedAt: undefined,
        comparison,
      });
      setNotice('已开始使用归档截图重跑失败的设备组合');
      await loadDetail(selectedRun.id, true);
    } catch (reason) {
      setDetailError(messageOf(reason));
    } finally {
      setRetryingComparison(false);
    }
  };

  const RecordsShell = embedded ? 'div' : 'main';

  return (
    <RecordsShell className={`records-shell ${embedded ? 'embedded' : ''}`}>
      {!embedded && <header className="records-header">
        <a className="records-brand" href="/" aria-label="返回 ViewPhone 工作台">
          <span className="brand-symbol"><span /><span /></span>
          <span>ViewPhone</span>
          <small>EXECUTION LOG</small>
        </a>
        <div className="records-header-actions">
          <span className={`records-auto-state ${list?.storage.active === 'mysql' ? 'mysql' : 'local'}`}>
            <span />
            {list?.storage.active === 'mysql' ? 'MySQL 自动归档' : '本机自动归档'}
          </span>
          <a className="records-back-button" href="/">
            <Icon name="back" />返回工作台
          </a>
        </div>
      </header>}

      {selectedId ? (
        <RecordDetail
          run={selectedRun}
          loading={detailLoading}
          error={detailError}
          share={share}
          notice={notice}
          onBack={closeDetail}
          onRefresh={() => void loadDetail(selectedId)}
          onShare={() => void createShare()}
          onCopyShare={() => void copyShare()}
          onRetryComparison={() => void retryComparison()}
          retryingComparison={retryingComparison}
          onPreview={setImage}
        />
      ) : (
        <div className="records-content">
          <section className="records-hero">
            <div>
              <span className="eyebrow">AUTOMATIC TEST ARCHIVE</span>
              <h1>执行记录</h1>
            <p>语义测试与页面打点都会自动保存截图、完成对比并归档。可按页面名称、自然语言、流程分类和执行状态检索。</p>
            </div>
            <div className="records-hero-stat">
              <span>当前结果</span>
              <strong>{list?.records.length ?? 0}</strong>
              <small>条记录</small>
            </div>
          </section>

          <section className="records-filters" aria-label="执行记录筛选">
            <label className="records-search">
              <Icon name="search" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索页面或自然语言，例如：首页、分类、我的、微信支付"
              />
              {query && <button type="button" onClick={() => setQuery('')}>清除</button>}
            </label>
            <div className="records-status-filters" role="group" aria-label="执行状态">
              {STATUS_FILTERS.map((item) => (
                <button
                  type="button"
                  key={item.label}
                  className={status === item.value ? 'active' : ''}
                  onClick={() => setStatus(item.value)}
                  aria-pressed={status === item.value}
                >{item.label}</button>
              ))}
            </div>
            <div className="records-categories" aria-label="流程分类">
              <button
                type="button"
                className={!category ? 'active' : ''}
                onClick={() => setCategory('')}
                aria-pressed={!category}
              >全部分类</button>
              {(list?.categories || DEFAULT_CATEGORIES).map((item) => (
                <button
                  type="button"
                  key={item.name}
                  className={category === item.name ? 'active' : ''}
                  onClick={() => setCategory(item.name)}
                  aria-pressed={category === item.name}
                >
                  {item.name}<small>{item.count}</small>
                </button>
              ))}
            </div>
          </section>

          <div className="records-list-heading">
            <div>
              <span className="eyebrow">RUN HISTORY</span>
              <h2>{statusName(status)}测试</h2>
            </div>
            <span>{loading ? '正在加载…' : `${list?.records.length ?? 0} 条`}</span>
          </div>
          {error && <p className="records-error" role="alert"><Icon name="alert" />{error}</p>}
          {loading && !list && <RecordsLoading />}
          {!loading && list?.records.length === 0 && (
            <section className="records-empty">
              <Icon name="archive" />
              <h2>没有匹配的执行记录</h2>
              <p>调整搜索词或分类；新的测试开始时会自动出现在这里。</p>
            </section>
          )}
          <section className="records-grid" aria-label="执行记录列表">
            {list?.records.map((record) => (
              <button
                type="button"
                className={`record-card record-${record.status}`}
                key={record.id}
                onClick={() => openRecord(record)}
              >
                <header>
                  <span className={`record-status status-${record.status}`}>
                    {record.status === 'queued' || record.status === 'running' ? <span className="spinner" /> : <Icon name={record.status === 'completed' ? 'check' : 'alert'} />}
                    {executionStatusName(record.status)}
                  </span>
                  <span>{formatTime(record.updatedAt || record.archivedAt)}</span>
                </header>
                <p className="record-flow">{record.flow || '未填写测试目标'}</p>
                <div className="record-categories">
                  {record.comparison?.checkpointName && (
                    <span className="record-checkpoint-chip">检查点 · {record.comparison.checkpointName}</span>
                  )}
                  {record.categories.map((name) => <span key={name}>{name}</span>)}
                </div>
                <div className="record-meta">
                  <span><Icon name="phone" />{record.deviceName}</span>
                  <span>{platformName(record.platform)}</span>
                  {record.recordType === 'comparison' ? <>
                    <span>{record.comparison?.deviceCount || 0} 台设备</span>
                    <span>{record.comparison?.pairCount || 0} 组互比</span>
                    <span>{record.comparison?.analyzed || 0}/{record.comparison?.pairCount || 0} 已完成</span>
                  </> : <>
                    <span>{record.stepCount} 步</span>
                    <span>{record.engine === 'vision' ? '视觉智能' : '离线步骤'}</span>
                  </>}
                </div>
                <footer>
                  <span>{record.quality?.issueCount
                    ? record.quality.summary
                    : record.verdict?.reason || (record.recordType === 'comparison'
                    ? record.status === 'running'
                      ? '截图已保存，正在逐组分析设备差异'
                      : '查看多设备页面差异与截图证据'
                    : record.status === 'failed'
                      ? '查看失败步骤与页面差异'
                      : '查看逐步执行证据')}</span>
                  <span className="record-open">打开 <Icon name="chevron" /></span>
                </footer>
              </button>
            ))}
          </section>
        </div>
      )}
      {image && <ScreenshotViewer image={image} onClose={() => setImage(undefined)} />}
    </RecordsShell>
  );
}

function RecordDetail({
  run,
  loading,
  error,
  share,
  notice,
  onBack,
  onRefresh,
  onShare,
  onCopyShare,
  onRetryComparison,
  retryingComparison,
  onPreview,
}: {
  run?: TestRun;
  loading: boolean;
  error?: string;
  share?: TestRunShare;
  notice?: string;
  onBack: () => void;
  onRefresh: () => void;
  onShare: () => void;
  onCopyShare: () => void;
  onRetryComparison: () => void;
  retryingComparison: boolean;
  onPreview: (preview: ComparisonPreview) => void;
}) {
  if (loading && !run) return <RecordsLoading />;
  if (!run) {
    return (
      <section className="records-empty records-detail-empty">
        <Icon name="alert" />
        <h2>无法读取这条执行记录</h2>
        <p>{error || '记录可能尚未归档或已被删除。'}</p>
        <button type="button" onClick={onBack}>返回执行记录</button>
      </section>
    );
  }

  const active = run.status === 'queued' || run.status === 'running';
  const comparison = run.recordType === 'comparison' ? run.comparison : undefined;
  const hasFailedComparisonPairs = Boolean(
    comparison?.pairs?.some((pair) => pair.status === 'error') ?? comparison?.targets?.some(
      (target) => target.status === 'error',
    ),
  );
  const checkpointName = comparison?.checkpointName;
  const detailTitle = comparison
    ? checkpointName
      ? `页面打点 · ${checkpointName}`
      : active
        ? '页面差异分析中'
        : run.status === 'failed'
          ? '页面差异分析失败'
          : '页面差异已归档'
    : run.status === 'completed'
      ? run.quality?.issueCount ? '目标完成 · 发现问题' : '测试通过'
      : run.status === 'failed'
        ? '测试失败'
        : '测试执行中';
  return (
    <div className="record-detail-content">
      <button type="button" className="records-detail-back" onClick={onBack}>
        <Icon name="back" />全部执行记录
      </button>
      <section className="record-detail-hero">
        <div className="record-detail-title">
          <span className="eyebrow">{checkpointName
            ? 'PAGE CHECKPOINT · MULTI-DEVICE UI EVIDENCE'
            : comparison
              ? 'MULTI-DEVICE UI EVIDENCE'
              : 'EXECUTION EVIDENCE'}</span>
          <h1>{detailTitle}</h1>
          <p>{run.verdict?.reason || run.error || (active
            ? comparison
              ? '截图已经保存，视觉分析正在后台继续，可以离开此页面。'
              : '新步骤会自动保存到执行记录。'
            : '查看每一步执行结果和页面差异。')}</p>
          <div className="record-categories detail-categories">
            {(run.categories || ['其他']).map((name) => <span key={name}>{name}</span>)}
          </div>
          {run.quality && (
            <span className={`record-quality-badge quality-${run.quality.status}`}>
              {run.quality.issueCount > 0 ? `${run.quality.issueCount} 个问题` : run.quality.status === 'unverified' ? '部分未确认' : '独立检查通过'}
            </span>
          )}
        </div>
        <span className={`record-large-status status-${run.status} ${run.quality?.issueCount ? 'has-issues' : ''}`}>
          {active
            ? <span className="spinner" />
            : <Icon name={run.status === 'completed' && !run.quality?.issueCount ? 'check' : 'alert'} />}
          {run.quality?.issueCount ? '发现问题' : executionStatusName(run.status)}
        </span>
      </section>
      <section className="record-detail-meta">
        <span><small>设备</small><strong>{run.deviceName}</strong></span>
        <span><small>平台</small><strong>{platformName(run.platform)}</strong></span>
        <span><small>执行时间</small><strong>{formatTime(run.startedAt || run.createdAt)}</strong></span>
        <span><small>耗时</small><strong>{formatDuration(run)}</strong></span>
      </section>
      <section className="record-goal">
        <span>{checkpointName ? '页面打点名称' : '自然语言目标'}</span>
        <p>{run.flow}</p>
      </section>
      <div className="records-actions-row">
        <span className={`auto-save-status ${active ? 'saving' : 'saved'}`}>
          <span />
          {active ? '每步自动保存中' : '已自动归档'}
          <small>{run.archivedAt ? formatTime(run.archivedAt) : ''}</small>
        </span>
        <div>
          {error && <span className="records-inline-error">{error}</span>}
          {notice && <span className="records-inline-notice">{notice}</span>}
          {hasFailedComparisonPairs && (
            <button
              type="button"
              className="records-retry-button"
              onClick={onRetryComparison}
              disabled={active || retryingComparison}
              title="使用这条归档中已保存的手机截图重新进行视觉对比"
            >
              {retryingComparison ? <span className="spinner" /> : <Icon name="refresh" />}
              {retryingComparison ? '正在启动重跑' : '重跑失败对比'}
            </button>
          )}
          <button type="button" className="records-secondary-button" onClick={onRefresh}>
            <Icon name="refresh" />刷新
          </button>
          <button type="button" className="records-secondary-button" onClick={onShare} disabled={active}>
            <Icon name="share" />分享
          </button>
        </div>
      </div>
      {share && (
        <div className="record-share-box">
          <span><Icon name="lock" />只读分享链接</span>
          <input readOnly value={share.url || share.path} aria-label="只读分享链接" />
          <button type="button" onClick={onCopyShare}>复制</button>
          <a href={share.url || share.path} target="_blank" rel="noreferrer">打开</a>
        </div>
      )}

      {run.quality && (
        <TestQualitySummary
          quality={run.quality}
          onPreview={(url, title) => onPreview({ url, title, regions: [] })}
        />
      )}

      <section className="record-steps-heading">
        <div>
          <span className="eyebrow">{comparison ? 'MUTUAL DEVICE REVIEW' : 'STEP BY STEP'}</span>
          <h2>{comparison ? '多设备页面差异' : '逐步执行过程'}</h2>
        </div>
        <span>{comparison ? `${comparison.progress?.total || comparison.pairs?.length || 0} 组设备互比` : `${run.steps.length} 个动作`}</span>
      </section>
      {comparison ? (
        <ComparisonEvidence comparison={comparison} onPreview={onPreview} compactOverview />
      ) : (
        <>
          {run.steps.length === 0 && <p className="records-empty-line">尚未产生执行步骤，请稍后刷新。</p>}
          <div className="record-steps">
            {run.steps.map((step) => (
              <RecordStep
                key={step.index}
                step={step}
                onPreview={(url, title) => onPreview({ url, title, regions: [] })}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function RecordStep({
  step,
  onPreview,
}: {
  step: TestStepResult;
  onPreview: (url: string, title: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <article className={`record-step record-step-${step.status}`}>
      <button type="button" className="record-step-summary" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <span className="record-step-number">{String(step.index).padStart(2, '0')}</span>
        <span className="record-step-copy">
          <strong>{step.description}</strong>
          <small>{step.source}{step.stageMessage ? ` · ${step.stageMessage}` : ''}</small>
        </span>
        <span className={`record-step-state status-${step.status}`}>
          {step.status === 'running' ? step.stageLabel : stepStatusName(step.status)}
        </span>
        <Icon name="chevron" className={expanded ? 'test-chevron open' : 'test-chevron'} />
      </button>
      {expanded && (
        <div className="record-step-body">
          {step.error && <p className="records-error"><Icon name="alert" />{step.error}</p>}
          {step.thought && <div className="record-thought"><span>视觉判断</span><p>{step.thought}</p></div>}
          {step.audit && <RecordStepAudit audit={step.audit} />}
          <div className="record-evidence-grid">
            <div className="record-screenshot-column">
              {step.image ? (
                <button type="button" className="record-screenshot" onClick={() => onPreview(step.image!, `第 ${step.index} 步 · 执行结果`)}>
                  <img src={step.image} alt={`第 ${step.index} 步结果截图`} />
                  <span><Icon name="expand" />放大查看</span>
                </button>
              ) : <div className="record-screenshot empty"><span>{step.status === 'running' ? '正在生成执行结果…' : '暂无截图'}</span></div>}
            </div>
            <div className="record-differences">
              {step.resolvedElement && (
                <div className="record-resolved">
                  <small>识别目标</small>
                  <strong>{step.resolvedElement.text || step.resolvedElement.kind}</strong>
                  <span>{Math.round(step.resolvedElement.score || 0)}% 置信度</span>
                </div>
              )}
              {step.imageDiff && (
                <div className="record-metrics">
                  <span>画面差异 <strong>{percent(step.imageDiff.changedRatio)}</strong></span>
                  <span>平均像素差 <strong>{percent(step.imageDiff.averageDelta)}</strong></span>
                  <span>识别元素 <strong>{step.snapshot?.nodeCount ?? '—'}</strong></span>
                </div>
              )}
              {step.elementDiff && <ElementChanges diff={step.elementDiff} />}
            </div>
          </div>
        </div>
      )}
    </article>
  );
}

function RecordStepAudit({ audit }: { audit: NonNullable<TestStepResult['audit']> }) {
  return (
    <div className={`record-step-audit audit-${audit.status}`}>
      <span>{audit.status === 'passed' ? '步骤校验通过' : audit.status === 'issue' ? '测试问题' : '未完成校验'}</span>
      {audit.title && <strong>{audit.title}</strong>}
      <dl>
        <div><dt>预期</dt><dd>{audit.expected}</dd></div>
        <div><dt>实际</dt><dd>{audit.actual}</dd></div>
      </dl>
      {audit.reason && <p>{audit.reason}</p>}
    </div>
  );
}

function ElementChanges({ diff }: { diff: NonNullable<TestStepResult['elementDiff']> }) {
  const groups = [
    ['新增', 'added', diff.added.map((item) => item.text)],
    ['消失', 'removed', diff.removed.map((item) => item.text)],
    ['移动', 'moved', diff.moved.map((item) => item.text)],
  ] as const;
  if (!groups.some(([, , items]) => items.length)) {
    return <p className="records-empty-line">未识别到文字元素新增、消失或移动</p>;
  }
  return (
    <div className="record-element-diffs">
      {groups.filter(([, , items]) => items.length > 0).map(([label, tone, items]) => (
        <div key={tone} className={`record-diff record-diff-${tone}`}>
          <small>{label}</small>
          <div>{items.slice(0, 16).map((item, index) => <em key={`${item}-${index}`}>{item}</em>)}</div>
        </div>
      ))}
    </div>
  );
}

function RecordsLoading() {
  return <div className="records-loading"><span className="spinner" /><span>正在读取执行记录…</span></div>;
}

function executionStatusName(status: TestRun['status']) {
  return status === 'queued' ? '待执行' : status === 'running' ? '执行中' : status === 'completed' ? '通过' : '失败';
}

function stepStatusName(status: TestStepResult['status']) {
  return status === 'passed' ? '通过' : status === 'failed' ? '失败' : status === 'skipped' ? '未执行' : '等待';
}

function statusName(status: StatusFilter) {
  return status === 'active' ? '执行中' : status === 'completed' ? '通过' : status === 'failed' ? '失败' : '全部';
}

function platformName(platform: Platform) {
  return platform === 'android' ? 'Android' : platform === 'ios' ? 'iOS' : 'HarmonyOS';
}

function formatTime(value?: string) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function formatDuration(run: TestRun) {
  if (!run.startedAt || !run.finishedAt) return '执行中';
  const milliseconds = Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt));
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)} 秒`;
  return `${Math.floor(milliseconds / 60_000)} 分 ${Math.round((milliseconds % 60_000) / 1000)} 秒`;
}

function percent(value: number) {
  return `${(Math.max(0, Number(value) || 0) * 100).toFixed(1)}%`;
}

function expired(share: TestRunShare) {
  return Boolean(share.expiresAt && Date.parse(share.expiresAt) <= Date.now());
}

function withShareUrl(share: TestRunShare): TestRunShare {
  return { ...share, url: new URL(share.path, window.location.origin).toString() };
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
