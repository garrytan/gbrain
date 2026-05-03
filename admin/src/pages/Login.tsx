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
        // Saved token expired or server restarted with new token
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
      setError('Invalid token. Check your terminal output.');
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
      <form className="login-box" onSubmit={handleSubmit}>
        <div className="login-logo">GBrain</div>
        <div style={{ marginBottom: 16 }}>
          <input
            type="password"
            placeholder="Admin Token"
            value={token}
            onChange={e => setToken(e.target.value)}
            autoFocus
          />
        </div>
        <button className="btn btn-primary" style={{ width: '100%' }} disabled={loading}>
          {loading ? 'Authenticating...' : 'Submit'}
        </button>
        {error && <div className="login-error">{error}</div>}
        <div className="login-hint">Find this token in your terminal output.</div>
      </form>
    </div>
  );
}
