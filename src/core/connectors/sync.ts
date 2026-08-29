/**
 * sync.ts — the connector sync orchestrator.
 *
 * Pipeline: resolve credential → build the real ConnectorClient → probe →
 * read the config-scalar watermark → list newest-first stopping at
 * (watermark − windowDays) → fetch each new conversation → spool in batches in
 * the provider's native-export shape → runTranscriptsIngest (reuses redaction,
 * slugging, splitting, idempotency) → advance the watermark ONLY on a fully
 * clean run → logIngest receipt → stamp last_sync_at → engine-branched embed
 * kickoff → prune the spool.
 *
 * WATERMARK IS A CONFIG SCALAR (`connectors.<p>.watermark_iso`), NOT
 * op_checkpoint: op_checkpoint stores a completed-KEY set with no scalar since,
 * and purgeStaleCheckpoints GCs rows after 7 days — which would wipe the
 * watermark on any >7-day gap and trigger a full re-fetch (the exact hammer
 * that flags an account). The config table is durable and never GC'd.
 */

import type { BrainEngine } from '../engine.ts';
import { runTranscriptsIngest } from '../transcripts/ingest.ts';
import type { TranscriptsIngestResult } from '../transcripts/ingest.ts';
import { submitEmbedBackfill } from '../embed-backfill-submit.ts';
import { runEmbedCore } from '../../commands/embed.ts';
import { ConnectorAuthError, ConnectorClient, ConnectorForbiddenError } from './client.ts';
import type { ConnectorFetch } from './client.ts';
import { getConnectorProvider } from './registry.ts';
import { resolveCredential } from './credentials.ts';
import { CONNECTOR_SPOOL_BATCH, pruneSpool, removeSpool, writeSpool } from './spool.ts';
import type { ChatHistoryProvider, ConnectorProviderName, ConversationStub } from './types.ts';
import {
  authErrorAtKey,
  DEFAULT_EMBED_KICKOFF_MIN_PAGES,
  DEFAULT_WINDOW_DAYS,
  lastSyncAtKey,
  watermarkKey,
} from './config-keys.ts';

export const CONNECTOR_SYNC_VERSION = 1;

export type ConnectorSyncStatus =
  | 'success'
  | 'nothing_new'
  | 'partial'
  | 'auth_required'
  | 'forbidden'
  | 'dry_run'
  | 'not_supported';

export type EmbedKickoffOutcome =
  | 'postgres_submitted'
  | 'pglite_inline'
  | 'cooldown'
  | 'spend_capped'
  | 'no_worker_surface'
  | 'below_threshold'
  | 'none';

export interface ConnectorSyncResult {
  status: ConnectorSyncStatus;
  provider: ConnectorProviderName;
  listed: number;
  fetched: number;
  fetchErrors: number;
  ingest?: {
    imported: number;
    skipped: number;
    errored: number;
    redactions: number;
    partsDeleted: number;
    cleanScan: boolean;
    drift: boolean;
  };
  watermarkAdvancedTo?: string;
  spoolPaths: string[];
  embedKickoff: EmbedKickoffOutcome;
  hint?: string;
}

export interface ConnectorSyncDeps {
  /** Pre-built client (tests). When absent, one is built from the credential. */
  client?: ConnectorClient;
  /** Fetch seam for the client + credential refresh. */
  fetchImpl?: ConnectorFetch;
  /** Override the transcripts ingest fn (tests). */
  runIngest?: typeof runTranscriptsIngest;
  /** Override the Postgres embed-kickoff submit (tests). */
  submitEmbedBackfill?: typeof submitEmbedBackfill;
  /** Override the PGLite inline embed (tests). */
  runEmbedCore?: typeof runEmbedCore;
  /** Injectable clock for the watermark trailing-window math + spool stamps. */
  now?: () => number;
  /** Injectable sleep/pacing override forwarded to a self-built client. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Base-URL override so a self-built client points at a fixture server. */
  baseUrlOverride?: string;
  log?: (msg: string) => void;
}

