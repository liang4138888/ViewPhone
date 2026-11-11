import { useEffect, useRef, useState } from 'react';
import type { ActionRequest, DeviceInfo, Platform } from '../../shared/types';
import {
  browserPointToDevice,
  isPointInside,
  mapInputCoordinate,
  swipeDuration,
  type DeviceSize,
  type ScrollDirection,
} from '../../shared/coordinates';
import { Icon } from './Icon';
import { PlatformMark } from './PlatformMark';

type Props = {
  device?: DeviceInfo;
  platform?: Platform;
  frameUrl?: string;
  frameSize?: { width: number; height: number };
  inputSize?: DeviceSize;
  loading: boolean;
  paused: boolean;
  error?: string;
  streamError?: string;
  latency?: number;
  interactive: boolean;
  computerControlsEnabled: boolean;
  computerControlsDisabledReason?: string;
  actionPending: number;
  onAction: (action: ActionRequest) => Promise<boolean>;
  onScroll: (direction: ScrollDirection) => Promise<boolean>;
  onLastTap: (point: { x: number; y: number }) => void;
  onToggleInteractive: () => void;
  onFullscreen: () => void;
  syncLabel?: '来源' | '跟随';
};

type PointerStart = {
  pointerId: number;
  x: number;
  y: number;
  startedAt: number;
  moved: boolean;
};

