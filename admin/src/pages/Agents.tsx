import React, { useState, useEffect } from 'react';
import { api } from '../api';
import { ALLOWED_SCOPES_LIST, type Scope } from '../lib/scope-constants';

function timeAgo(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

function statusLabel(status: string): string {
  return status === 'active' ? '活跃' : status === 'revoked' ? '已撤销' : status;
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
  source_id?: string | null;
  federated_read?: string[] | null;
}

interface SourceOption {
  id: string;
  name?: string;
  archived?: boolean;
}

interface ApiKey {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  status: 'active' | 'revoked';
}

function normalizeReadSources(readSources: string[] | null | undefined, sourceId: string) {
  const values = Array.isArray(readSources) ? readSources.filter(Boolean) : [];
  return Array.from(new Set(values.length > 0 ? values : [sourceId]));
}

function sourceLabel(sourceId: string, sources: SourceOption[], mainSourceId: string) {
  const effectiveId = sourceId === 'default' ? mainSourceId : sourceId;
  const source = sources.find(item => item.id === effectiveId);
  return source?.name || effectiveId;
}

function SourceScopeBadges({ agent, mainSourceId }: { agent: Agent; mainSourceId: string }) {
  const writeSource = agent.source_id || mainSourceId;
  const reads = normalizeReadSources(agent.federated_read, writeSource).map(id => id === 'default' ? mainSourceId : id);
  return (
    <span className="source-scope-badges">
      {reads.slice(0, 3).map(id => <span key={id} className="badge badge-read">{id}</span>)}
      {reads.length > 3 && <span className="badge">+{reads.length - 3}</span>}
    </span>
  );
}

function SourceOptionName({ sourceId, sources, mainSourceId }: { sourceId: string; sources: SourceOption[]; mainSourceId: string }) {
  const effectiveId = sourceId === 'default' ? mainSourceId : sourceId;
  const source = sources.find(item => item.id === effectiveId);
  return (
    <>
      <span>{source?.name || effectiveId}</span>
      {source?.name && source.name !== effectiveId && <small>{effectiveId}</small>}
    </>
  );
}

function SourceScopeFields({
  sources,
  mainSourceId,
  sourceId,
  readSources,
  onSourceIdChange,
  onReadSourcesChange,
}: {
  sources: SourceOption[];
  mainSourceId: string;
  sourceId: string;
  readSources: string[];
  onSourceIdChange: (sourceId: string) => void;
  onReadSourcesChange: (sourceIds: string[]) => void;
}) {
  const options = sources.length > 0 ? sources : [{ id: mainSourceId }];
  const selectedWrite = sourceLabel(sourceId, sources, mainSourceId);
  const toggleRead = (id: string, checked: boolean) => {
    const next = checked
      ? Array.from(new Set([...readSources, id]))
      : readSources.filter(item => item !== id);
    onReadSourcesChange(next.length > 0 ? next : [sourceId]);
  };
  return (
    <fieldset className="source-scope-editor">
      <legend>源范围</legend>
      <div className="source-write-control">
        <div>
          <span>写入源</span>
          <strong>{selectedWrite}</strong>
        </div>
        <select aria-label="写入源" value={sourceId} onChange={e => {
          const nextSourceId = e.target.value;
          onSourceIdChange(nextSourceId);
          if (readSources.length === 0 || (readSources.length === 1 && readSources[0] === sourceId)) {
            onReadSourcesChange([nextSourceId]);
          }
        }}>
          {options.map(source => (
            <option key={source.id} value={source.id}>
              {sourceLabel(source.id, sources, mainSourceId)}{source.id === mainSourceId ? '（主源）' : ''}
            </option>
          ))}
        </select>
      </div>
      <div className="source-read-head">
        <span>读取源</span>
        <em>{readSources.length} 个已选</em>
      </div>
      <div className="source-read-list">
        {options.map(source => {
          const checked = readSources.includes(source.id);
          return (
            <label key={source.id} className={`source-read-option ${checked ? 'checked' : ''}`}>
              <input
                type="checkbox"
                checked={checked}
                onChange={e => toggleRead(source.id, e.target.checked)}
              />
              <span className="source-checkmark" aria-hidden="true">{checked ? '✓' : ''}</span>
              <span className="source-option-copy">
                <SourceOptionName sourceId={source.id} sources={sources} mainSourceId={mainSourceId} />
              </span>
              {source.id === mainSourceId && <span className="source-main-chip">主源</span>}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export function AgentsPage({
  title = 'Agent 管理',
  description,
  titleHelp,
}: {
  title?: string;
  description?: React.ReactNode;
  titleHelp?: React.ReactNode;
}) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [hideRevoked, setHideRevoked] = useState(true);
  const [showRegister, setShowRegister] = useState(false);
  const [showCredentials, setShowCredentials] = useState<{ clientId: string; clientSecret: string; name: string } | null>(null);
  const [showApiKeyCreate, setShowApiKeyCreate] = useState(false);
  const [showApiKeyToken, setShowApiKeyToken] = useState<{ name: string; token: string } | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [sources, setSources] = useState<SourceOption[]>([]);
  const [mainSourceId, setMainSourceId] = useState('default');

  useEffect(() => { loadAgents(); loadOverview(); }, []);

  const loadAgents = () => { api.agents().then(setAgents).catch(() => {}); };
  const loadOverview = () => {
    api.brainOverview().then((overview: any) => {
      setMainSourceId(typeof overview?.main_source_id === 'string' ? overview.main_source_id : 'default');
      setSources(Array.isArray(overview?.sources) ? overview.sources.filter((source: SourceOption) => !source.archived) : []);
    }).catch(() => {});
  };

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 18, marginBottom: 24 }}>
        <div>
          <h1 className="page-title title-with-info" style={{ marginBottom: description ? 6 : 0 }}>
            {title}
            {titleHelp}
          </h1>
          {description && <p className="pm-section-desc">{description}</p>}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={hideRevoked} onChange={e => setHideRevoked(e.target.checked)} /> 隐藏已撤销项
          </label>
          <button className="btn btn-secondary" onClick={() => setShowApiKeyCreate(true)}>+ API Key</button>
          <button className="btn btn-primary" onClick={() => setShowRegister(true)}>+ OAuth 客户端</button>
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
              暂无已注册 Agent。请先注册第一个 Agent。
            </div>
          );
        }
        if (visibleAgents.length === 0) {
          return (
            <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)' }}>
              所有 Agent 均已撤销。取消勾选“隐藏已撤销项”即可查看。
            </div>
          );
        }
        return (
        <>
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>类型</th>
                <th>权限范围</th>
                <th>读取源</th>
                <th>状态</th>
                <th>请求数</th>
                <th>最近使用</th>
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
                    <SourceScopeBadges agent={a} mainSourceId={mainSourceId} />
                  </td>
                  <td>
                    <span className={`badge ${a.status === 'active' ? 'badge-success' : 'badge-danger'}`}>{statusLabel(a.status)}</span>
                  </td>
                  <td>
                    <span style={{ fontWeight: 500 }}>{a.requests_today || 0}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: 12 }}> / {a.total_requests || 0}</span>
                  </td>
                  <td style={{ color: 'var(--text-secondary)' }}>
                    {a.last_used_at ? timeAgo(new Date(a.last_used_at)) : '从未使用'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 12 }}>
            {agents.filter(a => a.status === 'active').length} 个活跃 / 共 {agents.length} 个
          </div>
        </>
        );
      })()}

      {showRegister && (
        <RegisterModal
          onClose={() => setShowRegister(false)}
          onRegistered={(creds) => { setShowRegister(false); setShowCredentials(creds); loadAgents(); }}
          sources={sources}
          mainSourceId={mainSourceId}
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
          agent={selectedAgent}
          onClose={() => setSelectedAgent(null)}
          onRevoked={loadAgents}
          sources={sources}
          mainSourceId={mainSourceId}
          onUpdated={(next) => {
            setSelectedAgent(next);
            loadAgents();
          }}
        />
      )}

      {showApiKeyCreate && (
        <ApiKeyCreateModal
          onClose={() => setShowApiKeyCreate(false)}
          onCreated={(result) => { setShowApiKeyCreate(false); setShowApiKeyToken(result); loadAgents(); }}
          sources={sources}
          mainSourceId={mainSourceId}
        />
      )}

      {showApiKeyToken && (
        <ApiKeyTokenModal token={showApiKeyToken} onClose={() => setShowApiKeyToken(null)} />
      )}
    </>
  );
}

