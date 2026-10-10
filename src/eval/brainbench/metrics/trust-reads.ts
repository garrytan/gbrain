/**
 * Shared observations for the memory-trust suites: what explicit reads
 * (get_page, search, recall) report about a row, and whether a canary token
 * survives in a live store outside the write gate's hold and quarantine.
 * Every read goes through the operation handlers as the fixture's remote
 * connection, the shape an agent sees.
 */

import { operationsByName } from '../../../core/operations.ts';
import type { OperationContext } from '../../../core/ops/contract.ts';
import { storedTrustTier, TRUST_TIER_RANK, type TrustTier } from '../../../core/trust/tier.ts';
import type { TrustFixtureRun, TrustRowRef } from '../trust-scenario.ts';

export interface ExplicitRead {
  /** Tier each explicit surface reported; absent when the surface did not return the row. */
  surfaces: Partial<Record<'get_page' | 'search' | 'recall', TrustTier>>;
  /** Any explicit surface marked the row "unconfirmed, agent-written". */
  unconfirmed: boolean;
}

async function call(ctx: OperationContext, name: string, params: Record<string, unknown>): Promise<unknown> {
  const def = operationsByName[name];
  if (!def) return null;
  try {
    return await def.handler(ctx, params);
  } catch {
    return null;
  }
}


export async function explicitPageRead(run: TrustFixtureRun, slug: string, sourceId = run.sourceId): Promise<ExplicitRead> {
  const out: ExplicitRead = { surfaces: {}, unconfirmed: false };
  const page = await call(run.remote, 'get_page', { slug, source_id: sourceId }) as Record<string, unknown> | null;
  if (page && typeof page.trust_tier === 'string') {
    out.surfaces.get_page = storedTrustTier(page.trust_tier);
    if (page.unconfirmed === true) out.unconfirmed = true;
  }
  const [row] = await run.engine.executeRaw<{ title: string | null }>('SELECT title FROM pages WHERE source_id = $1 AND slug = $2', [sourceId, slug]);
  const query = row?.title || slug.split('/').pop()!.replace(/-/g, ' ');
  const hits = await call(run.remote, 'search', { query, limit: 20 }) as unknown;
  const rows = Array.isArray(hits) ? hits : Array.isArray((hits as { results?: unknown })?.results) ? (hits as { results: unknown[] }).results : [];
  // A page can return several chunks; a fence chunk carrying a lower-tier row is labeled with that
  // row's tier (ENG-1). The page's own label is the highest one its hits carry, and no hit may claim more.
  const pageHits = (rows as Array<Record<string, unknown>>).filter(r => r.slug === slug && (r.source_id === undefined || r.source_id === sourceId));
  for (const hit of pageHits) {
    if (typeof hit.trust_tier !== 'string') continue;
    const tier = storedTrustTier(hit.trust_tier);
    if (!out.surfaces.search || TRUST_TIER_RANK[tier] > TRUST_TIER_RANK[out.surfaces.search]) out.surfaces.search = tier;
    if (hit.unconfirmed === true) out.unconfirmed = true;
  }
  return out;
}

export async function explicitFactRead(run: TrustFixtureRun, factId: number): Promise<ExplicitRead & { active: boolean }> {
  const out = { surfaces: {} as ExplicitRead['surfaces'], unconfirmed: false, active: false };
  const [row] = await run.engine.executeRaw<{ entity_slug: string | null; fact: string }>('SELECT entity_slug, fact FROM facts WHERE id = $1', [factId]);
  if (!row) return out;
  const res = await call(run.remote, 'recall', row.entity_slug ? { entity: row.entity_slug, limit: 50 } : { query: row.fact, limit: 50 }) as { facts?: Array<Record<string, unknown>> } | null;
  const fact = res?.facts?.find(f => Number(f.id) === factId);
  if (fact) {
    out.active = true;
    if (typeof fact.trust_tier === 'string') out.surfaces.recall = storedTrustTier(fact.trust_tier);
    if (fact.unconfirmed === true) out.unconfirmed = true;
  }
  return out;
}

/** Facts recall returns as current for an entity (explicit read, remote connection). */
export async function currentFactIds(run: TrustFixtureRun, entity: string): Promise<Set<number>> {
  const res = await call(run.remote, 'recall', { entity, limit: 100 }) as { facts?: Array<Record<string, unknown>> } | null;
  return new Set((res?.facts ?? []).filter(f => !f.expired_at && !f.superseded_by).map(f => Number(f.id)));
}

