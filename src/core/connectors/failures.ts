import type { BrainEngine } from '../engine.ts';
import { connectorSourceKey } from './config-keys.ts';
import type { ConnectorProviderName, ConversationStub } from './types.ts';

/** Quarantine releases the listing watermark, not the obligation to import. */
export const QUARANTINE_ATTEMPTS = 3;
export const FAILURE_RETRY_DELAY_MS = 86_400_000;
export const FAILURE_RETRY_LIMIT = 10;

export interface ConversationFailure {
  attempts: number;
  updatedAt: string;
  /** Missing on legacy entries: eligible for one bounded retry immediately. */
  nextRetryAt?: string;
  /** Claude conversations belong to the org that listed them. */
  orgId?: string;
}

export async function readConversationFailures(
  engine: BrainEngine, provider: ConnectorProviderName, sourceId: string,
): Promise<Record<string, ConversationFailure>> {
  const raw = await engine.getConfig(connectorSourceKey(provider, sourceId, 'failed'));
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) =>
      value && typeof value === 'object' && Number.isFinite(value.attempts) && value.attempts > 0 &&
      typeof value.updatedAt === 'string' &&
      (value.nextRetryAt === undefined || typeof value.nextRetryAt === 'string') &&
      (value.orgId === undefined || typeof value.orgId === 'string')));
  } catch { return {}; }
}

/** Retry old omissions before new work, with a separate bounded quarantine budget.
 * Listed edits bypass quarantine; unseen failures retain their last known version.
 * No synthetic retry changes the newest-listed watermark or the listed count.
 */
export function selectConversationFetches(
  stubs: ConversationStub[], synced: Record<string, string>, failed: Record<string, ConversationFailure>,
  full: boolean, nowMs: number,
): { pending: ConversationStub[]; skippedUnchanged: number } {
  const listed = new Map(stubs.map(stub => [stub.id, stub]));
  const retries: ConversationStub[] = [];
  const retryIds = new Set<string>();
  let quarantinedRetries = 0;
  for (const [id, entry] of Object.entries(failed).sort((a, b) =>
    (a[1].nextRetryAt ?? '').localeCompare(b[1].nextRetryAt ?? '') || a[0].localeCompare(b[0]))) {
    const stub = listed.get(id);
    if (stub && (full || stub.updatedAt !== entry.updatedAt)) continue;
    if (entry.attempts >= QUARANTINE_ATTEMPTS && !full) {
      if (entry.nextRetryAt && Date.parse(entry.nextRetryAt) > nowMs) continue;
      if (quarantinedRetries >= FAILURE_RETRY_LIMIT) continue;
      quarantinedRetries++;
    }
    retries.push(stub ?? { id, updatedAt: entry.updatedAt, orgId: entry.orgId });
    retryIds.add(id);
  }
  let skippedUnchanged = 0;
  const fresh = stubs.filter(stub => {
    if (retryIds.has(stub.id)) return false;
    if (full) return true;
    if (failed[stub.id]?.updatedAt === stub.updatedAt) return false;
    if (stub.updatedAt && synced[stub.id] === stub.updatedAt) {
      skippedUnchanged++;
      return false;
    }
    return true;
  });
  return { pending: [...retries, ...fresh], skippedUnchanged };
}
