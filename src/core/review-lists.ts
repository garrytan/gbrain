/**
 * #2947 / #2942: the two review lists extraction_pending adds beside its quarantine stubs.
 *
 *   - unattributed: active facts saved with no entity (memory/unattributed), each with the non-destructive
 *     relink action. Never "forget then remember": a forget without an entity withdraws the claim for every entity.
 *   - possible_duplicates (opt-in): entity pages created recently whose name is one edit or one acronym letter away
 *     from another entity's name or alias. Flag only: linking stays manual (entity_identity_link), and an alias
 *     edit or a later "distinct" decision silences a pair.
 *
 * Both lists are read-only and source-scoped, and both hide what a remote caller cannot read.
 */

import type { BrainEngine } from './engine.ts';
import type { OperationContext } from './ops/contract.ts';
import { buildNearNameIndex, loadEntityNames, normalizeEntityName, queryNearNames, shardCountFor, type NearNameKind } from './entities/near-name.ts';

export interface ReviewAction { kind: string; run_by: 'caller' | 'owner'; argv: string[]; mcp?: { tool: string; arguments: Record<string, unknown> }; inputs?: Array<{ name: string; how: string }>; why: string }

export interface UnattributedRow { fact_id: string; fact: string; kind: string; visibility: string; source_id: string; created_at: string; actions: ReviewAction[] }

export const UNATTRIBUTED_DEFAULT_LIMIT = 50;
export const REVIEW_LIST_MAX_LIMIT = 500;

export async function listUnattributedFacts(engine: BrainEngine, ctx: OperationContext, sourceIds: string[], opts: { limit: number; offset: number }):
  Promise<{ count: number; rows: UnattributedRow[]; next_offset: number | null; complete: boolean }> {
  const worldOnly = ctx.remote !== false;
  const rows = await engine.executeRaw<{ id: number | string; fact: string; kind: string | null; visibility: string; source_id: string; created_at: string }>(
    `SELECT id, fact, kind, visibility, source_id, created_at::text AS created_at FROM facts
      WHERE source_id = ANY($1::text[]) AND entity_slug IS NULL AND expired_at IS NULL
        AND (valid_until IS NULL OR valid_until > now())
        AND ($2::boolean = false OR visibility = 'world')
      ORDER BY id DESC LIMIT $3 OFFSET $4`,
    [sourceIds, worldOnly, opts.limit + 1, opts.offset],
  );
  const page = rows.slice(0, opts.limit).map((r): UnattributedRow => {
    const id = String(r.id);
    return {
      fact_id: id, fact: r.fact, kind: r.kind ?? 'fact', visibility: r.visibility, source_id: r.source_id, created_at: r.created_at,
      actions: [{
        kind: 'relink', run_by: 'caller',
        argv: ['gbrain', 'remember', r.fact, '--entity', '<entity-slug>', '--replaces', id, '--source', r.source_id],
        mcp: { tool: 'remember', arguments: { fact: r.fact, entity: '<entity-slug>', replaces: id, visibility: r.visibility } },
        inputs: [{ name: 'entity-slug', how: 'The slug of the person, company or project page the claim is about (search or whois finds it).' }],
        why: 'Saves the same claim on the entity it is about and replaces this unattributed copy. Do not forget it first: a forget without an entity blocks the claim for every entity.',
      }],
    };
  });
  return { count: page.length, rows: page, next_offset: rows.length > opts.limit ? opts.offset + opts.limit : null, complete: rows.length <= opts.limit };
}

export interface DuplicateRow { slug: string; name: string; source_id: string; created_at: string; near: Array<{ slug: string; name: string; kind: Exclude<NearNameKind, 'same'> }>; actions: ReviewAction[] }

export const POSSIBLE_DUPLICATES_DEFAULT_LIMIT = 50;
export const POSSIBLE_DUPLICATES_DEFAULT_DAYS = 30;

let buildQueue: Promise<unknown> = Promise.resolve();
/** One index build at a time per process, so concurrent calls never hold several shards in memory at once. */
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = buildQueue.then(fn, fn);
  buildQueue = run.catch(() => undefined);
  return run;
}

