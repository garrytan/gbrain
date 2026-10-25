/**
 * sync.ts — the connector sync orchestrator.
 *
 * Pipeline: resolve credential → build the real ConnectorClient → probe →
 * read the config-scalar watermark → list newest-first stopping at
 * (watermark − windowDays) → skip conversations whose `updatedAt` the source
 * already ingested → fetch the rest → spool in batches in the provider's
 * native-export shape → runTranscriptsIngest (reuses redaction, slugging,
 * splitting, idempotency) → advance the watermark ONLY on a clean run →
 * logIngest receipt → stamp last_sync_at → engine-branched embed kickoff →
 * prune the spool.
 *
 * All progress is keyed by (provider, source): the watermark, last_sync_at,
 * a `synced` ledger (conversation id → ingested updatedAt) that lets a capped
 * `--limit` run move on to older conversations, and a `failed` ledger. A
 * conversation that fails to fetch OR to ingest QUARANTINE_ATTEMPTS times at
 * the same updatedAt is quarantined: it no longer holds the watermark back,
 * but its entry stays until it imports and it is retried by id on a backoff
 * even after the watermark passes it (#6387, see failed-ledger.ts). While any
 * entry is unresolved the run reports `partial` with `unresolved`. An edit
 * (new updatedAt) or `--full` retries it at once; a `--full` listing that no
 * longer contains it drops it as `gone`. Aborts and auth stops never count as
 * a conversation's failure. Ingest outcomes are attributed per conversation
 * (session id = conversation id), so one failing conversation never blocks
 * its batch.
 *
 * STATE LIVES IN CONFIG SCALARS (`connectors.<p>.source.<id>.*`), NOT
 * op_checkpoint: op_checkpoint stores a completed-KEY set with no scalar since,
 * and purgeStaleCheckpoints GCs rows after 7 days — which would wipe the
 * watermark on any >7-day gap and trigger a full re-fetch (the exact hammer
 * that flags an account). The config table is durable and never GC'd.
 */

import type { BrainEngine } from '../engine.ts';
import { reviewConnectorBatch, reviewCommand } from './review.ts';
import { runTranscriptsIngest } from '../transcripts/ingest.ts';
import type { TranscriptsIngestResult } from '../transcripts/ingest.ts';
import { submitEmbedBackfill } from '../embed-backfill-submit.ts';
import { runEmbedCore } from '../../commands/embed.ts';
import {
  ConnectorAuthError,
  ConnectorClient,
  ConnectorCredentialFormatError,
  ConnectorForbiddenError,
  ConnectorHttpError,
  ConnectorNetworkError,
  ConnectorRateLimitedError,
} from './client.ts';
import type { ConnectorFetch } from './client.ts';
import { getConnectorProvider } from './registry.ts';
import { resolveCredential } from './credentials.ts';
import { CONNECTOR_SPOOL_BATCH, pruneSpool, removeSpool, writeSpool } from './spool.ts';
import type { ChatHistoryProvider, ConnectorProviderName, ConversationStub, ProbeResult } from './types.ts';
import { QUARANTINE_ATTEMPTS, fullSyncArgv, planConnectorFetch, readFailedLedger, recordFailedAttempt } from './failed-ledger.ts';
import {
  authErrorAtKey,
  connectorSourceKey,
  DEFAULT_EMBED_KICKOFF_MIN_PAGES,
  DEFAULT_WINDOW_DAYS,
  readConnectorState,
  writeConnectorState,
} from './config-keys.ts';

export const CONNECTOR_SYNC_VERSION = 1;
export { QUARANTINE_ATTEMPTS };

export type ConnectorSyncStatus =
  | 'success'
  | 'nothing_new'
  | 'partial'
  | 'auth_required'
  | 'forbidden'
  | 'rate_limited'
  | 'dry_run'
  | 'not_supported';

export type EmbedKickoffOutcome =
  | 'postgres_submitted'
  | 'pglite_inline'
  | 'cooldown'
  | 'spend_capped'
  | 'stalled'
  | 'no_worker_surface'
  | 'below_threshold'
  | 'none';

