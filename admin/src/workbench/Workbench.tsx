import React, { Fragment, useEffect, useRef, useState } from 'react';
import { Plus, ArrowUp, Square, BookOpen, FileUp, Settings, X, Bot, FolderOpen, ListTodo } from 'lucide-react';
import { OPEN_CONVERSATION_KEY } from '../product/home-model';
import { acceptComposerFiles, assignSessionAttachments, composerFromSaved, createAttachment, filesFromClipboard, revokeAttachment, sessionAttachments, type ComposerAttachment } from './composer-attachments';
import { useWorkbench } from './useWorkbench';
import { Message } from './Message';
import { AssistantSettings } from './AssistantSettings';
import { AgentSettings } from './AgentSettings';
import { Artifacts } from './Artifacts';
import { scheduleLabel } from './AgentCards';
import { agentAvatar, agentRoleLabel } from '../../../shared/workbench-agents';
import './workbench.css';

export function Workbench({ serviceReady = true, databaseReady = true }: { serviceReady?: boolean; databaseReady?: boolean }) {
  const wb = useWorkbench({ serviceReady, databaseReady });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [legacySettings, setLegacySettings] = useState(false);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Record<string, string | undefined>>({});
  const previousDraft = useRef<Record<string, string>>({});
  const previousAttachments = useRef<Record<string, ComposerAttachment[]>>({});
  const bottom = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [attachmentMap, setAttachmentMap] = useState<Record<string, ComposerAttachment[]>>({});
  const [dropping, setDropping] = useState(false);
  const attachmentMapRef = useRef(attachmentMap);
  attachmentMapRef.current = attachmentMap;
  useEffect(() => () => {
    for (const list of Object.values(attachmentMapRef.current)) for (const item of list) revokeAttachment(item);
  }, []);
  const addFiles = (files: File[]) => {
    if (!files.length || wb.pending || wb.running) return;
    const { accepted, error } = acceptComposerFiles(sessionAttachments(attachmentMapRef.current, wb.conversation?.id ?? `new:${wb.assistantId}`).length, files);
    if (error) wb.setError(error);
    if (!accepted.length) return;
    setAttachments(current => [...current, ...accepted.map(file => createAttachment(file, crypto.randomUUID()))]);
  };
  const removeAttachment = (id: string) => {
    setAttachments(current => {
      for (const item of current) if (item.id === id) revokeAttachment(item);
      return current.filter(item => item.id !== id);
    });
  };
  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = filesFromClipboard(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    addFiles(files);
  };
  const key = wb.conversation?.id ?? `new:${wb.assistantId}`;
  const draft = drafts[key] ?? '';
  const editingId = editing[key];
  const attachments = [...sessionAttachments(attachmentMap, key)];
  const setAttachments = (value: ComposerAttachment[] | ((current: ComposerAttachment[]) => ComposerAttachment[])) => {
    setAttachmentMap(old => {
      const current = [...sessionAttachments(old, key)];
      const next = typeof value === 'function' ? value(current) : value;
      return assignSessionAttachments(old, key, next);
    });
  };
  const setDraft = (value: string) => setDrafts(old => ({ ...old, [key]: value }));
  const messages = wb.conversation?.messages ?? [];
  const tailLength = messages.at(-1)?.text.length ?? 0;
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [wb.conversation?.id, messages.length, wb.running, tailLength]);
  const startEdit = (messageId: string, text: string) => {
    const message = messages.find(item => item.id === messageId);
    if (!editingId) {
      previousDraft.current[key] = draft;
      previousAttachments.current[key] = attachments;
    }
    setEditing(old => ({ ...old, [key]: messageId }));
    setDraft(text);
    setAttachments(composerFromSaved(message?.attachments));
    composer.current?.focus();
  };
  const cancelEdit = () => {
    const restored = previousDraft.current[key] ?? '';
    const restoredFiles = previousAttachments.current[key] ?? [];
    delete previousDraft.current[key];
    delete previousAttachments.current[key];
    setEditing(old => ({ ...old, [key]: undefined }));
    setDraft(restored);
    setAttachments(restoredFiles);
  };
  const canSend = Boolean(serviceReady && (draft.trim() || attachments.length) && wb.model && !wb.pending && !wb.running);
  const send = async () => {
    const originalKey = key;
    const editMessageId = editingId;
    const queued = attachments;
    if (await wb.send(draft, false, editMessageId, queued, Boolean(editMessageId))) {
      const sentIds = new Set(queued.map(item => item.id));
      setAttachmentMap(old => {
        const current = [...sessionAttachments(old, originalKey)];
        for (const item of current) if (sentIds.has(item.id)) revokeAttachment(item);
        return assignSessionAttachments(old, originalKey, current.filter(item => !sentIds.has(item.id)));
      });
      delete previousDraft.current[originalKey];
      setEditing(old => ({ ...old, [originalKey]: undefined }));
      setDrafts(old => ({ ...old, [originalKey]: '' }));
      composer.current?.focus();
    }
  };
  useEffect(() => {
    if (!wb.loaded) return;
    const openSaved = () => {
      const id = sessionStorage.getItem(OPEN_CONVERSATION_KEY);
      if (!id) return;
      sessionStorage.removeItem(OPEN_CONVERSATION_KEY);
      void wb.select(id);
    };
    openSaved();
    window.addEventListener('pmbrain:open-conversation', openSaved);
    return () => window.removeEventListener('pmbrain:open-conversation', openSaved);
  }, [wb.loaded]);
  useEffect(() => {
    if (!wb.loaded || wb.conversation) return;
    if (sessionStorage.getItem(OPEN_CONVERSATION_KEY)) return;
    void wb.selectAgent(wb.assistantId);
  }, [wb.loaded]);
  const assistant = wb.assistant;
  const agentProfile = wb.agents.find(agent => agent.id === wb.assistantId);
  const askMain = (text: string) => { void wb.selectAgent('main').then(id => { setDrafts(old => ({ ...old, [id ?? 'new:main']: text })); composer.current?.focus(); }); };
  const adjustAgent = () => { setSettingsOpen(false); askMain(`请调整助手「${assistant.name}」的配置。我的新要求是：`); };
  const suggestions = wb.assistantId === 'main' ? ['创建一个周报助手，按知识库里的实际进展写 Word 周报', '创建一个方案助手，先找项目资料再写方案', '帮我梳理最近关注的项目'] : [agentProfile?.schedule?.prompt || '按你的职责和规则，帮我完成这次工作', '先看看现有资料，告诉我还缺什么'];
  const contextNote = '更早的对话会按模型容量自动压缩。完整记录仍留在这里，不会把全部历史发给模型。';
  return <div className="knowledge-workbench">
    <aside className="wb-history" aria-label="我的助手"><div className="wb-sidebar-heading"><b>我的助手</b><button aria-label="创建助手" title="告诉主助手你想创建什么助手" disabled={wb.pending} onClick={() => askMain('创建一个助手。它要负责：')}><Plus size={16} /></button></div><div className="wb-agent-list" aria-label="我的助手">{wb.agents.map(agent => <button key={agent.id} className={wb.assistantId === agent.id ? 'selected' : ''} data-kind={agent.id === 'main' ? 'main' : 'specialist'} aria-current={wb.assistantId === agent.id ? 'true' : undefined} disabled={wb.pending} onClick={() => void wb.selectAgent(agent.id)}><span className="wb-agent-avatar">{agentAvatar(agent)}</span><span className="wb-agent-meta"><b>{agent.name}</b><small>{wb.assistantId === agent.id ? '正在使用' : agent.id === 'main' ? '主助手' : agent.schedule?.enabled ? '定时 · 专用助手' : '专用助手'}</small></span></button>)}</div><div className="wb-sidebar-links"><button onClick={() => setArtifactsOpen(true)}><FolderOpen size={16} />工作成果</button><button onClick={() => { window.location.hash = 'tasks'; }}><ListTodo size={16} />任务中心</button><button onClick={() => { window.location.hash = 'knowledge-import'; }}><FileUp size={16} />导入知识资料</button></div></aside>
    <section className="wb-chat"><header className="wb-toolbar"><div className="wb-assistant-chip" data-kind={wb.assistantId === 'main' ? 'main' : 'specialist'} aria-label={`当前正在使用${agentRoleLabel(wb.assistantId)} ${assistant.name}`}><span>{agentAvatar({ id: wb.assistantId, name: assistant.name, emoji: assistant.emoji })}</span><span className="wb-assistant-identity"><span className="wb-assistant-name" title={assistant.name}>{assistant.name}</span><small>{agentRoleLabel(wb.assistantId)}</small></span></div><select aria-label="对话模型" value={wb.model} disabled={wb.running || wb.pending} onChange={e => wb.setModel(e.target.value)}><option value="" disabled>选择对话模型</option>{wb.model && !wb.models.some(m => m.id === wb.model) && <option value={wb.model}>{wb.model}（未启用）</option>}{wb.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select><label className="wb-knowledge"><input type="checkbox" checked={wb.knowledge} disabled={!databaseReady || wb.running || wb.pending} onChange={e => wb.setKnowledge(e.target.checked)} /><BookOpen size={15} />知识库</label><div className="wb-conversation-actions"><button aria-label="助手配置" title="查看助手的职责、资料与定时任务" onClick={() => setSettingsOpen(true)}><Settings size={15} /></button><details className="wb-more"><summary aria-label="更多操作">···</summary><div><button type="button" disabled={!wb.conversation || wb.running || wb.pending} onClick={() => void wb.clearContext()}>清理当前任务上下文</button></div></details></div></header>
      <div className="wb-messages" role="log" aria-label="当前对话"><div className="wb-message-column">{!messages.length && <div className="wb-welcome"><div><Bot size={29} /></div><h1>{wb.assistantId === 'main' ? '把工作交给你的助手' : assistant.name}</h1><p>{wb.assistantId === 'main' ? '说说你想做什么。主助手可以创建专用助手，配置规则、资料和工作步骤。' : assistant.description || '直接告诉我这次要完成什么，成果会留在对话里。'}</p>{wb.assistantId !== 'main' && agentProfile && <p className="wb-agent-summary">{agentProfile.deliveryFormat === 'docx' ? 'Word 交付' : 'Markdown 交付'} · {scheduleLabel(agentProfile.schedule)}</p>}<div className="wb-suggestions">{suggestions.map(text => <button key={text} onClick={() => { setDraft(text); composer.current?.focus(); }}>{text}</button>)}</div>{wb.assistantId !== 'main' && <button className="wb-adjust-link" onClick={adjustAgent}>让主助手调整</button>}</div>}{messages.map((message, index) => <Fragment key={message.id}><Message key={message.id} message={message} assistantName={assistant.name} assistantEmoji={agentAvatar({ id: wb.assistantId, name: assistant.name, emoji: assistant.emoji })} assistantRole={agentRoleLabel(wb.assistantId)} canRetry={message.role === 'assistant' && index === messages.length - 1 && !wb.running && !wb.pending && !editingId} onRetry={() => void wb.send('', true)} canEdit={message.role === 'user' && !wb.running && !wb.pending} onEdit={() => startEdit(message.id, message.text)} agents={wb.agents} onAgent={id => void wb.selectAgent(id)} onConversation={id => void wb.select(id)} />{message.id === wb.conversation?.contextFloor ? <p className="wb-context-floor" role="status">已清理当前任务上下文。上面的记录还在，长期规则也还在。</p> : null}</Fragment>)}<div ref={bottom} /></div></div>
      <div className="wb-compose-area">{!serviceReady ? <p className="wb-muted" role="status">本地对话服务暂不可用</p> : !databaseReady && <p className="wb-muted" role="status">知识库正在准备，当前可进行普通对话。</p>}{editingId && <div className="wb-notice" role="status">正在修改这条问题。发送后，从这里重新回答，后面的内容会被替换。<button onClick={cancelEdit}>取消修改</button></div>}{wb.error && <p className="wb-error" role="alert">{wb.error}</p>}{wb.modelsLoaded && !wb.models.length && <p className="wb-muted">请先在<button onClick={() => { window.location.hash = 'settings-models'; }}>模型服务</button>中配置并启用普通模型。</p>}<div className={dropping ? 'wb-composer dropping' : 'wb-composer'} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDropping(true); } }} onDragLeave={() => setDropping(false)} onDrop={event => { event.preventDefault(); setDropping(false); addFiles(Array.from(event.dataTransfer.files ?? [])); }}>{attachments.length > 0 && <ul className="wb-attachments">{attachments.map(item => <li key={item.id}>{item.previewUrl ? <img src={item.previewUrl} alt={item.name} /> : <span className="wb-file-card">{item.name}</span>}<button type="button" aria-label={`移除 ${item.name}`} onClick={() => removeAttachment(item.id)}><X size={12} /></button></li>)}</ul>}<textarea ref={composer} aria-label="消息" placeholder={`向${assistant.name}发送，Enter 发送，Shift + Enter 换行`} value={draft} maxLength={32000} onPaste={onPaste} onChange={e => { setDraft(e.target.value); if (wb.error) wb.setError(''); }} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (canSend) void send(); } }} /><footer><span className="wb-compose-leading"><button type="button" className="wb-attach" aria-label="添加附件" disabled={wb.pending || wb.running} onClick={() => fileInput.current?.click()}><Plus size={16} /></button><span title={contextNote}>{assistant.name} · {wb.knowledge ? '结合知识库回答' : '普通对话'}</span></span>{wb.running ? <button className="wb-send wb-stop" aria-label="停止生成" onClick={() => void wb.action('cancel')}><Square size={17} /></button> : <button className="wb-send" aria-label="发送消息" disabled={!canSend} onClick={() => void send()}><ArrowUp size={16} /></button>}</footer><input ref={fileInput} className="wb-file-input" type="file" multiple hidden onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} /></div><small className="wb-compose-note">回答可能有误，请结合引用资料核对。</small></div>
    </section>
    {settingsOpen && agentProfile && <AgentSettings key={agentProfile.id} value={agentProfile} models={wb.models} onClose={() => setSettingsOpen(false)} onAdjust={adjustAgent} onSave={async value => { await wb.saveAgent(value); }} onMemory={wb.assistantId === 'main' ? () => { setSettingsOpen(false); setLegacySettings(true); } : undefined} />}
    {legacySettings && <AssistantSettings value={assistant} models={wb.models} onClose={() => setLegacySettings(false)} onSave={async value => { await wb.saveAssistant(value); await wb.refresh(); setLegacySettings(false); }} />}
    {artifactsOpen && <Artifacts onClose={() => setArtifactsOpen(false)} onConversation={id => void wb.select(id)} />}
  </div>;
}
