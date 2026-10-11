import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { LoaderCircle, X } from 'lucide-react';
import { productFetch } from '../lib/product-fetch';
import type { ConsoleRun } from '../lib/shared';
import { taskName } from '../../../shared/task-progress';
import { taskLink, taskStatus } from './TaskProgress';
import type { MaterialSubmission } from './material-list-progress';

const TasksContext = createContext<{ rows: ConsoleRun[]; error: string; loaded: boolean; imports: MaterialSubmission[]; setImports: React.Dispatch<React.SetStateAction<MaterialSubmission[]>> }>({ rows: [], error: '', loaded: false, imports: [], setImports: () => {} });
export const useProductTasks = () => useContext(TasksContext);

export function TaskActivityProvider({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  const [snapshot, setSnapshot] = useState<{ rows: ConsoleRun[]; error: string; loaded: boolean }>({ rows: [], error: '', loaded: false });
  const [notice, setNotice] = useState<ConsoleRun | null>(null);
  const [imports, setImports] = useState<MaterialSubmission[]>([]);
  const previous = useRef(new Map<string, string>());
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const response = await productFetch('/admin/api/runs?summary=1');
        if (!response.ok) throw new Error(`任务状态读取失败 (${response.status})`);
        const result = await response.json();
        const rows: ConsoleRun[] = Array.isArray(result) ? result : result.rows ?? [];
        if (!live) return;
        for (const run of rows) {
          const old = previous.current.get(run.id);
          if ((old === 'running' || old === 'queued') && !['running', 'queued'].includes(run.status)) setNotice(run);
        }
        previous.current = new Map(rows.map(run => [run.id, run.status]));
        setSnapshot({ rows, error: '', loaded: true });
        setImports(current => current.filter(item => !item.runId || !rows.some(run => run.id === item.runId)));
      } catch (reason) { if (live) setSnapshot(current => ({ ...current, error: String(reason), loaded: true })); }
      finally { if (live) timer = setTimeout(load, 1500); }
    };
    void load();
    return () => { live = false; clearTimeout(timer); };
  }, [enabled]);
  const running = snapshot.rows.find(run => run.status === 'running') ?? snapshot.rows.find(run => run.status === 'queued');
  return <TasksContext.Provider value={{ ...snapshot, imports, setImports }}>{children}
    {running && <button type="button" className="product-task-activity" onClick={() => taskLink(running)}><LoaderCircle size={15} /><span>{running.product?.name ?? taskName(running.kind)} · {running.product?.stage ?? '等待执行'}{running.product?.percent != null ? ` ${running.product.percent}%` : ''}</span></button>}
    {notice && <div className="product-task-notice" role="status"><button type="button" onClick={() => taskLink(notice)}>{notice.product?.name ?? taskName(notice.kind)} · {taskStatus(notice)}{notice.product?.metrics.filter(metric => metric.value > 0).slice(0, 2).map(metric => ` · ${metric.label} ${metric.value}`)}</button><button type="button" aria-label="关闭任务通知" onClick={() => setNotice(null)}><X size={16} /></button></div>}
  </TasksContext.Provider>;
}
