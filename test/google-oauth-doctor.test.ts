/**
 * google_oauth doctor check (src/commands/doctor/checks/google-oauth.ts) —
 * credential-vault health, zero-network.
 *
 * Each test points GBRAIN_HOME at a fresh temp dir (via withEnv, restored in
 * finally) and writes a synthetic credentials.json vault there, so the check
 * reads exactly the fixture and never the developer's real ~/.gbrain vault.
 *
 * Covers: no accounts → ok; healthy fresh account → ok; expired access token
 * with a stale last refresh → fail naming the account; non-production consent
 * near the 7-day Testing expiry → warn with the publish link; production
 * consent at the same age → ok; corrupt vault file → warn (unreadable).
 *
 * Synthetic data only (a@example.com, placeholder tokens).
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeGoogleOauthCheck } from '../src/commands/doctor/checks/google-oauth.ts';
import type { CredentialEntry } from '../src/core/creds/vault.ts';
import { withEnv } from './helpers/with-env.ts';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function daysAgoIso(n: number): string {
  return new Date(Date.now() - n * DAY_MS).toISOString();
}

function entry(over: {
  expiryMsFromNow: number;
  lastRefreshOkDaysAgo?: number;
  consent?: 'unknown' | 'testing' | 'production';
}): CredentialEntry {
  return {
    id: 'google:a@example.com',
    provider: 'google',
    kind: 'oauth2',
    client_ref: 'byo',
    secret: {
      access_token: 'ya29.synthetic-access',
      refresh_token: '1//synthetic-refresh',
      expiry: new Date(Date.now() + over.expiryMsFromNow).toISOString(),
    },
    meta: {
      account: 'a@example.com',
      scopes: ['openid', 'email'],
      connected_at: daysAgoIso(30),
      ...(over.lastRefreshOkDaysAgo !== undefined
        ? { last_refresh_ok_at: daysAgoIso(over.lastRefreshOkDaysAgo) }
        : {}),
      ...(over.consent !== undefined ? { consent_publish_state: over.consent } : {}),
    },
  };
}

/** Fresh GBRAIN_HOME with a vault holding `entries`; returns the home dir. */
function homeWithVault(entries: CredentialEntry[]): string {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-oauth-doctor-'));
  const dir = join(home, '.gbrain');
  mkdirSync(dir, { recursive: true });
  const credentials: Record<string, CredentialEntry> = {};
  for (const e of entries) credentials[e.id] = e;
  writeFileSync(
    join(dir, 'credentials.json'),
    JSON.stringify({ version: 1, clients: [], credentials }, null, 2) + '\n',
    'utf-8',
  );
  return home;
}

describe('computeGoogleOauthCheck', () => {
  test('no accounts connected → ok (the connector is optional)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-oauth-doctor-empty-'));
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const r = await computeGoogleOauthCheck();
      expect(r.name).toBe('google_oauth');
      expect(r.status).toBe('ok');
      expect(r.message).toContain('no Google accounts connected');
    });
  });

  test('healthy fresh account (live access token, refresh just proved) → ok', async () => {
    const home = homeWithVault([
      entry({ expiryMsFromNow: HOUR_MS, lastRefreshOkDaysAgo: 0, consent: 'unknown' }),
    ]);
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const r = await computeGoogleOauthCheck();
      expect(r.status).toBe('ok');
      expect(r.message).toContain('1 Google account(s) connected');
      expect(r.message).toContain('refresh healthy');
    });
  });

  test('access expired + last successful refresh 3 days ago → fail naming the account', async () => {
    const home = homeWithVault([
      entry({ expiryMsFromNow: -HOUR_MS, lastRefreshOkDaysAgo: 3 }),
    ]);
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const r = await computeGoogleOauthCheck();
      expect(r.status).toBe('fail');
      expect(r.message).toContain('a@example.com');
      expect(r.message).toContain('3d ago');
      // Actionable fix in the message.
      expect(r.message).toContain('gbrain google connect --reauth');
    });
  });

  test("consent 'unknown' + 6 days since refresh (token still live) → warn with the publish link", async () => {
    const home = homeWithVault([
      entry({ expiryMsFromNow: HOUR_MS, lastRefreshOkDaysAgo: 6, consent: 'unknown' }),
    ]);
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const r = await computeGoogleOauthCheck();
      expect(r.status).toBe('warn');
      expect(r.message).toContain('a@example.com');
      expect(r.message).toContain('Testing-mode tokens die at 7d');
      expect(r.message).toContain('https://console.cloud.google.com/auth/audience');
    });
  });

  test("consent 'production' + 6 days since refresh → ok (no weekly expiry to warn about)", async () => {
    const home = homeWithVault([
      entry({ expiryMsFromNow: HOUR_MS, lastRefreshOkDaysAgo: 6, consent: 'production' }),
    ]);
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const r = await computeGoogleOauthCheck();
      expect(r.status).toBe('ok');
      expect(r.message).toContain('refresh healthy');
    });
  });

  test('unreadable (corrupt) vault file → warn, never a crash', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-oauth-doctor-corrupt-'));
    const dir = join(home, '.gbrain');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'credentials.json'), '{ this is not json', 'utf-8');
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const r = await computeGoogleOauthCheck();
      expect(r.status).toBe('warn');
      expect(r.message).toContain('credential vault unreadable');
    });
  });
});
