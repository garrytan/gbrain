/**
 * The mention pass: keeps entity pages' derived aliases and every page's
 * `link_source='mentions'` links current, incrementally, from `gbrain extract
 * --stale` and the managed stale path (sync's inline extraction stays
 * link-only).
 *
 * One pass, per source in scope:
 *   1. Policy. `auto_link=false` or `mentions.auto_link=false` removes plain
 *      mention links and derived alias rows once and records `disabled`;
 *      re-enabling makes every page due. A change of the linkable type set,
 *      cross-source policy or ignore list makes every page due once.
 *   2. Alias refresh: linkable entity pages whose derived aliases were
 *      refreshed at another content revision (or alias version) get their
 *      `declared` and `subject` rows rewritten; pages that stopped being
 *      entities lose them. Frontmatter rows are never touched. Managed
 *      brains write through the coordinated writer (`page_aliases` is guarded).
 *   3. Authoritative gazetteer: a pack or alias read that fails writes
 *      nothing and records `failed` with the error.
 *   4. Entry diff: the gazetteer's (source, name, target, case) entries are
 *      compared with the saved set under an advisory lock; on change the set
 *      is saved, the source generation bumps, and only pages the change can
 *      affect are marked due (pages linking to a removed or retargeted
 *      target, plus pages whose text matches an added name through the real
 *      tokenizer, prefiltered by a substring superset).
 *   5. Reconcile due pages (content revision, extractor version or an
 *      invalidation differs): per batch, publish only when the source
 *      generations and each page's content revision are unchanged since the
 *      scan read them (conditional publish), so an edit or a gazetteer change
 *      during the scan leaves the page due. Only plain mention rows are
 *      touched; `typed_ner` rows stay.
 *   6. Status row: state, pending pages, last pass, generation. `coverage`
 *      on entity cards and get_backlinks reads it.
 *
 * MENTION_EXTRACTOR_VERSION is separate from LINK_EXTRACTOR_VERSION_TS, so a
 * gazetteer change never reruns link or timeline extraction.
 */

import { createHash } from 'node:crypto';
import type { BrainEngine, LinkBatchInput } from '../engine.ts';
import { pipelined } from '../page-state/transactions.ts';
import { isCrossSourceLinksEnabled } from '../link-extraction.ts';
import {
  buildGazetteer, findMentionedEntities, gazetteerEntryKeys, tokenizeTitle,
  type Gazetteer, type GazetteerEntry, type GazetteerEntryKey,
} from '../by-mention.ts';
import { linkableTypesFor, loadSourcePack, parseNameList, readMentionPolicy, type MentionPolicy, type PackTypes } from './policy.ts';
import { deriveEntityAliases, type DerivedAlias } from './aliases.ts';
import { normalizeAliasList } from '../search/alias-normalize.ts';
import { withCoordinatedWrite } from '../persistence/context.ts';
import { maintenanceAttribution } from '../persistence/attribution.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';

/** Bump to rescan every page's mentions once (gazetteer or scanner behavior change). */
export const MENTION_EXTRACTOR_VERSION = 2;
/** Bump to re-derive every entity page's declared aliases and title subject once. */
export const ALIAS_DERIVATION_VERSION = 1;

const RECONCILE_BATCH = 200;
const ALIAS_BATCH = 200;
const PREFILTER_BATCH = 500;

export type MentionState = 'complete' | 'pending' | 'disabled' | 'failed';

export interface MentionPassResult {
  /** Pages whose mention links were reconciled and published. */
  pages: number;
  created: number;
  removed: number;
  /** Pages left due because they (or the gazetteer) changed during the scan. */
  skipped: number;
  /** Entity pages whose derived alias rows changed. */
  aliasPages: number;
  /** Mention-due pages after the pass. */
  remaining: number;
  state: MentionState;
  error?: string;
}

export interface MentionPassOpts {
  sourceId?: string;
  /** Epoch ms; the pass stops between batches after it. Absent = run to completion. */
  deadline?: number;
  signal?: AbortSignal;
  /** Test seam: runs after a batch is scanned and before it is published. */
  beforePublish?: (pageIds: number[]) => Promise<void>;
}

const DUE_PREDICATE = `(s.page_id IS NULL OR s.mention_revision IS DISTINCT FROM p.knowledge_revision OR s.mention_version IS DISTINCT FROM $2)`;

