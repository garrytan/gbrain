/**
 * The meetings source sweep (`sources.config.kind = 'meetings'`).
 *
 * Coverage: each run works one window of meetings that started in
 * [from, to). `to` is pinned to the run start and persisted with the window,
 * so an interrupted run resumes the same window (skipping meetings it already
 * published) before a new one opens, and a window larger than one run's
 * budget still finishes. The committed boundary advances to `to` only after
 * the window was enumerated to a fixed point (listing passes repeat until a
 * pass finds no new meeting, so offset shifts from arrivals or deletions
 * during the walk cannot skip one) and every meeting in it was published,
 * held or deferred. The next window starts `lookbackDays` before the
 * boundary, so late summaries, edits and deletions in recent meetings
 * converge.
 *
 * A meeting the provider is still processing is deferred: its id and start
 * time are persisted and fetched directly on every run, independent of the
 * listing window, until it is final or gone.
 *
 * Records (D5): `git` mode commits each page through the door before its
 * database row (managed: the coordinator; unmanaged: the commit-push door,
 * then the import); `database` mode imports database-only with no directory.
 * A page whose content changed upstream, or a meeting deleted upstream inside
 * the window, retires the facts extracted from it before the new content is
 * queued for extraction.
 */
import { join, relative } from 'node:path';
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { SyncOpts, SyncResult } from '../../commands/sync.ts';
import { OperationError } from '../ops/contract.ts';
import { withConnectorSync, pendingConnectorResult, type ManagedConnectorSync } from '../persistence/connector-sync.ts';
import { connectorIdentity } from '../persistence/connector-identity.ts';
import { connectorAccountChanged } from '../persistence/connector-errors.ts';
import { sameConnectorAccount, type ConnectorAccount } from '../persistence/connector-state.ts';
import { ConnectorHoldSession, connectorHoldsResult } from '../connectors/connector-hold-session.ts';
import { connectorDbCursorKey, readConnectorDbCursor, writeConnectorDbCursor } from '../connectors/db-cursor.ts';
import { resolveApiToken } from '../connectors/credentials.ts';
import { carryStoredFences } from '../connectors/fence-carry.ts';
import { connectorRender } from '../connectors/connector-text.ts';
import { ConnectorAccessDeniedError, ConnectorAuthError, ConnectorRateLimitedError, ConnectorRunLimitError } from '../connectors/client.ts';
import { atomicWriteFileSync } from '../atomic-write.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { slugifyPath } from '../sync.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';
import { VERSION } from '../../version.ts';
import { meetingProvider } from './providers/index.ts';
import { FIREFLIES_PAGE_LIMIT } from './providers/fireflies.ts';
import { meetingPagePath, renderMeetingPage } from './render.ts';
import { connectorFactsSession, retireFactsFromPage } from '../facts/retire.ts';
import type { MeetingAccount, MeetingProvider, MeetingRecord, MeetingStub, MeetingsSourceConfig } from './types.ts';

const DAY_MS = 86_400_000;
/** Listing passes per window before the walk is treated as unstable and the boundary is kept. */
const MAX_LISTING_PASSES = 3;
/** Progress is persisted every this many meetings, so an interrupted run resumes instead of re-walking. */
const SAVE_EVERY = 20;
/** A deferred (still processing) meeting older than this is published as it is. */
const PENDING_MAX_AGE_MS = 7 * DAY_MS;

export interface MeetingsState extends Record<string, unknown> {
  /** Meetings that started before this are covered (minus the lookback, which every window re-reads). */
  committed_to: string | null;
  /** The window in progress: bounds fixed at its start, and the meetings already published from it. */
  window: { from: string; to: string; done: string[] } | null;
  /** Meetings published in the lookback horizon, for deletion detection: id → page path and start time. */
  seen: Record<string, { path: string; started_at: string }>;
  /** Meetings the provider was still processing: fetched directly every run until final or gone. */
  pending: Record<string, { started_at: string }>;
  /** Unmanaged account pin (managed brains pin in the connector state row). */
  account?: ConnectorAccount | null;
  item_holds?: unknown;
}

const EMPTY_STATE: MeetingsState = { committed_to: null, window: null, seen: {}, pending: {} };

export interface MeetingsSyncDeps {
  /** Test seam: a provider bound to a fake transport. */
  provider?: MeetingProvider;
  now?: () => number;
}

