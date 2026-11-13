import { useEffect, useRef, useState } from 'react';
import type {
  DeviceInfo,
  TestFlowStep,
  TestRun,
  TestRunShare,
  TestStepResult,
  VisionModelStatus,
} from '../../shared/types';
import {
  archiveTestRun,
  fetchTestRun,
  previewTestFlow,
  shareArchivedTestRun,
  startTestRun,
  stopTestRun,
} from '../lib/api';
import { Icon } from './Icon';
import { ScreenshotViewer } from './ScreenshotViewer';
import { TestQualitySummary } from './TestQualitySummary';

type Props = {
  open: boolean;
  devices: DeviceInfo[];
  onRunningChange: (running: boolean) => void;
  onClose: () => void;
  embedded?: boolean;
};

const sample = '点击我的 → 向上滑动 → 点击待支付 → 等待页面出现全部订单';

export function SemanticTestPanel({ open, devices, onRunningChange, onClose, embedded = false }: Props) {
  const [flow, setFlow] = useState(sample);
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<TestFlowStep[]>([]);
  const [previewError, setPreviewError] = useState<string>();
  const [previewNotice, setPreviewNotice] = useState<string>();
  const [visionStatus, setVisionStatus] = useState<VisionModelStatus>();
  const [engine, setEngine] = useState<'vision' | 'steps'>('vision');
  const [runs, setRuns] = useState<TestRun[]>([]);
  const [activeRunId, setActiveRunId] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [startError, setStartError] = useState<string>();
  const [previewImage, setPreviewImage] = useState<{ url: string; title: string }>();
  const [archiveError, setArchiveError] = useState<string>();
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [share, setShare] = useState<TestRunShare>();
  const [actionNotice, setActionNotice] = useState<string>();
  const parseSequence = useRef(0);
  const deviceIdsKey = devices.map((device) => device.id).join('|');

  useEffect(() => {
    if (!open) return;
    setSelectedDeviceIds((current) => {
      const retained = current.filter((id) => devices.some((device) => device.id === id));
      if (retained.length === current.length && current.length > 0) return current;
      if (current.length > 0) return retained;
      return devices[0] ? [devices[0].id] : [];
    });
  }, [deviceIdsKey, open]);

  useEffect(() => {
    if (!open) return;
    const text = flow.trim();
    if (!text) {
      setPreview([]);
      setPreviewError(undefined);
      return;
    }
    const sequence = ++parseSequence.current;
    const timer = window.setTimeout(() => {
      void previewTestFlow(text, engine)
        .then((result) => {
          if (sequence !== parseSequence.current) return;
          setPreview(result.steps);
          setVisionStatus(result.vision);
          setPreviewNotice(result.notice);
          setPreviewError(undefined);
          if (!result.vision.configured) setEngine('steps');
        })
        .catch((error) => {
          if (sequence !== parseSequence.current) return;
          setPreview([]);
          setPreviewError(messageOf(error));
        });
    }, 320);
    return () => window.clearTimeout(timer);
  }, [engine, flow, open]);

  const activeRuns = runs.filter((testRun) => ['queued', 'running'].includes(testRun.status));
  const activeRunKey = activeRuns.map((testRun) => testRun.id).sort().join('|');
  const selectedRun = runs.find((testRun) => testRun.id === activeRunId) || runs[0];

  useEffect(() => {
    if (!activeRunKey) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      const ids = activeRunKey.split('|');
      const updates = await Promise.all(ids.map(async (id) => {
        try {
          return { id, run: await fetchTestRun(id) };
        } catch (error) {
          return { id, error: messageOf(error) };
        }
      }));
      if (cancelled) return;
      setRuns((current) => current.map((testRun) => {
        const update = updates.find((item) => item.id === testRun.id);
        if (!update) return testRun;
        if (update.run) return update.run;
        return { ...testRun, status: 'failed', error: update.error };
      }));
      if (updates.some((update) => update.run && ['queued', 'running'].includes(update.run.status))) {
        timer = window.setTimeout(poll, 350);
      }
    };
    timer = window.setTimeout(poll, 300);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [activeRunKey]);

  useEffect(() => {
    if (!previewImage) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewImage(undefined);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [previewImage]);

  const runsToArchiveKey = runs
    .filter((testRun) => ['completed', 'failed'].includes(testRun.status) && !testRun.archivedAt)
    .map((testRun) => testRun.id)
    .sort()
    .join('|');

  useEffect(() => {
    if (!runsToArchiveKey) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const ids = runsToArchiveKey.split('|');
      void Promise.allSettled(ids.map((id) => archiveTestRun(id))).then((results) => {
        if (cancelled) return;
        const archived = new Map<string, TestRun>();
        const failures: string[] = [];
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') archived.set(ids[index], result.value);
          else failures.push(messageOf(result.reason));
        });
        if (archived.size > 0) {
          setRuns((current) => current.map((testRun) => archived.get(testRun.id) || testRun));
          const sampleRecord = archived.values().next().value as TestRun | undefined;
          setActionNotice(
            failures.length
              ? `${archived.size} 台设备结果已归档，${failures.length} 台归档失败`
              : `${archived.size} 台设备测试结果已归档到${storageName(sampleRecord?.archiveStorage)}`,
          );
        }
        if (failures.length > 0) setActionNotice(`自动归档未完成：${failures[0]}`);
      });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [runsToArchiveKey]);

  useEffect(() => {
    onRunningChange(activeRuns.length > 0);
  }, [activeRuns.length, onRunningChange]);

  useEffect(() => () => onRunningChange(false), [onRunningChange]);

  useEffect(() => {
    setShare(
      selectedRun?.share && !isExpired(selectedRun.share)
        ? withShareUrl(selectedRun.share)
        : undefined,
    );
  }, [selectedRun?.id, selectedRun?.share?.token, selectedRun?.share?.expiresAt]);

  const active = activeRuns.length > 0;
  const selectedDevices = devices.filter((device) => selectedDeviceIds.includes(device.id));
  const selectionLocked = Boolean(active || starting);
  const allDevicesSelected = devices.length > 0 && selectedDeviceIds.length === devices.length;
  const canWrite = Boolean(flow.trim() && (engine === 'vision' || (!previewError && preview.length > 0)));
  const canStart = Boolean(selectedDevices.length > 0 && canWrite && !active && !starting);
  const resultSteps = selectedRun?.steps || preview.map(toPendingStep);
  const storage = selectedRun?.archiveStorage
    ? { active: selectedRun.archiveStorage, message: `当前记录保存在${storageName(selectedRun.archiveStorage)}` }
    : undefined;

  const toggleDevice = (id: string, checked: boolean) => {
    setSelectedDeviceIds((current) => checked
      ? current.includes(id) ? current : [...current, id]
      : current.filter((deviceId) => deviceId !== id));
  };

  const start = async () => {
    if (!canStart) return;
    setStarting(true);
    setStartError(undefined);
    setShare(undefined);
    setActionNotice(undefined);
    setArchiveError(undefined);
    setRuns([]);
    setActiveRunId(undefined);
    const targets = [...selectedDevices];
    const results = await Promise.allSettled(
      targets.map((device) => startTestRun(device.id, flow, engine)),
    );
    const started = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    const failures = results.flatMap((result, index) => result.status === 'rejected'
      ? [{ name: targets[index].name, error: messageOf(result.reason) }]
      : []);
    setRuns(started);
    setActiveRunId(started[0]?.id);
    if (failures.length > 0) {
      setStartError(
        `${started.length} 台设备已启动，${failures.length} 台未启动：${failures
          .map((failure) => `${failure.name}（${failure.error}）`)
          .join('；')}`,
      );
    }
    setStarting(false);
  };

  const stopActiveRuns = async () => {
    if (!active || stopping) return;
    setStopping(true);
    setStartError(undefined);
    try {
      await Promise.all(activeRuns.map((testRun) => stopTestRun(testRun.id)));
      setActionNotice('已发送停止请求，当前动作执行完毕后结束');
    } catch (error) {
      setStartError(`停止失败：${messageOf(error)}`);
    } finally {
      setStopping(false);
    }
  };

  const createShare = async () => {
    if (!selectedRun || !['completed', 'failed'].includes(selectedRun.status)) return;
    setArchiveBusy(true);
    setArchiveError(undefined);
    try {
      if (!selectedRun.archivedAt) {
        const archived = await archiveTestRun(selectedRun.id);
        setRuns((current) => current.map((testRun) => testRun.id === archived.id ? archived : testRun));
      }
      const shared = await shareArchivedTestRun(selectedRun.id);
      const linked = withShareUrl(shared);
      setShare(linked);
      setRuns((current) => current.map((testRun) => testRun.id === selectedRun.id
        ? { ...testRun, share: linked }
        : testRun));
      setActionNotice('只读分享链接已生成，链接到期前可重复打开');
    } catch (error) {
      setArchiveError(messageOf(error));
    } finally {
      setArchiveBusy(false);
    }
  };

  const copyShare = async () => {
    if (!share?.url) return;
    try {
      await navigator.clipboard.writeText(share.url);
      setActionNotice('分享链接已复制');
    } catch (error) {
      setActionNotice(`请手动复制链接：${share.url}`);
    }
  };

  if (!open) return null;
  return (
    <aside className={`test-drawer semantic-test-sidepanel ${embedded ? 'embedded' : ''}`} aria-label="语义测试执行过程">
        <header className="test-drawer-heading">
          <div>
            <span className="eyebrow">SEMANTIC TEST RUNNER</span>
            <h2>语义测试流程</h2>
            <p>用中文描述测试目标，ViewPhone 会逐轮识别当前画面并操作；每一步只保留一张执行结果和页面差异。</p>
          </div>
          <div className="test-heading-actions">
            <a className="test-archive-link" href="/records" target="_blank" rel="noreferrer">
              <Icon name="archive" />
              执行记录
            </a>
            {!embedded && (
              <button
                className="icon-button"
                onClick={onClose}
                disabled={Boolean(active)}
                aria-label="关闭语义测试"
                title={active ? '测试执行中，完成后再关闭' : '关闭语义测试'}
              >
                <Icon name="close" />
              </button>
            )}
          </div>
        </header>

        <div className="test-panel-scroll">
          <div className="test-composer">
          <div className="test-device-row">
            <fieldset className="test-device-picker" disabled={selectionLocked}>
              <legend>
                <span>测试设备</span>
                <small>{selectedDeviceIds.length} / {devices.length} 台已选</small>
              </legend>
              <div className="test-device-options">
                {devices.map((device) => {
                  const checked = selectedDeviceIds.includes(device.id);
                  return (
                    <label className={`test-device-option ${checked ? 'selected' : ''}`} key={device.id}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) => toggleDevice(device.id, event.target.checked)}
                      />
                      <span className="test-device-checkbox"><Icon name="check" /></span>
                      <span className="test-device-option-copy">
                        <strong>{device.name}</strong>
                        <small>{platformName(device.platform)}</small>
                      </span>
                    </label>
                  );
                })}
                {devices.length === 0 && <span className="test-device-empty">暂无在线设备</span>}
              </div>
              {devices.length > 0 && (
                <button
                  type="button"
                  className="test-device-select-all"
                  onClick={() => setSelectedDeviceIds(allDevicesSelected ? [] : devices.map((device) => device.id))}
                >
                  {allDevicesSelected ? '取消全选' : '全选'}
                </button>
              )}
            </fieldset>
            <span className="test-local-note"><span />多设备并行执行</span>
          </div>
          <div className="test-engine-row" role="group" aria-label="语义识别模式">
            <button
              type="button"
              className={engine === 'vision' ? 'active' : ''}
              onClick={() => setEngine('vision')}
              disabled={Boolean(active) || visionStatus?.configured === false}
              title={visionStatus?.configured === false ? `缺少：${visionStatus.missing.join('、')}` : '视觉模型逐步看图并操作'}
            >
              视觉智能
              {visionStatus?.configured === false && <small>未配置</small>}
            </button>
            <button
              type="button"
              className={engine === 'steps' ? 'active' : ''}
              onClick={() => setEngine('steps')}
              disabled={Boolean(active)}
            >离线步骤</button>
            <span>
              {visionStatus?.configured
                ? `${visionStatus.provider === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容'} · ${visionStatus.model}`
                : previewNotice || '视觉模式需要配置模型，离线模式仍可使用'}
            </span>
          </div>
          <label className="test-flow-label">
            <span>测试流程</span>
            <textarea
              value={flow}
              onChange={(event) => setFlow(event.target.value)}
              disabled={Boolean(active)}
              rows={4}
              maxLength={4000}
              placeholder="例如：点击我的 → 向上滑动 → 点击待支付 → 检查页面是否出现全部订单"
            />
          </label>
          <div className="test-composer-actions">
            <span>{engine === 'vision' ? '视觉模式会看图逐步操作，完成后单独验收' : '离线模式只解析固定句式，不支持条件判断'}</span>
            <button type="button" className="test-secondary" onClick={() => setFlow(sample)} disabled={Boolean(active)}>
              使用示例
            </button>
          </div>
          </div>

          {previewError && <p className="test-error" role="alert"><Icon name="alert" />{previewError}</p>}
          {previewNotice && !previewError && <p className="test-notice" role="status">{previewNotice}</p>}
          {startError && <p className="test-error" role="alert"><Icon name="alert" />{startError}</p>}
          {archiveError && <p className="test-error" role="alert"><Icon name="alert" />{archiveError}</p>}
          {actionNotice && <p className="test-notice" role="status">{actionNotice}</p>}

          {runs.length > 0 && (
            <div className="test-device-runs" aria-label="多设备测试结果">
              {runs.map((testRun) => (
                <button
                  type="button"
                  key={testRun.id}
                  className={`test-device-run ${testRun.id === selectedRun?.id ? 'active' : ''}`}
                  onClick={() => setActiveRunId(testRun.id)}
                >
                  <span className={`test-run-dot run-${testRun.status}`} />
                  <span>
                    <strong>{testRun.deviceName}</strong>
                    <small>{platformName(testRun.platform)}</small>
                  </span>
                  <em>{testRunStatusName(testRun.status)}</em>
                </button>
              ))}
            </div>
          )}

          {selectedRun?.quality && (
            <TestQualitySummary
              quality={selectedRun.quality}
              compact
              onPreview={(url, title) => setPreviewImage({ url, title })}
            />
          )}

          {selectedRun && !active && (
            <div className="test-result-actions">
              <div>
                <span className="eyebrow">TEST EVIDENCE</span>
                <strong>{storage ? storage.message : '正在准备归档'}</strong>
              </div>
              <div className="test-result-buttons">
                <a className="test-result-link" href={`/records/${selectedRun.id}`} target="_blank" rel="noreferrer">
                  <Icon name="archive" />查看记录
                </a>
                <button type="button" className="test-share-button" onClick={() => void createShare()} disabled={archiveBusy}>
                  <Icon name="share" />分享
                </button>
              </div>
            </div>
          )}

          {share && (
            <div className="test-share-box">
              <div>
                <span><Icon name="share" />只读分享链接</span>
                <small>{share.expiresAt ? `有效至 ${formatArchiveTime(share.expiresAt)}` : '长期有效'}</small>
              </div>
              <div>
                <input value={share.url || ''} readOnly aria-label="只读分享链接" />
                <button type="button" className="test-secondary" onClick={() => void copyShare()}>复制</button>
                <a href={share.url || share.path} target="_blank" rel="noreferrer">打开</a>
              </div>
            </div>
          )}

          {resultSteps.length > 0 && (
            <div className="test-timeline-heading">
              <div>
                <span className="eyebrow">LIVE EXECUTION</span>
                <strong>{selectedRun
                  ? `${selectedRun.deviceName} · ${selectedRun.engine === 'vision' ? '视觉逐步执行' : '离线步骤'} · ${selectedRun.steps.length} 个动作${selectedRun.exploration?.pageCount ? ` · 覆盖 ${selectedRun.exploration.pageCount} 个页面/${selectedRun.exploration.interactionCount} 次交互` : ''}${selectedRun.quality?.issueCount ? ` · ${selectedRun.quality.issueCount} 个问题` : ''}`
                  : engine === 'vision' ? '视觉模型将从当前画面开始决策' : `${preview.length} 个步骤已识别`}</strong>
              </div>
              {selectedRun && <RunStatus run={selectedRun} />}
            </div>
          )}

          <div className="test-steps">
            {resultSteps.map((step) => (
              <TestStep
                key={`${selectedRun?.id ?? 'preview'}-${step.index}`}
                step={step}
                onPreview={(url, title) => setPreviewImage({ url, title })}
              />
            ))}
          </div>

          {selectedRun?.error && (
            <div className="test-run-error" role="alert">
              <Icon name="alert" />
              <div><strong>流程已停止</strong><p>{selectedRun.error}</p></div>
            </div>
          )}
        </div>

        <footer className="test-drawer-footer">
          <div>
            <strong>{active
              ? `${activeRuns.length} 台设备正在执行`
              : selectedDevices.length > 0
                ? `已选择 ${selectedDevices.length} 台设备`
                : '请选择测试设备'}</strong>
            <span>{active
              ? '各设备独立执行，请勿手动操作测试手机'
              : runs.length > 0
                ? stateHint(runs)
                : '勾选设备后会同时执行同一套测试流程'}</span>
          </div>
          <button className="primary-button test-start" onClick={() => void start()} disabled={!canStart}>
            {active || starting ? <span className="spinner" /> : <Icon name="test" />}
            {active
              ? '测试执行中'
              : starting
                ? `正在启动 ${selectedDevices.length} 台`
                : selectedDevices.length > 1
                  ? `开始 ${selectedDevices.length} 台设备测试`
                  : '开始语义测试'}
          </button>
          {active && (
            <button
              type="button"
              className="test-secondary test-stop"
              onClick={() => void stopActiveRuns()}
              disabled={stopping}
            >
              {stopping ? '正在停止' : '停止测试'}
            </button>
          )}
        </footer>
        {previewImage && (
          <ScreenshotViewer
            image={previewImage}
            onClose={() => setPreviewImage(undefined)}
          />
        )}
    </aside>
  );
}