function ApiKeyCreateModal({ onClose, onCreated, sources, mainSourceId }: {
  onClose: () => void;
  onCreated: (result: { name: string; token: string }) => void;
  sources: SourceOption[];
  mainSourceId: string;
}) {
  const [name, setName] = useState('');
  const [sourceId, setSourceId] = useState(mainSourceId);
  const [readSources, setReadSources] = useState<string[]>([mainSourceId]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setSourceId(mainSourceId);
    setReadSources([mainSourceId]);
  }, [mainSourceId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError('请输入名称'); return; }
    setLoading(true);
    try {
      const data = await api.createApiKey(name.trim(), { sourceId, federatedRead: readSources });
      onCreated({ name: data.name, token: data.token });
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    } finally { setLoading(false); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal" onClick={e => e.stopPropagation()} onSubmit={handleSubmit}>
        <div className="modal-title">创建 API Key</div>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>
          API Key 使用简单的 Bearer Token 认证，并授予完整的 read、write、admin 权限。
          如需限制权限范围，请改用 OAuth 客户端。
        </p>
        <div style={{ marginBottom: 16 }}>
          <label>Key 名称</label>
          <input placeholder="例如 claude-code-local" value={name} onChange={e => setName(e.target.value)} autoFocus />
        </div>
        <SourceScopeFields
          sources={sources}
          mainSourceId={mainSourceId}
          sourceId={sourceId}
          readSources={readSources}
          onSourceIdChange={setSourceId}
          onReadSourcesChange={setReadSources}
        />
        {error && <div style={{ color: 'var(--error)', fontSize: 13, marginBottom: 12 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>取消</button>
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? '正在创建...' : '创建 Key'}
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
          <div style={{ fontSize: 20, fontWeight: 600 }}>API Key 已创建</div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12 }}>名称</label>
          <div className="code-block"><span>{token.name}</span></div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12 }}>Bearer Token</label>
          <div className="code-block">
            <span>{token.token}</span>
            <button className="copy-btn" onClick={() => copy(token.token)}>复制</button>
          </div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12 }}>用法</label>
          <div className="code-block">
            <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 12 }}>{`Authorization: Bearer ${token.token}`}</pre>
            <button className="copy-btn" onClick={() => copy(`Authorization: Bearer ${token.token}`)}>复制</button>
          </div>
        </div>
        <div className="warning-bar">请立即保存此令牌，之后不会再次显示。</div>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 20 }}>
          <button className="btn btn-primary" onClick={onClose}>完成</button>
        </div>
      </div>
    </div>
  );
}

