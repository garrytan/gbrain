import React, { useState, useEffect } from 'react';
import { api } from '../api';

interface SourceRow {
  source_id: string;
  name: string;
  local_path: string | null;
  sync_enabled: boolean;
  last_sync_at: string | null;
  staleness_hours: number | null;
  staleness_class: 'fresh' | 'stale' | 'severe' | 'unknown';
  last_commit: string | null;
  pages: number;
  chunks_total: number;
  chunks_unembedded: number;
  embedding_coverage_pct: number;
}

interface FederatedClient {
  client_id: string;
  client_name: string;
  source_id: string | null;
  federated_read: string[];
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 0) return 'in the future?';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function stalenessColor(cls: string): string {
  switch (cls) {
    case 'fresh': return '#4ade80';
    case 'stale': return '#fbbf24';
    case 'severe': return '#ef4444';
    default: return 'var(--text-muted)';
  }
}

function coverageColor(pct: number): string {
  if (pct >= 99) return '#4ade80';
  if (pct >= 90) return '#fbbf24';
  return '#ef4444';
}

export function SourcesPage() {
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [clients, setClients] = useState<FederatedClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [srcReport, clientsResp] = await Promise.all([
        api.sources(),
        api.agentsFederatedRead(),
      ]);
      setSources(srcReport.sources || []);
      setClients(clientsResp.clients || []);
    } catch (e: any) {
      setError(e.message || 'load failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // Reverse-lookup: for each source, which clients can read it?
  const readersBySource = (sourceId: string): string[] =>
    clients.filter((c) => c.federated_read.includes(sourceId)).map((c) => c.client_name);

  // Reverse-lookup: which clients WRITE to this source (source_id == sourceId)?
  const writersBySource = (sourceId: string): string[] =>
    clients.filter((c) => c.source_id === sourceId).map((c) => c.client_name);

  return (
    <div style={{ padding: 24, maxWidth: 1200 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, margin: 0 }}>Sources</h1>
        <button
          onClick={load}
          style={{
            background: 'transparent',
            border: '1px solid var(--border)',
            color: 'var(--text-secondary)',
            padding: '6px 12px',
            borderRadius: 6,
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          Refresh
        </button>
      </div>

      {loading && <div style={{ color: 'var(--text-muted)' }}>Loading…</div>}
      {error && (
        <div style={{
          background: 'rgba(239,68,68,0.08)',
          border: '1px solid rgba(239,68,68,0.3)',
          color: '#ef4444',
          padding: 12,
          borderRadius: 6,
          marginBottom: 16,
          fontSize: 13,
        }}>
          Failed to load sources: {error}
        </div>
      )}

      {!loading && !error && sources.length === 0 && (
        <div style={{ color: 'var(--text-muted)', padding: 16 }}>
          No active sources with a local_path. Use{' '}
          <code style={{ background: 'var(--bg-elevated)', padding: '2px 6px', borderRadius: 4 }}>
            gbrain sources add &lt;id&gt; --path &lt;dir&gt;
          </code>{' '}
          to register one.
        </div>
      )}

      {!loading && !error && sources.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left', color: 'var(--text-muted)' }}>
                <th style={{ padding: '10px 12px' }}>ID</th>
                <th style={{ padding: '10px 12px', textAlign: 'right' }}>Pages</th>
                <th style={{ padding: '10px 12px', textAlign: 'right' }}>Chunks</th>
                <th style={{ padding: '10px 12px', textAlign: 'right' }}>Embed%</th>
                <th style={{ padding: '10px 12px' }}>Last Sync</th>
                <th style={{ padding: '10px 12px' }}>Writers</th>
                <th style={{ padding: '10px 12px' }}>Readers (federated)</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => {
                const readers = readersBySource(s.source_id);
                const writers = writersBySource(s.source_id);
                return (
                  <tr key={s.source_id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '10px 12px', fontFamily: 'JetBrains Mono, monospace' }}>
                      <div>{s.source_id}</div>
                      {s.name !== s.source_id && (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'inherit' }}>{s.name}</div>
                      )}
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'JetBrains Mono, monospace' }}>{s.pages.toLocaleString()}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'JetBrains Mono, monospace' }}>{s.chunks_total.toLocaleString()}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: coverageColor(s.embedding_coverage_pct), fontFamily: 'JetBrains Mono, monospace' }}>
                      {s.embedding_coverage_pct.toFixed(0)}%
                    </td>
                    <td style={{ padding: '10px 12px', color: s.local_path == null ? 'var(--text-muted)' : stalenessColor(s.staleness_class) }}>
                      {s.local_path == null ? 'push-only' : timeAgo(s.last_sync_at)}
                    </td>
                    <td style={{ padding: '10px 12px', fontSize: 12, color: 'var(--text-secondary)' }}>
                      {writers.length === 0 ? <span style={{ color: 'var(--text-muted)' }}>none</span> : writers.join(', ')}
                    </td>
                    <td style={{ padding: '10px 12px', fontSize: 12, color: 'var(--text-secondary)' }}>
                      {readers.length === 0 ? <span style={{ color: 'var(--text-muted)' }}>none</span> : readers.join(', ')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div style={{
        marginTop: 24,
        padding: 12,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        fontSize: 12,
        color: 'var(--text-muted)',
        lineHeight: 1.6,
      }}>
        <strong style={{ color: 'var(--text-secondary)' }}>Two scopes per OAuth client:</strong>{' '}
        <em>Writers</em> = clients with this source as their <code>source_id</code> (write authority).{' '}
        <em>Readers</em> = clients with this source in their <code>federated_read</code> list (read access via federation).
        Manage federation per-client from the <a href="#agents" style={{ color: '#60a5fa' }}>Agents</a> tab using the
        "Manage reads" action.
      </div>
    </div>
  );
}
