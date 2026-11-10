import type {
  SyncComparisonOverview,
  SyncPageComparison,
  SyncPagePairComparison,
  UiDifference,
  UiDifferenceType,
} from '../../shared/types';
import { Icon } from './Icon';

export type ComparisonPreview = {
  url: string;
  title: string;
  regions: UiDifference[];
};

type Props = {
  comparison: SyncPageComparison;
  onPreview: (preview: ComparisonPreview) => void;
  /** Archive views use a compact overview to leave room for the findings. */
  compactOverview?: boolean;
};

const DIFFERENCE_LABELS: Record<UiDifferenceType, string> = {
  missing: '缺失',
  extra: '新增',
  text: '文字',
  layout: '布局',
  style: '样式',
  other: '其他',
};

export function ComparisonEvidence({ comparison, onPreview, compactOverview = false }: Props) {
  const pairs = comparisonPairs(comparison);
  const status = comparison.status || 'completed';
  const total = comparison.progress?.total || pairs.length;
  const analyzed = comparison.progress?.analyzed
    ?? pairs.filter((pair) => pair.status !== 'pending').length;
  const capturing = status === 'running' && total === 0;
  const retrying = pairs.filter((pair) => pair.retrying).length;
  const isRetry = status === 'running' && retrying > 0;

  return (
    <div className={`comparison-evidence comparison-${status}`}>
      {status === 'running' && (
        <div className="sync-comparison-running" role="status">
          <span className="spinner" />
          <div>
            <strong>{capturing
              ? '正在保存全部设备截图'
              : isRetry
                ? `正在重跑 ${retrying} 组失败的设备对比`
                : '页面差异分析进行中'}</strong>
            <p>{capturing
              ? '截图完成后会立即显示多设备总览，并在后台开始逐组视觉对比。'
              : isRetry
                ? `使用这条归档中保存的原始截图重新分析，无需重新连接设备；已完成 ${analyzed}/${total} 组。`
                : `已完成 ${analyzed}/${total} 组设备对比，截图已保存，可以继续操作手机。`}</p>
          </div>
        </div>
      )}
      {status === 'failed' && (
        <div className="sync-comparison-error comparison-failure" role="alert">
          <Icon name="alert" />
          <div>
            <strong>页面差异分析失败</strong>
            <p>{comparison.error || '设备截图已保留，可以重新点击页面打点或实时对比差异。'}</p>
          </div>
        </div>
      )}
      {comparison.overview ? (
        <OverviewPreview
          overview={comparison.overview}
          pairs={pairs}
          onPreview={onPreview}
          compact={compactOverview}
        />
      ) : (
        <div className="sync-comparison-empty sync-overview-missing">
          {capturing ? <span className="spinner" /> : <Icon name="compare" />}
          <strong>{capturing ? '正在生成多设备总览图' : '这张记录没有多设备总览图'}</strong>
          <p>{capturing
            ? '页面稳定后会自动保存截图，无需再次点击按钮。'
            : '重新点击「页面打点」或「实时对比差异」即可生成新的多设备总览。'}</p>
        </div>
      )}
      <div className="sync-target-results">
        {pairs.map((pair, index) => (
          <PairComparison
            key={`${pair.source.id}-${pair.target.id}-${index}`}
            pair={pair}
            pairIndex={index}
            pairs={pairs}
          />
        ))}
      </div>
    </div>
  );
}

function comparisonPairs(comparison: SyncPageComparison): SyncPagePairComparison[] {
  if (comparison.pairs?.length) return comparison.pairs;
  return comparison.targets.map((target) => ({
    status: target.status === 'compared' ? 'compared' : 'error',
    source: comparison.source,
    target: target.target,
    same: target.same,
    summary: target.summary,
    pixelChangedRatio: target.pixelChangedRatio,
    differences: target.differences,
    error: target.error,
  }));
}

