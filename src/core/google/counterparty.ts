/**
 * Counterparty resolution for open loops (#5504, wave 14 P4.1).
 *
 * A loop's counterparty is a person named in a connector source (a Gmail
 * sweep), while the person's page often lives in another source (`default`
 * on a federated brain). Resolution runs in two steps and records the source
 * it landed in, so `open_loops.counterparty_source_id` can confine every
 * later read to one (source, slug) page:
 *
 *   1. the loop's OWN source, through the ordinary resolver, any
 *      high-confidence arm (never the slugify fallback);
 *   2. failing that, ACROSS sources by identity only (T8): the exact email
 *      as a page alias (one live page in one other source), or a page the
 *      own-source hit belongs to through `entity_identities` whose canonical
 *      member sits elsewhere. A display name never crosses a source
 *      boundary, and a tie (two sources match) stays unresolved.
 *
 * Facts stay in the connector source (T5): this module only decides where
 * the loop row and its typed edge point.
 */
import type { BrainEngine } from '../engine.ts';
import { normalizeAlias } from '../search/alias-normalize.ts';
import { isUndefinedTableError } from '../utils.ts';

export interface ResolvedCounterparty {
  slug: string;
  sourceId: string;
  via: 'same_source' | 'identity_canonical' | 'email_alias';
}

/** The identity group's canonical member when the page has one in ANOTHER source. */
async function canonicalTwin(engine: BrainEngine, sourceId: string, slug: string): Promise<{ slug: string; sourceId: string } | null> {
  try {
    const rows = await engine.executeRaw<{ slug: string; source_id: string }>(
      `SELECT c.slug, ei.source_id
         FROM entity_identities me
         JOIN pages p ON p.id = me.page_id AND p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL
         JOIN entity_identities ei ON ei.entity_id = me.entity_id AND ei.canonical AND ei.source_id <> $1
         JOIN pages c ON c.id = ei.page_id AND c.deleted_at IS NULL
        LIMIT 2`,
      [sourceId, slug],
    );
    return rows.length === 1 ? { slug: rows[0]!.slug, sourceId: rows[0]!.source_id } : null;
  } catch (err) {
    if (isUndefinedTableError(err)) return null;
    throw err;
  }
}

/** A live page in exactly one other source that declares the exact email as an alias. */
async function emailAliasElsewhere(engine: BrainEngine, sourceId: string, email: string): Promise<{ slug: string; sourceId: string } | null> {
  const norm = normalizeAlias(email);
  if (!norm || !norm.includes('@')) return null;
  try {
    const rows = await engine.executeRaw<{ slug: string; source_id: string }>(
      `SELECT DISTINCT pa.slug, pa.source_id
         FROM page_aliases pa
         JOIN pages p ON p.slug = pa.slug AND p.source_id = pa.source_id AND p.deleted_at IS NULL
        WHERE pa.alias_norm = $1 AND pa.source_id <> $2
        LIMIT 2`,
      [norm, sourceId],
    );
    return rows.length === 1 ? { slug: rows[0]!.slug, sourceId: rows[0]!.source_id } : null;
  } catch (err) {
    if (isUndefinedTableError(err)) return null;
    throw err;
  }
}

/**
 * Where the loop's counterparty page is, or null when nothing resolves with
 * confidence. `name` and `email` are what the detector or the model saw;
 * either may be empty.
 */
export async function resolveCounterparty(
  engine: BrainEngine,
  sourceId: string,
  ref: { name?: string | null; email?: string | null },
): Promise<ResolvedCounterparty | null> {
  const own = [ref.name?.trim(), ref.email?.trim()].filter((v): v is string => Boolean(v));
  if (own.length === 0) return null;
  const { resolveEntitySlugWithSource } = await import('../entities/resolve.ts');
  for (const raw of own) {
    const resolved = await resolveEntitySlugWithSource(engine, sourceId, raw);
    if (!resolved || resolved.source === 'fallback_slugify') continue;
    const canonical = await canonicalTwin(engine, sourceId, resolved.slug);
    return canonical ? { ...canonical, via: 'identity_canonical' } : { slug: resolved.slug, sourceId, via: 'same_source' };
  }
  const elsewhere = ref.email ? await emailAliasElsewhere(engine, sourceId, ref.email) : null;
  if (!elsewhere) return null;
  const canonical = await canonicalTwin(engine, elsewhere.sourceId, elsewhere.slug);
  return canonical ? { ...canonical, via: 'identity_canonical' } : { ...elsewhere, via: 'email_alias' };
}

/**
 * The `(counterparty_slug, source)` predicate readers confine a loop → entity
 * join with: a row written before v232 has no counterparty source and is read
 * as its own source, the posture it was written under.
 */
export const COUNTERPARTY_SOURCE_SQL = 'COALESCE(counterparty_source_id, source_id)';
