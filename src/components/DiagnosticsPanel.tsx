import type {
  Diagnostics,
  Platform,
  DeviceInfo,
  DeviceListResponse,
  ToolAvailability,
} from '../../shared/types';
import { Icon } from './Icon';
import { selectDiagnosticDevice } from '../lib/diagnosticSelection';

type Props = {
  open: boolean;
  onClose: () => void;
  snapshot?: DeviceListResponse;
  onRefresh: () => void;
  embedded?: boolean;
  compact?: boolean;
  devices?: DeviceInfo[];
  selectedDeviceId?: string;
  onSelectDevice?: (deviceId: string) => void;
};

const names: Record<Platform, string> = {
  android: 'Android',
  ios: 'iOS',
  harmony: 'HarmonyOS',
};

const guidance: Record<Platform, { install: string; connect: string }> = {
  android: {
    install: '需要 Android SDK Platform-Tools（adb）',
    connect: '开启开发者选项与 USB 调试，在手机上允许这台电脑',
  },
  ios: {
    install: '需要完整 Xcode + 已签名 WebDriverAgent',
    connect: '用 USB 信任这台电脑，并启动 WDA 服务后重新扫描',
  },
  harmony: {
    install: '需要 DevEco Studio 或 HarmonyOS 命令行工具（hdc）',
    connect: '开启开发者选项与 USB 调试，在手机上允许 HDC 连接',
  },
};

export function DiagnosticsPanel({
  open,
  onClose,
  snapshot,
  onRefresh,
  embedded = false,
  compact = false,
  devices = [],
  selectedDeviceId,
  onSelectDevice,
}: Props) {
  if (!open) return null;
  const diagnostics = snapshot?.diagnostics || [];
  const onlinePlatforms = diagnostics.filter((entry) => entry.deviceCount > 0).length;
  const warningCount = diagnostics.reduce((total, entry) => total + entry.warnings.length, 0);
  const content = (
      <aside
        className={`diagnostics-drawer ${embedded ? 'embedded' : ''} ${compact ? 'compact' : ''}`}
        role="dialog"
        aria-modal={embedded ? undefined : true}
        aria-label="连接诊断"
      >
        <header>
          <div>
            <span className="eyebrow">DEVICE HEALTH</span>
            <h2>连接与授权</h2>
          </div>
          {!embedded && (
            <button className="icon-button" onClick={onClose} aria-label="关闭诊断">
              <Icon name="close" />
            </button>
          )}
        </header>
        <p className="drawer-intro">工具、USB 授权和设备连接状态集中显示在这里。</p>
        {snapshot && (
          <div className="diagnostic-health-summary" aria-label="连接概览">
            <span>
              <strong>{onlinePlatforms}<small> / 3</small></strong>
              <em>平台在线</em>
            </span>
            <span className={warningCount > 0 ? 'has-warning' : ''}>
              <strong>{warningCount}</strong>
              <em>{warningCount > 0 ? '连接提示' : '无连接异常'}</em>
            </span>
          </div>
        )}
        <div className="diagnostic-list">
          {diagnostics.map((entry) => (
            <DiagnosticCard
              key={entry.platform}
              entry={entry}
              devices={devices.filter((device) => (
                device.platform === entry.platform && device.state === 'device'
              ))}
              selectedDeviceId={selectedDeviceId}
              onSelectDevice={onSelectDevice}
            />
          ))}
          {!snapshot && <p className="diagnostic-loading">正在读取本机连接信息…</p>}
        </div>
        <div className="diagnostic-actions">
          <button className="primary-button" onClick={onRefresh}>
            <Icon name="refresh" />重新扫描
          </button>
          <span>扫描时间 {snapshot ? formatTime(snapshot.refreshedAt) : '—'}</span>
        </div>
        <div className="security-note">
          <Icon name="lock" />
          <div><strong>本地服务边界</strong><p>ViewPhone 默认仅监听 127.0.0.1，不暴露到局域网或公网。</p></div>
        </div>
      </aside>
  );
  if (embedded) return content;
  return (
    <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      {content}
    </div>
  );
}

function DiagnosticCard({
  entry,
  devices,
  selectedDeviceId,
  onSelectDevice,
}: {
  entry: Diagnostics;
  devices: DeviceInfo[];
  selectedDeviceId?: string;
  onSelectDevice?: (deviceId: string) => void;
}) {
  const tool = entry.tools.adb || entry.tools.hdc || entry.tools.wda;
  const ready = Boolean(tool?.available) && entry.deviceCount > 0;
  const selected = devices.some((device) => device.id === selectedDeviceId);
  const selectPlatform = () => {
    if (!onSelectDevice) return;
    const nextId = selectDiagnosticDevice(devices, entry.platform, selectedDeviceId);
    if (nextId) onSelectDevice(nextId);
  };
  return (
    <article
      className={`diagnostic-card ${ready ? 'ready' : ''} ${devices.length > 0 ? 'clickable' : ''} ${selected ? 'selected' : ''}`}
      onClick={selectPlatform}
      onKeyDown={(event) => {
        if (!devices.length || !onSelectDevice) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectPlatform();
        }
      }}
      role={devices.length > 0 ? 'button' : undefined}
      tabIndex={devices.length > 0 ? 0 : undefined}
      aria-label={devices.length > 0
        ? `切换到 ${devices[0].name}${devices.length > 1 ? `，${names[entry.platform]} 共 ${devices.length} 台` : ''}`
        : undefined}
    >
      <div className="diagnostic-heading">
        <span className="tool-name">{names[entry.platform]}</span>
        <span className={`diagnostic-state ${ready ? 'ok' : 'muted'}`}>
          <span />{ready ? `${entry.deviceCount} 台在线` : entry.deviceCount > 0 ? '待授权' : '未连接'}
        </span>
      </div>
      {entry.deviceCount > 0 && (
        <p className="diagnostic-device-count">
          {selected ? '当前正在显示这台设备，点击具体设备可切换。' : '点击这里切换到该平台，或直接选择具体设备。'}
        </p>
      )}
      {devices.length > 0 && (
        <div className="diagnostic-device-list" aria-label={`${names[entry.platform]} 设备选择`}>
          {devices.map((device) => (
            <button
              type="button"
              key={device.id}
              className={device.id === selectedDeviceId ? 'active' : ''}
              onClick={(event) => {
                event.stopPropagation();
                onSelectDevice?.(device.id);
              }}
              aria-pressed={device.id === selectedDeviceId}
            >
              <span />
              {device.name}
            </button>
          ))}
        </div>
      )}
      <ToolLine platform={entry.platform} tool={entry.tools.adb || entry.tools.hdc || entry.tools.wda} />
      {entry.tools.ffmpeg && entry.platform === 'android' && <ToolLine name="ffmpeg" tool={entry.tools.ffmpeg} />}
      {entry.warnings.map((warning) => <p className="warning-text" key={warning}>{warning}</p>)}
      {!ready && <div className="setup-guidance">
        <p><span>准备</span>{guidance[entry.platform].install}</p>
        <p><span>连接</span>{guidance[entry.platform].connect}</p>
      </div>}
    </article>
  );
}

function ToolLine({ name, platform, tool }: { name?: string; platform?: Platform; tool?: ToolAvailability }) {
  if (!tool) return null;
  const label = name || (platform === 'android' ? 'adb' : platform === 'harmony' ? 'hdc' : 'WDA');
  return (
    <div className="tool-line">
      <span className={`tool-light ${tool.available ? 'online' : 'offline'}`} />
      <span className="tool-label">{label}</span>
      <span className="tool-message" title={tool.path || undefined}>{tool.message}</span>
    </div>
  );
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}
