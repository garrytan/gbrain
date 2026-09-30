import { useState, useEffect, useRef, type FormEvent } from 'react';
import { api, ApiError, mutationOutcomeUnknown } from '../api';
import { ClientGrantEditor, GrantFields, GrantPreview, grantDraft, grantRequest, reviewedGrantRequest, type Grant, type GrantCatalog, type GrantPreviewResult } from '../components/ClientGrant';
import { ClientSetup } from '../components/ClientSetup';
import { ClientLifecycle } from '../components/ClientLifecycle';
import { Dialog } from '../components/Dialog';
import { oauthRegistrationRequest, type ConnectionKind, type OAuthRegistrationDraft } from '../lib/oauth-registration';

interface Agent {
  id: string; name: string; auth_type: 'oauth' | 'api_key'; client_id?: string; client_name?: string;
  grant_types: string[]; scope: string; source_id: string | null; federated_read: string[];
  created_at: string; last_used_at: string | null; total_requests: number; requests_today: number;
  token_ttl: number | null; status: 'active' | 'revoked';
}
interface Source { id: string; name: string; federated: boolean }
interface RegisteredClient { clientId: string; name: string; grantTypes: string[] }
function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  return Math.floor(seconds / 86400) + 'd ago';
}

export function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]); const [sources, setSources] = useState<Source[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false); const [sourcesReady, setSourcesReady] = useState(false);
  const [agentsError, setAgentsError] = useState(''); const [sourcesError, setSourcesError] = useState('');
  const [loadingAgents, setLoadingAgents] = useState(true); const [loadingSources, setLoadingSources] = useState(true);
  const [hideRevoked, setHideRevoked] = useState(false);
  const [showRegister, setShowRegister] = useState(false); const [registered, setRegistered] = useState<RegisteredClient>();
  const [selectedAgent, setSelectedAgent] = useState<Agent>();
  const [showApiKeyCreate, setShowApiKeyCreate] = useState(false);
  const [apiKeyToken, setApiKeyToken] = useState<{ name: string; token: string }>();
  const agentsRequest = useRef(0); const sourcesRequest = useRef(0);
  const loadAgents = async () => {
    const request = ++agentsRequest.current; setLoadingAgents(true);
    try {
      const rows = await api.agents();
      if (request !== agentsRequest.current) return;
      setAgents(rows); setAgentsLoaded(true); setAgentsError('');
    } catch (cause) { if (request === agentsRequest.current) setAgentsError(cause instanceof Error ? cause.message : 'Clients are unavailable.'); }
    finally { if (request === agentsRequest.current) setLoadingAgents(false); }
  };
  const loadSources = async () => {
    const request = ++sourcesRequest.current; setLoadingSources(true);
    try {
      const rows = await api.sources();
      if (request !== sourcesRequest.current) return;
      setSources(rows); setSourcesReady(true); setSourcesError('');
    } catch (cause) { if (request === sourcesRequest.current) { setSourcesReady(false); setSourcesError(cause instanceof Error ? cause.message : 'Sources are unavailable.'); } }
    finally { if (request === sourcesRequest.current) setLoadingSources(false); }
  };
  useEffect(() => {
    void loadAgents(); void loadSources();
    return () => { agentsRequest.current++; sourcesRequest.current++; };
  }, []);
  const visibleAgents = agents.filter(agent => !hideRevoked || agent.status !== 'revoked');
  return <>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 24 }}>
      <h1 className="page-title" style={{ marginBottom: 0 }}>Agents</h1>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <label className="checkbox-label"><input type="checkbox" checked={hideRevoked} onChange={event => setHideRevoked(event.target.checked)} />Hide revoked</label>
        <button type="button" className="btn btn-secondary" disabled={loadingAgents} onClick={() => void loadAgents()}>Refresh clients</button>
        <button type="button" className="btn btn-secondary" onClick={() => setShowApiKeyCreate(true)}>+ API Key</button>
        <button type="button" className="btn btn-primary" disabled={!sourcesReady || !sources.length || loadingSources} onClick={() => setShowRegister(true)}>+ OAuth Client</button>
      </div>
    </div>
    <p className="grant-help" style={{ marginBottom: 16 }}>Owner administration uses this dashboard’s login. An OAuth client’s admin scope allows eligible brain operations; it does not open this dashboard.</p>
    {agentsError && <p role="alert" style={{ marginBottom: 16, color: 'var(--error)' }}>{agentsLoaded ? 'Showing previously loaded clients. ' : 'Could not load clients. '}{agentsError} <button type="button" className="btn btn-secondary" disabled={loadingAgents} onClick={() => void loadAgents()}>Retry clients</button></p>}
    {sourcesError && <p role="alert" style={{ marginBottom: 16, color: 'var(--error)' }}>Could not load current sources. Registration and permission changes are unavailable. {sourcesError} <button type="button" className="btn btn-secondary" disabled={loadingSources} onClick={() => void loadSources()}>Retry sources</button></p>}
    {!sourcesError && !sourcesReady && <p role="status">Loading sources before registration…</p>}
    {sourcesReady && !sources.length && <p role="status">No active sources are available. Add or unarchive a source on the host before registering a client.</p>}
    {!agentsLoaded && !agentsError && <p role="status">Loading clients…</p>}
    {agentsLoaded && !agents.length && <p style={{ textAlign: 'center', padding: 48 }}>No clients registered. Register a client to grant access to a harness.</p>}
    {agentsLoaded && agents.length > 0 && !visibleAgents.length && <p style={{ textAlign: 'center', padding: 48 }}>All clients are revoked. Uncheck “Hide revoked” to view them.</p>}
    {visibleAgents.length > 0 && <div style={{ overflowX: 'auto' }}><table>
      <thead><tr><th>Name</th><th>Type</th><th>Scopes</th><th>Sources</th><th>Status</th><th>Requests</th><th>Last used</th></tr></thead>
      <tbody>{visibleAgents.map(agent => <tr key={agent.auth_type + ':' + agent.id} onClick={() => setSelectedAgent(agent)} style={{ cursor: 'pointer' }}>
        <td><button type="button" className="client-name-button" onClick={event => { event.stopPropagation(); setSelectedAgent(agent); }}>{agent.name || agent.client_name}</button></td>
        <td><span className={'badge ' + (agent.auth_type === 'oauth' ? 'badge-read' : 'badge-write')}>{agent.auth_type === 'oauth' ? 'OAuth' : 'API key'}</span></td>
        <td>{(agent.scope || '').split(' ').filter(Boolean).map(scope => <span key={scope} className={'badge badge-' + scope} style={{ marginRight: 4 }}>{scope}</span>)}</td>
        <td>{agent.auth_type === 'oauth' ? (agent.source_id || 'none') + ' · ' + (agent.federated_read || []).length + ' readable' : 'Unscoped'}</td>
        <td><span className={'badge ' + (agent.status === 'active' ? 'badge-success' : 'badge-danger')}>{agent.status}</span></td>
        <td>{agent.requests_today || 0}<span style={{ color: 'var(--text-muted)' }}> / {agent.total_requests || 0}</span></td>
        <td>{agent.last_used_at ? timeAgo(new Date(agent.last_used_at)) : 'Never'}</td>
      </tr>)}</tbody>
    </table><p className="grant-help" style={{ marginTop: 12 }}>{agents.filter(agent => agent.status === 'active').length} active / {agents.length} total</p></div>}
    {showRegister && <RegisterModal sources={sources} sourcesReady={sourcesReady} onClose={() => setShowRegister(false)} onRegistered={client => { setShowRegister(false); setRegistered(client); void loadAgents(); }} />}
    {registered && <Dialog title="Client registered" titleId="registered-client-title" onClose={() => setRegistered(undefined)}>
      <p role="status" style={{ marginBottom: 16 }}>{registered.name} is registered. Its harness connection has not been verified.</p>
      <ClientSetup clientId={registered.clientId} grantTypes={registered.grantTypes} />
    </Dialog>}
    {selectedAgent && <AgentDrawer key={selectedAgent.id} agent={selectedAgent} sources={sources} sourcesReady={sourcesReady} onClose={() => setSelectedAgent(undefined)}
      onChanged={() => { setSelectedAgent(undefined); void loadAgents(); }} onRescoped={grant => { setSelectedAgent(current => current ? { ...current, source_id: grant.sourceId, federated_read: grant.federatedRead, scope: grant.scopes.join(' '), token_ttl: grant.tokenTtlSeconds } : current); void loadAgents(); }} />}
    {showApiKeyCreate && <ApiKeyCreateModal onClose={() => setShowApiKeyCreate(false)} onCreated={token => { setShowApiKeyCreate(false); setApiKeyToken(token); void loadAgents(); }} />}
    {apiKeyToken && <ApiKeyTokenModal token={apiKeyToken} onClose={() => setApiKeyToken(undefined)} />}
  </>;
}

