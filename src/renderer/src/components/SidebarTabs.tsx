import { useTranslation } from 'react-i18next';
import { type SidebarTab } from '@/store/store';
import { type AccentColorName } from '@/design/tokens';
import { Icon, type IconName } from './Icon';
import { PixelTabs } from './PixelTabs';

// v0.3.4: the files tab is gone — the per-agent IDE button (header) opens the
// full Monaco editor + file tree, which superseded the read-only browser.
const TABS: { key: SidebarTab; labelKey: string; icon: IconName }[] = [
  { key: 'terminal', labelKey: 'sidebar.terminal', icon: 'terminal' },
  { key: 'git',      labelKey: 'sidebar.git',      icon: 'code' },
  { key: 'messages', labelKey: 'sidebar.messages', icon: 'bell' },
  { key: 'traces',   labelKey: 'sidebar.traces',   icon: 'web' }
];

export interface SidebarTabsProps {
  current: SidebarTab;
  accent: AccentColorName;
  onChange: (tab: SidebarTab) => void;
}

export function SidebarTabs({ current, accent, onChange }: SidebarTabsProps) {
  const { t } = useTranslation();
  return (
    <PixelTabs
      variant="strip"
      accentColor={`var(--cth-${accent})`}
      current={current}
      onChange={(key) => onChange(key as SidebarTab)}
      items={TABS.map((tab) => ({
        key: tab.key,
        icon: <Icon name={tab.icon} />,
        label: t(tab.labelKey).toUpperCase()
      }))}
    />
  );
}
