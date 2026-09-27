import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useCallback, useRef } from 'react';
import { AgentsPage } from './Agents';
import { ChatGptTunnelPanel } from './ChatGptTunnel';
import { RunOutput, InfoIcon, formatDate, pageTypeLabel, pageTypeTitle, type ConsoleRun, type BrainPageChunk } from '../lib/shared';
import { getThinkRetrievalWarning, parseThinkOutput } from '../lib/think-output';
import { describeRunProgress } from '../lib/run-progress';
import { summarizeImportRun } from '../lib/import-summary';
import { CopyButton } from '../lib/clipboard';
import { parseMarkdownTable } from '../lib/markdown-table';
import { MarkdownArticle } from './Documentation';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  Activity, AlertTriangle, Bot, Boxes, Check, CheckCircle2, ChevronDown, Clock3, Cpu, Database,
  Download, FileText, FolderKanban, FolderTree, History, Layers3, Link2,
  ListTodo, Plus, RefreshCw, Search, Sparkles, Tags, Upload, type LucideIcon,
} from 'lucide-react';
import {
  Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer,
  Tooltip as ChartTooltip, XAxis, YAxis,
} from 'recharts';
import {
  LoadingBlock,
  MetricCard,
  pct,
  sourceLabel,
  useOverview,
  type BrainOverview,
  type SourceSummary,
} from './console-shared';

import {
  IntentPreview,
  KnowledgeSearchMode,
  KnowledgeSearchHit,
  KnowledgeSearchPayload,
  NaturalTaskHistoryItem,
  NaturalWorkspaceState,
  PgliteBusyNotice,
  NATURAL_HISTORY_KEY,
  NATURAL_WORKSPACE_KEY,
  KNOWLEDGE_SEARCH_MODE_KEY,
  NATURAL_HISTORY_LIMIT,
  MAX_NATURAL_TASK_CHARACTERS,
  loadKnowledgeSearchMode,
  saveKnowledgeSearchMode,
  knowledgeSearchModeLabel,
  summarizeKnowledgeSearch,
  MAX_KNOWLEDGE_ATTACHMENTS,
  MAX_KNOWLEDGE_ATTACHMENT_BYTES,
  KNOWLEDGE_ATTACHMENT_EXTENSIONS,
  KNOWLEDGE_ATTACHMENT_ACCEPT,
  KnowledgeAttachment,
  attachmentExtension,
  attachmentSizeLabel,
  looksLikeLocalImportPath,
  waitForConsoleRun,
  loadNaturalHistory,
  saveNaturalHistory,
  loadNaturalWorkspace,
  saveNaturalWorkspace,
  ImportEmbeddingSkip,
  getImportEmbeddingSkip,
  summarizeImportEmbeddingSkip,
  summarizeRunResult,
  summarizeRunLog,
  KnowledgeImportOptions,
} from './import/import-support';

