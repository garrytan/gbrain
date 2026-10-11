import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { RunOutput, type ConsoleRun } from '../lib/shared';

export function TaskTechnicalLogs({ run }: { run: ConsoleRun }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<ConsoleRun | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try { const next = await api.run(run.id); if (live) { setDetail(next); setError(''); } }
      catch (reason) { if (live) setError(String(reason)); }
      finally { if (live && ['running', 'queued'].includes(run.status)) timer = setTimeout(load, 1500); }
    };
    void load();
    return () => { live = false; clearTimeout(timer); };
  }, [open, run.id, run.status]);
  return <details className="task-technical-details" onToggle={event => setOpen(event.currentTarget.open)}><summary>技术日志</summary>{open && (error ? <p role="alert">{error}</p> : detail ? <RunOutput run={detail} /> : <p role="status">正在读取技术日志…</p>)}</details>;
}
