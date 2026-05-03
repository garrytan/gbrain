import React, { useState } from 'react';
import { api } from '../api';

export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [autoLogging, setAutoLogging] = useState(true);

  // Auto-login with saved token on mount
  React.useEffect(() => {
    const saved = localStorage.getItem('gbrain_admin_token');
    if (saved) {
      api.login(saved).then(() => {
        onLogin();
      }).catch(() => {
        localStorage.removeItem('gbrain_admin_token');
        setAutoLogging(false);
      });
    } else {
      setAutoLogging(false);
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.login(token);
      localStorage.setItem('gbrain_admin_token', token);
      onLogin();
    } catch (err) {
      setError('Invalid token.');
    } finally {
      setLoading(false);
    }
  };

  if (autoLogging) {
    return (
      <div className="login-page">
        <div className="login-box" style={{ textAlign: 'center' }}>
          <div className="login-logo">GBrain</div>
          <div style={{ color: 'var(--text-secondary)' }}>Authenticating...</div>
        </div>
      </div>
    );
  }

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
            Your agent will generate a secure one-click URL that logs you in automatically.
          </div>
        </div>

        <details style={{ marginBottom: 16 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--text-muted)' }}>
            Or paste token manually
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
