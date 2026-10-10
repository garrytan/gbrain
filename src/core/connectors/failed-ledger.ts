/**
 * failed-ledger.ts — the per-(provider, source) record of conversations a
 * connector sync could not archive, and the retry plan built from it (#6387).
 *
 * An entry stays until its conversation imports. The watermark may pass it
 * (a quarantined entry no longer holds the watermark back) and the provider
 * may stop listing it, so a sync retries due entries by id: at most
 * RETRY_BUDGET per run, oldest-due first, with slots reserved under `--limit`
 * so new conversations cannot starve them. A quarantined entry waits
 * HOLD_BACKOFF_MS[n] (then HOLD_DAILY_MS) after each further failure — the
 * connector item-holds schedule, so connector retry timing is one policy.
 * A conversation the provider lists with a new updatedAt, and `--full`,
 * retry at once.
 *
 * Providers that route a detail fetch by organization (`routesByOrg`) record
 * the org with the entry. An entry written before orgs were recorded cannot
 * be retried by id safely (the wrong org returns 404 and would look like a
 * content failure); it is held until a `--full` sync lists it again.
 *
 * No engine imports beyond config reads: status and doctor read this without
 * loading the sync pipeline.
 */

import type { BrainEngine } from '../engine.ts';
import { connectorSourceKey } from './config-keys.ts';
import { HOLD_BACKOFF_MS, HOLD_DAILY_MS } from './item-holds.ts';
import type { ConnectorProviderName, ConversationStub } from './types.ts';

/** Failed fetches or ingests at one updatedAt before a conversation is quarantined. */
export const QUARANTINE_ATTEMPTS = 3;
/** Retained failures retried by id per sync run. */
export const RETRY_BUDGET = 10;

export interface FailedEntry {
  attempts: number;
  updatedAt: string;
  lastAttemptAt?: string;
  /** Absent: due now. Set once the entry is quarantined. */
  nextRetryAt?: string;
  orgId?: string;
}

export type FailedLedger = Record<string, FailedEntry>;

export function isQuarantined(entry: FailedEntry): boolean {
  return entry.attempts >= QUARANTINE_ATTEMPTS;
}

/** Record one failure; a quarantined entry gets its next retry time. */
export function recordFailedAttempt(ledger: FailedLedger, stub: ConversationStub, nowMs: number): FailedEntry {
  const updatedAt = stub.updatedAt ?? '';
  const prior = ledger[stub.id];
  const attempts = (prior?.updatedAt === updatedAt ? prior.attempts : 0) + 1;
  const backoff = attempts >= QUARANTINE_ATTEMPTS ? HOLD_BACKOFF_MS[attempts - QUARANTINE_ATTEMPTS] ?? HOLD_DAILY_MS : 0;
  const orgId = stub.orgId ?? prior?.orgId;
  const entry: FailedEntry = {
    attempts,
    updatedAt,
    lastAttemptAt: new Date(nowMs).toISOString(),
    ...(backoff ? { nextRetryAt: new Date(nowMs + backoff).toISOString() } : {}),
    ...(orgId ? { orgId } : {}),
  };
  ledger[stub.id] = entry;
  return entry;
}

const isDue = (entry: FailedEntry, nowIso: string) => !entry.nextRetryAt || entry.nextRetryAt <= nowIso;

export interface FetchPlan {
  /** Listed conversations to fetch (new, edited, or failed but not quarantined). */
  listed: ConversationStub[];
  /** Due retained failures, fetched by id (oldest-due first). */
  retries: ConversationStub[];
  /** Listed new work the `--limit` cap left for a later run. */
  capped: boolean;
  skippedUnchanged: number;
  /** Quarantined, not due yet. */
  waiting: string[];
  /** Legacy entries without an org on an org-routed provider; need `--full`. */
  held: string[];
}

/**
 * Decide what one run fetches. `--full` fetches every listed conversation;
 * retained failures it does not list are left to the caller (a complete
 * listing that omits them means the provider no longer has them).
 */
export function planConnectorFetch(input: {
  stubs: ConversationStub[];
  synced: Record<string, string>;
  failed: FailedLedger;
  full: boolean;
  limit?: number;
  nowMs: number;
  routesByOrg: boolean;
}): FetchPlan {
  const nowIso = new Date(input.nowMs).toISOString();
  const listedIds = new Set(input.stubs.map((s) => s.id));
  const listed: ConversationStub[] = [];
  const due: Array<{ stub: ConversationStub; at: string }> = [];
  const waiting: string[] = [];
  const held: string[] = [];
  let skippedUnchanged = 0;

  for (const stub of input.stubs) {
    if (input.full) { listed.push(stub); continue; }
    if (stub.updatedAt && input.synced[stub.id] === stub.updatedAt) { skippedUnchanged++; continue; }
    const entry = input.failed[stub.id];
    if (entry && entry.updatedAt === (stub.updatedAt ?? '') && isQuarantined(entry)) {
      if (isDue(entry, nowIso)) due.push({ stub, at: entry.nextRetryAt ?? '' });
      else waiting.push(stub.id);
      continue;
    }
    listed.push(stub);
  }
  if (!input.full) {
    for (const [id, entry] of Object.entries(input.failed)) {
      if (listedIds.has(id)) continue;
      if (input.routesByOrg && !entry.orgId) { held.push(id); continue; }
      if (!isDue(entry, nowIso)) { waiting.push(id); continue; }
      due.push({ stub: { id, updatedAt: entry.updatedAt, ...(entry.orgId ? { orgId: entry.orgId } : {}) }, at: entry.nextRetryAt ?? '' });
    }
  }

  due.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  let retries = due.slice(0, RETRY_BUDGET).map((d) => d.stub);
  let take = listed.length;
  if (input.limit !== undefined) {
    const reserved = Math.min(retries.length, Math.ceil(input.limit / 2));
    take = Math.min(listed.length, input.limit - reserved);
    retries = retries.slice(0, input.limit - take);
  }
  return { listed: listed.slice(0, take), retries, capped: take < listed.length, skippedUnchanged, waiting, held };
}

export async function readFailedLedger(engine: BrainEngine, provider: ConnectorProviderName, sourceId: string): Promise<FailedLedger> {
  const raw = await engine.getConfig(connectorSourceKey(provider, sourceId, 'failed'));
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as FailedLedger : {};
  } catch {
    return {};
  }
}

/** The full-repair command a held or pruned failure needs (it re-downloads the whole history; ask first). */
export const fullSyncArgv = (provider: ConnectorProviderName, sourceId: string): string[] =>
  ['gbrain', 'connectors', 'sync', provider, '--full', '--source', sourceId];
