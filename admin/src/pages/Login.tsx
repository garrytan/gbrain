import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { ownerLoginPrompt, pendingOAuthRequest } from '../lib/oauth-request';

// The bootstrap credential is transient form state only. The server sets an
// HttpOnly session cookie; browser storage never holds the owner credential.
export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [token, setToken] = useState(''); const [error, setError] = useState('');
  const [loading, setLoading] = useState(false); const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [mcpUrl, setMcpUrl] = useState<string>();
  const [discoveryError, setDiscoveryError] = useState(''); const [discoveryAttempt, setDiscoveryAttempt] = useState(0);
  const requestId = pendingOAuthRequest();
  const prompt = mcpUrl ? ownerLoginPrompt(mcpUrl, requestId) : undefined;
  useEffect(() => {
    let active = true; const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    setMcpUrl(undefined); setDiscoveryError(''); setCopied(false);
    void fetch('/.well-known/gbrain', { credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('Server discovery is unavailable.');
        const info = await response.json();
        if (typeof info?.endpoint !== 'string') throw new Error('Server discovery has no MCP endpoint.');
        const endpoint = new URL(info.endpoint);
        if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/mcp') {
          throw new Error('Server discovery returned an invalid MCP endpoint.');
        }
        if (active) setMcpUrl(endpoint.toString());
      }).catch(() => {
        if (active) setDiscoveryError('The configured MCP endpoint could not be discovered. Ask the brain host administrator to check the server’s configured public URL. You can still sign in with the owner credential below.');
      }).finally(() => clearTimeout(timeout));
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [discoveryAttempt]);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setLoading(true);
    try { await api.login(token); setToken(''); onLogin(); }
    catch (cause) {
      setError(cause instanceof ApiError && cause.status === 401
        ? 'The owner bootstrap credential was not accepted. An OAuth access token or client secret cannot log into this dashboard. Ask the brain host administrator for a fresh login link.'
        : cause instanceof Error ? cause.message : 'Could not reach the owner login service. Check the server and retry.');
    } finally { setLoading(false); }
  };
  return <div className="login-page"><section className="login-box" aria-labelledby="owner-login-title" style={{ maxWidth: 560 }}>
    <h1 id="owner-login-title" className="login-logo">GBrain owner login</h1>
    <p style={{ marginBottom: 16 }}>Ask the agent that administers the brain host for a login link. Ordinary MCP clients cannot create owner login links, even with an admin scope.</p>
    {requestId && <p role="status" style={{ marginBottom: 16 }}>A client connection is waiting for owner approval. The prompt below preserves that request when you open the login link in another browser or tab.</p>}
    {prompt && <><label htmlFor="owner-login-prompt">Prompt for the host administrator</label>
    <textarea id="owner-login-prompt" rows={7} readOnly value={prompt} style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }} />
    <button type="button" className="btn btn-secondary" style={{ marginTop: 8 }} onClick={() => {
      setCopyError('');
      void navigator.clipboard.writeText(prompt).then(() => setCopied(true)).catch(() => setCopyError('Clipboard unavailable. Select and copy the prompt above.'));
    }}>{copied ? 'Prompt copied' : 'Copy owner login prompt'}</button></>}
    {!prompt && !discoveryError && <p role="status">Discovering the server’s configured MCP endpoint…</p>}
    {discoveryError && <p role="alert">{discoveryError} <button type="button" className="btn btn-secondary" onClick={() => setDiscoveryAttempt(attempt => attempt + 1)}>Retry server discovery</button></p>}
    {copyError && <p role="alert">{copyError}</p>}
    <p className="grant-help" style={{ margin: '12px 0 20px' }}>Login links expire after five minutes and can be used once. A client’s PKCE sign-in requests access to memory; owner login approves that request.</p>
    <details>
      <summary style={{ cursor: 'pointer' }}>Sign in with the owner bootstrap credential</summary>
      <form onSubmit={submit} style={{ marginTop: 12 }}>
        <label htmlFor="owner-bootstrap-token">Owner bootstrap credential</label>
        <input id="owner-bootstrap-token" type="password" autoComplete="off" value={token} disabled={loading} onChange={event => setToken(event.target.value)} />
        <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: 12 }} disabled={loading || !token.trim()}>{loading ? 'Signing in…' : 'Sign in as owner'}</button>
        {error && <p role="alert" className="login-error">{error}</p>}
      </form>
    </details>
  </section></div>;
}