interface Summary {
  status: 'synced' | 'partial';
  added: number; modified: number; deleted: number; chunksCreated: number; embedded: number;
  pagesAffected: string[]; deferred: number; factsRetired: number; failedFiles: number;
}

/** Who a meetings key belongs to, as the account pin records it. */
export function meetingsConnectorAccount(cfg: Pick<MeetingsSourceConfig, 'provider'>, account: MeetingAccount): ConnectorAccount {
  return { kind: 'meetings', provider: cfg.provider, userId: account.userId, email: account.email };
}

export function meetingsAuthRequired(sourceId: string, cfg: Pick<MeetingsSourceConfig, 'provider' | 'tokenEnv'>, detail?: string): OperationError {
  const where = cfg.tokenEnv ? `the environment variable ${cfg.tokenEnv} (the source's --token-env)` : `${'GBRAIN_CONNECTOR_' + cfg.provider.toUpperCase() + '_TOKEN'} or ~/.gbrain/connectors/${cfg.provider}.json`;
  const error = new OperationError('connector_auth_required',
    `Meetings source ${sourceId} has no working ${cfg.provider} API key${detail ? ` (${detail})` : ''}. Nothing was imported.`,
    cfg.tokenEnv ? `Set ${cfg.tokenEnv} to a valid ${cfg.provider} API key in the environment that runs the sync, then run: gbrain sync --source ${sourceId}`
      : `Ask the user for their ${cfg.provider} API key and save it on stdin: gbrain connectors auth ${cfg.provider} --token - ; then run: gbrain sync --source ${sourceId}. The key was read from ${where}.`,
    'docs/guides/meeting-and-slack-sources.md#connector_auth_required');
  return error;
}

function runScoped(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return error instanceof ConnectorAuthError || error instanceof ConnectorAccessDeniedError || error instanceof ConnectorRateLimitedError
    || error instanceof ConnectorRunLimitError || name === 'AbortError' || name === 'TimeoutError' || name === 'LockStolenError' || name === 'ConnectorWaitBudgetStop';
}