function TestStep({
  step,
  onPreview,
}: {
  step: TestStepResult;
  onPreview: (url: string, title: string) => void;
}) {
  const [expanded, setExpanded] = useState(Boolean(step.image || step.imageDiff));
  const stepRef = useRef<HTMLElement>(null);
  const hasEvidence = Boolean(step.image || step.imageDiff);

  useEffect(() => {
    if (step.status === 'running' || step.status === 'failed' || step.image) {
      setExpanded(true);
    }
  }, [step.image, step.status]);

  useEffect(() => {
    if (step.status !== 'running') return;
    stepRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [step.stage, step.status]);

  return (
    <article className={`test-step test-step-${step.status}`} ref={stepRef}>
      <button className="test-step-summary" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <span className="test-step-number">{String(step.index).padStart(2, '0')}</span>
        <span className="test-step-copy">
          <strong>{step.description}</strong>
          <small>{step.source}</small>
        </span>
        <span className={`test-step-state state-${step.status}`}>
          {step.status === 'running' ? step.stageLabel : statusName(step.status)}
        </span>
        <Icon name="chevron" className={expanded ? 'test-chevron open' : 'test-chevron'} />
      </button>
      {expanded && (
        <div className="test-step-details">
          {step.error && <p className="test-step-error"><Icon name="alert" />{step.error}</p>}
          {step.status === 'running' && (
            <div className="test-live-state" role="status" aria-live="polite">
              <div className="test-live-heading">
                <span className="spinner" />
                <span>当前阶段</span>
                <strong>{step.stageLabel}</strong>
                {step.startedAt && <time>已用 {formatDuration(Date.now() - Date.parse(step.startedAt))}</time>}
              </div>
              <p>{step.stageMessage || '正在执行这一步'}</p>
            </div>
          )}
          {step.resolvedElement && (
            <div className="test-resolved">
              <span>识别目标</span>
              <strong>{step.resolvedElement.text || step.resolvedElement.kind}</strong>
              <small>{Math.round(step.resolvedElement.score || 0)}% 置信度 · {step.resolvedElement.kind}</small>
            </div>
          )}
          {step.thought && (
            <div className="test-vision-thought">
              <span>视觉判断</span>
              <p>{step.thought}</p>
            </div>
          )}
          {step.audit && <StepAudit audit={step.audit} />}
          {hasEvidence && (
            <div className="test-evidence" aria-label={`第 ${step.index} 步截图`}>
              <EvidenceThumbnail
                image={step.image}
                label="执行结果 · 下一步起点"
                title={`第 ${step.index} 步 · 执行结果`}
                onPreview={onPreview}
              />
            </div>
          )}
          {step.imageDiff && (
            <div className="test-metrics">
              <span>画面差异 <strong>{percent(step.imageDiff.changedRatio)}</strong></span>
              <span>平均像素差 <strong>{percent(step.imageDiff.averageDelta)}</strong></span>
              <span>识别元素 <strong>{step.snapshot?.nodeCount ?? '—'}</strong></span>
            </div>
          )}
          {step.elementDiff && <ElementDiff diff={step.elementDiff} />}
          {step.logs.length > 0 && (
            <StageLogs
              logs={step.logs}
              running={step.status === 'running'}
              durationMs={step.finishedAt && step.startedAt
                ? Date.parse(step.finishedAt) - Date.parse(step.startedAt)
                : undefined}
            />
          )}
        </div>
      )}
    </article>
  );
}

function EvidenceThumbnail({
  image,
  label,
  title,
  onPreview,
}: {
  image?: string;
  label: '执行结果 · 下一步起点';
  title: string;
  onPreview: (url: string, title: string) => void;
}) {
  return (
    <figure className="test-evidence-item">
      <figcaption>{label}</figcaption>
      <button
        type="button"
        className="test-screen-frame"
        disabled={!image}
        onClick={() => image && onPreview(image, title)}
        aria-label={image ? `放大${title}截图` : `${title}截图尚未生成`}
      >
        {image
          ? <img src={image} alt={`${title}截图`} />
          : <span>等待执行结果…</span>}
        {image && <ZoomBadge />}
      </button>
    </figure>
  );
}

function ZoomBadge() {
  return <span className="test-zoom-badge"><Icon name="expand" />点击放大</span>;
}

function ElementDiff({ diff }: { diff: NonNullable<TestStepResult['elementDiff']> }) {
  const empty = !diff.added.length && !diff.removed.length && !diff.moved.length;
  if (empty) return <p className="test-no-changes">未识别到文字元素新增、消失或移动</p>;
  return (
    <div className="test-element-diff">
      {diff.added.length > 0 && <DiffGroup label="新增" tone="added" items={diff.added.map((item) => item.text)} />}
      {diff.removed.length > 0 && <DiffGroup label="消失" tone="removed" items={diff.removed.map((item) => item.text)} />}
      {diff.moved.length > 0 && <DiffGroup label="移动" tone="moved" items={diff.moved.map((item) => item.text)} />}
    </div>
  );
}

function DiffGroup({ label, tone, items }: { label: string; tone: string; items: string[] }) {
  return (
    <div className={`test-diff-group diff-${tone}`}>
      <span>{label}</span>
      <div>{items.slice(0, 8).map((item, index) => <em key={`${item}-${index}`}>{item}</em>)}</div>
    </div>
  );
}

function RunStatus({ run }: { run: TestRun }) {
  const passed = run.steps.filter((step) => step.status === 'passed').length;
  const activeStep = run.steps.find((step) => step.status === 'running');
  return (
    <span className={`test-run-status run-${run.status}`} title={run.quality?.summary || run.verdict?.reason}>
      {run.status === 'running' || run.status === 'queued'
        ? <span className="spinner" />
        : run.status === 'completed' && !run.quality?.issueCount
          ? <Icon name="check" />
          : <Icon name="alert" />}
      {run.status === 'running' || run.status === 'queued'
        ? activeStep
          ? `第 ${activeStep.index} 步 · ${activeStep.stageLabel}`
          : `执行 ${passed}/${run.steps.length}`
        : run.status === 'completed'
          ? run.quality?.issueCount ? `目标完成 · ${run.quality.issueCount} 个问题` : '验收通过'
          : run.termination === 'stopped'
            ? '已手动停止'
            : run.termination === 'max_steps' ? '达到步数上限' : '执行失败'}
    </span>
  );
}

function StepAudit({ audit }: { audit: NonNullable<TestStepResult['audit']> }) {
  return (
    <div className={`test-step-audit audit-${audit.status}`}>
      <div>
        <span>{audit.status === 'passed' ? '步骤校验通过' : audit.status === 'issue' ? '发现问题' : '未能确认'}</span>
        {audit.title && <strong>{audit.title}</strong>}
      </div>
      <dl>
        <div><dt>预期</dt><dd>{audit.expected}</dd></div>
        <div><dt>实际</dt><dd>{audit.actual}</dd></div>
      </dl>
      {audit.reason && <p>{audit.reason}</p>}
    </div>
  );
}

function toPendingStep(step: TestFlowStep): TestStepResult {
  return {
    ...step,
    status: 'pending',
    stage: 'pending',
    stageLabel: '待执行',
    logs: [],
  };
}

function StageLogs({
  logs,
  running,
  durationMs,
}: {
  logs: TestStepResult['logs'];
  running: boolean;
  durationMs?: number;
}) {
  const firstTime = Date.parse(logs[0]?.at || '');
  return (
    <details className="test-stage-logs" open={running}>
      <summary>
        <span>执行过程</span>
        <small>
          {logs.length} 个阶段节点
          {Number.isFinite(durationMs) ? ` · ${formatDuration(durationMs!)}` : ''}
        </small>
      </summary>
      <ol>
        {logs.map((log, index) => (
          <li key={`${log.at}-${index}`}>
            <span className={`test-stage-dot stage-${log.stage}`} />
            <strong>{stageName(log.stage)}</strong>
            <span>{log.message}</span>
            <time>{formatClock(log.at, firstTime)}</time>
          </li>
        ))}
      </ol>
    </details>
  );
}

function stageName(stage: TestStepResult['stage']) {
  return ({
    pending: '待执行',
    preparing: '准备动作',
    readingScreen: '读取当前画面',
    recognizing: '页面识别',
    thinking: '视觉决策',
    locating: '定位目标',
    acting: '执行动作',
    stabilizing: '等待稳定',
    capturingResult: '保存执行结果',
    comparing: '对比差异',
    verifying: '独立验收',
    done: '完成',
    failed: '失败',
  } as const)[stage];
}

function formatDuration(value: number) {
  const milliseconds = Math.max(0, value);
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)} s`;
  return `${Math.floor(milliseconds / 60_000)}m ${Math.round((milliseconds % 60_000) / 1000)}s`;
}

function formatClock(value: string, firstTime: number) {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || !Number.isFinite(firstTime)) return '';
  return `+${formatDuration(time - firstTime)}`;
}

function statusName(status: TestStepResult['status']) {
  return ({ pending: '待执行', running: '执行中', passed: '通过', failed: '失败', skipped: '未执行' })[status];
}

function storageName(storage?: 'mysql' | 'file') {
  if (storage === 'mysql') return ' MySQL';
  if (storage === 'file') return '本机文件';
  return '归档存储';
}

function isExpired(share: TestRunShare) {
  return Boolean(share.expiresAt && Date.parse(share.expiresAt) <= Date.now());
}

function withShareUrl(share: TestRunShare): TestRunShare {
  return {
    ...share,
    // In development the API runs on a separate port; always expose the URL
    // through the page the user is currently using so the report route loads.
    url: new URL(share.path, window.location.origin).toString(),
  };
}

function formatArchiveTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function platformName(platform: DeviceInfo['platform']) {
  return platform === 'android' ? 'Android' : platform === 'ios' ? 'iOS' : 'HarmonyOS';
}

function stateHint(runs: TestRun[]) {
  const completed = runs.filter((run) => run.status === 'completed').length;
  if (completed === runs.length) return `${completed} 台设备均已完成，可以修改流程后重新运行`;
  return `${runs.length} 台设备已执行，${completed} 台通过；可切换设备查看每一步证据`;
}

function testRunStatusName(status: TestRun['status']) {
  return ({ queued: '排队中', running: '执行中', completed: '通过', failed: '失败' } as const)[status];
}

function percent(value: number) {
  return `${(Math.max(0, Number(value) || 0) * 100).toFixed(1)}%`;
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
