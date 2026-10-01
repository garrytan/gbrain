/**
 * GitHub App installation tokens for the github source kind (peeled from
 * github-source.ts in fix wave 4 to keep it within its module-size ceiling;
 * behavior unchanged). Re-exported from github-source.ts.
 */
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import type { FetchImpl, GitHubAppConfig, GitHubTokenProvider } from './github-source.ts';

function b64url(input: string): string {
  return Buffer.from(input, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

interface MintedInstallationToken {
  token: string;
  expiresAt: number; // epoch ms
  installationId: number;
}

/**
 * Mint an installation access token for a GitHub App:
 * RS256 JWT (iss = app id, 9 min) -> find installation -> POST access_tokens.
 * Installation tokens last 1 hour; callers refresh before expiry.
 */
export async function mintAppInstallationToken(
  app: GitHubAppConfig,
  fetchImpl: FetchImpl = fetch,
): Promise<MintedInstallationToken> {
  const pem = readFileSync(app.pemPath, 'utf-8');
  const nowSec = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: nowSec, exp: nowSec + 540, iss: app.appId }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  signer.end();
  const sig = signer.sign(pem, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const jwt = `${header}.${payload}.${sig}`;
  const headers = {
    authorization: `Bearer ${jwt}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };

  let installId = app.installId;
  if (!installId) {
    const res = await fetchImpl('https://api.github.com/app/installations', { headers });
    if (!res.ok) throw new Error(`GitHub App installations HTTP ${res.status}`);
    const installs = (await res.json()) as Array<{ id: number }>;
    if (installs.length === 0) throw new Error('GitHub App has no installations');
    installId = installs[0].id;
  }
  const res = await fetchImpl(`https://api.github.com/app/installations/${installId}/access_tokens`, {
    method: 'POST',
    headers,
  });
  if (!res.ok) throw new Error(`GitHub App access_tokens HTTP ${res.status}`);
  const body = (await res.json()) as { token: string; expires_at: string };
  return { token: body.token, expiresAt: Date.parse(body.expires_at), installationId: installId };
}

/** Caches a minted installation token and refreshes it before expiry. */
export class AppTokenProvider implements GitHubTokenProvider {
  private cached: MintedInstallationToken | null = null;
  get installationId(): number | null { return this.cached?.installationId ?? null; }

  constructor(
    private readonly app: GitHubAppConfig,
    private readonly fetchImpl: FetchImpl = fetch,
  ) {}

  async getToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - 5 * 60_000 > Date.now()) return this.cached.token;
    return this.refresh();
  }

  // A refresh re-mints for the installation first resolved (and pinned), never a newly discovered one.
  async refresh(): Promise<string> {
    this.cached = await mintAppInstallationToken({ ...this.app, installId: this.app.installId ?? this.cached?.installationId }, this.fetchImpl);
    return this.cached.token;
  }
}