export async function rowExplicitRead(run: TrustFixtureRun, ref: TrustRowRef): Promise<ExplicitRead> {
  if (ref.table === 'facts') return explicitFactRead(run, ref.id);
  const [p] = await run.engine.executeRaw<{ slug: string; source_id: string }>('SELECT slug, source_id FROM pages WHERE id = $1', [ref.id]);
  return p ? explicitPageRead(run, p.slug, p.source_id) : { surfaces: {}, unconfirmed: false };
}

export function atOrBelow(tier: TrustTier | null, ceiling: TrustTier): boolean {
  return tier !== null && TRUST_TIER_RANK[tier] <= TRUST_TIER_RANK[ceiling];
}

const QUARANTINED = (alias: string) => `(COALESCE(${alias}.frontmatter, '{}'::jsonb) ? 'quarantine')`;

/**
 * A canary is durable when a live, non-quarantined page, chunk, timeline
 * entry or take carries it, or an active fact does whose source page is not
 * quarantined. Write-gate holds and quarantined pages do not count.
 */
export async function canaryPersisted(run: TrustFixtureRun, canary: string): Promise<boolean> {
  const like = canary.toLowerCase();
  const checks = [
    `SELECT 1 FROM pages p WHERE p.source_id = ANY($1::text[]) AND p.deleted_at IS NULL AND NOT ${QUARANTINED('p')}
       AND strpos(lower(coalesce(p.title,'') || ' ' || coalesce(p.compiled_truth,'') || ' ' || coalesce(p.timeline,'') || ' ' || coalesce(p.frontmatter::text,'')), $2) > 0 LIMIT 1`,
    `SELECT 1 FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.source_id = ANY($1::text[]) AND p.deleted_at IS NULL AND NOT ${QUARANTINED('p')}
       AND strpos(lower(c.chunk_text), $2) > 0 LIMIT 1`,
    `SELECT 1 FROM facts f WHERE f.source_id = ANY($1::text[]) AND f.expired_at IS NULL AND strpos(lower(f.fact || ' ' || coalesce(f.context,'')), $2) > 0
       AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id AND p.slug = f.source_markdown_slug AND ${QUARANTINED('p')}) LIMIT 1`,
    `SELECT 1 FROM timeline_entries t JOIN pages p ON p.id = t.page_id WHERE p.source_id = ANY($1::text[]) AND NOT ${QUARANTINED('p')}
       AND strpos(lower(t.summary || ' ' || coalesce(t.detail,'')), $2) > 0 LIMIT 1`,
    `SELECT 1 FROM takes k JOIN pages p ON p.id = k.page_id WHERE p.source_id = ANY($1::text[]) AND NOT ${QUARANTINED('p')} AND k.active
       AND strpos(lower(k.claim), $2) > 0 LIMIT 1`,
  ];
  for (const sql of checks) {
    const rows = await run.engine.executeRaw(sql, [run.sourceIds, like]);
    if (rows.length) return true;
  }
  return false;
}

/** The canary sits in a held write or a quarantined page (the gate kept it, reviewably). */
export async function canaryHeld(run: TrustFixtureRun, canary: string): Promise<boolean> {
  const like = canary.toLowerCase();
  const held = await run.engine.executeRaw(
    `SELECT 1 FROM write_gate_holds h WHERE h.source_id = ANY($1::text[]) AND h.status = 'held' AND strpos(lower(h.payload::text), $2) > 0 LIMIT 1`, [run.sourceIds, like]);
  if (held.length) return true;
  const quarantined = await run.engine.executeRaw(
    `SELECT 1 FROM pages p WHERE p.source_id = ANY($1::text[]) AND p.deleted_at IS NULL AND ${QUARANTINED('p')}
       AND strpos(lower(coalesce(p.compiled_truth,'') || ' ' || coalesce(p.title,'')), $2) > 0 LIMIT 1`, [run.sourceIds, like]);
  return quarantined.length > 0;
}

/** A flag receipt from the write gate names this row. */
export async function rowFlagged(run: TrustFixtureRun, ref: TrustRowRef): Promise<boolean> {
  const rows = await run.engine.executeRaw(
    `SELECT 1 FROM write_gate_receipts WHERE target_table = $1 AND target_id = $2 AND verdict = 'flag' LIMIT 1`, [ref.table, String(ref.id)]);
  return rows.length > 0;
}
