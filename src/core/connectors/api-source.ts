/**
 * Shared machinery of the API-backed connector sweeps (the meetings and slack
 * kinds, autoplan T30): the coverage window and its committed boundary, the
 * provider rate-limit record the scheduler reads, and the publication of one
 * page in either record mode.
 *
 * Coverage: a run works one window [from, to). `to` is pinned to the run
 * start and persisted with the window, so an interrupted run resumes the same
 * window before a new one opens. The boundary (`committed_to`) advances to
 * `to` only when the caller has covered the whole window. The next window
 * starts `lookbackDays` before the boundary, so late edits and deletions in
 * recent items converge.
 *
 * Records (D5): `git` mode commits each page through the door before its
 * database row (managed: the coordinator; unmanaged: the commit-push door,
 * then the import); `database` mode imports database-only with no directory.
 * A private page stays database-only on a Git-recorded source, and one that
 * became private leaves the checkout. A page whose content changed upstream,
 * or that was deleted upstream, retires the facts extracted from it.
 */
import { join, relative } from 'node:path';
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import type { BrainEngine } from '../engine.ts';
import type { SyncOpts, SyncResult } from '../../commands/sync.ts';
import { OperationError } from '../ops/contract.ts';
import type { ManagedConnectorSync } from '../persistence/connector-sync.ts';
import { carryStoredFences } from './fence-carry.ts';
import { ConnectorAccessDeniedError, ConnectorAuthError, ConnectorRateLimitedError, ConnectorRunLimitError } from './client.ts';
import { atomicWriteFileSync } from '../atomic-write.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { slugifyPath } from '../sync.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';
import { connectorFactsSession, retireFactsFromPage } from '../facts/retire.ts';
import { CONNECTOR_AUTHOR_PREFIX } from '../persistence/content-author-schema.ts';

export const DAY_MS = 86_400_000;

export interface CoverageWindow { from: string; to: string; done: string[] }
export interface CoverageState { committed_to: string | null; window: CoverageWindow | null }

/**
 * The window this run works: the persisted one when an earlier run did not finish it, else
 * [boundary - lookback, runStart) after the first sync and [runStart - history, runStart) before it.
 * `alignFrom` moves `from` back to a boundary the caller needs (the start of a day page).
 */
export function openCoverageWindow(state: CoverageState, opts: { runStart: number; historyDays: number; lookbackDays: number; alignFrom?: (ms: number) => number }): CoverageWindow {
  if (state.window) return state.window;
  const from = state.committed_to ? Date.parse(state.committed_to) - opts.lookbackDays * DAY_MS : opts.runStart - opts.historyDays * DAY_MS;
  state.window = { from: new Date(opts.alignFrom ? opts.alignFrom(from) : from).toISOString(), to: new Date(opts.runStart).toISOString(), done: [] };
  return state.window;
}

/** The window is covered: the boundary moves to its end. Returns the horizon before which no later window reaches. */
export function closeCoverageWindow(state: CoverageState, lookbackDays: number): number {
  const to = state.window!.to;
  state.committed_to = to;
  state.window = null;
  return Date.parse(to) - (lookbackDays + 1) * DAY_MS;
}

/** An unmanaged dry run: these sources fetch and publish in one pass, so a preview calls no provider and writes nothing. */
export function connectorDryRunResult(label: string, sourceId: string): SyncResult {
  process.stderr.write(`[sync] ${sourceId}: a ${label} source has no preview; nothing was fetched or written. Run gbrain sync --source ${sourceId} without --dry-run to sync it.\n`);
  return { status: 'dry_run', fromCommit: null, toCommit: '', added: 0, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [] };
}

