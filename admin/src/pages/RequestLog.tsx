import React, { useState, useEffect } from 'react';
import { api } from '../api';

interface LogEntry {
  id: number;
  token_name: string;
  operation: string;
  latency_ms: number;
  status: string;
  created_at: string;
}

export function RequestLogPage() {
  const [data, setData] = useState<{ rows: LogEntry[]; total: number; page: number; pages: number }>({
    rows: [], total: 0, page: 1, pages: 1,
  });
  const [page, setPage] = useState(1);

  useEffect(() => { loadPage(page); }, [page]);

  const loadPage = (p: number) => {
    api.requests(p).then(setData).catch(() => {});
  };

  const timeAgo = (ts: string) => {
    const diff = Date.now() - new Date(ts).getTime();
    if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return new Date(ts).toLocaleDateString();
  };

  return (
    <>
      <h1 className="page-title">Request Log</h1>

      {data.rows.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)' }}>
          No requests yet.
        </div>
      ) : (
        <>
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Agent</th>
                <th>Operation</th>
                <th>Latency</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map(r => (
                <tr key={r.id}>
                  <td style={{ color: 'var(--text-secondary)' }}>{timeAgo(r.created_at)}</td>
                  <td className="mono">{r.token_name || 'unknown'}</td>
                  <td className="mono">{r.operation}</td>
                  <td className="mono">{r.latency_ms} ms</td>
                  <td><span className={`badge badge-${r.status}`}>{r.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="pagination">
            <span>Page {data.page} of {data.pages} ({data.total} total)</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button disabled={data.page <= 1} onClick={() => setPage(p => p - 1)}>Previous</button>
              <button disabled={data.page >= data.pages} onClick={() => setPage(p => p + 1)}>Next</button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