/** Mention-due live pages, per source (or one source). */
export async function countMentionDuePages(engine: Pick<BrainEngine, 'executeRaw'>, sourceId?: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM pages p LEFT JOIN page_mention_state s ON s.page_id = p.id
      WHERE p.deleted_at IS NULL AND ($1::text IS NULL OR p.source_id = $1) AND ${DUE_PREDICATE}`,
    [sourceId ?? null, MENTION_EXTRACTOR_VERSION]);
  return Number(rows[0]?.n ?? 0);
}

async function sourcesInScope(engine: BrainEngine, sourceId?: string): Promise<string[]> {
  if (sourceId) return [sourceId];
  const rows = await engine.executeRaw<{ id: string }>('SELECT id FROM sources ORDER BY id');
  return rows.map(r => r.id);
}

function policyFingerprint(types: string[], crossSource: boolean, policy: MentionPolicy): string {
  return createHash('sha256').update(JSON.stringify({
    types, crossSource, ignore: [...policy.ignore].map(n => n.toLowerCase()).sort(),
  })).digest('hex').slice(0, 16);
}

async function writeStatus(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, patch: {
  state: MentionState; pending?: number; error?: string | null; lastPassAt?: string | null; bumpGeneration?: boolean; fingerprint?: string | null;
}): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO mention_index_status (source_id, generation, state, pending, counted_at, last_pass_at, policy_fingerprint, error, updated_at)
     VALUES ($1, CASE WHEN $6::boolean THEN 1 ELSE 0 END, $2, COALESCE($3::int, 0), now(), $4::timestamptz, $7, $5, now())
     ON CONFLICT (source_id) DO UPDATE SET
       state = EXCLUDED.state,
       pending = COALESCE($3::int, mention_index_status.pending),
       counted_at = CASE WHEN $3::int IS NULL THEN mention_index_status.counted_at ELSE now() END,
       last_pass_at = COALESCE($4::timestamptz, mention_index_status.last_pass_at),
       error = $5,
       generation = mention_index_status.generation + CASE WHEN $6::boolean THEN 1 ELSE 0 END,
       policy_fingerprint = CASE WHEN $8::boolean THEN $7 ELSE mention_index_status.policy_fingerprint END,
       updated_at = now()`,
    [sourceId, patch.state, patch.pending ?? null, patch.lastPassAt ?? null, patch.error ?? null, patch.bumpGeneration === true,
      patch.fingerprint ?? null, patch.fingerprint !== undefined]);
}

/** Run `fn` in a transaction; on a managed brain, as a coordinated write for `sourceId` (page_aliases is guarded). */
async function aliasWrite<T>(engine: BrainEngine, managed: boolean, sourceId: string, fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
  if (!managed) return engine.transaction(fn);
  const attribution = await maintenanceAttribution(engine);
  return engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => fn(tx), attribution));
}

/**
 * Replace one page's derived alias rows (declared, subject) with what its
 * current title and body yield, inside the caller's transaction (import and
 * `reindex --aliases`; on a managed brain the caller holds the coordinated
 * write). A page that is not a linkable entity, or linking that is off,
 * leaves no derived rows. Frontmatter rows are untouched.
 */
export async function writeDerivedAliases(tx: Pick<BrainEngine, 'executeRaw' | 'getConfig'>, sourceId: string,
  page: { slug: string; title: string | null; type: string | null; compiled_truth: string | null; timeline?: string | null },
  opts: { pack?: PackTypes | null; policy?: MentionPolicy | null } = {}): Promise<number> {
  // A config read that fails (null policy) leaves the rows for the next sweep rather than failing the caller's write.
  const policy = opts.policy !== undefined ? opts.policy : await readMentionPolicy(tx).catch(() => null);
  if (!policy) return 0;
  const types = policy.enabled ? linkableTypesFor(opts.pack !== undefined ? opts.pack : await loadSourcePack(tx, sourceId), policy) : [];
  const aliases = types.includes(page.type ?? '') ? deriveEntityAliases(page).aliases : [];
  await tx.executeRaw(`DELETE FROM page_aliases WHERE source_id = $1 AND slug = $2 AND origin IN ('declared','subject')`, [sourceId, page.slug]);
  if (aliases.length) {
    await tx.executeRaw(
      `INSERT INTO page_aliases (source_id, alias_norm, slug, origin, case_sensitive, alias_text)
       SELECT $1, a, $2, o, c::boolean, t FROM unnest($3::text[], $4::text[], $5::text[], $6::text[]) AS x(a, o, c, t) ON CONFLICT DO NOTHING`,
      [sourceId, page.slug, aliases.map(a => a.alias_norm), aliases.map(a => a.origin), aliases.map(a => String(a.case_sensitive)), aliases.map(a => a.alias_text)]);
  }
  return aliases.length;
}

