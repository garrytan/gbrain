import { useEffect, useState } from 'react';
import { api } from '../api';
import type { GrantCatalog } from './ClientGrant';

export interface SetupArtifact {
  kind: 'oauth-client-setup' | 'machine-client-setup'; version: 1;
  mcp_url: string; issuer_url: string; scopes: string[]; harness: string;
  flow: 'authorization-code' | 'client-credentials'; instructions: string[];
  client: { client_id: string; client_name: string; redirect_uris: string[]; grant_types: string[]; token_endpoint_auth_method: string; client_secret?: string };
}

export function downloadPrivateJson(value: unknown, filename: string): void {
  const objectUrl = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = objectUrl; link.download = filename; link.click();
  URL.revokeObjectURL(objectUrl);
}

export function ClientSetup({ clientId, grantTypes, revoked = false, grantRevision }: { clientId: string; grantTypes: string[]; revoked?: boolean; grantRevision?: number }) {
  const [harness, setHarness] = useState('generic');
  const mixed = grantTypes.includes('authorization_code') && grantTypes.includes('client_credentials');
  const [flow, setFlow] = useState(mixed ? '' : grantTypes.includes('authorization_code') ? 'authorization-code' : 'client-credentials');
  const [catalog, setCatalog] = useState<GrantCatalog>();
  const [setup, setSetup] = useState<SetupArtifact>();
  const [instructions, setInstructions] = useState<string[]>([]);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [delivered, setDelivered] = useState(false); const [copied, setCopied] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (revoked) return;
    let active = true;
    setSetup(undefined); setInstructions([]); setError(''); setDelivered(false); setCopied(false);
    if (!flow) return;
    void Promise.all([api.clientSetup(clientId, harness, flow), api.grantCatalog()]).then(([result, nextCatalog]) => {
      if (!active) return;
      setSetup(result.setup); setInstructions(result.instructions); setCatalog(nextCatalog);
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Setup instructions are unavailable.'); });
    return () => { active = false; };
  }, [clientId, harness, flow, revoked, grantRevision, refresh]);
  const download = async () => {
    if (!setup) return;
    setBusy(true); setError('');
    try {
      // Secret retrieval is explicit. Ordinary setup GETs contain no credentials.
      const result = await api.recoverClient(clientId, harness, flow);
      const artifact = flow === 'authorization-code' ? result.oauthSetup : result.credentials;
      if (!artifact) throw new Error('No matching setup file was returned. Ask the host administrator to inspect this client’s credential delivery.');
      downloadPrivateJson(artifact, `${clientId}-${flow === 'authorization-code' ? 'oauth-setup' : 'credentials'}.json`);
      setDelivered(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Download failed. Existing permissions are unchanged.'); }
    finally { setBusy(false); }
  };
  return <section aria-labelledby="client-setup-title">
    <h3 id="client-setup-title" className="section-title">Set up this client</h3>
    {revoked ? <p>This client is revoked. Register a new client to connect another harness.</p> : <>
      <p className="grant-help">Registration grants access. Configure the intended harness, then verify an actual memory round trip there.</p>
      <label htmlFor="setup-harness">Harness</label>
      <select id="setup-harness" value={harness} onChange={event => setHarness(event.target.value)} disabled={busy}>
        {!catalog && <option value="generic">Generic MCP client</option>}
        {catalog?.harnesses.map(adapter => <option key={adapter.id} value={adapter.id}>{adapter.label}</option>)}
      </select>
      {mixed && <>
        <label htmlFor="setup-flow">Connection flow</label><select id="setup-flow" value={flow} onChange={event => setFlow(event.target.value)} disabled={busy}>
          <option value="">Choose the flow supported by your harness</option>
          <option value="authorization-code">Browser sign-in with PKCE</option><option value="client-credentials">Machine credentials</option>
        </select>
      </>}
      {setup && <>
        <dl className="oauth-consent-details" style={{ marginTop: 16 }}>
          <dt>MCP URL</dt><dd><code>{setup.mcp_url}</code></dd>
          <dt>OAuth issuer</dt><dd><code>{setup.issuer_url}</code></dd>
          <dt>Client ID</dt><dd><code>{setup.client.client_id}</code></dd>
          <dt>Scopes</dt><dd>{setup.scopes.join(' ') || 'None'}</dd>
          <dt>Authentication</dt><dd>{setup.client.token_endpoint_auth_method === 'none' ? 'Public client — PKCE, no client secret' : setup.client.token_endpoint_auth_method}</dd>
          {setup.flow === 'authorization-code' && <><dt>Redirect URIs</dt><dd>{setup.client.redirect_uris.map(uri => <div key={uri}><code>{uri}</code></div>)}</dd></>}
        </dl>
        <ol>{instructions.map((instruction, index) => <li key={index} style={{ marginBottom: 8, overflowWrap: 'anywhere' }}>{instruction}</li>)}</ol>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
          <button type="button" className="btn btn-secondary" onClick={() => {
            void navigator.clipboard.writeText(instructions.join('\n')).then(() => setCopied(true)).catch(() => setError('Clipboard unavailable. Select and copy the instructions above.'));
          }}>{copied ? 'Instructions copied' : 'Copy setup instructions'}</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void download()}>{busy ? 'Preparing download…' : setup.flow === 'authorization-code' ? 'Download OAuth setup' : 'Download credentials'}</button>
        </div>
        <p className="grant-help">Keep downloaded files private. Set permissions to 0600 on the target computer. A setup download does not verify the harness.</p>
      </>}
      {!flow && <p role="status">This client supports both flows. Choose one before requesting setup instructions.</p>}
      {flow && !setup && !error && <p role="status">Loading setup instructions…</p>}
      {delivered && <p role="status">Setup file delivered to your browser. Harness verification is still required.</p>}
      {error && <p role="alert" style={{ color: 'var(--error)' }}>{error} <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setRefresh(value => value + 1)}>Retry setup</button></p>}
    </>}
  </section>;
}