/** Errors that stop the whole run (credential, permission, quota, budget, cancel) rather than hold one item. */
export function runScoped(error: unknown): boolean {
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

export function connectorBindingMissing(label: string, sourceId: string): OperationError {
  return new OperationError('connector_binding_missing',
    `${label} source ${sourceId} records to Git, but its checkout is not available; the item was held, not written database-only.`,
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

export interface PublishSummary {
  added: number; modified: number; deleted: number; chunksCreated: number; embedded: number; pagesAffected: string[]; factsRetired: number;
}

export interface ConnectorPublishCtx {
  engine: BrainEngine; sourceId: string; managed: ManagedConnectorSync | null; summary: PublishSummary;
  /** The kind as people name it in messages ("Meetings", "Slack"), and the lower-case tag in commit subjects and logs. */
  label: string; tag: string;
  record: 'git' | 'database'; dir: string | null;
  /** An unmanaged import passes the external-untrusted write gate, as every managed connector import does. */
  gated?: boolean;
}

export interface ConnectorPage {
  relPath: string;
  /** Rendered through `connectorRender`. */
  markdown: string;
  /** Commit message when the page is committed; the subject when a page that became private leaves the checkout. */
  commitMessage: string;
  privateMessage: string;
  /** Recorded on the retired facts when the page changed. */
  retireReason: string;
}

/** Publishes one page in the source's record mode; counts it and retires the facts of a changed page. */
export async function publishConnectorPage(ctx: ConnectorPublishCtx, page: ConnectorPage): Promise<'added' | 'modified' | 'unchanged'> {
  const { engine, sourceId, managed, summary } = ctx;
  const { relPath } = page;
  const slug = slugifyPath(relPath);
  let markdown = page.markdown;
  let status: 'imported' | 'skipped';
  let created: boolean;
  if (managed) {
    if (ctx.record === 'git' && !managed.bound) throw connectorBindingMissing(ctx.label, sourceId);
    const result = await managed.importMarkdown(relPath, markdown);
    status = result.status; created = result.created;
    summary.chunksCreated += result.chunks;
  } else {
    const existing = await engine.getPage(slug, { sourceId });
    markdown = await carryStoredFences(sourceId, slug, relPath, existing, markdown, `${ctx.tag} connector fence carry`);
    const isPrivate = /^visibility: private$/m.test(markdown.split('\n---\n')[0] ?? '');
    if (ctx.record === 'git') {
      const root = await gitCheckoutOf(ctx.dir);
      if (!root || !ctx.dir) throw connectorBindingMissing(ctx.label, sourceId);
      const filePath = join(ctx.dir, relPath);
      if (!isWriteTargetContained(filePath, ctx.dir)) throw new OperationError('invalid_params', `${relPath} resolves outside the source directory.`, 'This is a gbrain defect; report it.');
      const { commitPathsLocked } = await import('../git/commit-push.ts');
      if (isPrivate) {
        if (existsSync(filePath)) { rmSync(filePath); commitPathsLocked(ctx.dir, [checkoutPath(root, ctx.dir, relPath)], page.privateMessage, { lockWaitMs: 30_000 }); }
      } else {
        mkdirSync(join(filePath, '..'), { recursive: true, mode: 0o700 });
        atomicWriteFileSync(filePath, markdown, { mode: 0o600 });
        commitPathsLocked(ctx.dir, [checkoutPath(root, ctx.dir, relPath)], page.commitMessage, { lockWaitMs: 30_000 });
      }
    }
    const { importFromContent } = await import('../import-file.ts');
    const result = await importFromContent(engine, slug, markdown, { noEmbed: true, sourceId, sourcePath: relPath, preserveGateMarkers: true, holdNoncanonicalPrivate: true,
      content_author: `${CONNECTOR_AUTHOR_PREFIX}${ctx.tag}`,
      ...(ctx.gated ? { writeGate: { tier: 'external_untrusted' as const, origin: { channel: `connector:${ctx.tag}`, connector: ctx.tag, source_uri: relPath }, requestId: null } } : {}) });
    if (result.status === 'error' || result.error) throw new Error(result.error ?? `Import failed for ${relPath}`);
    status = result.status === 'imported' ? 'imported' : 'skipped';
    created = !existing;
    summary.chunksCreated += result.chunks;
  }
  if (status !== 'imported') return 'unchanged';
  summary.pagesAffected.push(slug);
  if (created) { summary.added++; return 'added'; }
  summary.modified++;
  const retired = await retireFactsFromPage(engine, { sourceId, slug, reason: page.retireReason, managed: !!managed });
  summary.factsRetired += retired.retired;
  return 'modified';
}

/**
 * Deletes one page whose item was deleted upstream, after retiring its facts. `soft` (apple-contacts) soft-deletes the
 * database row, so `gbrain restore` brings it back within the purge window; the default removes it.
 */
export async function deleteConnectorPage(ctx: ConnectorPublishCtx, relPath: string, commitMessage: string, retireReason: string, opts: { soft?: boolean } = {}): Promise<void> {
  const { engine, sourceId, managed, summary } = ctx;
  const slug = slugifyPath(relPath);
  const retired = await retireFactsFromPage(engine, { sourceId, slug, reason: retireReason, managed: !!managed });
  summary.factsRetired += retired.retired;
  if (managed) {
    if (await managed.delete(slug, relPath)) summary.deleted++;
    return;
  }
  if (ctx.record === 'git' && ctx.dir) {
    const filePath = join(ctx.dir, relPath);
    const root = await gitCheckoutOf(ctx.dir);
    if (!root) throw connectorBindingMissing(ctx.label, sourceId);
    if (isWriteTargetContained(filePath, ctx.dir) && existsSync(filePath)) {
      rmSync(filePath);
      const { commitPathsLocked } = await import('../git/commit-push.ts');
      commitPathsLocked(ctx.dir, [checkoutPath(root, ctx.dir, relPath)], commitMessage, { lockWaitMs: 30_000 });
    }
  }
  const rows = await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, slug]);
  if (rows.length) {
    if (opts.soft) {
      const { maintenanceTransaction } = await import('../persistence/attribution.ts');
      await maintenanceTransaction(engine, tx => tx.softDeletePages([slug], { sourceId }));
    }
    else await engine.deletePages([slug], { sourceId });
    summary.deleted++;
  }
}

/** A connector run queues fact extraction for at most this many pages; the cycle's backfill covers the rest. */
export const CONNECTOR_FACTS_PAGE_LIMIT = 50;

/** Facts and embeddings for the pages a run published (the connector path has no sync finalize). */
export async function afterConnectorPublish(ctx: Pick<ConnectorPublishCtx, 'engine' | 'sourceId' | 'summary' | 'managed' | 'tag'>, opts: SyncOpts): Promise<void> {
  const { engine, sourceId, summary, managed } = ctx;
  if (!summary.pagesAffected.length) return;
  const overLimit = summary.pagesAffected.length > CONNECTOR_FACTS_PAGE_LIMIT;
  // #9552: on a managed brain each import's publication queued its own fact extraction (connector-sync.ts).
  if (!opts.noExtract && !overLimit && !managed) {
    const { runFactsBackstop } = await import('../facts/backstop.ts');
    let failed = 0;
    let firstError = '';
    for (const slug of summary.pagesAffected) {
      try {
        const page = await engine.getPage(slug, { sourceId });
        if (!page || isSegmentedPage(page)) continue;
        await runFactsBackstop({ slug, type: page.type, compiled_truth: page.compiled_truth ?? '', frontmatter: page.frontmatter ?? {} },
          { engine, sourceId, sessionId: connectorFactsSession(sourceId, slug), source: 'sync:import', mode: 'queue', notabilityFilter: 'high-only', sourceSlug: slug });
      } catch (error) {
        failed++;
        firstError ||= error instanceof Error ? error.message : String(error);
        const { writeFactsAbsorbFailure } = await import('../facts/absorb-log.ts');
        await writeFactsAbsorbFailure(engine, slug, error, sourceId);
      }
    }
    if (failed) process.stderr.write(`[${ctx.tag}] ${sourceId}: fact extraction was not queued for ${failed} page(s): ${firstError}\n`);
  } else if (!opts.noExtract && overLimit) {
    process.stderr.write(`[${ctx.tag}] ${summary.pagesAffected.length} pages changed; ${managed ? `facts were queued for the first ${CONNECTOR_FACTS_PAGE_LIMIT}, the rest` : 'facts'} are extracted by the cycle's backfill\n`);
  }
  if (managed || opts.noEmbed || summary.pagesAffected.length > 100) return;
  try {
    const { runEmbedCore } = await import('../../commands/embed.ts');
    await runEmbedCore(engine, { slugs: summary.pagesAffected, sourceId });
    summary.embedded = summary.pagesAffected.length;
  } catch { /* embed is best-effort */ }
}
