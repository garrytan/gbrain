/**
 * Enrichment as a global service.
 *
 * Shared library callable from any ingest pathway. Handles the brain CRUD
 * for entity enrichment: check brain, create/update page, backlink, timeline.
 *
 * External API enrichment (people data APIs, professional networks) remains
 * agent-orchestrated per the enrich skill file. This library handles the
 * brain-side operations.
 *
 * Entity mention counts are derived from engine.searchKeyword() on the
 * existing data (clamped to 100 results). Source tracking derives from
 * page type/slug prefix since SearchResult has no metadata.skill field.
 */

import type { BrainEngine } from './engine.ts';
import { waitForCapacity } from './backoff.ts';
import { quarantineMarkers } from './extraction-review.ts';
// #3994: created stubs route through serializeMarkdown + importFromContent
// (the same parse→chunk→embed pipeline put_page uses) instead of a bare
// engine.putPage, so fresh entity pages land in the retrieval surface
// (content_chunks + embeddings) — the #2163 concept-page precedent.
import { importFromContent } from './import-file.ts';
import { serializeMarkdown } from './markdown.ts';
import { isAvailable } from './ai/gateway.ts';
// #4222: shared generic-token reject list — same list gates the by-mention
// gazetteer and drives the junk_entity_hubs doctor check.
import { isJunkEntityName } from './entity-name-quality.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnrichmentRequest {
  entityName: string;
  entityType: 'person' | 'company';
  context: string;
  sourceSlug: string;
  tier?: 1 | 2 | 3;
}

/**
 * Trust options for the enrichment write path (issue #160).
 *
 * `trusted: true` — the input text comes from the machine owner via the
 * trusted local CLI (ctx.remote === false) AND the caller passed an explicit
 * opt-in flag. Stubs write direct as authoritative entity pages.
 *
 * Anything else (undefined, false, absent) is UNTRUSTED — fail-closed,
 * mirroring the OperationContext.remote invariant ("anything not strictly
 * false is remote"). Created stubs land in the quarantine lane: frontmatter
 * `provenance: 'auto-extracted'` + `status: 'unverified'`. They are excluded
 * from authoritative retrieval boosts and wait in the review queue
 * (`extraction_pending` / `extraction_review` ops) until the owner promotes
 * or rejects them.
 */
export interface EnrichmentTrustOptions {
  trusted?: boolean;
  /** Source to read/write in (multi-source brains). Omitted → engine default. */
  sourceId?: string;
}

export interface EnrichmentResult {
  slug: string;
  action: 'created' | 'updated' | 'skipped';
  /** True when the created stub landed in the quarantine lane (issue #160). */
  quarantined?: boolean;
  tier: 1 | 2 | 3;
  backlinkCreated: boolean;
  timelineAdded: boolean;
  mentionCount: number;
  mentionSources: string[];
  suggestedTier: 1 | 2 | 3;
  tierEscalated: boolean;
}

// ---------------------------------------------------------------------------
// Entity naming utilities
// ---------------------------------------------------------------------------

/** Convert an entity name to a URL-safe slug. */
export function slugifyEntity(name: string, type: 'person' | 'company'): string {
  const slug = name
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const prefix = type === 'person' ? 'people' : 'companies';
  return `${prefix}/${slug}`;
}

/** Get the brain page path for an entity. */
export function entityPagePath(name: string, type: 'person' | 'company'): string {
  return slugifyEntity(name, type);
}

// ---------------------------------------------------------------------------
// Core enrichment
// ---------------------------------------------------------------------------

/**
 * Enrich a single entity: check brain, create/update, backlink, timeline.
 * Uses searchKeyword to count mentions and derive source skills.
 */