/**
 * Import's alias projection: the page's frontmatter aliases and, for a
 * linkable entity page, its derived aliases. Import never loads a schema
 * pack itself: it uses the pack the caller already resolved (none: the four
 * always-linkable types), and the next sweep refreshes with the source's pack.
 * The caller reads the mention policy before its transaction opens.
 */
export async function writePageAliases(tx: BrainEngine, slug: string, sourceId: string,
  page: { title: string; type: string; compiled_truth: string; timeline: string; frontmatter: Record<string, unknown> }, pack: unknown,
  policy: MentionPolicy | null): Promise<void> {
  // #5984: the frontmatter and derived rows are independent; their statements are pipelined, in the caller's transaction.
  await pipelined(tx, [
    () => tx.setPageAliases(slug, sourceId, normalizeAliasList(page.frontmatter.aliases), { inline: true }),
    () => writeDerivedAliases(tx, sourceId, { slug, ...page }, { pack: (pack as PackTypes | undefined) ?? null, policy }),
  ]);
}

/** Turn the index off for one source: plain mention links, derived aliases, entries and page state go; typed_ner rows stay. */
async function disableSource(engine: BrainEngine, managed: boolean, sourceId: string): Promise<number> {
  let removed = 0;
  await aliasWrite(engine, managed, sourceId, async tx => {
    const rows = await tx.executeRaw<{ id: number }>(
      `DELETE FROM links l USING pages f
        WHERE f.id = l.from_page_id AND f.source_id = $1 AND l.link_source = 'mentions'
          AND (l.link_kind IS NULL OR l.link_kind = 'plain') RETURNING l.id`, [sourceId]);
    removed = rows.length;
    await tx.executeRaw(`DELETE FROM page_aliases WHERE source_id = $1 AND origin IN ('declared','subject')`, [sourceId]);
    await tx.executeRaw('DELETE FROM mention_gazetteer_entries WHERE source_id = $1', [sourceId]);
    await tx.executeRaw('DELETE FROM page_mention_state WHERE source_id = $1', [sourceId]);
    await writeStatus(tx, sourceId, { state: 'disabled', pending: 0, error: null, bumpGeneration: true, fingerprint: null });
  });
  return removed;
}

interface DuePage { id: number; slug: string; source_id: string; revision: string; title: string | null; type: string | null;
  compiled_truth: string | null; timeline: string | null; mention_ignore: unknown }

