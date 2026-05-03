import React, { useState, useEffect } from 'react';
import { api } from '../api';

function timeAgo(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

interface Agent {
  client_id: string;
  client_name: string;
  grant_types: string[];
  scope: string;
  created_at: string;
  last_used_at: string | null;
  total_requests: number;
  requests_today: number;
  token_ttl: number | null;
}

interface ApiKey {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  status: 'active' | 'revoked';
}

export function AgentsPage() {
  const [tab, setTab] = useState<'oauth' | 'apikeys'>('oauth');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [showRegister, setShowRegister] = useState(false);
  const [showCredentials, setShowCredentials] = useState<{ clientId: string; clientSecret: string; name: string } | null>(null);
  const [showApiKeyCreate, setShowApiKeyCreate] = useState(false);
  const [showApiKeyToken, setShowApiKeyToken] = useState<{ name: string; token: string } | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);

  useEffect(() => { loadAgents(); loadApiKeys(); }, []);

  const loadAgents = () => { api.agents().then(setAgents).catch(() => {}); };
  const loadApiKeys = () => { api.apiKeys().then(setApiKeys).catch(() => {}); };

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 className="page-title" style={{ marginBottom: 0 }}>Agents</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {tab === 'oauth' && <button className="btn btn-primary" onClick={() => setShowRegister(true)}>+ Register Agent</button>}
          {tab === 'apikeys' && <button className="btn btn-primary" onClick={() => setShowApiKeyCreate(true)}>+ Create API Key</button>}
        </div>
      </div>

      <div className="tabs" style={{ marginBottom: 20 }}>
        <div className={`tab ${tab === 'oauth' ? 'active' : ''}`} onClick={() => setTab('oauth')}>OAuth Clients</div>
        <div className={`tab ${tab === 'apikeys' ? 'active' : ''}`} onClick={() => setTab('apikeys')}>
          API Keys {apiKeys.filter(k => k.status === 'active').length > 0 && <span className="badge badge-read" style={{ marginLeft: 6 }}>{apiKeys.filter(k => k.status === 'active').length}</span>}
        </div>
      </div>

      {tab === 'apikeys' && (
        <>
          {apiKeys.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)' }}>
              No API keys. Create one for simple bearer token auth.
            </div>
          ) : (
            <>
              <table>
                <thead>
                  <tr><th>Name</th><th>Status</th><th>Created</th><th>Last Used</th><th></th></tr>
                </thead>
                <tbody>
                  {apiKeys.map(k => (
                    <tr key={k.id}>
                      <td style={{ fontWeight: 500 }}>{k.name}</td>
                      <td><span className={`badge ${k.status === 'active' ? 'badge-success' : 'badge-danger'}`}>{k.status}</span></td>
                      <td style={{ color: 'var(--text-secondary)' }}>{new Date(k.created_at).toLocaleDateString()}</td>
                      <td style={{ color: 'var(--text-secondary)' }}>{k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : 'Never'}</td>
                      <td>
                        {k.status === 'active' && (
                          <button className="btn btn-danger" style={{ fontSize: 12, padding: '2px 8px' }}
                            onClick={async () => { await api.revokeApiKey(k.name); loadApiKeys(); }}>Revoke</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 12 }}>
                API keys grant read+write+admin access. Use OAuth clients for scoped access.
              </div>
            </>
          )}
        </>
      )}

      {tab === 'oauth' && (
      <>

      {agents.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)' }}>
          No agents registered. Register your first agent to get started.
        </div>
      ) : (
        <>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Scopes</th>
                <th>Requests</th>
                <th>Last Used</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {agents.map(a => (
                <tr key={a.client_id} onClick={() => setSelectedAgent(a)} style={{ cursor: 'pointer' }}>
                  <td style={{ fontWeight: 500 }}>{a.client_name}</td>
                  <td>
                    {(a.scope || '').split(' ').filter(Boolean).map(s => (
                      <span key={s} className={`badge badge-${s}`} style={{ marginRight: 4 }}>{s}</span>
                    ))}
                  </td>
                  <td>
                    <span style={{ fontWeight: 500 }}>{a.requests_today || 0}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: 12 }}> today / {a.total_requests || 0} total</span>
                  </td>
                  <td style={{ color: 'var(--text-secondary)' }}>
                    {a.last_used_at ? timeAgo(new Date(a.last_used_at)) : 'Never'}
                  </td>
                  <td style={{ color: 'var(--text-secondary)' }}>
                    {new Date(a.created_at).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 12 }}>
            {agents.length} agent{agents.length !== 1 ? 's' : ''} registered
          </div>
        </>
      )}

      </>)}

      {showRegister && (
        <RegisterModal
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
        <AgentDrawer agent={selectedAgent} onClose={() => setSelectedAgent(null)} />
      )}

      {showApiKeyCreate && (
        <ApiKeyCreateModal
          onClose={() => setShowApiKeyCreate(false)}
          onCreated={(result) => { setShowApiKeyCreate(false); setShowApiKeyToken(result); loadApiKeys(); }}
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

function RegisterModal({ onClose, onRegistered }: {
  onClose: () => void;
  onRegistered: (creds: { clientId: string; clientSecret: string; name: string }) => void;
}) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState({ read: true, write: false, admin: false });
  const [ttl, setTtl] = useState('86400'); // 24h default
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const ttlOptions = [
    { label: '1 hour', value: '3600' },
    { label: '24 hours', value: '86400' },
    { label: '7 days', value: '604800' },
    { label: '30 days', value: '2592000' },
    { label: '1 year', value: '31536000' },
    { label: 'No expiry', value: '0' },
  ];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError('Name required'); return; }
    setLoading(true);
    setError('');
    try {
      // Use the CLI registration endpoint (POST to admin API)
      const selectedScopes = Object.entries(scopes).filter(([, v]) => v).map(([k]) => k).join(' ');
      const res = await fetch('/admin/api/register-client', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), scopes: selectedScopes, tokenTtl: ttl === '0' ? 315360000 : Number(ttl) }),
      });
      if (!res.ok) throw new Error('Registration failed');
      const data = await res.json();
      onRegistered({ clientId: data.clientId, clientSecret: data.clientSecret, name: name.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal" onClick={e => e.stopPropagation()} onSubmit={handleSubmit}>
        <div className="modal-title">Register Agent</div>
        <div style={{ marginBottom: 16 }}>
          <label>Agent Name</label>
          <input placeholder="e.g. perplexity-production" value={name} onChange={e => setName(e.target.value)} autoFocus />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label>Scopes</label>
          <div className="checkbox-group">
            {(['read', 'write', 'admin'] as const).map(s => (
              <label key={s} className="checkbox-label">
                <input type="checkbox" checked={scopes[s]} onChange={e => setScopes(p => ({ ...p, [s]: e.target.checked }))} />
                {s}
              </label>
            ))}
          </div>
        </div>
        <div style={{ marginBottom: 20 }}>
          <label>Token Lifetime</label>
          <select value={ttl} onChange={e => setTtl(e.target.value)}
            style={{ width: '100%', background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', fontSize: 14 }}>
            {ttlOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        {error && <div style={{ color: 'var(--error)', fontSize: 13, marginBottom: 12 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Registering...' : 'Register'}
          </button>
        </div>
      </form>
    </div>
  );
}

function CredentialsModal({ credentials, onClose }: {
  credentials: { clientId: string; clientSecret: string; name: string };
  onClose: () => void;
}) {
  const copy = (text: string) => navigator.clipboard.writeText(text);
  const downloadJson = () => {
    const blob = new Blob([JSON.stringify(credentials, null, 2)], { type: 'application/json' });
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
          Save this secret now. It will not be shown again.
        </div>

        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 20 }}>
          <button className="btn btn-secondary" onClick={downloadJson}>Download as JSON</button>
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

function AgentDrawer({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const [tab, setTab] = useState<'claude-code' | 'chatgpt' | 'claude-cowork' | 'perplexity' | 'cursor' | 'json'>('claude-code');
  const copy = (text: string) => navigator.clipboard.writeText(text);
  const serverUrl = window.location.origin;

  const configSnippets: Record<string, string> = {
    'claude-code': `# Add to .mcp.json in your project root:\n{\n  "mcpServers": {\n    "gbrain": {\n      "type": "url",\n      "url": "${serverUrl}/mcp",\n      "headers": {\n        "Authorization": "Bearer <TOKEN>"\n      }\n    }\n  }\n}\n\n# Get a token:\ncurl -s -X POST ${serverUrl}/token \\\n  -d "grant_type=client_credentials\\\n&client_id=${agent.client_id}\\\n&client_secret=YOUR_SECRET\\\n&scope=${agent.scope || 'read write'}" | jq -r .access_token`,
    'chatgpt': `1. Go to ChatGPT → Settings → Tools & Integrations → Add MCP\n2. Server URL: ${serverUrl}/mcp\n3. Authentication: OAuth 2.0\n   Token URL: ${serverUrl}/token\n   Client ID: ${agent.client_id}\n   Client Secret: YOUR_SECRET\n   Grant Type: client_credentials\n   Scope: ${agent.scope || 'read write'}\n\nChatGPT will auto-discover via:\n${serverUrl}/.well-known/oauth-authorization-server`,
    'claude-cowork': `1. Open Claude.ai → Settings → Connected Apps → Add MCP Server\n2. Server URL: ${serverUrl}/mcp\n3. Auth: OAuth 2.0 (client_credentials)\n   Token endpoint: ${serverUrl}/token\n   Client ID: ${agent.client_id}\n   Client Secret: YOUR_SECRET\n   Scope: ${agent.scope || 'read write'}\n\nOr use the discovery URL:\n${serverUrl}/.well-known/oauth-authorization-server`,
    perplexity: `1. Go to Settings → Connectors → Add MCP\n2. Server URL: ${serverUrl}/mcp\n3. Client ID: ${agent.client_id}\n4. Client Secret: YOUR_SECRET`,
    cursor: `# Add to .cursor/mcp.json:\n{\n  "mcpServers": {\n    "gbrain": {\n      "url": "${serverUrl}/mcp",\n      "auth": {\n        "type": "oauth2",\n        "clientId": "${agent.client_id}",\n        "clientSecret": "YOUR_SECRET",\n        "tokenUrl": "${serverUrl}/token",\n        "grantType": "client_credentials",\n        "scope": "${agent.scope || 'read write'}"\n      }\n    }\n  }\n}`,
    json: JSON.stringify({
      server_url: `${serverUrl}/mcp`,
      token_url: `${serverUrl}/token`,
      discovery_url: `${serverUrl}/.well-known/oauth-authorization-server`,
      client_id: agent.client_id,
      client_name: agent.client_name,
      scope: agent.scope,
      grant_types: agent.grant_types,
    }, null, 2),
  };

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <div className="drawer">
        <button className="drawer-close" onClick={onClose}>&#10005;</button>
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>{agent.client_name}</div>
        <span className="badge badge-success">Active</span>

        <div className="section-title">Details</div>
        <div style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: '6px 12px', fontSize: 13 }}>
          <span style={{ color: 'var(--text-secondary)' }}>Client ID</span>
          <span className="mono">{agent.client_id.substring(0, 24)}...</span>
          <span style={{ color: 'var(--text-secondary)' }}>Scopes</span>
          <span>{(agent.scope || '').split(' ').filter(Boolean).map(s => (
            <span key={s} className={`badge badge-${s}`} style={{ marginRight: 4 }}>{s}</span>
          ))}</span>
          <span style={{ color: 'var(--text-secondary)' }}>Registered</span>
          <span>{new Date(agent.created_at).toLocaleDateString()}</span>
          <span style={{ color: 'var(--text-secondary)' }}>Token TTL</span>
          <span>{agent.token_ttl ? (agent.token_ttl >= 31536000 ? 'No expiry' : agent.token_ttl >= 86400 ? `${Math.floor(agent.token_ttl / 86400)}d` : agent.token_ttl >= 3600 ? `${Math.floor(agent.token_ttl / 3600)}h` : `${agent.token_ttl}s`) : '1h (default)'}</span>
        </div>

        <div className="section-title">Config Export</div>
        <div className="tabs" style={{ flexWrap: 'wrap' }}>
          <div className={`tab ${tab === 'claude-code' ? 'active' : ''}`} onClick={() => setTab('claude-code')}>Claude Code</div>
          <div className={`tab ${tab === 'chatgpt' ? 'active' : ''}`} onClick={() => setTab('chatgpt')}>ChatGPT</div>
          <div className={`tab ${tab === 'claude-cowork' ? 'active' : ''}`} onClick={() => setTab('claude-cowork')}>Claude.ai</div>
          <div className={`tab ${tab === 'cursor' ? 'active' : ''}`} onClick={() => setTab('cursor')}>Cursor</div>
          <div className={`tab ${tab === 'perplexity' ? 'active' : ''}`} onClick={() => setTab('perplexity')}>Perplexity</div>
          <div className={`tab ${tab === 'json' ? 'active' : ''}`} onClick={() => setTab('json')}>JSON</div>
        </div>
        <div className="code-block">
          <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{configSnippets[tab]}</pre>
          <button className="copy-btn" onClick={() => copy(configSnippets[tab])}>Copy</button>
        </div>

        <div style={{ marginTop: 32 }}>
          <button className="btn btn-danger">Revoke Agent</button>
        </div>
      </div>
    </>
  );
}