export async function enrichEntity(
  engine: BrainEngine,
  request: EnrichmentRequest,
  opts?: EnrichmentTrustOptions,
): Promise<EnrichmentResult> {
  const candidateSlug = slugifyEntity(request.entityName, request.entityType);
  const sourceId = opts?.sourceId ?? 'default';
  const slug = await engine.resolveSlugWithAlias(candidateSlug, sourceId);
  // Fail-closed: only an explicit `trusted: true` writes authoritative pages.
  const trusted = opts?.trusted === true;
  const scope = opts?.sourceId ? { sourceId: opts.sourceId } : undefined;

  // 1. Count existing mentions for tier auto-escalation
  const { mentionCount, mentionSources } = await countMentions(engine, request.entityName, opts?.sourceId);

  // 2. Determine tier (auto-escalate based on mentions)
  const suggestedTier = suggestTier(mentionCount, mentionSources, request.context);
  const tier = request.tier || suggestedTier;
  const tierEscalated = suggestedTier < (request.tier || 3); // lower tier number = higher importance

  // 3. Check if entity page exists
  const existingPage = await engine.getPage(slug, scope);
  let action: 'created' | 'updated' | 'skipped';

  if (existingPage) {
    // UPDATE path — add timeline entry
    action = 'updated';
  } else {
    // #4222: refuse to MINT a page for a junk entity name — a single
    // generic token ("Will", "Info", "Chief", "Unknown") or a bare
    // @handle. These come from over-eager extractors and become
    // near-empty mega-hubs that accrete thousands of mention edges.
    // Existing pages are user-visible and stay trusted (CK12 precedent);
    // only creation is gated — no auto-delete, ever.
    if (isJunkEntityName(request.entityName)) {
      return {
        slug,
        action: 'skipped',
        tier,
        backlinkCreated: false,
        timelineAdded: false,
        mentionCount,
        mentionSources,
        suggestedTier,
        tierEscalated,
      };
    }
    // CREATE path — new entity page
    const title = request.entityName;
    const type = request.entityType;
    const content = generateStubContent(request.entityName, request.entityType, request.context);
    const frontmatter = {
      created: new Date().toISOString().split('T')[0],
      source: request.sourceSlug,
      tier,
      // issue #160 quarantine lane: stubs extracted from untrusted input
      // carry provenance + unverified markers until the owner reviews them.
      ...(trusted ? {} : quarantineMarkers()),
    };
    try {
      // #3994: canonical import pipeline so the stub is chunked (+ embedded
      // when a provider is configured) and reachable by the recall arms.
      const md = serializeMarkdown(frontmatter, content, '', { type, title, tags: [] });
      await importFromContent(engine, slug, md, {
        noEmbed: !isAvailable('embedding'),
        ...(opts?.sourceId ? { sourceId: opts.sourceId } : {}),
      });
    } catch (e) {
      // Fail-open fallback: a pipeline error (parse edge case, size guard)
      // must never regress the batch — the pre-#3994 direct write still
      // produces a page (unchunked, but present + reviewable). Warn loudly:
      // silence here would hide that the stub is invisible to vector recall
      // until the next `gbrain embed --stale` / re-import sweep.
      process.stderr.write(
        `[enrich] import pipeline failed for stub ${slug} (${e instanceof Error ? e.message : String(e)}); ` +
        'falling back to a direct unchunked write — the page exists but is not chunked/embedded until re-imported.\n',
      );
      await engine.putPage(slug, {
        title,
        type,
        compiled_truth: content,
        timeline: '',
        frontmatter,
      }, scope);
    }
    action = 'created';
  }

  // 4. Add timeline entry
  let timelineAdded = false;
  try {
    await engine.addTimelineEntry(slug, { // gbrain-allow-direct-insert: auto-timeline reconciliation triggered by entity reference in source markdown
      date: new Date().toISOString().split('T')[0] ?? '',
      summary: `Referenced in [${request.sourceSlug}](${request.sourceSlug}) — ${request.context}`,
      source: request.sourceSlug,
    }, scope);
    timelineAdded = true;
  } catch {
    // Timeline add failed (page might not support it)
  }

  // 5. Add backlink from entity to source
  let backlinkCreated = false;
  try {
    await engine.addLink(slug, request.sourceSlug, `Entity mention from ${request.sourceSlug}`, undefined, undefined, undefined, undefined, opts?.sourceId ? { fromSourceId: opts.sourceId, toSourceId: opts.sourceId } : undefined); // gbrain-allow-direct-insert: auto-link reconciliation triggered by entity reference in source markdown
    backlinkCreated = true;
  } catch {
    // Link might already exist
  }

  return {
    slug,
    action,
    ...(action === 'created' && !trusted ? { quarantined: true } : {}),
    tier,
    backlinkCreated,
    timelineAdded,
    mentionCount,
    mentionSources,
    suggestedTier,
    tierEscalated,
  };
}

/**
 * Enrich multiple entities with throttling between each.
 * config.onProgress is called after each entity so callers can stream
 * progress to a reporter (CLI) or job.updateProgress (Minion).
 */
export async function enrichEntities(
  engine: BrainEngine,
  requests: EnrichmentRequest[],
  config?: { throttle?: boolean; onProgress?: (done: number, total: number, name: string) => void } & EnrichmentTrustOptions,
): Promise<EnrichmentResult[]> {
  const results: EnrichmentResult[] = [];
  for (const req of requests) {
    if (config?.throttle !== false) {
      await waitForCapacity({ maxAttempts: 5 }); // shorter timeout for batch items
    }
    const result = await enrichEntity(engine, req, { trusted: config?.trusted, sourceId: config?.sourceId });
    results.push(result);
    config?.onProgress?.(results.length, requests.length, req.entityName);
  }
  return results;
}