/** Refresh derived alias rows of due entity pages in one source; returns pages whose rows changed. */
async function refreshAliases(engine: BrainEngine, managed: boolean, sourceId: string, types: string[], deadline: number): Promise<number> {
  let changed = 0;
  // Pages that stopped being linkable entities (retype, pack change, deletion) lose their derived rows.
  const stale = await engine.executeRaw<{ slug: string }>(
    `SELECT DISTINCT pa.slug FROM page_aliases pa
       LEFT JOIN pages p ON p.slug = pa.slug AND p.source_id = pa.source_id
      WHERE pa.source_id = $1 AND pa.origin IN ('declared','subject')
        AND (p.id IS NULL OR p.deleted_at IS NOT NULL OR NOT (p.type = ANY($2::text[])))`, [sourceId, types]);
  if (stale.length) {
    await aliasWrite(engine, managed, sourceId, tx => tx.executeRaw(
      `DELETE FROM page_aliases WHERE source_id = $1 AND slug = ANY($2::text[]) AND origin IN ('declared','subject')`,
      [sourceId, stale.map(r => r.slug)]));
    changed += stale.length;
  }
  let after = 0;
  for (;;) {
    if (Date.now() > deadline) break;
    const pages = await engine.executeRaw<DuePage>(
      `SELECT p.id, p.slug, p.source_id, p.knowledge_revision::text AS revision, p.title, p.type, p.compiled_truth, p.timeline, NULL AS mention_ignore
         FROM pages p LEFT JOIN page_mention_state s ON s.page_id = p.id
        WHERE p.source_id = $1 AND p.deleted_at IS NULL AND p.type = ANY($2::text[]) AND p.id > $3
          AND (s.page_id IS NULL OR s.alias_revision IS DISTINCT FROM p.knowledge_revision OR s.alias_version IS DISTINCT FROM $4)
        ORDER BY p.id LIMIT $5`, [sourceId, types, after, ALIAS_DERIVATION_VERSION, ALIAS_BATCH]);
    if (!pages.length) break;
    after = pages[pages.length - 1]!.id;
    const desired = new Map(pages.map(p => [p.slug, deriveEntityAliases(p).aliases]));
    const existing = await engine.executeRaw<{ slug: string; alias_norm: string; origin: string; case_sensitive: boolean; alias_text: string | null }>(
      `SELECT slug, alias_norm, origin, case_sensitive, alias_text FROM page_aliases
        WHERE source_id = $1 AND slug = ANY($2::text[]) AND origin IN ('declared','subject')`, [sourceId, pages.map(p => p.slug)]);
    const key = (a: { alias_norm: string; origin: string; case_sensitive: boolean; alias_text: string | null }) =>
      `${a.alias_norm}\0${a.origin}\0${a.case_sensitive}\0${a.case_sensitive ? a.alias_text : ''}`;
    const have = new Map<string, Set<string>>();
    for (const row of existing) {
      const set = have.get(row.slug) ?? new Set<string>();
      set.add(key(row));
      have.set(row.slug, set);
    }
    const rewrite = pages.filter(p => {
      const want = new Set((desired.get(p.slug) ?? []).map(a => key({ ...a, alias_text: a.alias_text })));
      const got = have.get(p.slug) ?? new Set<string>();
      return want.size !== got.size || [...want].some(k => !got.has(k));
    });
    await aliasWrite(engine, managed, sourceId, async tx => {
      const current = new Map((await tx.executeRaw<{ id: number; revision: string }>(
        `SELECT id, knowledge_revision::text AS revision FROM pages WHERE id = ANY($1::int[]) AND deleted_at IS NULL`,
        [pages.map(p => p.id)])).map(r => [Number(r.id), r.revision]));
      const fresh = pages.filter(p => current.get(Number(p.id)) === p.revision);
      const freshRewrite = rewrite.filter(p => current.get(Number(p.id)) === p.revision);
      if (freshRewrite.length) {
        await tx.executeRaw(`DELETE FROM page_aliases WHERE source_id = $1 AND slug = ANY($2::text[]) AND origin IN ('declared','subject')`,
          [sourceId, freshRewrite.map(p => p.slug)]);
        const rows = freshRewrite.flatMap(p => (desired.get(p.slug) ?? []).map((a: DerivedAlias) => ({ slug: p.slug, ...a })));
        if (rows.length) {
          await tx.executeRaw(
            `INSERT INTO page_aliases (source_id, alias_norm, slug, origin, case_sensitive, alias_text)
             SELECT $1, a, s, o, c::boolean, t FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) AS x(a, s, o, c, t)
             ON CONFLICT DO NOTHING`,
            [sourceId, rows.map(r => r.alias_norm), rows.map(r => r.slug), rows.map(r => r.origin), rows.map(r => String(r.case_sensitive)), rows.map(r => r.alias_text)]);
        }
      }
      if (fresh.length) {
        await tx.executeRaw(
          `INSERT INTO page_mention_state (page_id, source_id, alias_revision, alias_version, aliases_refreshed_at)
           SELECT id, $1, rev::uuid, $4, now() FROM unnest($2::int[], $3::text[]) AS x(id, rev)
           ON CONFLICT (page_id) DO UPDATE SET alias_revision = EXCLUDED.alias_revision, alias_version = EXCLUDED.alias_version,
             aliases_refreshed_at = EXCLUDED.aliases_refreshed_at`,
          [sourceId, fresh.map(p => p.id), fresh.map(p => p.revision), ALIAS_DERIVATION_VERSION]);
      }
      changed += freshRewrite.length;
    });
  }
  return changed;
}

