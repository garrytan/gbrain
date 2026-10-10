/**
 * I2 taint (#5575: ENG-3, CEO-1, ENG-7): the tier of a derived row is the
 * minimum over every input placed in the model's context for that
 * derivation, capped at agent_written, decided at prompt-build time. A
 * deriver collects the rows it put in the prompt (pages, facts, takes,
 * timeline entries), reads their stored tiers here, declares the result to
 * the attribution seam, and records the complete input edges
 * (`derivation_inputs`, facts/derivation-inputs.ts) right after it writes.
 *
 * Deterministic projections that restate an input without a model (a fence
 * or timeline parse) take the input's tier, capped at operator_curated,
 * instead of the agent_written cap.
 *
 * Text that is not a row (a transcript file, a caller's turn text) enters as
 * a lowering cap: `lowerTo`.
 */
import type { BrainEngine } from '../engine.ts';
import { recordDerivationInputs, type DerivationRef } from '../facts/derivation-inputs.ts';
import {
  OWNER_TIER_FLOOR, compareTrust, effectiveWriteTrust, isTrustTier, minTrust, storedTrustTier, trustRankSql,
  type TaintInput, type TaintTable, type TrustTier, type WriteOrigin, type WriteTrust,
} from './tier.ts';
import { frontmatterTrustCaps } from './channel.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';

/** A row placed in a model's context: by id, or a page by its (source, slug) coordinate. */
export type TaintRef = { table: TaintTable; id: number } | { table: 'pages'; sourceId: string; slug: string };

type Sql = Pick<BrainEngine, 'executeRaw'>;

/**
 * The stored tier of every referenced row, deduplicated. A row that no longer
 * exists reads as `unknown` (a page by slug keeps `source:slug` as its id), so
 * a vanished input can never raise the derived tier.
 */
export async function readTaintInputs(engine: Sql, refs: readonly TaintRef[]): Promise<TaintInput[]> {
  const ids = new Map<TaintTable, Set<number>>();
  const slugs = new Map<string, { source_id: string; slug: string }>();
  for (const ref of refs) {
    if ('slug' in ref) slugs.set(`${ref.sourceId}:${ref.slug}`, { source_id: ref.sourceId, slug: ref.slug });
    else if (Number.isSafeInteger(Number(ref.id))) (ids.get(ref.table) ?? ids.set(ref.table, new Set()).get(ref.table)!).add(Number(ref.id));
  }
  const found = new Map<string, TaintInput>();
  for (const [table, set] of ids) {
    const rows = await engine.executeRaw<{ id: number | string; trust_tier: string | null }>(
      `SELECT id,trust_tier FROM ${table} WHERE id=ANY($1::bigint[])`, [[...set]]);
    for (const row of rows) found.set(`${table}:${row.id}`, { table, id: Number(row.id), tier: storedTrustTier(row.trust_tier) });
    for (const id of set) if (!found.has(`${table}:${id}`)) found.set(`${table}:${id}`, { table, id, tier: 'unknown' });
  }
  if (slugs.size) {
    const rows = await engine.executeRaw<{ id: number | string; source_id: string; slug: string; trust_tier: string | null }>(
      `SELECT p.id,p.source_id,p.slug,p.trust_tier FROM pages p
        JOIN jsonb_to_recordset($1::text::jsonb) AS r(source_id text,slug text) ON p.source_id=r.source_id AND p.slug=r.slug`,
      [JSON.stringify([...slugs.values()])]);
    const bySlug = new Map(rows.map(row => [`${row.source_id}:${row.slug}`, row]));
    for (const [key] of slugs) {
      const row = bySlug.get(key);
      if (row) found.set(`pages:${row.id}`, { table: 'pages', id: Number(row.id), tier: storedTrustTier(row.trust_tier) });
      else found.set(`pages:${key}`, { table: 'pages', id: key, tier: 'unknown' });
    }
  }
  return [...found.values()];
}

/** The tier the frontmatter of a not-yet-imported page (a transcript file read from disk) names, or undefined. */
export function frontmatterTaint(frontmatter: Record<string, unknown> | null | undefined): TrustTier | undefined {
  const caps = frontmatterTrustCaps(frontmatter);
  return caps.length ? minTrust(caps[0], ...caps.slice(1)) : undefined;
}