function PairComparison({
  pair,
  pairIndex,
  pairs,
}: {
  pair: SyncPagePairComparison;
  pairIndex: number;
  pairs: SyncPagePairComparison[];
}) {
  const differenceCount = pair.differences.length;
  return (
    <section className="sync-pair-result">
      <header>
        <div className="sync-pair-title">
          <span className={`platform-dot platform-${pair.source.platform}`} />
          <strong>{pair.source.name}</strong>
          <span className="sync-pair-arrow">↔</span>
          <span className={`platform-dot platform-${pair.target.platform}`} />
          <strong>{pair.target.name}</strong>
        </div>
        <PairDifferenceSummary pair={pair} />
      </header>
      {pair.status === 'pending' ? (
        <div className="sync-pair-pending">
          <span className="spinner" />
          {pair.retrying
            ? '正在从归档截图重新分析这组设备'
            : '截图已保存，等待这组设备进行视觉分析'}
        </div>
      ) : pair.status === 'error' ? (
        <div className="sync-comparison-error">
          <Icon name="alert" />
          <div>
            <strong>这组设备视觉对比未完成</strong>
            <p>{pair.error || '视觉模型没有返回结果，两台设备的截图已保留。'}</p>
            <small>可点击上方「重跑失败对比」，直接使用已保存的截图重新分析。</small>
          </div>
        </div>
      ) : pair.differences.length === 0 ? (
        <div className="sync-comparison-same"><Icon name="check" />这两台设备的页面未发现明显业务 UI 差异</div>
      ) : (
        <ol className="sync-difference-list">
          {pair.differences.map((difference, index) => (
            <li key={`${difference.type}-${difference.title}-${index}`}>
              <span className="sync-difference-index">
                {differenceNumber(pairs, pairIndex, index) || '·'}
              </span>
              <span className={`ui-difference-tag difference-${difference.type}`}>
                {DIFFERENCE_LABELS[difference.type]}
              </span>
              <div>
                <strong>{difference.title}</strong>
                <p>{difference.description}</p>
                {difference.region && (
                  <small>右侧页面区域 {Math.round(difference.region.x / 10)}%, {Math.round(difference.region.y / 10)}%</small>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
      {differenceCount > 0 && !pair.differences.some((item) => item.region) && (
        <p className="sync-region-note">这组差异来自页面内容判断，模型未返回可高亮区域。</p>
      )}
      {pair.pixelChangedRatio !== undefined && (
        <p className="sync-pixel-ratio">
          归一化画面差异 <strong>{formatPercent(pair.pixelChangedRatio)}</strong>
          <span>包含样式和内容像素变化，仅作参考</span>
        </p>
      )}
    </section>
  );
}

function OverviewPreview({
  overview,
  pairs,
  onPreview,
  compact,
}: {
  overview: SyncComparisonOverview;
  pairs: SyncPagePairComparison[];
  onPreview: (preview: ComparisonPreview) => void;
  compact: boolean;
}) {
  const regions = overviewDifferences(overview, pairs);
  const openOverview = () => onPreview({
    url: overview.imageUrl,
    title: `全部 ${overview.devices.length} 台手机 · 页面差异总览`,
    regions,
  });
  return (
    <div className={`sync-overview-preview ${compact ? 'compact' : ''}`}>
      <button
        type="button"
        className="sync-overview-thumbnail"
        onClick={openOverview}
        title="点击放大查看全部手机页面和差异标记"
        aria-label="放大查看多设备页面差异总览"
      >
        <ComparisonImage
          url={overview.imageUrl}
          regions={regions}
          showRegions={!compact}
        />
      </button>
      <div className="sync-overview-caption">
        <span className="sync-overview-caption-label">
          <b>全部手机 · 一张总览图</b>
          <span>{overview.devices.length} 台设备</span>
        </span>
        <button type="button" className="sync-overview-expand" onClick={openOverview}>
          <Icon name="expand" />放大查看
        </button>
      </div>
    </div>
  );
}

function overviewDifferences(
  overview: SyncComparisonOverview,
  pairs: SyncPagePairComparison[],
): UiDifference[] {
  const differences: UiDifference[] = [];
  for (const pair of pairs) {
    const panel = overview.devices.find((device) => device.id === pair.target.id);
    if (!panel) continue;
    for (const difference of pair.differences) {
      if (!difference.region) continue;
      differences.push({
        ...difference,
        title: `${pair.source.name} ↔ ${pair.target.name} · ${difference.title}`,
        region: {
          x: Math.round(panel.x + panel.width * difference.region.x / 1_000),
          y: Math.round(panel.y + panel.height * difference.region.y / 1_000),
          width: Math.max(1, Math.round(panel.width * difference.region.width / 1_000)),
          height: Math.max(1, Math.round(panel.height * difference.region.height / 1_000)),
        },
      });
    }
  }
  return differences;
}

function differenceNumber(
  pairs: SyncPagePairComparison[],
  pairIndex: number,
  differenceIndex: number,
) {
  let number = 0;
  for (let currentPair = 0; currentPair <= pairIndex; currentPair += 1) {
    const pair = pairs[currentPair];
    const limit = currentPair === pairIndex ? differenceIndex + 1 : pair.differences.length;
    for (let currentDifference = 0; currentDifference < limit; currentDifference += 1) {
      if (pair.differences[currentDifference]?.region) number += 1;
    }
  }
  return number;
}

function PairDifferenceSummary({ pair }: { pair: SyncPagePairComparison }) {
  if (pair.retrying) return <span className="comparison-status status-pending">重跑中</span>;
  if (pair.status === 'pending') return <span className="comparison-status status-pending">分析中</span>;
  if (pair.status === 'error') return <span className="comparison-status status-error">未完成</span>;
  if (pair.differences.length === 0) return <span className="comparison-status status-same">一致</span>;
  return <span className="comparison-status status-different">{pair.differences.length} 项差异</span>;
}

function ComparisonImage({
  url,
  regions,
  showRegions = true,
}: {
  url: string;
  regions: UiDifference[];
  showRegions?: boolean;
}) {
  return (
    <span className="sync-comparison-image">
      <img src={url} alt="多设备页面差异总览" loading="lazy" />
      {showRegions && regions.map((difference, index) => difference.region && (
        <i
          key={`${difference.title}-${index}`}
          className={`sync-difference-region difference-${difference.type}`}
          style={{
            left: `${difference.region.x / 10}%`,
            top: `${difference.region.y / 10}%`,
            width: `${difference.region.width / 10}%`,
            height: `${difference.region.height / 10}%`,
          }}
        >
          <b>{index + 1}</b>
        </i>
      ))}
    </span>
  );
}

function formatPercent(value: number) {
  return `${Math.round(Math.max(0, Math.min(1, Number(value))) * 1_000) / 10}%`;
}
