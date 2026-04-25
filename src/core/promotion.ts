/**
 * Dream cycle promotion — episodic-to-semantic promotion of recurring
 * timeline patterns.
 *
 * Algorithm: embedding-based clustering via pgvector. Two summaries
 * that mean the same thing ("ai concierge launch prep" vs "ai concierge
 * ready to launch") cluster together if their cosine similarity is above
 * the threshold (default 0.85). The cluster's most-recent member text
 * becomes the canonical pattern. Hash-keyed idempotency in the
 * dream_cycle_promotions table prevents re-promoting the same cluster
 * across runs.
 *
 * Phase 1 is still mostly deterministic. The only LLM-style call is the
 * embedding generation, which is cached in `timeline_summary_embeddings`
 * so re-runs hit the cache and cost nothing.
 *
 * INTEGRATION:
 *   Composes into runCycle as `phase: 'promotion'`. Two callers reach the
 *   engine function below: `runCycle` (autopilot, scheduled) and
 *   `gbrain dream-cycle` CLI (manual one-off with custom config knobs).
 *   Both share runDreamCycle so behavior stays identical.
 *
 * EDGE CASES (documented contract):
 *   - Empty brain (zero pages): returns a clean PromotionReport with
 *     candidates=[], promoted=[], skipped=[].
 *   - Brain with > MAX_PAGES_TO_SCAN pages: scans the first MAX_PAGES_TO_SCAN
 *     by listPages ordering. Older / less recently accessed pages may not
 *     contribute evidence on a single run. Known limitation; full coverage
 *     requires multi-run paging (not yet implemented).
 *   - All candidates below threshold: PromotionReport.promoted=[],
 *     PromotionReport.skipped=[every-candidate], status still 'ok'.
 *   - Target page not found at apply time: skipped with reason
 *     'target page <slug> not found', no exception.
 *   - Target page modified between scoring and apply: last write wins
 *     (no optimistic concurrency check). Acceptable because compiled_truth
 *     is append-only here.
 *   - Embedding API failure: falls back to exact-text grouping for that run
 *     (single-cluster-per-unique-text). Logged, non-fatal.
 *   - similarityThreshold < 0 or > 1: clamped to [0, 1] at clusterByEmbedding.
 */

import { createHash } from 'crypto';
import type { BrainEngine } from './engine.ts';
import type { TimelineEntry } from './types.ts';
import { embedBatch } from './embedding.ts';

// --- Config ---

export interface PromotionConfig {
  /** How far back to look for evidence (days). Default: 14 */
  evidenceWindowDays: number;
  /** Minimum recurrence count to consider a pattern promotable. Default: 3 */
  minRecurrence: number;
  /** Max promotions per run. Default: 10 */
  maxPromotions: number;
  /**
   * Cosine similarity threshold for clustering timeline summaries.
   * Two entries with sim >= threshold cluster together. Default: 0.85.
   * Lower = more aggressive (more entries cluster, less precise canonical).
   * Higher = more conservative (fewer clusters, closer to exact-match).
   */
  similarityThreshold: number;
}

export const DEFAULT_CONFIG: PromotionConfig = {
  evidenceWindowDays: 14,
  minRecurrence: 3,
  maxPromotions: 10,
  similarityThreshold: 0.85,
};

// --- Constants ---

/**
 * Maximum number of pages scanned for evidence in a single cycle.
 * Documented as part of the phase contract — agents should know that
 * brains exceeding this size won't be fully covered by a single run.
 */
export const MAX_PAGES_TO_SCAN = 500;

/**
 * Default minimum hours between consecutive promotion runs. Used by the
 * stamp-file rate limiter in runPhasePromotion (src/core/cycle.ts).
 */
export const DEFAULT_PROMOTION_MIN_HOURS = 23;

/**
 * Returns true if the dream cycle is due to run based on the last-run timestamp.
 *
 * Edge cases:
 *   - lastRunMs = 0 or non-finite → returns true (first run)
 *   - lastRunMs > nowMs (clock skew) → returns true (defensive)
 *   - lastRunMs negative → returns true (treat as first run)
 */
export function shouldRunDreamCycle(
  lastRunMs: number,
  nowMs: number,
  minHours: number = DEFAULT_PROMOTION_MIN_HOURS,
): boolean {
  if (!Number.isFinite(lastRunMs) || lastRunMs <= 0) return true;
  if (nowMs < lastRunMs) return true;
  return (nowMs - lastRunMs) / 3600000 >= minHours;
}

