import { useEffect, useRef, useState } from 'react';
import { defaultAssistant, type KnowledgeAssistantSettings, type WorkbenchConversation, type WorkbenchModel } from '../../../shared/workbench';
import { filePayload } from './composer-attachments';
import { CHAT_MODEL_DEFAULT_KEY, CHAT_MODEL_EVENT, CHAT_MODEL_KEY, rememberChatModel, rememberedChatModel } from './chat-model';
import { productFetch } from '../lib/product-fetch';

type ConversationRow = Omit<WorkbenchConversation, 'messages'> & { messageCount: number; running: boolean };
export async function workbenchRequest<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await productFetch(`/admin/api/workbench${path}`, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  let result: { error?: string };
  try { result = await response.json(); }
  catch { throw new Error(response.ok ? '服务返回的内容无法解析。' : `请求失败：${response.status}`); }
  if (!response.ok) throw new Error(result.error || `请求失败：${response.status}`);
  return result as T;
}
export function mergePolledConversation(current: WorkbenchConversation | undefined, next: WorkbenchConversation): WorkbenchConversation {
  if (!current || current.id !== next.id) return next;
  const previous = new Map(current.messages.map(message => [message.id, message]));
  return {
    ...next,
    messages: next.messages.map(message => {
      const older = previous.get(message.id);
      if (!older?.attachments?.length || !message.attachments?.length) return message;
      const saved = new Map(older.attachments.map(item => [item.id, item]));
      return {
        ...message,
        attachments: message.attachments.map(item => {
          const prior = saved.get(item.id);
          if (!prior) return item;
          const preview = item.preview || prior.preview;
          const text = item.text || prior.text;
          return { ...item, ...(preview ? { preview } : {}), ...(text ? { text } : {}) };
        }),
      };
    }),
  };
}
export function useWorkbench({ serviceReady = true, databaseReady = true }: { serviceReady?: boolean; databaseReady?: boolean } = {}) {
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [models, setModels] = useState<WorkbenchModel[]>([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [conversation, setConversation] = useState<WorkbenchConversation>();
  const [model, setModel] = useState('');
  const [knowledge, setKnowledge] = useState(true);
  const [assistant, setAssistant] = useState<KnowledgeAssistantSettings>(defaultAssistant);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const active = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const modelsRef = useRef(models);
  const selectionRevision = useRef(0);
  const defaultModel = useRef('');
  const settingsModel = useRef('');
  modelsRef.current = models;
  const refresh = async () => {
    const result = await workbenchRequest<{ conversations: ConversationRow[] }>('/conversations');
    if (mounted.current) setRows(result.conversations);
  };
  useEffect(() => {
    if (!serviceReady) return;
    mounted.current = true; let cancelled = false;
    let revision = 0;
    const initialSelection = selectionRevision.current;
    const remembered = () => { try { const savedDefault = localStorage.getItem(CHAT_MODEL_DEFAULT_KEY); return savedDefault === null || savedDefault === defaultModel.current ? localStorage.getItem(CHAT_MODEL_KEY) || '' : ''; } catch { return ''; } };
    const fail = (reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); };
    void Promise.allSettled([
      workbenchRequest<{ conversations: ConversationRow[] }>('/conversations').then(history => { if (!cancelled) setRows(history.conversations); }).catch(fail),
      workbenchRequest<{ models: WorkbenchModel[]; defaultModel?: string }>('/models').then(available => {
        if (cancelled || revision !== 0) return;
        modelsRef.current = available.models; setModels(available.models); setModelsLoaded(true);
        defaultModel.current = available.defaultModel || '';
        setModel(current => rememberedChatModel(selectionRevision.current !== initialSelection ? current : remembered(), settingsModel.current || defaultModel.current, available.models.map(item => item.id)));
      }).catch(fail),
      workbenchRequest<KnowledgeAssistantSettings>('/assistant').then(settings => {
        if (cancelled) return;
        setAssistant(settings); if (!active.current) setKnowledge(settings.knowledge); settingsModel.current = settings.model || '';
        setModel(current => rememberedChatModel(selectionRevision.current === initialSelection ? remembered() : current, settingsModel.current || defaultModel.current, modelsRef.current.map(item => item.id)));
      }).catch(fail),
    ]).then(() => { if (!cancelled) setLoaded(true); });
    const refreshModels = (preferred: unknown = null) => {
      const requested = ++revision;
      void workbenchRequest<{ models: WorkbenchModel[]; defaultModel?: string }>('/models').then(result => {
        if (cancelled || requested !== revision) return;
        modelsRef.current = result.models;
        setModels(result.models);
        setModelsLoaded(true);
        if (defaultModel.current !== (result.defaultModel || '')) selectionRevision.current = 0;
        defaultModel.current = result.defaultModel || '';
        setModel(current => rememberedChatModel(typeof preferred === 'string' ? preferred : selectionRevision.current ? current : remembered(), settingsModel.current || defaultModel.current, result.models.map(item => item.id)));
      }).catch(reason => { if (!cancelled && requested === revision) setError(String(reason.message || reason)); });
    };
    const onRemembered = (event: Event) => { const id = (event as CustomEvent<string>).detail; if (modelsRef.current.some(item => item.id === id)) { selectionRevision.current++; setModel(id); } };
    const onStorage = (event: StorageEvent) => { if (event.key === CHAT_MODEL_KEY) refreshModels(event.newValue); };
    const onVisible = () => { if (document.visibilityState === 'visible') refreshModels(); };
    window.addEventListener('pmbrain:models-updated', refreshModels);
    window.addEventListener('focus', refreshModels);
    window.addEventListener('hashchange', refreshModels);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(CHAT_MODEL_EVENT, onRemembered);
    window.addEventListener('storage', onStorage);
    return () => { cancelled = true; mounted.current = false; window.removeEventListener('pmbrain:models-updated', refreshModels); window.removeEventListener('focus', refreshModels); window.removeEventListener('hashchange', refreshModels); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener(CHAT_MODEL_EVENT, onRemembered); window.removeEventListener('storage', onStorage); };
  }, [serviceReady]);
  const running = conversation?.messages.some(message => message.status === 'running') ?? false;
  useEffect(() => {
    if (!running || !conversation) return;
    const id = conversation.id; let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await workbenchRequest<WorkbenchConversation>(`/conversations/${id}?lite=1`);
        if (stopped || active.current !== id) return;
        setConversation(current => mergePolledConversation(current, next));
        if (next.messages.some(m => m.status === 'running')) timer = setTimeout(poll, 200);
        else await refresh();
      } catch (reason) { if (!stopped) { setError(reason instanceof Error ? reason.message : String(reason)); timer = setTimeout(poll, 2500); } }
    };
    timer = setTimeout(poll, 150);
    return () => { stopped = true; clearTimeout(timer); };
  }, [conversation?.id, running]);
  const select = async (id?: string) => {
    active.current = id; setConversation(undefined); setError('');
    if (!id) return;
    setPending(true);
    try { const next = await workbenchRequest<WorkbenchConversation>(`/conversations/${id}`); if (active.current === id) { setConversation(next); setKnowledge(next.knowledge); } }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setPending(false); }
  };
  const send = async (text: string, retry = false, editMessageId?: string, files?: { id: string; name: string; file?: File; saved?: boolean; mime?: string }[], attachmentsHydrated = false) => {
    if (pending || running || !serviceReady) return false;
    const useKnowledge = knowledge && databaseReady;
    setPending(true); setError('');
    let createdId: string | undefined;
    try {
      let id = conversation?.id;
      if (!id) { const created = await workbenchRequest<WorkbenchConversation>('/conversations', { model, knowledge: useKnowledge }); id = created.id; createdId = id; active.current = id; setConversation(created); }
      const attachments = files ? await Promise.all(files.map(file => filePayload(file))) : undefined;
      const attachmentFields = editMessageId
        ? { editMessageId, attachments: attachments ?? [], attachmentsHydrated }
        : (attachments?.some(item => item.data || item.keep) ? { attachments } : {});
      const next = await workbenchRequest<WorkbenchConversation>(`/conversations/${id}/messages`, { text, model, knowledge: useKnowledge, retry, ...attachmentFields });
      if (active.current === id) setConversation(next);
      try { await refresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
      return id;
    } catch (reason) {
      if (createdId) {
        try {
          await workbenchRequest(`/conversations/${createdId}?emptyOnly=true`, undefined, 'DELETE');
          if (active.current === createdId) { active.current = undefined; setConversation(undefined); }
        } catch {
          try {
            const saved = await workbenchRequest<WorkbenchConversation>(`/conversations/${createdId}`);
            if (active.current === createdId) setConversation(saved);
          } catch {}
        }
      }
      setError(reason instanceof Error ? reason.message : String(reason)); return false;
    }
    finally { setPending(false); }
  };
  const action = async (kind: 'cancel' | 'delete' | 'rename', title?: string) => {
    if (!conversation) return;
    const id = conversation.id; setError(''); setPending(true);
    try {
      if (kind === 'delete') { await workbenchRequest(`/conversations/${id}`, undefined, 'DELETE'); await select(); }
      else { const next = kind === 'cancel' ? await workbenchRequest<WorkbenchConversation>(`/conversations/${id}/cancel`, {}) : await workbenchRequest<WorkbenchConversation>(`/conversations/${id}`, { title }, 'PATCH'); if (active.current === id) setConversation(next); }
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setPending(false); }
  };
  const saveAssistant = async (value: KnowledgeAssistantSettings) => {
    const saved = await workbenchRequest<KnowledgeAssistantSettings>('/assistant', value, 'PUT');
    setAssistant(saved);
    settingsModel.current = saved.model || '';
    if (saved.model) { setModel(saved.model); rememberChatModel(saved.model, defaultModel.current); }
    if (!conversation) setKnowledge(saved.knowledge);
    return saved;
  };
  const chooseModel = (id: string) => { selectionRevision.current++; setModel(id); rememberChatModel(id, defaultModel.current); };
  return { rows, models, modelsLoaded, conversation, model, setModel: chooseModel, knowledge: knowledge && databaseReady, setKnowledge, assistant, saveAssistant, error, setError, loaded, pending, running, select, send, action };
}