function RegisterModal({ sources, sourcesReady, onClose, onRegistered }: { sources: Source[]; sourcesReady: boolean; onClose: () => void; onRegistered: (client: RegisteredClient) => void }) {
  const [name, setName] = useState(''); const [draft, setDraft] = useState(() => grantDraft());
  const [connection, setConnection] = useState<OAuthRegistrationDraft>({ kind: 'machine', redirectUris: '', confidentialMethod: 'client_secret_post' });
  const [catalog, setCatalog] = useState<GrantCatalog>(); const [catalogError, setCatalogError] = useState('');
  const [preview, setPreview] = useState<{ grant: GrantPreviewResult; oauth: ReturnType<typeof oauthRegistrationRequest>; name: string }>();
  const [loading, setLoading] = useState(false); const [error, setError] = useState('');
  const [recovery, setRecovery] = useState<RegisteredClient>(); const [uncertain, setUncertain] = useState(false);
  const loadCatalog = () => { setCatalogError(''); void api.grantCatalog().then(setCatalog).catch(cause => setCatalogError(cause instanceof Error ? cause.message : 'Permission catalog unavailable.')); };
  useEffect(loadCatalog, []);
  const changeConnection = (next: OAuthRegistrationDraft) => { setConnection(next); setPreview(undefined); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!sourcesReady || !catalog || uncertain) return;
    if (!name.trim()) { setError('Enter a client name.'); return; }
    setLoading(true); setError('');
    try {
      const oauth = preview?.oauth ?? oauthRegistrationRequest(connection);
      const submittedName = preview?.name ?? name.trim();
      const result = await api.registerClient({ ...(preview ? reviewedGrantRequest(preview.grant.after) : grantRequest(draft)), ...oauth, name: submittedName, dryRun: !preview });
      if (!preview) setPreview({ grant: result, oauth, name: submittedName });
      else onRegistered({ clientId: result.clientId, name: submittedName, grantTypes: oauth.grantTypes });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Registration failed.');
      const unknown = !!preview && mutationOutcomeUnknown(cause);
      setUncertain(unknown);
      if (preview && (unknown || (cause instanceof ApiError && cause.status === 409))) {
        // A lost mutation response can follow a committed registration. Do not create twice.
        try {
          const rows = (await api.agents() as Agent[]).filter(agent => agent.auth_type === 'oauth' && agent.status === 'active' && (agent.name || agent.client_name) === preview.name);
          if (rows.length === 1) {
            setRecovery({ clientId: rows[0].id || rows[0].client_id!, name: preview.name, grantTypes: rows[0].grant_types });
            setUncertain(true);
          }
        } catch { /* Show the uncertain result and require client-list reconciliation. */ }
      }
      setPreview(undefined);
    } finally { setLoading(false); }
  };
  return <Dialog title="Register OAuth client" titleId="register-client-title" onClose={onClose} busy={loading}>
    <form onSubmit={submit}>
      <fieldset disabled={loading || uncertain} style={{ border: 0, padding: 0 }}>
        <label htmlFor="agent-name">Client name</label><input id="agent-name" data-autofocus value={name} placeholder="agent-example" onChange={event => { setName(event.target.value); setPreview(undefined); }} />
        <label htmlFor="oauth-connection-kind" style={{ marginTop: 16 }}>Connection type</label>
        <select id="oauth-connection-kind" value={connection.kind} onChange={event => changeConnection({ ...connection, kind: event.target.value as ConnectionKind })}>
          <option value="machine">Machine credentials</option><option value="public-pkce">Browser sign-in: public client with PKCE</option><option value="confidential-pkce">Browser sign-in: confidential client with PKCE</option>
        </select>
        <p className="grant-help">Choose the method required by your MCP client. Browser sign-in requires the owner’s approval. Public clients use PKCE without a client secret.</p>
        {connection.kind !== 'machine' && <><label htmlFor="oauth-redirect-uris">Exact redirect URIs (one per line)</label>
          <textarea id="oauth-redirect-uris" rows={3} value={connection.redirectUris} onChange={event => changeConnection({ ...connection, redirectUris: event.target.value })} placeholder="https://client.example.com/oauth/callback" />
          <p className="grant-help">Copy these from the client’s OAuth settings. Keep the complete path and query. GBrain uses S256 PKCE.</p></>}
        {connection.kind === 'confidential-pkce' && <><label htmlFor="oauth-client-auth">Client secret authentication</label>
          <select id="oauth-client-auth" value={connection.confidentialMethod} onChange={event => changeConnection({ ...connection, confidentialMethod: event.target.value as OAuthRegistrationDraft['confidentialMethod'] })}>
            <option value="client_secret_post">client_secret_post (request body)</option><option value="client_secret_basic">client_secret_basic (HTTP Basic)</option>
          </select></>}
        {connection.kind === 'machine' && <p className="grant-help">Machine handoffs use client_secret_post to renew their access tokens.</p>}
        <div style={{ marginTop: 24 }}>{catalog && <GrantFields draft={draft} setDraft={next => { setDraft(next); setPreview(undefined); }} catalog={catalog} sources={sources} />}</div>
      </fieldset>
      {catalogError && <p role="alert" style={{ color: 'var(--error)' }}>{catalogError} <button type="button" className="btn btn-secondary" onClick={loadCatalog}>Retry permissions</button></p>}
      {!sourcesReady && <p role="alert">Current sources are unavailable. Close this form and retry sources before registration.</p>}
      {preview && <><GrantPreview preview={preview.grant} /><div aria-live="polite"><h3>Review connection</h3>
        <dl className="oauth-consent-details"><dt>Client name</dt><dd>{preview.name}</dd><dt>Grant types</dt><dd>{preview.oauth.grantTypes.join(', ')}</dd><dt>Authentication</dt><dd>{preview.oauth.tokenEndpointAuthMethod}</dd>
          {preview.oauth.redirectUris.length > 0 && <><dt>Exact redirect URIs</dt><dd>{preview.oauth.redirectUris.map(uri => <div key={uri}><code>{uri}</code></div>)}</dd></>}
        </dl></div></>}
      {error && <p role="alert" style={{ color: 'var(--error)', margin: '16px 0' }}>{error}</p>}
      {recovery && <div role="status"><p>A client named {recovery.name} is registered. Open its setup instructions and recover its existing download.</p>
        <button type="button" className="btn btn-secondary" onClick={() => onRegistered(recovery)}>Open existing client setup</button></div>}
      {uncertain && !recovery && <p role="status">Registration may have completed. Close this form and refresh clients before trying again. No automatic retry was made.</p>}
      <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 20 }}>
        <button type="button" className="btn btn-secondary" disabled={loading} onClick={onClose}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={loading || !catalog || !sourcesReady || uncertain}>{loading ? 'Checking…' : preview ? 'Register with reviewed permissions' : 'Preview permissions'}</button>
      </div>
    </form>
  </Dialog>;
}

