import type { BrainEngine } from '../engine.ts';
import type { ParsedPage } from '../import-file.ts';
import { isFactsBackstopEligible } from '../facts/eligibility.ts';
import { isFactsExtractionEnabled } from '../facts/extract.ts';
import { resolvePageWriteNotabilityFilter } from '../facts/notability-filter.ts';
import { MinionQueue } from '../minions/queue.ts';
import type { MinionJobStatus } from '../minions/types.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { authorizeStoredRequest, authorizeWrite } from './authority.ts';
import { completeEffect } from './effect-journal.ts';
import { guardEffectSource } from './effect-recovery.ts';
import { derivedExtractionSkip } from './derived-extraction-gate.ts';
import type { PersistenceEffect } from './effect-model.ts';
import type { WriteRequest } from './model.ts';

export type FactsBackstopStatus = { queued: true } | { skipped: string };

export async function authorizeFactsBackstop(engine: BrainEngine, row: WriteRequest, lock = false): Promise<void> {
  if (derivedExtractionSkip(row.authority) === 'slug_bound_client') {
    throw opError('permission_denied', 'A confined writer cannot extract into unnamed entity pages.',
      `The write of ${row.slug} came from a slug-bound client, so facts are not extracted into entity pages outside its prefixes; the page itself is written. Widening that client's grant is the brain host operator's decision.`);
  }
  await authorizeStoredRequest(engine, row, lock);
  await authorizeWrite(engine, row.authority, 'extract_facts', row.slug, lock);
  // A grant may have become confined while the page itself remains in scope.
  if (row.principal_kind === 'oauth_client') {
    const [current] = await engine.executeRaw<{ bound_slug_prefixes: unknown }>('SELECT bound_slug_prefixes FROM oauth_clients WHERE client_id=$1', [row.principal_id]);
    if (current?.bound_slug_prefixes != null) throw opError('permission_denied', 'The current writer grant is confined.',
      `OAuth client ${row.principal_id} is now bound to slug prefixes, so facts from ${row.slug} are not extracted; the page itself is written. Widening the grant is the brain host operator's decision.`,
      { fix: readFix('Lists the OAuth clients with their bound slug prefixes, read-only.', { argv: ['gbrain', 'auth', 'clients', '--json'] }) });
  } else if (row.principal_kind === 'local_cli' || row.principal_kind === 'local_stdio') {
    const [current] = await engine.executeRaw<{ prefixes: unknown }>("SELECT grant_ceiling->'slugPrefixes' AS prefixes FROM persistence_local_writers WHERE id=$1::uuid", [row.principal_id]);
    if (current?.prefixes != null) throw opError('permission_denied', 'The current writer grant is confined.',
      `Local writer ${row.principal_id} now has slug prefixes, so facts from ${row.slug} are not extracted; the page itself is written. Replacing the grant is the user's decision.`,
      { fix: readFix('Lists the local writer registrations and their grants, read-only.', { argv: ['gbrain', 'auth', 'local-writer', 'list', '--json'] }) });
  }
}

/** Job states from which a facts-absorb job can still start, and so can still be superseded by a newer revision. */
const STARTABLE_JOB_STATES: readonly MinionJobStatus[] = ['waiting', 'delayed', 'paused', 'waiting-children', 'active'];

/**
 * Whether an extraction bound to this page row has yet to read it: a
 * facts-backstop effect still in the outbox, or a facts-absorb job that can
 * still start. Both carry the page id and revision, so the next revision ends
 * them as `superseded`.
 */
async function extractionPendingForPage(engine: BrainEngine, pageId: number): Promise<boolean> {
  const [row] = await engine.executeRaw<{ pending: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM persistence_effects
                     WHERE kind = 'facts-backstop' AND state IN ('queued', 'running') AND data->>'page_id' = $1)
         OR EXISTS (SELECT 1 FROM minion_jobs
                     WHERE name = 'facts-absorb' AND status = ANY($2::text[]) AND data->>'page_id' = $1) AS pending`,
    [String(pageId), [...STARTABLE_JOB_STATES]]);
  return row?.pending === true;
}

async function extractionCompletedForPage(engine: BrainEngine, pageId: number): Promise<boolean> {
  const [row] = await engine.executeRaw<{ done: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM minion_jobs
                     WHERE name = 'facts-absorb' AND status = 'completed' AND data->>'page_id' = $1) AS done`,
    [String(pageId)]);
  return row?.done === true;
}

/**
 * #6042: the extractor reads compiled_truth only. When the page was live and
 * already eligible before this write and the write keeps its compiled_truth
 * (a title, tag, frontmatter or timeline change, such as `repair timeline`
 * writing back rows the database already holds), there is nothing new to
 * extract, provided an extraction already completed for this page. A page no
 * extraction ever completed for still queues one (#6071, maintainer decision B),
 * and so does a page with an extraction still pending: this write supersedes it,
 * so the write must queue in its place.
 */
