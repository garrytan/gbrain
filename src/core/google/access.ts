/**
 * google/access — pluggable Google API access.
 *
 * The REST clients need exactly two things: a bearer token, and a way to
 * force-refresh one after a 401. `GoogleAccessProvider` is that seam. Three
 * implementations exist:
 *
 *  - the vault flow (`GoogleTokenProvider` in src/core/creds/providers/
 *    google.ts) — BYO OAuth client or hosted relay; the default.
 *  - `CommandAccessProvider` (`--access command`) — any CLI that prints an
 *    access token (gog, `gcloud auth print-access-token`, a credential
 *    gateway's mint command). gbrain never stores the token; the command IS
 *    the refresher.
 *  - `EnvAccessProvider` (`--access env`) — a token refreshed by something
 *    outside gbrain, read live from a named env var each call.
 *
 * Non-vault modes exist so harness stacks that already hold Google access
 * another way (an OpenClaw deployment routing through a credential gateway,
 * a gog-based setup) can drive the native source — and the open-loop
 * engine — without re-consenting through gbrain's own OAuth flow.
 *
 * Trust note: the token command is part of the LOCAL source config, executed
 * only by the locally-running sync (the google source kind is hard-rejected
 * on remote sources_add, and its config keys are not reachable over MCP).
 * Same trust class as recipe health_check argv entries.
 */

import { spawnSync } from 'node:child_process';

import { CredentialError } from '../creds/errors.ts';

export interface GoogleAccessProvider {
  getAccessToken(): Promise<string>;
  forceRefresh(): Promise<string>;
}

/** Google access tokens live ~60 min; without an expiry hint, cache 45. */
const DEFAULT_CACHE_MS = 45 * 60_000;
const COMMAND_TIMEOUT_MS = 30_000;

/** Parse command output: bare token line, or JSON with token/expiry fields. */
export function parseTokenOutput(raw: string): { token: string; expiresAtMs: number | null } {
  const text = raw.trim();
  if (text === '') throw new CredentialError('access_command_failed', ' (empty output)');
  if (text.startsWith('{')) {
    try {
      const o = JSON.parse(text) as Record<string, unknown>;
      const token =
        (typeof o.token === 'string' && o.token) ||
        (typeof o.access_token === 'string' && o.access_token) ||
        '';
      if (!token) {
        throw new CredentialError('access_command_failed', ' (JSON output has no token/access_token field)');
      }
      let expiresAtMs: number | null = null;
      if (typeof o.expiry === 'string') {
        const ms = Date.parse(o.expiry);
        if (Number.isFinite(ms)) expiresAtMs = ms;
      } else if (typeof o.expires_in === 'number' && Number.isFinite(o.expires_in)) {
        expiresAtMs = Date.now() + Math.max(0, o.expires_in) * 1000;
      }
      return { token: token.trim(), expiresAtMs };
    } catch (e) {
      if (e instanceof CredentialError) throw e;
      throw new CredentialError('access_command_failed', ' (output looks like JSON but does not parse)');
    }
  }
  // Bare token: first non-empty line. Guard against obviously-wrong output
  // (multiline logs, spaces) so a chatty command fails loudly, not as a 401.
  const firstLine = text.split('\n')[0].trim();
  if (firstLine.includes(' ') || firstLine.length < 8) {
    throw new CredentialError('access_command_failed', ' (output does not look like a token)');
  }
  return { token: firstLine, expiresAtMs: null };
}

export class CommandAccessProvider implements GoogleAccessProvider {
  private cached: { token: string; expiresAtMs: number } | null = null;

  constructor(private readonly command: string) {
    if (!command.trim()) throw new CredentialError('access_command_failed', ' (empty --token-command)');
  }

  private run(): string {
    const res = spawnSync('/bin/sh', ['-c', this.command], {
      timeout: COMMAND_TIMEOUT_MS,
      encoding: 'utf-8',
      // The command inherits the caller's env (it may need its own config);
      // stdin closed so an interactive prompt fails fast instead of hanging.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (res.error) {
      throw new CredentialError('access_command_failed', ` (${res.error.message})`);
    }
    if (res.status !== 0) {
      const tail = (res.stderr ?? '').trim().split('\n').slice(-1)[0] ?? '';
      throw new CredentialError(
        'access_command_failed',
        ` (exit ${String(res.status)}${tail ? `: ${tail.slice(0, 160)}` : ''})`,
      );
    }
    const { token, expiresAtMs } = parseTokenOutput(res.stdout ?? '');
    // 60s safety margin mirrors the vault provider's pre-expiry refresh.
    const expiry = expiresAtMs ?? Date.now() + DEFAULT_CACHE_MS;
    this.cached = { token, expiresAtMs: expiry };
    return token;
  }

  async getAccessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAtMs - 60_000 > Date.now()) return this.cached.token;
    return this.run();
  }

  async forceRefresh(): Promise<string> {
    this.cached = null;
    return this.run();
  }
}

export class EnvAccessProvider implements GoogleAccessProvider {
  constructor(private readonly envName: string) {
    if (!envName.trim()) throw new CredentialError('access_env_missing', ' (empty --token-env)');
  }

  private read(): string {
    const v = (process.env[this.envName] ?? '').trim();
    if (!v) throw new CredentialError('access_env_missing', ` ($${this.envName})`);
    return v;
  }

  async getAccessToken(): Promise<string> {
    return this.read();
  }

  async forceRefresh(): Promise<string> {
    // The refresher lives outside gbrain; a 401 retry re-reads the var in
    // case the external process rotated it between calls.
    return this.read();
  }
}
