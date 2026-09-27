import React, { useEffect, useState } from 'react';
import { MessageCircle, Database, FileText, Network, CalendarCheck, Settings, Info, Search, Box, SlidersHorizontal, Globe, Monitor, Link, ShieldCheck, RefreshCw, ChevronRight } from 'lucide-react';
import { App as ExistingPages } from '../App';
import { ImportDataPage } from '../pages/Import';
import { SettingsPage, ModelConfigPage, AppearanceSettings } from '../pages/Settings';
import { desktopApi } from '../lib/product-fetch';
import { applyThemeMode, readThemeMode, storeThemeMode, type ThemeMode } from '../lib/theme';
import { DesktopSettings } from './DesktopSettings';
import type { SidecarState } from '../../../desktop/src/preload/index';

const settingItems = [
  { key: 'general', label: '通用设置', group: '基础', icon: Settings },
  { key: 'models', label: '模型服务与用途', group: 'AI 与模型', icon: Box, desktop: true },
  { key: 'knowledge', label: '知识库设置', group: '知识库', icon: Database },
  { key: 'basic', label: '数据库与资料目录', group: '知识库', icon: SlidersHorizontal, desktop: true },
  { key: 'dream', label: '整理设置', group: '知识整理', icon: FileText },
  { key: 'integrations', label: 'MCP 接入', group: '连接与服务', icon: Link, desktop: true },
  { key: 'system', label: '桌面、网络与启动', group: '系统', icon: Monitor, desktop: true },
  { key: 'updates', label: '软件更新', group: '系统', icon: RefreshCw, desktop: true },
  { key: 'repair', label: '数据备份与修复', group: '系统', icon: ShieldCheck, desktop: true },
];
const desktopPanels = ['models', 'basic', 'integrations', 'system', 'updates', 'repair', 'recovery'];
const currentPage = () => window.location.hash.replace(/^#/, '').split('?')[0] || 'import';
const settingKey = (page: string) => page.startsWith('settings-') ? page.slice(9) : 'models';

export function ProductApp() {
  const desktop = desktopApi();
  const [page, setPage] = useState(currentPage);
  const [legacyMobile] = useState(() => !desktop && window.matchMedia('(max-width: 767px)').matches);
  const [theme, setTheme] = useState<ThemeMode>(() => desktop ? 'dark' : readThemeMode());
  const [service, setService] = useState<SidecarState | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [stateError, setStateError] = useState('');
  const [filter, setFilter] = useState('');
  const navigate = (target: string) => { window.location.hash = target; setPage(target); };
  const isSettings = page === 'settings' || page.startsWith('settings-') || page === 'config';
  const category = page === 'config' ? 'models' : settingKey(page);
  const ready = !desktop || service?.phase === 'ready';
  useEffect(() => {
    const update = () => setPage(currentPage());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => applyThemeMode(theme), [theme]);
  useEffect(() => {
    if (!desktop) return;
    const fail = (error: unknown) => setStateError(String(error));
    void desktop.getState().then(setService).catch(fail);
    void desktop.getSetup().then(result => setNeedsSetup(result.setup.needsSetup)).catch(fail);
    void desktop.getTheme().then(result => setTheme(result.source)).catch(fail);
    const unsubscribe = desktop.onState(next => { setService(next); if (next.phase === 'ready') setNeedsSetup(false); });
    const unsubscribeTheme = desktop.onThemeState(next => setTheme(next.source));
    const unsubscribeNavigation = desktop.onNavigate(navigate);
    const unsubscribePanel = desktop.onShowPanel(panel => navigate(`settings-${panel}`));
    const unsubscribeUpdates = desktop.onShowUpdates(() => navigate('settings-updates'));
    const showPanel = (event: Event) => navigate(`settings-${(event as CustomEvent<string>).detail}`);
    window.addEventListener('pmbrain:settings-panel', showPanel);
    return () => { unsubscribe(); unsubscribeTheme(); unsubscribeNavigation(); unsubscribePanel(); unsubscribeUpdates(); window.removeEventListener('pmbrain:settings-panel', showPanel); };
  }, []);
  const changeTheme = (next: ThemeMode) => {
    if (desktop) void desktop.setTheme(next).then(() => setTheme(next)).catch(error => setStateError(String(error)));
    else { storeThemeMode(next); setTheme(next); }
  };
  if (legacyMobile || (page === 'login' && !desktop)) return <ExistingPages />;
  const nav = [[MessageCircle, '知识工作台', 'import'], [Database, '知识库', 'data'], [FileText, '知识整理', 'dream'], [Network, '知识图谱', 'graph'], [CalendarCheck, '任务中心', 'tasks']] as const;
  return <div className="product-app">
    <aside className="product-nav"><div className="product-brand"><span>P</span><b>PMBrain</b></div>
      <nav aria-label="PMBrain 主导航">{nav.map(([Icon, label, target]) => <button key={target} className={page === target ? 'active' : ''} onClick={() => navigate(target)}><Icon /><span>{label}</span></button>)}<hr /><button className={isSettings ? 'active' : ''} onClick={() => navigate('settings-models')}><Settings /><span>设置</span></button><button className={page === 'docs' ? 'active' : ''} onClick={() => navigate('docs')}><Info /><span>关于与帮助</span></button></nav>
      <button className="product-service" onClick={() => navigate(desktop ? 'settings-system' : 'health')}><i className={ready ? 'ready' : 'pending'} /><span>{ready ? '服务运行中' : needsSetup ? '等待配置' : service?.phase === 'failed' ? '服务启动失败' : '服务启动中'}<small>{desktop && service ? `localhost:${service.port}` : desktop ? '本机服务' : '知识库服务'}</small></span><ChevronRight size={17} /></button>
    </aside>
    <main className={`product-main ${isSettings ? 'is-settings' : ''}`}>
      {stateError && <div className="product-error" role="alert">{stateError}</div>}
      {!ready && <div className="product-startup" role="status"><span>{needsSetup ? '欢迎使用 PMBrain，请先配置知识库与模型。' : service?.phase === 'failed' ? service.message : '正在准备本机知识服务…'}</span><button onClick={() => navigate(service?.phase === 'failed' ? 'settings-recovery' : 'settings-basic')}>{service?.phase === 'failed' ? '查看与恢复' : '打开设置'}</button></div>}
      <section hidden={!isSettings} className="product-settings">
        <header><h1>设置</h1><p>统一管理模型服务、知识库、整理流程与桌面系统能力。</p></header>
        <div className="product-settings-grid"><aside className="product-categories"><label><Search size={20} /><input aria-label="搜索设置" placeholder="搜索设置…" value={filter} onChange={event => setFilter(event.target.value)} /></label>{Array.from(new Set(settingItems.map(item => item.group))).map(group => <section key={group}><h3>{group}</h3>{settingItems.filter(item => item.group === group && item.label.includes(filter) && (desktop || !item.desktop || item.key === 'models')).map(item => <button className={category === item.key ? 'active' : ''} key={item.key} onClick={() => navigate(`settings-${item.key}`)}><item.icon size={22} />{item.label}</button>)}</section>)}</aside>
          <div className="product-settings-body">
            {desktop && <DesktopSettings theme={theme} panel={desktopPanels.includes(category) ? category : 'models'} visible={isSettings && desktopPanels.includes(category)} />}
            {isSettings && category === 'general' && <AppearanceSettings themeMode={theme} onThemeModeChange={changeTheme} />}
            {isSettings && ['knowledge', 'dream'].includes(category) && ready && <SettingsPage section={category as 'knowledge' | 'dream'} themeMode={theme} onThemeModeChange={changeTheme} />}
            {isSettings && !desktop && category === 'models' && <ModelConfigPage />}
          </div></div>
      </section>
      <div hidden={isSettings || page !== 'import'} className="product-workbench">
        {ready ? <ImportDataPage /> : <div className="product-welcome"><div className="product-knowledge-icon">▱</div><h1>有什么可以帮你的吗？</h1><p>基于你的知识库，进行搜索、分析、总结和创作</p><button onClick={() => navigate('settings-basic')}>配置知识库与模型</button></div>}
      </div>
      {!isSettings && page !== 'import' && ready && <div className="product-existing"><ExistingPages embedded /></div>}
    </main>
  </div>;
}
