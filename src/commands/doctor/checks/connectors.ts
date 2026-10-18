/**
 * checks/connectors.ts — chat-connector health (D3.2).
 *
 * Surfaces silent-failure conditions the user would otherwise never see:
 *   - re-auth needed: `auth_error_at` newer than the credential's `savedAt`
 *   - sync stalled: `auto_sync` on but `last_sync_at` older than
 *     `connectors.doctor_stale_hours` (default 72 — NOT the dispatch floor, so
 *     a manual sync a few hours ago never nags)
 *   - drift: the latest connector receipt reports skipped conversations
 *   - archive incomplete (#6387): the source's failed ledger holds
 *     conversations not archived yet; sync retries them on its own, and a
 *     legacy entry only a `--full` sync can retry carries an ask-first fix
 *     (a full sync re-downloads the whole history with the user's session)
 *
 * Gated on a credential existing; a manual-lane user (auto_sync off) is never
 * flagged for staleness. Never prints the credential value.
 */

import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import type { Action } from '../../../core/agent-output.ts';
import { doctorVerify } from '../check-fix.ts';
import { fullSyncArgv, readFailedLedger } from '../../../core/connectors/failed-ledger.ts';
import { getConnectorProvider } from '../../../core/connectors/registry.ts';
import { connectorProviderNames } from '../../../core/connectors/registry.ts';
import { loadCredential } from '../../../core/connectors/credentials.ts';
import {
  authErrorAtKey,
  autoSyncKey,
  doctorStaleHoursKey,
  DEFAULT_DOCTOR_STALE_HOURS,
  isTruthy,
  readConnectorState,
  sourceIdKey,
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
  let fix: Action | undefined;
  const now = Date.now();
  const sourceId = (await engine.getConfig(sourceIdKey())) || 'default';

  for (const provider of connectorProviderNames()) {
    const cred = loadCredential(provider);
    if (!cred) continue;
    anyCredential = true;

    const failed = Object.values(await readFailedLedger(engine, provider, sourceId));
    if (failed.length > 0) {
      const needsFull = getConnectorProvider(provider)?.routesByOrg ? failed.filter((e) => !e.orgId).length : 0;
      problems.push(
        `${provider}: ${failed.length} unresolved conversation(s) — archive incomplete; sync retries them automatically ` +
          `(\`gbrain connectors status ${provider} --json\` lists them)` +
          (needsFull ? `; ${needsFull} need one full re-sync: ask the user, then run \`${fullSyncArgv(provider, sourceId).join(' ')}\`` : ''),
      );
      if (needsFull && !fix) {
        fix = {
          argv: fullSyncArgv(provider, sourceId),
          consent: ['credentials'],
          actor: 'agent',
          why: `${needsFull} ${provider} conversation(s) failed before gbrain recorded which organization they belong to, so only a full re-sync can fetch them.`,
          user_message:
            `${needsFull} ${provider} conversation(s) are missing from your archive. Recovering them re-downloads your whole ${provider} ` +
            'history with your saved session (many requests to the provider; changed pages are re-imported). Run it now?',
          verify: doctorVerify('connectors'),
          docs: 'docs/guides/chat-connectors.md#recovering-an-archive-synced-before-this-fix',
          requires_exclusive: false,
        };
      }
    }

    const authErrorAt = await engine.getConfig(authErrorAtKey(provider));
    if (authErrorAt && cred.savedAt && authErrorAt > cred.savedAt) {
      problems.push(`${provider}: re-auth needed — run \`gbrain connectors auth ${provider}\``);
      continue; // a dead credential subsumes staleness
    }

    if (isTruthy(await engine.getConfig(autoSyncKey(provider)))) {
      const lastSyncAt = await readConnectorState(engine, provider, sourceId, 'last_sync_at');
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
  return { name, status: 'warn', message: problems.join('; '), ...(fix ? { fix } : {}) };
}
