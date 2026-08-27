/**
 * checks/connectors.ts — chat-connector health (D3.2).
 *
 * Surfaces silent-failure conditions the user would otherwise never see:
 *   - re-auth needed: `auth_error_at` newer than the credential's `savedAt`
 *   - sync stalled: `auto_sync` on but `last_sync_at` older than
 *     `connectors.doctor_stale_hours` (default 72 — NOT the dispatch floor, so
 *     a manual sync a few hours ago never nags)
 *   - drift: the latest connector receipt reports skipped conversations
 *
 * Gated on a credential existing; a manual-lane user (auto_sync off) is never
 * flagged for staleness. Never prints the credential value.
 */

import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { connectorProviderNames } from '../../../core/connectors/registry.ts';
import { loadCredential } from '../../../core/connectors/credentials.ts';
import {
  authErrorAtKey,
  autoSyncKey,
  doctorStaleHoursKey,
  DEFAULT_DOCTOR_STALE_HOURS,
  isTruthy,
  lastSyncAtKey,
} from '../../../core/connectors/config-keys.ts';

export async function connectorsHealthCheck(engine: BrainEngine): Promise<Check> {
  const name = 'connectors';
  let staleHours = DEFAULT_DOCTOR_STALE_HOURS;
  const cfg = await engine.getConfig(doctorStaleHoursKey());
  if (cfg) {
    const n = Number(cfg);
    if (Number.isFinite(n) && n > 0) staleHours = n;
  }

  const problems: string[] = [];
  let anyCredential = false;
  const now = Date.now();

  for (const provider of connectorProviderNames()) {
    const cred = loadCredential(provider);
    if (!cred) continue;
    anyCredential = true;

    const authErrorAt = await engine.getConfig(authErrorAtKey(provider));
    if (authErrorAt && cred.savedAt && authErrorAt > cred.savedAt) {
      problems.push(`${provider}: re-auth needed — run \`gbrain connectors auth ${provider}\``);
      continue; // a dead credential subsumes staleness
    }

    if (isTruthy(await engine.getConfig(autoSyncKey(provider)))) {
      const lastSyncAt = await engine.getConfig(lastSyncAtKey(provider));
      const lastMs = lastSyncAt ? Date.parse(lastSyncAt) : NaN;
      if (!Number.isFinite(lastMs) || now - lastMs >= staleHours * 3_600_000) {
        problems.push(
          `${provider}: sync stalled — auto_sync is on but the last sync was ${lastSyncAt ? `at ${lastSyncAt}` : 'never'} (>${staleHours}h); check the worker/scheduler`,
        );
      }
    }
  }

  // Drift: latest connector receipt reports skipped conversations.
  try {
    const log = await engine.getIngestLog({ limit: 20 });
    const latest = log.find((e) => e.source_type === 'connector');
    if (latest && /DRIFT/.test(latest.summary)) {
      problems.push('last connector sync reported format drift — the provider API shape may have changed');
    }
  } catch {
    // ingest_log read is best-effort
  }

  if (!anyCredential) {
    return { name, status: 'ok', message: 'No chat connectors configured (optional).' };
  }
  if (problems.length === 0) {
    return { name, status: 'ok', message: 'Chat connectors healthy.' };
  }
  return { name, status: 'warn', message: problems.join('; ') };
}