export interface ConnectorSyncResult {
  status: ConnectorSyncStatus;
  reviewHeld?: string[];
  reviewNoise?: number;
  reviewKept?: number;
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
  /** Listed conversations skipped because this source already ingested that updatedAt. */
  skippedUnchanged: number;
  /** Conversation ids quarantined after repeated fetch or ingest failures (retried by id on a backoff). */
  quarantined: string[];
  /** Conversation ids whose write was accepted and is still publishing: not synced, and they hold the watermark. */
  pending: string[];
  /** Conversations in the failed ledger after this run: not archived yet (#6387). */
  unresolved: number;
  /** Unresolved conversations that only a `--full` sync can retry (recorded before their org was). */
  held: string[];
  /** Failed conversations a complete `--full` listing no longer contains; dropped from the ledger. */
  gone: string[];
  spoolPaths: string[];
  embedKickoff: EmbedKickoffOutcome;
  /** #7482: set when the run stopped fetching early because CONSECUTIVE_FETCH_FAILURE_LIMIT fetches failed in a row. */
  stopReason?: 'consecutive_fetch_failures';
  hint?: string;
}

/**
 * #7482: this many conversation fetches failing in a row on a provider-wide error (a 5xx or no response, each after
 * its own bounded retries) stop the run. An item error such as a 404 says the provider is answering, so it resets the run.
 */
export const CONSECUTIVE_FETCH_FAILURE_LIMIT = 5;

type TerminalStatus = 'auth_required' | 'forbidden' | 'rate_limited';

/** Probe failures that end the run before listing; drift and network fall through to `partial`. */
const PROBE_TERMINAL: Partial<Record<Exclude<ProbeResult, { ok: true }>['kind'], TerminalStatus>> = {
  unauthorized: 'auth_required',
  invalid_credential: 'auth_required',
  forbidden_fingerprint: 'forbidden',
  rate_limited: 'rate_limited',
};

