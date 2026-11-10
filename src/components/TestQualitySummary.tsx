import type { TestIssue, TestQuality } from '../../shared/types';
import { Icon } from './Icon';

export function TestQualitySummary({
  quality,
  onPreview,
  compact = false,
}: {
  quality?: TestQuality;
  onPreview?: (url: string, title: string) => void;
  compact?: boolean;
}) {
  if (!quality) return null;
  const issues = quality.issues || [];
  return (
    <section
      className={`test-quality quality-${quality.status} ${compact ? 'compact' : ''}`}
      aria-label="测试问题汇总"
    >
      <header>
        <span className="test-quality-icon">
          <Icon name={quality.status === 'passed' ? 'check' : 'alert'} />
        </span>
        <div>
          <span className="eyebrow">TEST ENGINEER REVIEW</span>
          <strong>{quality.status === 'passed'
            ? '独立测试检查通过'
            : quality.status === 'unverified'
              ? '部分步骤未能确认'
              : `发现 ${quality.issueCount} 个测试问题`}</strong>
        </div>
      </header>
      <p>{quality.summary}</p>
      {issues.length > 0 && (
        <ol className="test-quality-issues">
          {issues.map((issue) => (
            <QualityIssue
              key={`${issue.stepIndex}-${issue.category}-${issue.title}`}
              issue={issue}
              onPreview={onPreview}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function QualityIssue({
  issue,
  onPreview,
}: {
  issue: TestIssue;
  onPreview?: (url: string, title: string) => void;
}) {
  return (
    <li>
      <div className="test-quality-issue-heading">
        <span className={`test-quality-severity severity-${issue.severity}`}>
          {severityName(issue.severity)}
        </span>
        <strong>第 {issue.stepIndex} 步 · {issue.title}</strong>
        <span className="test-quality-category">{categoryName(issue.category)}</span>
        {issue.recovered && <span className="test-quality-recovered">后续已恢复</span>}
      </div>
      <dl>
        <div><dt>预期</dt><dd>{issue.expected}</dd></div>
        <div><dt>实际</dt><dd>{issue.actual}</dd></div>
      </dl>
      {issue.evidence && onPreview && (
        <button
          type="button"
          className="test-quality-evidence"
          onClick={() => onPreview(issue.evidence!, `第 ${issue.stepIndex} 步 · 问题证据`)}
        >
          <Icon name="expand" />查看对应截图
        </button>
      )}
    </li>
  );
}

function severityName(severity: TestIssue['severity']) {
  return ({ critical: '严重', major: '主要', minor: '轻微' })[severity];
}

function categoryName(category: TestIssue['category']) {
  return ({
    navigation: '误导航',
    no_response: '无响应',
    repeat_action: '重复操作',
    unexpected_dialog: '异常弹窗',
    ui_mismatch: 'UI 不一致',
    data_mismatch: '数据不一致',
    assertion: '目标未完成',
    recovery: '异常恢复',
    other: '其他',
  })[category];
}
