/**
 * sessions.mjs — voice-agent session management.
 *
 * Pure functions, no side effects, fully testable.
 *
 * Session model:
 *   - Voice sessions track auth state (code-based + pre-auth flows).
 *   - Tokens are short-lived (1h default) for callers who verified.
 *   - LogicalSession tracks reconnects + disconnect reasons for QA.
 *
 * Identity: the operator's identity is set via `OPERATOR_IDENTITY` env var
 * or the `identity` arg to preAuthenticate. Defaults to the generic
 * 'operator' if unset — never hardcoded to a real name.
 */

import { randomBytes } from 'node:crypto';

const DEFAULT_IDENTITY = process.env.OPERATOR_IDENTITY || 'operator';

export class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.current = null;
    this.maxSessions = 5;
  }

  create() {
    const id = 'vs_' + randomBytes(16).toString('hex');
    this.sessions.set(id, {
      authCode: null,
      authenticated: false,
      identity: null,
      createdAt: Date.now(),
      preAuth: false,
    });
    this.current = id;
    this._cleanup();
    return id;
  }

  get(id) {
    return this.sessions.get(id || this.current) || null;
  }

  getCurrent() {
    return this.get(this.current);
  }

  restore(id) {
    if (this.sessions.has(id)) {
      this.current = id;
      return true;
    }
    return false;
  }

  setAuthCode(code) {
    const s = this.getCurrent();
    if (s) {
      if (s.authCode) return false; // Already has code — don't regenerate
      s.authCode = code;
      return true;
    }
    return false;
  }

  getAuthCode() {
    return this.getCurrent()?.authCode || null;
  }

  verify(code) {
    const s = this.getCurrent();
    if (!s || !s.authCode) return { verified: false, reason: 'No code sent' };
    const digits = String(code || '').replace(/\D/g, '');
    if (digits === s.authCode) {
      s.authenticated = true;
      s.identity = DEFAULT_IDENTITY;
      return { verified: true };
    }
    return { verified: false, reason: 'Code does not match' };
  }

  preAuthenticate(identity) {
    const s = this.getCurrent();
    if (s) {
      s.authenticated = true;
      s.identity = identity || DEFAULT_IDENTITY;
      s.preAuth = true;
      return true;
    }
    return false;
  }

  isAuthenticated() {
    const s = this.getCurrent();
    return !!(s && s.authenticated);
  }

  getIdentity() {
    return this.getCurrent()?.identity || null;
  }

  _cleanup() {
    const keys = [...this.sessions.keys()];
    if (keys.length > 10) {
      for (const k of keys.slice(0, keys.length - 10)) {
        const s = this.sessions.get(k);
        if (s?.authenticated || s?.preAuth) continue; // Keep authed sessions
        this.sessions.delete(k);
      }
    }
    // Hard cap: expire sessions older than 2 hours
    const twoHoursAgo = Date.now() - 2 * 3600000;
    for (const [k, s] of this.sessions) {
      if (s.createdAt < twoHoursAgo) this.sessions.delete(k);
    }
  }
}

export class TokenManager {
  constructor() {
    this.tokens = new Map();
  }

  generate(identity = DEFAULT_IDENTITY, hours = 1) {
    const token = randomBytes(32).toString('hex');
    const expires = Date.now() + (hours !== undefined ? hours : 1) * 3600000;
    this.tokens.set(token, { expires, identity });
    this._cleanup();
    return { token, expires: new Date(expires).toISOString() };
  }

  validate(token) {
    if (!token) return null;
    const data = this.tokens.get(token);
    if (!data) return null;
    if (data.expires <= Date.now()) {
      this.tokens.delete(token);
      return null;
    }
    return data;
  }

  _cleanup() {
    const now = Date.now();
    for (const [k, v] of this.tokens) {
      if (v.expires <= now) this.tokens.delete(k);
    }
  }
}

export class LogicalSession {
  constructor() {
    this.id = 'vl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    this.startTime = Date.now();
    this.reconnects = 0;
    this.notified = false;
    this.disconnectReasons = [];
  }

  recordDisconnect(code, reason) {
    this.disconnectReasons.push({ code, reason, at: Date.now() });
    this.reconnects++;
  }
}

// ── Rating ────────────────────────────────────────────────
/**
 * Compute a 0-10 call quality rating from transcript + duration + reconnect count.
 * Used for post-call summaries; not user-facing.
 */
export function calculateRating(transcript, duration, reconnects = 0, identity = '') {
  let rating = 7;
  const issues = [];

  if (duration < 15) { rating -= 2; issues.push('too short'); }
  if (duration < 5) { rating -= 1; issues.push('extremely short'); }
  if (reconnects > 0) { rating -= 1; issues.push(`${reconnects} reconnect(s)`); }
  if (reconnects > 3) { rating -= 1; issues.push('excessive reconnects'); }
  if (identity === 'unverified' && duration > 30) { rating -= 1; issues.push('unverified'); }
  if (transcript.length <= 2) { rating -= 2; issues.push('minimal conversation'); }

  const hadReconnect = transcript.some((t) => t.text?.includes('Reconnecting'));
  if (hadReconnect) { rating -= 1; issues.push('connection dropped'); }

  return { rating: Math.max(0, Math.min(10, rating)), issues };
}

export function ratingEmoji(score) {
  return score >= 8 ? '⭐' : score >= 5 ? '🟡' : '🔴';
}

// ── Auth tool gating ──────────────────────────────────────
// Note: voice-callable tool gating lives in `../tools.mjs` (D14-A allow-list).
// The arrays below are LEGACY helpers retained for compatibility with the
// vendored prompt + bridge code, and they intentionally name no specific
// upstream agent. The canonical source of "is this tool callable?" is
// `dispatchTool()` in `tools.mjs`, which always wins.
const AUTH_REQUIRED = new Set(['log_to_brain', 'set_reminder', 'send_message']);
const AUTH_FREE = new Set(['send_auth_code', 'verify_code', 'take_message']);

export function requiresAuth(toolName) {
  return AUTH_REQUIRED.has(toolName);
}

export function isAuthFlowTool(toolName) {
  return AUTH_FREE.has(toolName);
}
