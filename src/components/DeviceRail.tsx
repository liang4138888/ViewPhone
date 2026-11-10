import type { DeviceInfo } from '../../shared/types';
import { Icon } from './Icon';
import { PlatformMark } from './PlatformMark';

type Props = {
  devices: DeviceInfo[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
};

export function DeviceRail({ devices, selectedId, onSelect, onRefresh, refreshing }: Props) {
  return (
    <aside className="device-rail" aria-label="已连接设备">
      <div className="rail-heading">
        <div>
          <span className="eyebrow">DEVICE LAB</span>
          <h2>已连接设备</h2>
        </div>
        <button
          className="icon-button subtle"
          onClick={onRefresh}
          aria-label="重新扫描设备"
          title="重新扫描设备"
        >
          <Icon name="refresh" className={refreshing ? 'spinning' : ''} />
        </button>
      </div>

      <div className="device-count">
        <span className="live-dot" />
        {devices.length > 0 ? `${devices.length} 台设备` : '等待设备接入'}
      </div>

      <div className="device-list">
        {devices.map((device) => (
          <button
            key={device.id}
            className={`device-card ${selectedId === device.id ? 'selected' : ''}`}
            onClick={() => onSelect(device.id)}
            aria-current={selectedId === device.id ? 'page' : undefined}
          >
            <span className="device-icon"><Icon name="phone" /></span>
            <span className="device-copy">
              <strong>{device.name}</strong>
              <PlatformMark platform={device.platform} />
              <span className={`device-state state-${device.state}`}>
                {device.state === 'device'
                  ? '在线'
                  : device.state === 'unauthorized'
                    ? '待授权'
                    : '离线'}
              </span>
            </span>
            {selectedId === device.id && <span className="selected-bar" />}
          </button>
        ))}
        {devices.length === 0 && (
          <div className="rail-empty">
            <span className="rail-empty-icon"><Icon name="phone" /></span>
            <p>没有检测到手机</p>
            <small>使用数据线连接后，在手机上允许调试授权。</small>
          </div>
        )}
      </div>

      <div className="rail-foot">
        <span className="privacy-shield"><Icon name="lock" /></span>
        <div>
          <strong>仅在本机运行</strong>
          <p>画面与控制不会上传云端</p>
        </div>
      </div>
    </aside>
  );
}
