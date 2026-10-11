// src/core/extract-ner.ts
// v0.41.18.0 (A10, T7). NER link extraction reuses the by-mention gazetteer
// and applies schema-pack `link_types[].inference.regex` patterns to assign
// a typed link verb ("CEO of Acme" → 'works_at' linking the page to Acme).
//
// Codex finding #12 design (locked): do NOT split link_source='ner' as a
// new provenance — that would break every existing link_source='mentions'
// query (backlink-count filter, orphan-ratio, doctor checks). Instead:
// keep link_source='mentions' AND set link_kind='typed_ner' on the new row
// (v98 added the column). Legacy plain mentions stay link_kind=NULL
// (semantically 'plain').
//
// The links UNIQUE constraint excludes link_kind, so an existing plain
// mention row + a typed_ner row for the same (from, to, type, source, origin)
// collide — DO NOTHING. NER does NOT overwrite plain mentions; the verb
// link goes in as a different row with a different link_type.

import type { BrainEngine } from './engine.ts';
import type { LinkBatchInput } from './engine.ts';
import {ingestMentionOrigin} from './pmbrain-adapters/ingest-provenance.ts';
import { buildGazetteer, findMentionedEntities, type Gazetteer } from './by-mention.ts';
import { inferLinkTypeFromPack } from './schema-pack/link-inference.ts';
import { loadActivePack } from './schema-pack/load-active.ts';
import { loadConfig } from './config.ts';
import { inferLinkType } from './link-extraction.ts';
import type { PageType } from './types.ts';

export interface ExtractNerOpts {
  signal?: AbortSignal;
  yieldDuringPhase?: () => Promise<void>;
  /** When true: enumerate but don't write. */
  dryRun?: boolean;
  /** Optional source-id filter on the WALK (gazetteer stays brain-wide). */
  sourceIdFilter?: string;
  /** Optional page-type filter on the WALK. */
  typeFilter?: string;
  /** Only scan pages with updated_at after this ISO date. */
  since?: string;
  /**
   * Pre-built gazetteer (T7+: combined `--by-mention --ner` walk shares
   * one gazetteer across both passes). When omitted, this fn builds its own.
   */
  gazetteer?: Gazetteer;
  /** Optional progress hook called per processed page. */
  onProgress?: (done: number, total: number, created: number) => void;
  /** When set, only these page slugs are scanned. */
  slugs?: readonly string[];
}

export interface ExtractNerResult {
  /** Pages scanned. */
  pages: number;
  /** Typed-NER links created (or would-have-created in dry-run). */
  created: number;
  /** Pages where the active schema pack had no link_types at all. */
  pack_unavailable: boolean;
}

/** Context window scanned around each mention for verb-pattern matching. */
const CONTEXT_WINDOW_CHARS = 80;

/**
 * Pure helper: get the context window around a mention's character offset.
 * Returns the substring [offset - W, offset + name.length + W] of the body.
 * Caller passes (body, offset, name.length).
 */
export function getContextWindow(
  body: string,
  offset: number,
  nameLen: number,
  window: number = CONTEXT_WINDOW_CHARS,
): string {
  const start = Math.max(0, offset - window);
  const end = Math.min(body.length, offset + nameLen + window);
  return body.slice(start, end);
}

/**
 * Pure helper: derive the entity-type→link-verb pair from a single mention.
 * Returns null when (a) target type unknown, (b) pack has no inference for
 * that type, (c) no verb pattern matches the surrounding context.
 *
 * Exported for unit tests; the orchestrator below uses it directly.
 */
export function inferNerLinkType(
  pack: Parameters<typeof inferLinkTypeFromPack>[0],
  targetType: string | undefined,
  context: string,
  sourcePageType?: string,
): string | null {
  if (!targetType) return null;
  try {
    const inferred = inferLinkTypeFromPack(
      pack,
      sourcePageType ?? targetType,
      context,
      undefined,
      sourcePageType ? targetType : undefined,
      { ner: true },
    );
    if (inferred) return inferred;
    const existing = inferLinkType(
      (sourcePageType ?? targetType) as PageType,
      context,
      undefined,
      undefined,
      targetType,
    );
    if (existing !== 'mentions' && pack.link_types.some(rule => rule.name === existing && (rule.inference?.page_type || rule.inference?.target_type))) {
      return null;
    }
    return existing !== 'mentions' && pack.link_types.some(rule => rule.name === existing) ? existing : null;
  } catch {
    return null;
  }
}

/**
 * extractNerLinks: walk pages, find body mentions, apply schema-pack
 * inference regex per (target_type, surrounding context) to assign a typed
 * link verb. Returns count of created links.
 *
 * Best-effort wrt the schema pack: if no active pack OR no link_types
 * declared OR no inference.regex on any link_type, the function returns
 * pack_unavailable=true and 0 created. Caller (CLI / handler) surfaces a
 * one-line hint instead of an error.
 */
