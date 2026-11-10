import type { ComponentProps } from 'react';
import { Icon } from './Icon';

export type AppPage = 'devices' | 'sync' | 'test' | 'records';

type IconName = ComponentProps<typeof Icon>['name'];

type NavItem = {
  page: AppPage;
  label: string;
  description: string;
  icon: IconName;
};

const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: '设备工作区',
    items: [
      { page: 'devices', label: '设备总览', description: '管理设备并检查连接状态', icon: 'phone' },
      { page: 'sync', label: '多设备同步', description: '同步操作并对比页面', icon: 'sync' },
    ],
  },
  {
    label: '测试与记录',
    items: [
      { page: 'test', label: '语义测试', description: '用自然语言执行流程', icon: 'test' },
      { page: 'records', label: '执行记录', description: '查看归档与分享结果', icon: 'archive' },
    ],
  },
];

type Props = {
  page: AppPage;
  onlineCount: number;
  warningCount: number;
  syncEnabled: boolean;
  testRunning: boolean;
  mobileOpen: boolean;
  onNavigate: (page: AppPage) => void;
  onCloseMobile: () => void;
};

export function AppSidebar({
  page,
  onlineCount,
  warningCount,
  syncEnabled,
  testRunning,
  mobileOpen,
  onNavigate,
  onCloseMobile,
}: Props) {
  return (
    <>
      {mobileOpen && (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="关闭导航"
          onClick={onCloseMobile}
        />
      )}
      <aside className={`app-sidebar ${mobileOpen ? 'mobile-open' : ''}`} aria-label="ViewPhone 功能导航">
        <button type="button" className="sidebar-brand" onClick={() => onNavigate('devices')}>
          <span className="brand-symbol"><span /><span /></span>
          <span className="sidebar-brand-copy">
            <strong>ViewPhone</strong>
            <small>DEVICE TEST LAB</small>
          </span>
        </button>

        <div className="sidebar-connection">
          <span className={onlineCount > 0 ? 'online' : ''} />
          <div>
            <strong>{onlineCount > 0 ? `${onlineCount} 台设备在线` : '等待设备连接'}</strong>
            <small>本机 USB 工作区</small>
          </div>
        </div>

        <nav className="sidebar-nav">
          {NAV_GROUPS.map((group) => (
            <section key={group.label}>
              <span className="sidebar-group-label">{group.label}</span>
              {group.items.map((item) => {
                const disabled = testRunning && page === 'test' && item.page !== 'test';
                return (
                  <button
                    type="button"
                    key={item.page}
                    className={`sidebar-nav-item ${page === item.page ? 'active' : ''}`}
                    onClick={() => !disabled && onNavigate(item.page)}
                    aria-current={page === item.page ? 'page' : undefined}
                    disabled={disabled}
                    title={disabled ? '语义测试执行中，完成后再切换页面' : item.description}
                  >
                    <span className="sidebar-nav-icon">
                      <SidebarIcon name={item.icon} />
                    </span>
                    <span className="sidebar-nav-copy">
                      <strong>{item.label}</strong>
                      <small>{item.description}</small>
                    </span>
                    {item.page === 'sync' && syncEnabled && <i className="sidebar-live-dot" title="同步已开启" />}
                    {item.page === 'devices' && warningCount > 0 && <i className="sidebar-count">{warningCount}</i>}
                  </button>
                );
              })}
            </section>
          ))}
        </nav>

        <div className="sidebar-footer">
          <span className="sidebar-security-icon"><SidebarIcon name="lock" /></span>
          <div>
            <strong>本地安全运行</strong>
            <small>设备画面与控制不会上传</small>
          </div>
        </div>
      </aside>
    </>
  );
}

function SidebarIcon({ name }: { name: IconName }) {
  return <Icon name={name} />;
}
