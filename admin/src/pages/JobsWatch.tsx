import React, { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * v0.41 D2 — live jobs dashboard. Browser counterpart to the TTY
 * `gbrain jobs watch` command. Polls `/admin/api/jobs/watch` every
 * 1s (matches TTY refresh cadence; SSE upgrade is a v0.42 follow-up
 * once the same wiring lands in serve-http for the TTY command).
 *
 * Layout intentionally matches the TTY 1:1 so an operator looking at
 * both surfaces sees the same panels in the same order.
 */

interface WatchSnapshot {
  ts_ms: number;
  by_type: Array<{ name: string; total: number; completed: number; failed: number; dead: number }>;
  queue_health: { waiting: number; active: number; stalled: number };
  lease_pressure_1h: number;
  top_errors: Array<{ cluster: string; count: number }>;
  budget_owners: Array<{ owner_id: number; remaining_cents: number; total_spent_cents: number }>;
}

function leasePressureColor(n: number): string {
  if (n === 0) return 'var(--accent-success, #2ea043)';
  if (n >= 100) return 'var(--accent-danger, #f85149)';
  return 'var(--accent-warn, #d29922)';
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function JobsWatchPage() {
  const [snap, setSnap] = useState<WatchSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const data = await api.jobsWatch();
        if (alive) {
          setSnap(data);
          setErr(null);
        }
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      }
      if (alive) timer = setTimeout(tick, 1000);
    };

    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (err) {
    return (
      <div className="pm-page jobs-page">
        <div className="pm-card pm-error jobs-state-card">
        <h2>任务监控：错误</h2>
        <pre>{err}</pre>
        </div>
      </div>
    );
  }

  if (!snap) {
    return <div className="pm-page jobs-page"><div className="pm-card pm-empty jobs-state-card">正在加载任务监控...</div></div>;
  }

  const ts = new Date(snap.ts_ms).toLocaleTimeString();

  return (
    <div className="pm-page jobs-page">
      <div className="pm-section-head">
        <div>
          <h1>任务监控</h1>
          <p className="pm-page-intro">
            用来观察 PMBrain 后台队列是否健康：导入、同步、向量化、自然语言执行等长任务都会进入这里。等待和活跃表示当前负载，停滞和退避用于发现任务卡住或数据库竞争。
          </p>
        </div>
        <span className="pm-pill">更新于 {ts}</span>
      </div>

      <div className="pm-grid three-col">
        <div className="pm-card">
          <h2>队列</h2>
          <div className="jobs-health-line">
          等待=<b>{snap.queue_health.waiting}</b>{'  '}
          活跃=<b>{snap.queue_health.active}</b>{'  '}
          停滞=<b style={{ color: snap.queue_health.stalled > 0 ? 'var(--accent-warn, #d29922)' : undefined }}>
            {snap.queue_health.stalled}
          </b>
          </div>
          <p className="pm-hint">正常情况下等待和停滞应接近 0。</p>
        </div>
        <div className="pm-card">
          <h2>租约压力（1 小时）</h2>
          <div className="jobs-big-number" style={{ color: leasePressureColor(snap.lease_pressure_1h) }}>
            {snap.lease_pressure_1h}
          </div>
          <p className="pm-hint">退避次数升高通常表示并发锁竞争或任务执行受阻。</p>
        </div>
        <div className="pm-card">
          <h2>主要用途</h2>
          <p className="jobs-desc">判断后台任务有没有堆积、卡死、失败，以及预算或外部模型调用是否出现异常。</p>
        </div>
      </div>

      {snap.by_type.length > 0 && (
        <section className="pm-card">
          <h2>按类型统计（24 小时）</h2>
          <table className="jobs-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>总数</th>
                <th>完成</th>
                <th>失败</th>
                <th>失效</th>
              </tr>
            </thead>
            <tbody>
              {snap.by_type.slice(0, 6).map(t => (
                <tr key={t.name}>
                  <td>{t.name}</td>
                  <td>{t.total}</td>
                  <td className="pm-ok">{t.completed}</td>
                  <td className={t.failed > 0 ? 'pm-warn' : ''}>{t.failed}</td>
                  <td className={t.dead > 0 ? 'pm-error-text' : ''}>{t.dead}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {snap.top_errors.length > 0 && (
        <section className="pm-card">
          <h2>主要错误（24 小时）</h2>
          <table className="jobs-table jobs-error-table">
            <tbody>
              {snap.top_errors.slice(0, 5).map(e => (
                <tr key={e.cluster}>
                  <td>
                    {e.count}×
                  </td>
                  <td>{e.cluster}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {snap.budget_owners.length > 0 && (
        <section className="pm-card">
          <h2>预算所有者</h2>
          <table className="jobs-table">
            <thead>
              <tr>
                <th>所有者</th>
                <th>已用</th>
                <th>剩余</th>
              </tr>
            </thead>
            <tbody>
              {snap.budget_owners.slice(0, 5).map(b => (
                <tr key={b.owner_id}>
                  <td>{b.owner_id}</td>
                  <td>{dollars(b.total_spent_cents)}</td>
                  <td>{dollars(b.remaining_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