/** What the user does about a run that ended on a terminal status. */
function terminalHint(term: TerminalStatus, provider: ChatHistoryProvider): string {
  if (term === 'rate_limited') {
    return 'The provider is rate limiting this account; the sync stopped instead of retrying. Wait before the next ' +
      'sync (an automatic schedule picks up where this run stopped).';
  }
  if (term === 'forbidden') {
    return 'The provider blocked this request (bot/challenge). Use the cookie-capture lane or ' +
      'the official export + `gbrain transcripts ingest`.';
  }
  return provider.sessionInstructions();
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
  /** Host-owned argv; Jev runs before transcript publication. */
  reviewArgv?: string[];
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
  const configuredReview = reviewCommand(await engine.getConfig('connectors.review.command') ?? undefined);
  if (await engine.getConfig('connectors.review.required') === 'true' && !configuredReview)
    throw new Error('connector_review_required');
  if (configuredReview && opts.reviewArgv && JSON.stringify(configuredReview) !== JSON.stringify(opts.reviewArgv))
    throw new Error('connector_review_command_mismatch');
  opts = { ...opts, reviewArgv: configuredReview ?? opts.reviewArgv };
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
    skippedUnchanged: 0,
    quarantined: [],
    pending: [],
    unresolved: 0,
    held: [],
    gone: [],
    spoolPaths: [],
    embedKickoff: 'none',
    ...(opts.reviewArgv ? { reviewHeld: [], reviewNoise: 0, reviewKept: 0 } : {}),
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
    const term = PROBE_TERMINAL[probe.kind];
    if (term === 'auth_required') await stampAuthError(engine, opts.provider, now);
    if (term) return { ...base, status: term, hint: probe.kind === 'invalid_credential' ? probe.detail : terminalHint(term, provider) };
    // drift / network → surface as forbidden-ish partial with the detail.
    return { ...base, status: 'partial', hint: `probe failed: ${probe.detail}` };
  }

  // Resolve the trailing-window since bound from this source's watermark.
  const watermark = opts.full ? '' : (await readConnectorState(engine, opts.provider, sourceId, 'watermark_iso')) ?? '';
  const syncedKey = connectorSourceKey(opts.provider, sourceId, 'synced');
  const failedKey = connectorSourceKey(opts.provider, sourceId, 'failed');
  const synced = await readLedger<string>(engine, syncedKey);
  const failed = await readFailedLedger(engine, opts.provider, sourceId);
  const saveLedgers = async () => {
    await engine.setConfig(syncedKey, JSON.stringify(synced));
    await engine.setConfig(failedKey, JSON.stringify(failed));
  };
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
      return { ...base, status: term, hint: terminalHint(term, provider) };
    }
    log(`[connector] list error: ${e instanceof Error ? e.message : String(e)}`);
  }
  base.listed = stubs.length;

  // A complete --full listing is the provider's whole history: a failed
  // conversation it no longer contains cannot be archived any more.
  if (opts.full && !listErrored && !opts.dryRun) {
    const listedIds = new Set(stubs.map(s => s.id));
    for (const id of Object.keys(failed)) {
      if (listedIds.has(id)) continue;
      delete failed[id];
      base.gone.push(id);
    }
    if (base.gone.length) await saveLedgers();
  }

  if (stubs.length === 0 && !listErrored && Object.keys(failed).length === 0) {
    await writeConnectorState(engine, opts.provider, sourceId, 'last_sync_at', new Date(now()).toISOString());
    return { ...base, status: 'nothing_new' };
  }

  // Skip what this source already holds and what waits on its retry backoff,
  // BEFORE the cap, so a capped run reaches conversations earlier runs did
  // not; due retained failures get reserved slots under the cap (#6387).
  const plan = planConnectorFetch({
    stubs, synced, failed, full: !!opts.full, limit: opts.limit, nowMs: now(), routesByOrg: !!provider.routesByOrg,
  });
  const quarantined = [...plan.waiting];
  base.skippedUnchanged = plan.skippedUnchanged;
  base.held = plan.held;
  const capped = plan.capped;
  const retryIds = new Set(plan.retries.map(s => s.id));
  const toFetch = [...plan.retries, ...plan.listed];

  if (opts.dryRun) {
    return { ...base, status: 'dry_run', listed: stubs.length, unresolved: Object.keys(failed).length, hint: `${toFetch.length} conversation(s) would be fetched` };
  }

  // FETCH details + spool + ingest, in batches (memory-bounded; banks progress).
  const spoolPaths: string[] = [];
  let fetched = 0;
  let fetchErrors = 0;
  let blockingFailures = 0;
  let importedTotal = 0;
  let skippedTotal = 0;
  let erroredTotal = 0;
  let redactionsTotal = 0;
  let partsDeletedTotal = 0;
  let allBatchesClean = true;
  let anyDrift = false;
  let aborted = false;
  let consecutiveFetchFailures = 0;

  const reviewHeld = new Set<string>();
  let reviewNoise = 0, reviewKept = 0;
  const spoolFormat = provider.spoolFormat; // capture: nested closures lose narrowing
  const batches = chunk(toFetch, CONNECTOR_SPOOL_BATCH);
  for (let bi = 0; bi < batches.length && !aborted && !base.stopReason; bi++) {
    const batch = batches[bi];
    const convs: Array<Record<string, unknown>> = [];
    const convStubs: ConversationStub[] = [];
    for (const stub of batch) {
      if (opts.signal?.aborted) break;
      try {
        convs.push(await provider.fetchConversation(client, stub.id, { signal: opts.signal, orgId: stub.orgId }));
        convStubs.push(stub);
        fetched++;
        consecutiveFetchFailures = 0;
        opts.onProgress?.({ phase: 'fetch', listed: stubs.length, fetched, imported: importedTotal });
      } catch (e) {
        // A cancelled run says nothing about the conversation: no strike.
        if (opts.signal?.aborted) { aborted = true; break; }
        const term = classifyThrow(e);
        if (term) {
          if (term === 'auth_required') await stampAuthError(engine, opts.provider, now);
          // Ingest whatever we already collected this batch before returning.
          if (convs.length) await ingestBatch();
          await saveLedgers();
          return { ...base, status: term, listed: stubs.length, fetched, fetchErrors, spoolPaths, hint: terminalHint(term, provider) };
        }
        fetchErrors++;
        const attempts = recordFailure(stub, null);
        log(`[connector] fetch error for ${stub.id} (attempt ${attempts}): ${e instanceof Error ? e.message : String(e)}`);
        const providerWide = e instanceof ConnectorNetworkError || (e instanceof ConnectorHttpError && e.status >= 500);
        consecutiveFetchFailures = providerWide ? consecutiveFetchFailures + 1 : 0;
        if (consecutiveFetchFailures >= CONSECUTIVE_FETCH_FAILURE_LIMIT) {
          base.stopReason = 'consecutive_fetch_failures';
          break;
        }
      }
    }
    if (convs.length) await ingestBatch();
    await saveLedgers();

    /**
     * Count one failure; quarantined conversations stop blocking the
     * watermark, and a retry by id never blocked it (the watermark describes
     * listed history).
     */
    function recordFailure(stub: ConversationStub, code: string | null): number {
      const { attempts } = recordFailedAttempt(failed, stub, now(), code);
      if (attempts >= QUARANTINE_ATTEMPTS) quarantined.push(stub.id);
      else if (!retryIds.has(stub.id)) blockingFailures++;
      return attempts;
    }

    async function ingestBatch(): Promise<void> {
      const stamp = `${new Date(now()).toISOString().replace(/[:.]/g, '-')}-b${bi}`;
      const spoolPath = writeSpool(opts.provider, convs, stamp);
      spoolPaths.push(spoolPath);
      let ingestPath = spoolPath;
      try {
        let keepIds: Set<string> | undefined;
        if (opts.reviewArgv) {
          const verdicts = await reviewConnectorBatch(spoolPath, opts.provider, sourceId, opts.reviewArgv);
          keepIds = new Set<string>();
          for (const stub of convStubs) {
            const verdict = verdicts.get(stub.id) ?? 'unsure';
            if (verdict === 'keep') { keepIds.add(stub.id); reviewKept++; }
            else if (verdict === 'noise') reviewNoise++;
            else { reviewHeld.add(stub.id); if (!retryIds.has(stub.id)) blockingFailures++; }
          }
          const keep = convs.filter((_, i) => keepIds!.has(convStubs[i].id));
          if (keep.length) ingestPath = writeSpool(opts.provider, keep, stamp + '-reviewed');
        }
        const r: TranscriptsIngestResult = keepIds?.size === 0 ? {
          pages: { imported: 0, skipped: 0, errored: 0 }, redactions: 0, partsDeleted: 0,
          cleanScan: true, driftFiles: 0, files: [],
        } as unknown as TranscriptsIngestResult : await runIngest(engine, {
          paths: [ingestPath],
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
        // A file-level problem (unreadable spool, drift, dropped lines) fails
        // the whole batch; otherwise each conversation stands on its own
        // session outcome. A conversation with no session had nothing to import.
        const fileFailed = r.files.some(f => f.error || f.drift || f.truncated || f.skippedLines > 0);
        const sessions = new Map(r.files.flatMap(f => f.sessions).map(s => [s.sessionId, s]));
        for (const stub of convStubs) {
          if (reviewHeld.has(stub.id)) continue;
          if (keepIds && !keepIds.has(stub.id)) {
            if (stub.updatedAt) synced[stub.id] = stub.updatedAt;
            delete failed[stub.id];
            continue;
          }
          const session = sessions.get(stub.id);
          if (fileFailed || session?.error) {
            const attempts = recordFailure(stub, session?.code ?? null);
            log(`[connector] ingest error for ${stub.id} (attempt ${attempts}): ${session?.error ?? 'spool file failed to ingest'}`);
            continue;
          }
          // An accepted write still publishing is neither synced nor a failure: the next run waits on the same
          // request (transcripts ingest derives its id), and until then the conversation holds the watermark.
          if (session?.pending) {
            base.pending.push(stub.id);
            if (!retryIds.has(stub.id)) blockingFailures++;
            continue;
          }
          if (stub.updatedAt) synced[stub.id] = stub.updatedAt;
          delete failed[stub.id];
        }
        if (r.driftFiles > 0) anyDrift = true;
        opts.onProgress?.({ phase: 'ingest', listed: stubs.length, fetched, imported: importedTotal });
      } finally {
        if (ingestPath !== spoolPath) removeSpool(ingestPath);
        removeSpool(spoolPath); // §3A: unredacted spool never lingers
      }
    }
  }

  if (opts.reviewArgv) { base.reviewHeld = [...reviewHeld]; base.reviewNoise = reviewNoise; base.reviewKept = reviewKept; }
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

  base.quarantined = quarantined;
  // Quarantined conversations no longer hold the watermark back.
  const clean = !listErrored && reviewHeld.size === 0 && blockingFailures === 0 && !capped && !opts.signal?.aborted && !base.stopReason;

  // Advance the watermark ONLY on a clean run.
  if (clean && maxUpdatedAt && maxUpdatedAt !== watermark) {
    await writeConnectorState(engine, opts.provider, sourceId, 'watermark_iso', maxUpdatedAt);
    base.watermarkAdvancedTo = maxUpdatedAt;
    // Synced conversations older than the next run's list window are never
    // listed again, so their entries are dead weight. Failed entries stay
    // until they import (#6387): they are the only record of the omission.
    const floor = subtractDays(maxUpdatedAt, windowDays, now);
    for (const [id, updatedAt] of Object.entries(synced)) if (updatedAt < floor) delete synced[id];
    await saveLedgers();
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
  await writeConnectorState(engine, opts.provider, sourceId, 'last_sync_at', new Date(now()).toISOString());
  // Clear a stale auth_error stamp on a clean run.
  if (clean) await engine.setConfig(authErrorAtKey(opts.provider), '');

  // Embed kickoff (engine-branched; below-threshold is a no-op).
  base.embedKickoff = await maybeKickoffEmbed(engine, sourceId, importedTotal, opts, deps, log);

  // Prune the spool dir (belt-and-suspenders; batches already removed inline).
  pruneSpool(opts.provider, 0);

  base.unresolved = Object.keys(failed).length;
  base.hint = unresolvedHint(base, opts.provider, sourceId) ?? base.hint;
  base.status =
    reviewHeld.size > 0 || fetchErrors > 0 || capped || !allBatchesClean || listErrored || aborted || base.stopReason || base.unresolved > 0 || base.pending.length > 0
      ? 'partial'
      : importedTotal === 0
        ? 'nothing_new'
        : 'success';
  return base;
}

/** What the run left unarchived (failed or still publishing) and the command that shows it. */
function unresolvedHint(base: ConnectorSyncResult, provider: ConnectorProviderName, sourceId: string): string | undefined {
  const parts: string[] = [];
  if (base.stopReason) {
    parts.push(`Stopped after ${CONSECUTIVE_FETCH_FAILURE_LIMIT} conversation fetches failed in a row; the provider may be ` +
      'throttling or down. The next sync resumes from the same place.');
  }
  if (base.unresolved > 0) {
    parts.push(
      `${base.unresolved} conversation(s) not archived yet; sync retries them automatically ` +
      `(\`gbrain connectors status ${provider} --json\` lists them).` +
      (base.held.length
        ? ` ${base.held.length} recorded before their organization was tracked need one full re-sync, which ` +
          `re-downloads the whole history: ask the user, then run \`${fullSyncArgv(provider, sourceId).join(' ')}\`.`
        : ''));
  }
  if (base.pending.length) {
    parts.push(`${base.pending.length} conversation(s) were accepted and are still publishing; the next sync `
      + `finishes them without a second write (\`gbrain sources writer status --source ${sourceId} --json\` shows the queue).`);
  }
  return parts.length ? parts.join(' ') : undefined;
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
      if (status === 'stalled') return 'stalled';
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

async function readLedger<T>(engine: BrainEngine, key: string): Promise<Record<string, T>> {
  const raw = await engine.getConfig(key);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, T> : {};
  } catch {
    return {};
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
function classifyThrow(e: unknown): TerminalStatus | null {
  if (e instanceof ConnectorAuthError || e instanceof ConnectorCredentialFormatError) return 'auth_required';
  if (e instanceof ConnectorForbiddenError) return 'forbidden';
  if (e instanceof ConnectorRateLimitedError) return 'rate_limited';
  return null;
}

function chunk<T>(arr: T[], size: number): T[][] {
  if (arr.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
