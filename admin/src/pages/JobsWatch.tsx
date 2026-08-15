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
      <div style={{ padding: 24, color: 'var(--accent-danger, #f85149)' }}>
        <h2>Jobs Watch — error</h2>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{err}</pre>
      </div>
    );
  }

  if (!snap) {
    return <div style={{ padding: 24, color: 'var(--text-muted, #777)' }}>Loading jobs watch…</div>;
  }

  const ts = new Date(snap.ts_ms).toLocaleTimeString();

  return (
    <div style={{ padding: 24, fontFamily: 'var(--font-mono, "JetBrains Mono", monospace)' }}>
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>
        Jobs Watch
        <span style={{ marginLeft: 12, color: 'var(--text-muted, #777)', fontSize: 12, fontWeight: 'normal' }}>
          updated {ts}
        </span>
      </h1>

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 14, marginBottom: 8 }}>Queue</h2>
        <div>
          waiting=<b>{snap.queue_health.waiting}</b>{'  '}
          active=<b>{snap.queue_health.active}</b>{'  '}
          stalled=<b style={{ color: snap.queue_health.stalled > 0 ? 'var(--accent-warn, #d29922)' : undefined }}>
            {snap.queue_health.stalled}
          </b>
        </div>
      </section>

      {snap.by_type.length > 0 && (
        <section style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 14, marginBottom: 8 }}>By type (24h)</h2>
          <table style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: 'var(--text-muted, #777)', fontSize: 12 }}>
                <th style={{ textAlign: 'left', padding: '4px 12px 4px 0' }}>name</th>
                <th style={{ textAlign: 'right', padding: '4px 12px' }}>total</th>
                <th style={{ textAlign: 'right', padding: '4px 12px' }}>done</th>
                <th style={{ textAlign: 'right', padding: '4px 12px' }}>fail</th>
                <th style={{ textAlign: 'right', padding: '4px 12px' }}>dead</th>
              </tr>
            </thead>
            <tbody>
              {snap.by_type.slice(0, 6).map(t => (
                <tr key={t.name}>
                  <td style={{ padding: '4px 12px 4px 0' }}>{t.name}</td>
                  <td style={{ textAlign: 'right', padding: '4px 12px' }}>{t.total}</td>
                  <td style={{ textAlign: 'right', padding: '4px 12px' }}>{t.completed}</td>
                  <td style={{ textAlign: 'right', padding: '4px 12px' }}>{t.failed}</td>
                  <td style={{ textAlign: 'right', padding: '4px 12px' }}>{t.dead}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 14, marginBottom: 8 }}>Lease pressure (1h)</h2>
        <div style={{ color: leasePressureColor(snap.lease_pressure_1h) }}>
          {snap.lease_pressure_1h} bounce{snap.lease_pressure_1h === 1 ? '' : 's'}
        </div>
      </section>

      {snap.top_errors.length > 0 && (
        <section style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 14, marginBottom: 8 }}>Top errors (24h)</h2>
          <table style={{ borderCollapse: 'collapse' }}>
            <tbody>
              {snap.top_errors.slice(0, 5).map(e => (
                <tr key={e.cluster}>
                  <td style={{ textAlign: 'right', padding: '4px 12px 4px 0', color: 'var(--text-muted, #777)' }}>
                    {e.count}×
                  </td>
                  <td style={{ padding: '4px 12px 4px 0' }}>{e.cluster}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {snap.budget_owners.length > 0 && (
        <section style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 14, marginBottom: 8 }}>Budget owners</h2>
          <table style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: 'var(--text-muted, #777)', fontSize: 12 }}>
                <th style={{ textAlign: 'left', padding: '4px 12px 4px 0' }}>owner</th>
                <th style={{ textAlign: 'right', padding: '4px 12px' }}>spent</th>
                <th style={{ textAlign: 'right', padding: '4px 12px' }}>remaining</th>
              </tr>
            </thead>
            <tbody>
              {snap.budget_owners.slice(0, 5).map(b => (
                <tr key={b.owner_id}>
                  <td style={{ padding: '4px 12px 4px 0' }}>{b.owner_id}</td>
                  <td style={{ textAlign: 'right', padding: '4px 12px' }}>{dollars(b.total_spent_cents)}</td>
                  <td style={{ textAlign: 'right', padding: '4px 12px' }}>{dollars(b.remaining_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