function RegisterModal({ onClose, onRegistered, sources, mainSourceId }: {
  onClose: () => void;
  onRegistered: (creds: { clientId: string; clientSecret: string; name: string }) => void;
  sources: SourceOption[];
  mainSourceId: string;
}) {
  const [name, setName] = useState('');
  const [sourceId, setSourceId] = useState(mainSourceId);
  const [readSources, setReadSources] = useState<string[]>([mainSourceId]);
  // v0.28: scope set sourced from admin/src/lib/scope-constants.ts (mirror
  // of src/core/scope.ts). CI drift check at scripts/check-admin-scope-drift.sh
  // fails the build if these diverge.
  const [scopes, setScopes] = useState<Record<Scope, boolean>>(() =>
    Object.fromEntries(ALLOWED_SCOPES_LIST.map(s => [s, s === 'read'])) as Record<Scope, boolean>,
  );
  const [ttl, setTtl] = useState('86400'); // 24h default
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setSourceId(mainSourceId);
    setReadSources([mainSourceId]);
  }, [mainSourceId]);

  const ttlOptions = [
    { label: '1 小时', value: '3600' },
    { label: '24 小时', value: '86400' },
    { label: '7 天', value: '604800' },
    { label: '30 天', value: '2592000' },
    { label: '1 年', value: '31536000' },
    { label: '永不过期', value: '0' },
  ];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError('请输入名称'); return; }
    setLoading(true);
    setError('');
    try {
      // Use the CLI registration endpoint (POST to admin API)
      const selectedScopes = Object.entries(scopes).filter(([, v]) => v).map(([k]) => k).join(' ');
      const res = await fetch('/admin/api/register-client', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          scopes: selectedScopes,
          tokenTtl: ttl === '0' ? 315360000 : Number(ttl),
          sourceId,
          federatedRead: readSources,
        }),
      });
      if (!res.ok) throw new Error('注册失败');
      const data = await res.json();
      onRegistered({ clientId: data.clientId, clientSecret: data.clientSecret, name: name.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : '注册失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal" onClick={e => e.stopPropagation()} onSubmit={handleSubmit}>
        <div className="modal-title">注册 Agent</div>
        <div style={{ marginBottom: 16 }}>
          <label>Agent 名称</label>
          <input placeholder="例如 perplexity-production" value={name} onChange={e => setName(e.target.value)} autoFocus />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label>权限范围</label>
          <div className="checkbox-group">
            {ALLOWED_SCOPES_LIST.map(s => (
              <label key={s} className="checkbox-label">
                <input type="checkbox" checked={scopes[s]} onChange={e => setScopes(p => ({ ...p, [s]: e.target.checked }))} />
                {s}
              </label>
            ))}
          </div>
        </div>
        <SourceScopeFields
          sources={sources}
          mainSourceId={mainSourceId}
          sourceId={sourceId}
          readSources={readSources}
          onSourceIdChange={setSourceId}
          onReadSourcesChange={setReadSources}
        />
        <div style={{ marginBottom: 20 }}>
          <label>令牌有效期</label>
          <select value={ttl} onChange={e => setTtl(e.target.value)}
            style={{ width: '100%', background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', fontSize: 14 }}>
            {ttlOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        {error && <div style={{ color: 'var(--error)', fontSize: 13, marginBottom: 12 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>取消</button>
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? '正在注册...' : '注册'}
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
          <div style={{ fontSize: 20, fontWeight: 600 }}>Agent 已注册</div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12 }}>Client ID</label>
          <div className="code-block">
            <span>{credentials.clientId}</span>
            <button className="copy-btn" onClick={() => copy(credentials.clientId)}>复制</button>
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12 }}>客户端密钥</label>
          <div className="code-block">
            <span>{credentials.clientSecret}</span>
            <button className="copy-btn" onClick={() => copy(credentials.clientSecret)}>复制</button>
          </div>
        </div>

        <div className="warning-bar">
          请立即保存此密钥，之后不会再次显示。
        </div>

        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 20 }}>
          <button className="btn btn-secondary" onClick={downloadJson}>下载 JSON</button>
          <button className="btn btn-primary" onClick={onClose}>完成</button>
        </div>
      </div>
    </div>
  );
}