export async function extractNerLinks(
  engine: BrainEngine,
  opts: ExtractNerOpts = {},
): Promise<ExtractNerResult> {
  opts.signal?.throwIfAborted();
  const dryRun = opts.dryRun ?? false;

  // Pack best-effort: no pack → no inference → nothing to do.
  const dbConfig = await engine.getConfig('schema_pack');
  const sourcePack = opts.sourceIdFilter ? await engine.getConfig(`schema_pack.source.${opts.sourceIdFilter}`) : null;
  const pack = await loadActivePack({
    cfg: loadConfig(), remote: true, sourceId: opts.sourceIdFilter,
    dbConfig: dbConfig ?? undefined,
    perSourceDb: opts.sourceIdFilter && sourcePack ? new Map([[opts.sourceIdFilter, sourcePack]]) : undefined,
  }).catch(() => null);
  if (!pack || !pack.manifest?.link_types || pack.manifest.link_types.length === 0) {
    return { pages: 0, created: 0, pack_unavailable: true };
  }
  // Require at least one link_type with an inference.regex; otherwise NER
  // has no patterns to match and we'd waste a full walk.
  const hasRegex = pack.manifest.link_types.some(
    (lt) => lt.inference && typeof lt.inference === 'object' && 'regex' in lt.inference,
  );
  if (!hasRegex) return { pages: 0, created: 0, pack_unavailable: true };

  const gazetteer = opts.gazetteer ?? await buildGazetteer(engine);
  if (gazetteer.size === 0) {
    return { pages: 0, created: 0, pack_unavailable: false };
  }

  // Pre-fetch target entity types so inferLinkType has the type signal
  // without an N+1 getPage round-trip. Pulls the slug→type map from
  // listAllPageRefs + a single listPages projection.
  const targetTypeMap = await buildTargetTypeMap(engine);

  const slugFilter = opts.slugs ? new Set(opts.slugs) : null;
  const allRefs = (opts.sourceIdFilter
    ? (await engine.listAllPageRefs()).filter((r) => r.source_id === opts.sourceIdFilter)
    : await engine.listAllPageRefs()
  ).filter((ref) => !slugFilter || slugFilter.has(ref.slug));

  let processed = 0;
  let created = 0;
  const batch: LinkBatchInput[] = [];
  const BATCH_SIZE = 500;
  const sinceMs = opts.since ? new Date(opts.since).getTime() : null;

  async function flush() {
    opts.signal?.throwIfAborted();
    if (batch.length === 0) return;
    if (!dryRun) {
      created += await engine.addLinksBatch(batch); // gbrain-allow-direct-insert: extract-ner — typed NER link write
    } else {
      created += batch.length;
    }
    batch.length = 0;
  }

  for (const { slug, source_id } of allRefs) {
    opts.signal?.throwIfAborted();
    if (processed % 25 === 0) await opts.yieldDuringPhase?.();
    opts.signal?.throwIfAborted();
    const page = await engine.getPage(slug, { sourceId: source_id });
    if (!page) continue;
    if (opts.typeFilter && page.type !== opts.typeFilter) continue;
    if (sinceMs !== null) {
      const updatedMs = new Date(page.updated_at).getTime();
      if (Number.isFinite(updatedMs) && updatedMs <= sinceMs) continue;
    }
    processed++;
    opts.onProgress?.(processed, allRefs.length, created);

    const active=await (await import('./pmbrain-adapters/ingest-provenance.ts')).activeIngestContent(engine,page);
    const body = active.compiled_truth + '\n\n' + active.timeline;
    if (!body.trim()) continue;

    const mentions = findMentionedEntities(body, gazetteer, {
      fromSlug: slug,
      fromSourceId: source_id,
      includeBlockedSurfaces: true,
    });
    if (mentions.length === 0) continue;

    for (const m of mentions) {
      const targetType = targetTypeMap.get(`${m.source_id}::${m.slug}`);
      const context = getContextWindow(body, m.offset, m.name.length);
      const verb = inferNerLinkType(pack.manifest, targetType, context, page.type);
      if (!verb) continue;

      batch.push({
        ...ingestMentionOrigin(page.frontmatter,body,m.offset),
        from_slug: slug,
        to_slug: m.slug,
        link_type: verb,
        link_source: 'mentions',
        link_kind: 'typed_ner',
        context: m.name,
        from_source_id: source_id,
        to_source_id: m.source_id,
      });
      if (batch.length >= BATCH_SIZE) await flush();
    }
  }

  await flush();
  return { pages: processed, created, pack_unavailable: false };
}

/**
 * Helper: build a Map<sourceId::slug → type> for all entity-typed pages.
 * One round-trip via listPages. Targets cached at extraction-start so
 * inferNerLinkType doesn't pay an N+1 cost per mention.
 */
async function buildTargetTypeMap(engine: BrainEngine): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const result = await engine.executeRaw<{ slug: string; source_id: string; type: string }>(
    `SELECT slug, source_id, type FROM pages
       WHERE type IN ('person', 'company', 'organization', 'entity')
         AND deleted_at IS NULL`,
  );
  for (const row of result) {
    map.set(`${row.source_id}::${row.slug}`, row.type);
  }
  return map;
}
