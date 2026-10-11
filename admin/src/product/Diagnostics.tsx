import React, { useState } from 'react';
import { desktopApi } from '../lib/product-fetch';
import { copyText } from '../lib/clipboard';
import { TaskTechnicalLogs } from './TaskTechnicalLogs';
import { useProductTasks } from './TaskActivity';
import { taskName } from '../../../shared/task-progress';
import { PRODUCT_VERSION } from './product-version';
import './tasks.css';

const RequestLog = React.lazy(() => import('../pages/RequestLog').then(module => ({ default: module.RequestLogPage })));

export function DiagnosticsPage() {
  const [tab, setTab] = useState('system');
  const [selected, setSelected] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const { rows, error } = useProductTasks();
  const desktop = desktopApi();
  const run = rows.find(row => row.id === selected) ?? rows[0];
  const action = async (operation: () => Promise<string>) => {
    setBusy(true); setMessage('');
    try { setMessage(await operation()); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  return <div className="diagnostics-page"><h1>诊断与日志</h1><p>排查连接、模型调用与后台任务问题。</p>
    <div className="diagnostic-tabs" role="tablist" aria-label="诊断分类">{[['system', '系统诊断'], ['requests', 'MCP 请求'], ['tasks', '后台任务日志']].map(([key, label]) => <button type="button" role="tab" aria-selected={tab === key} key={key} onClick={() => setTab(key)}>{label}</button>)}</div>
    {tab === 'system' && <section className="diagnostic-card"><h2>系统诊断</h2><p>PMBrain {PRODUCT_VERSION}</p><p>{desktop ? '打开日志目录查看应用与后台服务日志，或导出脱敏诊断包。' : '后台任务日志与 MCP 请求记录可在这里查看。应用与服务日志通过桌面端打开。'}</p><div className="diagnostic-actions">
      {desktop && <><button type="button" disabled={busy} onClick={() => void action(async () => { await desktop.openLogs(); return '已打开日志目录'; })}>打开日志目录</button><button type="button" disabled={busy} onClick={() => void action(async () => { const bundle = await desktop.exportDiagnosticBundle(); return bundle ? '诊断包已导出' : '已取消导出'; })}>导出诊断包</button></>}
      <button type="button" disabled={busy} onClick={() => void action(async () => { const state = desktop ? await desktop.getState() : null; await copyText(JSON.stringify({ version: PRODUCT_VERSION, service: state ? { phase: state.phase, message: state.message } : '浏览器连接', tasks: rows.map(row => ({ id: row.id, name: row.product?.name ?? taskName(row.kind), status: row.status, stage: row.product?.stage })), taskReadError: error || undefined }, null, 2)); return '诊断信息已复制'; })}>复制诊断信息</button>
    </div></section>}
    {tab === 'requests' && <React.Suspense fallback={<p role="status">正在读取请求记录…</p>}><RequestLog /></React.Suspense>}
    {tab === 'tasks' && <section className="diagnostic-card"><h2>后台任务技术日志</h2><p>原始执行记录仅用于排查问题。</p>{error && <p role="alert">{error}</p>}{rows.length ? <><select aria-label="选择任务日志" value={run?.id ?? ''} onChange={event => setSelected(event.target.value)}>{rows.map(row => <option key={row.id} value={row.id}>{row.product?.name ?? taskName(row.kind)} · {new Date(row.startedAt).toLocaleString()}</option>)}</select>{run && <TaskTechnicalLogs key={run.id} run={run} />}</> : <p>暂无任务日志</p>}</section>}
    {message && <p role="status">{message}</p>}
  </div>;
}
