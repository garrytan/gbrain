import React, { useState, useEffect, useMemo } from 'react';
import { LoginPage } from './pages/Login';
import { AgentsPage } from './pages/Agents';
import { RequestLogPage } from './pages/RequestLog';
import { TaskCenterPage } from './pages/TaskCenter';
import { CalibrationPage } from './pages/Calibration';
import {
  DreamCalibrationPage,
  DreamExecutePage,
  DreamInsightsPage,
  DreamKnowledgePage,
  DreamOverviewPage,
  DreamScoringPage,
  DreamTakesPage,
} from './pages/Dream';
import { BrainDataPage } from './pages/BrainData';
import { ImportDataPage, NaturalLanguagePage } from './pages/Import';
import { KnowledgeHealthPage, KnowledgeWorkbenchPage } from './pages/Knowledge';
import { ConnectionCenterPage } from './pages/Connection';
import { DocumentationPage } from './pages/Documentation';
import { ModelConfigPage, SettingsPage, type SettingsSection } from './pages/Settings';
import { api } from './api';
import {
  applyThemeMode,
  normalizeThemeMode,
  readStoredThemeMode,
  readThemeMode,
  storeThemeMode,
  type ThemeMode,
} from './lib/theme';
import {
  Activity, BookOpenText, Bot, BrainCircuit, Cable,
  Database, FileClock, FolderKanban, HeartHandshake, LayoutDashboard, ListTodo,
  MonitorCog, Sparkles, type LucideIcon,
  Orbit,
} from 'lucide-react';

const PAGES = [
  'login', 'dashboard', 'natural',
  'dream', 'dream-execute', 'dream-knowledge', 'dream-takes', 'dream-scoring', 'dream-calibration', 'dream-insights',
  'import', 'data', 'graph', 'docs',
  'mcp', 'tasks', 'health', 'config', 'agents', 'log', 'calibration',
  'settings', 'settings-general', 'settings-knowledge', 'settings-dream',
] as const;

const KnowledgeGraphPage = React.lazy(() => import('./pages/KnowledgeGraph').then(module => ({
  default: module.KnowledgeGraphPage,
})));

type Page = typeof PAGES[number];

function pageFromTarget(target: string): Page {
  const hash = target.replace('#', '').split('?')[0] || 'dashboard';
  return PAGES.includes(hash as Page) ? hash as Page : 'dashboard';
}

function getPage(): Page {
  return pageFromTarget(window.location.hash);
}

type NavIconName =
  | 'overview' | 'workspace' | 'database' | 'organize' | 'mcp' | 'tasks' | 'log' | 'assistant'
  | 'graph' | 'health'
  | 'settings-general' | 'settings-knowledge' | 'settings-dream';

const NAV_ICONS: Record<NavIconName, LucideIcon> = {
  overview: LayoutDashboard,
  workspace: FolderKanban,
  database: Database,
  graph: Orbit,
  organize: BookOpenText,
  mcp: Cable,
  tasks: ListTodo,
  log: FileClock,
  health: Activity,
  assistant: Bot,
  'settings-general': MonitorCog,
  'settings-knowledge': Database,
  'settings-dream': Sparkles,
};

const SETTINGS_NAV_ITEMS: Array<{
  page: Page;
  section?: SettingsSection;
  label: string;
  icon: NavIconName;
}> = [
  { page: 'mcp', label: 'MCP', icon: 'mcp' },
  { page: 'settings-dream', section: 'dream', label: '自动化', icon: 'settings-dream' },
  { page: 'settings-knowledge', section: 'knowledge', label: '知识库设置', icon: 'settings-knowledge' },
  { page: 'settings-general', section: 'general', label: '其他设置', icon: 'settings-general' },
];

const SETTINGS_PAGE_SECTIONS: Partial<Record<Page, SettingsSection>> = {
  settings: 'general',
  ...Object.fromEntries(SETTINGS_NAV_ITEMS.filter(item => item.section).map(item => [item.page, item.section])),
};

function NavIcon({ name }: { name: NavIconName }) {
  const Icon = NAV_ICONS[name];
  return <Icon className="nav-icon" aria-hidden="true" />;
}

function BrandMark() {
  return <span className="brand-mark" aria-hidden="true"><BrainCircuit /></span>;
}

