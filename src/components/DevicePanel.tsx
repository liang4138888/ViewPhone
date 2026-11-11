import { useRef, useState } from 'react';
import type { ActionRequest } from '../../shared/types';
import {
  createScrollSwipe,
  type DeviceSize,
  type ScrollDirection,
} from '../../shared/coordinates';
import type { DeviceSlot } from '../lib/deviceSlots';
import { getDeviceInputSize } from '../lib/deviceSync';
import { useDeviceActions } from '../hooks/useDeviceLab';
import { useDeviceFrame } from '../hooks/useDeviceFrame';
import { ControlDock } from './ControlDock';
import { PhoneViewport } from './PhoneViewport';

type Props = {
  slot: DeviceSlot;
  frameIntervalMs: number;
  syncEnabled: boolean;
  computerControlsEnabled?: boolean;
  computerControlsDisabledReason?: string;
  onSyncAction: (
    action: ActionRequest,
    sourceSize: DeviceSize,
    sourceId: string,
    captureId?: string,
  ) => Promise<void>;
  captureSyncBeforeAction: boolean;
  onCaptureSyncSource: (sourceId: string) => Promise<string | undefined>;
  syncLabel?: '来源' | '跟随';
};

export function DevicePanel({
  slot,
  frameIntervalMs,
  syncEnabled,
  computerControlsEnabled = true,
  computerControlsDisabledReason,
  onSyncAction,
  captureSyncBeforeAction,
  onCaptureSyncSource,
  syncLabel,
}: Props) {
  const { device, platform, detail } = slot;
  const panelRef = useRef<HTMLElement>(null);
  const actions = useDeviceActions(device);
  const [interactive, setInteractive] = useState(true);
  const [placeholder] = useState(() => slot.platform);
  const [lastTap, setLastTap] = useState<{ x: number; y: number }>();
  const inputSizeAtExecute = useRef<DeviceSize | undefined>(undefined);
  const frame = useDeviceFrame(
    device?.state === 'device' ? device.id : undefined,
    frameIntervalMs,
    !interactive,
  );

  const execute = async (action: ActionRequest) => {
    if (!computerControlsEnabled) return false;
    const prepared: ActionRequest =
      action.type === 'text' && lastTap
        ? { ...action, x: lastTap.x, y: lastTap.y }
        : action;
    const inputSize =
      frame.inputSize ||
      frame.size ||
      (device ? getDeviceInputSize(device) : undefined);
    if (inputSize) inputSizeAtExecute.current = inputSize;
    const sourceSize = inputSize || inputSizeAtExecute.current;
    // A sync request may spend several seconds locating a matching control on
    // a slow receiver. Do not hold the phone under the user's pointer hostage
    // during that lookup: the direct source action and receiver matching run
    // concurrently. The sync request starts first so it can snapshot the
    // current page before a navigation tap changes the source screen.
    // Vision sync needs a real pre-action frame. Capture it before starting
    // the source tap; the screenshot request and tap may otherwise race and
    // the model could receive the already-changed source screen.
    const captureId = syncEnabled && captureSyncBeforeAction && device
      ? await onCaptureSyncSource(device.id)
      : undefined;
    const visionCaptureMissing = syncEnabled && captureSyncBeforeAction && !captureId;
    const syncTask = syncEnabled && device && sourceSize && !visionCaptureMissing
      ? onSyncAction(prepared, sourceSize, device.id, captureId)
      : Promise.resolve();
    const sourceTask = actions.execute(prepared);
    const [ok] = await Promise.all([sourceTask, syncTask]);
    if (ok && prepared.type === 'tap') setLastTap({ x: prepared.x, y: prepared.y });
    return ok;
  };

  const scroll = async (direction: ScrollDirection) => {
    if (!computerControlsEnabled) return false;
    const inputSize =
      frame.inputSize ||
      frame.size ||
      (device?.inputWidth && device.inputHeight
        ? { width: device.inputWidth, height: device.inputHeight }
        : device?.width && device.height
          ? { width: device.width, height: device.height }
          : undefined);
    if (!inputSize) return false;
    return execute(createScrollSwipe(direction, inputSize));
  };

  const fullscreen = () => {
    const panel = panelRef.current;
    if (!panel) return;
    const active = document.fullscreenElement === panel;
    void (active ? document.exitFullscreen() : panel.requestFullscreen?.());
  };

  return (
    <article
      className={`device-panel device-panel-${platform}`}
      ref={panelRef}
      aria-label={`${platform} 设备画面`}
    >
      <PhoneViewport
        device={device}
        platform={platform || placeholder}
        frameUrl={frame.url}
        frameSize={frame.size}
        inputSize={frame.inputSize}
        loading={!frame.url && !frame.error && device?.state === 'device'}
        paused={!interactive}
        error={frame.error || detail}
        streamError={frame.error}
        latency={frame.latencyMs}
        interactive={Boolean(interactive && device?.state === 'device')}
        computerControlsEnabled={computerControlsEnabled}
        computerControlsDisabledReason={computerControlsDisabledReason}
        actionPending={actions.pending}
        onAction={execute}
        onScroll={scroll}
        onLastTap={setLastTap}
        onToggleInteractive={() => setInteractive((value) => !value)}
        onFullscreen={fullscreen}
        syncLabel={device?.state === 'device' ? syncLabel : undefined}
      />
      <ControlDock
        pending={actions.pending}
        lastActionAt={actions.lastActionAt}
        error={actions.lastError}
        errorCode={actions.lastErrorCode}
        onClearError={actions.clearError}
        onOpenSettings={actions.openSettings}
      />
    </article>
  );
}
