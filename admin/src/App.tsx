import React, { useState, useEffect, useMemo } from 'react';
import { LoginPage } from './pages/Login';
import { AgentsPage } from './pages/Agents';
import { RequestLogPage } from './pages/RequestLog';
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
import {
  BrainDataPage,
  ConnectionCenterPage,
  ImportDataPage,
  KnowledgeWorkbenchPage,
  ModelConfigPage,
  NaturalLanguagePage,
  DocumentationPage,
  SettingsPage,
} from './pages/Console';
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
  BookOpenText, Bot, BrainCircuit, Cable,
  Database, FileClock, FolderKanban, HeartHandshake, LayoutDashboard,
  SlidersHorizontal, type LucideIcon,
} from 'lucide-react';

const PAGES = [
  'login', 'dashboard', 'natural',
  'dream', 'dream-execute', 'dream-knowledge', 'dream-takes', 'dream-scoring', 'dream-calibration', 'dream-insights',
  'import', 'data', 'docs',
  'mcp', 'config', 'agents', 'log', 'calibration', 'settings',
] as const;

type Page = typeof PAGES[number];

function getPage(): Page {
  const hash = window.location.hash.replace('#', '') || 'dashboard';
  return PAGES.includes(hash as Page) ? hash as Page : 'dashboard';
}

type NavIconName = 'overview' | 'workspace' | 'database' | 'organize' | 'mcp' | 'log' | 'settings' | 'assistant';

const NAV_ICONS: Record<NavIconName, LucideIcon> = {
  overview: LayoutDashboard,
  workspace: FolderKanban,
  database: Database,
  organize: BookOpenText,
  mcp: Cable,
  log: FileClock,
  settings: SlidersHorizontal,
  assistant: Bot,
};

function NavIcon({ name }: { name: NavIconName }) {
  const Icon = NAV_ICONS[name];
  return <Icon className="nav-icon" aria-hidden="true" />;
}

function BrandMark() {
  return <span className="brand-mark" aria-hidden="true"><BrainCircuit /></span>;
}

export function App() {
  const [page, setPage] = useState<Page>(getPage);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => readThemeMode());
  const [supportPanel, setSupportPanel] = useState<'wecom' | 'donate' | null>(null);
  const wecomQrSrc = `${import.meta.env.BASE_URL}wecom-helper.jpg`;
  const donationQrSrc = `${import.meta.env.BASE_URL}wechat-donation.jpg`;
  const navSections: Array<{ title: string; items: Array<{ page: Page; label: string; icon: NavIconName }> }> = useMemo(() => [
    { title: '知识', items: [
      { page: 'import', label: '知识工作台', icon: 'workspace' },
      { page: 'data', label: '知识库', icon: 'database' },
      { page: 'dream', label: '知识整理', icon: 'organize' },
    ] },
    { title: '集成', items: [
      { page: 'mcp', label: 'MCP 接入', icon: 'mcp' },
      { page: 'log', label: '请求日志', icon: 'log' },
    ] },
  ], []);
  const allNavItems = useMemo(() => [
    { page: 'dashboard' as Page, label: '总体概览' },
    ...navSections.flatMap(section => section.items.map(({ page: itemPage, label }) => ({ page: itemPage, label }))),
    { page: 'settings' as Page, label: '设置' },
  ], [navSections]);

  useEffect(() => {
    const onHash = () => setPage(getPage());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    return applyThemeMode(themeMode);
  }, [themeMode]);

  useEffect(() => {
    if (page === 'login') return;
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
  }, [page]);

  const navigate = (target: Page) => {
    window.location.hash = target;
    setPage(target);
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
          <section className="nav-section" aria-label="系统">
            <div className="nav-section-label">系统</div>
            <button type="button" className={`nav-item ${page === 'settings' ? 'active' : ''}`} onClick={() => navigate('settings')}>
              <NavIcon name="settings" /><span>设置</span>
            </button>
          </section>
        </div>
        <div className="sidebar-support">
          <button className="support-link" onClick={() => setSupportPanel('wecom')}>
            <NavIcon name="assistant" />
            <span>企微助手</span>
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
          value={allNavItems.some(item => item.page === page) ? page : 'dashboard'}
          onChange={event => navigate(event.target.value as Page)}
        >
          <option value="dashboard">总体概览</option>
          {navSections.map(section => <optgroup key={section.title} label={section.title}>{section.items.map(item => <option key={item.page} value={item.page}>{item.label}</option>)}</optgroup>)}
          <optgroup label="系统"><option value="settings">设置</option></optgroup>
        </select>
        <button type="button" className="mobile-signout" onClick={handleSignOutEverywhere}>退出</button>
      </header>
      <main className="main">
        {page === 'dashboard' && <KnowledgeWorkbenchPage onNavigate={(p) => navigate(p as Page)} />}
        {page === 'dream' && <DreamOverviewPage />}
        {page === 'dream-execute' && <DreamExecutePage />}
        {page === 'dream-knowledge' && <DreamKnowledgePage />}
        {page === 'dream-takes' && <DreamTakesPage />}
        {page === 'dream-scoring' && <DreamScoringPage />}
        {page === 'dream-calibration' && <DreamCalibrationPage />}
        {page === 'dream-insights' && <DreamInsightsPage />}
        {page === 'import' && <ImportDataPage />}
        {page === 'data' && <BrainDataPage />}
        {page === 'docs' && <DocumentationPage />}
        {page === 'natural' && <NaturalLanguagePage />}
        {page === 'mcp' && <ConnectionCenterPage />}
        {page === 'config' && <ModelConfigPage />}
        {page === 'agents' && <AgentsPage />}
        {page === 'log' && <RequestLogPage />}
        {page === 'calibration' && <CalibrationPage />}
        {page === 'settings' && (
          <SettingsPage themeMode={themeMode} onThemeModeChange={changeThemeMode} />
        )}
      </main>
      {supportPanel && (
        <div className="modal-overlay" onClick={() => setSupportPanel(null)}>
          <div className="modal support-modal" onClick={e => e.stopPropagation()}>
            <button className="drawer-close" onClick={() => setSupportPanel(null)}>&#10005;</button>
            {supportPanel === 'wecom' && (
              <>
                <div className="modal-title">企微助手</div>
                <div className="wecom-panel">
                  <img className="wecom-qr" src={wecomQrSrc} alt="PMBrain 企微助手二维码" />
                  <div className="wecom-panel-copy">
                    <h3>扫码关注开发者公众号，获取最新信息</h3>
                    <span>打开微信扫码关注。</span>
                    <div className="donation-invite">
                      <p>认为产品还不错的话可进行打赏，你的支持是产品更新的动力。</p>
                      <button type="button" className="pm-ghost donation-button" onClick={() => setSupportPanel('donate')}>
                        <HeartHandshake aria-hidden="true" />
                        打赏支持
                      </button>
                    </div>
                  </div>
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