/** Records the provider's reset time so the scheduler does not resubmit before it (D1). */
export async function recordRateLimit(engine: BrainEngine, sourceId: string, retryAt: number): Promise<void> {
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('connector-rate-limit',$1,$2::text::jsonb)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`,
  [sourceId, JSON.stringify([{ version: 1, retry_at: new Date(retryAt).toISOString() }])]).catch(() => undefined);
}

function translate(sourceId: string, cfg: MeetingsSourceConfig, error: unknown): unknown {
  if (error instanceof ConnectorAuthError) return meetingsAuthRequired(sourceId, cfg, 'the provider rejected it');
  if (error instanceof ConnectorAccessDeniedError) {
    return new OperationError('connector_access_denied', `The ${cfg.provider} key for ${sourceId} may not read meetings: ${error.message}. Nothing more was imported.`,
      `Use a key whose account can read the team's meetings (an admin key reads every member's), save it with gbrain connectors auth ${cfg.provider} --token -, then run gbrain sync --source ${sourceId}.`,
      'docs/guides/meeting-and-slack-sources.md#connector_access_denied');
  }
  if (error instanceof ConnectorRateLimitedError) {
    const at = error.retryAt ? new Date(error.retryAt).toISOString() : null;
    return new OperationError('rate_limited', `${cfg.provider} rate-limited ${sourceId}${at ? ` until ${at}` : ''}; progress so far was saved.`,
      `Wait${at ? ` until ${at}` : ''}; autopilot resumes it by itself, or run gbrain sync --source ${sourceId} after that.`,
      'docs/guides/meeting-and-slack-sources.md#rate_limited');
  }
  return error;
}

export async function runMeetingsSync(engine: BrainEngine, sourceId: string, cfg: MeetingsSourceConfig, opts: SyncOpts, deps: MeetingsSyncDeps = {}): Promise<SyncResult> {
  return withConnectorSync(engine, sourceId, 'meetings', cfg, opts,
    (managed, options) => runMeetingsSyncInner(engine, sourceId, cfg, options, managed, deps), pendingConnectorResult);
}

async function runMeetingsSyncInner(engine: BrainEngine, sourceId: string, cfg: MeetingsSourceConfig, opts: SyncOpts,
  managed: ManagedConnectorSync | null, deps: MeetingsSyncDeps): Promise<SyncResult> {
  const now = deps.now ?? Date.now;
  const runStart = now();
  const runId = randomUUID();
  let provider = deps.provider;
  if (!provider) {
    const key = resolveApiToken(cfg.provider, cfg.tokenEnv);
    if (!key) throw meetingsAuthRequired(sourceId, cfg);
    provider = meetingProvider(cfg.provider, { token: key.token, userAgent: `gbrain/${VERSION} (+https://github.com/garrytan/gbrain)`, now });
  }
  const signal = opts.signal;
  let account: MeetingAccount;
  try { account = await provider.probe(signal); } catch (e) {
    if (e instanceof ConnectorRateLimitedError && e.retryAt) await recordRateLimit(engine, sourceId, e.retryAt);
    throw translate(sourceId, cfg, e);
  }
  const resolved = meetingsConnectorAccount(cfg, account);

  const [source] = await engine.executeRaw<{ incarnation: string; local_path: string | null; config: Record<string, unknown> }>(
    'SELECT incarnation::text AS incarnation,local_path,config FROM sources WHERE id=$1', [sourceId]);
  const identity = connectorIdentity('meetings', source.config, source.local_path);
  const cursorKey = connectorDbCursorKey(sourceId, source.incarnation, identity);
  let state: MeetingsState;
  if (managed) {
    await managed.assertAccount(resolved);
    state = { ...EMPTY_STATE, ...managed.state<MeetingsState>({ ...EMPTY_STATE }) };
  } else {
    state = { ...EMPTY_STATE, ...(await readConnectorDbCursor(engine, cursorKey)).state as MeetingsState | null };
    if (state.account && !sameConnectorAccount(state.account, resolved)) throw connectorAccountChanged(sourceId, 'meetings', identity.config, state.account, resolved);
    state.account = resolved;
  }

  const summary: Summary = { status: 'synced', added: 0, modified: 0, deleted: 0, chunksCreated: 0, embedded: 0, pagesAffected: [], deferred: 0, factsRetired: 0, failedFiles: 0 };
  const holds = await ConnectorHoldSession.open(engine, sourceId, managed, { ...EMPTY_STATE }, state.item_holds, { full: opts.full });
  const save = async (final: boolean) => {
    if (managed) {
      // A save with accepted writes still pending defers itself, so a window never records a meeting whose write could still fail.
      await managed.saveState(state, final && summary.status === 'synced', final ? state.committed_to ?? undefined : undefined);
      return;
    }
    await writeConnectorDbCursor(engine, cursorKey, state, final ? { run_id: runId, finished_at: new Date(now()).toISOString(),
      counts: { added: summary.added, modified: summary.modified, deleted: summary.deleted, deferred: summary.deferred, facts_retired: summary.factsRetired, failed: summary.failedFiles } } : undefined);
  };

  const ctx: PublishCtx = { engine, sourceId, cfg, managed, account, summary, now };
  const handle = async (key: string, work: () => Promise<void>, slug: string | null): Promise<boolean> => {
    try { await work(); holds.succeed(key); return true; } catch (error) {
      if (runScoped(error)) throw error;
      summary.failedFiles++;
      await holds.fail(key, error, { slug });
      return false;
    }
  };

  try {
    // Deferred meetings first, independent of the listing window (autoplan T32).
    for (const [id, entry] of Object.entries(state.pending)) {
      if (!holds.shouldAttempt(id)) continue;
      await handle(id, async () => {
        const record = await provider!.fetchMeeting(id, { transcript: cfg.transcript === 'full', signal });
        if (!record) { delete state.pending[id]; return; }
        if (!record.isFinal && runStart - Date.parse(entry.started_at) < PENDING_MAX_AGE_MS) { summary.deferred++; return; }
        await publishMeeting(ctx, record);
        state.seen[id] = { path: (await existingPath(engine, sourceId, id)) ?? meetingPagePath(record), started_at: record.startedAt };
        delete state.pending[id];
      }, null);
    }

    const window = state.window ?? {
      from: new Date(state.committed_to ? Date.parse(state.committed_to) - cfg.lookbackDays * DAY_MS : runStart - cfg.historyDays * DAY_MS).toISOString(),
      to: new Date(runStart).toISOString(), done: [],
    };
    state.window = window;
    const done = new Set(window.done);
    const listed = await enumerateWindow(provider, window.from, window.to, signal);
    const ordered = [...listed.stubs.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    let sinceSave = 0;
    for (const stub of ordered) {
      if (done.has(stub.id) || state.pending[stub.id]) continue;
      if (!holds.shouldAttempt(stub.id)) continue;
      const ok = await handle(stub.id, async () => {
        const record = await provider!.fetchMeeting(stub.id, { transcript: cfg.transcript === 'full', signal });
        if (!record) return;
        if (!record.isFinal) { state.pending[stub.id] = { started_at: record.startedAt }; summary.deferred++; return; }
        await publishMeeting(ctx, record);
        state.seen[stub.id] = { path: (await existingPath(engine, sourceId, stub.id)) ?? meetingPagePath(record), started_at: record.startedAt };
      }, null);
      if (ok) { window.done.push(stub.id); done.add(stub.id); }
      if (++sinceSave >= SAVE_EVERY) { sinceSave = 0; state.item_holds = holds.holds.finish().state; await save(false); }
    }
    for (const key of holds.dueHeldKeys()) {
      if (listed.stubs.has(key) || state.pending[key]) continue;
      await handle(key, async () => {
        const record = await provider!.fetchMeeting(key, { transcript: cfg.transcript === 'full', signal });
        if (!record) { holds.drop(key); return; }
        if (!record.isFinal) { state.pending[key] = { started_at: record.startedAt }; summary.deferred++; return; }
        await publishMeeting(ctx, record);
        state.seen[key] = { path: (await existingPath(engine, sourceId, key)) ?? meetingPagePath(record), started_at: record.startedAt };
      }, null);
    }

    if (listed.stable) {
      for (const [id, entry] of Object.entries(state.seen)) {
        if (entry.started_at < window.from || entry.started_at >= window.to || listed.stubs.has(id) || state.pending[id]) continue;
        await handle(id, async () => {
          if (await provider!.fetchMeeting(id, { transcript: false, signal })) return;
          await deleteMeeting(ctx, id, entry.path);
          delete state.seen[id];
          holds.drop(id);
        }, null);
      }
      const unfinished = ordered.some(stub => !done.has(stub.id) && !state.pending[stub.id] && !holds.isHeld(stub.id));
      if (!unfinished) {
        state.committed_to = window.to;
        state.window = null;
        const horizon = Date.parse(window.to) - (cfg.lookbackDays + 1) * DAY_MS;
        for (const [id, entry] of Object.entries(state.seen)) if (Date.parse(entry.started_at) < horizon) delete state.seen[id];
      } else summary.status = 'partial';
    } else {
      summary.status = 'partial';
      process.stderr.write(`[meetings] ${sourceId}: the meeting list kept changing across ${MAX_LISTING_PASSES} passes; the window stays open and is re-read next run\n`);
    }
    if (summary.failedFiles > 0) summary.status = 'partial';
    state.item_holds = holds.finish();
    await save(true);
    await holds.complete();
    // A finished run, partial included, sets the schedule's clock; held items wait for their own retry time, not the next tick.
    if (!managed) {
      await engine.executeRaw('UPDATE sources SET last_sync_at=now(), newest_content_at=COALESCE($1::timestamptz, newest_content_at) WHERE id=$2', [state.committed_to, sourceId]).catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof ConnectorRateLimitedError && error.retryAt) await recordRateLimit(engine, sourceId, error.retryAt);
    if (runScoped(error) && !(error as { name?: string }).name?.startsWith('Lock')) {
      try { state.item_holds = holds.holds.finish().state; await save(false); } catch { /* the original error is what the caller sees */ }
    }
    throw translate(sourceId, cfg, error);
  }

  await afterPublish(ctx, opts);
  return {
    status: summary.status === 'partial' ? 'partial' : summary.added + summary.modified + summary.deleted > 0 ? 'synced' : 'up_to_date',
    fromCommit: null, toCommit: '', added: summary.added, modified: summary.modified, deleted: summary.deleted, renamed: 0,
    chunksCreated: summary.chunksCreated, embedded: summary.embedded, pagesAffected: summary.pagesAffected,
    ...(summary.failedFiles > 0 ? { failedFiles: summary.failedFiles } : {}),
    ...(summary.status === 'partial' ? { filesImported: summary.added + summary.modified,
      reason: summary.failedFiles > 0 ? 'connector_item_failures' as const : signal?.aborted ? 'timeout' as const : 'connector_partial' as const } : {}),
    ...connectorHoldsResult(sourceId, holds.summary()),
  };
}

