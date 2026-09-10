import React, { useState, useEffect } from 'react';
import { api } from '../api';
import { ClientGrantEditor, GrantFields, GrantPreview, HarnessGuides, grantDraft, grantRequest, reviewedGrantRequest, type GrantCatalog, type GrantPreviewResult } from '../components/ClientGrant';

function timeAgo(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

interface Agent {
  id: string;
  name: string;
  auth_type: 'oauth' | 'api_key';
  client_id?: string;  // compat
  client_name?: string; // compat
  grant_types: string[];
  scope: string;
  source_id: string | null;
  federated_read: string[];
  created_at: string;
  last_used_at: string | null;
  total_requests: number;
  requests_today: number;
  token_ttl: number | null;
  status: 'active' | 'revoked';
}

interface Source {
  id: string;
  name: string;
  federated: boolean;
}

interface ApiKey {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  status: 'active' | 'revoked';
}

interface ClientCredentials {
  clientId: string;
  clientSecret: string;
  name: string;
  credentials?: Record<string, unknown>;
}

export function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [hideRevoked, setHideRevoked] = useState(true);
  const [showRegister, setShowRegister] = useState(false);
  const [showCredentials, setShowCredentials] = useState<ClientCredentials | null>(null);
  const [showApiKeyCreate, setShowApiKeyCreate] = useState(false);
  const [showApiKeyToken, setShowApiKeyToken] = useState<{ name: string; token: string } | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);

  useEffect(() => {
    loadAgents();
    api.sources().then(setSources).catch(() => {});
  }, []);

  const loadAgents = () => { api.agents().then(setAgents).catch(() => {}); };

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 className="page-title" style={{ marginBottom: 0 }}>Agents</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={hideRevoked} onChange={e => setHideRevoked(e.target.checked)} /> Hide revoked
          </label>
          <button className="btn btn-secondary" onClick={() => setShowApiKeyCreate(true)}>+ API Key</button>
          <button className="btn btn-primary" onClick={() => setShowRegister(true)}>+ OAuth Client</button>
        </div>
      </div>

      {(() => {
        // Filter once and reuse, so the empty-state guard sees the same
        // rows the table renders. Pre-fix: agents.length === 0 used the
        // unfiltered array, so an all-revoked dataset with hideRevoked=on
        // showed a header-only table with no placeholder.
        const visibleAgents = agents.filter(a => !hideRevoked || a.status !== 'revoked');
        if (agents.length === 0) {
          return (
            <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)' }}>
              No agents registered. Register your first agent to get started.
            </div>
          );
        }
        if (visibleAgents.length === 0) {
          return (
            <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)' }}>
              All agents are revoked. Uncheck "Hide revoked" to view them.
            </div>
          );
        }
        return (
        <>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Scopes</th>
                <th>Sources</th>
                <th>Status</th>
                <th>Requests</th>
                <th>Last Used</th>
              </tr>
            </thead>
            <tbody>
              {visibleAgents.map(a => (
                <tr key={a.id} onClick={() => setSelectedAgent(a)}
                    style={{ cursor: 'pointer' }}>
                  <td style={{ fontWeight: 500 }}>{a.name || a.client_name}</td>
                  <td>
                    <span className={`badge ${a.auth_type === 'oauth' ? 'badge-read' : 'badge-write'}`} style={{ fontSize: 11 }}>
                      {a.auth_type === 'oauth' ? 'OAuth' : 'API Key'}
                    </span>
                  </td>
                  <td>
                    {(a.scope || '').split(' ').filter(Boolean).map(s => (
                      <span key={s} className={`badge badge-${s}`} style={{ marginRight: 4 }}>{s}</span>
                    ))}
                  </td>
                  <td style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
                    {a.auth_type === 'oauth'
                      ? `${a.source_id || 'none'} · ${(a.federated_read || []).length} readable`
                      : 'Unscoped'}
                  </td>
                  <td>
                    <span className={`badge ${a.status === 'active' ? 'badge-success' : 'badge-danger'}`}>{a.status}</span>
                  </td>
                  <td>
                    <span style={{ fontWeight: 500 }}>{a.requests_today || 0}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: 12 }}> / {a.total_requests || 0}</span>
                  </td>
                  <td style={{ color: 'var(--text-secondary)' }}>
                    {a.last_used_at ? timeAgo(new Date(a.last_used_at)) : 'Never'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 12 }}>
            {agents.filter(a => a.status === 'active').length} active / {agents.length} total
          </div>
        </>
        );
      })()}

      {showRegister && (
        <RegisterModal
          sources={sources}
          onClose={() => setShowRegister(false)}
          onRegistered={(creds) => { setShowRegister(false); setShowCredentials(creds); loadAgents(); }}
        />
      )}

      {showCredentials && (
        <CredentialsModal
          credentials={showCredentials}
          onClose={() => setShowCredentials(null)}
        />
      )}

      {selectedAgent && (
        <AgentDrawer
          key={selectedAgent.id}
          agent={selectedAgent}
          sources={sources}
          onClose={() => setSelectedAgent(null)}
          onRevoked={loadAgents}
          onRecovered={(credentials) => { setSelectedAgent(null); setShowCredentials(credentials); }}
          onRescoped={({ sourceId, federatedRead }) => {
            setSelectedAgent(current => current ? {
              ...current,
              source_id: sourceId,
              federated_read: federatedRead,
            } : current);
            loadAgents();
          }}
        />
      )}

      {showApiKeyCreate && (
        <ApiKeyCreateModal
          onClose={() => setShowApiKeyCreate(false)}
          onCreated={(result) => { setShowApiKeyCreate(false); setShowApiKeyToken(result); loadAgents(); }}
        />
      )}

      {showApiKeyToken && (
        <ApiKeyTokenModal token={showApiKeyToken} onClose={() => setShowApiKeyToken(null)} />
      )}
    </>
  );
}