// --- Types ---

export interface Cluster {
  /** Stable hash of the canonical text. Used as cluster_id throughout. */
  cluster_id: string;
  /** Picked representative text (most-recent entry's summary). */
  canonical: string;
  /** All entries in this cluster, regardless of source page. */
  entries: { slug: string; entry: TimelineEntry }[];
}

export interface CandidatePattern {
  /** The cluster's canonical text. */
  pattern: string;
  /** Stable id for the cluster, derived from canonical. */
  cluster_id: string;
  /** How many distinct timeline entries are in the cluster. */
  recurrence: number;
  /** Distinct slugs where this pattern appeared. */
  slugs: string[];
  /** Most recent date seen across the cluster. */
  lastSeen: string;
  /** Score (0-1, higher = more promotable). */
  score: number;
  /** Why it was accepted or rejected. */
  reason: string;
}

export interface PromotionReport {
  /** Stable schema marker. Bumped on breaking changes to this shape. */
  schema_version: '1';
  candidates: CandidatePattern[];
  promoted: CandidatePattern[];
  skipped: CandidatePattern[];
  dryRun: boolean;
  runAt: string;
  evidenceWindowDays: number;
}

// --- Normalization ---

/**
 * Normalize a timeline summary for hashing/embedding.
 * Lowercase, collapse whitespace, strip trailing punctuation.
 * Two summaries with the same normalized text get one embedding cache row.
 */
export function normalizeSummary(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.:;,!?]+$/, '')
    .trim();
}

// --- Sensitive-content filter (best-effort regex, NOT a HIPAA control) ---
//
// What this is: a 5-pattern regex filter that flags text containing
// phone-number-shaped sequences, SSN-shaped sequences, a few ID shapes,
// the literal phrase "patient (id|name|dob|ssn|mrn)", and date-formatted
// MM/DD/YYYY. Used to prevent the dream cycle from promoting recurring
// timeline summaries that contain these specific patterns.
//
// What this is NOT:
//   - A PHI detector. Real PHI redaction requires named-entity recognition
//     (e.g., Microsoft Presidio, healthcare NLP services), context-aware
//     classification, and a model trained on medical text. This regex
//     misses paraphrased PHI ("the patient", "John's medication"), free-form
//     diagnosis text, lab values, and most clinical notes.
//   - A HIPAA control. HIPAA requires administrative + physical + technical
//     safeguards plus audit logging plus BAA agreements; a regex on a
//     promotion candidate is none of these.
//   - A PII detector. The patterns are USA-centric (US phone format, US
//     SSN format, US date format). International equivalents are missed.
//
// Why ship it anyway: it's a low-cost defense-in-depth that catches the
// most-obvious leaks of phone/SSN/ID into compiled_truth — text that has
// no business being promoted to semantic memory. It's strictly better
// than no filter; it's strictly worse than a real PHI engine. Treat as
// belt-and-braces, never as the only gate.

const SENSITIVE_PATTERNS = [
  /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/,           // phone numbers (US format)
  /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/,            // SSN-shaped sequences
  /\b[A-Z]\d{3}[A-Z]{2}\d\b/i,                    // some ID patterns
  /\b(patient\s+(id|name|dob|ssn|mrn))\b/i,       // literal "patient X" phrasing
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/,                // MM/DD/YYYY dates
];

/**
 * Returns true if text matches any of the SENSITIVE_PATTERNS.
 *
 * NAMING NOTE: this function used to be called `looksLikePhi`. That name
 * over-claimed: 5 regex patterns are not PHI detection. The honest name
 * `looksLikePhoneOrIdShape` describes what the function actually checks.
 * `looksLikePhi` is preserved as a deprecated alias to avoid breaking
 * external callers; new code should use the honest name.
 *
 * Use as a defense-in-depth filter only. NOT a real PHI/PII detector.
 * NOT a HIPAA control. See module-level comment above for full scope.
 */
export function looksLikePhoneOrIdShape(text: string): boolean {
  return SENSITIVE_PATTERNS.some(p => p.test(text));
}

/**
 * @deprecated Use `looksLikePhoneOrIdShape` instead. The name `looksLikePhi`
 * over-claimed scope (5 regex patterns are not PHI detection). Kept as an
 * alias for compatibility; will be removed in a future major version.
 */