/** Every meeting in [from, to), walked until a full pass finds nothing new (or the pass cap, which reports unstable). */
async function enumerateWindow(provider: MeetingProvider, from: string, to: string, signal?: AbortSignal): Promise<{ stubs: Map<string, MeetingStub>; stable: boolean }> {
  const stubs = new Map<string, MeetingStub>();
  for (let pass = 0; pass < MAX_LISTING_PASSES; pass++) {
    let added = 0;
    for (let skip = 0; ; skip += FIREFLIES_PAGE_LIMIT) {
      const page = await provider.listMeetings({ fromDate: from, toDate: to, limit: FIREFLIES_PAGE_LIMIT, skip, signal });
      for (const stub of page) {
        if (stub.startedAt < from || stub.startedAt >= to) continue;
        if (!stubs.has(stub.id)) { stubs.set(stub.id, stub); added++; }
      }
      if (page.length < FIREFLIES_PAGE_LIMIT) break;
    }
    if (pass > 0 && added === 0) return { stubs, stable: true };
    if (pass === 0 && stubs.size < FIREFLIES_PAGE_LIMIT) return { stubs, stable: true };
  }
  return { stubs, stable: false };
}

interface PublishCtx {
  engine: BrainEngine; sourceId: string; cfg: MeetingsSourceConfig; managed: ManagedConnectorSync | null;
  account: MeetingAccount; summary: Summary; now: () => number;
}

