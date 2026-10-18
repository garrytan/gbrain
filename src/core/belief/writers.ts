/**
 * Writer-side helpers of the finalization contract (docs/designs/BELIEF_LEDGER.md
 * sections 5.1 and 6.2) for transactions outside the publication paths: a
 * refusal that files its proposal in its own transaction, a database-only
 * coordinated write, an owner action. Each locks its streams' page keys first
 * (so the batch's reads and appends happen under them), runs its writes in a
 * belief batch and writes the commit mark after commit.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { maintenanceAttribution } from '../persistence/attribution.ts';
import { withWriteAttribution } from '../persistence/context.ts';
import { validateSlug } from '../utils.ts';
import { normalizeDimension } from '../chronicle/ontology.ts';
import { markBeliefCommits } from './append.ts';
import { withBeliefBatch, type BeliefBatchOptions } from './ledger.ts';

const validSlug = (slug: string | null | undefined): slug is string => {
  if (!slug) return false;
  try { validateSlug(slug); return true; } catch { return false; }
};

/** The ledger stream slug of each row: a fact's fence page else its entity, a take's page, a page's own slug. */
export async function beliefStreamSlugs(tx: Pick<BrainEngine, 'executeRaw'>, table: 'facts' | 'takes' | 'pages', ids: readonly number[]): Promise<string[]> {
  if (!ids.length) return [];
  const sql = table === 'facts' ? 'SELECT COALESCE(source_markdown_slug, entity_slug) AS slug FROM facts WHERE id = ANY($1::bigint[])'
    : table === 'takes' ? 'SELECT p.slug FROM takes t JOIN pages p ON p.id = t.page_id WHERE t.id = ANY($1::bigint[])'
      : 'SELECT slug FROM pages WHERE id = ANY($1::int[])';
  const rows = await tx.executeRaw<{ slug: string | null }>(sql, [[...ids]]);
  return [...new Set(rows.map(r => r.slug).filter(validSlug))].sort();
}

/**
 * The streams an ontology observation can change: the entity, the new row's
 * provenance (`source_markdown_slug` is the observation's `source`) and the
 * provenance of each open stint it may close. Read before the write's lock;
 * every ontology writer also holds the entity's key, so the open stints do not
 * change between this read and the write.
 */
export async function ontologyStreamSlugs(tx: Pick<BrainEngine, 'executeRaw'>, sourceId: string, entity: string, dimension: string, source: string): Promise<string[]> {
  const open = await tx.executeRaw<{ slug: string | null }>(`SELECT DISTINCT source_markdown_slug AS slug FROM facts
    WHERE source_id = $1 AND entity_slug = $2 AND dimension = $3 AND expired_at IS NULL AND valid_until IS NULL`, [sourceId, entity, normalizeDimension(dimension)]);
  return [...new Set([entity, source, ...open.map(r => r.slug)].filter(validSlug))].sort();
}

/**
 * Locks `opts.slugs` and runs `fn` in a belief batch inside `tx`, which must not
 * hold page keys yet (the keys are taken in lockPageKeys' sorted order).
 */
export async function lockedBeliefBatch<T>(tx: BrainEngine, opts: BeliefBatchOptions, fn: () => Promise<T>): Promise<T> {
  const slugs = [...new Set(opts.slugs.filter(validSlug))];
  await tx.lockPageKeys(slugs.map(slug => ({ sourceId: opts.sourceId, slug })));
  return withBeliefBatch(tx, { ...opts, slugs }, fn);
}

/**
 * A transaction of its own whose writes the ledger records: `fn` runs in a
 * locked batch, and the commit mark is written after commit. `wrap` sets the
 * transaction's attribution around the batch, so the batch reads the writer's
 * tier.
 */
export async function beliefTransaction<T>(engine: BrainEngine, opts: Omit<BeliefBatchOptions, 'report' | 'publicationId'> & { publicationId: string },
  fn: (tx: BrainEngine) => Promise<T>, wrap: (tx: BrainEngine, run: () => Promise<T>) => Promise<T> = (_tx, run) => run()): Promise<T> {
  const report = { appended: 0 };
  const result = await engine.transaction(async tx => {
    const slugs = [...new Set(opts.slugs.filter(validSlug))];
    await tx.lockPageKeys(slugs.map(slug => ({ sourceId: opts.sourceId, slug })));
    return wrap(tx, () => withBeliefBatch(tx, { ...opts, slugs, report }, () => fn(tx)));
  });
  if (report.appended) await markBeliefCommits(engine, [opts.publicationId]).catch(() => undefined);
  return result;
}

/** A maintenance transaction (sync or import housekeeping) whose page writes the ledger records, e.g. a cheap rename that keeps the row. */
export async function maintenanceBeliefTransaction<T>(engine: BrainEngine, opts: { sourceId: string; slugs: readonly string[]; op: string },
  fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
  const attribution = await maintenanceAttribution(engine);
  return beliefTransaction(engine, { ...opts, publicationId: randomUUID(), remote: false }, fn, (tx, run) => withWriteAttribution(tx, attribution, run));
}