export function App({ embedded = false }: { embedded?: boolean } = {}) {
  const [page, setPage] = useState<Page>(getPage);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => readThemeMode());
  const [supportPanel, setSupportPanel] = useState<'wecom' | 'donate' | null>(null);
  const wecomQrSrc = `${import.meta.env.BASE_URL}wecom-helper.jpg`;
  const donationQrSrc = `${import.meta.env.BASE_URL}wechat-donation.jpg`;
  const customerServiceQrSrc = `${import.meta.env.BASE_URL}customer-service-qr.png`;
  const navSections: Array<{ title: string; items: Array<{ page: Page; label: string; icon: NavIconName }> }> = useMemo(() => [
    { title: '工作台', items: [
      { page: 'import', label: '知识工作台', icon: 'workspace' },
    ] },
    { title: '知识', items: [
      { page: 'data', label: '知识库', icon: 'database' },
      { page: 'graph', label: '知识图谱', icon: 'graph' },
    ] },
    { title: '知识整理', items: [
      { page: 'dream', label: '知识整理', icon: 'organize' },
    ] },
    { title: '运行', items: [
      { page: 'tasks', label: '任务中心', icon: 'tasks' },
      { page: 'health', label: '知识库健康', icon: 'health' },
      { page: 'log', label: '请求日志', icon: 'log' },
    ] },
  ], []);
  const allNavItems = useMemo(() => [
    { page: 'dashboard' as Page, label: '总体概览' },
    ...navSections.flatMap(section => section.items.map(({ page: itemPage, label }) => ({ page: itemPage, label }))),
    ...SETTINGS_NAV_ITEMS.map(({ page: itemPage, label }) => ({ page: itemPage, label })),
  ], [navSections]);

  useEffect(() => {
    const onHash = () => setPage(getPage());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (!embedded) return applyThemeMode(themeMode);
  }, [themeMode, embedded]);

  useEffect(() => {
    if (embedded || page === 'login') return;
    let active = true;
    const syncDesktopTheme = () => {
      void api.theme()
        .then((result) => {
          if (active && readStoredThemeMode() === null) {
            setThemeMode(normalizeThemeMode((result as { source?: unknown }).source));
          }
        })
        .catch(() => undefined);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') syncDesktopTheme();
    };
    syncDesktopTheme();
    window.addEventListener('focus', syncDesktopTheme);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      active = false;
      window.removeEventListener('focus', syncDesktopTheme);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [page, embedded]);

  const navigate = (target: string) => {
    window.location.hash = target;
    setPage(pageFromTarget(target));
  };

  const changeThemeMode = (mode: ThemeMode) => {
    storeThemeMode(mode);
    setThemeMode(mode);
  };

  if (page === 'login') {
    return <LoginPage onLogin={() => navigate('dashboard')} />;
  }

  const handleSignOutEverywhere = async () => {
    if (!confirm('退出所有管理员会话，包括其他浏览器和标签页？每个会话都需要使用新的登录链接重新验证。')) {
      return;
    }
    try {
      await api.signOutEverywhere();
    } catch {
      // Even if the call fails, push to login; the cookie is likely already invalid.
    }
    navigate('login');
  };

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="sidebar-logo">
          <BrandMark />
          <div>
            <b>PMBrain</b>
            <small>知识控制台</small>
          </div>
        </div>
        <div className="sidebar-nav">
          <button type="button" className={`nav-item nav-item-overview ${page === 'dashboard' ? 'active' : ''}`} onClick={() => navigate('dashboard')}>
            <NavIcon name="overview" /><span>总体概览</span>
          </button>
          {navSections.map(section => (
            <section className="nav-section" key={section.title} aria-label={section.title}>
              <div className="nav-section-label">{section.title}</div>
              {section.items.map(item => (
                <button type="button" key={item.page} className={`nav-item ${page === item.page ? 'active' : ''}`} onClick={() => navigate(item.page)}>
                  <NavIcon name={item.icon} /><span>{item.label}</span>
                </button>
              ))}
            </section>
          ))}
          <section className="nav-section nav-section-settings" aria-label="设置">
            <div className="nav-section-label">设置</div>
            {SETTINGS_NAV_ITEMS.map(item => (
              <button
                type="button"
                key={item.page}
                className={`nav-item nav-subitem ${(item.section ? SETTINGS_PAGE_SECTIONS[page] === item.section : page === item.page) ? 'active' : ''}`}
                onClick={() => navigate(item.page)}
              >
                <NavIcon name={item.icon} /><span>{item.label}</span>
              </button>
            ))}
          </section>
        </div>
        <div className="sidebar-support">
          <button className="support-link" onClick={() => setSupportPanel('wecom')}>
            <NavIcon name="assistant" />
            <span>使用帮助</span>
          </button>
          <button
            onClick={handleSignOutEverywhere}
            className="signout-button"
            title="撤销所有浏览器和标签页中的管理员会话"
          >
            退出所有会话
          </button>
        </div>
      </nav>
      <header className="mobile-nav">
        <div className="mobile-brand"><BrandMark /><b>PMBrain</b></div>
        <select
          aria-label="选择管理台页面"
          value={page === 'settings' ? 'settings-general' : allNavItems.some(item => item.page === page) ? page : 'dashboard'}
          onChange={event => navigate(event.target.value as Page)}
        >
          <option value="dashboard">总体概览</option>
          {navSections.map(section => <optgroup key={section.title} label={section.title}>{section.items.map(item => <option key={item.page} value={item.page}>{item.label}</option>)}</optgroup>)}
          <optgroup label="设置">{SETTINGS_NAV_ITEMS.map(item => <option key={item.page} value={item.page}>{item.label}</option>)}</optgroup>
        </select>
        <button type="button" className="mobile-signout" onClick={handleSignOutEverywhere}>退出</button>
      </header>
      <main className="main">
        {page === 'dashboard' && <KnowledgeWorkbenchPage onNavigate={navigate} />}
        {page === 'dream' && <DreamOverviewPage />}
        {page === 'dream-execute' && <DreamExecutePage />}
        {page === 'dream-knowledge' && <DreamKnowledgePage />}
        {page === 'dream-takes' && <DreamTakesPage />}
        {page === 'dream-scoring' && <DreamScoringPage />}
        {page === 'dream-calibration' && <DreamCalibrationPage />}
        {page === 'dream-insights' && <DreamInsightsPage />}
        {page === 'import' && <ImportDataPage />}
        {page === 'data' && <BrainDataPage />}
        {page === 'graph' && (
          <React.Suspense fallback={<div className="pm-empty">正在打开知识星图…</div>}>
            <KnowledgeGraphPage />
          </React.Suspense>
        )}
        {page === 'docs' && <DocumentationPage />}
        {page === 'natural' && <NaturalLanguagePage />}
        {page === 'mcp' && <ConnectionCenterPage />}
        {page === 'tasks' && <TaskCenterPage />}
        {page === 'health' && <KnowledgeHealthPage onNavigate={navigate} />}
        {page === 'config' && <ModelConfigPage />}
        {page === 'agents' && <AgentsPage />}
        {page === 'log' && <RequestLogPage />}
        {page === 'calibration' && <CalibrationPage />}
        {SETTINGS_PAGE_SECTIONS[page] && (
          <SettingsPage section={SETTINGS_PAGE_SECTIONS[page]} themeMode={themeMode} onThemeModeChange={changeThemeMode} />
        )}
      </main>
      {supportPanel && (
        <div className="modal-overlay" onClick={() => setSupportPanel(null)}>
          <div className={`modal support-modal${supportPanel === 'donate' ? ' support-modal-donation' : ''}`} onClick={e => e.stopPropagation()}>
            <button type="button" className="drawer-close" aria-label="关闭使用帮助" onClick={() => setSupportPanel(null)}>&#10005;</button>
            {supportPanel === 'wecom' && (
              <>
                <div className="support-modal-header">
                  <div className="modal-title">使用帮助</div>
                  <p>关注产品更新，或添加客服协助处理使用问题。</p>
                </div>
                <div className="support-contact-grid">
                  <section className="support-contact-card support-contact-card-official">
                    <div className="support-contact-copy">
                      <span className="support-contact-label">产品动态</span>
                      <h3>扫码关注开发者公众号，获取使用方法和最新信息</h3>
                      <p>打开微信扫码关注。</p>
                    </div>
                    <div className="support-qr-stage">
                      <img className="support-qr support-qr-official" src={wecomQrSrc} alt="PMBrain 开发者公众号二维码" />
                    </div>
                  </section>
                  <section className="support-contact-card support-contact-card-service">
                    <div className="support-contact-copy">
                      <span className="support-contact-label">问题处理</span>
                      <h3>遇到问题，添加客服好友</h3>
                      <p>扫码添加客服，协助处理使用问题。</p>
                    </div>
                    <div className="support-qr-stage">
                      <img className="support-qr support-qr-service" src={customerServiceQrSrc} alt="客服微信二维码" />
                    </div>
                  </section>
                </div>
                <div className="donation-invite">
                  <div>
                    <b>愿意支持 PMBrain？</b>
                      <p>认为产品还不错的话可进行打赏，你的支持是产品更新的动力。</p>
                  </div>
                  <button type="button" className="pm-ghost donation-button" onClick={() => setSupportPanel('donate')}>
                    <HeartHandshake aria-hidden="true" />
                    打赏支持
                  </button>
                </div>
              </>
            )}
            {supportPanel === 'donate' && (
              <>
                <div className="modal-title">支持 PMBrain</div>
                <div className="donation-panel">
                  <div>
                    <h3>如果你愿意支持</h3>
                    <p>认为产品还不错的话可进行打赏，你的支持是产品更新的动力。</p>
                  </div>
                  <img className="donation-qr" src={donationQrSrc} alt="微信支付收款二维码" />
                  <button type="button" className="pm-ghost donation-back" onClick={() => setSupportPanel('wecom')}>
                    返回公众号二维码
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