export const looksLikePhi = looksLikePhoneOrIdShape;

// --- Scoring ---

/**
 * Score a candidate pattern. Returns 0-1.
 *
 * Factors:
 * - recurrence (more = better, max contribution at 6+)
 * - recency (more recent = better)
 * - slug spread (appearing on more pages = better)
 */
export function scoreCandidate(
  recurrence: number,
  lastSeenDate: string,
  slugCount: number,
): number {
  // Recurrence factor: 0.5 at min (3), 1.0 at 6+
  const recFactor = Math.min(recurrence / 6, 1.0);

  // Recency factor: 1.0 if today, decays over 14 days
  const daysSinceLast = Math.max(0,
    (Date.now() - new Date(lastSeenDate).getTime()) / (1000 * 60 * 60 * 24),
  );
  const recencyFactor = Math.max(0, 1 - daysSinceLast / 14);

  // Spread factor: 0.5 for 1 slug, 1.0 for 3+
  const spreadFactor = Math.min(slugCount / 3, 1.0) * 0.5 + 0.5;

  return recFactor * 0.5 + recencyFactor * 0.3 + spreadFactor * 0.2;
}

// --- Idempotency helper ---

/**
 * Compute the stable promotion hash for a (cluster_id, target_slug) tuple.
 * Used as the primary key in dream_cycle_promotions. Same inputs always
 * produce the same hash, so a re-run is a clean no-op (existence check
 * skips the page write; INSERT ... ON CONFLICT DO NOTHING short-circuits
 * the row insert against concurrent races).
 *
 * Keyed on cluster_id (not raw pattern text) so the hash is stable across
 * algorithm tweaks: re-running with the same brain content produces the
 * same canonical text → same cluster_id → same hash.
 */
export function promotionHash(cluster_id: string, targetSlug: string): string {
  return createHash('sha256')
    .update(`${cluster_id}\x00${targetSlug}`)
    .digest('hex');
}

// --- Embedding helpers ---

