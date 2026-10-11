import React, { useEffect, useRef, useState } from 'react';
import { Plus, MessageCircle, ArrowUp, Square, BookOpen, FileUp, Pencil, Trash2, Settings, X } from 'lucide-react';
import { OPEN_CONVERSATION_KEY } from '../product/home-model';
import { acceptComposerFiles, assignSessionAttachments, composerFromSaved, createAttachment, filesFromClipboard, revokeAttachment, sessionAttachments, type ComposerAttachment } from './composer-attachments';
import { useWorkbench } from './useWorkbench';
import { Message } from './Message';
import { AssistantSettings } from './AssistantSettings';
import './workbench.css';

export function Workbench({ serviceReady = true, databaseReady = true }: { serviceReady?: boolean; databaseReady?: boolean }) {
  const wb = useWorkbench({ serviceReady, databaseReady });
  const [settingsOpen, setSettingsOpen] = useState(false);
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
    const { accepted, error } = acceptComposerFiles(sessionAttachments(attachmentMapRef.current, wb.conversation?.id ?? 'new').length, files);
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
  const key = wb.conversation?.id ?? 'new';
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
  const rename = () => { const title = window.prompt('会话名称', wb.conversation?.title); if (title) void wb.action('rename', title); };
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
  const assistant = wb.assistant;
  const contextNote = `超过 ${assistant.context.maxMessages} 条，或达到模型上下文约 ${Math.round(assistant.context.threshold * 100)}% 时，更早的对话会压缩成摘要`;
  return <div className="knowledge-workbench">
    <aside className="wb-history" aria-label="对话记录"><button type="button" className="wb-assistant" onClick={() => setSettingsOpen(true)}><span>{assistant.emoji}</span><span><b>{assistant.name}</b><small>助手设置</small></span><Settings size={15} /></button><button className="wb-new" disabled={wb.pending} onClick={() => void wb.select()}><Plus size={17} />新建对话</button><div className="wb-history-list">{wb.rows.map(row => <button key={row.id} disabled={wb.pending} className={wb.conversation?.id === row.id ? 'selected' : ''} onClick={() => void wb.select(row.id)}><MessageCircle size={16} /><span><b>{row.title}</b><small>{row.running ? '正在生成…' : `${row.messageCount} 条消息`} · {new Date(row.updatedAt).toLocaleDateString()}</small></span></button>)}{wb.loaded && !wb.rows.length && <p className="wb-muted">对话会自动保存在当前知识库的工作台中。</p>}</div><button onClick={() => { window.location.hash = 'knowledge-import'; }}><FileUp size={16} />导入知识资料</button></aside>
    <section className="wb-chat"><header className="wb-toolbar"><button type="button" className="wb-assistant-chip" onClick={() => setSettingsOpen(true)}><span>{assistant.emoji}</span>{assistant.name}</button><select aria-label="对话模型" value={wb.model} disabled={wb.running || wb.pending} onChange={e => wb.setModel(e.target.value)}><option value="" disabled>选择对话模型</option>{wb.model && !wb.models.some(m => m.id === wb.model) && <option value={wb.model}>{wb.model}（未启用）</option>}{wb.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select><label className="wb-knowledge"><input type="checkbox" checked={wb.knowledge} disabled={!databaseReady || wb.running || wb.pending} onChange={e => wb.setKnowledge(e.target.checked)} /><BookOpen size={15} />知识库</label><div className="wb-conversation-actions">{wb.conversation && <><button aria-label="重命名会话" disabled={wb.running || wb.pending} onClick={rename}><Pencil size={15} /></button><button aria-label="删除会话" disabled={wb.running || wb.pending} onClick={() => { if (window.confirm('删除这段对话记录？知识库资料不受影响。')) void wb.action('delete'); }}><Trash2 size={15} /></button></>}</div></header>
      <div className="wb-messages" role="log" aria-label="当前对话"><div className="wb-message-column">{!messages.length && <div className="wb-welcome"><div><BookOpen size={29} /></div><h1>从你的知识，开始对话</h1><p>查找资料、分析问题，或接着上一轮继续聊。</p><div className="wb-suggestions">{['帮我梳理最近关注的项目', '根据知识库整理一份行动清单', '帮我分析一个问题'].map(text => <button key={text} onClick={() => { setDraft(text); composer.current?.focus(); }}>{text}</button>)}</div></div>}{messages.map((message, index) => <Message key={message.id} message={message} assistantName={assistant.name} assistantEmoji={assistant.emoji} canRetry={message.role === 'assistant' && index === messages.length - 1 && !wb.running && !wb.pending && !editingId} onRetry={() => void wb.send('', true)} canEdit={message.role === 'user' && !wb.running && !wb.pending} onEdit={() => startEdit(message.id, message.text)} />)}<div ref={bottom} /></div></div>
      <div className="wb-compose-area">{!serviceReady ? <p className="wb-muted" role="status">本地对话服务暂不可用</p> : !databaseReady && <p className="wb-muted" role="status">知识库正在准备，当前可进行普通对话。</p>}{editingId && <div className="wb-notice" role="status">正在修改这条问题。发送后，从这里重新回答，后面的内容会被替换。<button onClick={cancelEdit}>取消修改</button></div>}{wb.error && <p className="wb-error" role="alert">{wb.error}</p>}{wb.modelsLoaded && !wb.models.length && <p className="wb-muted">请先在<button onClick={() => { window.location.hash = 'settings-models'; }}>模型服务</button>中配置并启用普通模型。</p>}<div className={dropping ? 'wb-composer dropping' : 'wb-composer'} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDropping(true); } }} onDragLeave={() => setDropping(false)} onDrop={event => { event.preventDefault(); setDropping(false); addFiles(Array.from(event.dataTransfer.files ?? [])); }}>{attachments.length > 0 && <ul className="wb-attachments">{attachments.map(item => <li key={item.id}>{item.previewUrl ? <img src={item.previewUrl} alt={item.name} /> : <span className="wb-file-card">{item.name}</span>}<button type="button" aria-label={`移除 ${item.name}`} onClick={() => removeAttachment(item.id)}><X size={12} /></button></li>)}</ul>}<textarea ref={composer} aria-label="消息" placeholder="输入消息，Enter 发送，Shift + Enter 换行" value={draft} maxLength={32000} onPaste={onPaste} onChange={e => { setDraft(e.target.value); if (wb.error) wb.setError(''); }} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (canSend) void send(); } }} /><footer><span className="wb-compose-leading"><button type="button" className="wb-attach" aria-label="添加附件" disabled={wb.pending || wb.running} onClick={() => fileInput.current?.click()}><Plus size={16} /></button><span title={contextNote}>{wb.knowledge ? "结合知识库回答" : "普通对话"}</span></span>{wb.running ? <button className="wb-send wb-stop" aria-label="停止生成" onClick={() => void wb.action('cancel')}><Square size={17} /></button> : <button className="wb-send" aria-label="发送消息" disabled={!canSend} onClick={() => void send()}><ArrowUp size={16} /></button>}</footer><input ref={fileInput} className="wb-file-input" type="file" multiple hidden onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} /></div><small className="wb-compose-note">回答可能有误，请结合引用资料核对。</small></div>
    </section>
    {settingsOpen && <AssistantSettings value={assistant} models={wb.models} onClose={() => setSettingsOpen(false)} onSave={async value => { await wb.saveAssistant(value); setSettingsOpen(false); }} />}
  </div>;
}