/** Live pages in `sourceIds` whose text the mini-gazetteer of `added` matches (real tokenizer, substring-superset prefilter). */
async function pagesMatchingNames(engine: BrainEngine, sourceIds: string[], added: Gazetteer, allowCrossSource: boolean): Promise<number[]> {
  const longest = [...added.values()].flat().map(e => [...e.tokens].sort((a, b) => b.length - a.length)[0]!);
  // ASCII tokens: lower() in SQL agrees with the scanner's NFC+toLowerCase, so LIKE is a superset.
  // Otherwise every page in scope is scanned in JS.
  const ascii = longest.every(t => /^[\x20-\x7e]+$/.test(t));
  const patterns = [...new Set(longest)].map(t => `%${t.replace(/[\\%_]/g, m => `\\${m}`)}%`);
  const out: number[] = [];
  let after = 0;
  for (;;) {
    const rows = await engine.executeRaw<{ id: number; slug: string; source_id: string; body: string; mention_ignore: unknown }>(
      `SELECT id, slug, source_id, COALESCE(title, '') || E'\\n\\n' || COALESCE(compiled_truth, '') || E'\\n\\n' || COALESCE(timeline, '') AS body,
              frontmatter->'mention_ignore' AS mention_ignore
         FROM pages WHERE deleted_at IS NULL AND source_id = ANY($1::text[]) AND id > $2
          ${ascii ? `AND lower(COALESCE(title, '') || ' ' || COALESCE(compiled_truth, '') || ' ' || COALESCE(timeline, '')) LIKE ANY($4::text[])` : ''}
        ORDER BY id LIMIT $3`,
      ascii ? [sourceIds, after, PREFILTER_BATCH, patterns] : [sourceIds, after, PREFILTER_BATCH]);
    if (!rows.length) break;
    after = rows[rows.length - 1]!.id;
    for (const r of rows) {
      const hits = findMentionedEntities(r.body, added, { fromSlug: r.slug, fromSourceId: r.source_id, allowCrossSource });
      if (hits.length) out.push(Number(r.id));
    }
  }
  return out;
}

function miniGazetteer(gazetteer: Gazetteer, keys: Set<string>): Gazetteer {
  const out: Gazetteer = new Map();
  for (const [first, bucket] of gazetteer) {
    const kept = bucket.filter(e => keys.has(entryKey(e)));
    if (kept.length) out.set(first, kept);
  }
  return out;
}

function entryKey(e: GazetteerEntry | GazetteerEntryKey): string {
  if ('target_slug' in e) return `${e.source_id}\0${e.name_norm}\0${e.target_slug}\0${e.case_sensitive}`;
  return `${e.source_id}\0${(e.caseTokens ?? e.tokens).join(' ')}\0${e.slug}\0${!!e.caseTokens}`;
}

/**
 * Diff the saved entry set of one source against `gazetteer`; on change, save
 * it, bump the generation and mark affected pages due, in one transaction under
 * the source's advisory lock. Returns whether the set changed.
 */