/**
 * Extract entities from text, then enrich each.
 * Uses simple regex patterns for entity detection.
 * This is the first fail-improve integration candidate (per Codex review).
 */
export async function extractAndEnrich(
  engine: BrainEngine,
  text: string,
  sourceSlug: string,
  opts?: EnrichmentTrustOptions & { throttle?: boolean; maxEntities?: number },
): Promise<EnrichmentResult[]> {
  // Bounded by default (#160 hardening): the greedy regex on a large paste
  // can produce thousands of hits; each enrichment is several DB round-trips.
  const entities = extractEntities(text).slice(0, opts?.maxEntities ?? 200);
  if (entities.length === 0) return [];

  const requests: EnrichmentRequest[] = entities.map(e => ({
    entityName: e.name,
    entityType: e.type,
    context: e.context,
    sourceSlug,
  }));

  return enrichEntities(engine, requests, { trusted: opts?.trusted, sourceId: opts?.sourceId, throttle: opts?.throttle });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Count entity mentions across the brain using keyword search. */
async function countMentions(
  engine: BrainEngine,
  entityName: string,
  sourceId?: string,
): Promise<{ mentionCount: number; mentionSources: string[] }> {
  try {
    const results = await engine.searchKeyword(entityName, { limit: 100, ...(sourceId ? { sourceId } : {}) });
    // Derive sources from slug prefixes since SearchResult has no metadata.skill
    const sources = new Set<string>();
    for (const r of results) {
      const prefix = r.slug.split('/')[0];
      if (prefix === 'people' || prefix === 'companies') sources.add('enrich');
      else if (prefix === 'meetings') sources.add('meeting-ingestion');
      else if (prefix === 'media') sources.add('media-ingest');
      else if (prefix === 'sources' || prefix === 'ideas') sources.add('idea-ingest');
      else if (prefix === 'voice-notes') sources.add('voice-note');
      else sources.add('brain-ops');
    }
    return { mentionCount: results.length, mentionSources: [...sources] };
  } catch {
    return { mentionCount: 0, mentionSources: [] };
  }
}

/** Suggest enrichment tier based on mention frequency. */
function suggestTier(
  mentionCount: number,
  mentionSources: string[],
  context: string,
): 1 | 2 | 3 {
  // 8+ mentions OR meeting/conversation source → Tier 1
  if (mentionCount >= 8) return 1;
  if (mentionSources.includes('meeting-ingestion') || mentionSources.includes('voice-note')) return 1;

  // 3-7 mentions across 2+ sources → Tier 2
  if (mentionCount >= 3 && mentionSources.length >= 2) return 2;

  // Default → Tier 3
  return 3;
}

/** Generate stub content for a new entity page. */
function generateStubContent(name: string, type: 'person' | 'company', context: string): string {
  if (type === 'person') {
    return `# ${name}\n\n**Type:** Person\n\n## Summary\n\n*Stub page. ${context}*\n\n## Timeline\n`;
  }
  return `# ${name}\n\n**Type:** Company\n\n## Summary\n\n*Stub page. ${context}*\n\n## Timeline\n`;
}

/** Simple entity extraction from text using regex patterns. */
export function extractEntities(text: string): Array<{ name: string; type: 'person' | 'company'; context: string }> {
  const entities: Array<{ name: string; type: 'person' | 'company'; context: string }> = [];
  const seen = new Set<string>();

  // Match capitalized multi-word names (likely people or companies)
  // Pattern: 2-4 capitalized words in sequence, scoped to a single line so a
  // paragraph break (or any line break) can't splice unrelated capitalized
  // words from adjacent sentences into one bogus candidate. The pattern
  // excludes all vertical whitespace -- CR, LF, VT (U+000B), FF (U+000C),
  // and the Unicode line/paragraph separators (U+2028/U+2029) -- while
  // retaining horizontal whitespace (spaces, tabs, NBSP, other Unicode
  // space separators), unlike a plain `[ \t]+`.
  const namePattern = /\b([A-Z][a-z]+(?:[^\S\r\n\v\f\u2028\u2029]+[A-Z][a-z]+){1,3})\b/g;
  let match;
  while ((match = namePattern.exec(text)) !== null) {
    const name = match[1];
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());

    // Simple heuristics for type classification
    const isCompany = /Inc\b|Corp\b|Ltd\b|LLC\b|Co\b|Labs?\b|Tech\b|AI\b|Capital\b|Ventures?\b|Fund\b/i.test(name);
    const type = isCompany ? 'company' : 'person';

    // Extract surrounding context (50 chars each side)
    const idx = match.index;
    const start = Math.max(0, idx - 50);
    const end = Math.min(text.length, idx + name.length + 50);
    const context = text.slice(start, end).replace(/\n/g, ' ').trim();

    entities.push({ name, type, context });
  }

  return entities;
}