export interface DerivedTrustInput {
  /** The write path, e.g. `derive:synthesize`, `derive:facts_backstop`. */
  channel: string;
  /** Every row placed in the model's context (ENG-3). */
  inputs: readonly TaintInput[];
  /** Tiers of context text that is not a row (caller turn text, a transcript file). */
  lowerTo?: readonly TrustTier[];
  requestId?: string | null;
  sourceUri?: string | null;
  /** A deterministic restatement of its inputs (no model): capped at operator_curated, not agent_written. */
  projection?: boolean;
}

/** The WriteTrust of one derivation, computed once (trust/tier.ts effectiveWriteTrust). */
export function derivedWriteTrust(input: DerivedTrustInput): WriteTrust {
  const lowerTo = [...input.lowerTo ?? []];
  if (input.projection && !input.inputs.length && !lowerTo.length) lowerTo.push('unknown');
  return effectiveWriteTrust({
    channel: input.projection ? OWNER_TIER_FLOOR : 'agent_written',
    derived: !input.projection,
    inputs: input.inputs,
    lowerTo,
    origin: { channel: input.channel, ...(input.requestId ? { request_id: input.requestId } : {}),
      ...(input.sourceUri ? { source_uri: input.sourceUri } : {}) },
  });
}

/** Reads the inputs' tiers and builds the derivation's WriteTrust in one call. */
export async function deriveTrust(engine: Sql, refs: readonly TaintRef[], input: Omit<DerivedTrustInput, 'inputs'>):
  Promise<{ trust: WriteTrust; inputs: TaintInput[] }> {
  const inputs = await readTaintInputs(engine, refs);
  return { trust: derivedWriteTrust({ ...input, inputs }), inputs };
}

/**
 * ENG-7: the complete input edges of one derived row, written in the same
 * transaction right after the row. Inputs read as `unknown` because they
 * vanished keep their recorded reference.
 */
export async function recordTaintEdges(tx: BrainEngine, derived: { table: TaintTable; id: number; sourceId?: string | null },
  inputs: readonly Pick<TaintInput, 'table' | 'id'>[]): Promise<void> {
  if (!inputs.length) return;
  await recordDerivationInputs(tx, derived, inputs.map(({ table, id }): DerivationRef => ({ table, id })));
}

/**
 * Lowers rows to a derivation's tier, never raising. A derived write that
 * changes no content column (a re-promotion that only refreshes `source`, a
 * provenance republish with identical content) keeps the stored tier under
 * the trigger rule, so the deriver lowers explicitly; the trigger allows any
 * lowering. Returns the ids lowered.
 */
export async function lowerToDerivedTier(tx: Sql, table: TaintTable, ids: readonly number[], trust: WriteTrust): Promise<number[]> {
  if (!ids.length) return [];
  const rows = await tx.executeRaw<{ id: number | string }>(
    `UPDATE ${table} SET trust_tier=$2,write_origin=$3::text::jsonb
      WHERE id=ANY($1::bigint[]) AND ${trustRankSql('trust_tier')}>${trustRankSql('$2::text')} RETURNING id`,
    [[...ids], trust.tier, trust.origin ? JSON.stringify(trust.origin) : null]);
  return rows.map(row => Number(row.id));
}

/** A row a derivation wrote, for the lowering and edge pass. */
export interface DerivedRowRef { table: TaintTable; id: number; sourceId?: string | null }

/**
 * An unmanaged deriver's write: one attributed maintenance transaction at the
 * derivation's tier; every row `fn` reports is lowered to that tier (when its
 * content did not change) and gets its complete input edges.
 */
export async function derivedMaintenanceTransaction<T>(engine: BrainEngine, derivation: { trust: WriteTrust; inputs: readonly TaintInput[] },
  fn: (tx: BrainEngine) => Promise<{ result: T; rows: readonly DerivedRowRef[] }>): Promise<T> {
  return maintenanceTransaction(engine, async tx => {
    const { result, rows } = await fn(tx);
    for (const row of rows) {
      await lowerToDerivedTier(tx, row.table, [row.id], derivation.trust);
      await recordTaintEdges(tx, row, derivation.inputs);
    }
    return result;
  }, derivation.trust);
}

