/**
 * google_oauth doctor check — credential-vault health for the google
 * connector, zero-network (live refresh probes live in `gbrain google
 * status`; doctor must stay fast and offline-safe).
 *
 * Surfaces, in order of severity:
 *  - fail: a connected account whose access token expired AND whose last
 *    successful refresh is old (>2 days) — refresh is broken (revoked,
 *    rotated client, or the 7-day Testing-mode expiry already hit).
 *  - warn: a consent screen not known to be Production whose last proof of
 *    life is ≥5 days old — the 7-day Testing-mode refresh expiry is about to
 *    hit; re-auth NOW is cheaper than a dead pipeline on day 8 (this is the
 *    day-6 proactive re-auth demand from the plan, outside-voice F2).
 *  - ok: accounts healthy, or nothing connected (not an error — the
 *    connector is optional).
 */

import type { Check } from '../../doctor.ts';

export async function computeGoogleOauthCheck(): Promise<Check> {
  try {
    const { openVault } = await import('../../../core/creds/vault.ts');
    const metas = await openVault().list({ provider: 'google' });
    if (metas.length === 0) {
      return {
        name: 'google_oauth',
        status: 'ok',
        message: 'no Google accounts connected (gbrain google connect to start)',
      };
    }
    const now = Date.now();
    const failing: string[] = [];
    const expiring: string[] = [];
    for (const m of metas) {
      const account = m.account ?? m.id;
      const lastOkMs = m.last_refresh_ok_at ? Date.parse(m.last_refresh_ok_at) : Date.parse(m.connected_at);
      const daysSinceOk = (now - lastOkMs) / 86_400_000;
      // Missing expiry (imported/relay entries) is UNKNOWN, not expired — a
      // false `fail` here would page the operator over a healthy account.
      const accessExpired = m.expiry ? Date.parse(m.expiry) < now : false;
      if (accessExpired && daysSinceOk > 2) {
        failing.push(`${account} (last successful refresh ${Math.floor(daysSinceOk)}d ago)`);
      } else if (m.consent_publish_state !== 'production' && daysSinceOk >= 5) {
        expiring.push(`${account} (${Math.floor(daysSinceOk)}d since last refresh; Testing-mode tokens die at 7d)`);
      }
    }
    if (failing.length > 0) {
      return {
        name: 'google_oauth',
        status: 'fail',
        message:
          `token refresh looks broken for ${failing.join(', ')} — ` +
          `run \`gbrain google status\` for the exact cause, then \`gbrain google connect --reauth <email>\``,
      };
    }
    if (expiring.length > 0) {
      return {
        name: 'google_oauth',
        status: 'warn',
        message:
          `${expiring.join(', ')} — publish the app to Production ` +
          `(https://console.cloud.google.com/auth/audience) or re-auth before it dies: ` +
          `\`gbrain google connect --reauth <email>\``,
      };
    }
    return {
      name: 'google_oauth',
      status: 'ok',
      message: `${metas.length} Google account(s) connected, refresh healthy`,
    };
  } catch (e) {
    return {
      name: 'google_oauth',
      status: 'warn',
      message: `credential vault unreadable: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
