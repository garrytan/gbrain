import React, { useState } from 'react';
import { api } from '../api';

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
      onLogin();
    } catch (err) {
      setError('Invalid token. Check your terminal output.');
    } finally {
      setLoading(false);
    }
  };

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