export interface ConnectorSyncOpts {
  provider: ConnectorProviderName;
  /** Target source; default 'default'. */
  sourceId?: string;
  /** Ignore the watermark (first backfill / repair). */
  full?: boolean;
  /** List-only preview: no detail fetches, no writes, no watermark change. */
  dryRun?: boolean;
  /** Max conversations fetched this run; a cap ⇒ NOT a clean run. */
  limit?: number;
  /** Gap-heal trailing window behind the watermark (days). Default 7. */
  windowDays?: number;
  /** Embed during ingest (default OFF — the kickoff catches up post-run). */
  embed?: boolean;
  signal?: AbortSignal;
  onProgress?: (p: { phase: 'list' | 'fetch' | 'ingest'; listed: number; fetched: number; imported: number }) => void;
  deps?: ConnectorSyncDeps;
}

/** Subtract `days` from an ISO timestamp, returning a Z-form ISO string. */
export function subtractDays(iso: string, days: number, now: () => number): string {
  const base = iso ? Date.parse(iso) : now();
  const ms = (Number.isFinite(base) ? base : now()) - days * 86_400_000;
  return new Date(ms).toISOString();
}

function buildClient(
  provider: ChatHistoryProvider,
  cred: import('./types.ts').ConnectorCredential,
  deps: ConnectorSyncDeps,
): ConnectorClient {
  if (deps.client) return deps.client;
  const fetchImpl = deps.fetchImpl;
  return new ConnectorClient({
    baseUrl: deps.baseUrlOverride ?? provider.baseUrl,
    headers: () => provider.authHeaders(cred),
    refresh: provider.refreshAccessToken
      ? () => provider.refreshAccessToken!(cred, fetchImpl ?? (fetch as unknown as ConnectorFetch))
      : undefined,
    fetchImpl,
    sleep: deps.sleep,
    now: deps.now,
    log: deps.log,
  });
}

/**
 * Run one connector sync. Never throws for the expected terminal states
 * (auth_required / forbidden / not_supported) — they are returned so callers
 * (CLI + minion handler) can surface them without a stack trace.
 */