async function existingPath(engine: BrainEngine, sourceId: string, meetingId: string): Promise<string | null> {
  const [row] = await engine.executeRaw<{ slug: string; source_path: string | null }>(
    `SELECT slug,source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND frontmatter->>'meeting_id'=$2 ORDER BY id LIMIT 1`, [sourceId, meetingId]);
  return row ? row.source_path ?? `${row.slug}.md` : null;
}

function bindingMissing(sourceId: string): OperationError {
  return new OperationError('connector_binding_missing',
    `Meetings source ${sourceId} records to Git, but its checkout is not available; the meeting was held, not written database-only.`,
    `Restore the source's Git checkout (gbrain sources status ${sourceId}), then retry the held items: gbrain sources retry-held ${sourceId}. To record this source in the database instead, change its record mode explicitly.`,
    'docs/guides/meeting-and-slack-sources.md#connector_binding_missing');
}

/** A page path inside the source directory, as the checkout root names it (the commit door takes checkout-relative paths). */
function checkoutPath(root: string, dir: string, relPath: string): string {
  return relative(realpathSync(root), join(realpathSync(dir), relPath)).split('\\').join('/');
}

/** The git checkout that holds an unmanaged git-mode source's directory, or null. */
export async function gitCheckoutOf(dir: string | null): Promise<string | null> {
  if (!dir || !existsSync(dir)) return null;
  try {
    const { checkoutRoot } = await import('../git/commit-push.ts');
    return checkoutRoot(dir);
  } catch { return null; }
}

export async function publishMeeting(ctx: PublishCtx, record: MeetingRecord): Promise<void> {
  const { engine, sourceId, cfg, managed, summary } = ctx;
  const relPath = (await existingPath(engine, sourceId, record.id)) ?? meetingPagePath(record);
  const slug = slugifyPath(relPath);
  let markdown = connectorRender(renderMeetingPage(record, { cfg, account: ctx.account }), { path: relPath, meeting_id: record.id });
  let status: 'imported' | 'skipped';
  let created: boolean;
  if (managed) {
    if (cfg.record === 'git' && !managed.bound) throw bindingMissing(sourceId);
    const result = await managed.importMarkdown(relPath, markdown);
    status = result.status; created = result.created;
    summary.chunksCreated += result.chunks;
  } else {
    const existing = await engine.getPage(slug, { sourceId });
    markdown = await carryStoredFences(sourceId, slug, relPath, existing, markdown, 'meetings connector fence carry');
    const isPrivate = /^visibility: private$/m.test(markdown.split('\n---\n')[0] ?? '');
    let filePath: string | null = null;
    if (cfg.record === 'git') {
      const root = await gitCheckoutOf(cfg.dir);
      if (!root || !cfg.dir) throw bindingMissing(sourceId);
      filePath = join(cfg.dir, relPath);
      if (!isWriteTargetContained(filePath, cfg.dir)) throw new OperationError('invalid_params', `${relPath} resolves outside the source directory.`, 'This is a gbrain defect; report it.');
      const { commitPathsLocked } = await import('../git/commit-push.ts');
      // Private meetings stay database-only on a Git-recorded source; one that became private leaves the checkout.
      if (isPrivate) {
        if (existsSync(filePath)) { rmSync(filePath); commitPathsLocked(cfg.dir, [checkoutPath(root, cfg.dir, relPath)], `meetings(${sourceId}): ${record.id} is private; database only`, { lockWaitMs: 30_000 }); }
      } else {
        mkdirSync(join(filePath, '..'), { recursive: true, mode: 0o700 });
        atomicWriteFileSync(filePath, markdown, { mode: 0o600 });
        commitPathsLocked(cfg.dir, [checkoutPath(root, cfg.dir, relPath)], `meetings(${sourceId}): ${record.title.replace(/\s+/g, ' ').slice(0, 72)}\n\nmeeting_id: ${record.id}\nprovider: ${cfg.provider}`, { lockWaitMs: 30_000 });
      }
    }
    const { importFromContent } = await import('../import-file.ts');
    const result = await importFromContent(engine, slug, markdown, { noEmbed: true, sourceId, sourcePath: relPath, preserveGateMarkers: true });
    if (result.status === 'error' || result.error) throw new Error(result.error ?? `Import failed for ${relPath}`);
    status = result.status === 'imported' ? 'imported' : 'skipped';
    created = !existing;
    summary.chunksCreated += result.chunks;
  }
  if (status !== 'imported') return;
  summary.pagesAffected.push(slug);
  if (created) { summary.added++; return; }
  summary.modified++;
  const retired = await retireFactsFromPage(engine, { sourceId, slug, reason: 'the meeting changed upstream', managed: !!managed });
  summary.factsRetired += retired.retired;
}

