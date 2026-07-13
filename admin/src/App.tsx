import React, { useState, useEffect, useMemo } from 'react';
import { LoginPage } from './pages/Login';
import { AgentsPage } from './pages/Agents';
import { RequestLogPage } from './pages/RequestLog';
import { CalibrationPage } from './pages/Calibration';
import { JobsWatchPage } from './pages/JobsWatch';
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
  SystemDiagnosticPage,
} from './pages/Console';
import { api } from './api';
import { applyThemeMode, normalizeThemeMode, readThemeMode, type ThemeMode } from './lib/theme';

const PAGES = [
  'login', 'dashboard', 'natural',
  'dream', 'dream-execute', 'dream-knowledge', 'dream-takes', 'dream-scoring', 'dream-calibration', 'dream-insights',
  'import', 'data', 'docs',
  'mcp', 'config', 'agents', 'log', 'calibration', 'jobs', 'diagnostics', 'settings',
] as const;

type Page = typeof PAGES[number];

function getPage(): Page {
  const hash = window.location.hash.replace('#', '') || 'dashboard';
  return PAGES.includes(hash as Page) ? hash as Page : 'dashboard';
}

export function App() {
  const [page, setPage] = useState<Page>(getPage);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => readThemeMode());
  const [helpOpen, setHelpOpen] = useState(false);
  const [supportPanel, setSupportPanel] = useState<'wecom' | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const wecomQrSrc = `${import.meta.env.BASE_URL}wecom-helper.jpg`;
  const navGroups: Array<{ title: string; items: Array<{ page: Page; label: string }> }> = useMemo(() => [
    {
      title: '概览',
      items: [
        { page: 'dashboard', label: '总体概览' },
      ],
    },
    {
      title: '知识工作台',
      items: [
        { page: 'import', label: '知识工作台' },
      ],
    },
    {
      title: '知识库',
      items: [
        { page: 'data', label: '知识库' },
      ],
    },
    {
      title: '知识整理',
      items: [
        { page: 'dream', label: '知识整理' },
      ],
    },
    {
      title: '知识调用',
      items: [
        { page: 'mcp', label: 'MCP 接入' },
        { page: 'log', label: '请求日志' },
      ],
    },
    {
      title: '系统与设置',
      items: [
        { page: 'jobs', label: '任务监控' },
        { page: 'diagnostics', label: '系统诊断' },
        { page: 'settings', label: '设置' },
      ],
    },
  ], []);

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
          if (active) setThemeMode(normalizeThemeMode((result as { source?: unknown }).source));
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

  // 根据当前 page 自动展开所在分组
  const currentGroup = navGroups.find(g => g.items.some(i => i.page === page));
  useEffect(() => {
    if (currentGroup) {
      setExpandedGroups(prev => new Set(prev).add(currentGroup.title));
    }
  }, [page]);

  const toggleGroup = (title: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(title)) {
        next.delete(title);
      } else {
        next.add(title);
      }
      return next;
    });
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
          <span className="brand-mark">P</span>
          <div>
            <b>PMBrain</b>
            <small>知识控制台</small>
          </div>
        </div>
        <div className="sidebar-nav">
          {navGroups.map(group => {
            if (group.items.length === 1) {
              const item = group.items[0];
              return (
                <button
                  type="button"
                  key={item.page}
                  className={`nav-item nav-item-top ${page === item.page ? 'active' : ''}`}
                  onClick={() => navigate(item.page)}
                >
                  {item.label}
                </button>
              );
            }
            return (
              <div className={`nav-group ${expandedGroups.has(group.title) ? 'expanded' : ''}`} key={group.title}>
                <button type="button" className="nav-group-title" onClick={() => toggleGroup(group.title)} aria-expanded={expandedGroups.has(group.title)}>
                  {group.title}
                </button>
                {group.items.map(item => (
                  <button
                    type="button"
                    key={item.page}
                    className={`nav-item ${page === item.page ? 'active' : ''}`}
                    onClick={() => navigate(item.page)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
        <div className="sidebar-support">
          <button className="support-link" onClick={() => setHelpOpen(open => !open)}>
            <span className="support-icon">?</span>
            <span>帮助中心</span>
          </button>
          {helpOpen && (
            <div className="support-submenu">
              <button onClick={() => { sessionStorage.setItem('pmbrain.docs.article', 'readme'); navigate('docs'); }}>使用文档</button>
              <button onClick={() => { sessionStorage.setItem('pmbrain.docs.article', 'faq'); navigate('docs'); }}>常见问题</button>
            </div>
          )}
          <button className="support-link" onClick={() => setSupportPanel('wecom')}>
            <span className="support-icon">◎</span>
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
        <div className="mobile-brand"><span className="brand-mark">P</span><b>PMBrain</b></div>
        <select
          aria-label="选择管理台页面"
          value={navGroups.some(group => group.items.some(item => item.page === page)) ? page : 'dashboard'}
          onChange={event => navigate(event.target.value as Page)}
        >
          {navGroups.map(group => group.items.length === 1 ? (
            <option key={group.items[0].page} value={group.items[0].page}>{group.items[0].label}</option>
          ) : (
            <optgroup key={group.title} label={group.title}>
              {group.items.map(item => <option key={item.page} value={item.page}>{item.label}</option>)}
            </optgroup>
          ))}
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
        {page === 'jobs' && <JobsWatchPage />}
        {page === 'diagnostics' && <SystemDiagnosticPage />}
        {page === 'settings' && (
          <SettingsPage
            themeMode={themeMode}
            onNavigate={(target) => navigate(target as Page)}
          />
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
                  <div>
                    <h3>扫码添加 PMBrain 企微助手</h3>
                    <p>用于获取管理员登录链接、MCP 接入帮助和常见运维问题支持。</p>
                    <span>打开企业微信或微信扫码添加。</span>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