function AgentDrawer({
  agent,
  onClose,
  onRevoked,
  sources,
  mainSourceId,
  onUpdated,
}: {
  agent: Agent;
  onClose: () => void;
  onRevoked: () => void;
  sources: SourceOption[];
  mainSourceId: string;
  onUpdated: (agent: Agent) => void;
}) {
  const [tab, setTab] = useState<'claude-code' | 'chatgpt' | 'claude-cowork' | 'perplexity' | 'cursor' | 'json'>('claude-code');
  const [editingSource, setEditingSource] = useState(false);
  const [sourceId, setSourceId] = useState(agent.source_id || mainSourceId);
  const [readSources, setReadSources] = useState<string[]>(normalizeReadSources(agent.federated_read, agent.source_id || mainSourceId));
  const [sourceSaving, setSourceSaving] = useState(false);
  const [sourceError, setSourceError] = useState('');
  const copy = (text: string) => navigator.clipboard.writeText(text);
  const serverUrl = window.location.origin;

  const cid = agent.id || agent.client_id || '';
  const isOAuth = agent.auth_type === 'oauth';
  const agentName = agent.name || agent.client_name || 'unknown';

  useEffect(() => {
    const nextSourceId = agent.source_id || mainSourceId;
    setSourceId(nextSourceId);
    setReadSources(normalizeReadSources(agent.federated_read, nextSourceId));
  }, [agent.id, agent.source_id, agent.federated_read, mainSourceId]);

  const saveSourceScope = async () => {
    setSourceSaving(true);
    setSourceError('');
    try {
      const result = await api.updateAgentSourceScope({
        id: agent.id,
        authType: agent.auth_type,
        sourceId,
        federatedRead: readSources,
      });
      onUpdated({ ...agent, source_id: result.sourceId, federated_read: result.federatedRead });
      setEditingSource(false);
    } catch (e) {
      setSourceError(e instanceof Error ? e.message : String(e));
    } finally {
      setSourceSaving(false);
    }
  };

  // For API keys, we can't show the actual token (it was shown once at creation).
  // For OAuth, we show the client_id and tell them to use their secret.

  const configSnippets: Record<string, string> = {
    'claude-code': isOAuth
      ? [
        `用户希望将 PMBrain MCP 连接到你的上下文。请按以下步骤操作。`,
        ``,
        `# 第 1 步：读取客户端密钥，不要将其写入 shell 历史。`,
        `# read -s 会禁止回显；export 仅让变量在当前 shell 会话中生效。`,
        `read -rs -p "Client Secret: " PMBRAIN_CS && echo`,
        ``,
        `# 第 2 步：生成令牌并注册 PMBrain。`,
        `claude mcp add --transport http pmbrain ${serverUrl}/mcp \\`,
        `  --header "Authorization: Bearer $(curl -s -X POST ${serverUrl}/token \\`,
        `    -d 'grant_type=client_credentials' \\`,
        `    -d 'client_id=${cid}' \\`,
        `    --data-urlencode "client_secret=$PMBRAIN_CS" \\`,
        `    -d 'scope=${agent.scope || 'read write'}' | jq -r .access_token)"`,
        ``,
        `# 第 3 步：从当前 shell 清除密钥。`,
        `unset PMBRAIN_CS`,
        ``,
        `令牌有效期：${agent.token_ttl ? (agent.token_ttl >= 86400 ? Math.floor(agent.token_ttl / 86400) + ' 天' : Math.floor(agent.token_ttl / 3600) + ' 小时') : '1 小时（默认）'}。`,
        ``,
        `─── 备用方案：分两步执行 curl 并粘贴令牌 ───`,
        ``,
        `如果 shell 不支持 read -s，请先生成令牌，再粘贴：`,
        ``,
        `curl -s -X POST ${serverUrl}/token \\`,
        `  -d 'grant_type=client_credentials' \\`,
        `  -d 'client_id=${cid}' \\`,
        `  -d 'client_secret=PASTE_YOUR_CLIENT_SECRET_HERE' \\`,
        `  -d 'scope=${agent.scope || 'read write'}' | jq -r .access_token`,
        ``,
        `claude mcp add --transport http pmbrain ${serverUrl}/mcp \\`,
        `  --header "Authorization: Bearer PASTE_TOKEN_FROM_ABOVE"`,
        ``,
        `# 然后执行：history -d $((HISTCMD-1))   # zsh: print -s -- '' && fc -p`,
      ].join('\n')
      : [
        `用户希望将 PMBrain MCP 连接到你的上下文。请按以下步骤操作。`,
        ``,
        `在终端中运行以下命令注册 PMBrain：`,
        ``,
        `claude mcp add --transport http pmbrain ${serverUrl}/mcp \\`,
        `  --header "Authorization: Bearer PASTE_YOUR_API_KEY_HERE"`,
        ``,
        `将 PASTE_YOUR_API_KEY_HERE 替换为创建“${agentName}”时显示的 API Key。`,
        `API Key 永不过期。`,
      ].join('\n'),

    'chatgpt': [
      `用户希望将 PMBrain MCP 连接到 ChatGPT。`,
      ``,
      `1. 打开 ChatGPT > Settings > Tools & Integrations > Add MCP Server`,
      `2. 输入以下 URL，ChatGPT 会自动发现 OAuth 配置：`,
      ``,
      `   ${serverUrl}/.well-known/oauth-authorization-server`,
      ``,
      `3. 根据提示输入凭据：`,
      `   Client ID: ${cid}`,
      `   客户端密钥：（注册 Agent 时获得的密钥）`,
      `   授权类型：client_credentials`,
      `   权限范围：${agent.scope || 'read write'}`,
    ].join('\n'),

    'claude-cowork': [
      `用户希望将 PMBrain MCP 连接到 Claude.ai。`,
      ``,
      `1. 打开 claude.ai > Settings > Connected Apps > Add MCP Server`,
      `2. 服务器 URL：${serverUrl}/mcp`,
      `3. 根据提示输入认证信息：`,
      `   令牌端点：${serverUrl}/token`,
      `   Client ID: ${cid}`,
      `   客户端密钥：（注册 Agent 时获得的密钥）`,
      `   权限范围：${agent.scope || 'read write'}`,
      ``,
      `发现 URL：${serverUrl}/.well-known/oauth-authorization-server`,
    ].join('\n'),

    cursor: isOAuth
      ? [
        `用户希望将 PMBrain MCP 连接到 Cursor。`,
        ``,
        `Cursor 支持远程 MCP 的 OAuth。请添加到 .cursor/mcp.json：`,
        ``,
        `{`,
        `  "mcpServers": {`,
        `    "pmbrain": {`,
        `      "url": "${serverUrl}/mcp",`,
        `      "transport": "sse"`,
        `    }`,
        `  }`,
        `}`,
        ``,
        `Cursor 会通过以下地址自动发现 OAuth：`,
        `${serverUrl}/.well-known/oauth-authorization-server`,
        ``,
        `出现提示时，Client ID 填写 ${cid}，密钥使用注册时获得的值。`,
      ].join('\n')
      : [
        `用户希望将 PMBrain MCP 连接到 Cursor。`,
        ``,
        `请添加到 .cursor/mcp.json：`,
        ``,
        `{`,
        `  "mcpServers": {`,
        `    "pmbrain": {`,
        `      "url": "${serverUrl}/mcp",`,
        `      "transport": "sse",`,
        `      "headers": {`,
        `        "Authorization": "Bearer PASTE_YOUR_API_KEY_HERE"`,
        `      }`,
        `    }`,
        `  }`,
        `}`,
        ``,
        `将 PASTE_YOUR_API_KEY_HERE 替换为创建“${agentName}”时显示的 API Key。`,
      ].join('\n'),

    perplexity: [
      `用户希望将 PMBrain MCP 连接到 Perplexity。`,
      ``,
      `1. 打开 Settings > Connectors > Add MCP`,
      `2. 服务器 URL：${serverUrl}/mcp`,
      `3. Client ID: ${cid}`,
      `4. 客户端密钥：（注册 Agent 时获得的密钥）`,
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
        <span className={`badge ${agent.status === 'active' ? 'badge-success' : 'badge-danger'}`}>{statusLabel(agent.status)}</span>

        <div className="section-title">详情</div>
        <div style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: '6px 12px', fontSize: 13 }}>
          <span style={{ color: 'var(--text-secondary)' }}>Client ID</span>
          <span className="mono">{(agent.id || agent.client_id || '').substring(0, 24)}...</span>
          <span style={{ color: 'var(--text-secondary)' }}>权限范围</span>
          <span>{(agent.scope || '').split(' ').filter(Boolean).map(s => (
            <span key={s} className={`badge badge-${s}`} style={{ marginRight: 4 }}>{s}</span>
          ))}</span>
          <span style={{ color: 'var(--text-secondary)' }}>注册时间</span>
          <span>{new Date(agent.created_at).toLocaleDateString()}</span>
          <span style={{ color: 'var(--text-secondary)' }}>Token TTL</span>
          <span>{agent.token_ttl ? (agent.token_ttl >= 31536000 ? '永不过期' : agent.token_ttl >= 86400 ? `${Math.floor(agent.token_ttl / 86400)} 天` : agent.token_ttl >= 3600 ? `${Math.floor(agent.token_ttl / 3600)} 小时` : `${agent.token_ttl} 秒`) : '1 小时（默认）'}</span>
        </div>

        <div className="section-title">源范围</div>
        <div className="agent-source-card">
          {!editingSource ? (
            <>
              <div>
                <span>写入源</span>
                <b>{sourceLabel(agent.source_id || mainSourceId, sources, mainSourceId)}</b>
              </div>
              <div>
                <span>读取源</span>
                <b>{normalizeReadSources(agent.federated_read, agent.source_id || mainSourceId).map(id => sourceLabel(id, sources, mainSourceId)).join('、')}</b>
              </div>
              <button className="btn btn-secondary" onClick={() => setEditingSource(true)}>修改</button>
            </>
          ) : (
            <>
              <SourceScopeFields
                sources={sources}
                mainSourceId={mainSourceId}
                sourceId={sourceId}
                readSources={readSources}
                onSourceIdChange={setSourceId}
                onReadSourcesChange={setReadSources}
              />
              {sourceError && <div style={{ color: 'var(--error)', fontSize: 13 }}>{sourceError}</div>}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button type="button" className="btn btn-secondary" onClick={() => setEditingSource(false)}>取消</button>
                <button type="button" className="btn btn-primary" disabled={sourceSaving} onClick={() => void saveSourceScope()}>
                  {sourceSaving ? '保存中...' : '保存'}
                </button>
              </div>
            </>
          )}
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
        <div className="section-title">配置导出</div>
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
                  {clientName} 需要 OAuth 客户端
                </div>
                {clientName} 仅支持 OAuth 2.0（client_credentials）。API Key 使用原始 Bearer Token，{clientName} 不接受这种方式。请单独注册 OAuth 客户端后再连接。
              </div>
            );
          }
          return (
            <div className="code-block">
              <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{configSnippets[tab]}</pre>
              <button className="copy-btn" onClick={() => copy(configSnippets[tab])}>复制</button>
            </div>
          );
        })()}

        <div style={{ marginTop: 32 }}>
          {agent.status === 'active' && (
            <button className="btn btn-danger" onClick={async () => {
              if (!confirm(`撤销 ${agent.name || agent.client_name}？所有活跃令牌都会失效。`)) return;
              try {
                if (agent.auth_type === 'oauth') {
                  await api.revokeClient(agent.id || agent.client_id || '');
                } else {
                  await api.revokeApiKey(agent.name || '');
                }
                onRevoked();
                onClose();
              } catch (e) {
                alert('撤销失败：' + (e instanceof Error ? e.message : '未知错误'));
              }
            }}>撤销 Agent</button>
          )}
          {agent.status === 'revoked' && (
            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>此 Agent 已撤销。</span>
          )}
        </div>
      </div>
    </>
  );
}