function ApiKeyCreateModal({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: (result: { name: string; token: string }) => void;
}) {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError('Name required'); return; }
    setLoading(true);
    try {
      const data = await api.createApiKey(name.trim());
      onCreated({ name: data.name, token: data.token });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally { setLoading(false); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal" onClick={e => e.stopPropagation()} onSubmit={handleSubmit}>
        <div className="modal-title">Create API Key</div>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>
          API keys use simple bearer token auth. They grant full read+write+admin access.
          For scoped access, use OAuth clients instead.
        </p>
        <div style={{ marginBottom: 16 }}>
          <label>Key Name</label>
          <input placeholder="e.g. claude-code-local" value={name} onChange={e => setName(e.target.value)} autoFocus />
        </div>
        {error && <div style={{ color: 'var(--error)', fontSize: 13, marginBottom: 12 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Creating...' : 'Create Key'}
          </button>
        </div>
      </form>
    </div>
  );
}

function ApiKeyTokenModal({ token, onClose }: {
  token: { name: string; token: string };
  onClose: () => void;
}) {
  const copy = (text: string) => navigator.clipboard.writeText(text);

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 560 }}>
        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 36, color: 'var(--success)', marginBottom: 8 }}>&#10003;</div>
          <div style={{ fontSize: 20, fontWeight: 600 }}>API Key Created</div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12 }}>Name</label>
          <div className="code-block"><span>{token.name}</span></div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12 }}>Bearer Token</label>
          <div className="code-block">
            <span>{token.token}</span>
            <button className="copy-btn" onClick={() => copy(token.token)}>Copy</button>
          </div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12 }}>Usage</label>
          <div className="code-block">
            <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 12 }}>{`Authorization: Bearer ${token.token}`}</pre>
            <button className="copy-btn" onClick={() => copy(`Authorization: Bearer ${token.token}`)}>Copy</button>
          </div>
        </div>
        <div className="warning-bar">Save this token now. It will not be shown again.</div>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 20 }}>
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

