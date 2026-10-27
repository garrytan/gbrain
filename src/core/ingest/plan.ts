/**
 * GBRA-215 L3: plan an ingest with no writes. Each extracted name resolves by exact and alias identity (an existing
 * page, normalized-equal names included), else near-name against existing names and the batch's siblings (flagged,
 * never merged), else a new page filed by its schema-pack type. Each claim is checked read-only against saved facts
 * (withdrawn, duplicate) with the facts pipeline's own check, so a duplicate becomes support for an existing claim.
 */
import { createHash } from 'node:crypto';
import type { OperationContext } from '../ops/contract.ts';
import { enforceClientSlugFence, enforceSubagentSlugFence, validatePageSlug } from '../ops/context.ts';
import { resolveStrictEntityReference } from '../entities/resolve.ts';
import {
  buildNearNameIndex, classifyNearName, loadEntityNames, queryNearNames, shardCountFor, type NearNameMatch,
} from '../entities/near-name.ts';
import { resolveExcludePrivatePages, privatePagesFilterFragment } from '../search/private-visibility.ts';
import { canonicalTypeOf, loadSourcePack } from '../mentions/policy.ts';
import { checkFactAgainstSaved } from '../facts/backstop.ts';
import { INGEST_ENTITY_CAP, isJunkName, type ExtractedEntity, type ExtractedFact } from './extract.ts';

export type PagePlanStatus = 'existing' | 'create' | 'propose' | 'skipped';
export interface PlannedPage {
  name: string;
  type: string;
  slug: string;
  status: PagePlanStatus;
  reason?: string;
  source: 'model' | 'regex';
  context: string;
  first_mention: number;
  near_names?: Array<{ slug: string; name: string; kind: string }>;
  near_name_incomplete?: true;
}
export type CopyPlanStatus = 'planned' | 'support' | 'skipped';
export interface PlannedCopy { entity_slug: string; status: CopyPlanStatus; reason?: string; fact_id?: number }
export interface PlannedFact {
  fact: string;
  kind: ExtractedFact['kind'];
  notability: ExtractedFact['notability'];
  valid_from: string | null;
  status: 'planned' | 'skipped';
  reason?: string;
  copies: PlannedCopy[];
}
export interface IngestPlan { pages: PlannedPage[]; facts: PlannedFact[]; near_name_complete: boolean }

const FALLBACK_DIRS: Record<string, string> = { person: 'people/', company: 'companies/' };
const ORG_TYPES = new Set(['company', 'organization', 'org', 'startup', 'fund', 'firm']);

