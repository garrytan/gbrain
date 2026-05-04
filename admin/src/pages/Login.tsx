import React, { useState } from 'react';
import { api } from '../api';

// v0.26.3 trust model (D11 + D12):
// - The bootstrap token is NEVER stored in browser JS state. No
//   localStorage, no sessionStorage, no React state beyond the form
//   submit cycle. After successful POST /admin/login the operator's
//   token only lives in the HttpOnly cookie that the server set.
// - Magic-link URLs use single-use server-issued nonces, not the
//   bootstrap token itself (see /admin/api/issue-magic-link). The
//   bootstrap token never appears in a URL.
// - Closing the tab ends the session client-side. Reopening the
//   dashboard 401s and shows this page again. Operator asks the agent
//   for a fresh magic link or pastes the bootstrap token from the
//   server's terminal scrollback.
export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.login(token);
      // Don't persist the token. The HttpOnly cookie is the only
      // session credential after this point.
      setToken('');
      onLogin();
    } catch (err) {
      setError('Invalid token.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-box">
        <div className="login-logo">GBrain</div>

        <div style={{
          background: 'rgba(136, 170, 255, 0.08)',
          border: '1px solid rgba(136, 170, 255, 0.2)',
          borderRadius: 8,
          padding: '14px 16px',
          marginBottom: 20,
          fontSize: 13,
          lineHeight: 1.5,
          color: 'var(--text-secondary)',
        }}>
          <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
            🔒 This is a protected dashboard
          </div>
          Ask your AI agent for the admin login link:
          <div style={{
            background: 'rgba(0,0,0,0.3)',
            borderRadius: 6,
            padding: '8px 12px',
            marginTop: 8,
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: '#88aaff',
            wordBreak: 'break-all',
          }}>
            "Give me the GBrain admin login link"
          </div>
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>
            Each link is single-use. Your agent generates a fresh one each time.
          </div>
        </div>

        <details style={{ marginBottom: 16 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--text-muted)' }}>
            Or paste bootstrap token manually
          </summary>
          <form onSubmit={handleSubmit} style={{ marginTop: 12 }}>
            <div style={{ marginBottom: 12 }}>
              <input
                type="password"
                placeholder="Admin Token"
                value={token}
                onChange={e => setToken(e.target.value)}
              />
            </div>
            <button className="btn btn-primary" style={{ width: '100%' }} disabled={loading}>
              {loading ? 'Authenticating...' : 'Submit'}
            </button>
            {error && <div className="login-error">{error}</div>}
          </form>
        </details>
      </div>
    </div>
  );
}