/**
 * A derived page written through a path that stamps by its own channel (an
 * unmanaged importFromContent): lowers the live page to the derivation's
 * taint and records its edges, in one attributed transaction.
 */
export async function lowerDerivedPage(engine: BrainEngine, derivation: { trust: WriteTrust; inputs: readonly TaintInput[] },
  sourceId: string, slug: string): Promise<void> {
  await derivedMaintenanceTransaction(engine, derivation, async tx => ({ result: undefined,
    rows: (await tx.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, slug]))
      .map(row => ({ table: 'pages' as const, id: Number(row.id), sourceId })) }));
}

// ---------------------------------------------------------------------------
// Declarations carried in a journaled maintenance intent
// ---------------------------------------------------------------------------

/**
 * A derivation declared by the deriver at prompt-build time and carried in its
 * maintenance or facts request intent, so the preparer stamps the same tier
 * and records the same edges when the coordinator publishes it.
 */
export interface DerivationDeclaration { tier: TrustTier; origin: WriteOrigin; inputs: Array<Pick<TaintInput, 'table' | 'id'>> }

export function declareDerivation(trust: WriteTrust, inputs: readonly TaintInput[]): DerivationDeclaration {
  return { tier: trust.tier, origin: trust.origin ?? { channel: 'derive:unnamed' }, inputs: inputs.map(({ table, id }) => ({ table, id })) };
}

const TAINT_TABLES: readonly string[] = ['facts', 'takes', 'pages', 'timeline_entries'];

/** A declaration read back from a stored intent, or null when absent or malformed. */
export function readDerivationDeclaration(value: unknown): DerivationDeclaration | null {
  const v = value as Partial<DerivationDeclaration> | null | undefined;
  if (!v || typeof v !== 'object' || !isTrustTier(v.tier) || !v.origin || typeof v.origin.channel !== 'string' || !Array.isArray(v.inputs)) return null;
  if (v.inputs.some(i => !i || !TAINT_TABLES.includes(i.table as string) || (typeof i.id !== 'number' && typeof i.id !== 'string'))) return null;
  return v as DerivationDeclaration;
}

/**
 * The WriteTrust a preparer declares for a stored derivation: never above
 * `ceiling` (agent_written for model output) and never above any input in its
 * sample. A missing declaration (an intent queued before tiers) is `unknown`.
 */
export function declaredWriteTrust(declaration: DerivationDeclaration | null, ceiling: TrustTier = 'agent_written'): WriteTrust {
  if (!declaration) return { tier: minTrust('unknown', ceiling), origin: null };
  const sample = (declaration.origin.taint_inputs ?? []).map(i => storedTrustTier(i.tier));
  const tier = minTrust(declaration.tier, ceiling, ...sample);
  return { tier, origin: declaration.origin };
}

/** Whether `tier` is external_untrusted (or lower): the partition rule's test (ENG-3). */
export function isExternalTier(tier: TrustTier): boolean {
  return compareTrust(tier, 'external_untrusted') <= 0;
}

/**
 * CEO-24 diagnostic (never gated): how many derived rows (those whose
 * `write_origin` carries `taint_inputs`) are stamped external_untrusted, across
 * facts, takes, timeline entries and pages. One scan per table, like the tier
 * counts beside it in doctor.
 */
export async function readDerivedTaintShare(engine: Sql): Promise<{ rows: number; external_untrusted: number; external_pct: number }> {
  let rows = 0, external = 0;
  for (const table of ['facts', 'takes', 'timeline_entries', 'pages'] as const) {
    const [row] = await engine.executeRaw<{ derived: number | string; external: number | string }>(
      `SELECT count(*) FILTER (WHERE write_origin ? 'taint_inputs') AS derived,
              count(*) FILTER (WHERE write_origin ? 'taint_inputs' AND trust_tier = 'external_untrusted') AS external FROM ${table}`);
    rows += Number(row?.derived ?? 0);
    external += Number(row?.external ?? 0);
  }
  return { rows, external_untrusted: external, external_pct: rows === 0 ? 0 : Math.round((external / rows) * 10_000) / 100 };
}