async function deleteMeeting(ctx: PublishCtx, meetingId: string, relPath: string): Promise<void> {
  const { engine, sourceId, cfg, managed, summary } = ctx;
  const slug = slugifyPath(relPath);
  const retired = await retireFactsFromPage(engine, { sourceId, slug, reason: 'the meeting was deleted upstream', managed: !!managed });
  summary.factsRetired += retired.retired;
  if (managed) {
    if (await managed.delete(slug, relPath)) summary.deleted++;
    return;
  }
  if (cfg.record === 'git' && cfg.dir) {
    const filePath = join(cfg.dir, relPath);
    const root = await gitCheckoutOf(cfg.dir);
    if (!root) throw bindingMissing(sourceId);
    if (isWriteTargetContained(filePath, cfg.dir) && existsSync(filePath)) {
      rmSync(filePath);
      const { commitPathsLocked } = await import('../git/commit-push.ts');
      commitPathsLocked(cfg.dir, [checkoutPath(root, cfg.dir, relPath)], `meetings(${sourceId}): ${meetingId} deleted upstream`, { lockWaitMs: 30_000 });
    }
  }
  const rows = await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, slug]);
  if (rows.length) { await engine.deletePages([slug], { sourceId }); summary.deleted++; }
}

/** Facts and embeddings for the pages this run published (the connector path has no sync finalize). */
async function afterPublish(ctx: PublishCtx, opts: SyncOpts): Promise<void> {
  const { engine, sourceId, summary, managed } = ctx;
  if (!summary.pagesAffected.length) return;
  if (!opts.noExtract && summary.pagesAffected.length <= 50) {
    const { runFactsBackstop } = await import('../facts/backstop.ts');
    for (const slug of summary.pagesAffected) {
      try {
        const page = await engine.getPage(slug, { sourceId });
        if (!page || isSegmentedPage(page)) continue;
        await runFactsBackstop({ slug, type: page.type, compiled_truth: page.compiled_truth ?? '', frontmatter: page.frontmatter ?? {} },
          { engine, sourceId, sessionId: connectorFactsSession(sourceId, slug), source: 'sync:import', mode: 'queue', notabilityFilter: 'high-only', sourceSlug: slug });
      } catch { /* per-page enqueue is best-effort, as in sync */ }
    }
  } else if (!opts.noExtract) {
    process.stderr.write(`[meetings] ${summary.pagesAffected.length} pages changed; facts are extracted by the cycle's backfill\n`);
  }
  if (managed || opts.noEmbed || summary.pagesAffected.length > 100) return;
  try {
    const { runEmbedCore } = await import('../../commands/embed.ts');
    await runEmbedCore(engine, { slugs: summary.pagesAffected, sourceId });
    summary.embedded = summary.pagesAffected.length;
  } catch { /* embed is best-effort */ }
}