async function bodyAlreadyOffered(engine: BrainEngine, slug: string, page: ParsedPage, before: PageSnapshot | null): Promise<boolean> {
  const live = before && !before.page.deleted_at ? before.page : null;
  if (!live || live.compiled_truth !== page.compiled_truth) return false;
  if (!isFactsBackstopEligible(slug, live).ok) return false;
  if (!(await extractionCompletedForPage(engine, live.id))) return false;
  return !(await extractionPendingForPage(engine, live.id));
}

/**
 * Provider availability belongs to the durable job's execution process.
 * `before` is the page as this write found it (null for a new page).
 */
export async function prepareFactsBackstop(engine: BrainEngine, row: WriteRequest, page: ParsedPage, before: PageSnapshot | null = null): Promise<FactsBackstopStatus> {
  const confined = derivedExtractionSkip(row.authority);
  if (confined) return { skipped: confined };
  if (!(await isFactsExtractionEnabled(engine))) return { skipped: 'extraction_disabled' };
  const eligible = isFactsBackstopEligible(row.slug, page);
  if (!eligible.ok) return { skipped: eligible.reason };
  if (await bodyAlreadyOffered(engine, row.slug, page, before)) return { skipped: 'body_unchanged' };
  return { queued: true };
}

/** Optional fence on new durable jobs; old jobs retain their established input contract. */
export async function readFactsBackstopJobPage(engine: BrainEngine, data: Record<string, unknown>) {
  const slug = typeof data.slug === 'string' ? data.slug : '';
  const sourceId = typeof data.sourceId === 'string' ? data.sourceId : 'default';
  const [brain] = await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1');
  if (brain?.enabled && data.persistence_request_id === undefined) return { skipped: 'missing_write_authority' } as const;
  const snapshot = await engine.readPageSnapshot(slug, { sourceId });
  if (!snapshot) return { skipped: 'page_missing' } as const;
  if (data.persistence_request_id !== undefined) {
    if (typeof data.persistence_request_id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(data.persistence_request_id)) return { skipped: 'invalid_write_request' } as const;
    const [row] = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [data.persistence_request_id]);
    if (!row || row.state !== 'committed' || row.slug !== slug || row.source_id !== sourceId
      || row.source_incarnation !== snapshot.sourceIncarnation || snapshot.page.id !== data.page_id
      || snapshot.revision !== data.revision) return { skipped: 'superseded' } as const;
    try { await authorizeFactsBackstop(engine, row); }
    catch (error) {
      if (error instanceof OperationError && ['permission_denied', 'source_changed'].includes(error.code)) return { skipped: error.code } as const;
      throw error;
    }
  }
  return { page: snapshot.page };
}

/** Job insertion and outbox completion commit together; losing their ACK cannot create another job. */
export async function dispatchFactsBackstopEffect(engine: BrainEngine, effect: PersistenceEffect, hostId: string): Promise<void> {
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true)");
    await guardEffectSource(tx, effect, hostId);
    const [row] = await tx.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [effect.request_id]);
    let skipped: string | undefined;
    if (!row || row.state !== 'committed') skipped = 'invalid_write_request';
    if (row && !skipped) {
      try { await authorizeFactsBackstop(tx, row, true); }
      catch (error) {
        if (error instanceof OperationError && ['permission_denied', 'source_changed'].includes(error.code)) skipped = error.code;
        else throw error;
      }
    }
    if (effect.data.slug) await tx.lockPageKeys([{ sourceId: effect.source_id, slug: effect.data.slug }]);
    const [current] = await tx.executeRaw<PersistenceEffect>('SELECT * FROM persistence_effects WHERE id=$1 FOR UPDATE', [effect.id]);
    if (!current || current.state !== 'running' || current.execution_token !== effect.execution_token) return;
    const snapshot = effect.data.slug ? await tx.readPageSnapshot(effect.data.slug, { sourceId: effect.source_id }) : null;
    if (!snapshot || snapshot.page.id !== effect.data.page_id || snapshot.revision !== effect.revision) skipped ??= 'superseded';
    if (!(await isFactsExtractionEnabled(tx))) skipped ??= 'extraction_disabled';
    if (skipped) { await completeEffect(tx, effect, { facts: 'skipped', reason: skipped }); return; }
    // #6231: the page-write filter in force when the effect dispatches; the job keeps it across retries.
    const notabilityFilter = await resolvePageWriteNotabilityFilter(tx);
    const job = await new MinionQueue(tx).add('facts-absorb', {
      slug: effect.data.slug, sourceId: effect.source_id, source: 'mcp:put_page', notabilityFilter,
      visibility: effect.data.visibility === 'world' ? 'world' : 'private',
      persistence_request_id: effect.request_id, page_id: effect.data.page_id, revision: effect.revision,
    }, { queue: 'default', idempotency_key: `facts-absorb:write:${effect.request_id}`, max_attempts: 5, backoff_delay: 60_000 });
    await completeEffect(tx, effect, { facts: 'queued', job_id: job.id });
  });
}
