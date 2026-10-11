import React, { useEffect, useMemo, useState } from 'react';
import { Power, RefreshCw, ShieldAlert } from 'lucide-react';
import { api } from '../api';
import { formatDate, type ConsoleRun } from '../lib/shared';
import { TaskTechnicalLogs } from '../product/TaskTechnicalLogs';
import { describeRunRecovery } from '../lib/run-recovery';
import { useProductTasks } from '../product/TaskActivity';
import { TaskProgressCard, taskStatus, taskStopping } from '../product/TaskProgress';
import { taskName } from '../../../shared/task-progress';
import { taskRoundCompleted, taskRoundListSummary } from '../product/task-presentation';

type TaskFilter = 'all' | 'running' | 'queued' | 'completed' | 'failed' | 'cancelled';
const DreamRunContent=React.lazy(()=>import('./Dream').then(module=>({default:module.DreamRunContent})));

interface EmbeddingRebuildTask {
  status: 'paused' | 'running';
  model: string;
  dimensions: number;
  total: number;
  updated_at: string;
}

interface TaskCenterSnapshot {
  mode: 'pglite' | 'postgres';
  pglite_busy: boolean;
  pglite_owner?: PgliteOwnerStatus | null;
  embedding_rebuild?: EmbeddingRebuildTask | null;
  rows: ConsoleRun[];
  queue: {
    queue_health?: { waiting: number; active: number; stalled: number };
    ts_ms?: number;
  } | null;
  server_time: string;
}

interface PgliteOwnerStatus {
  state: 'clear' | 'current' | 'active' | 'stale' | 'unavailable';
  pid: number | null;
  ownerType: string | null;
  commandLabel: string | null;
  acquiredAt: string | null;
  canTerminate: boolean;
  message: string;
}

function taskTriggerLabel(run: ConsoleRun): string {
  return run.trigger === 'scheduled' ? '自动' : '手动';
}

function taskResult(run: ConsoleRun): string | null {
  const metrics = run.product?.metrics.filter(metric => metric.value > 0).slice(0, 3).map(metric => `${metric.label} ${metric.value}`).join(' · ');
  if (metrics) return metrics;
  if (!run.result || typeof run.result !== 'object') return null;
  const result = run.result as Record<string, unknown>;
  if (typeof result.imported === 'number') {
    return `导入 ${result.imported} · 跳过 ${result.skipped ?? 0} · 失败 ${result.errors ?? 0}${Number(result.resumedFiles) > 0 ? ` · 已恢复 ${result.resumedFiles}` : ''}`;
  }
  const phases = result.phases;
  if (Array.isArray(phases)) return `已处理 ${phases.filter(phase => phase.status === 'ok').length} 个阶段${phases.some(phase => phase.status === 'fail') ? ' · 有阶段未完成' : ''}`;
  if (typeof result.embedded === 'number') return `已向量化 ${result.embedded} 条`;
  if (Array.isArray(result.results)) return `已处理 ${result.results.length} 个知识源 · 失败 ${result.errors ?? 0}`;
  return null;
}

function statusLabel(run: ConsoleRun): string {
  return describeRunRecovery(run)?.badge
    ?? taskStatus(run);
}

function statusClass(status: ConsoleRun['status']): string {
  return `task-status task-status-${status}`;
}

function isActive(run: ConsoleRun): boolean {
  return run.status === 'queued' || run.status === 'running';
}

function preferLiveRun(saved: ConsoleRun, live: ConsoleRun | undefined): ConsoleRun {
  if (!live) return saved;
  const moving = ['running', 'queued'].includes(live.status) || ['running', 'queued'].includes(saved.status);
  if (!moving) return saved;
  return { ...saved, status: live.status, error: live.error, product: live.product ?? saved.product, completedAt: live.completedAt, durationMs: live.durationMs, result: live.result ?? saved.result };
}

function isToday(value: string | null): boolean {
  if (!value) return false;
  const date = new Date(value);
  const now = new Date();
  return date.toDateString() === now.toDateString();
}

