import { useState } from 'react';
import { Icon } from './Icon';

type Props = {
  pending: number;
  lastActionAt?: number;
  error?: string;
  errorCode?: string;
  onClearError: () => void;
  onOpenSettings: () => Promise<boolean>;
};

export function ControlDock({
  pending,
  lastActionAt,
  error,
  errorCode,
  onClearError,
  onOpenSettings,
}: Props) {
  const [openingSettings, setOpeningSettings] = useState(false);
  const securitySettingsError = errorCode === 'ANDROID_SECURITY_SETTINGS_REQUIRED';

  const openSettings = async () => {
    setOpeningSettings(true);
    await onOpenSettings();
    setOpeningSettings(false);
  };

  return (
    <section className="control-dock" aria-label="手机快捷操作">
      <div className="dock-state">
        {pending > 0 ? (
          <span className="working"><span className="spinner" /> 正在执行</span>
        ) : error ? (
          <button className="dock-error" onClick={onClearError} title="点击关闭">
            <Icon name="alert" />{error}
          </button>
        ) : lastActionAt ? (
          <span className="action-ok"><Icon name="check" />指令已送达</span>
        ) : (
          <span className="dock-hint">操作会直接发送到所选手机</span>
        )}
      </div>
      {securitySettingsError && (
        <div className="permission-help" role="alert">
          <span className="permission-help-icon"><Icon name="lock" /></span>
          <div className="permission-help-copy">
            <strong>需要允许模拟点击</strong>
            <p>请开启“USB 调试（安全设置）”，确认后回来重新点按画面。普通 USB 调试只能查看画面，不能控制手机。</p>
          </div>
          <button className="permission-help-action" onClick={() => void openSettings()} disabled={openingSettings}>
            {openingSettings ? <span className="spinner" /> : <Icon name="settings" />}
            {openingSettings ? '正在打开' : '打开设置'}
          </button>
          <button className="permission-help-close" onClick={onClearError} aria-label="关闭权限提示">
            <Icon name="close" />
          </button>
        </div>
      )}
    </section>
  );
}