export function PhoneViewport({
  device,
  platform,
  frameUrl,
  frameSize,
  inputSize,
  loading,
  paused,
  error,
  streamError,
  latency,
  interactive,
  computerControlsEnabled,
  computerControlsDisabledReason,
  actionPending,
  onAction,
  onScroll,
  onLastTap,
  onToggleInteractive,
  onFullscreen,
  syncLabel,
}: Props) {
  const imageRef = useRef<HTMLImageElement>(null);
  const start = useRef<PointerStart | undefined>(undefined);
  const wheelDirection = useRef<ScrollDirection | undefined>(undefined);
  const wheelDeltaY = useRef(0);
  const wheelTimer = useRef<number | undefined>(undefined);
  const scrollHandler = useRef(onScroll);
  const [busy, setBusy] = useState(false);
  const inputEnabled = interactive && computerControlsEnabled;

  useEffect(() => {
    scrollHandler.current = onScroll;
  }, [onScroll]);

  useEffect(() => {
    setBusy(false);
    start.current = undefined;
    wheelDirection.current = undefined;
    wheelDeltaY.current = 0;
    if (wheelTimer.current) window.clearTimeout(wheelTimer.current);
  }, [device?.id]);

  useEffect(() => {
    if (inputEnabled) return;
    start.current = undefined;
    wheelDirection.current = undefined;
    wheelDeltaY.current = 0;
    if (wheelTimer.current) window.clearTimeout(wheelTimer.current);
    wheelTimer.current = undefined;
  }, [inputEnabled]);

  useEffect(
    () => () => {
      if (wheelTimer.current) window.clearTimeout(wheelTimer.current);
    },
    [],
  );

  const toDevice = (clientX: number, clientY: number) => {
    const image = imageRef.current;
    if (!image || !frameSize) return undefined;
    const rect = image.getBoundingClientRect();
    if (!isPointInside(clientX, clientY, rect)) return undefined;
    return browserPointToDevice(clientX, clientY, rect, frameSize);
  };

  const toDeviceClamped = (clientX: number, clientY: number) => {
    const image = imageRef.current;
    if (!image || !frameSize) return undefined;
    return browserPointToDevice(clientX, clientY, image.getBoundingClientRect(), frameSize);
  };

  const pointerDown = (event: React.PointerEvent<HTMLImageElement>) => {
    if (!inputEnabled || !frameUrl || event.button !== 0) return;
    if (!toDevice(event.clientX, event.clientY)) return;
    event.preventDefault();
    imageRef.current?.setPointerCapture(event.pointerId);
    start.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startedAt: performance.now(),
      moved: false,
    };
  };

  const pointerMove = (event: React.PointerEvent<HTMLImageElement>) => {
    const pointer = start.current;
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 5) {
      pointer.moved = true;
    }
  };

  const pointerUp = async (event: React.PointerEvent<HTMLImageElement>) => {
    const pointer = start.current;
    start.current = undefined;
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    try {
      imageRef.current?.releasePointerCapture(event.pointerId);
    } catch {
      // The browser may already have released capture after a cancel.
    }
    const from = toDevice(pointer.x, pointer.y);
    const to = toDeviceClamped(event.clientX, event.clientY);
    if (!from) return;
    const elapsed = performance.now() - pointer.startedAt;
    const inputFrom = inputSize ? mapInputCoordinate(from, frameSize!, inputSize) : from;
    const inputTo = to && inputSize ? mapInputCoordinate(to, frameSize!, inputSize) : to;
    let action: ActionRequest | undefined;
    if (pointer.moved && inputTo) {
      action = {
        type: 'swipe',
        fromX: inputFrom.x,
        fromY: inputFrom.y,
        toX: inputTo.x,
        toY: inputTo.y,
        duration: swipeDuration(elapsed),
      };
    } else if (elapsed >= 600) {
      action = { type: 'longPress', x: inputFrom.x, y: inputFrom.y, duration: elapsed };
    } else {
      action = { type: 'tap', x: inputFrom.x, y: inputFrom.y };
      onLastTap(inputFrom);
    }
    if (!action) return;
    setBusy(true);
    await onAction(action);
    setBusy(false);
  };

  const cancelPointer = (event: React.PointerEvent<HTMLImageElement>) => {
    if (start.current?.pointerId === event.pointerId) start.current = undefined;
  };

  const wheel = (event: React.WheelEvent<HTMLImageElement>) => {
    if (!inputEnabled || !frameUrl || !event.deltaY) return;
    event.preventDefault();
    const direction: ScrollDirection = event.deltaY > 0 ? 'down' : 'up';
    if (wheelDirection.current && wheelDirection.current !== direction) {
      wheelDeltaY.current = 0;
    }
    wheelDirection.current = direction;
    wheelDeltaY.current += event.deltaY;
    if (wheelTimer.current) return;
    wheelTimer.current = window.setTimeout(() => {
      wheelTimer.current = undefined;
      const next = wheelDirection.current;
      const distance = Math.abs(wheelDeltaY.current);
      wheelDirection.current = undefined;
      wheelDeltaY.current = 0;
      if (next && distance >= 8) void scrollHandler.current(next);
    }, 90);
  };

  const screenStyle = frameSize
    ? ({
        aspectRatio: `${frameSize.width} / ${frameSize.height}`,
      } as React.CSSProperties)
    : undefined;
  const screenRatioStyle = frameSize
    ? ({ '--screen-ratio': frameSize.width / frameSize.height } as React.CSSProperties)
    : undefined;
  const displayPlatform = device?.platform || platform;
  const displayName =
    device?.name ||
    (displayPlatform === 'android'
      ? 'Android 设备'
      : displayPlatform === 'ios'
        ? 'iOS 设备'
        : displayPlatform === 'harmony'
          ? 'HarmonyOS 设备'
          : '手机镜像工作台');
  const systemVersion = device ? compactSystemVersion(device) : undefined;

  return (
    <section className="stage">
      <header className="stage-header">
        <div className="stage-title">
          <div className="stage-kicker">
            {displayPlatform ? <PlatformMark platform={displayPlatform} /> : <span className="eyebrow">LIVE VIEW</span>}
            {device?.state === 'device' && <span className="live-label">LIVE</span>}
            {syncLabel && (
              <span className={syncLabel === '来源' ? 'sync-controller-label' : 'sync-target-label'}>
                {syncLabel}
              </span>
            )}
          </div>
          <h1>{displayName}</h1>
          {device && (
            <p className="device-meta">
              {systemVersion && (
                <span title={`系统 ${device.osVersion}`}>系统 {systemVersion}</span>
              )}
              {device.width && device.height && (
                <span title="画面分辨率">{device.width} × {device.height}</span>
              )}
              {latency !== undefined && <span title="画面刷新延时">{latency} ms</span>}
            </p>
          )}
        </div>
        <div className="stage-actions">
          <button
            className="compact-button"
            onClick={onToggleInteractive}
            disabled={!device || !computerControlsEnabled}
            title={
              !computerControlsEnabled
                ? computerControlsDisabledReason || '当前模式下电脑画面仅查看'
                : interactive
                  ? '锁定画面，仅查看'
                  : '开启鼠标操作'
            }
          >
            <Icon name={inputEnabled ? 'unlock' : 'lock'} />
            {!computerControlsEnabled ? '仅查看' : interactive ? '可操作' : '已锁定'}
          </button>
          <button className="icon-button" onClick={onFullscreen} disabled={!device} title="进入全屏" aria-label="进入全屏">
            <Icon name="expand" />
          </button>
        </div>
      </header>

      <div className="phone-area" style={screenRatioStyle}>
        <div className={`phone-shell ${inputEnabled ? 'interactive' : 'preview-only'} ${busy ? 'busy' : ''}`}>
          <div className="phone-side phone-side-left">
            <span className="side-button side-volume-up" />
            <span className="side-button side-volume-down" />
          </div>
          <div className="phone-side phone-side-right"><span className="side-button side-power" /></div>
          <div className="phone-bezel">
            <div className="screen" style={screenStyle}>
              {frameUrl ? (
                <img
                  ref={imageRef}
                  src={frameUrl}
                  alt={`${device?.name ?? '手机'} 实时画面`}
                  className="phone-screen"
                  draggable={false}
                  onPointerDown={pointerDown}
                  onPointerMove={pointerMove}
                  onPointerUp={(event) => void pointerUp(event)}
                  onPointerCancel={cancelPointer}
                  onWheel={wheel}
                  onContextMenu={(event) => event.preventDefault()}
                />
              ) : (
                <EmptyPhone
                  loading={loading}
                  error={error}
                  paused={paused}
                  hasDevice={Boolean(device)}
                />
              )}
              {frameUrl && (loading || busy || actionPending > 0) && (
                <div className="screen-activity"><span /></div>
              )}
              {frameUrl && paused && <div className="paused-cover"><Icon name="lock" />画面已暂停</div>}
              {frameUrl && streamError && (
                <div className="stream-warning" title={streamError}>
                  画面更新失败 · {streamError}
                </div>
              )}
            </div>
          </div>
          <span className="phone-camera" />
        </div>
        <div className="phone-shadow" />
      </div>
      <p className="interaction-hint">
        {!computerControlsEnabled
          ? computerControlsDisabledReason || '电脑画面仅查看，不会向手机发送操作'
          : interactive
            ? '单击 点按 · 拖拽/滚轮 滚动 · 按住 长按'
            : '画面已锁定，不会向手机发送任何操作'}
      </p>
    </section>
  );
}

function compactSystemVersion(device: DeviceInfo) {
  const version = device.osVersion?.trim();
  if (!version) return undefined;
  const model = device.model?.trim();
  const withoutModel =
    model && version.startsWith(model)
      ? version.slice(model.length).trim()
      : device.name && version.startsWith(device.name)
        ? version.slice(device.name.length).trim()
        : version;
  return withoutModel.replace(/\s*\([^)]*\)\s*$/, '').trim() || version;
}

function EmptyPhone({ loading, error, paused, hasDevice }: { loading: boolean; error?: string; paused: boolean; hasDevice: boolean }) {
  return (
    <div className="phone-empty">
      <div className="empty-orbit"><Icon name="phone" /></div>
      <strong>{loading ? '正在获取手机画面' : paused ? '画面已暂停' : hasDevice ? '正在连接画面' : '等待手机连接'}</strong>
      <p>{error || (hasDevice ? '首次连接可能需要几秒' : '通过 USB 数据线接入 iOS、Android 或 HarmonyOS 设备')}</p>
      {loading && <span className="loading-line" />}
    </div>
  );
}