function parseCursor(raw: unknown): { shard: number; offset: number } {
  const m = typeof raw === 'string' ? /^s(\d+):(\d+)$/.exec(raw.trim()) : null;
  return m ? { shard: Number(m[1]), offset: Number(m[2]) } : { shard: 0, offset: 0 };
}

/**
 * One page of possible duplicates for one source. The cursor walks recent entity pages within a shard, then the
 * next shard; complete is true only after the last page of the last shard, so a sharded index never reports a
 * pair-free result it did not compare.
 */
export async function listPossibleDuplicates(engine: BrainEngine, ctx: OperationContext, sourceId: string,
  opts: { limit: number; cursor?: unknown; sinceDays: number; excludePrivate: boolean }):
  Promise<{ count: number; rows: DuplicateRow[]; next_cursor: string | null; complete: boolean; shards: number; reason?: string }> {
  return serialized(async () => {
    const loaded = await loadEntityNames(engine, sourceId, { excludePrivate: opts.excludePrivate });
    const shards = shardCountFor(loaded.names);
    const cursor = parseCursor(opts.cursor);
    const shard = Math.min(cursor.shard, shards - 1);
    const since = Date.now() - opts.sinceDays * 86_400_000;
    const created = new Map<string, string>();
    for (const n of loaded.names) if (n.created_at) created.set(n.slug, n.created_at);
    const recent = [...created.entries()].filter(([, at]) => Date.parse(at) >= since)
      .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]) || a[0].localeCompare(b[0]));
    const index = buildNearNameIndex(loaded.names, shard, shards);
    const window = recent.slice(cursor.offset, cursor.offset + opts.limit);
    const local = ctx.remote === false;
    const rows: DuplicateRow[] = [];
    for (const [slug, createdAt] of window) {
      const own = loaded.names.filter(n => n.slug === slug);
      const near = new Map<string, { slug: string; name: string; kind: Exclude<NearNameKind, 'same'> }>();
      for (const entry of own) {
        for (const m of queryNearNames(index, entry.name, slug)) {
          if (m.kind === 'same' || near.has(m.slug)) continue;
          if (loaded.distinctBySlug.get(slug)?.has(m.slug) || loaded.distinctBySlug.get(m.slug)?.has(slug)) continue;
          if (loaded.aliasesBySlug.get(m.slug)?.has(normalizeEntityName(entry.name)) || loaded.aliasesBySlug.get(slug)?.has(normalizeEntityName(m.name))) continue;
          near.set(m.slug, { slug: m.slug, name: m.name, kind: m.kind });
        }
      }
      if (!near.size) continue;
      const first = [...near.values()][0]!;
      rows.push({
        slug, name: own[0]!.name, source_id: sourceId, created_at: createdAt, near: [...near.values()],
        actions: [
          { kind: 'link_identity', run_by: local ? 'caller' : 'owner', argv: ['gbrain', 'entity-identity-link', '<entity-id>', slug, '--source-id', sourceId],
            inputs: [{ name: 'entity-id', how: 'Any stable identity handle; run it once for each of the two pages with the same handle.' }],
            why: `Records that ${slug} and ${first.slug} are the same entity (link both pages under one entity id). Linking is manual by design.` },
          { kind: 'add_alias', run_by: 'caller', argv: ['gbrain', 'get', first.slug],
            mcp: { tool: 'edit_page', arguments: { slug: first.slug, expected_revision: '<from get_page>', edits: [] } },
            why: `If "${own[0]!.name}" is another name for ${first.slug}, add it to that page's aliases frontmatter; the pair is then no longer flagged.` },
        ],
      });
    }
    const nextOffset = cursor.offset + opts.limit;
    const next = nextOffset < recent.length ? `s${shard}:${nextOffset}` : shard + 1 < shards ? `s${shard + 1}:0` : null;
    return { count: rows.length, rows, next_cursor: next, complete: next === null && !loaded.truncated, shards,
      ...(loaded.truncated ? { reason: 'entity_count_over_cap' } : {}) };
  });
}