export async function runConnectorSync(
  engine: BrainEngine,
  opts: ConnectorSyncOpts,
): Promise<ConnectorSyncResult> {
  const deps = opts.deps ?? {};
  const now = deps.now ?? Date.now;
  const runIngest = deps.runIngest ?? runTranscriptsIngest;
  const sourceId = opts.sourceId ?? 'default';
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const log = deps.log ?? (() => {});
  const provider = getConnectorProvider(opts.provider);
  const base: ConnectorSyncResult = {
    status: 'success',
    provider: opts.provider,
    listed: 0,
    fetched: 0,
    fetchErrors: 0,
    spoolPaths: [],
    embedKickoff: 'none',
  };

  if (!provider) {
    return { ...base, status: 'not_supported', hint: `no live connector for '${opts.provider}'` };
  }

  const resolved = resolveCredential(opts.provider);
  if (!resolved) {
    return { ...base, status: 'auth_required', hint: provider.sessionInstructions() };
  }

  const client = buildClient(provider, resolved.cred, deps);

  // Probe first: a dead credential must not burn a full list+fetch.
  const probe = await provider.probe(client, opts.signal);
  if (!probe.ok) {
    if (probe.kind === 'unauthorized') {
      await stampAuthError(engine, opts.provider, now);
      return { ...base, status: 'auth_required', hint: provider.sessionInstructions() };
    }
    if (probe.kind === 'forbidden_fingerprint') {
      return {
        ...base,
        status: 'forbidden',
        hint:
          'The provider blocked this request (bot/challenge). Use the cookie-capture lane or ' +
          'the official export + `gbrain transcripts ingest`.',
      };
    }
    // drift / network → surface as forbidden-ish partial with the detail.
    return { ...base, status: 'partial', hint: `probe failed: ${probe.detail}` };
  }

  // Resolve the trailing-window since bound from the config-scalar watermark.
  const watermark = opts.full ? '' : (await engine.getConfig(watermarkKey(opts.provider))) ?? '';
  const stopBefore = watermark ? subtractDays(watermark, windowDays, now) : undefined;

  // LIST (metadata) — collect stubs newer than the window bound, newest-first.
  const stubs: ConversationStub[] = [];
  let maxUpdatedAt = watermark;
  let listErrored = false;
  try {
    for await (const stub of provider.listConversations(client, { signal: opts.signal, stopBefore })) {
      stubs.push(stub);
      if (stub.updatedAt && stub.updatedAt > maxUpdatedAt) maxUpdatedAt = stub.updatedAt;
      opts.onProgress?.({ phase: 'list', listed: stubs.length, fetched: 0, imported: 0 });
    }
  } catch (e) {
    listErrored = true;
    const term = classifyThrow(e);
    if (term) {
      if (term === 'auth_required') await stampAuthError(engine, opts.provider, now);
      return { ...base, status: term, hint: provider.sessionInstructions() };
    }
    log(`[connector] list error: ${e instanceof Error ? e.message : String(e)}`);
  }
  base.listed = stubs.length;

  if (stubs.length === 0 && !listErrored) {
    await engine.setConfig(lastSyncAtKey(opts.provider), new Date(now()).toISOString());
    return { ...base, status: 'nothing_new' };
  }

  // Apply the per-run fetch cap (a cap ⇒ NOT a clean run).
  const capped = typeof opts.limit === 'number' && stubs.length > opts.limit;
  const toFetch = capped ? stubs.slice(0, opts.limit) : stubs;

  if (opts.dryRun) {
    return { ...base, status: 'dry_run', listed: stubs.length, hint: `${toFetch.length} conversation(s) would be fetched` };
  }

  // FETCH details + spool + ingest, in batches (memory-bounded; banks progress).
  const spoolPaths: string[] = [];
  let fetched = 0;
  let fetchErrors = 0;
  let importedTotal = 0;
  let skippedTotal = 0;
  let erroredTotal = 0;
  let redactionsTotal = 0;
  let partsDeletedTotal = 0;
  let allBatchesClean = true;
  let anyDrift = false;

  const spoolFormat = provider.spoolFormat; // capture: nested closures lose narrowing
  const batches = chunk(toFetch, CONNECTOR_SPOOL_BATCH);
  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const convs: Array<Record<string, unknown>> = [];
    for (const stub of batch) {
      if (opts.signal?.aborted) break;
      try {
        convs.push(await provider.fetchConversation(client, stub.id, { signal: opts.signal }));
        fetched++;
        opts.onProgress?.({ phase: 'fetch', listed: stubs.length, fetched, imported: importedTotal });
      } catch (e) {
        const term = classifyThrow(e);
        if (term === 'auth_required') {
          await stampAuthError(engine, opts.provider, now);
          // Ingest whatever we already collected this batch before returning.
          if (convs.length) await ingestBatch();
          return { ...base, status: 'auth_required', listed: stubs.length, fetched, fetchErrors, spoolPaths, hint: provider.sessionInstructions() };
        }
        if (term === 'forbidden') {
          if (convs.length) await ingestBatch();
          return { ...base, status: 'forbidden', listed: stubs.length, fetched, fetchErrors, spoolPaths };
        }
        fetchErrors++;
        log(`[connector] fetch error for ${stub.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (convs.length) await ingestBatch();

    async function ingestBatch(): Promise<void> {
      const stamp = `${new Date(now()).toISOString().replace(/[:.]/g, '-')}-b${bi}`;
      const spoolPath = writeSpool(opts.provider, convs, stamp);
      spoolPaths.push(spoolPath);
      try {
        const r: TranscriptsIngestResult = await runIngest(engine, {
          paths: [spoolPath],
          sourceId,
          format: spoolFormat,
          embed: opts.embed ?? false,
        });
        importedTotal += r.pages.imported;
        skippedTotal += r.pages.skipped;
        erroredTotal += r.pages.errored;
        redactionsTotal += r.redactions;
        partsDeletedTotal += r.partsDeleted;
        if (!r.cleanScan) allBatchesClean = false;
        if (r.driftFiles > 0) anyDrift = true;
        opts.onProgress?.({ phase: 'ingest', listed: stubs.length, fetched, imported: importedTotal });
      } finally {
        removeSpool(spoolPath); // §3A: unredacted spool never lingers
      }
    }
  }

  base.fetched = fetched;
  base.fetchErrors = fetchErrors;
  base.spoolPaths = spoolPaths;
  base.ingest = {
    imported: importedTotal,
    skipped: skippedTotal,
    errored: erroredTotal,
    redactions: redactionsTotal,
    partsDeleted: partsDeletedTotal,
    cleanScan: allBatchesClean,
    drift: anyDrift,
  };

  const clean = !listErrored && fetchErrors === 0 && !capped && allBatchesClean && !opts.signal?.aborted;

  // Advance the watermark ONLY on a fully clean run.
  if (clean && maxUpdatedAt && maxUpdatedAt !== watermark) {
    await engine.setConfig(watermarkKey(opts.provider), maxUpdatedAt);
    base.watermarkAdvancedTo = maxUpdatedAt;
  }

  // Receipt (written by the orchestrator, NOT runTranscriptsIngest).
  await engine.logIngest({
    source_id: sourceId,
    source_type: 'connector',
    source_ref: `${opts.provider}:${spoolPaths.length} batch(es)`,
    pages_updated: [], // slugs are per-batch; the receipt records counts in summary
    summary:
      `connector ${opts.provider}: listed ${stubs.length}, fetched ${fetched}, ` +
      `imported ${importedTotal}, skipped ${skippedTotal}, errors ${fetchErrors}` +
      (anyDrift ? ', DRIFT' : ''),
  });

  // Stamp last_sync_at (success + nothing_new both count as "we ran").
  await engine.setConfig(lastSyncAtKey(opts.provider), new Date(now()).toISOString());
  // Clear a stale auth_error stamp on a clean run.
  if (clean) await engine.setConfig(authErrorAtKey(opts.provider), '');

  // Embed kickoff (engine-branched; below-threshold is a no-op).
  base.embedKickoff = await maybeKickoffEmbed(engine, sourceId, importedTotal, opts, deps, log);

  // Prune the spool dir (belt-and-suspenders; batches already removed inline).
  pruneSpool(opts.provider, 0);

  base.status =
    fetchErrors > 0 || capped || !allBatchesClean || listErrored
      ? 'partial'
      : importedTotal === 0
        ? 'nothing_new'
        : 'success';
  return base;
}

export async function maybeKickoffEmbed(
  engine: BrainEngine,
  sourceId: string,
  imported: number,
  opts: ConnectorSyncOpts,
  deps: ConnectorSyncDeps,
  log: (msg: string) => void,
): Promise<EmbedKickoffOutcome> {
  if (opts.embed) return 'none'; // already embedded during ingest
  const min = await readIntConfig(engine, `connectors.embed_kickoff_min_pages`, DEFAULT_EMBED_KICKOFF_MIN_PAGES);
  if (imported < min) return 'below_threshold';

  if (engine.kind === 'postgres') {
    const submit = deps.submitEmbedBackfill ?? submitEmbedBackfill;
    try {
      const r = await submit(engine, sourceId, { reason: 'connector-sync' });
      const status = (r as { status?: string }).status;
      if (status === 'submitted') return 'postgres_submitted';
      if (status === 'cooldown') return 'cooldown';
      if (status === 'spend_capped') return 'spend_capped';
      if (status === 'no_worker_surface') return 'no_worker_surface';
      return 'none';
    } catch (e) {
      log(`[connector] embed kickoff (postgres) failed: ${e instanceof Error ? e.message : String(e)}`);
      return 'none';
    }
  }

  // PGLite: submitEmbedBackfill REFUSES (no_worker_surface) and a stuck waiting
  // row cooldown-blocks later submits — so drain inline instead (ER-1).
  const embed = deps.runEmbedCore ?? runEmbedCore;
  try {
    await embed(engine, { stale: true, sourceId });
    return 'pglite_inline';
  } catch (e) {
    log(`[connector] embed kickoff (pglite inline) failed: ${e instanceof Error ? e.message : String(e)}`);
    return 'none';
  }
}

async function readIntConfig(engine: BrainEngine, key: string, fallback: number): Promise<number> {
  const v = await engine.getConfig(key);
  if (v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

async function stampAuthError(engine: BrainEngine, provider: ConnectorProviderName, now: () => number): Promise<void> {
  await engine.setConfig(authErrorAtKey(provider), new Date(now()).toISOString());
}

/** Map a thrown client error to a terminal sync status, or null if non-terminal. */
function classifyThrow(e: unknown): 'auth_required' | 'forbidden' | null {
  if (e instanceof ConnectorAuthError) return 'auth_required';
  if (e instanceof ConnectorForbiddenError) return 'forbidden';
  return null;
}

function chunk<T>(arr: T[], size: number): T[][] {
  if (arr.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
