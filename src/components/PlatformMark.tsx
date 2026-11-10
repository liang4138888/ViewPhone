import type { Platform } from '../../shared/types';

const labels: Record<Platform, string> = {
  android: 'Android',
  ios: 'iOS',
  harmony: 'HarmonyOS',
};

export function PlatformMark({ platform }: { platform: Platform }) {
  return (
    <span className={`platform-mark platform-${platform}`}>
      <span className="platform-dot" />
      {labels[platform]}
    </span>
  );
}
