import React, { useRef, useState } from 'react';

import { MessageCircle, Database, FileText, Network, CalendarCheck, Settings, Info, Search, Plus, ChevronDown, ChevronRight, SlidersHorizontal, Box, Link, Globe, Monitor, List, Image, Paperclip, Folder, FolderPlus, Send, Pencil, Layers, Minus, Copy, X, CircleSlash, PanelLeftClose, PanelLeftOpen, Check, type LucideIcon } from 'lucide-react';


type Conversation = { id: number; title: string; preview: string; time: string; group: string; messages: string[] };
const initialConversations: Conversation[] = [
  ['PMBrain 最新内容分析', '请帮我分析一下最近的更新…', '12:24', '今天'],
  ['会议纪要总结', '根据今天的会议记录，总结…', '10:18', '今天'],
  ['产品规划讨论', '基于我提供的需求，帮我分析…', '09:36', '今天'],
  ['技术方案对比', '对比一下这几个方案的优缺点…', '昨天', '昨天'],
  ['知识库建设思路', '我想建立一个个人知识库…', '昨天', '昨天'],
  ['Grok 使用方法', '总结一下 Grok 的使用技巧', '昨天', '昨天'],
  ['项目复盘', '帮我分析这个项目的经验教训', '9/20', '更早'],
  ['模型选择建议', '本地模型选型的建议', '9/18', '更早'],
].map(([title, preview, time, group], id) => ({ id, title, preview, time, group, messages: [] }));

const categories: { group: string; items: [string, LucideIcon][] }[] = [
  { group: '基础', items: [['通用设置', Settings]] },
  { group: 'AI 与模型', items: [['模型服务', Box], ['模型用途', SlidersHorizontal]] },
  { group: '知识库', items: [['知识库设置', Database], ['检索与向量', Search]] },
  { group: '知识整理', items: [['整理设置', FileText]] },
  { group: '连接与服务', items: [['MCP', Link], ['网络与访问', Globe]] },
  { group: '系统', items: [['桌面与启动', Monitor], ['数据与备份', Database], ['高级设置', Settings]] },
];
const providers = [
  { name: 'Ollama', logo: 'ollama', mark: '♧', url: 'http://localhost:11434', count: '3 个模型', connected: true },
  { name: 'SiliconFlow', logo: 'silicon', mark: 'ʄ', url: 'https://api.siliconflow.cn', count: '6 个模型', connected: true },
  { name: 'OpenAI', logo: 'openai', mark: '◎', url: '未填写 API Key', count: '', connected: false },
  { name: '自定义 OpenAI', logo: 'custom', mark: '', url: 'http://192.168.1.100:8000/v1', count: '2 个模型', connected: true },
];
const initialRoles = [
  { label: 'AI 对话', icon: MessageCircle, model: 'Qwen3 4B', detail: 'Ollama' },
  { label: '知识整理 / Dream', icon: FileText, model: 'MiMo V2.6', detail: 'SiliconFlow' },
  { label: 'Embedding', icon: Database, model: 'Qwen3-Embedding 8B', detail: '4096 维' },
  { label: '视觉 / OCR', icon: Image, model: 'Qwen VL', detail: '' },
  { label: 'Rerank', icon: List, model: '未配置', detail: '' },
];

function IconButton({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick?: () => void }) {
  return <button className="icon-button" aria-label={label} title={label} onClick={onClick}><Icon size={22} /></button>;
}

