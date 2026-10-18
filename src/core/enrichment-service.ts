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
import type { OperationContext } from './ops/contract.ts';
import { OperationError } from './ops/contract.ts';
import { waitForCapacity } from './backoff.ts';
import { quarantineMarkers } from './extraction-review.ts';
import { SLUG_WORD_CHARS, SLUG_VARIATION_SELECTORS_RE } from './cjk.ts';
import { createHash } from 'node:crypto';
import { portableSegment, RESERVED_DEVICE_NAME, segmentByteBudget, truncateUtf8 } from './portable-slug.ts';
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
import { followRetirement } from './entities/resolve.ts';
import { maintenanceTransaction } from './persistence/attribution.ts';
import { managedPersistenceEnabled } from './persistence/ownership.ts';
import { deriveTrust, derivedMaintenanceTransaction, lowerDerivedPage, lowerDerivedPageIn } from './trust/taint.ts';
import { derivedGateConfig, derivedGateInput, recordTimelineFlag, timelineRowAllowed } from './trust/derived-gate.ts';
import { assessTimelineForGate } from './write-gate.ts';

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
  /** #6262: the caller's context; on a managed brain every write goes through the coordinator under its authority. */
  ctx?: OperationContext;
}

export interface EnrichmentResult {
  slug: string;
  action: 'created' | 'updated' | 'skipped';
  /** True when the created stub landed in the quarantine lane (issue #160). */
  quarantined?: boolean;
  /**
   * Why nothing was written: the page is retired and its superseded_by / merged_into chain has no live target (B-9),
   * or both this entity's slug and its hash-tagged slug hold pages that name another entity.
   */
  skipped_reason?: 'retired_page_unfollowable' | 'entity_slug_taken';
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

// Keep-set mirrors sync.ts:slugifySegment (single grammar, see cjk.ts
// docstring) so an entity minted here and a file synced under brain/people/
// never diverge on what counts as a slug character.
const SLUGIFY_ENTITY_KEEP_RE = new RegExp(`[^${SLUG_WORD_CHARS}]`, 'gu');

/**
 * Convert an entity name to a URL-safe slug.
 *
 * Was ASCII-only ([a-z0-9]), which silently dropped every non-Latin
 * character — Cyrillic/CJK/Arabic/etc. names slugified to '' or a bare
 * '-', producing empty or colliding people/companies slugs. Now mirrors
 * sync.ts:slugifySegment's Unicode-aware keep-set: strip Latin accents to
 * their base letter (fold, don't drop), keep every script's own letters
 * as-is (Cyrillic, CJK, Devanagari, …). A name that slugifies to a Windows
 * reserved device name gets the entity type as a suffix (`Con` →
 * `people/con-person`) and an over-long one is cut to the file-name budget
 * and tagged with a hash of its full slug (portable-slug.ts), so a stub is
 * always a page export and write-through can store and two long names sharing
 * a prefix keep separate pages; a page an older brain created as `people/con`
 * is still found through the legacy-slug lookup in enrichEntity.
 */
export function slugifyEntity(name: string, type: 'person' | 'company'): string {
  return `${type === 'person' ? 'people' : 'companies'}/${entitySegment(entitySlugBase(name), type, false)}`;
}

/** The full slug segment a name maps to before portability escaping: the identity two names share when it is equal. */
function entitySlugBase(name: string): string {
  return name
    .replace(/['‘’]/g, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .normalize('NFC')
    .replace(SLUG_VARIATION_SELECTORS_RE, '')
    .toLowerCase()
    .replace(SLUGIFY_ENTITY_KEEP_RE, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The portable file name for a slug base: a reserved name gets the entity type
 * as a suffix, and a name over the budget (or any name when `tagged`) ends in
 * the first 8 hex digits of the base's SHA-256, cut to fit before the tag.
 */
function entitySegment(base: string, type: 'person' | 'company', tagged: boolean): string {
  const renamed = base.replace(RESERVED_DEVICE_NAME, name => `${name}-${type}`);
  const budget = segmentByteBudget(true);
  if (!tagged && Buffer.byteLength(renamed) <= budget) return renamed;
  const tag = createHash('sha256').update(base).digest('hex').slice(0, 8);
  return `${truncateUtf8(renamed, budget - tag.length - 1).replace(/[-._:]+$/, '')}-${tag}`;
}

/**
 * The slug the pre-Unicode slugifier produced for the same name (ASCII only:
 * every non-[a-z0-9] run became '-'). Kept so enrichment can find entity pages
 * that existing brains created before slugifyEntity learned other scripts,
 * instead of minting a second page for the same entity.
 */
export function legacyAsciiEntitySlug(name: string, type: 'person' | 'company'): string {
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
  const base = entitySlugBase(request.entityName);
  const prefix = request.entityType === 'person' ? 'people' : 'companies';
  const candidateSlug = `${prefix}/${entitySegment(base, request.entityType, false)}`;
  const sourceId = opts?.sourceId ?? 'default';
  let slug = await engine.resolveSlugWithAlias(candidateSlug, sourceId);
  // Fail-closed: only an explicit `trusted: true` writes authoritative pages.
  const trusted = opts?.trusted === true;
  const scope = opts?.sourceId ? { sourceId: opts.sourceId } : undefined;
  // #5575 I2: a stub and its timeline row restate the source page's mention, so they carry its taint (capped at agent_written).
  const derivation = await deriveTrust(engine, [{ table: 'pages', sourceId, slug: request.sourceSlug }], { channel: 'derive:enrichment' });
  const ctx = opts?.ctx;
  // #6262: a managed brain refuses direct writes, so each one goes through the coordinator under the caller's authority.
  const managed = ctx !== undefined && await managedPersistenceEnabled(engine);
  const coordinated = async <T>(lockSlugs: string[], write: (tx: BrainEngine) => Promise<T>) => {
    const { coordinatedDatabaseWrite } = await import('./persistence/database-write.ts');
    return coordinatedDatabaseWrite(ctx!, 'extract_entities', slug, lockSlugs, write, derivation.trust);
  };

  // 1. Count existing mentions for tier auto-escalation
  const { mentionCount, mentionSources } = await countMentions(engine, request.entityName, opts?.sourceId);

  // 2. Determine tier (auto-escalate based on mentions)
  const suggestedTier = suggestTier(mentionCount, mentionSources, request.context);
  const tier = request.tier || suggestedTier;
  const tierEscalated = suggestedTier < (request.tier || 3); // lower tier number = higher importance

  // 3. Check if entity page exists
  let existingPage = await engine.getPage(slug, scope);
  // F8: a page whose title maps to this slug base names this entity; any other page at the slug may name another one.
  const namesEntity = (title: string | undefined) => entitySlugBase(title ?? '') === base;
  if (!existingPage || !namesEntity(existingPage.title)) {
    // A page an older brain created under the ASCII-only slug is the same entity.
    const legacy = legacyAsciiEntitySlug(request.entityName, request.entityType);
    let legacyFound = false;
    if (legacy !== candidateSlug && !/^(people|companies)\/$/.test(legacy)) {
      const legacySlug = await engine.resolveSlugWithAlias(legacy, sourceId);
      const legacyPage = await engine.getPage(legacySlug, { sourceId });
      // The legacy slug is lossy (José -> people/jos), so only reuse a page that names this entity.
      const same = (t: string) => t.normalize('NFC').trim().toLowerCase();
      if (legacyPage && same(legacyPage.title ?? '') === same(request.entityName)) { slug = legacySlug; existingPage = legacyPage; legacyFound = true; }
    }
    // An over-budget name an older gbrain minted at its cut slug with no hash tag; that slug is shared by every name with the same prefix.
    const untagged = `${prefix}/${portableSegment(base, true, request.entityType)}`;
    if (!legacyFound && !existingPage && untagged !== candidateSlug) {
      const untaggedSlug = await engine.resolveSlugWithAlias(untagged, sourceId);
      const untaggedPage = await engine.getPage(untaggedSlug, scope);
      if (untaggedPage && namesEntity(untaggedPage.title)) { slug = untaggedSlug; existingPage = untaggedPage; legacyFound = true; }
    }
    // An escaped slug (Aux -> companies/aux-company) can be another entity's natural slug, and a natural slug can be
    // the escaped slug another entity was minted at (Prn Company's companies/prn-company held by Prn): either way the
    // page names another entity, so this one takes its hash-tagged slug. A page a person titled differently at this
    // entity's natural slug stays this entity's page.
    const heldByOther = !legacyFound && existingPage !== null &&
      (candidateSlug !== `${prefix}/${base}` || slugifyEntity(existingPage.title ?? '', request.entityType) === candidateSlug);
    if (heldByOther) {
      const tagged = `${prefix}/${entitySegment(base, request.entityType, true)}`;
      const taggedSlug = tagged === candidateSlug ? null : await engine.resolveSlugWithAlias(tagged, sourceId);
      const taggedPage = taggedSlug === null ? null : await engine.getPage(taggedSlug, scope);
      if (taggedSlug === null || (taggedPage && !namesEntity(taggedPage.title))) {
        return { slug, action: 'skipped', skipped_reason: 'entity_slug_taken', tier, backlinkCreated: false, timelineAdded: false,
          mentionCount, mentionSources, suggestedTier, tierEscalated };
      }
      slug = taggedSlug;
      existingPage = taggedPage;
    }
  }
  // B-9: a retired page (canonical: false, superseded_by) answers through its canonical page, as fact resolution does (#6898).
  if (existingPage) {
    const live = await followRetirement(engine, sourceId, slug);
    if (!live) {
      return { slug, action: 'skipped', skipped_reason: 'retired_page_unfollowable', tier, backlinkCreated: false, timelineAdded: false,
        mentionCount, mentionSources, suggestedTier, tierEscalated };
    }
    if (live.slug !== slug) { slug = live.slug; existingPage = await engine.getPage(slug, { sourceId }); }
  }
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
    if (managed) {
      // No direct-write fallback: a refusal or a pending write reaches the caller as its envelope.
      const { submitPageMutation } = await import('./persistence/page-mutations.ts');
      const md = serializeMarkdown(frontmatter, content, '', { type, title, tags: [] });
      await submitPageMutation(ctx!, { operation: 'put_page', params: { slug, content: md,
        ...(derivation.trust.tier === 'external_untrusted' ? { content_origin: 'tool_output' } : {}) } });
      await coordinated([slug], tx => lowerDerivedPageIn(tx, derivation, sourceId, slug));
    } else try {
      // #3994: canonical import pipeline so the stub is chunked (+ embedded
      // when a provider is configured) and reachable by the recall arms.
      const md = serializeMarkdown(frontmatter, content, '', { type, title, tags: [] });
      await importFromContent(engine, slug, md, {
        noEmbed: !isAvailable('embedding'), writeGate: derivedGateInput(derivation.trust),
        ...(opts?.sourceId ? { sourceId: opts.sourceId } : {}),
      });
      await lowerDerivedPage(engine, derivation, sourceId, slug);
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
      await derivedMaintenanceTransaction(engine, derivation, async tx => {
        const page = await tx.putPage(slug, { title, type, compiled_truth: content, timeline: '', frontmatter }, scope);
        return { result: page, rows: [{ table: 'pages', id: page.id, sourceId }] };
      });
    }
    action = 'created';
  }

  // 4. Add timeline entry
  let timelineAdded = false;
  try {
    const entry = { date: new Date().toISOString().split('T')[0] ?? '', summary: `Referenced in [${request.sourceSlug}](${request.sourceSlug}) — ${request.context}`, source: request.sourceSlug };
    // #5575 B3: the caller's context lands on the entity page, so it passes the write gate at the derived tier.
    const assessment = assessTimelineForGate(entry, derivedGateInput(derivation.trust), await derivedGateConfig(engine));
    const write = async (tx: BrainEngine) => {
      const added = await tx.addTimelineEntry(slug, entry, scope); // gbrain-allow-direct-insert: auto-timeline reconciliation triggered by entity reference in source markdown
      if (added) await recordTimelineFlag(tx, assessment, { slug, source_id: sourceId, ...entry });
      return true;
    };
    timelineAdded = timelineRowAllowed(assessment) &&
      (managed ? (await coordinated([slug], write))!.value : await maintenanceTransaction(engine, write, derivation.trust));
  } catch (e) {
    if (managed) throw e;
    // Timeline add failed (page might not support it)
  }

  // 5. Add backlink from entity to source
  let backlinkCreated = false;
  try {
    const link = (tx: BrainEngine) => tx.addLink(slug, request.sourceSlug, `Entity mention from ${request.sourceSlug}`, undefined, undefined, undefined, undefined, opts?.sourceId ? { fromSourceId: opts.sourceId, toSourceId: opts.sourceId } : undefined); // gbrain-allow-direct-insert: auto-link reconciliation triggered by entity reference in source markdown
    if (managed) await coordinated([slug, request.sourceSlug], link);
    else await link(engine);
    backlinkCreated = true;
  } catch (e) {
    if (managed && e instanceof OperationError) throw e;
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
    let result: EnrichmentResult;
    try { result = await enrichEntity(engine, req, { trusted: config?.trusted, sourceId: config?.sourceId, ctx: config?.ctx }); }
    catch (e) {
      // #6262: a managed refusal stops the batch and says which entities were already written.
      if (e instanceof OperationError && results.length) {
        e.why = `${e.why ?? ''} ${results.length} of ${requests.length} entities were written before ${req.entityName}: ${results.map(r => r.slug).join(', ')}. Run extract_entities again on the same text once the write can commit; written entities are updated, not duplicated.`.trim();
      }
      throw e;
    }
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
  const namePattern = /(?<!\p{L})(\p{Lu}[\p{Ll}\p{M}]+(?:[^\S\r\n\v\f\u2028\u2029]+\p{Lu}[\p{Ll}\p{M}]+){1,3})(?!\p{L})/gu;
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
