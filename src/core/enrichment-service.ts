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

export interface EnrichmentResult {
  slug: string;
  action: 'created' | 'updated' | 'skipped';
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
): Promise<EnrichmentResult> {
  const slug = slugifyEntity(request.entityName, request.entityType);

  // 1. Count existing mentions for tier auto-escalation
  const { mentionCount, mentionSources } = await countMentions(engine, request.entityName);

  // 2. Determine tier (auto-escalate based on mentions)
  const suggestedTier = suggestTier(mentionCount, mentionSources, request.context);
  const tier = request.tier || suggestedTier;
  const tierEscalated = suggestedTier < (request.tier || 3); // lower tier number = higher importance

  // 3. Check if entity page exists
  const existingPage = await engine.getPage(slug);
  let action: 'created' | 'updated' | 'skipped';

  if (existingPage) {
    // UPDATE path — add timeline entry
    action = 'updated';
  } else {
    // CREATE path — new entity page
    const title = request.entityName;
    const type = request.entityType;
    const content = generateStubContent(request.entityName, request.entityType, request.context);
    await engine.putPage(slug, {
      title,
      type,
      compiled_truth: content,
      timeline: '',
      frontmatter: {
        created: new Date().toISOString().split('T')[0],
        source: request.sourceSlug,
        tier,
      },
    });
    action = 'created';
  }

  // 4. Add timeline entry
  let timelineAdded = false;
  try {
    await engine.addTimelineEntry(slug, {
      date: new Date().toISOString().split('T')[0],
      content: `Referenced in [${request.sourceSlug}](${request.sourceSlug}) — ${request.context}`,
      source: request.sourceSlug,
    });
    timelineAdded = true;
  } catch {
    // Timeline add failed (page might not support it)
  }

  // 5. Add backlink from entity to source
  let backlinkCreated = false;
  try {
    await engine.addLink(slug, request.sourceSlug, `Entity mention from ${request.sourceSlug}`);
    backlinkCreated = true;
  } catch {
    // Link might already exist
  }

  return {
    slug,
    action,
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
 */
export async function enrichEntities(
  engine: BrainEngine,
  requests: EnrichmentRequest[],
  config?: { throttle?: boolean },
): Promise<EnrichmentResult[]> {
  const results: EnrichmentResult[] = [];
  for (const req of requests) {
    if (config?.throttle !== false) {
      await waitForCapacity({ maxAttempts: 5 }); // shorter timeout for batch items
    }
    const result = await enrichEntity(engine, req);
    results.push(result);
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
): Promise<EnrichmentResult[]> {
  const entities = extractEntities(text);
  if (entities.length === 0) return [];

  const requests: EnrichmentRequest[] = entities.map(e => ({
    entityName: e.name,
    entityType: e.type,
    context: e.context,
    sourceSlug,
  }));

  return enrichEntities(engine, requests);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Count entity mentions across the brain using keyword search. */
async function countMentions(
  engine: BrainEngine,
  entityName: string,
): Promise<{ mentionCount: number; mentionSources: string[] }> {
  try {
    const results = await engine.searchKeyword(entityName, { limit: 100 });
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
  // Pattern: 2-4 capitalized words in sequence
  const namePattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/g;
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