export function Preview() {
  const [page, setPage] = useState<'workspace' | 'settings'>('workspace');
  const [category, setCategory] = useState('模型服务');
  const [search, setSearch] = useState('');
  const [settingsSearch, setSettingsSearch] = useState('');
  const [conversations, setConversations] = useState(initialConversations);
  const [selected, setSelected] = useState(0);
  const [draft, setDraft] = useState('');
  const [model, setModel] = useState('Qwen3 4B');
  const [scope, setScope] = useState('全部知识');
  const [collapsed, setCollapsed] = useState(false);
  const [notice, setNotice] = useState('');
  const [provider, setProvider] = useState<string | null>(null);
  const [role, setRole] = useState<number | null>(null);
  const [roles, setRoles] = useState(initialRoles);
  const [roleModel, setRoleModel] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const conversation = conversations.find(item => item.id === selected)!;
  const filtered = conversations.filter(item => `${item.title}${item.preview}`.toLowerCase().includes(search.toLowerCase()));
  const previewNotice = () => setNotice('当前为版式预览，尚未连接后台服务。');
  const newConversation = () => {
    const next = Math.max(...conversations.map(item => item.id)) + 1;
    setConversations(items => [{ id: next, title: '新对话', preview: '开始一次新的知识探索', time: '刚刚', group: '今天', messages: [] }, ...items]);
    setSelected(next);
    setDraft('');
    setSearch('');
    input.current?.focus();
  };
  const send = () => {
    if (!draft.trim()) return;
    setConversations(items => items.map(item => item.id === selected ? { ...item, title: item.messages.length ? item.title : draft.trim().slice(0, 18), preview: draft.trim(), messages: [...item.messages, draft.trim()] } : item));
    setDraft('');
  };
  const showRole = (index: number) => { setRole(index); setRoleModel(roles[index].model); };
  const roleTable = <section className="role-panel">
    <div className="role-heading"><h2>模型用途</h2><p>为不同的功能场景选择合适的模型，PMBrain 将按此配置进行调用。</p></div>
    <div className="role-rows">{roles.map((item, index) => <button className="role-row" key={item.label} onClick={() => showRole(index)} aria-label={`更换${item.label}模型`}>
      <item.icon size={23} /><span>{item.label}</span><span className={item.model === '未配置' ? 'unconfigured' : ''}>{item.model}</span><small>{item.detail}</small><span className="text-action">{item.model === '未配置' ? '设置' : '更换'}</span><ChevronRight size={18} />
    </button>)}</div>
  </section>;

  return <div className="preview-app">
    <header className="titlebar"><span className="brand"><span className="brand-symbol">P</span>PMBrain</span><span className="preview-label">设计预览 · 演示数据</span><div className="window-actions" aria-hidden="true"><Search /><Minus /><Copy /><X /></div></header>
    <div className="app-body">
      <aside className="main-sidebar" aria-label="主导航">
        <nav>{[[MessageCircle, 'AI 工作台'], [Database, '知识库'], [FileText, '知识整理'], [Network, '知识图谱'], [CalendarCheck, '任务中心']].map(([Icon, label], index) => {
          const NavIcon = Icon as LucideIcon;
          return <button key={String(label)} className={`nav-item ${page === 'workspace' && index === 0 ? 'active' : ''}`} onClick={() => index === 0 ? setPage('workspace') : setNotice(`${label}将在后续阶段改版。`)}><NavIcon /><span>{String(label)}</span></button>;
        })}<div className="nav-divider" /><button className={`nav-item ${page === 'settings' ? 'active' : ''}`} onClick={() => setPage('settings')}><Settings /><span>设置</span></button><button className="nav-item" onClick={() => setNotice('PMBrain 页面改版预览 · 当前仅设计 AI 工作台与设置。')}><Info /><span>关于</span></button></nav>
        <button className="service-card" onClick={previewNotice}><i /><span>服务运行中<small>localhost:3131</small></span><ChevronRight size={19} /></button>
      </aside>
      {page === 'workspace' ? <main className={`workspace ${collapsed ? 'history-collapsed' : ''}`}>
        {!collapsed && <aside className="history-sidebar" aria-label="会话列表">
          <label className="search-field"><Search size={20} /><input placeholder="搜索对话…" value={search} onChange={event => setSearch(event.target.value)} /><SlidersHorizontal size={18} /></label>
          <button className="primary new-chat" onClick={newConversation}><Plus size={25} />新建对话</button>
          <div className="history-list">{['今天', '昨天', '更早'].map(group => {
            const items = filtered.filter(item => item.group === group);
            return items.length > 0 && <section key={group}><h3>{group}</h3>{items.map(item => <button className={`conversation ${selected === item.id ? 'selected' : ''}`} key={item.id} onClick={() => { setSelected(item.id); setDraft(''); }}><MessageCircle size={22} /><span><span className="conversation-title">{item.title}</span><small>{item.preview}</small></span><time>{item.time}</time></button>)}</section>;
          })}{filtered.length === 0 && <p className="empty-search">没有匹配的对话</p>}</div>
        </aside>}
        <section className="chat-panel" aria-label="知识工作台">
          <div className="chat-toolbar"><IconButton icon={collapsed ? PanelLeftOpen : PanelLeftClose} label={collapsed ? '展开会话列表' : '收起会话列表'} onClick={() => setCollapsed(!collapsed)} /><button className="toolbar-pill" onClick={() => setNotice('当前预览知识库：PMBrain 知识库。')}><span className="mini-book"><FileText size={17} /></span>PMBrain知识库<ChevronDown size={17} /></button><label className="toolbar-pill model-select"><span className="model-symbol">✦</span><select aria-label="当前对话模型" value={model} onChange={event => setModel(event.target.value)}><option>Qwen3 4B</option><option>MiMo V2.6</option><option>Qwen VL</option></select><ChevronDown size={17} /></label><button className="directory-choice" onClick={() => setNotice('工作目录入口已预留，本轮只还原版式。')}><CircleSlash size={21} /><span>不使用工作目录</span><ChevronDown size={17} /></button><div className="toolbar-spacer" /><IconButton icon={Settings} label="打开设置" onClick={() => setPage('settings')} /></div>
          {conversation.messages.length === 0 ? <div className="welcome">
            <div className="welcome-intro"><div className="knowledge-mark"><span /><span /><span /></div><h1>有什么可以帮你的吗？</h1><p>基于你的知识库，进行搜索、分析、总结和创作</p></div>
            <div className="quick-actions">{[[Search, '搜索我的知识库', '查找相关资料', '帮我搜索知识库中关于'], [FileText, '总结文档内容', '提炼核心要点', '请帮我总结这份文档的核心要点：'], [Pencil, '帮我写点内容', '基于我的资料创作', '请基于我的资料，帮我撰写']].map(([Icon, title, detail, prompt]) => { const QuickIcon = Icon as LucideIcon; return <button key={String(title)} onClick={() => { setDraft(String(prompt)); input.current?.focus(); }}><QuickIcon /><span><strong>{String(title)}</strong><small>{String(detail)}</small></span></button>; })}</div>
          </div> : <div className="messages" aria-live="polite">{conversation.messages.map((message, index) => <div className="message-pair" key={index}><div className="user-message">{message}</div><div className="preview-reply"><Layers size={20} />消息已展示。当前为交互预览，尚未接入 AI 回复。</div></div>)}</div>}
          <div className="composer"><textarea ref={input} aria-label="输入消息" placeholder="输入消息，按 Enter 发送，输入 / 搜索路径或命令，输入 @ 引用文件或会话" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); send(); } }} /><div className="composer-tools"><IconButton icon={Paperclip} label="添加附件" onClick={previewNotice} /><IconButton icon={Folder} label="选择文件夹" onClick={previewNotice} /><IconButton icon={FolderPlus} label="添加知识资料" onClick={previewNotice} /><label className="scope-select"><Database size={21} /><select aria-label="知识范围" value={scope} onChange={event => setScope(event.target.value)}><option value="全部知识">知识范围</option><option>当前知识库</option><option>仅本次附件</option></select><ChevronDown size={17} /></label><div className="toolbar-spacer" /><label className="composer-model"><span className="model-symbol">✦</span><select aria-label="发送使用的模型" value={model} onChange={event => setModel(event.target.value)}><option>Qwen3 4B</option><option>MiMo V2.6</option><option>Qwen VL</option></select><ChevronDown size={17} /></label><span className="tool-divider" /><IconButton icon={Globe} label="联网搜索" onClick={previewNotice} /><button className="primary send-button" aria-label="发送消息" onClick={send}><Send size={27} /></button></div></div>
        </section>
      </main> : <main className="settings-page">
        <header className="settings-heading"><div><h1>设置</h1><p>统一管理 PMBrain 的基础配置、模型服务、知识库、整理流程和系统能力。</p></div><Settings size={25} /></header>
        <div className="settings-layout"><aside className="settings-sidebar" aria-label="设置分类"><label className="search-field"><Search size={20} /><input placeholder="搜索设置…" value={settingsSearch} onChange={event => setSettingsSearch(event.target.value)} /></label><div className="category-list">{categories.map(group => { const items = group.items.filter(([label]) => label.toLowerCase().includes(settingsSearch.toLowerCase())); return items.length > 0 && <section key={group.group}><h3>{group.group}</h3>{items.map(([label, Icon]) => <button key={label} className={`category ${category === label ? 'active' : ''}`} onClick={() => setCategory(label)}><Icon size={23} /><span>{label}</span></button>)}</section>; })}{!categories.some(group => group.items.some(([label]) => label.toLowerCase().includes(settingsSearch.toLowerCase()))) && <p className="empty-search">没有匹配的设置</p>}</div></aside>
          <section className="settings-content" aria-label={category}>
            {category === '模型服务' ? <><div className="section-heading"><h2>模型服务</h2><p>管理 PMBrain 使用的 AI 服务和模型，统一给对话、知识整理、Embedding、OCR 与检索调用。</p></div><div className="provider-grid">{providers.map(item => <article className="provider-card" key={item.name}><div className={`provider-logo ${item.logo}`}>{item.logo === 'custom' ? <Link size={37} /> : item.logo === 'ollama' ? <svg viewBox='0 0 48 56' width='40' height='47' fill='none' stroke='currentColor' strokeWidth='2.2' aria-hidden='true'><path d='M13 49V35C6 29 9 19 15 16L13 5Q15 0 18 5L21 14H28L31 4Q34 0 35 6L34 19Q42 25 35 35V49' /><path d='M16 28Q24 23 32 28M20 34Q24 38 28 34' /><circle cx='18' cy='23' r='1' /><circle cx='30' cy='23' r='1' /></svg> : item.logo === 'openai' ? <svg viewBox='0 0 48 48' width='43' height='43' fill='none' stroke='currentColor' strokeWidth='2' aria-hidden='true'>{[0,60,120,180,240,300].map(angle => <path key={angle} transform={'rotate(' + angle + ' 24 24)'} d='M24 8C36 2 44 13 39 22L26 30L18 25V15Z' />)}</svg> : item.mark}</div><div className="provider-info"><button className="provider-title" onClick={() => setProvider(item.name)}>{item.name}<ChevronRight size={19} /></button><div className={`provider-status ${item.connected ? 'connected' : ''}`}><i />{item.connected ? '已连接' : '未配置'}</div><p>{item.url}</p><small>{item.count || '\u00a0'}</small></div><div className="provider-actions"><button className="secondary" onClick={() => item.connected ? previewNotice() : setProvider(item.name)}>{item.connected ? '刷新模型' : '设置'}</button><button className="primary" onClick={previewNotice}>测试连接</button></div></article>)}</div>{roleTable}</> : category === '模型用途' ? <><div className="section-heading"><h2>模型用途</h2><p>分别为对话、知识整理、向量与图片识别选择模型。</p></div>{roleTable}</> : <div className="pending-section"><Settings size={38} /><h2>{category}</h2><p>分类入口已就位，具体内容将在后续改版中设计。</p><button className="secondary" onClick={() => setCategory('模型服务')}>返回模型服务</button></div>}
            <div className="desktop-note"><span><Info size={22} /></span><p><b>桌面专属能力：</b>开机启动、系统托盘、自动更新等设置在系统分类中可管理。<br />部分设置（如模型服务、知识库等）保存在 PMBrain 后端，因此在桌面端和浏览器端是共享的。</p></div>
          </section>
        </div>
      </main>}
    </div>
    {notice && <div className="notice" role="status"><Info size={20} /><span>{notice}</span><IconButton icon={X} label="关闭提示" onClick={() => setNotice('')} /></div>}
    {(provider !== null || role !== null) && <div className="modal-backdrop" onClick={() => { setProvider(null); setRole(null); }}><section className="modal" role="dialog" aria-modal="true" aria-label={provider || '更换模型'} onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape') { setProvider(null); setRole(null); } }}><header><h2>{provider || `${roles[role!].label} · 更换模型`}</h2><IconButton icon={X} label="关闭弹窗" onClick={() => { setProvider(null); setRole(null); }} /></header>{provider ? <><p>模型服务配置面板将在后续接入现有配置能力。</p><div className="modal-detail">{providers.find(item => item.name === provider)?.url}</div><p className="muted">当前连接状态为设计演示数据。</p><button autoFocus className="primary" onClick={() => setProvider(null)}>知道了</button></> : <><p>选择模型以预览配置后的页面效果。</p><input autoFocus aria-label="用途模型名称" value={roleModel} onChange={event => setRoleModel(event.target.value)} /><p className="muted">仅修改本页演示数据，刷新后恢复。</p><button className="primary" disabled={!roleModel.trim()} onClick={() => { setRoles(items => items.map((item, index) => index === role ? { ...item, model: roleModel.trim(), detail: '预览选择' } : item)); setRole(null); }}><Check size={18} />应用到预览</button></>}</section></div>}
  </div>;
}
