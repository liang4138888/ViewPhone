import { useState } from 'react';
import type { SyncPageComparison } from '../../shared/types';
import { ComparisonEvidence, type ComparisonPreview } from './ComparisonEvidence';
import { Icon } from './Icon';
import { ScreenshotViewer } from './ScreenshotViewer';

type Props = {
  open: boolean;
  comparisons: SyncPageComparison[];
  running: number;
  error?: string;
  onClose: () => void;
  embedded?: boolean;
};

const ACTION_LABELS: Record<NonNullable<SyncPageComparison['action']>, string> = {
  tap: '点击后',
  longPress: '长按后',
  swipe: '滑动后',
  text: '输入后',
  key: '按键后',
};

export function SyncComparisonPanel({
  open,
  comparisons,
  running,
  error,
  onClose,
  embedded = false,
}: Props) {
  const [preview, setPreview] = useState<ComparisonPreview>();
  if (!open) return null;
  const latestCheckpoint = comparisons[0]?.trigger === 'checkpoint' ? comparisons[0] : undefined;

  return (
    <aside className={`sync-comparison-sidepanel ${embedded ? 'embedded' : ''}`} aria-label="多设备页面 UI 差异">
      <header className="sync-comparison-heading">
        <div>
          <span className="eyebrow">{latestCheckpoint ? 'PAGE CHECKPOINT REVIEW' : 'LIVE UI DIFFERENCE REVIEW'}</span>
          <h2>{latestCheckpoint
            ? `页面打点：${latestCheckpoint.checkpointName || '未命名页面'}`
            : '实时页面差异'}</h2>
          <p>{latestCheckpoint
            ? '截图、设备间差异与进度保存在这里，执行记录也会自动归档，可按页面名称查询。'
            : '点击「实时对比差异」后，全部在线设备会立即截图并合成总览图，随后在后台逐组分析。'}</p>
        </div>
        {!embedded && (
          <button className="icon-button" onClick={onClose} aria-label="关闭页面 UI 差异">
            <Icon name="close" />
          </button>
        )}
      </header>
      <div className="sync-comparison-scroll">
        {error && (
          <div className="sync-manual-comparison sync-comparison-error" role="alert">
            <Icon name="alert" />
            <div><strong>无法开始页面差异对比</strong><p>{error}</p></div>
          </div>
        )}
        {running > 0 && !comparisons.some((comparison) => comparison.status === 'running') && (
          <div className="sync-comparison-running" role="status">
            <span className="spinner" />
            <div>
              <strong>正在等待页面稳定并保存截图</strong>
              <p>设备画面会先保存，然后自动开始所有设备两两对比。</p>
            </div>
          </div>
        )}
        {comparisons.length === 0 ? (
          <div className="sync-comparison-empty">
            <Icon name="point" />
            <strong>填写页面名称，然后点击「页面打点」</strong>
            <p>例如依次打点“首页、分类、我的”。也可点击「实时对比差异」只比较当前页面。</p>
          </div>
        ) : comparisons.map((comparison, index) => (
          <ComparisonRecord
            key={comparison.id}
            comparison={comparison}
            latest={index === 0}
            onPreview={setPreview}
          />
        ))}
      </div>
      {preview && <ScreenshotViewer image={preview} onClose={() => setPreview(undefined)} />}
    </aside>
  );
}

function ComparisonRecord({
  comparison,
  latest,
  onPreview,
}: {
  comparison: SyncPageComparison;
  latest: boolean;
  onPreview: (preview: ComparisonPreview) => void;
}) {
  return (
    <article className={`sync-comparison-record ${latest ? 'latest' : ''}`}>
      <header className="sync-comparison-record-heading">
        <div>
          <strong>
            {comparison.trigger === 'checkpoint'
              ? `页面打点：${comparison.checkpointName || '未命名页面'}`
              : comparison.trigger === 'manual'
              ? '当前页面实时对比'
              : comparison.action
                ? `${ACTION_LABELS[comparison.action] || '操作后'}页面`
                : '同步后页面'}
          </strong>
          <span>{formatComparisonTime(comparison.createdAt)}</span>
        </div>
        <div className="sync-comparison-record-flags">
          <span>{comparison.trigger === 'checkpoint'
            ? '检查点'
            : comparison.trigger === 'manual' ? '手动' : '自动'}</span>
          {comparison.status === 'running' && <span className="running">分析中</span>}
          {latest && <em>最新</em>}
        </div>
      </header>
      <ComparisonEvidence comparison={comparison} onPreview={onPreview} />
    </article>
  );
}

function formatComparisonTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}
