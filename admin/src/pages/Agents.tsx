import React, { useState, useEffect } from 'react';
import { api } from '../api';
import { ALLOWED_SCOPES_LIST, type Scope } from '../lib/scope-constants';
import { CopyButton } from '../lib/clipboard';
import {
  buildApiKeyAgentContent,
  buildApiKeyJsonConfig,
  buildOAuthAgentContent,
  buildOAuthJsonConfig,
  MCP_CLIENTS,
  type McpClientId,
} from '../lib/mcp-config';

type ConfigTab = 'claude-code' | 'chatgpt' | 'claude-cowork' | 'perplexity' | 'cursor' | 'json';

const CONFIG_TABS: ReadonlyArray<{ id: ConfigTab; label: string }> = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'claude-cowork', label: 'Claude.ai' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'perplexity', label: 'Perplexity' },
  { id: 'json', label: 'JSON' },
];

function downloadJsonFile(content: string, fileName: string) {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

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
    <section className="agents-section">
      <div className="agents-section-head">
        <div>
          <h1 className="page-title title-with-info">
            {title}
            {titleHelp}
          </h1>
          {description && <p className="pm-section-desc">{description}</p>}
        </div>
        <div className="agents-section-actions">
          <label className="agents-revoked-filter">
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
            <div className="pm-empty agents-empty">
              暂无已注册 Agent。请先注册第一个 Agent。
            </div>
          );
        }
        if (visibleAgents.length === 0) {
          return (
            <div className="pm-empty agents-empty">
              所有 Agent 均已撤销。取消勾选“隐藏已撤销项”即可查看。
            </div>
          );
        }
        return (
        <>
          <div className="table-scroll"><table className="agents-table">
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
                <tr key={a.id} onClick={() => setSelectedAgent(a)} className="agents-table-row">
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
          </table></div>
          <div className="agents-table-summary">
            {visibleAgents.filter(a => a.status === 'active').length} 个活跃凭证
            {!hideRevoked && ` / 当前显示 ${visibleAgents.length} 个`}
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
    </section>
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
      <form className="modal credential-modal" onClick={e => e.stopPropagation()} onSubmit={handleSubmit}>
        <div className="credential-modal-body">
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
        </div>
        <div className="credential-modal-actions">
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
  const [client, setClient] = useState<McpClientId>('universal');
  const content = buildApiKeyAgentContent(client, window.location.origin, token.token);
  const jsonConfig = buildApiKeyJsonConfig(window.location.origin, token.token);

  return (
    <div className="modal-overlay">
      <div className="modal credential-modal">
        <div className="credential-modal-body">
        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 36, color: 'var(--success)', marginBottom: 8 }}>&#10003;</div>
          <div style={{ fontSize: 20, fontWeight: 600 }}>API Key 已创建</div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12 }}>名称</label>
          <div className="code-block"><span>{token.name}</span></div>
        </div>
        <div className="agent-handoff-head">
          <div><b>复制给哪个 Agent</b><span>内容已包含真实凭证，复制后直接发给对应 Agent。</span></div>
          <div className="tabs agent-client-tabs">
            {MCP_CLIENTS.map(item => <button type="button" key={item.id} className={`tab ${client === item.id ? 'active' : ''}`} onClick={() => setClient(item.id)}>{item.label}</button>)}
          </div>
        </div>
        <div className="code-block agent-handoff-content">
          <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 12 }}>{content}</pre>
          <CopyButton value={content} />
        </div>
        <details className="credential-details">
          <summary>查看原始凭证</summary>
          <div className="code-block"><span>{token.token}</span><CopyButton value={token.token} /></div>
          <div className="code-block"><pre>{`Authorization: Bearer ${token.token}`}</pre><CopyButton value={`Authorization: Bearer ${token.token}`} /></div>
        </details>
        <div className="warning-bar">请立即保存此令牌，之后不会再次显示。</div>
        </div>
        <div className="credential-modal-actions">
          <button className="btn btn-secondary" onClick={() => downloadJsonFile(jsonConfig, `${token.name}-pmbrain.json`)}>下载可用 JSON</button>
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
      <form className="modal credential-modal" onClick={e => e.stopPropagation()} onSubmit={handleSubmit}>
        <div className="credential-modal-body">
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
        </div>
        <div className="credential-modal-actions">
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
  const [client, setClient] = useState<McpClientId>('universal');
  const content = buildOAuthAgentContent(client, window.location.origin, credentials);
  const jsonConfig = buildOAuthJsonConfig(window.location.origin, credentials);
  const downloadJson = () => {
    downloadJsonFile(jsonConfig, `${credentials.name}-pmbrain.json`);
  };

  return (
    <div className="modal-overlay">
      <div className="modal credential-modal">
        <div className="credential-modal-body">
        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 36, color: 'var(--success)', marginBottom: 8 }}>&#10003;</div>
          <div style={{ fontSize: 20, fontWeight: 600 }}>Agent 已注册</div>
        </div>

        <div className="agent-handoff-head">
          <div><b>复制给哪个 Agent</b><span>内容已包含 Client ID 和密钥，复制后直接交给对应 Agent。</span></div>
          <div className="tabs agent-client-tabs">
            {MCP_CLIENTS.map(item => <button type="button" key={item.id} className={`tab ${client === item.id ? 'active' : ''}`} onClick={() => setClient(item.id)}>{item.label}</button>)}
          </div>
        </div>
        <div className="code-block agent-handoff-content"><pre>{content}</pre><CopyButton value={content} /></div>
        <details className="credential-details">
          <summary>查看原始凭证</summary>
          <div className="code-block"><span>{credentials.clientId}</span><CopyButton value={credentials.clientId} /></div>
          <div className="code-block"><span>{credentials.clientSecret}</span><CopyButton value={credentials.clientSecret} /></div>
        </details>

        <div className="warning-bar">
          请立即保存此密钥，之后不会再次显示。
        </div>
        </div>
        <div className="credential-modal-actions">
          <button className="btn btn-secondary" onClick={downloadJson}>下载可用 JSON</button>
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
  const [configTab, setConfigTab] = useState<ConfigTab>('json');
  const [editingSource, setEditingSource] = useState(false);
  const [sourceId, setSourceId] = useState(agent.source_id || mainSourceId);
  const [readSources, setReadSources] = useState<string[]>(normalizeReadSources(agent.federated_read, agent.source_id || mainSourceId));
  const [sourceSaving, setSourceSaving] = useState(false);
  const [sourceError, setSourceError] = useState('');
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

    json: isOAuth
      ? buildOAuthJsonConfig(serverUrl, {
        clientId: cid,
        clientSecret: 'PASTE_YOUR_CLIENT_SECRET_HERE',
      })
      : buildApiKeyJsonConfig(serverUrl, 'PASTE_YOUR_API_KEY_HERE'),
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

        <div className="section-title">接入其他 Agent</div>
        <div className="tabs agent-client-tabs agent-config-tabs">
          {CONFIG_TABS.map(item => (
            <button type="button" key={item.id} className={`tab ${configTab === item.id ? 'active' : ''}`} onClick={() => setConfigTab(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
        {(() => {
          const oauthOnlyTabs = new Set<ConfigTab>(['chatgpt', 'claude-cowork', 'perplexity']);
          if (!isOAuth && oauthOnlyTabs.has(configTab)) {
            const clientName = CONFIG_TABS.find(item => item.id === configTab)?.label ?? configTab;
            return (
              <div className="credential-unavailable-note">
                <b>{clientName} 需要 OAuth 客户端</b>
                <span>当前 Agent 使用 API Key，不能直接用于该客户端。请新建 OAuth 客户端后，在创建成功页下载包含真实密钥的 JSON。</span>
              </div>
            );
          }
          const selectedConfig = configSnippets[configTab];
          return (
            <>
              <div className="code-block agent-config-content">
                <pre>{selectedConfig}</pre>
                <CopyButton value={selectedConfig} />
              </div>
              <div className="agent-config-actions">
                {configTab === 'json' && (
                  <button type="button" className="btn btn-secondary" onClick={() => downloadJsonFile(selectedConfig, `${agentName}-pmbrain-template.json`)}>
                    下载 JSON 模板
                  </button>
                )}
              </div>
              <div className="credential-unavailable-note agent-template-note">
                <b>已有凭证的密钥不会再次显示</b>
                <span>这里的配置包含密钥占位符。请替换为创建时保存的密钥；如果密钥已丢失，请新建 Agent，并在创建成功页下载可直接使用的 JSON。</span>
              </div>
            </>
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