function PgliteRecoveryCard({
  owner,
  onTerminate,
  terminating,
}: {
  owner: PgliteOwnerStatus;
  onTerminate: () => void;
  terminating: boolean;
}) {
  const active = owner.state === 'active';
  const title = active ? '发现残留 PGLite 占用进程' : owner.state === 'stale' ? '发现已退出的 PGLite 残留锁' : 'PGLite 连接需要人工确认';
  const stateLabel = active ? '需要恢复' : owner.state === 'stale' ? '可自动清理' : '无法确认';
  return (
    <section className="task-recovery-section">
      <div className="task-section-head">
        <div><span className="pm-eyebrow"><ShieldAlert aria-hidden="true" /> DATABASE RECOVERY</span><h2>PGLite 连接恢复</h2></div>
        <span className="task-status task-status-failed">{stateLabel}</span>
      </div>
      <article className="task-recovery-card">
        <div className="task-recovery-card-head">
          <div><h3>{title}</h3><p>{owner.message}</p></div>
          {owner.pid && <span className="task-recovery-pid">PID {owner.pid}</span>}
        </div>
        <div className="task-recovery-meta">
          <span>进程来源：{owner.commandLabel ?? owner.ownerType ?? '未知'}</span>
          {owner.acquiredAt && <span>占用开始：{formatDate(owner.acquiredAt, '-')}</span>}
        </div>
        {active && owner.canTerminate && owner.pid && (
          <div className="task-run-card-actions">
            <button type="button" className="pm-ghost danger" onClick={onTerminate} disabled={terminating}>
              <Power aria-hidden="true" /> {terminating ? '正在结束…' : '结束占用进程'}
            </button>
            <span className="pm-hint">只结束该 PMBrain 进程树，不删除数据库。</span>
          </div>
        )}
        {active && !owner.canTerminate && <p className="task-recovery-hint">当前无法安全结束这个进程，请先确认它不是正在运行的其他 PMBrain 实例。</p>}
        {owner.state === 'stale' && <p className="task-recovery-hint">进程已经停止，刷新或重新启动服务即可让 PGLite 自动归档残留锁。</p>}
      </article>
    </section>
  );
}

function TaskDetailDrawer({ run, onClose, onCancel, onRetry, busy }: { run: ConsoleRun; onClose: () => void; onCancel: () => void; onRetry: () => void; busy: boolean }) {
  const dream=run.kind.startsWith('dream_');
  const [detail,setDetail]=useState<ConsoleRun|null>(null);
  const [detailError,setDetailError]=useState('');
  useEffect(()=>{
    if(!dream)return;
    let live=true;
    let timer:ReturnType<typeof setTimeout>;
    const load=async()=>{
      try{const next=await api.run(run.id);if(live){setDetail(next);setDetailError('');}}
      catch(error){if(live)setDetailError(error instanceof Error?error.message:String(error));}
      finally{if(live&&isActive(run))timer=setTimeout(load,1500);}
    };
    setDetail(null);setDetailError('');void load();
    return()=>{live=false;clearTimeout(timer);};
  },[dream,run.id,run.status]);
  const current=dream&&detail?.id===run.id?preferLiveRun(detail,run):run;
  return <><div className="drawer-overlay" onClick={onClose} /><aside className="drawer task-detail-drawer" aria-label="任务详情">
    <button type="button" className="drawer-close" aria-label="关闭任务详情" onClick={onClose}>×</button>
    <h2>{run.product?.name ?? taskName(run.kind)}</h2><p className="pm-hint">{formatDate(run.startedAt, '-')} · {taskTriggerLabel(run)}</p>
    <TaskProgressCard run={current} link={false} />
    {dream&&(detailError?<p role="alert">{detailError}</p>:detail?<React.Suspense fallback={<p role="status">正在读取整理内容…</p>}><DreamRunContent run={current} expanded /></React.Suspense>:<p role="status">正在读取整理内容…</p>)}
    <div className="task-run-card-actions">{isActive(run) && <button type="button" className="pm-ghost" disabled={busy || taskStopping(run)} onClick={onCancel}>{taskStopping(run) ? '正在停止…' : '停止任务'}</button>}{['failed', 'cancelled'].includes(run.status) && run.id.startsWith('task-') && <button type="button" className="pm-ghost" disabled={busy} onClick={onRetry}>重新执行</button>}</div>
    <TaskTechnicalLogs key={run.id} run={run} />
  </aside></>;
}