async function saveEntries(engine: BrainEngine, sourceId: string, gazetteer: Gazetteer, scopeSources: string[], allowCrossSource: boolean): Promise<boolean> {
  const current = gazetteerEntryKeys(gazetteer).filter(k => k.source_id === sourceId);
  const read = async (db: Pick<BrainEngine, 'executeRaw'>) => (await db.executeRaw<GazetteerEntryKey>(
    'SELECT source_id, name_norm, target_slug, case_sensitive FROM mention_gazetteer_entries WHERE source_id = $1', [sourceId]));
  const before = await read(engine);
  const beforeKeys = new Set(before.map(entryKey));
  const currentKeys = new Set(current.map(entryKey));
  const added = current.filter(k => !beforeKeys.has(entryKey(k)));
  const removed = before.filter(k => !currentKeys.has(entryKey(k)));
  if (!added.length && !removed.length) return false;
  // The first save for a source marks the whole candidate scope due (cheap); later saves only affected pages.
  const firstSave = before.length === 0;
  let candidates: number[] = [];
  if (!firstSave) {
    const linked = removed.length ? await engine.executeRaw<{ id: number }>(
      `SELECT DISTINCT l.from_page_id AS id FROM links l JOIN pages t ON t.id = l.to_page_id
        WHERE t.source_id = $1 AND t.slug = ANY($2::text[]) AND l.link_source = 'mentions'`,
      [sourceId, [...new Set(removed.map(k => k.target_slug))]]) : [];
    const matched = added.length ? await pagesMatchingNames(engine, scopeSources,
      miniGazetteer(gazetteer, new Set(added.map(entryKey))), allowCrossSource) : [];
    candidates = [...new Set([...linked.map(r => Number(r.id)), ...matched])];
  }
  return engine.transaction(async tx => {
    await tx.executeRaw('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`gbrain:mention-entries:${sourceId}`]);
    const locked = await read(tx);
    // Another sweep saved first: its pages and generation are authoritative; this pass's scan fails its conditional publish.
    if (locked.length !== before.length || locked.some(k => !beforeKeys.has(entryKey(k)))) return true;
    if (removed.length) {
      await tx.executeRaw(
        `DELETE FROM mention_gazetteer_entries e USING unnest($2::text[], $3::text[], $4::text[]) AS x(n, t, c)
          WHERE e.source_id = $1 AND e.name_norm = x.n AND e.target_slug = x.t AND e.case_sensitive = x.c::boolean`,
        [sourceId, removed.map(k => k.name_norm), removed.map(k => k.target_slug), removed.map(k => String(k.case_sensitive))]);
    }
    if (added.length) {
      await tx.executeRaw(
        `INSERT INTO mention_gazetteer_entries (source_id, name_norm, target_slug, case_sensitive)
         SELECT $1, n, t, c::boolean FROM unnest($2::text[], $3::text[], $4::text[]) AS x(n, t, c) ON CONFLICT DO NOTHING`,
        [sourceId, added.map(k => k.name_norm), added.map(k => k.target_slug), added.map(k => String(k.case_sensitive))]);
    }
    if (firstSave) {
      await tx.executeRaw('UPDATE page_mention_state SET mention_revision = NULL WHERE source_id = ANY($1::text[])', [scopeSources]);
    } else if (candidates.length) {
      await tx.executeRaw('UPDATE page_mention_state SET mention_revision = NULL WHERE page_id = ANY($1::int[])', [candidates]);
    }
    await writeStatus(tx, sourceId, { state: 'pending', bumpGeneration: true });
    return true;
  });
}

async function readGenerations(engine: Pick<BrainEngine, 'executeRaw'>, sourceIds: string[], lock: boolean): Promise<Map<string, string>> {
  const rows = await engine.executeRaw<{ source_id: string; generation: string }>(
    `SELECT source_id, generation::text AS generation FROM mention_index_status WHERE source_id = ANY($1::text[])${lock ? ' FOR SHARE' : ''}`,
    [sourceIds]);
  return new Map(rows.map(r => [r.source_id, r.generation]));
}

function sameGenerations(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/** Reconcile due pages of one source; returns counts and whether a gazetteer change stopped it. */
async function reconcileSource(engine: BrainEngine, sourceId: string, gazetteer: Gazetteer, genSources: string[], allowCrossSource: boolean,
  opts: MentionPassOpts, deadline: number, result: MentionPassResult): Promise<void> {
  const generations = await readGenerations(engine, genSources, false);
  let after = 0;
  for (;;) {
    opts.signal?.throwIfAborted();
    if (Date.now() > deadline) return;
    const pages = await engine.executeRaw<DuePage>(
      `SELECT p.id, p.slug, p.source_id, p.knowledge_revision::text AS revision, p.title, p.type, p.compiled_truth, p.timeline,
              p.frontmatter->'mention_ignore' AS mention_ignore
         FROM pages p LEFT JOIN page_mention_state s ON s.page_id = p.id
        WHERE p.source_id = $1 AND p.deleted_at IS NULL AND p.id > $3 AND ${DUE_PREDICATE}
        ORDER BY p.id LIMIT $4`, [sourceId, MENTION_EXTRACTOR_VERSION, after, RECONCILE_BATCH]);
    if (!pages.length) return;
    after = pages[pages.length - 1]!.id;
    const found = new Map(pages.map(p => [Number(p.id), (p.title || p.compiled_truth || p.timeline)
      ? findMentionedEntities(`${p.title ?? ''}\n\n${p.compiled_truth ?? ''}\n\n${p.timeline ?? ''}`, gazetteer, {
          fromSlug: p.slug, fromSourceId: p.source_id, allowCrossSource, ignoreNames: parseNameList(p.mention_ignore),
        })
      : []]));
    await opts.beforePublish?.(pages.map(p => Number(p.id)));
    const outcome = await engine.transaction(async tx => {
      if (!sameGenerations(generations, await readGenerations(tx, genSources, true))) return null;
      const current = new Map((await tx.executeRaw<{ id: number; revision: string }>(
        `SELECT id, knowledge_revision::text AS revision FROM pages WHERE id = ANY($1::int[]) AND deleted_at IS NULL FOR SHARE`,
        [pages.map(p => p.id)])).map(r => [Number(r.id), r.revision]));
      const fresh = pages.filter(p => current.get(Number(p.id)) === p.revision);
      if (!fresh.length) return { fresh: 0, created: 0, removed: 0 };
      const rows = await tx.executeRaw<{ id: number; from_page_id: number; to_slug: string; to_source_id: string; plain: boolean }>(
        `SELECT l.id, l.from_page_id, t.slug AS to_slug, t.source_id AS to_source_id,
                (l.link_source = 'mentions' AND (l.link_kind IS NULL OR l.link_kind = 'plain')) AS plain
           FROM links l JOIN pages t ON t.id = l.to_page_id WHERE l.from_page_id = ANY($1::int[])`,
        [fresh.map(p => p.id)]);
      const existing = rows.filter(r => r.plain);
      // One link per page pair: a pair another producer already links (markdown, frontmatter, typed_ner, manual) gets no plain mention.
      // A cross-source mention is also covered by an explicit link to the same slug in any source (the resolver may pick another twin).
      const covered = new Set(rows.filter(r => !r.plain).flatMap(r => [`${r.from_page_id}\0${r.to_source_id}\0${r.to_slug}`, `${r.from_page_id}\0*\0${r.to_slug}`]));
      const pageSource = new Map(fresh.map(p => [Number(p.id), p.source_id]));
      const want = new Set(fresh.flatMap(p => (found.get(Number(p.id)) ?? [])
        .filter(m => !covered.has(`${p.id}\0${m.source_id}\0${m.slug}`) && !(m.source_id !== pageSource.get(Number(p.id)) && covered.has(`${p.id}\0*\0${m.slug}`)))
        .map(m => `${p.id}\0${m.source_id}\0${m.slug}`)));
      const have = new Set(existing.map(r => `${r.from_page_id}\0${r.to_source_id}\0${r.to_slug}`));
      const drop = existing.filter(r => !want.has(`${r.from_page_id}\0${r.to_source_id}\0${r.to_slug}`)).map(r => Number(r.id));
      if (drop.length) await tx.executeRaw('DELETE FROM links WHERE id = ANY($1::int[])', [drop]);
      const add: LinkBatchInput[] = fresh.flatMap(p => (found.get(Number(p.id)) ?? [])
        .filter(m => want.has(`${p.id}\0${m.source_id}\0${m.slug}`) && !have.has(`${p.id}\0${m.source_id}\0${m.slug}`))
        .map(m => ({ from_slug: p.slug, to_slug: m.slug, link_type: 'mentions', link_source: 'mentions', context: m.name,
          from_source_id: p.source_id, to_source_id: m.source_id })));
      const created = add.length ? await tx.addLinksBatch(add, { auditSite: 'extract.mentions' }) : 0; // gbrain-allow-direct-insert: mention pass — reconciling write of the scan's own plain mention rows
      await tx.executeRaw(
        `INSERT INTO page_mention_state (page_id, source_id, mention_revision, mention_version, mention_generation, mentions_scanned_at)
         SELECT id, $1, rev::uuid, $4, $5::bigint, now() FROM unnest($2::int[], $3::text[]) AS x(id, rev)
         ON CONFLICT (page_id) DO UPDATE SET mention_revision = EXCLUDED.mention_revision, mention_version = EXCLUDED.mention_version,
           mention_generation = EXCLUDED.mention_generation, mentions_scanned_at = EXCLUDED.mentions_scanned_at`,
        [sourceId, fresh.map(p => p.id), fresh.map(p => p.revision), MENTION_EXTRACTOR_VERSION, generations.get(sourceId) ?? '0']);
      return { fresh: fresh.length, created, removed: drop.length };
    });
    if (!outcome) { result.skipped += pages.length; return; }
    result.pages += outcome.fresh;
    result.skipped += pages.length - outcome.fresh;
    result.created += outcome.created;
    result.removed += outcome.removed;
  }
}

/**
 * Run the mention pass for one source or every source. Never throws for a
 * pack, alias or entry-table failure: it writes nothing and returns
 * `state: 'failed'` with the error (recorded on the status rows).
 */
export async function runMentionPass(engine: BrainEngine, opts: MentionPassOpts = {}): Promise<MentionPassResult> {
  const result: MentionPassResult = { pages: 0, created: 0, removed: 0, skipped: 0, aliasPages: 0, remaining: 0, state: 'complete' };
  const deadline = opts.deadline ?? Infinity;
  const passStart = new Date().toISOString();
  const policy = await readMentionPolicy(engine);
  const sources = await sourcesInScope(engine, opts.sourceId);
  const managed = await managedPersistenceEnabled(engine).catch(() => false);
  if (!policy.enabled) {
    const status = new Map((await engine.executeRaw<{ source_id: string; state: string }>(
      'SELECT source_id, state FROM mention_index_status WHERE source_id = ANY($1::text[])', [sources])).map(r => [r.source_id, r.state]));
    for (const sourceId of sources) {
      if (status.get(sourceId) === 'disabled') continue;
      result.removed += await disableSource(engine, managed, sourceId);
    }
    result.state = 'disabled';
    return result;
  }
  const allowCrossSource = await isCrossSourceLinksEnabled(engine);
  const types = new Map<string, string[]>();
  let gazetteer: Gazetteer;
  try {
    for (const sourceId of sources) types.set(sourceId, linkableTypesFor(await loadSourcePack(engine, sourceId, { strict: true }), policy));
    gazetteer = await buildGazetteer(engine, { policy, strict: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const sourceId of sources) await writeStatus(engine, sourceId, { state: 'failed', error: message });
    return { ...result, state: 'failed', error: message, remaining: await countMentionDuePages(engine, opts.sourceId) };
  }
  const allSources = allowCrossSource ? (await sourcesInScope(engine)) : [];
  const fingerprints = new Map<string, string>(sources.map(s => [s, policyFingerprint(types.get(s)!, allowCrossSource, policy)]));
  const stored = new Map((await engine.executeRaw<{ source_id: string; policy_fingerprint: string | null }>(
    'SELECT source_id, policy_fingerprint FROM mention_index_status WHERE source_id = ANY($1::text[])', [sources]))
    .map(r => [r.source_id, r.policy_fingerprint]));
  for (const sourceId of sources) {
    if (stored.get(sourceId) === fingerprints.get(sourceId)) continue;
    await engine.transaction(async tx => {
      await tx.executeRaw('UPDATE page_mention_state SET mention_revision = NULL, alias_revision = NULL WHERE source_id = $1', [sourceId]);
      await writeStatus(tx, sourceId, { state: 'pending', bumpGeneration: true, fingerprint: fingerprints.get(sourceId)! });
    });
  }
  for (const sourceId of sources) {
    if (Date.now() > deadline) break;
    result.aliasPages += await refreshAliases(engine, managed, sourceId, types.get(sourceId)!, deadline);
  }
  // Aliases may have changed: the gazetteer the reconcile uses is built after the refresh.
  if (result.aliasPages > 0) {
    try { gazetteer = await buildGazetteer(engine, { policy, strict: true }); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const sourceId of sources) await writeStatus(engine, sourceId, { state: 'failed', error: message });
      return { ...result, state: 'failed', error: message, remaining: await countMentionDuePages(engine, opts.sourceId) };
    }
  }
  for (const sourceId of sources) {
    await saveEntries(engine, sourceId, gazetteer, allowCrossSource ? allSources : [sourceId], allowCrossSource);
  }
  for (const sourceId of sources) {
    await reconcileSource(engine, sourceId, gazetteer, allowCrossSource ? allSources : [sourceId], allowCrossSource, opts, deadline, result);
    const pending = await countMentionDuePages(engine, sourceId);
    result.remaining += pending;
    await writeStatus(engine, sourceId, { state: pending > 0 ? 'pending' : 'complete', pending, error: null, lastPassAt: passStart });
  }
  result.state = result.remaining > 0 ? 'pending' : 'complete';
  return result;
}

/** The gazetteer's entries targeting one page, with their origins (for explain). */
export function entriesFor(gazetteer: Gazetteer, sourceId: string, slug: string): GazetteerEntry[] {
  return [...gazetteer.values()].flat().filter(e => e.source_id === sourceId && e.slug === slug);
}

/** Normalized token key of a name, as the scanner compares it. */
export function nameKey(name: string): string {
  return tokenizeTitle(name).join(' ');
}