function summaryHashOf(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Cosine similarity between two embedding vectors. Both inputs must have
 * the same length.
 *
 * Edge cases:
 *   - Either vector is the zero vector: returns 0 (no similarity).
 *   - Vectors of different lengths: throws (programmer error).
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: length mismatch ${a.length} vs ${b.length}`);
  }
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Look up cached embeddings for a list of normalized summaries; embed any
 * cache misses; cache the new ones; return a Map<normalized, Float32Array>
 * covering every input.
 *
 * Uses BrainEngine.executeRaw because timeline_summary_embeddings is a
 * promotion-specific table, not part of the general BrainEngine contract.
 *
 * Edge cases:
 *   - Empty input: returns empty Map, no DB or API calls.
 *   - Embedding API failure: thrown, caller handles fallback.
 *   - Some cached, some not: only cache misses get embedded.
 */
async function getOrComputeEmbeddings(
  engine: BrainEngine,
  normalizedTexts: string[],
): Promise<Map<string, Float32Array>> {
  const result = new Map<string, Float32Array>();
  if (normalizedTexts.length === 0) return result;

  const uniqueTexts = [...new Set(normalizedTexts)];
  const hashOf = new Map(uniqueTexts.map(t => [t, summaryHashOf(t)]));

  // Batch lookup
  const hashes = Array.from(hashOf.values());
  type CachedRow = { summary_hash: string; summary_text: string; embedding: string };
  const cached = await engine.executeRaw<CachedRow>(
    `SELECT summary_hash, summary_text, embedding::text AS embedding
     FROM timeline_summary_embeddings
     WHERE summary_hash = ANY($1::text[])`,
    [hashes],
  );

  const cachedTexts = new Set<string>();
  for (const row of cached) {
    const arr = String(row.embedding).replace(/[\[\]]/g, '').split(',').map(parseFloat);
    result.set(row.summary_text, new Float32Array(arr));
    cachedTexts.add(row.summary_text);
  }

  const toEmbed = uniqueTexts.filter(t => !cachedTexts.has(t));
  if (toEmbed.length === 0) return result;

  const fresh = await embedBatch(toEmbed);

  // Insert into cache (one round-trip per text — small N, acceptable).
  // ON CONFLICT DO NOTHING handles concurrent runs racing on the same text.
  for (let i = 0; i < toEmbed.length; i++) {
    const text = toEmbed[i];
    const emb = fresh[i];
    const vecStr = '[' + Array.from(emb).join(',') + ']';
    try {
      await engine.executeRaw(
        `INSERT INTO timeline_summary_embeddings (summary_hash, summary_text, embedding)
         VALUES ($1, $2, $3::vector)
         ON CONFLICT (summary_hash) DO NOTHING`,
        [summaryHashOf(text), text, vecStr],
      );
    } catch (e) {
      console.warn(
        '[promotion] could not cache embedding for "%s": %s',
        text.slice(0, 40),
        e instanceof Error ? e.message : String(e),
      );
    }
    result.set(text, emb);
  }

  return result;
}

// --- Clustering ---

/**
 * Cluster entries by cosine similarity using union-find. Two entries with
 * embeddings >= threshold join the same cluster transitively (A~B and B~C
 * means A, B, C are all one cluster). The cluster's canonical is the
 * most-recent entry's original (un-normalized) summary text.
 *
 * Time complexity: O(n²) pairwise comparison. Acceptable for n up to a
 * few thousand (a 14-day window on a 500-page brain typically yields
 * 1000-3000 entries). For larger n, switch to ANN via pgvector ivfflat.
 *
 * Edge cases:
 *   - threshold < 0 or > 1: clamped to [0, 1].
 *   - Empty input: returns empty array.
 *   - Single entry: returns one cluster of size 1.
 *   - All identical embeddings: returns one cluster.
 */
export function clusterByEmbedding(
  entries: { slug: string; entry: TimelineEntry; embedding: Float32Array }[],
  threshold: number,
): Cluster[] {
  if (entries.length === 0) return [];
  const t = Math.max(0, Math.min(1, threshold));

  // Union-find with path compression
  const parent = entries.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    while (parent[i] !== r) {
      const next = parent[i];
      parent[i] = r;
      i = next;
    }
    return r;
  };
  const union = (i: number, j: number) => {
    const ri = find(i), rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  };

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (cosineSimilarity(entries[i].embedding, entries[j].embedding) >= t) {
        union(i, j);
      }
    }
  }

  // Group by root
  const groups = new Map<number, typeof entries>();
  for (let i = 0; i < entries.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(entries[i]);
  }

  // Build clusters: canonical = most-recent member's original summary
  const clusters: Cluster[] = [];
  for (const members of groups.values()) {
    const sorted = members.slice().sort((a, b) =>
      String(b.entry.date).localeCompare(String(a.entry.date)),
    );
    const canonical = sorted[0].entry.summary;
    const cluster_id = createHash('sha256').update(normalizeSummary(canonical)).digest('hex').slice(0, 16);
    clusters.push({
      cluster_id,
      canonical,
      entries: members.map(m => ({ slug: m.slug, entry: m.entry })),
    });
  }
  return clusters;
}

// --- Core logic ---

/**
 * Collect timeline evidence from the last N days across all pages, embed
 * each unique summary, cluster by cosine similarity, return clusters.
 *
 * Edge cases:
 *   - Empty brain (zero pages): returns empty array.
 *   - Brain with > MAX_PAGES_TO_SCAN pages: scans only the first slice
 *     as ordered by listPages.
 *   - Page with broken/malformed timeline: page is skipped, error logged.
 *   - Embedding API failure: caught at this level; falls back to exact-text
 *     grouping (each unique normalized text becomes its own cluster).
 */
export async function collectEvidence(
  engine: BrainEngine,
  config: PromotionConfig,
  onProgress?: (phase: 'pages' | 'embed', done: number, total: number) => void,
): Promise<Cluster[]> {
  const since = new Date(Date.now() - config.evidenceWindowDays * 86400000);
  const sinceStr = since.toISOString().slice(0, 10);

  const pages = await engine.listPages({ limit: MAX_PAGES_TO_SCAN });

  // Collect raw entries from every page's timeline within the window.
  // Progress reported per-page so a 500-page brain doesn't go silent for
  // minutes while we walk timelines.
  const rawEntries: { slug: string; entry: TimelineEntry; normalized: string }[] = [];
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    try {
      const timeline = await engine.getTimeline(page.slug, {
        after: sinceStr,
        limit: 100,
      });
      for (const entry of timeline) {
        const normalized = normalizeSummary(entry.summary);
        if (normalized) {
          rawEntries.push({ slug: page.slug, entry, normalized });
        }
      }
    } catch (e) {
      console.warn(
        '[promotion.collectEvidence] skipping page %s with broken timeline: %s',
        page.slug,
        e instanceof Error ? e.message : String(e),
      );
    }
    onProgress?.('pages', i + 1, pages.length);
  }

  if (rawEntries.length === 0) return [];

  // Embed unique normalized texts (cache-aware), then cluster.
  let embeddings: Map<string, Float32Array>;
  try {
    embeddings = await getOrComputeEmbeddings(
      engine,
      rawEntries.map(r => r.normalized),
    );
  } catch (e) {
    console.warn(
      '[promotion.collectEvidence] embedding lookup failed; falling back to exact-text grouping: %s',
      e instanceof Error ? e.message : String(e),
    );
    return fallbackExactTextClusters(rawEntries);
  }

  const withEmbeddings = rawEntries
    .map(r => {
      const emb = embeddings.get(r.normalized);
      return emb ? { slug: r.slug, entry: r.entry, embedding: emb } : null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (withEmbeddings.length === 0) return fallbackExactTextClusters(rawEntries);

  return clusterByEmbedding(withEmbeddings, config.similarityThreshold);
}

/**
 * Fallback when embeddings can't be computed: each unique normalized text
 * becomes its own cluster (the v0.20 exact-text behavior).
 */
function fallbackExactTextClusters(
  rawEntries: { slug: string; entry: TimelineEntry; normalized: string }[],
): Cluster[] {
  const groups = new Map<string, { canonical: string; entries: { slug: string; entry: TimelineEntry }[] }>();
  for (const r of rawEntries) {
    if (!groups.has(r.normalized)) {
      groups.set(r.normalized, { canonical: r.entry.summary, entries: [] });
    }
    const group = groups.get(r.normalized)!;
    group.entries.push({ slug: r.slug, entry: r.entry });
    // Update canonical to the most recent member's summary
    if (String(r.entry.date) > String(group.entries[0]?.entry.date ?? '')) {
      group.canonical = r.entry.summary;
    }
  }
  return Array.from(groups.entries()).map(([normalized, g]) => ({
    cluster_id: createHash('sha256').update(normalized).digest('hex').slice(0, 16),
    canonical: g.canonical,
    entries: g.entries,
  }));
}

/**
 * Score clusters and return ranked candidates. One cluster → one candidate.
 */
export function rankCandidates(
  clusters: Cluster[],
  config: PromotionConfig,
): CandidatePattern[] {
  const candidates: CandidatePattern[] = [];

  for (const cluster of clusters) {
    const recurrence = cluster.entries.length;
    const uniqueSlugs = [...new Set(cluster.entries.map(e => e.slug))];
    const dates = cluster.entries.map(e => String(e.entry.date)).sort();
    const lastSeen = dates[dates.length - 1];

    const base = {
      pattern: cluster.canonical,
      cluster_id: cluster.cluster_id,
      recurrence,
      slugs: uniqueSlugs,
      lastSeen,
    };

    if (recurrence < config.minRecurrence) {
      candidates.push({
        ...base,
        score: 0,
        reason: `below threshold (${recurrence} < ${config.minRecurrence})`,
      });
      continue;
    }

    if (looksLikePhoneOrIdShape(cluster.canonical)) {
      candidates.push({
        ...base,
        score: 0,
        reason: 'rejected: possible sensitive content (regex filter)',
      });
      continue;
    }

    const score = scoreCandidate(recurrence, lastSeen, uniqueSlugs.length);
    candidates.push({
      ...base,
      score,
      reason: score >= 0.4 ? 'promotable' : `low score (${score.toFixed(2)})`,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

/**
 * Apply promotions. For each promotable candidate, append a semantic note
 * to the most relevant page's compiled_truth and add a timeline entry.
 *
 * Note on idempotency: a SHA256(cluster_id || target_slug) hash is
 * checked against dream_cycle_promotions before each apply. If the
 * tuple already exists, the candidate is skipped. After a successful
 * write, the hash is recorded with INSERT ... ON CONFLICT DO NOTHING
 * (belt-and-braces against concurrent races). A re-run with identical
 * clusters produces zero duplicate writes.
 *
 * Returns the list of actually promoted candidates.
 */
export async function applyPromotions(
  engine: BrainEngine,
  promotable: CandidatePattern[],
  config: PromotionConfig,
  dryRun: boolean,
): Promise<{ promoted: CandidatePattern[]; skipped: CandidatePattern[] }> {
  const promoted: CandidatePattern[] = [];
  const skipped: CandidatePattern[] = [];
  let applied = 0;

  for (const candidate of promotable) {
    if (applied >= config.maxPromotions) {
      skipped.push({ ...candidate, reason: 'max promotions reached' });
      continue;
    }

    // Pick the first slug as the target (most recent entry's page).
    const targetSlug = candidate.slugs[0];
    const hash = promotionHash(candidate.cluster_id, targetSlug);

    if (dryRun) {
      promoted.push({ ...candidate, reason: `[dry-run] would promote to ${targetSlug}` });
      applied++;
      continue;
    }

    try {
      // Idempotency check: was this (cluster, target) tuple already promoted?
      const existing = await engine.executeRaw<{ promoted_at: string }>(
        'SELECT promoted_at FROM dream_cycle_promotions WHERE pattern_hash = $1 LIMIT 1',
        [hash],
      );
      if (existing.length > 0) {
        const promotedDate = String(existing[0].promoted_at).slice(0, 10);
        skipped.push({
          ...candidate,
          reason: `already promoted on ${promotedDate}`,
        });
        continue;
      }

      const page = await engine.getPage(targetSlug);
      if (!page) {
        skipped.push({ ...candidate, reason: `target page ${targetSlug} not found` });
        continue;
      }

      const today = new Date().toISOString().slice(0, 10);

      // Append semantic note to compiled_truth.
      const semanticNote = `\n\n---\n**Semantic note** (dream-cycle ${today}, cluster ${candidate.cluster_id}): Recurring pattern detected across ${candidate.recurrence} entries. ${candidate.pattern}`;
      const updatedTruth = page.compiled_truth + semanticNote;

      await engine.putPage(targetSlug, {
        type: page.type,
        title: page.title,
        compiled_truth: updatedTruth,
        frontmatter: page.frontmatter,
      });

      await engine.addTimelineEntry(targetSlug, {
        date: today,
        source: 'dream-cycle',
        summary: `Promoted recurring pattern (${candidate.recurrence} occurrences) to semantic memory`,
        detail: `Pattern: "${candidate.pattern}". Cluster: ${candidate.cluster_id}. Score: ${candidate.score.toFixed(2)}. Spread across: ${candidate.slugs.join(', ')}`,
      });

      // Record the promotion. ON CONFLICT DO NOTHING is belt-and-braces:
      // the SELECT above already gates this branch, but a concurrent run
      // could race; the conflict clause makes the second writer a no-op.
      await engine.executeRaw(
        `INSERT INTO dream_cycle_promotions
           (pattern_hash, cluster_id, target_slug, pattern_text, recurrence, score)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (pattern_hash) DO NOTHING`,
        [hash, candidate.cluster_id, targetSlug, candidate.pattern, candidate.recurrence, candidate.score],
      );

      promoted.push({ ...candidate, reason: `promoted to ${targetSlug}` });
      applied++;
    } catch (e) {
      skipped.push({
        ...candidate,
        reason: `error: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  return { promoted, skipped };
}

/**
 * Run the full dream cycle. Returns a structured report.
 *
 * @param onProgress  Optional callback invoked with (phase, done, total) for
 *                    bulk operations. The runCycle phase wrapper uses this
 *                    to feed the standard progress reporter.
 */
export async function runDreamCycle(
  engine: BrainEngine,
  config: Partial<PromotionConfig> = {},
  dryRun: boolean = true,
  onProgress?: (phase: 'pages' | 'embed', done: number, total: number) => void,
): Promise<PromotionReport> {
  const fullConfig = { ...DEFAULT_CONFIG, ...config };
  const runAt = new Date().toISOString();

  const clusters = await collectEvidence(engine, fullConfig, onProgress);
  const candidates = rankCandidates(clusters, fullConfig);

  const promotable = candidates.filter(c => c.reason === 'promotable');
  const rejected = candidates.filter(c => c.reason !== 'promotable');

  const { promoted, skipped } = await applyPromotions(engine, promotable, fullConfig, dryRun);

  return {
    schema_version: '1',
    candidates,
    promoted,
    skipped: [...rejected, ...skipped],
    dryRun,
    runAt,
    evidenceWindowDays: fullConfig.evidenceWindowDays,
  };
}
