export interface SettingNavItem { key: string; label: string; group: string; desktop?: boolean }
export function visibleSettingItems<T extends SettingNavItem>(items: T[], query: string, desktop: boolean): T[] {
  const text = query.trim().toLowerCase();
  return items.filter(item => (desktop || !item.desktop || item.key === 'models') && (!text || item.label.toLowerCase().includes(text) || item.group.toLowerCase().includes(text)));
}
export function settingGroupNames(items: SettingNavItem[]): string[] {
  return [...new Set(items.map(item => item.group))];
}
