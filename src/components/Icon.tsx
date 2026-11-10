import type { ReactNode, SVGProps } from 'react';

type IconName =
  | 'back'
  | 'home'
  | 'recents'
  | 'volumeUp'
  | 'volumeDown'
  | 'power'
  | 'refresh'
  | 'lock'
  | 'unlock'
  | 'keyboard'
  | 'settings'
  | 'phone'
  | 'send'
  | 'close'
  | 'alert'
  | 'check'
  | 'expand'
  | 'chevron'
  | 'arrowUp'
  | 'arrowDown'
  | 'sync'
  | 'test'
  | 'archive'
  | 'share'
  | 'search'
  | 'compare'
  | 'point'
  | 'menu';

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}

const paths: Record<IconName, ReactNode> = {
  back: <path d="m10 6-6 6 6 6M5 12h15" />,
  home: <path d="m3 10 9-7 9 7v10H3V10Zm6 10v-7h6v7" />,
  recents: <path d="M5 5h14v14H5zM9 9h6" />,
  volumeUp: <path d="M4 10v4h4l5 4V6L8 10H4Zm13-1a4 4 0 0 1 0 6m2-9a8 8 0 0 1 0 12" />,
  volumeDown: <path d="M4 10v4h4l5 4V6L8 10H4Zm13 1h4" />,
  power: <path d="M12 2v9m6.3-5.3a9 9 0 1 1-12.6 0" />,
  refresh: <path d="M20 11a8 8 0 1 0-2.3 6M20 5v6h-6" />,
  lock: <path d="M6 11h12v10H6V11Zm3 0V7a3 3 0 0 1 6 0v4" />,
  unlock: <path d="M6 11h12v10H6V11Zm3 0V7a3 3 0 0 1 5.7-1.3" />,
  keyboard: <path d="M3 6h18v12H3V6Zm4 3h.01M11 9h.01M15 9h.01M19 9h.01M7 12h.01M11 12h.01M15 12h.01M19 12h.01M7 15h10" />,
  settings: <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm0-13v2m0 15v2M4.5 12h-2m19 0h-2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />,
  phone: <path d="M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm3 17h4" />,
  send: <path d="m22 2-7 20-4-9-9-4 20-7ZM22 2 11 13" />,
  close: <path d="m5 5 14 14M19 5 5 19" />,
  alert: <path d="M12 3 2 21h20L12 3Zm0 6v5m0 3h.01" />,
  check: <path d="m4 12 5 5L20 6" />,
  expand: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5" />,
  chevron: <path d="m9 18 6-6-6-6" />,
  arrowUp: <path d="M12 19V5m-6 6 6-6 6 6" />,
  arrowDown: <path d="M12 5v14m-6-6 6 6 6-6" />,
  sync: <path d="M20 7h-9a5 5 0 0 0-5 5m14-5-3-3m3 3-3 3M4 17h9a5 5 0 0 0 5-5M4 17l3-3m-3 3 3 3" />,
  test: <path d="M8 3h8v4l3 5v8H5v-8l3-5V3Zm0 4h8M9 15h6" />,
  archive: <path d="M4 7h16v13H4V7Zm-1-3h18v3H3V4Zm6 7h6" />,
  share: <path d="M18 8a3 3 0 1 0-2.8-4M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm12-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM8.6 15.8l6.8-3.6M8.6 8.2l6.8 3.6" />,
  search: <path d="M10.8 18a7.2 7.2 0 1 0 0-14.4 7.2 7.2 0 0 0 0 14.4Zm5.2-2 4.5 4.5" />,
  compare: <path d="M4 5h10v14H4V5Zm12-2h4v10h-4V3ZM15 2v16m3-13h3" />,
  point: <path d="M12 21s6-5.2 6-11a6 6 0 1 0-12 0c0 5.8 6 11 6 11Zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
};
