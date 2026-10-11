import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { clearOAuthRequest, pendingOAuthRequest } from '../lib/oauth-request';

interface ConsentRequest {
  id: string; clientId: string; clientName: string; redirectUri: string;
  scopes: string[]; sourceId: string | null; allowedSources: string[];
  allowedOperations: string[] | null; boundSlugPrefixes: string[] | null;
  delegatedTools: string[] | null; delegatedSlugPrefixes: string[] | null; delegatedNamespace: string | null;
  resource: string | null; expiresAt: number; csrf: string;
  sourceChoice: { editable: boolean; options: Array<{ id: string; name: string }> };
}

export function OAuthConsentPage() {
  const [request, setRequest] = useState<ConsentRequest>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sourceId, setSourceId] = useState('');
  useEffect(() => {
    let active = true;
    const id = pendingOAuthRequest();
    if (!id) { setError('No pending authorization request. Restart the connection from your client.'); return; }
    api.oauthRequest(id).then((value: ConsentRequest) => { if (active) { setRequest(value); setSourceId(value.sourceId ?? ''); } })
      .catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, []);
  const decide = async (decision: 'approve' | 'deny') => {
    if (!request || busy) return;
    setBusy(true);
    setError('');
    try {
      const chosen = decision === 'approve' && request.sourceChoice.editable && sourceId !== request.sourceId ? sourceId : undefined;
      const result = await api.decideOAuthRequest(request.id, decision, request.csrf, chosen);
      clearOAuthRequest();
      window.location.assign(result.redirectUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approval failed. Restart the connection from your client.');
      setRequest(undefined); // do not retry a potentially committed approval
      setBusy(false);
    }
  };
  return <section aria-labelledby="consent-title" style={{ maxWidth: 760 }}>
    <h1 id="consent-title">Approve client access</h1>
    <p style={{ color: 'var(--text-secondary)', margin: '16px 0' }}>Only approve a connection you initiated. These permissions let the client act on your brain.</p>
    {error && <div role="alert" className="login-error" style={{ marginBottom: 16 }}>{error}</div>}
    {!request && !error && <p role="status">Loading authorization request…</p>}
    {request && <>
      <dl className="oauth-consent-details">
        <dt>Client</dt><dd>{request.clientName}</dd>
        <dt>Client ID</dt><dd><code>{request.clientId}</code></dd>
        <dt>Redirect destination</dt><dd><code>{request.redirectUri}</code></dd>
        <dt>Permissions</dt><dd>{request.scopes.length ? request.scopes.map(scope => <span key={scope} className={`badge ${scope.includes('admin') ? 'badge-error' : ''}`} style={{ marginRight: 8 }}>{scope}</span>) : 'No permissions'}</dd>
        <dt>Administrative brain operations</dt><dd>{request.scopes.some(scope => scope === 'admin') ? 'Eligible operations within the grant below. This does not grant owner dashboard access.' : request.scopes.some(scope => scope.endsWith('_admin')) ? 'The named administrative brain operations. This does not grant owner dashboard access.' : 'None'}</dd>
        <dt>Allowed operations</dt><dd>{request.allowedOperations === null ? 'All operations permitted by these scopes and the server policy' : request.allowedOperations.join(', ') || 'None'}</dd>
        <dt>Write paths</dt><dd>{request.boundSlugPrefixes === null ? 'Within the granted source' : request.boundSlugPrefixes.join(', ') || 'None'}</dd>
        {request.scopes.includes('agent') && <>
          <dt>Delegated tools</dt><dd>{request.delegatedTools?.join(', ') || 'None'}</dd>
          <dt>Delegated write paths</dt><dd>{request.delegatedNamespace === 'job' ? 'A separate namespace for each job' : request.delegatedSlugPrefixes?.join(', ') || 'None'}</dd>
        </>}
        {request.sourceChoice.editable ? <>
          <dt><label htmlFor="consent-source">Write source</label></dt>
          <dd>
            <select id="consent-source" value={sourceId} disabled={busy} onChange={event => setSourceId(event.target.value)}>
              {request.sourceChoice.options.map(option => <option key={option.id} value={option.id}>{option.name === option.id ? option.id : `${option.name} (${option.id})`}</option>)}
            </select>
            <div style={{ color: 'var(--text-secondary)', marginTop: 4 }}>This client reads and writes only this source. Change it later on the Agents page or with <code>gbrain auth rescope --client</code>.</div>
          </dd>
          <dt>Read sources</dt><dd>{sourceId}</dd>
        </> : <>
          <dt>Write source</dt><dd>{request.sourceId ?? 'Not configured'}</dd>
          <dt>Read sources</dt><dd>{request.allowedSources.length ? request.allowedSources.join(', ') : request.sourceId ?? 'Not configured'}</dd>
        </>}
        <dt>Resource</dt><dd><code>{request.resource ?? 'No resource binding requested'}</code></dd>
        <dt>Request expires</dt><dd>{new Date(request.expiresAt).toLocaleTimeString()}</dd>
      </dl>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 24 }}>
        <button className="btn" disabled={busy} onClick={() => decide('deny')}>Deny</button>
        <button className="btn btn-primary" disabled={busy} onClick={() => decide('approve')}>{busy ? 'Completing request…' : 'Approve access'}</button>
      </div>
    </>}
    {error && <button className="btn" onClick={() => { clearOAuthRequest(); window.location.hash = 'agents'; }}>Return to agents</button>}
  </section>;
}
