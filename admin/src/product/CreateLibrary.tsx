import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { desktopApi } from '../lib/product-fetch';
import { availableServiceModels } from '../../../shared/model-services';
import type { ConsoleRun } from '../../../shared/contracts/common';
import { waitForConsoleRun } from '../pages/import/import-support';
import { createIntent, importBuildDetail, importBuildSteps, suggestedChatModel, type CreateIntent } from './home-model';
import type { DesktopSetupState, SidecarState } from '../../../desktop/src/preload';
import './home.css';

const STEPS = [
  ['create', '创建知识库'],
  ['models', '基础配置'],
  ['sources', '选择资料来源'],
  ['build', '开始构建'],
  ['done', '完成'],
] as const;
type StepId = typeof STEPS[number][0];

function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitUntilReady(): Promise<void> {
  const desktop = desktopApi();
  if (!desktop) return;
  const current = await desktop.getState();
  if (current?.phase === 'ready') return;
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => { stop(); reject(new Error('知识库服务启动超时。可以先回到首页，稍后再试。')); }, 120000);
    const stop = desktop.onState((state: SidecarState) => {
      if (state.phase === 'ready') { window.clearTimeout(timer); stop(); resolve(); }
      if (state.phase === 'failed') { window.clearTimeout(timer); stop(); reject(new Error(state.message || '知识库服务没有启动')); }
    });
  });
}

