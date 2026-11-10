import { useEffect, useState } from 'react';
import type { TestRun, TestStepResult } from '../../shared/types';
import { fetchSharedTestRun } from '../lib/api';
import { ComparisonEvidence, type ComparisonPreview } from './ComparisonEvidence';
import { Icon } from './Icon';
import { ScreenshotViewer } from './ScreenshotViewer';
import { TestQualitySummary } from './TestQualitySummary';

export function SharedTestReport({ token }: { token: string }) {
  const [run, setRun] = useState<TestRun>();
  const [error, setError] = useState<string>();
  const [image, setImage] = useState<ComparisonPreview>();

  useEffect(() => {
    let cancelled = false;
    fetchSharedTestRun(token)
      .then((sharedRun) => {
        if (cancelled) return;
        setRun(sharedRun);
        document.title = `测试报告 · ${sharedRun.deviceName} · ViewPhone`;
      })
      .catch((reason) => {
        if (!cancelled) setError(messageOf(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!image) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setImage(undefined);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [image]);

  if (error) {
    return (
      <main className="shared-report-shell shared-report-error">
        <div className="report-brand"><span className="brand-symbol"><span /><span /></span>ViewPhone</div>
        <section>
          <Icon name="alert" />
          <h1>无法打开测试报告</h1>
          <p>{error}</p>
          <small>分享链接可能已过期、被撤回，或服务地址已经变化。</small>
        </section>
      </main>
    );
  }

  if (!run) {
    return (
      <main className="shared-report-shell report-loading">
        <span className="spinner" />
        <p>正在加载只读测试报告…</p>
      </main>
    );
  }

  return (
    <main className="shared-report-shell">
      <header className="shared-report-header">
        <div className="report-brand"><span className="brand-symbol"><span /><span /></span>ViewPhone</div>
        <span className="report-readonly"><Icon name="lock" />只读报告</span>
      </header>

      <div className="shared-report-content">
        <section className="shared-report-hero">
          <span className="eyebrow">SEMANTIC TEST REPORT</span>
          <div className="report-title-row">
            <div>
          <h1>{run.recordType === 'comparison'
            ? run.status === 'completed'
              ? '页面差异报告'
              : '页面差异分析未完成'
            : run.status === 'completed'
              ? run.quality?.issueCount ? '目标完成 · 发现问题' : '测试流程通过'
              : '测试流程失败'}</h1>
          <p>{run.verdict?.reason || run.error || (run.recordType === 'comparison'
            ? '查看全部设备总览、两两页面差异和截图证据。'
            : '查看每一步执行结果和页面差异。')}</p>
            </div>
            <ReportVerdict run={run} />
          </div>
          <div className="report-meta">
            <span><small>设备</small><strong>{run.deviceName}</strong></span>
            <span><small>平台</small><strong>{platformName(run.platform)}</strong></span>
            <span><small>执行时间</small><strong>{formatDate(run.startedAt || run.createdAt)}</strong></span>
            <span><small>耗时</small><strong>{formatRunDuration(run)}</strong></span>
          </div>
          <div className="report-goal">
            <span>测试目标</span>
            <p>{run.flow}</p>
          </div>
        </section>

        {run.quality && (
          <TestQualitySummary
            quality={run.quality}
            onPreview={(url, title) => setImage({ url, title, regions: [] })}
          />
        )}

        {run.recordType === 'comparison' && run.comparison ? (
          <section className="shared-report-steps">
            <div className="shared-report-section-heading">
              <div>
                <span className="eyebrow">MULTI-DEVICE UI EVIDENCE</span>
                <h2>页面差异证据</h2>
              </div>
              <span>{run.comparison.pairs?.length || 0} 组设备互比</span>
            </div>
            <ComparisonEvidence
              comparison={run.comparison}
              onPreview={(preview) => setImage(preview)}
              compactOverview
            />
          </section>
        ) : <section className="shared-report-steps">
          <div className="shared-report-section-heading">
            <div>
              <span className="eyebrow">EXECUTION EVIDENCE</span>
              <h2>逐步执行记录</h2>
            </div>
            <span>{run.steps.length} 个动作</span>
          </div>
          {run.steps.map((step) => (
            <SharedStep
              key={step.index}
              step={step}
              onPreview={(url, title) => setImage({ url, title, regions: [] })}
            />
          ))}
          {run.steps.length === 0 && <p className="report-empty">该记录没有可展示的执行步骤。</p>}
        </section>}
        <footer className="shared-report-footer">由 ViewPhone 生成 · 此页面仅展示归档证据，不能控制手机</footer>
      </div>
      {image && <ScreenshotViewer image={image} onClose={() => setImage(undefined)} />}
    </main>
  );
}

function SharedStep({
  step,
  onPreview,
}: {
  step: TestStepResult;
  onPreview: (url: string, title: string) => void;
}) {
  return (
    <article className={`shared-report-step report-step-${step.status}`}>
      <header>
        <span className="shared-step-number">{String(step.index).padStart(2, '0')}</span>
        <div>
          <strong>{step.description}</strong>
          <small>{step.status === 'passed' ? '通过' : step.status === 'failed' ? '失败' : step.status === 'skipped' ? '未执行' : '已执行'}</small>
        </div>
        {step.thought && <p>{step.thought}</p>}
      </header>
      {step.error && <p className="shared-step-error"><Icon name="alert" />{step.error}</p>}
      {step.audit && (
        <div className={`shared-step-audit audit-${step.audit.status}`}>
          <span>{step.audit.status === 'passed' ? '步骤校验通过' : step.audit.status === 'issue' ? '测试问题' : '未能确认'}</span>
          <strong>{step.audit.title || step.description}</strong>
          <dl>
            <div><dt>预期</dt><dd>{step.audit.expected}</dd></div>
            <div><dt>实际</dt><dd>{step.audit.actual}</dd></div>
          </dl>
        </div>
      )}
      <div className="shared-step-body">
        <div className="shared-step-evidence">
          {step.image ? (
            <button
              type="button"
              className="report-screenshot"
              onClick={() => onPreview(step.image!, `第 ${step.index} 步 · 执行结果`)}
            >
              <img src={step.image} alt={`第 ${step.index} 步执行结果截图`} />
              <span><Icon name="expand" />放大查看</span>
            </button>
          ) : (
            <div className="report-screenshot empty">无截图</div>
          )}
        </div>
        <div className="shared-step-differences">
          {step.resolvedElement && (
            <div className="report-resolved">
              <small>识别目标</small>
              <strong>{step.resolvedElement.text || step.resolvedElement.kind}</strong>
              <span>{Math.round(step.resolvedElement.score || 0)}% 置信度</span>
            </div>
          )}
          {step.imageDiff && (
            <div className="report-metrics">
              <span>画面差异 <strong>{percent(step.imageDiff.changedRatio)}</strong></span>
              <span>平均像素差 <strong>{percent(step.imageDiff.averageDelta)}</strong></span>
            </div>
          )}
          {step.elementDiff && <ReportElementDiff diff={step.elementDiff} />}
          {!step.resolvedElement && !step.imageDiff && !step.elementDiff && (
            <p className="report-no-diff">这一步没有可展示的差异数据。</p>
          )}
        </div>
      </div>
    </article>
  );
}

function ReportElementDiff({ diff }: { diff: NonNullable<TestStepResult['elementDiff']> }) {
  const groups = [
    ['新增', 'added', diff.added.map((item) => item.text)],
    ['消失', 'removed', diff.removed.map((item) => item.text)],
    ['移动', 'moved', diff.moved.map((item) => item.text)],
  ] as const;
  return (
    <div className="report-element-diffs">
      {groups.filter(([, , items]) => items.length > 0).map(([label, tone, items]) => (
        <div key={tone} className={`report-diff report-diff-${tone}`}>
          <small>{label}</small>
          <div>{items.slice(0, 20).map((item, index) => <em key={`${item}-${index}`}>{item}</em>)}</div>
        </div>
      ))}
    </div>
  );
}

function ReportVerdict({ run }: { run: TestRun }) {
  const passed = run.status === 'completed';
  return (
    <span className={`report-verdict ${passed ? 'passed' : 'failed'}`}>
      <Icon name={passed ? 'check' : 'alert'} />
      {passed
        ? run.quality?.issueCount ? `PASS · ${run.quality.issueCount} ISSUES` : 'PASS'
        : 'FAIL'}
    </span>
  );
}

function formatRunDuration(run: TestRun) {
  if (!run.startedAt || !run.finishedAt) return '—';
  const duration = Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt));
  if (duration < 60_000) return `${(duration / 1000).toFixed(1)} 秒`;
  return `${Math.floor(duration / 60_000)} 分 ${Math.round((duration % 60_000) / 1000)} 秒`;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function platformName(platform: TestRun['platform']) {
  return platform === 'android' ? 'Android' : platform === 'ios' ? 'iOS' : 'HarmonyOS';
}

function percent(value: number) {
  return `${(Math.max(0, Number(value) || 0) * 100).toFixed(1)}%`;
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