function RegisterModal({ sources, onClose, onRegistered }: {
  sources: Source[];
  onClose: () => void;
  onRegistered: (creds: ClientCredentials) => void;
}) {
  const [name, setName] = useState('');
  const [draft, setDraft] = useState(() => grantDraft());
  const [catalog, setCatalog] = useState<GrantCatalog>();
  const [preview, setPreview] = useState<GrantPreviewResult>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [recovery, setRecovery] = useState<{ clientId: string; name: string }>();
  useEffect(() => { void api.grantCatalog().then(setCatalog).catch(e => setError(e.message)); }, []);
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError('Name required'); return; }
    setLoading(true); setError('');
    try {
      const result = await api.registerClient({ ...(preview ? reviewedGrantRequest(preview.after) : grantRequest(draft)), name: name.trim(), dryRun: !preview });
      if (!preview) setPreview(result);
      else onRegistered({ clientId: result.clientId, clientSecret: result.clientSecret, name: name.trim(), credentials: result.credentials });
    } catch (err) {
      setPreview(undefined);
      setError(err instanceof Error ? err.message : 'Registration failed');
      if (preview) {
        // A lost response may follow a committed registration. Reconcile by
        // the submitted name before offering a distinct credential recovery.
        try {
          const existing = (await api.agents() as Agent[]).filter(agent => agent.auth_type === 'oauth' && agent.status === 'active' && (agent.name || agent.client_name) === name.trim());
          if (existing.length === 1) setRecovery({ clientId: existing[0].id || existing[0].client_id!, name: name.trim() });
        } catch { /* Retain the registration error; the Agents list also offers recovery. */ }
      }
    }
    finally { setLoading(false); }
  };
  const recover = async () => {
    if (!recovery) return;
    setLoading(true); setError('');
    try { onRegistered(await api.recoverClient(recovery.clientId)); }
    catch (err) { setError(err instanceof Error ? err.message : 'Credential recovery failed'); }
    finally { setLoading(false); }
  };
  return <div className="modal-overlay" onClick={onClose}>
    <form className="modal" style={{ maxWidth: 700, width: '90vw', minWidth: 0, maxHeight: '90vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()} onSubmit={handleSubmit}>
      <div className="modal-title">Register agent</div>
      <fieldset disabled={loading || !!recovery} style={{ border: 0, padding: 0, margin: 0 }}>
        <div style={{ marginBottom: 16 }}><label htmlFor="agent-name">Agent name</label><input id="agent-name" placeholder="muse-personal-example" value={name} onChange={e => { setName(e.target.value); setPreview(undefined); }} autoFocus /></div>
        {catalog && <GrantFields draft={draft} setDraft={next => { setDraft(next); setPreview(undefined); }} catalog={catalog} sources={sources} />}
      </fieldset>
      {preview && <GrantPreview preview={preview} />}
      {error && <p role="alert" style={{ color: 'var(--error)' }}>{error}</p>}
      {recovery && <div role="status">
        <p>A registered client named {recovery.name} exists. Recover its saved credential delivery before retrying registration. This preserves its permissions and secret.</p>
        <button type="button" className="btn btn-secondary" disabled={loading} onClick={() => void recover()}>Recover credentials</button>
      </div>}
      <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={loading || !catalog || !!recovery}>{loading ? 'Checking…' : preview ? 'Register with reviewed permissions' : 'Preview permissions'}</button>
      </div>
    </form>
  </div>;
}

function CredentialsModal({ credentials, onClose }: {
  credentials: ClientCredentials;
  onClose: () => void;
}) {
  const copy = (text: string) => navigator.clipboard.writeText(text);
  const downloadJson = () => {
    const handoff = credentials.credentials ?? { version: 1, mcp_url: `${window.location.origin}/mcp`, issuer_url: window.location.origin, client_id: credentials.clientId, client_secret: credentials.clientSecret };
    const blob = new Blob([JSON.stringify(handoff, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${credentials.name}-credentials.json`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 560 }}>
        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 36, color: 'var(--success)', marginBottom: 8 }}>&#10003;</div>
          <div style={{ fontSize: 20, fontWeight: 600 }}>Agent Registered</div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12 }}>Client ID</label>
          <div className="code-block">
            <span>{credentials.clientId}</span>
            <button className="copy-btn" onClick={() => copy(credentials.clientId)}>Copy</button>
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12 }}>Client Secret</label>
          <div className="code-block">
            <span>{credentials.clientSecret}</span>
            <button className="copy-btn" onClick={() => copy(credentials.clientSecret)}>Copy</button>
          </div>
        </div>

        <div className="warning-bar">
          Download the credential file now. Keep it private, set its permissions to 0600 on the target computer, and use it with gbrain connect. If delivery is lost, use Recover credentials in this client's Agents entry.
        </div>

        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 20 }}>
          <button className="btn btn-secondary" onClick={downloadJson}>Download as JSON</button>
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}


function AgentDrawer({ agent, sources, onClose, onRevoked, onRescoped, onRecovered }: {
  agent: Agent;
  sources: Source[];
  onClose: () => void;
  onRevoked: () => void;
  onRecovered: (credentials: ClientCredentials) => void;
  onRescoped: (scope: { sourceId: string; federatedRead: string[] }) => void;
}) {
  const serverUrl = window.location.origin;

  const cid = agent.id || agent.client_id || '';
  const isOAuth = agent.auth_type === 'oauth';
  const [recovering, setRecovering] = useState(false);
  const [recoveryError, setRecoveryError] = useState('');
  const recoverCredentials = async () => {
    setRecovering(true); setRecoveryError('');
    try { onRecovered(await api.recoverClient(cid)); }
    catch (error) { setRecoveryError(error instanceof Error ? error.message : 'Credential recovery failed'); }
    finally { setRecovering(false); }
  };

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <div className="drawer">
        <button className="drawer-close" onClick={onClose}>&#10005;</button>
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>{agent.name || agent.client_name}</div>
        <span className={`badge ${agent.status === 'active' ? 'badge-success' : 'badge-danger'}`}>{agent.status}</span>

        <div className="section-title">Details</div>
        <div style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: '6px 12px', fontSize: 13 }}>
          <span style={{ color: 'var(--text-secondary)' }}>Client ID</span>
          <span className="mono">{(agent.id || agent.id || agent.client_id || '').substring(0, 24)}...</span>
          <span style={{ color: 'var(--text-secondary)' }}>Scopes</span>
          <span>{(agent.scope || '').split(' ').filter(Boolean).map(s => (
            <span key={s} className={`badge badge-${s}`} style={{ marginRight: 4 }}>{s}</span>
          ))}</span>
          <span style={{ color: 'var(--text-secondary)' }}>Registered</span>
          <span>{new Date(agent.created_at).toLocaleDateString()}</span>
          <span style={{ color: 'var(--text-secondary)' }}>Token TTL</span>
          <span>{agent.token_ttl ? (agent.token_ttl >= 86400 ? `${Math.floor(agent.token_ttl / 86400)}d` : agent.token_ttl >= 3600 ? `${Math.floor(agent.token_ttl / 3600)}h` : `${agent.token_ttl}s`) : '1h (default)'}</span>
        </div>

        {isOAuth && (
          <ClientGrantEditor
            clientId={cid}
            sources={sources}
            onRescoped={onRescoped}
          />
        )}

        <HarnessGuides serverUrl={serverUrl} clientId={cid} credentialFile={isOAuth && agent.grant_types.includes('client_credentials')} />
        {isOAuth && agent.status === 'active' && agent.grant_types.includes('client_credentials') && <div>
          <p className="grant-help">If registration finished but its download was lost, recover the saved credential delivery. Existing permissions and credentials stay unchanged.</p>
          <button type="button" className="btn btn-secondary" disabled={recovering} onClick={() => void recoverCredentials()}>{recovering ? 'Recovering…' : 'Recover credentials'}</button>
          {recoveryError && <p role="alert" style={{ color: 'var(--error)' }}>{recoveryError}</p>}
        </div>}

        <div style={{ marginTop: 32 }}>
          {agent.status === 'active' && (
            <button className="btn btn-danger" onClick={async () => {
              if (!confirm(`Revoke ${agent.name || agent.client_name}? All active tokens will be invalidated.`)) return;
              try {
                if (agent.auth_type === 'oauth') {
                  await api.revokeClient(agent.id || agent.client_id || '');
                } else {
                  await api.revokeApiKey(agent.name || '');
                }
                onRevoked();
                onClose();
              } catch (e) {
                alert('Revoke failed: ' + (e instanceof Error ? e.message : 'unknown error'));
              }
            }}>Revoke Agent</button>
          )}
          {agent.status === 'revoked' && (
            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>This agent has been revoked.</span>
          )}
        </div>
      </div>
    </>
  );
}