export function CreateLibrary({ onDone, onCreated, onOpenSettings }: {
  onDone: (target: string) => void;
  onCreated: () => void;
  onOpenSettings: (panel: string) => void;
}) {
  const desktop = desktopApi();
  const [intent] = useState<CreateIntent>(() => createIntent(window.location.hash));
  const [step, setStep] = useState<StepId>('create');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [path, setPath] = useState('');
  const [directory, setDirectory] = useState('');
  const [engine, setEngine] = useState<'pglite' | 'postgres'>('pglite');
  const [databaseUrl, setDatabaseUrl] = useState('');
  const [customPath, setCustomPath] = useState('');
  const [chatChoices, setChatChoices] = useState<Array<{ value: string; label: string }>>([]);
  const [embeddingChoices, setEmbeddingChoices] = useState<Array<{ value: string; label: string; dimensions?: number }>>([]);
  const [chatModel, setChatModel] = useState('');
  const [pickedChat, setPickedChat] = useState('');
  const [folder, setFolder] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [run, setRun] = useState<ConsoleRun | null>(null);
  const [detail, setDetail] = useState('');
  const index = STEPS.findIndex(item => item[0] === step);
  useEffect(() => {
    if (!desktop) return;
    void desktop.getSetup().then((result: DesktopSetupState) => {
      const setup = result.setup;
      setPath(setup.defaults.databasePath);
      setDirectory(setup.defaults.knowledgeDirectory);
      setCustomPath(setup.defaults.databasePath);
      setEngine(setup.current.engine);
      setDatabaseUrl(setup.current.databaseUrl ?? '');
      setChatModel(setup.current.chatModel ?? '');
      if (!setup.needsSetup) setStep('sources');
    }).catch((reason: unknown) => setError(textOf(reason)));
  }, [desktop]);
  const loadModels = async () => {
    if (!desktop) return;
    const [services, setup] = await Promise.all([desktop.getModelServices(), desktop.getSetup()]);
    const chat = availableServiceModels(services.services, 'chat').map(item => ({ value: item.value, label: item.label }));
    const embedding = availableServiceModels(services.services, 'embedding').map(item => ({ value: item.value, label: item.label, dimensions: item.model.dimensions }));
    setChatChoices(chat);
    setEmbeddingChoices(embedding);
    const current = setup.setup.current.chatModel ?? '';
    setChatModel(current);
    setPickedChat(current || suggestedChatModel(current, chat) || chat[0]?.value || '');
  };
  useEffect(() => {
    if (step !== 'models') return;
    void loadModels().catch((reason: unknown) => setError(textOf(reason)));
  }, [step]);
  const create = async () => {
    if (!desktop) return;
    setBusy(true); setError('');
    try {
      const setup = (await desktop.getSetup()).setup;
      await desktop.saveSetup({
        engine,
        resetAdvancedModelRouting: false,
        ...(engine === 'pglite' ? { databasePath: customPath.trim() || setup.defaults.databasePath } : { databaseUrl: databaseUrl.trim() }),
        knowledgeDirectory: setup.defaults.knowledgeDirectory,
      });
      await waitUntilReady();
      onCreated();
      setStep('models');
    } catch (reason) { setError(textOf(reason)); }
    finally { setBusy(false); }
  };
  const applyChat = async (value: string) => {
    if (!desktop || !value) { setStep('sources'); return; }
    setBusy(true); setError('');
    try {
      const snapshot = (await desktop.getSetup()).setup;
      const current = snapshot.current;
      if (current.chatModel !== value) {
        await desktop.saveSetup({ expectedModelRevision: snapshot.modelRevision, engine: current.engine, databasePath: current.databasePath, databaseUrl: current.databaseUrl, resetAdvancedModelRouting: false, modelConfig: { chatModel: value } });
        await waitUntilReady();
        setChatModel(value);
      }
      setStep('sources');
    } catch (reason) { setError(textOf(reason)); }
    finally { setBusy(false); }
  };
  const openModels = (panel: string) => {
    sessionStorage.setItem('pmbrain.createReturn', `create${intent ? `?intent=${intent}` : ''}`);
    onOpenSettings(panel);
  };
  const startBuild = async () => {
    if (!folder && !files.length) { setStep('done'); return; }
    setStep('build'); setBusy(true); setError(''); setRun(null);
    try {
      if (folder) {
        setDetail(`正在导入文件夹`);
        const accepted = await api.startImportRun({ path: folder, includeOffice: true, includeImages: true, autoEmbed: true, structuredDocuments: true, documentOcr: true, workers: 1 });
        const finished = await waitForConsoleRun(accepted.runId, setRun);
        if (finished.status !== 'completed') throw new Error(finished.error || finished.stderr || '文件夹导入没有完成');
      }
      for (let position = 0; position < files.length; position += 1) {
        const file = files[position];
        setDetail(`正在导入 ${position + 1}/${files.length}：${file.name}`);
        const accepted = await api.startImportUploadRun(file, { autoEmbed: true, structuredDocuments: true, documentOcr: true, workers: 1 });
        const finished = await waitForConsoleRun(accepted.runId, setRun);
        if (finished.status !== 'completed') throw new Error(finished.error || finished.stderr || `${file.name} 导入没有完成`);
      }
      setStep('done');
    } catch (reason) { setError(textOf(reason)); }
    finally { setBusy(false); }
  };
  const finishTarget = intent === 'organize' ? 'dream' : intent === 'ask' ? 'assistant' : intent === 'import' ? 'knowledge-import' : 'home';
  if (!desktop) {
    return <section className="create-page"><div className="create-wrap"><h1>创建知识库</h1><p>创建本地知识库是在 PMBrain 桌面版里完成的。浏览器里打开的是已经启动的知识库。</p><button type="button" className="home-primary" onClick={() => onDone('home')}>返回首页</button></div></section>;
  }
  return <section className="create-page"><div className="create-wrap">
    <button type="button" className="home-secondary" onClick={() => onDone('home')}>返回首页</button>
    <ol className="create-steps">{STEPS.map(([id, label], position) => <li key={id}><button type="button" data-state={position === index ? 'current' : position < index ? 'done' : 'pending'} disabled={position > index} onClick={() => { if (position < index) setStep(id); }}>{label}</button></li>)}</ol>
    <div className="create-panel">
      {error && <p className="wb-error" role="alert">{error}</p>}
      {step === 'create' && <>
        <h1>创建知识库</h1>
        <p>PMBrain 会在这台电脑上准备好你的知识库。之后导入的资料都会放在这里。</p>
        {path && <p className="create-path">位置：{path}</p>}
        {directory && <p className="create-path">资料目录：{directory}</p>}
        <div className="create-actions"><button type="button" className="home-primary" disabled={busy} onClick={() => void create()}>{busy ? '正在创建…' : '创建并继续'}</button></div>
        <details className="create-advanced"><summary>高级设置</summary><div className="create-form">
          <label>存储方式<select aria-label="存储方式" value={engine} onChange={event => setEngine(event.target.value as 'pglite' | 'postgres')}><option value="pglite">本机自动创建</option><option value="postgres">使用已有 Postgres</option></select></label>
          {engine === 'pglite' ? <label>知识库位置<input aria-label="知识库位置" value={customPath} onChange={event => setCustomPath(event.target.value)} /></label> : <label>Postgres 地址<input aria-label="Postgres 地址" value={databaseUrl} onChange={event => setDatabaseUrl(event.target.value)} placeholder="postgresql://" /></label>}
        </div></details>
      </>}
      {step === 'models' && <>
        <h1>基础配置</h1>
        <p>{chatModel ? `已使用对话模型 ${chatModel}。` : chatChoices.length ? '检测到可用的对话模型。选一个后就可以提问。' : '还没有检测到对话模型。可以先继续，稍后在模型设置里添加。没有对话模型时，仍然可以导入和按关键词搜索。'}</p>
        {!chatModel && chatChoices.length > 1 && <label className="create-form">对话模型<select aria-label="对话模型" value={pickedChat} onChange={event => setPickedChat(event.target.value)}>{chatChoices.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>}
        {embeddingChoices.length > 0 && <p>检测到向量模型 {embeddingChoices.map(item => item.label).join('、')}。需要语义搜索时，可以在模型设置里启用。</p>}
        <div className="create-actions">
          <button type="button" className="home-primary" disabled={busy} onClick={() => void applyChat(chatModel || suggestedChatModel(chatModel, chatChoices) || pickedChat)}>{busy ? '正在保存…' : '继续'}</button>
          <button type="button" onClick={() => openModels('models')}>打开模型设置</button>
          <button type="button" onClick={() => setStep('sources')}>稍后配置</button>
        </div>
      </>}
      {step === 'sources' && <>
        <h1>选择资料来源</h1>
        <p>可以选择一个文件夹，或几个文件。PMBrain 会读取文档、笔记和常见办公文件。这一步可以跳过，以后在首页的「导入资料」里继续。</p>
        <div className="create-actions">
          <button type="button" onClick={() => void desktop.chooseDirectory().then((selected: string | null) => { if (selected) setFolder(selected); })}>选择文件夹</button>
          <label className="create-choice">选择文件<input className="wb-file-input" aria-label="选择文件" type="file" multiple onChange={event => setFiles(Array.from(event.target.files ?? []))} /></label>
        </div>
        {folder && <p className="create-path">文件夹：{folder}</p>}
        {files.length > 0 && <ul className="create-list">{files.map(file => <li key={`${file.name}-${file.size}`}>{file.name}</li>)}</ul>}
        <div className="create-actions"><button type="button" className="home-primary" disabled={busy} onClick={() => void startBuild()}>{folder || files.length ? '开始导入' : '先跳过'}</button></div>
      </>}
      {step === 'build' && <>
        <h1>开始构建</h1>
        <p>{detail || importBuildDetail(run)}</p>
        <div className="build-steps">{importBuildSteps(run).map(item => <div key={item.id} data-state={item.state}><i />{item.label}</div>)}</div>
        <p className="create-path">{importBuildDetail(run)}</p>
        {!busy && error && <div className="create-actions"><button type="button" className="home-primary" onClick={() => void startBuild()}>重新导入</button><button type="button" onClick={() => setStep('done')}>先完成</button></div>}
      </>}
      {step === 'done' && <>
        <h1>知识库已经可以使用</h1>
        <p>资料进入知识库之后，可以整理、查看关联，也可以直接提问，或交给外部 AI 使用。</p>
        <div className="create-actions">
          <button type="button" className="home-primary" onClick={() => onDone(finishTarget)}>{intent === 'organize' ? '去知识整理' : intent === 'ask' ? '去知识助手' : intent === 'import' ? '继续导入' : '进入首页'}</button>
          <button type="button" onClick={() => onDone('home')}>进入首页</button>
          <button type="button" onClick={() => onDone('knowledge-import')}>打开导入</button>
        </div>
      </>}
    </div>
  </div></section>;
}
