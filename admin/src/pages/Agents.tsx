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
  id: string;
  name: string;
  auth_type: 'oauth' | 'api_key';
  client_id?: string;  // compat
  client_name?: string; // compat
  grant_types: string[];
  scope: string;
  created_at: string;
  last_used_at: string | null;
  total_requests: number;
  requests_today: number;
  token_ttl: number | null;
  status: 'active' | 'revoked';
}

interface ApiKey {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  status: 'active' | 'revoked';
}

export function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [hideRevoked, setHideRevoked] = useState(true);
  const [showRegister, setShowRegister] = useState(false);
  const [showCredentials, setShowCredentials] = useState<{ clientId: string; clientSecret: string; name: string } | null>(null);
  const [showApiKeyCreate, setShowApiKeyCreate] = useState(false);
  const [showApiKeyToken, setShowApiKeyToken] = useState<{ name: string; token: string } | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);

  useEffect(() => { loadAgents(); }, []);

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
        <AgentDrawer agent={selectedAgent} onClose={() => setSelectedAgent(null)} onRevoked={loadAgents} />
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

function AgentDrawer({ agent, onClose, onRevoked }: { agent: Agent; onClose: () => void; onRevoked: () => void }) {
  const [tab, setTab] = useState<'claude-code' | 'chatgpt' | 'claude-cowork' | 'perplexity' | 'cursor' | 'json'>('claude-code');
  const copy = (text: string) => navigator.clipboard.writeText(text);
  const serverUrl = window.location.origin;

  const cid = agent.id || agent.client_id || '';
  const isOAuth = agent.auth_type === 'oauth';
  const agentName = agent.name || agent.client_name || 'unknown';

  // For API keys, we can't show the actual token (it was shown once at creation).
  // For OAuth, we show the client_id and tell them to use their secret.

  const configSnippets: Record<string, string> = {
    'claude-code': isOAuth
      ? [
        `The user wants to connect GBrain MCP to your context. Here's how.`,
        ``,
        `# Step 1 — read the client secret from the operator without putting it in shell history.`,
        `# read -s suppresses the echo; export keeps it scoped to this shell session.`,
        `read -rs -p "Client Secret: " GBRAIN_CS && echo`,
        ``,
        `# Step 2 — mint a token and register GBrain in one go.`,
        `claude mcp add --transport http gbrain ${serverUrl}/mcp \\`,
        `  --header "Authorization: Bearer $(curl -s -X POST ${serverUrl}/token \\`,
        `    -d 'grant_type=client_credentials' \\`,
        `    -d 'client_id=${cid}' \\`,
        `    --data-urlencode "client_secret=$GBRAIN_CS" \\`,
        `    -d 'scope=${agent.scope || 'read write'}' | jq -r .access_token)"`,
        ``,
        `# Step 3 — clear the secret from this shell.`,
        `unset GBRAIN_CS`,
        ``,
        `The token will last ${agent.token_ttl ? (agent.token_ttl >= 86400 ? Math.floor(agent.token_ttl / 86400) + ' days' : Math.floor(agent.token_ttl / 3600) + ' hours') : '1 hour (default)'}.`,
        ``,
        `─── Fallback: 2-step curl + paste ───`,
        ``,
        `If your shell doesn't support read -s, mint the token first, then paste:`,
        ``,
        `curl -s -X POST ${serverUrl}/token \\`,
        `  -d 'grant_type=client_credentials' \\`,
        `  -d 'client_id=${cid}' \\`,
        `  -d 'client_secret=PASTE_YOUR_CLIENT_SECRET_HERE' \\`,
        `  -d 'scope=${agent.scope || 'read write'}' | jq -r .access_token`,
        ``,
        `claude mcp add --transport http gbrain ${serverUrl}/mcp \\`,
        `  --header "Authorization: Bearer PASTE_TOKEN_FROM_ABOVE"`,
        ``,
        `# Then run: history -d $((HISTCMD-1))   # zsh: print -s -- '' && fc -p`,
      ].join('\n')
      : [
        `The user wants to connect GBrain MCP to your context. Here's how.`,
        ``,
        `Run this command in terminal to register GBrain:`,
        ``,
        `claude mcp add --transport http gbrain ${serverUrl}/mcp \\`,
        `  --header "Authorization: Bearer PASTE_YOUR_API_KEY_HERE"`,
        ``,
        `Replace PASTE_YOUR_API_KEY_HERE with the API key shown when "${agentName}" was created.`,
        `API keys never expire.`,
      ].join('\n'),

    'chatgpt': [
      `The user wants to connect GBrain MCP to ChatGPT.`,
      ``,
      `1. Open ChatGPT > Settings > Tools & Integrations > Add MCP Server`,
      `2. Enter this URL — ChatGPT will auto-discover the OAuth configuration:`,
      ``,
      `   ${serverUrl}/.well-known/oauth-authorization-server`,
      ``,
      `3. When prompted for credentials:`,
      `   Client ID: ${cid}`,
      `   Client Secret: (the secret from agent registration)`,
      `   Grant Type: client_credentials`,
      `   Scope: ${agent.scope || 'read write'}`,
    ].join('\n'),

    'claude-cowork': [
      `The user wants to connect GBrain MCP to Claude.ai.`,
      ``,
      `1. Open claude.ai > Settings > Connected Apps > Add MCP Server`,
      `2. Server URL: ${serverUrl}/mcp`,
      `3. When prompted for auth:`,
      `   Token endpoint: ${serverUrl}/token`,
      `   Client ID: ${cid}`,
      `   Client Secret: (the secret from agent registration)`,
      `   Scope: ${agent.scope || 'read write'}`,
      ``,
      `Discovery URL: ${serverUrl}/.well-known/oauth-authorization-server`,
    ].join('\n'),

    cursor: isOAuth
      ? [
        `The user wants to connect GBrain MCP to Cursor.`,
        ``,
        `Cursor supports OAuth for remote MCP. Add to .cursor/mcp.json:`,
        ``,
        `{`,
        `  "mcpServers": {`,
        `    "gbrain": {`,
        `      "url": "${serverUrl}/mcp",`,
        `      "transport": "sse"`,
        `    }`,
        `  }`,
        `}`,
        ``,
        `Cursor will auto-discover OAuth via:`,
        `${serverUrl}/.well-known/oauth-authorization-server`,
        ``,
        `When prompted: Client ID ${cid}, use the secret from registration.`,
      ].join('\n')
      : [
        `The user wants to connect GBrain MCP to Cursor.`,
        ``,
        `Add to .cursor/mcp.json:`,
        ``,
        `{`,
        `  "mcpServers": {`,
        `    "gbrain": {`,
        `      "url": "${serverUrl}/mcp",`,
        `      "transport": "sse",`,
        `      "headers": {`,
        `        "Authorization": "Bearer PASTE_YOUR_API_KEY_HERE"`,
        `      }`,
        `    }`,
        `  }`,
        `}`,
        ``,
        `Replace PASTE_YOUR_API_KEY_HERE with the API key shown when "${agentName}" was created.`,
      ].join('\n'),

    perplexity: [
      `The user wants to connect GBrain MCP to Perplexity.`,
      ``,
      `1. Go to Settings > Connectors > Add MCP`,
      `2. Server URL: ${serverUrl}/mcp`,
      `3. Client ID: ${cid}`,
      `4. Client Secret: (the secret from agent registration)`,
    ].join('\n'),

    json: JSON.stringify({
      server_url: serverUrl + '/mcp',
      token_url: serverUrl + '/token',
      discovery_url: serverUrl + '/.well-known/oauth-authorization-server',
      client_id: cid,
      client_name: agentName,
      auth_type: agent.auth_type,
      scope: agent.scope,
    }, null, 2),
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
          <span>{agent.token_ttl ? (agent.token_ttl >= 31536000 ? 'No expiry' : agent.token_ttl >= 86400 ? `${Math.floor(agent.token_ttl / 86400)}d` : agent.token_ttl >= 3600 ? `${Math.floor(agent.token_ttl / 3600)}h` : `${agent.token_ttl}s`) : '1h (default)'}</span>
        </div>

        {/*
          Config Export visible for both auth_type=oauth AND auth_type=api_key.
          Claude Code + Cursor + JSON tabs render real snippets regardless
          (commit 15's snippets are auth-type-aware for those two clients;
          JSON is just structured metadata). ChatGPT, Claude.ai, and
          Perplexity tabs render an "OAuth client required" message on
          api_key agents — those MCP clients only speak OAuth 2.0
          client_credentials, not raw bearer tokens.

          Pre-fix (Wintermute commit 16): the entire Config Export
          section was hidden for api_key agents, dropping the working
          Claude Code + Cursor snippets along with the broken ones.
          (D5=C in the eng review.)
        */}
        <div className="section-title">Config Export</div>
        <div className="tabs" style={{ flexWrap: 'wrap' }}>
          <div className={`tab ${tab === 'claude-code' ? 'active' : ''}`} onClick={() => setTab('claude-code')}>Claude Code</div>
          <div className={`tab ${tab === 'chatgpt' ? 'active' : ''}`} onClick={() => setTab('chatgpt')}>ChatGPT</div>
          <div className={`tab ${tab === 'claude-cowork' ? 'active' : ''}`} onClick={() => setTab('claude-cowork')}>Claude.ai</div>
          <div className={`tab ${tab === 'cursor' ? 'active' : ''}`} onClick={() => setTab('cursor')}>Cursor</div>
          <div className={`tab ${tab === 'perplexity' ? 'active' : ''}`} onClick={() => setTab('perplexity')}>Perplexity</div>
          <div className={`tab ${tab === 'json' ? 'active' : ''}`} onClick={() => setTab('json')}>JSON</div>
        </div>
        {(() => {
          const oauthOnlyTabs = new Set(['chatgpt', 'claude-cowork', 'perplexity']);
          if (!isOAuth && oauthOnlyTabs.has(tab)) {
            const clientName = { chatgpt: 'ChatGPT', 'claude-cowork': 'Claude.ai', perplexity: 'Perplexity' }[tab] || tab;
            return (
              <div style={{
                background: 'rgba(255, 200, 100, 0.08)',
                border: '1px solid rgba(255, 200, 100, 0.2)',
                borderRadius: 8,
                padding: '14px 16px',
                marginTop: 12,
                fontSize: 13,
                lineHeight: 1.6,
                color: 'var(--text-secondary)',
              }}>
                <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
                  {clientName} requires an OAuth client
                </div>
                {clientName} only supports OAuth 2.0 (client_credentials). API keys use raw bearer tokens, which {clientName} does not accept. Register a separate OAuth client and use that to connect this AI.
              </div>
            );
          }
          return (
            <div className="code-block">
              <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{configSnippets[tab]}</pre>
              <button className="copy-btn" onClick={() => copy(configSnippets[tab])}>Copy</button>
            </div>
          );
        })()}

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
