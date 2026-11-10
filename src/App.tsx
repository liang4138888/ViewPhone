import { useEffect, useRef, useState } from 'react';
import type { ActionRequest } from '../shared/types';
import type { DeviceSize } from '../shared/coordinates';
import { useDeviceLab } from './hooks/useDeviceLab';
import { AppSidebar, type AppPage } from './components/AppSidebar';
import { DevicePanel } from './components/DevicePanel';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { ExecutionRecords } from './components/ExecutionRecords';
import { SemanticTestPanel } from './components/SemanticTestPanel';
import { SyncComparisonPanel } from './components/SyncComparisonPanel';
import { Icon } from './components/Icon';
import { buildConnectedDeviceSlots, buildDeviceSlots } from './lib/deviceSlots';
import {
  getDeviceInputSize,
  getSyncTargets,
} from './lib/deviceSync';
import {
  captureSyncSource,
  fetchClientConfig,
  fetchSyncPageComparison,
  sendSyncAction,
  startSyncPageComparison,
} from './lib/api';
import { useNativeTouch } from './hooks/useNativeTouch';
import type { SyncMode, SyncPageComparison, VisionModelStatus } from '../shared/types';

type SyncStatus = {
  kind: 'syncing' | 'success' | 'error';
  message: string;
};

type SyncTaskResult = {
  ok: boolean;
  message: string;
};

type SyncSource = 'computer' | 'native';