export function slugifyName(name: string): string {
  return name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

/** The pack's canonical type and its first validated path prefix; people/ and companies/ when the pack has none. */
export async function directoryForType(ctx: OperationContext, sourceId: string, type: string, cache: Map<string, { type: string; dir: string }>): Promise<{ type: string; dir: string }> {
  const hit = cache.get(type);
  if (hit) return hit;
  const pack = await loadSourcePack(ctx.engine, sourceId);
  const canonical = canonicalTypeOf(type, pack);
  const declared = pack?.page_types?.find(pt => pt.name === canonical);
  const prefixes = (declared as { path_prefixes?: readonly string[] } | undefined)?.path_prefixes ?? [];
  const prefix = declared?.primitive === 'entity' ? prefixes.find(p => /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*\/$/.test(p)) : undefined;
  const fallbackType = canonical === 'person' ? 'person' : 'company';
  const out = prefix ? { type: canonical, dir: prefix } : { type: fallbackType, dir: FALLBACK_DIRS[fallbackType]! };
  cache.set(type, out);
  return out;
}

/** The first case-insensitive occurrence of a name in the document (Infinity when absent). */
export function firstMention(text: string, name: string): number {
  const at = text.toLowerCase().indexOf(name.toLowerCase());
  return at === -1 ? Number.POSITIVE_INFINITY : at;
}

interface SlugState { exists: boolean; readable: boolean }
async function slugState(ctx: OperationContext, sourceId: string, slug: string, excludePrivate: boolean): Promise<SlugState> {
  const rows = await ctx.engine.executeRaw<{ readable: boolean }>(
    'SELECT ' + (excludePrivate ? privatePagesFilterFragment('p') : 'true') + ' AS readable FROM pages p WHERE p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL',
    [sourceId, slug]);
  return { exists: rows.length > 0, readable: rows.length > 0 && rows[0]!.readable === true };
}

function insideGrant(ctx: OperationContext, slug: string): boolean {
  try { enforceClientSlugFence(ctx, slug, 'ingest'); enforceSubagentSlugFence(ctx, slug, 'ingest'); return true; } catch { return false; }
}

export interface PlanInput {
  ctx: OperationContext;
  sourceId: string;
  text: string;
  entities: ExtractedEntity[];
  facts: ExtractedFact[];
  visibility: 'world' | 'private';
  validFrom: string | null;
  trusted: boolean;
  factsSkipped: string | null;
}

export async function planIngest(input: PlanInput): Promise<IngestPlan> {
  const { ctx, sourceId } = input;
  const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);
  const known = await loadEntityNames(ctx.engine, sourceId, { excludePrivate });
  const shards = shardCountFor(known.names);
  const indexes = Array.from({ length: shards }, (_, i) => buildNearNameIndex(known.names, i, shards));
  const dirs = new Map<string, { type: string; dir: string }>();
  const pages: PlannedPage[] = [];
  const byName = new Map<string, PlannedPage>();
  const ordered = [...input.entities].map(e => ({ e, at: firstMention(input.text, e.name) })).sort((a, b) => a.at - b.at);
  let created = 0;
  for (const { e, at } of ordered) {
    const key = e.name.toLowerCase();
    if (byName.has(key)) continue;
    const base = { name: e.name, source: e.source, context: e.context, first_mention: Number.isFinite(at) ? at : -1 };
    const sibling = pages.find(p => p.status !== 'skipped' && classifyNearName(p.name, e.name) === 'same');
    if (sibling) { byName.set(key, sibling); continue; }
    const skip = (reason: string) => { const page: PlannedPage = { ...base, type: e.type, slug: '', status: 'skipped', reason }; pages.push(page); byName.set(key, page); };
    if (isJunkName(e.name)) { skip('junk_name'); continue; }
    const { type, dir } = await directoryForType(ctx, sourceId, e.type, dirs);
    if (type === 'person' && !/\s/.test(e.name.trim())) { skip('bare_first_name'); continue; }
    const strict = await resolveStrictEntityReference(ctx.engine, sourceId, e.name, { sameName: true, excludePrivate });
    const near: NearNameMatch[] = indexes.flatMap(index => queryNearNames(index, e.name));
    const same = near.find(m => m.kind === 'same');
    const existingSlug = strict.slug ?? same?.slug ?? null;
    if (existingSlug) {
      const page: PlannedPage = insideGrant(ctx, existingSlug)
        ? { ...base, type, slug: existingSlug, status: 'existing' }
        : { ...base, type, slug: existingSlug, status: 'skipped', reason: 'outside_grant' };
      pages.push(page); byName.set(key, page);
      continue;
    }
    if (created >= INGEST_ENTITY_CAP) { skip('entity_cap'); continue; }
    const natural = dir + slugifyName(e.name);
    let slug = natural;
    let hidden = false;
    const state = await slugState(ctx, sourceId, natural, excludePrivate);
    if (state.exists) {
      hidden = !state.readable;
      slug = natural + '-' + createHash('sha256').update(sourceId + '\0' + e.name).digest('hex').slice(0, 6);
    }
    try { validatePageSlug(slug); } catch { skip('invalid_slug'); continue; }
    if (!insideGrant(ctx, slug)) { const page: PlannedPage = { ...base, type, slug, status: 'skipped', reason: 'outside_grant' }; pages.push(page); byName.set(key, page); continue; }
    const flags = near.filter(m => m.kind !== 'same').map(m => ({ slug: m.slug, name: m.name, kind: m.kind }));
    const page: PlannedPage = { ...base, type, slug, status: 'propose',
      ...(flags.length ? { near_names: dedupFlags(flags) } : {}), ...(known.truncated ? { near_name_incomplete: true as const } : {}) };
    if (input.trusted && ctx.remote === false && e.source === 'model' && !flags.length && !known.truncated && !hidden) page.status = 'create';
    pages.push(page); byName.set(key, page);
    created++;
  }
  // The batch's own siblings: two new names a slip apart are flagged against each other, so neither becomes real silently.
  const fresh = pages.filter(p => p.status === 'create' || p.status === 'propose');
  for (let i = 0; i < fresh.length; i++) for (let j = i + 1; j < fresh.length; j++) {
    const kind = classifyNearName(fresh[i]!.name, fresh[j]!.name);
    if (kind !== 'typo' && kind !== 'acronym') continue;
    for (const [a, b] of [[fresh[i]!, fresh[j]!], [fresh[j]!, fresh[i]!]] as const) {
      a.near_names = dedupFlags([...(a.near_names ?? []), { slug: b.slug, name: b.name, kind }]);
      a.status = 'propose';
    }
  }
  const facts: PlannedFact[] = [];
  for (const f of input.facts) {
    const base = { fact: f.fact, kind: f.kind, notability: f.notability, valid_from: f.valid_from ?? input.validFrom };
    if (input.factsSkipped) { facts.push({ ...base, status: 'skipped', reason: input.factsSkipped, copies: [] }); continue; }
    const named = new Map<string, PlannedPage>();
    for (const n of f.entities) { const p = byName.get(n.toLowerCase()); if (p && p.status !== 'skipped') named.set(p.slug, p); }
    for (const p of pages) if (p.status !== 'skipped' && !named.has(p.slug) && firstMention(f.fact, p.name) !== Number.POSITIVE_INFINITY) named.set(p.slug, p);
    const targets = [...named.values()].sort((a, b) => (a.first_mention < 0 ? Infinity : a.first_mention) - (b.first_mention < 0 ? Infinity : b.first_mention)).slice(0, 2);
    if (!targets.length) { facts.push({ ...base, status: 'skipped', reason: 'no_entity', copies: [] }); continue; }
    const copies: PlannedCopy[] = [];
    for (const t of targets) {
      if (t.status !== 'existing') { copies.push({ entity_slug: t.slug, status: 'planned' }); continue; }
      const check = await checkFactAgainstSaved(ctx.engine, sourceId, { fact: f.fact, kind: f.kind, visibility: input.visibility, entity_slug: t.slug }, { excludePrivate });
      copies.push(check.verdict === 'withdrawn' ? { entity_slug: t.slug, status: 'skipped', reason: 'withdrawn' }
        : check.verdict === 'duplicate' ? { entity_slug: t.slug, status: 'support', fact_id: check.id }
        : { entity_slug: t.slug, status: 'planned' });
    }
    facts.push({ ...base, status: 'planned', copies });
  }
  return { pages, facts, near_name_complete: !known.truncated };
}

function dedupFlags(flags: Array<{ slug: string; name: string; kind: string }>) {
  const seen = new Set<string>();
  return flags.filter(f => { const k = f.slug + '\0' + f.kind; if (seen.has(k)) return false; seen.add(k); return true; });
}
