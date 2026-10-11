import React, { useEffect, useRef, useState } from 'react';
import { FilePlus2, FolderPlus, Folder, FileText, X, Upload } from 'lucide-react';
import { api } from '../api';
import { desktopApi } from '../lib/product-fetch';
import { type ConsoleRun } from '../lib/shared';
import { TaskProgressCard, taskLink } from './TaskProgress';
import { waitForConsoleRun } from '../pages/import/import-support';
import { availableImportSources, importMaterials, type Material } from './import-materials';
import { useProductTasks } from './TaskActivity';
import { sourceLabel, type BrainOverview } from '../pages/console-shared';
import { dialogBackdropClick } from '../lib/dialog-backdrop';

export function ImportMaterials({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Material[]>([]);
  const [sources, setSources] = useState<BrainOverview['sources']>([]);
  const [sourceId, setSourceId] = useState('');
  const [mainSourceId, setMainSourceId] = useState('');
  const [sourceError, setSourceError] = useState('');
  const { setImports } = useProductTasks();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [active, setActive] = useState('');
  const [run, setRun] = useState<ConsoleRun | null>(null);
  const [results, setResults] = useState<Array<{ id: string; name: string; run: ConsoleRun; path: string }>>([]);
  const desktop = desktopApi();
  useEffect(() => { if (open && !dialog.current?.open) dialog.current?.showModal(); else if (!open) dialog.current?.close(); }, [open]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void api.brainOverview().then(overview => {
      if (!live) return;
      const available = availableImportSources(overview.sources);
      setSources(available); setMainSourceId(overview.main_source_id); setSourceError('');
      setSourceId(current => available.some(source => source.id === current) ? current : overview.main_source_id);
    }).catch(reason => { if (live) setSourceError(String(reason)); });
    return () => { live = false; };
  }, [open]);
  const addPath = (raw: string) => {
    const value = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!value) return;
    setItems(current => current.some(item => item.path === value) ? current : [...current, { id: crypto.randomUUID(), name: value.split(/[\\/]/).filter(Boolean).at(-1) || value, path: value }]);
    setError('');
  };
  const start = async () => {
    if (busy) return;
    const queued = [...items];
    if (!queued.length || !sources.some(source => source.id === sourceId) || sourceError) return;
    setItems(queued); setBusy(true); setError(''); setResults([]);
    setImports(current => [...current.filter(entry => !queued.some(item => item.id === entry.id)), ...queued.map(item => ({ id: item.id, name: item.name, sourceId }))]);
    let activeItem = queued[0];
    try {
      await importMaterials(queued, { api, sourceId, wait: waitForConsoleRun, update: setRun,
        accepted: (item, runId) => setImports(current => current.map(entry => entry.id === item.id ? { ...entry, runId } : entry)),
        starting: item => { activeItem = item; setActive(item.name); setRun(null); },
        completed: (item, completedRun) => { setResults(current => [...current, { id: item.id, name: item.name, run: completedRun, path: item.path ?? item.name }]); setItems(current => current.filter(entry => entry.id !== item.id)); window.dispatchEvent(new Event('pmbrain:materials-imported')); },
      });
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      setImports(current => current.filter(entry => !queued.some(item => item.id === entry.id) || entry.id === activeItem.id).map(entry => entry.id === activeItem.id ? { ...entry, error: message } : entry));
    }
    finally { setBusy(false); }
  };
  return <dialog ref={dialog} className="materials-drawer" onCancel={onClose} onClose={onClose} onClick={event=>dialogBackdropClick(event,onClose)} aria-labelledby="materials-title">
    <header><div><h2 id="materials-title">添加资料</h2><p>文件或目录导入到当前知识库。</p></div><button type="button" aria-label="关闭添加资料" onClick={onClose}><X size={18} /></button></header>
    <div className="materials-body">
      <div className="materials-actions"><button type="button" disabled={busy} onClick={() => files.current?.click()}><FilePlus2 size={20} /><b>本地文件</b><small>文档、图片、Markdown</small></button>{desktop && <button type="button" disabled={busy} onClick={() => void desktop.chooseDirectory().then((value: string | null) => { if (value) addPath(value); }).catch((reason: unknown) => setError(String(reason)))}><FolderPlus size={20} /><b>文件夹</b><small>包含子目录中的资料</small></button>}</div>
      <input ref={files} type="file" multiple hidden onChange={event => { const selected = Array.from(event.target.files ?? []); setItems(current => [...current, ...selected.map(file => ({ id: crypto.randomUUID(), name: file.name, file }))]); event.target.value = ''; }} />
      <label className="materials-source">导入到数据源<select aria-label="导入到数据源" value={sourceId} disabled={busy || !sources.length} onChange={event => setSourceId(event.target.value)}>{!sources.length && <option value="">{sourceError ? '数据源读取失败' : '正在读取数据源…'}</option>}{sources.map(source => <option key={source.id} value={source.id}>{sourceLabel(source)}{source.id === mainSourceId ? ' · 主源' : ''}</option>)}</select></label>
      {sourceError && <p className="product-error" role="alert">{sourceError}</p>}
      {items.length > 0 ? <ul className="materials-list">{items.map(item => <li key={item.id}>{item.file ? <FileText size={18} /> : <Folder size={18} />}<span><b>{item.name}</b><small title={item.path}>{item.path || `${Math.ceil((item.file?.size ?? 0) / 1024)} KB`}</small></span><button type="button" disabled={busy} aria-label={`移除 ${item.name}`} onClick={() => setItems(current => current.filter(entry => entry.id !== item.id))}><X size={16} /></button></li>)}</ul> : !run && <p className="materials-empty">选择本地文件或文件夹开始添加。</p>}
      {busy && <p className="materials-progress" role="status">正在导入 · {active}</p>}
      {error && <p className="product-error" role="alert">{run?.product?.errorReason ?? error}</p>}
      {results.filter(result => result.run.id !== run?.id).map(result => <TaskProgressCard key={result.id} run={result.run} />)}
      {run && <><TaskProgressCard run={run} link={false} /><button type="button" className="pm-ghost" onClick={() => { taskLink(run); onClose(); }}>查看任务</button></>}
    </div>
    <footer><small>{busy ? '关闭面板后，导入继续在后台运行。' : '已导入的文件会跳过，更新过的文件会重新处理。'}</small>{busy && run ? <button type="button" onClick={() => void api.cancelRun(run.id).catch(reason => setError(String(reason)))}>停止</button> : <button type="button" className="materials-primary" disabled={busy || !items.length || !sourceId || Boolean(sourceError)} onClick={() => void start()}><Upload size={16} />导入{items.length > 0 ? ` ${items.length} 项` : ''}</button>}</footer>
  </dialog>;
}