function NaturalLanguagePanel({
  compact = false,
  onNavigate,
  importOptions,
  chatModel,
}: {
  compact?: boolean;
  onNavigate?: (page: string) => void;
  importOptions?: KnowledgeImportOptions;
  chatModel?: string | null;
}) {
  const [initialWorkspace] = useState(loadNaturalWorkspace);
  const [text, setText] = useState(initialWorkspace.text);
  const [preview, setPreview] = useState<IntentPreview | null>(initialWorkspace.preview);
  const [run, setRun] = useState<ConsoleRun | null>(initialWorkspace.run);
  const [searchPayload, setSearchPayload] = useState<KnowledgeSearchPayload | null>(null);
  const [searchMode, setSearchMode] = useState<KnowledgeSearchMode>(() => loadKnowledgeSearchMode());
  const [searchModeMenuOpen, setSearchModeMenuOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitClicked, setSubmitClicked] = useState(false);
  const [executeClicked, setExecuteClicked] = useState(false);
  const [error, setError] = useState(initialWorkspace.error);
  const [history, setHistory] = useState<NaturalTaskHistoryItem[]>(() => loadNaturalHistory());
  const [historyQuery, setHistoryQuery] = useState('');
  const [activeHistoryId, setActiveHistoryId] = useState<string | null>(initialWorkspace.activeHistoryId);
  const [pendingContext, setPendingContext] = useState(initialWorkspace.pendingContext);
  const [attachments, setAttachments] = useState<KnowledgeAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [attachmentProgress, setAttachmentProgress] = useState('');
  const [progressNow, setProgressNow] = useState(Date.now());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchModeMenuRef = useRef<HTMLDivElement>(null);
  const inputLength = text.length;
  const inputTooLong = inputLength > MAX_NATURAL_TASK_CHARACTERS;

  useEffect(() => {
    if (!searchModeMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!searchModeMenuRef.current?.contains(event.target as Node)) {
        setSearchModeMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSearchModeMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [searchModeMenuOpen]);

  const applySearchMode = (mode: KnowledgeSearchMode) => {
    setSearchMode(mode);
    saveKnowledgeSearchMode(mode);
    setSearchModeMenuOpen(false);
  };

  const addAttachments = (files: File[]) => {
    if (files.length === 0) return;
    const existing = new Set(attachments.map(item => item.id));
    const accepted: KnowledgeAttachment[] = [];
    const warnings = new Set<string>();

    for (const file of files) {
      const extension = attachmentExtension(file.name);
      const id = `${file.name}:${file.size}:${file.lastModified}`;
      const unsupportedMarkdownCase = (extension === '.md' || extension === '.mdx') && !file.name.endsWith(extension);
      if (!KNOWLEDGE_ATTACHMENT_EXTENSIONS.has(extension) || unsupportedMarkdownCase) {
        warnings.add(`不支持 ${file.name} 的文件格式`);
        continue;
      }
      if (file.size === 0) {
        warnings.add(`${file.name} 是空文件`);
        continue;
      }
      if (extension !== '.jsonl' && file.size > MAX_KNOWLEDGE_ATTACHMENT_BYTES) {
        warnings.add(`${file.name} 超过 ${attachmentSizeLabel(MAX_KNOWLEDGE_ATTACHMENT_BYTES)} 限制`);
        continue;
      }
      if (existing.has(id)) continue;
      existing.add(id);
      accepted.push({ id, file });
    }

    const available = Math.max(0, MAX_KNOWLEDGE_ATTACHMENTS - attachments.length);
    if (accepted.length > available) warnings.add(`一次最多添加 ${MAX_KNOWLEDGE_ATTACHMENTS} 个文件`);
    setAttachments(current => [...current, ...accepted.slice(0, available)]);
    setAttachmentError(Array.from(warnings).join('；'));
    setSubmitClicked(false);
    setExecuteClicked(false);
  };

  const removeAttachment = (id: string) => {
    setAttachments(current => current.filter(item => item.id !== id));
    setAttachmentError('');
  };

  const handleAttachmentPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [
      ...Array.from(event.clipboardData.files),
      ...Array.from(event.clipboardData.items)
        .filter(item => item.kind === 'file')
        .map(item => item.getAsFile())
        .filter((file): file is File => Boolean(file)),
    ];
    if (files.length === 0) return;
    event.preventDefault();
    addAttachments(files);
  };

  const uploadAttachmentRuns = async (files: KnowledgeAttachment[]): Promise<ConsoleRun> => {
    let lastRun: ConsoleRun | null = null;
    for (let index = 0; index < files.length; index++) {
      const attachment = files[index];
      setAttachmentProgress(`正在导入 ${index + 1}/${files.length}：${attachment.file.name}`);
      const response = await api.startImportUploadRun(attachment.file, {
        sourceId: importOptions?.sourceId,
        autoEmbed: importOptions?.autoEmbed ?? true,
        structuredDocuments: importOptions?.structuredDocuments ?? true,
        documentOcr: true,
        workers: importOptions?.workers ?? 1,
      }) as { runId: string };
      lastRun = await waitForConsoleRun(response.runId, setRun);
      if (lastRun.status !== 'completed') {
        const fallback = lastRun.status === 'cancelled'
          ? `${attachment.file.name} 导入已取消`
          : `${attachment.file.name} 导入失败`;
        throw new Error(lastRun.error || lastRun.stderr || fallback);
      }
      setAttachments(current => current.filter(item => item.id !== attachment.id));
    }
    if (!lastRun) throw new Error('没有可导入的附件');
    return lastRun;
  };

  const upsertHistory = (item: NaturalTaskHistoryItem) => {
    setHistory(current => {
      const next = [item, ...current.filter(row => row.id !== item.id)].slice(0, NATURAL_HISTORY_LIMIT);
      saveNaturalHistory(next);
      return next;
    });
    setActiveHistoryId(item.id);
  };

  const selectHistory = async (item: NaturalTaskHistoryItem) => {
    setText(item.text);
    setPreview(item.preview ?? null);
    setRun(item.run ?? null);
    setSearchPayload(item.search ?? null);
    setError(item.error ?? '');
    setActiveHistoryId(item.id);
    if (item.search?.mode) applySearchMode(item.search.mode);
    if (!item.run?.id) return;
    setLoading(true);
    try {
      const nextRun = await api.run(item.run.id) as ConsoleRun;
      setRun(nextRun);
      upsertHistory({ ...item, run: nextRun });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const launchPreview = async (nextPreview: IntentPreview, historyItem: NaturalTaskHistoryItem, confirmed: boolean): Promise<ConsoleRun> => {
    const res = await api.executeIntent(nextPreview.previewId, confirmed) as { runId: string };
    const first = await api.run(res.runId) as ConsoleRun;
    setRun(first);
    upsertHistory({ ...historyItem, preview: nextPreview, run: first });
    return first;
  };

  const submitAuto = async () => {
    if ((!text.trim() && attachments.length === 0) || inputTooLong) return;
    setSubmitClicked(true);
    setExecuteClicked(false);
    setLoading(true);
    setError('');
    setAttachmentError('');
    setPreview(null);
    setRun(null);
    setSearchPayload(null);
    setSearchModeMenuOpen(false);
    const attachedFiles = [...attachments];
    const attachedNames = attachedFiles.map(item => item.file.name);
    const requestText = text.trim() || '请阅读并整理这些文件。';
    const basePrompt = pendingContext
      ? `原始请求：${pendingContext}\n用户补充：${requestText}`
      : requestText;
    const prompt = attachedNames.length > 0
      ? `以下附件已经由系统完成导入：${attachedNames.join('、')}。不要再次请求文件路径或重复执行导入。\n用户对已导入内容的要求：${basePrompt}`
      : basePrompt;
    const historyItem: NaturalTaskHistoryItem = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      text: basePrompt,
      createdAt: new Date().toISOString(),
    };
    setActiveHistoryId(historyItem.id);
    try {
      let attachmentRun: ConsoleRun | null = null;
      if (attachedFiles.length > 0) {
        attachmentRun = await uploadAttachmentRuns(attachedFiles);
        setAttachments([]);
      }
      const nextPreview = await api.previewIntent(prompt) as IntentPreview;
      const repeatedAttachmentImport = attachmentRun && (
        nextPreview.intent === 'import_path'
        || /(?:本地)?(?:文件|文件夹)?路径|文件夹位置/u.test(nextPreview.clarification ?? '')
      );
      if (repeatedAttachmentImport && attachmentRun) {
        const importedPreview: IntentPreview = {
          previewId: `attachment-import-${Date.now()}`,
          intent: 'import_path',
          confidence: 1,
          slots: { files: attachedNames },
          proposedAction: `附件已导入知识库：${attachedNames.join('、')}`,
          riskLevel: 'write',
          requiresConfirmation: false,
        };
        setPreview(importedPreview);
        setRun(attachmentRun);
        setPendingContext('');
        setText('');
        upsertHistory({ ...historyItem, preview: importedPreview, run: attachmentRun });
        return;
      }
      setPreview(nextPreview);
      upsertHistory({ ...historyItem, preview: nextPreview });
      if (nextPreview.clarification) {
        setPendingContext(prompt);
        setText('');
      } else {
        setPendingContext('');
        if (!nextPreview.requiresConfirmation) {
          const first = await launchPreview(nextPreview, historyItem, false);
          const completed = await waitForConsoleRun(first.id, setRun);
          upsertHistory({ ...historyItem, preview: nextPreview, run: completed });
          if (completed.status === 'completed') setText('');
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      upsertHistory({ ...historyItem, error: message });
    } finally {
      setAttachmentProgress('');
      setLoading(false);
    }
  };

  const startDirect = async (kind: 'import' | 'search') => {
    const value = text.trim();
    const attachedFiles = kind === 'import' ? [...attachments] : [];
    if ((kind === 'search' ? !value : !value && attachedFiles.length === 0) || inputTooLong) return;
    setSubmitClicked(true);
    setExecuteClicked(false);
    setLoading(true);
    setError('');
    setAttachmentError('');
    setRun(null);
    setSearchPayload(null);
    setPendingContext('');
    setSearchModeMenuOpen(false);
    const attachedNames = attachedFiles.map(item => item.file.name);
    const displayValue = attachedNames.length > 0 ? attachedNames.join('、') : value;
    const captureText = kind === 'import' && attachedFiles.length === 0 && !looksLikeLocalImportPath(value);
    const modeLabel = knowledgeSearchModeLabel(searchMode);
    const directPreview: IntentPreview = {
      previewId: `direct-${Date.now()}`,
      intent: kind === 'search' ? 'search_brain' : captureText ? 'capture_memory' : 'import_path',
      confidence: 1,
      slots: kind === 'search'
        ? { query: value, searchMode }
        : captureText
          ? { content: value }
          : attachedNames.length > 0
            ? { files: attachedNames }
            : { path: value },
      proposedAction: kind === 'search'
        ? `${modeLabel}：${value}`
        : captureText
          ? `保存完整文本到知识库（共 ${value.length.toLocaleString('zh-CN')} 字）`
          : attachedNames.length > 0
            ? `导入文件：${displayValue}`
            : `导入路径：${value}`,
      riskLevel: kind === 'search' ? 'read' : 'write',
      requiresConfirmation: false,
    };
    const historyItem: NaturalTaskHistoryItem = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      text: displayValue,
      createdAt: new Date().toISOString(),
      preview: directPreview,
    };
    setActiveHistoryId(historyItem.id);
    setPreview(directPreview);
    upsertHistory(historyItem);
    try {
      if (kind === 'search') {
        const payload = await api.knowledgeSearch({
          query: value,
          mode: searchMode,
          limit: 20,
        }) as KnowledgeSearchPayload;
        setSearchPayload(payload);
        upsertHistory({ ...historyItem, search: payload });
        return;
      }
      let first: ConsoleRun;
      if (kind === 'import' && attachedFiles.length > 0) {
        first = await uploadAttachmentRuns(attachedFiles);
        setAttachments([]);
      } else if (captureText) {
        const response = await api.startCaptureRun(value, importOptions?.sourceId) as { runId: string };
        first = await waitForConsoleRun(response.runId, setRun);
        if (first.status === 'completed') setText('');
      } else {
        const response = await api.startImportRun({
          path: value,
          sourceId: importOptions?.sourceId,
          includeOffice: true,
          includeImages: true,
          autoEmbed: true,
          structuredDocuments: true,
          documentOcr: true,
          workers: importOptions?.workers ?? 1,
        }) as { runId: string };
        first = await api.run(response.runId) as ConsoleRun;
      }
      setRun(first);
      upsertHistory({ ...historyItem, run: first });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      upsertHistory({ ...historyItem, error: message });
    } finally {
      setAttachmentProgress('');
      setLoading(false);
    }
  };

  const execute = async (confirmed: boolean) => {
    if (!preview || !activeHistoryId) return;
    const current = history.find(item => item.id === activeHistoryId);
    const historyItem: NaturalTaskHistoryItem = current ?? {
      id: activeHistoryId,
      text: text.trim(),
      createdAt: new Date().toISOString(),
      preview,
    };
    setExecuteClicked(true);
    setLoading(true);
    setError('');
    try {
      const first = await launchPreview(preview, historyItem, confirmed);
      const completed = await waitForConsoleRun(first.id, setRun);
      upsertHistory({ ...historyItem, preview, run: completed });
      if (completed.status === 'completed') {
        setText('');
        setPendingContext('');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    saveNaturalWorkspace({ text, preview, run, error, activeHistoryId, pendingContext });
  }, [text, preview, run, error, activeHistoryId, pendingContext]);

  useEffect(() => {
    if (!run || (run.status !== 'running' && run.status !== 'queued')) return;
    const timer = setInterval(async () => {
      try {
        const nextRun = await api.run(run.id) as ConsoleRun;
        setRun(nextRun);
        if (activeHistoryId) {
          setHistory(current => {
            const next = current.map(item => item.id === activeHistoryId ? { ...item, run: nextRun } : item);
            saveNaturalHistory(next);
            return next;
          });
        }
      } catch {}
    }, 1200);
    return () => clearInterval(timer);
  }, [run?.id, run?.status, activeHistoryId]);

  useEffect(() => {
    if (!run || (run.status !== 'running' && run.status !== 'queued')) return;
    setProgressNow(Date.now());
    const timer = window.setInterval(() => setProgressNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [run?.id, run?.status]);

  const importRunSummary = preview?.intent === 'import_path' && run ? summarizeImportRun(preview, run) : null;
  const importEmbeddingSkip = preview?.intent === 'import_path' && run && !importRunSummary ? getImportEmbeddingSkip(run) : null;
  const searchSummary = searchPayload ? summarizeKnowledgeSearch(searchPayload) : null;
  const summary = searchSummary
    ?? importRunSummary?.markdown
    ?? (preview && run ? summarizeRunResult(preview, run) : null);
  const searchWarning = preview?.intent === 'search_brain' && run && !searchPayload
    ? getThinkRetrievalWarning(run.stderr)
    : null;
  const isRunActive = run?.status === 'queued' || run?.status === 'running';
  const runProgress = run ? describeRunProgress(run, chatModel, progressNow) : null;
  const completenessNote = preview?.intent === 'capture_memory'
    ? '页面只显示内容摘要；实际提交和保存的是上方标注字数的完整文本。'
    : preview?.intent === 'import_path'
      ? '摘要会区分完整导入、未切片、未变化跳过和失败；逐文件名单可展开执行详情查看。'
      : null;

  return (
    <div className={`nl-shell ${compact ? 'compact' : ''}`}>
      <div className={`pm-card nl-card ${compact ? 'compact' : ''}`}>
        <div className="pm-section-head">
          <div>
            <div className="pm-eyebrow">一处完成常用知识工作</div>
            <h2>知识助手</h2>
          </div>
          {compact && <button className="pm-ghost" onClick={() => onNavigate?.('import')}>完整视图</button>}
          {!compact && <span className="pm-muted">{chatModel || '尚未配置模型'}</span>}
        </div>
        {!compact && !preview && !run && !searchPayload && <div className="product-chat-welcome">
          <Layers3 aria-hidden="true" /><h1>有什么可以帮你的吗？</h1><p>基于你的知识库，进行搜索、分析、总结和创作</p>
          <div className="product-quick-actions">
            <button onClick={() => setText('帮我搜索知识库中关于')}><Search /><span><b>搜索我的知识库</b><small>查找相关资料</small></span></button>
            <button onClick={() => setText('请总结以下资料的核心要点：')}><FileText /><span><b>总结文档内容</b><small>提炼核心要点</small></span></button>
            <button onClick={() => setText('基于我的知识库，帮我撰写：')}><Sparkles /><span><b>帮我写点内容</b><small>基于我的资料创作</small></span></button>
          </div>
        </div>}
        {pendingContext && <div className="assistant-followup">请补充上一个问题需要的信息，点击“AI搜索”后会继续判断。</div>}
        <div className="assistant-composer">
          {attachments.length > 0 && (
            <div className="assistant-attachments" role="list" aria-label={`已添加 ${attachments.length} 个文件`}>
              {attachments.map(attachment => {
                const extension = attachmentExtension(attachment.file.name).slice(1).toUpperCase();
                return (
                  <div className="assistant-attachment-chip" role="listitem" key={attachment.id}>
                    <span className="assistant-file-type" aria-hidden="true">{extension.slice(0, 4) || 'FILE'}</span>
                    <span className="assistant-file-copy">
                      <strong title={attachment.file.name}>{attachment.file.name}</strong>
                      <small>{attachmentSizeLabel(attachment.file.size)}</small>
                    </span>
                    <button
                      type="button"
                      className="assistant-remove-file"
                      aria-label={`移除文件 ${attachment.file.name}`}
                      title="移除文件"
                      onClick={() => removeAttachment(attachment.id)}
                      disabled={loading}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          <textarea
            value={text}
            onChange={e => {
              setText(e.target.value);
              setSubmitClicked(false);
              setExecuteClicked(false);
            }}
            onPaste={handleAttachmentPaste}
            placeholder={pendingContext ? '在这里补充路径、Source 或其他缺少的信息…' : '输入要保存的正文、本地文件路径或知识库问题；也可点击 + 或直接粘贴文件…'}
            rows={compact ? 4 : 6}
          />
          <div className="assistant-composer-footer">
            <input
              ref={fileInputRef}
              className="assistant-file-input"
              type="file"
              multiple
              accept={KNOWLEDGE_ATTACHMENT_ACCEPT}
              aria-label="选择本地文件"
              tabIndex={-1}
              onChange={event => {
                addAttachments(Array.from(event.target.files ?? []));
                event.target.value = '';
              }}
            />
            <button
              type="button"
              className="assistant-attach-button"
              aria-label="添加本地文件"
              title="添加本地文件"
              onClick={() => fileInputRef.current?.click()}
              disabled={loading || attachments.length >= MAX_KNOWLEDGE_ATTACHMENTS}
            >
              <Plus aria-hidden="true" />
            </button>
            <span
              className="assistant-attachment-help"
              aria-live="polite"
              title="支持会话 JSONL、Markdown、Office/PDF/表格和图片；会话 JSONL 不限制原始文件大小"
            >
              {attachmentProgress || (attachments.length > 0 ? `已添加 ${attachments.length} 个文件` : '选择文件，也可以从资源管理器复制后粘贴')}
            </span>
          </div>
        </div>
        <div className={`nl-input-meta ${inputTooLong ? 'is-over-limit' : ''}`}>
          <span>{attachments.length > 0 ? '导入会处理附件；AI搜索会先导入再按文字要求处理；搜索只使用文字。' : '导入会检查整个路径：未变化文件跳过，修改过的文件重新导入，并按成功、跳过和失败分类。'}</span>
          <strong>{inputLength.toLocaleString('zh-CN')} / {MAX_NATURAL_TASK_CHARACTERS.toLocaleString('zh-CN')} 字</strong>
        </div>
        {attachmentError && <div className="pm-error-text" role="alert">{attachmentError}</div>}
        {inputTooLong && (
          <div className="pm-error-text">已超出 {(inputLength - MAX_NATURAL_TASK_CHARACTERS).toLocaleString('zh-CN')} 字，请缩短后发送；系统不会静默截断内容。</div>
        )}
        <div className="pm-actions assistant-actions" aria-label="知识助手操作">
          <button
            type="button"
            className="pm-assistant-action import-action"
            onClick={() => void startDirect('import')}
            disabled={loading || (!text.trim() && attachments.length === 0) || inputTooLong}
          >
            <span className="assistant-action-icon" aria-hidden="true"><Upload /></span>
            <span className="assistant-action-copy"><strong>导入</strong></span>
          </button>
          <div className={`assistant-search-split ${searchModeMenuOpen ? 'is-open' : ''}`} ref={searchModeMenuRef}>
            <button
              type="button"
              className="pm-assistant-action search-action search-action-main"
              onClick={() => void startDirect('search')}
              disabled={loading || !text.trim() || inputTooLong}
              title={`当前：${knowledgeSearchModeLabel(searchMode)}`}
            >
              <span className="assistant-action-icon" aria-hidden="true"><Search /></span>
              <span className="assistant-action-copy">
                <strong>搜索</strong>
                <small>{knowledgeSearchModeLabel(searchMode)}</small>
              </span>
            </button>
            <button
              type="button"
              className="search-mode-badge"
              aria-label="选择搜索方式"
              aria-haspopup="menu"
              aria-expanded={searchModeMenuOpen}
              disabled={loading}
              onClick={(event) => {
                event.stopPropagation();
                setSearchModeMenuOpen(open => !open);
              }}
            >
              <ChevronDown aria-hidden="true" />
            </button>
            {searchModeMenuOpen && (
              <div className="search-mode-menu" role="menu" aria-label="搜索方式">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={searchMode === 'keyword'}
                  className={searchMode === 'keyword' ? 'is-active' : ''}
                  onClick={() => applySearchMode('keyword')}
                >
                  <span className="search-mode-check" aria-hidden="true">
                    {searchMode === 'keyword' ? <Check /> : null}
                  </span>
                  <span>
                    <strong>关键词搜索</strong>
                    <small>标题与正文全文匹配，不调用普通模型</small>
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={searchMode === 'semantic'}
                  className={searchMode === 'semantic' ? 'is-active' : ''}
                  onClick={() => applySearchMode('semantic')}
                >
                  <span className="search-mode-check" aria-hidden="true">
                    {searchMode === 'semantic' ? <Check /> : null}
                  </span>
                  <span>
                    <strong>语义搜索</strong>
                    <small>关键词＋向量混合检索，需要向量模型</small>
                  </span>
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            className={`pm-assistant-action ai-action ${submitClicked ? 'pm-clicked' : ''}`}
            onClick={() => void submitAuto()}
            disabled={loading || (!text.trim() && attachments.length === 0) || inputTooLong}
          >
            <span className="assistant-action-icon" aria-hidden="true"><Sparkles /></span>
            <span className="assistant-action-copy"><strong>{loading ? '处理中…' : 'AI搜索'}</strong></span>
          </button>
        </div>
        {error && <div className="pm-error-text">{error}</div>}
        {searchWarning && <div className="assistant-search-warning" role="status">{searchWarning}</div>}
        {preview && (
          <div className="intent-preview">
            <p className="nl-proposed-action">{preview.clarification || preview.proposedAction}</p>
            {!preview.clarification && preview.requiresConfirmation && (
              <button
                className={`pm-primary ${executeClicked && !isRunActive ? 'pm-clicked' : ''}`}
                onClick={() => void execute(preview.requiresConfirmation)}
                disabled={loading || isRunActive}
              >
                确认并执行
              </button>
            )}
          </div>
        )}
        {searchPayload && (
          <div className="nl-result knowledge-search-result">
            <div className="nl-summary">
              <div className="nl-summary-text">
                {summary && <MarkdownArticle markdown={summary} />}
              </div>
              <span className={`pm-pill run-pill ${searchPayload.result_count > 0 ? 'run-completed' : 'run-partial'}`}>
                {searchPayload.result_count > 0 ? '已完成' : '无结果'}
              </span>
            </div>
            {searchPayload.results.length > 0 ? (
              <ul className="knowledge-search-hits">
                {searchPayload.results.map((hit) => (
                  <li key={`${hit.source_id ?? 'default'}:${hit.page_id}:${hit.chunk_id}`}>
                    <div className="knowledge-search-hit-head">
                      <strong title={hit.slug}>{hit.title || hit.slug}</strong>
                      <em>{hit.score.toFixed(3)}</em>
                    </div>
                    <code className="knowledge-search-slug">{hit.slug}</code>
                    {hit.locator && <span className="knowledge-search-locator">{hit.locator}</span>}
                    {hit.snippet && <p>{hit.snippet}{hit.snippet.length >= 160 ? '…' : ''}</p>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="pm-hint knowledge-search-empty">
                {searchPayload.mode === 'semantic'
                  ? '可以改用关键词搜索，或确认已配置向量模型并完成向量化。'
                  : '可以换个关键词，或切换到语义搜索再试。'}
              </p>
            )}
          </div>
        )}
        {run && !searchPayload && (
          <div className="nl-result">
            <div className={`nl-summary ${importRunSummary?.tone === 'partial' || importEmbeddingSkip ? 'is-partial' : ''}`}>
              <div className="nl-summary-text">
                {summary && <MarkdownArticle markdown={summary} />}
                {completenessNote && <div className="nl-completeness-note">{completenessNote}</div>}
              </div>
              <span className={`pm-pill run-pill ${
                importRunSummary?.tone === 'partial' || importEmbeddingSkip
                  ? 'run-partial'
                  : importRunSummary?.tone === 'failed'
                    ? 'run-failed'
                    : `run-${run.status}`
              }`}>
                {searchWarning ? '检索超时' : importRunSummary?.badge ?? (importEmbeddingSkip ? '部分完成' : runProgress?.label ?? run.status)}
              </span>
            </div>
            {runProgress?.meta && (
              <div className={`assistant-run-progress ${runProgress.active ? 'is-active' : 'is-finished'}`} role="status" aria-live="polite">
                <div className="assistant-run-progress-meta">
                  <Clock3 aria-hidden="true" />
                  <span>{runProgress.meta}</span>
                </div>
                {runProgress.explanation && (
                  <p>
                    {runProgress.localModel ? <Cpu aria-hidden="true" /> : <Activity aria-hidden="true" />}
                    <span>{runProgress.explanation}</span>
                  </p>
                )}
              </div>
            )}
            <details className="nl-details">
              <summary>查看执行详情</summary>
              {run.error && <div className="pm-error-text">{run.error}</div>}
              {run.stdout && <pre>{run.stdout}</pre>}
              {run.stderr && <pre className="stderr">{run.stderr}</pre>}
            </details>
          </div>
        )}
      </div>
      {!compact && (
        <div className="pm-card nl-history">
          <label className="product-history-search"><Search size={18} /><input aria-label="搜索工作记录" placeholder="搜索工作记录…" value={historyQuery} onChange={event => setHistoryQuery(event.target.value)} /></label>
          <button className="product-new-work" disabled={loading} onClick={() => {
            setText(''); setPreview(null); setRun(null); setSearchPayload(null); setError(''); setPendingContext(''); setActiveHistoryId(null); setAttachments([]); setAttachmentError('');
          }}>＋ 新建对话</button>
          <div className="pm-section-head">
            <h2>最近 5 条</h2>
            {history.length > 0 && (
              <button
                className="pm-ghost"
                onClick={() => {
                  saveNaturalHistory([]);
                  setHistory([]);
                  setActiveHistoryId(null);
                }}
              >
                清空
              </button>
            )}
          </div>
          {history.length === 0 ? (
            <div className="pm-empty compact-empty">暂无历史记录。每次执行任务后会自动保留在这里。</div>
          ) : (
            <div className="nl-history-list">
              {history.filter(item => item.text.includes(historyQuery)).map(item => (
                <button
                  key={item.id}
                  className={item.id === activeHistoryId ? 'active' : ''}
                  onClick={() => void selectHistory(item)}
                >
                  <span>{new Date(item.createdAt).toLocaleString()}</span>
                  <b>{item.preview?.proposedAction?.slice(0, 20) ?? item.run?.status ?? (item.error ? '失败' : '已记录')}</b>
                  <em>{item.text}</em>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ImportDataPage() {
  const { overview } = useOverview();
  return (
    <div className="pm-page knowledge-assistant-page">
      <section className="assistant-hero">
        <div>
          <div className="pm-eyebrow">IMPORT · SEARCH · ASK</div>
          <h1>知识工作台</h1>
          <p>输入正文、路径或添加文件；导入直接保存，搜索支持关键词/语义切换，AI搜索才走 AI 意图。</p>
        </div>
        <div className="assistant-pulse" aria-hidden="true"><i /><i /><i /></div>
      </section>
      <NaturalLanguagePanel chatModel={overview?.chat_model} importOptions={{
        includeOffice: true,
        includeImages: true,
        autoEmbed: true,
        structuredDocuments: true,
        documentOcr: true,
        workers: 1,
      }} />
    </div>
  );
}


export function NaturalLanguagePage() {
  return <ImportDataPage />;
}