function AgentDrawer({ agent, sources, sourcesReady, onClose, onChanged, onRescoped }: { agent: Agent; sources: Source[]; sourcesReady: boolean; onClose: () => void; onChanged: () => void; onRescoped: (grant: Grant) => void }) {
  const clientId = agent.id || agent.client_id || ''; const name = agent.name || agent.client_name || clientId;
  const [detail, setDetail] = useState<{ client: { grant_types: string[]; token_endpoint_auth_method: string; redirect_uris: string[] }; grant: Grant }>();
  const [error, setError] = useState(''); const [reload, setReload] = useState(0);
  const [confirmApiKeyRevoke, setConfirmApiKeyRevoke] = useState(false); const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (agent.auth_type !== 'oauth') return;
    let active = true; setError('');
    void api.clientDetails(clientId).then(value => { if (active) setDetail(value); }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Client details unavailable.'); });
    return () => { active = false; };
  }, [clientId, agent.auth_type, reload]);
  return <Dialog title={name} titleId="client-details-title" onClose={onClose} drawer busy={busy}>
    <span className={'badge ' + (agent.status === 'active' ? 'badge-success' : 'badge-danger')}>{agent.status}</span>
    <dl className="oauth-consent-details" style={{ marginTop: 16 }}><dt>Client ID</dt><dd><code>{clientId}</code></dd><dt>Scopes</dt><dd>{agent.scope || 'None'}</dd>
      <dt>Registered</dt><dd>{new Date(agent.created_at).toLocaleString()}</dd><dt>Token lifetime</dt><dd>{agent.token_ttl ? agent.token_ttl + ' seconds' : 'Server default (future tokens)'}</dd>
      {detail && <><dt>Grant types</dt><dd>{detail.client.grant_types.join(', ')}</dd><dt>Authentication</dt><dd>{detail.client.token_endpoint_auth_method}</dd></>}
    </dl>
    {agent.auth_type === 'oauth' ? <>
      {error && <p role="alert" style={{ color: 'var(--error)' }}>{error} <button type="button" className="btn btn-secondary" onClick={() => setReload(value => value + 1)}>Retry client details</button></p>}
      {!detail && !error && <p role="status">Loading client details…</p>}
      {detail && <>
        <ClientSetup clientId={clientId} grantTypes={detail.client.grant_types} revoked={agent.status === 'revoked'} grantRevision={detail.grant.revision} />
        {agent.status === 'active' && <details style={{ marginTop: 24 }}><summary style={{ cursor: 'pointer', fontWeight: 600 }}>Edit access levels</summary>
          <ClientGrantEditor clientId={clientId} sources={sources} sourcesReady={sourcesReady} onRescoped={grant => {
            setDetail(current => current ? { ...current, grant } : current);
            onRescoped(grant);
          }} />
        </details>}
        <ClientLifecycle clientId={clientId} name={name} revoked={agent.status === 'revoked'} onChanged={onChanged} onBusyChange={setBusy} />
      </>}
    </> : <>
      <h3 className="section-title">API key</h3><p>Use this key as a bearer token in a client that supports static authentication. Its value is available only in the original private handoff.</p>
      {agent.status === 'active' && <div style={{ marginTop: 20 }}>
        {!confirmApiKeyRevoke ? <button type="button" className="btn btn-secondary" onClick={() => setConfirmApiKeyRevoke(true)}>Revoke API key</button> : <>
          <p>Revoke all active API keys named {name}? Keys with the same name will stop working. Memory remains.</p>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setConfirmApiKeyRevoke(false)}>Cancel</button>{' '}
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => { setBusy(true); void api.revokeApiKey(name).then(onChanged).catch(cause => setError(cause instanceof Error ? cause.message : 'Revoke failed. Refresh the client list before retrying.')).finally(() => setBusy(false)); }}>Confirm revoke</button>
        </>}
        {error && <p role="alert">{error}</p>}
      </div>}
    </>}
  </Dialog>;
}

function ApiKeyCreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: (result: { name: string; token: string }) => void }) {
  const [name, setName] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!name.trim()) { setError('Enter a key name.'); return; }
    setBusy(true); setError('');
    try { const result = await api.createApiKey(name.trim()); onCreated({ name: result.name, token: result.token }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Key creation failed. Inspect the clients list before retrying.'); }
    finally { setBusy(false); }
  };
  return <Dialog title="Create API key" titleId="create-api-key-title" onClose={onClose} busy={busy}><form onSubmit={submit}>
    <p className="grant-help">API keys created here allow full read, write, and admin brain operations. Choose an OAuth client for scoped access. This key cannot log into the owner dashboard.</p>
    <label htmlFor="api-key-name">Key name</label><input id="api-key-name" data-autofocus value={name} disabled={busy} onChange={event => setName(event.target.value)} />
    {error && <p role="alert">{error}</p>}<div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 20 }}>
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Creating…' : 'Create key'}</button>
    </div></form></Dialog>;
}

function ApiKeyTokenModal({ token, onClose }: { token: { name: string; token: string }; onClose: () => void }) {
  const [copied, setCopied] = useState(false); const [error, setError] = useState('');
  return <Dialog title="API key created" titleId="api-key-created-title" onClose={onClose}>
    <p>{token.name}</p><label htmlFor="new-api-key">Bearer token</label><textarea id="new-api-key" rows={3} readOnly value={token.token} />
    <p className="grant-help">Save this token privately now. It will not be shown again. A key’s creation does not verify your harness connection.</p>
    <button type="button" className="btn btn-secondary" onClick={() => { void navigator.clipboard.writeText(token.token).then(() => setCopied(true)).catch(() => setError('Clipboard unavailable. Select and copy the token above.')); }}>{copied ? 'Copied' : 'Copy token'}</button>
    {error && <p role="alert">{error}</p>}<button type="button" className="btn btn-primary" style={{ marginLeft: 12 }} onClick={onClose}>Done</button>
  </Dialog>;
}