export function TaskCenterPage() {
  const liveTasks = useProductTasks();
  const [snapshot, setSnapshot] = useState<TaskCenterSnapshot | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<TaskFilter>('all');
  const [selectedRun, setSelectedRun] = useState<ConsoleRun | null>(null);
  const [cancelling, setCancelling] = useState('');
  const [retrying, setRetrying] = useState('');
  const [terminatingOwner, setTerminatingOwner] = useState<number | null>(null);
  const [resumingRebuild, setResumingRebuild] = useState(false);

  const load = async () => {
    try {
      setSnapshot(await api.taskCenter(true) as TaskCenterSnapshot);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { await load(); if (live) timer = setTimeout(poll, 1500); };
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, []);

  const rows = useMemo(() => {
    if (!snapshot) return liveTasks.rows;
    const liveById = new Map(liveTasks.rows.map(run => [run.id, run]));
    const seen = new Set(snapshot.rows.map(run => run.id));
    return [...snapshot.rows.map(run => preferLiveRun(run, liveById.get(run.id))), ...liveTasks.rows.filter(run => !seen.has(run.id))];
  }, [liveTasks.rows, snapshot]);

  useEffect(() => {
    const target = new URLSearchParams(window.location.hash.split('?')[1]).get('run') ?? selectedRun?.id;
    if (!target) return;
    const latest = rows.find(run => run.id === target);
    if (latest) setSelectedRun(latest);
  }, [rows, selectedRun?.id]);
  const activeRows = rows.filter(isActive);
  const waitingRows = rows.filter(run => run.status === 'queued');
  const failedRows = rows.filter(run => run.status === 'failed');
  const completedToday = rows.filter(run => run.status === 'completed' && isToday(run.completedAt)).length;
  const historyRows = useMemo(() => rows
    .filter(run => filter === 'all' || run.status === filter)
    .slice(0, 100), [filter, rows]);

  const cancel = async (run: ConsoleRun) => {
    if (!window.confirm(run.status === 'queued'
      ? '取消等待后，本次任务不会再启动。确定取消吗？'
      : '取消任务不会删除已经完成的成果，下次可以从未完成部分继续。确定取消吗？')) return;
    setCancelling(run.id);
    try {
      await api.cancelRun(run.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelling('');
    }
  };

  const resumeEmbeddingRebuild = async () => {
    setResumingRebuild(true);
    setError('');
    try {
      await api.startActionRun('embed_stale', { catchUp: true, forceReembed: true });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResumingRebuild(false);
    }
  };

  const retry = async (run: ConsoleRun) => {
    if (!window.confirm('将重新执行任务；导入会跳过已确认完成且未改变的文件。中断的模型请求可能已产生费用，重新执行可能再次计费。继续吗？')) return;
    setRetrying(run.id);
    try {
      await api.retryRun(run.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying('');
    }
  };

  const terminateOwner = async () => {
    const owner = snapshot?.pglite_owner;
    if (!owner?.canTerminate || !owner.pid) return;
    if (!window.confirm(
      `这会结束 PID ${owner.pid} 的 PMBrain 占用进程树，但不会删除数据库、锁文件或知识数据。仅在确认它是中止任务留下的残留进程时继续。确定结束吗？`,
    )) return;
    setTerminatingOwner(owner.pid);
    setError('');
    try {
      await api.terminatePgliteOwner(owner.pid);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTerminatingOwner(null);
    }
  };

  if ((error || liveTasks.error) && !snapshot && rows.length === 0 && (liveTasks.loaded || error)) {
    return <div className="pm-page task-center-page"><div className="pm-card pm-error task-state-card"><h2>任务中心暂时不可用</h2><p>{error || liveTasks.error}</p><button type="button" className="pm-ghost" onClick={() => void load()}><RefreshCw aria-hidden="true" /> 重试</button></div></div>;
  }

  if (!snapshot && rows.length === 0 && !liveTasks.loaded) {
    return <div className="pm-page task-center-page"><div className="pm-card pm-empty task-state-card">正在读取后台任务…</div></div>;
  }

  return (
    <div className="pm-page task-center-page">
      <div className="pm-section-head">
        <div>
          <h1>任务中心</h1>
          <p className="pm-page-intro">导入与整理在后台完成。在这里查看结果，或处理未完成的任务。</p>
        </div>
        <button type="button" className="pm-ghost" onClick={() => void load()}><RefreshCw aria-hidden="true" /> 刷新状态</button>
      </div>

      {snapshot?.pglite_busy && (
        <div className="task-busy-banner">
          <div><b>数据库正在维护</b><span>维护结束后恢复访问；普通导入与整理不占用整个软件。</span></div>
          <span className="task-busy-dot">运行中</span>
        </div>
      )}

      {error && <div className="pm-error task-inline-error">{error}</div>}

      {activeRows.length === 0 && snapshot?.pglite_owner && snapshot.pglite_owner.state !== 'clear' && snapshot.pglite_owner.state !== 'current' && (
        <PgliteRecoveryCard
          owner={snapshot.pglite_owner}
          onTerminate={() => void terminateOwner()}
          terminating={terminatingOwner === snapshot.pglite_owner.pid}
        />
      )}

      <div className="task-status-grid">
        <div className="task-status-card task-status-card-running"><span>运行中</span><strong>{activeRows.filter(run => run.status === 'running').length}</strong><small>后台正在执行</small></div>
        <div className="task-status-card task-status-card-waiting"><span>等待中</span><strong>{waitingRows.length}</strong><small>等待资源空闲</small></div>
        <div className="task-status-card task-status-card-failed"><span>失败</span><strong>{failedRows.length}</strong><small>需要查看错误</small></div>
        <div className="task-status-card task-status-card-completed"><span>今日完成</span><strong>{completedToday}</strong><small>已保存的任务结果</small></div>
      </div>

      {snapshot?.embedding_rebuild?.status === 'paused' && (
        <section className="task-section">
          <div className="task-section-head">
            <div><span className="pm-eyebrow">PAUSED INDEX</span><h2>重建向量索引</h2></div>
            <span className="task-status task-status-queued">已暂停</span>
          </div>
          <article className="task-run-card">
            <div className="task-run-card-head">
              <div>
                <h3>新模型已生效，向量索引待重建</h3>
                <p>
                  {snapshot?.embedding_rebuild?.model}
                  {(snapshot?.embedding_rebuild?.total ?? 0) > 0 ? ` · 待重建 ${snapshot?.embedding_rebuild?.total} 条` : ''}
                  。未完成的条目暂时不能语义搜索，可随时继续。
                </p>
              </div>
            </div>
            <div className="task-run-card-actions">
              <button type="button" className="pm-primary" onClick={() => void resumeEmbeddingRebuild()} disabled={resumingRebuild}>
                {resumingRebuild ? '正在继续…' : '继续重建'}
              </button>
            </div>
          </article>
        </section>
      )}

      <section className="task-section">
        <div className="task-section-head"><h2>后台任务</h2><div className="task-filter-bar" role="tablist" aria-label="任务筛选">
          {([['all', '全部'], ['running', '执行中'], ['queued', '排队中'], ['completed', '已完成'], ['failed', '失败'], ['cancelled', '已停止']] as Array<[TaskFilter, string]>).map(([value, label]) => <button role="tab" aria-selected={filter === value} key={value} type="button" className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}
        </div></div>
        <div className="task-table-wrap"><table className="task-table"><thead><tr><th>任务</th><th>状态</th><th>进度</th><th>结果 / 当前阶段</th><th>操作</th></tr></thead><tbody>{historyRows.map(run => <tr key={run.id}>
          <td><button type="button" onClick={() => { setSelectedRun(run); window.history.replaceState(null, '', `#tasks?run=${encodeURIComponent(run.id)}`); }}>{run.product?.name ?? taskName(run.kind)}</button><small>{run.product?.file ?? formatDate(run.startedAt, '-')}</small></td>
          <td><span className={statusClass(run.status)}>{statusLabel(run)}</span></td>
          <td>{taskRoundCompleted(run)?'—':run.product?.percent != null ? `${run.product.percent}%` : isActive(run) ? '进行中' : '—'}{!taskRoundCompleted(run)&&run.product?.percent != null && <div className="product-task-bar"><i style={{ width: `${run.product.percent}%` }} /></div>}</td>
          <td>{taskRoundCompleted(run)?taskRoundListSummary(run):run.product?.errorReason ?? (isActive(run) ? run.product?.stage ?? '等待执行' : taskResult(run) ?? run.product?.stage ?? statusLabel(run))}</td>
          <td><div className="task-table-actions"><button type="button" className="pm-ghost" onClick={() => { setSelectedRun(run); window.history.replaceState(null, '', `#tasks?run=${encodeURIComponent(run.id)}`); }}>查看详情</button>{isActive(run) && <button type="button" className="pm-ghost" disabled={cancelling === run.id} onClick={() => void cancel(run)}>停止</button>}{['failed', 'cancelled'].includes(run.status) && run.id.startsWith('task-') && <button type="button" className="pm-ghost" disabled={retrying === run.id} onClick={() => void retry(run)}>重试</button>}</div></td>
        </tr>)}</tbody></table>{historyRows.length === 0 && <div className="task-empty">暂无任务记录</div>}</div>
        <p className="task-retention-note">关闭页面不影响后台任务。最近的结果已保存，重启后仍可查看。</p>
      </section>

      {selectedRun && <TaskDetailDrawer run={selectedRun} onClose={() => { setSelectedRun(null); window.history.replaceState(null, '', '#tasks'); }} onCancel={() => void cancel(selectedRun)} onRetry={() => void retry(selectedRun)} busy={cancelling === selectedRun.id || retrying === selectedRun.id} />}
    </div>
  );
}