export default function App() {
  const lab = useDeviceLab();
  const [manualRefresh, setManualRefresh] = useState(false);
  const [page, setPage] = useState<AppPage>(() => pageFromHash());
  const [comparisonPanelOpen, setComparisonPanelOpen] = useState(() => (
    window.location.hash.replace(/^#\/?/, '') === 'compare'
  ));
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [semanticTestRunning, setSemanticTestRunning] = useState(false);
  const slots = buildDeviceSlots(lab.snapshot?.devices || [], lab.snapshot?.diagnostics);
  const devices = lab.snapshot?.devices ?? [];
  const onlineDevices = devices.filter((device) => device.state === 'device');
  const onlineCount = onlineDevices.length;
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [syncMapping, setSyncMapping] = useState<SyncMode>('vision');
  const [syncVisionStatus, setSyncVisionStatus] = useState<VisionModelStatus>();
  const [syncSource, setSyncSource] = useState<SyncSource>('computer');
  const [nativeSourceId, setNativeSourceId] = useState('');
  const [syncStatus, setSyncStatus] = useState<SyncStatus>();
  const [comparisons, setComparisons] = useState<SyncPageComparison[]>([]);
  const [comparisonRunning, setComparisonRunning] = useState(0);
  const [comparisonError, setComparisonError] = useState<string>();
  const [checkpointName, setCheckpointName] = useState('');
  const syncQueue = useRef(Promise.resolve());
  const syncGeneration = useRef(0);
  const comparisonGeneration = useRef(0);
  const syncTargetCount = Math.max(0, onlineCount - 1);
  const androidDevices = onlineDevices.filter((device) => device.platform === 'android');
  const nativeSource =
    androidDevices.find((device) => device.id === nativeSourceId) ?? androidDevices[0];
  const connectedSlots = buildConnectedDeviceSlots(devices);
  const selectedSlot =
    slots.find((slot) => slot.device?.id === lab.selectedId) ||
    slots.find((slot) => slot.device?.state === 'device') ||
    slots[0];

  useEffect(() => {
    const onHistoryChange = () => {
      if (window.location.hash.replace(/^#\/?/, '') === 'compare') {
        setPage('sync');
        setComparisonPanelOpen(true);
        window.history.replaceState({ page: 'sync' }, '', '#/sync');
        return;
      }
      setPage(pageFromHash());
    };
    window.addEventListener('hashchange', onHistoryChange);
    window.addEventListener('popstate', onHistoryChange);
    if (window.location.hash.replace(/^#\/?/, '') === 'compare') {
      window.history.replaceState({ page: 'sync' }, '', '#/sync');
    }
    return () => {
      window.removeEventListener('hashchange', onHistoryChange);
      window.removeEventListener('popstate', onHistoryChange);
    };
  }, []);

  useEffect(() => {
    document.title = `${PAGE_TITLES[page]} · ViewPhone`;
  }, [page]);

  const navigate = (nextPage: AppPage) => {
    if (nextPage !== 'sync') setSyncEnabled(false);
    if (nextPage !== 'sync') setComparisonPanelOpen(false);
    setPage(nextPage);
    setMobileNavOpen(false);
    window.history.pushState({ page: nextPage }, '', `#/${nextPage}`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  useEffect(() => {
    let cancelled = false;
    fetchClientConfig()
      .then((client) => {
        if (cancelled) return;
        setSyncVisionStatus(client.vision);
        if (!client.vision.configured && syncMapping === 'vision') setSyncMapping('semantic');
      })
      .catch(() => {
        // Device controls remain usable when vision status cannot be read.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (onlineCount < 2) setSyncEnabled(false);
  }, [lab.snapshot?.refreshedAt]);

  useEffect(() => {
    if (syncSource === 'native' && androidDevices.length === 0) {
      setSyncSource('computer');
    }
  }, [syncSource, androidDevices.length]);

  useEffect(() => {
    if (syncSource === 'native' && syncMapping === 'vision') {
      // A physical touch event arrives after its gesture has completed, so a
      // reliable pre-action source screenshot is unavailable. Keep listener
      // sync on control matching rather than sending a mismatched frame.
      setSyncMapping('semantic');
    }
  }, [syncMapping, syncSource]);

  useEffect(() => {
    if (nativeSource && nativeSource.id !== nativeSourceId) setNativeSourceId(nativeSource.id);
  }, [nativeSource?.id, nativeSourceId]);

  useEffect(() => {
    syncGeneration.current += 1;
    setSyncStatus(undefined);
  }, [syncEnabled]);

  useEffect(() => {
    comparisonGeneration.current += 1;
    setComparisons([]);
    setComparisonRunning(0);
    setComparisonError(undefined);
  }, [syncMapping, syncSource, nativeSource?.id]);

  useEffect(() => {
    comparisonGeneration.current += 1;
    setComparisons([]);
    setComparisonRunning(0);
    setComparisonError(undefined);
  }, [onlineDevices.map((device) => device.id).sort().join('|')]);

  const runningComparisonIds = comparisons
    .filter((comparison) => (
      comparison.status === 'running' && !comparison.id.startsWith('pending-')
    ))
    .map((comparison) => comparison.id)
    .sort();
  const runningComparisonKey = runningComparisonIds.join('|');

  useEffect(() => {
    if (!runningComparisonKey) return undefined;
    let cancelled = false;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const updates = await Promise.all(runningComparisonKey.split('|').map((id) =>
          fetchSyncPageComparison(id).catch(() => undefined),
        ));
        if (cancelled) return;
        const byId = new Map(updates.filter(Boolean).map((item) => [item!.id, item!]));
        if (byId.size === 0) return;
        setComparisons((previous) => previous.map((item) => byId.get(item.id) || item));
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1_200);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [runningComparisonKey]);

  const refresh = async () => {
    setManualRefresh(true);
    await lab.refresh(true);
    setManualRefresh(false);
  };

  const showConnectionBanner = lab.status === 'error' || onlineCount === 0;

  const toggleSync = () => {
    setSyncEnabled((enabled) => !enabled);
  };

  useEffect(() => {
    if (page !== 'sync' && syncEnabled) setSyncEnabled(false);
  }, [page, syncEnabled]);

  useEffect(() => {
    if (page !== 'sync' && comparisonPanelOpen) setComparisonPanelOpen(false);
  }, [page, comparisonPanelOpen]);

  useEffect(() => {
    if (syncSource === 'native' && page !== 'sync') setSyncSource('computer');
  }, [page, syncSource]);

  useEffect(() => {
    if (!semanticTestRunning || page === 'test') return;
    setPage('test');
    window.history.pushState({ page: 'test' }, '', '#/test');
  }, [page, semanticTestRunning]);

  // In native-listening mode the Android phone is the sole input source.
  // Keeping the mirrors visible is useful, but local mouse controls must not
  // send direct actions to any device behind the listener's back.
  const computerControlsEnabled = syncSource === 'computer';
  const computerControlsDisabledReason =
    '手机监听模式：网页画面仅查看，请直接在 Android 手机上点击或滑动';

  const captureCurrentPages = async (name?: string) => {
    const source = onlineDevices[0];
    const targets = onlineDevices.filter((device) => device.id !== source?.id);
    if (!source || targets.length === 0) {
      setComparisonError(onlineDevices.length < 2
        ? '至少需要两台在线设备才能识别页面差异。'
        : '暂无可用于对比的在线设备。');
      return false;
    }
    const normalizedCheckpointName = name?.trim();
    const generation = comparisonGeneration.current;
    setComparisonPanelOpen(true);
    setComparisonError(undefined);
    // Add a placeholder result immediately so the panel opens in its loading
    // state instead of leaving the user wondering whether the button worked.
    const pendingId = `pending-${Date.now()}`;
    const pending: SyncPageComparison = {
      id: pendingId,
      status: 'running',
      trigger: normalizedCheckpointName ? 'checkpoint' : 'manual',
      ...(normalizedCheckpointName ? { checkpointName: normalizedCheckpointName } : {}),
      createdAt: new Date().toISOString(),
      source: comparisonDevice(source),
      devices: onlineDevices.map(comparisonDevice),
      pairs: [],
      targets: [],
      progress: { analyzed: 0, total: 0 },
    };
    setComparisons((previous) => [pending, ...previous].slice(0, 20));
    setComparisonRunning((count) => count + 1);
    const task = syncQueue.current.then(() => startSyncPageComparison(
      source.id,
      targets.map((target) => target.id),
      undefined,
      normalizedCheckpointName,
    ));
    syncQueue.current = task.then(() => undefined, () => undefined);
    try {
      const comparison = await task;
      if (generation === comparisonGeneration.current) {
        setComparisons((previous) => [
          comparison,
          ...previous.filter((item) => item.id !== pendingId && item.id !== comparison.id),
        ].slice(0, 20));
      }
      return true;
    } catch (error) {
      if (generation === comparisonGeneration.current) {
        setComparisons((previous) => previous.filter((item) => item.id !== pendingId));
        setComparisonError(errorMessage(error));
      }
      return false;
    } finally {
      if (generation === comparisonGeneration.current) {
        setComparisonRunning((count) => Math.max(0, count - 1));
      }
    }
  };

  const identifyCurrentPages = () => captureCurrentPages();

  const savePageCheckpoint = async () => {
    const name = checkpointName.trim();
    if (!name) {
      setComparisonError('请先输入或选择页面名称，例如“首页”“分类”或“我的”。');
      setComparisonPanelOpen(true);
      return;
    }
    const saved = await captureCurrentPages(name);
    if (saved) {
      setCheckpointName((current) => current.trim() === name ? '' : current);
    }
  };

  const syncAction = async (
    action: ActionRequest,
    sourceSize: DeviceSize,
    sourceId: string,
    captureId?: string,
  ) => {
    if (!syncEnabled) return;
    const targets = getSyncTargets(devices, sourceId);
    if (targets.length === 0) return;
    const generation = syncGeneration.current;
    const comparisonRun = comparisonGeneration.current;
    setSyncStatus({ kind: 'syncing', message: `正在同步到 ${targets.length} 台设备` });
    const task = syncQueue.current.then(async () => {
      const capture = syncMapping === 'vision' && !captureId
        ? await captureSyncSource(sourceId).catch((error) => {
          throw new Error(`视觉识别无法读取来源截图：${errorMessage(error)}`);
        })
        : undefined;
      const results = await Promise.allSettled(
        targets.map(async (target) => {
          // Resolution and delivery happen in one server request. This avoids
          // reporting success when the second, front-end action request is
          // lost while a slow receiving phone is still processing the first.
          const result = await sendSyncAction(
            sourceId,
            target.id,
            action,
            syncMapping,
            captureId || capture?.captureId,
          );
          if (!result.executed || result.match === 'unmatched') {
            return {
              ok: false,
              message: `${target.name}：${result.reason || '未找到对应控件，已跳过'}`,
            } satisfies SyncTaskResult;
          }
          const mappingLabel =
            result.match === 'vision'
              ? '（视觉识别）'
              : result.match === 'semantic'
              ? '（控件匹配）'
              : result.match === 'native'
                ? '（系统操作）'
                : '（坐标）';
          return {
            ok: true,
            message: `${target.name}${mappingLabel}`,
          } satisfies SyncTaskResult;
        }),
      );
      if (generation !== syncGeneration.current) return;
      const successfulTargets = results.flatMap((result, index) => (
        result.status === 'fulfilled' && result.value.ok
          ? [targets[index]]
          : []
      ));
      let comparisonError: string | undefined;
      if (successfulTargets.length > 0 && comparisonRun === comparisonGeneration.current) {
        setComparisonRunning((count) => count + 1);
        try {
          // Keep this inside the sync queue. Otherwise a second gesture can
          // replace the page before the first gesture has been compared.
          const comparison = await startSyncPageComparison(
            sourceId,
            successfulTargets.map((target) => target.id),
            action,
          );
          if (comparisonRun === comparisonGeneration.current) {
            setComparisons((previous) => [comparison, ...previous].slice(0, 20));
          }
        } catch (error) {
          comparisonError = errorMessage(error);
        } finally {
          if (comparisonRun === comparisonGeneration.current) {
            setComparisonRunning((count) => Math.max(0, count - 1));
          }
        }
      }
      const failed = results.flatMap((result, index) => {
        if (result.status === 'rejected') {
          return [`${targets[index].name}：${errorMessage(result.reason)}`];
        }
        return result.value.ok ? [] : [result.value.message];
      });
      if (failed.length > 0) {
        setSyncStatus({
          kind: 'error',
          message: `同步 ${targets.length - failed.length}/${targets.length} 台成功；${failed.join('；')}${comparisonError ? `；页面 UI 差异生成失败：${comparisonError}` : ''}`,
        });
      } else if (comparisonError) {
        setSyncStatus({
          kind: 'error',
          message: `同步已完成，但页面 UI 差异生成失败：${comparisonError}`,
        });
      } else {
        setSyncStatus({
          kind: 'success',
          message: `已同步：${results.map((result) =>
            result.status === 'fulfilled' ? result.value.message : '').filter(Boolean).join('、')}`,
        });
      }
    });
    syncQueue.current = task.catch(() => undefined);
    await task;
  };

  const nativeTouch = useNativeTouch({
    enabled: syncEnabled && syncSource === 'native',
    source: nativeSource,
    fallbackSize: nativeSource ? getDeviceInputSize(nativeSource) : undefined,
    onGesture: syncAction,
  });

  useEffect(() => {
    if (!syncEnabled || syncSource !== 'native') return;
    const address = nativeTouch.readError || nativeTouch.status?.error;
    if (address) setSyncStatus({ kind: 'error', message: address });
    else if (nativeTouch.status?.state === 'listening' && (nativeTouch.status.sequence ?? 0) > 0) {
      setSyncStatus({
        kind: 'success',
        message: `已检测到实体触控（${nativeTouch.status.sequence} 次），正在同步`,
      });
    } else if (nativeTouch.status?.state === 'listening') {
      setSyncStatus({
        kind: 'success',
        message: `监听已启动，请在 ${nativeSource?.name ?? 'Android'} 屏幕上直接触控（尚无手势）`,
      });
    } else if (nativeTouch.status?.state === 'starting') {
      setSyncStatus({ kind: 'syncing', message: '正在启动实体触控监听' });
    }
  }, [
    syncEnabled,
    syncSource,
    nativeSource?.name,
    nativeTouch.readError,
    nativeTouch.status?.state,
    nativeTouch.status?.error,
    nativeTouch.status?.sequence,
  ]);

  useEffect(() => {
    if (!syncEnabled || syncSource !== 'native' || !nativeSource) return;
    const stopWhenLeaving = () => {
      navigator.sendBeacon?.(
        `/api/devices/${encodeURIComponent(nativeSource.id)}/native-touch/stop`,
      );
    };
    window.addEventListener('pagehide', stopWhenLeaving);
    return () => window.removeEventListener('pagehide', stopWhenLeaving);
  }, [syncEnabled, syncSource, nativeSource?.id]);

  return (
    <div className={`app-shell sidebar-layout page-${page} ${page === 'sync' && comparisonPanelOpen ? 'sync-comparison-panel-open' : ''}`}>
      <AppSidebar
        page={page}
        onlineCount={onlineCount}
        warningCount={warningCount(lab.snapshot)}
        syncEnabled={syncEnabled}
        testRunning={semanticTestRunning}
        mobileOpen={mobileNavOpen}
        onNavigate={navigate}
        onCloseMobile={() => setMobileNavOpen(false)}
      />
      <div className="app-main">
      <header className="app-header">
        <button
          type="button"
          className="mobile-nav-button"
          onClick={() => setMobileNavOpen(true)}
          aria-label="打开功能导航"
        >
          <Icon name="menu" />
        </button>
        <div className="brand">
          <span className="header-page-kicker">VIEWPHONE / {PAGE_TITLES[page]}</span>
          <strong className="header-page-title">{PAGE_DESCRIPTIONS[page]}</strong>
        </div>
        <div className="header-center">
          <span className="local-status"><span />本机连接</span>
          <span className="header-divider" />
          <span>{onlineCount} 台在线</span>
        </div>
        <div className="header-actions">
          <button className="header-quick-button" onClick={() => void refresh()} disabled={manualRefresh} title="重新扫描设备">
            <Icon name="refresh" className={manualRefresh ? 'spinning' : ''} />
            <span>{manualRefresh ? '扫描中' : '重新扫描'}</span>
          </button>
        </div>
      </header>

      <main className={`workspace multi-device-workspace ${page === 'sync' && comparisonPanelOpen ? 'sync-comparison-panel-open' : ''}`}>
        <div className="main-column">
          {showConnectionBanner && (
            <div className="connection-banner">
              <Icon name="alert" />
              <div>
                <strong>{lab.error || '暂时没有可操作的手机'}</strong>
                <p>请在右侧连接诊断中检查工具、数据线、开发者选项和设备授权。</p>
              </div>
              <button onClick={refresh}>重新扫描 <Icon name="chevron" /></button>
            </div>
          )}
          {(page === 'devices' || page === 'sync') && <header className="multi-device-heading">
            <div>
              <span className="eyebrow">{page === 'devices' ? 'CONNECTED DEVICE' : 'MULTI-DEVICE WORKBENCH'}</span>
              <h2>{page === 'devices' ? '设备总览' : '多设备同步'}</h2>
              <p>
                {page === 'devices'
                  ? '查看并操作当前手机，同时检查各平台的工具、授权和连接状态。'
                  : syncEnabled
                  ? syncSource === 'computer'
                    ? '在任意手机画面用鼠标操作，其他设备自动执行相同操作。'
                    : nativeSource
                      ? `直接在 ${nativeSource.name} 上触控，其他设备自动跟随。`
                      : '当前没有可监听的 Android 手机。'
                  : '每块画面都可独立点击和滑动，也可开启多设备同步。'}
              </p>
            </div>
            <div className="multi-device-heading-actions">
              {page === 'devices' && slots.filter((slot) => slot.device?.state === 'device').length > 0 && (
                <div className="device-select-tabs" role="tablist" aria-label="选择设备">
                  {slots.filter((slot) => slot.device?.state === 'device').map((slot) => (
                    <button
                      type="button"
                      role="tab"
                      key={slot.key}
                      className={slot.device?.id === selectedSlot?.device?.id ? 'active' : ''}
                      aria-selected={slot.device?.id === selectedSlot?.device?.id}
                      onClick={() => slot.device && lab.setSelectedId(slot.device.id)}
                    >
                      <span className={`platform-dot platform-${slot.platform}`} />
                      {slot.device?.name}
                    </button>
                  ))}
                </div>
              )}
              {page === 'sync' && <>
                <button
                  type="button"
                  className={`device-compare-button ${comparisonPanelOpen ? 'open' : ''}`}
                  onClick={() => void identifyCurrentPages()}
                  disabled={onlineCount < 2 || comparisonRunning > 0}
                  aria-expanded={comparisonPanelOpen}
                  aria-controls="sync-page-comparison"
                  title={onlineCount < 2
                    ? '至少需要两台在线设备才能对比页面'
                    : '立即截取所有在线设备，并在后台识别页面 UI 差异'}
                >
                  <Icon name="compare" />
                  实时对比差异
                  {comparisons.length > 0 && <small>{comparisons.length}</small>}
                </button>
                <button className="compact-button" onClick={refresh} disabled={manualRefresh}>
                  <Icon name="refresh" className={manualRefresh ? 'spinning' : ''} />
                  {manualRefresh ? '扫描中' : '重新扫描'}
                </button>
              </>}
            </div>
          </header>}
          {page === 'sync' && (
            <section className="sync-checkpoint-bar" aria-label="页面打点">
              <div className="sync-checkpoint-copy">
                <span className="sync-checkpoint-icon"><Icon name="point" /></span>
                <div>
                  <strong>页面检查点</strong>
                  <p>浏览到目标页面后打点。全部在线设备会并行保存当前画面，再在后台对比并自动归档。</p>
                </div>
              </div>
              <div className="sync-checkpoint-presets" aria-label="常用页面名称">
                {CHECKPOINT_PRESETS.map((name) => (
                  <button
                    type="button"
                    key={name}
                    className={checkpointName === name ? 'active' : ''}
                    onClick={() => setCheckpointName(name)}
                    aria-pressed={checkpointName === name}
                  >{name}</button>
                ))}
              </div>
              <div className="sync-checkpoint-action">
                <input
                  value={checkpointName}
                  maxLength={80}
                  onChange={(event) => setCheckpointName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && comparisonRunning === 0) void savePageCheckpoint();
                  }}
                  placeholder="输入页面名称，如：活动页"
                  aria-label="页面打点名称"
                />
                <button
                  type="button"
                  className="sync-checkpoint-button"
                  onClick={() => void savePageCheckpoint()}
                  disabled={onlineCount < 2 || comparisonRunning > 0}
                  title={onlineCount < 2
                    ? '至少需要两台在线设备才能打点对比'
                    : '保存当前全部在线设备页面并开始异步对比'}
                >
                  {comparisonRunning > 0 ? <span className="spinner" /> : <Icon name="point" />}
                  {comparisonRunning > 0 ? '正在打点' : '页面打点'}
                </button>
              </div>
            </section>
          )}
          {page === 'sync' && <section className={`sync-toolbar ${syncEnabled ? 'sync-active' : ''}`} aria-label="多设备同步操作">
            <div className="sync-summary">
              <span className="sync-indicator" />
              <strong>{syncEnabled ? '同步操作已开启' : '设备独立操作'}</strong>
              <span>
                {onlineCount > 1
                  ? syncEnabled
                    ? syncSource === 'computer'
                      ? `电脑画面操作会同步到另外 ${syncTargetCount} 台设备`
                      : nativeSource
                        ? `实体触控会同步到另外 ${syncTargetCount} 台设备`
                        : '手机监听需要一台在线的 Android 设备'
                    : '开启后操作任意画面，其他设备自动跟随'
                  : onlineCount === 1
                    ? '再连接至少一台设备即可启用同步'
                    : '连接两台以上设备后即可启用'}
              </span>
            </div>
            <div className="sync-controls">
              <div className="sync-source-switch" role="group" aria-label="同步操作来源">
                <button
                  type="button"
                  className={syncSource === 'computer' ? 'active' : ''}
                  onClick={() => setSyncSource('computer')}
                  aria-pressed={syncSource === 'computer'}
                  title="在网页手机画面上用鼠标操作"
                >
                  电脑操作
                </button>
                <button
                  type="button"
                  className={syncSource === 'native' ? 'active' : ''}
                  onClick={() => setSyncSource('native')}
                  disabled={androidDevices.length === 0}
                  aria-pressed={syncSource === 'native'}
                  title={
                    androidDevices.length === 0
                      ? '实体触控监听目前仅支持 Android'
                      : '直接操作实体 Android 手机'
                  }
                >
                  手机监听
                </button>
              </div>
              {syncSource === 'native' && androidDevices.length > 1 && (
                <label>
                  <span>监听</span>
                  <select
                    value={nativeSource?.id ?? ''}
                    onChange={(event) => setNativeSourceId(event.target.value)}
                    aria-label="选择实体触控来源手机"
                  >
                    {androidDevices.map((device) => (
                      <option key={device.id} value={device.id}>{device.name}</option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                <span>定位</span>
                <select
                  value={syncMapping}
                  onChange={(event) => setSyncMapping(event.target.value as SyncMode)}
                  disabled={!syncEnabled}
                  aria-label="同步坐标映射方式"
                >
                  <option
                    value="vision"
                    disabled={syncVisionStatus?.configured === false || syncSource === 'native'}
                  >
                    视觉识别（AI）{syncVisionStatus?.configured === false ? ' · 未配置' : ''}
                  </option>
                  <option value="semantic">控件匹配</option>
                  <option value="relative">比例坐标</option>
                  <option value="pixel">原始坐标</option>
                </select>
              </label>
              <button
                className="sync-toggle"
                onClick={toggleSync}
                disabled={syncTargetCount === 0}
                aria-pressed={syncEnabled}
                title={syncTargetCount === 0 ? '至少需要两台在线设备' : undefined}
              >
                <Icon name="sync" />
                {syncEnabled ? '停止同步' : '开启同步'}
              </button>
            </div>
            {syncStatus && (
              <span className={`sync-feedback sync-${syncStatus.kind}`} role="status">
                {syncStatus.message}
              </span>
            )}
          </section>}
          {page === 'sync' && syncSource === 'native' && (
            <p className="native-touch-note" role="note">
              <span className={nativeTouch.status?.state === 'listening' ? 'listening' : ''}>
                {nativeTouchStatusText(nativeTouch.status, nativeSource?.name, nativeTouch.readError)}
              </span>
              <span>直接操作 Android 实体手机；鸿蒙和 iOS 的实体触控监听暂不支持。</span>
            </p>
          )}
          {page === 'sync' && <p className="sync-mode-note" role="note">
            {syncSource === 'native'
              ? '手机监听使用控件匹配：实体手势结束后才有触控事件，无法可靠取得动作前截图。若要在网页操作时使用视觉识别，请切换到“电脑操作”。'
              : syncMapping === 'vision'
              ? '视觉识别会同时比较来源和目标截图，找到相同的按钮、文字或滚动区域后执行；找不到时跳过，不使用坐标兜底误点。每次操作前会先生成来源截图，因此单次同步耗时通常高于控件匹配。'
              : '控件匹配按按钮、文字、节点身份和滚动区域定位，不依赖屏幕比例；未找到对应控件或页面区域时不会误操作。需要手动按画面比例同步时选择“比例坐标”。'}
          </p>}
          {(page === 'devices' || page === 'sync') && (
            <div className={`device-overview-layout ${page === 'devices' ? 'with-diagnostics' : ''}`}>
              <section
                className={`device-grid ${page === 'devices' ? 'single-device' : ''} ${syncSource === 'native' ? 'native-touch-active' : ''}`}
                aria-label={page === 'devices' ? '当前设备实时画面' : 'Android、iOS 和 HarmonyOS 设备同屏'}
              >
                {(page === 'devices' ? (selectedSlot ? [selectedSlot] : []) : connectedSlots).map((slot) => (
                  <DevicePanel
                    key={slot.key}
                    slot={slot}
                    frameIntervalMs={onlineCount > 2 ? 750 : onlineCount > 1 ? 600 : 450}
                    syncEnabled={page === 'sync' && syncEnabled && syncSource === 'computer' && !semanticTestRunning}
                    computerControlsEnabled={computerControlsEnabled}
                    computerControlsDisabledReason={computerControlsDisabledReason}
                    onSyncAction={syncAction}
                    captureSyncBeforeAction={page === 'sync' &&
                      syncEnabled && syncMapping === 'vision' && syncSource === 'computer'
                    }
                    onCaptureSyncSource={(sourceId) =>
                      captureSyncSource(sourceId)
                        .then((capture) => capture.captureId)
                        .catch((error) => {
                          setSyncStatus({
                            kind: 'error',
                            message: `视觉识别无法读取来源截图：${errorMessage(error)}`,
                          });
                          return undefined;
                        })}
                    syncLabel={
                      syncEnabled
                        ? syncSource === 'native' && slot.device?.id === nativeSource?.id
                          ? '来源'
                          : '跟随'
                        : undefined
                    }
                  />
                ))}
              </section>
              {page === 'devices' && (
                <DiagnosticsPanel
                  open
                  embedded
                  compact
                  snapshot={lab.snapshot}
                  devices={onlineDevices}
                  selectedDeviceId={selectedSlot?.device?.id}
                  onSelectDevice={lab.setSelectedId}
                  onRefresh={() => void refresh()}
                  onClose={() => undefined}
                />
              )}
            </div>
          )}

          {page === 'sync' && comparisonPanelOpen && (
            <SyncComparisonPanel
              open
              embedded={false}
              comparisons={comparisons}
              running={comparisonRunning}
              error={comparisonError}
              onClose={() => setComparisonPanelOpen(false)}
            />
          )}
          {page === 'test' && (
            <SemanticTestPanel
              open
              embedded
              devices={onlineDevices}
              onRunningChange={setSemanticTestRunning}
              onClose={() => undefined}
            />
          )}
          {page === 'records' && <ExecutionRecords embedded />}
        </div>
      </main>
      </div>
    </div>
  );
}

function warningCount(snapshot?: { diagnostics: Array<{ warnings: string[] }> }) {
  return snapshot?.diagnostics.filter((entry) => entry.warnings.length > 0).length || 0;
}

const PAGE_TITLES: Record<AppPage, string> = {
  devices: '设备总览',
  sync: '多设备同步',
  test: '语义测试',
  records: '执行记录',
};

const PAGE_DESCRIPTIONS: Record<AppPage, string> = {
  devices: '查看设备并检查连接状态',
  sync: '统一控制多台设备并对比页面',
  test: '用自然语言描述并执行测试',
  records: '检索、分享和回顾测试结果',
};

const CHECKPOINT_PRESETS = ['首页', '分类', '我的', '搜索', '购物车', '结算'] as const;

function pageFromHash(): AppPage {
  const page = window.location.hash.replace(/^#\/?/, '');
  if (page === 'compare') return 'sync';
  if (page === 'diagnostics') return 'devices';
  return page in PAGE_TITLES ? page as AppPage : 'devices';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function comparisonDevice(device: {
  id: string;
  name: string;
  platform: 'android' | 'ios' | 'harmony';
}) {
  return { id: device.id, name: device.name, platform: device.platform, imageUrl: '' };
}

function nativeTouchStatusText(
  status: { state?: string; enabled?: boolean; error?: string; sequence?: number } | undefined,
  name?: string,
  readError?: string,
) {
  if (readError || status?.error) return `监听异常：${readError || status?.error}`;
  if (status?.state === 'listening' && (status.sequence ?? 0) > 0) {
    return `已收到触控：${name ?? 'Android 手机'}`;
  }
  if (status?.state === 'listening') return `监听已开启，等待手指触控：${name ?? 'Android 手机'}`;
  if (status?.state === 'starting') return '正在读取 Android 实体触控';
  return '未启动监听';
}
