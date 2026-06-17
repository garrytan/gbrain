/**
 * v0.43 (#2095) — push-based context: the brain VOLUNTEERS relevant pages
 * from a rolling conversation window instead of waiting to be asked.
 *
 *   window text ─ parseWindow() ─→ turns[] ─ extractCandidatesFromWindow()
 *        │                                       (recency + frequency +
 *        │                                        user-role weights)
 *        ▼
 *   resolveEntitiesToPointers(sourceIds[])    alias 0.9 / title 0.8 /
 *        │                                    slug-suffix 0.6 (+0.05 boost
 *        ▼                                    for ≥2-turn or newest-turn
 *   gate min_confidence (default 0.7) →       mentions)
 *   suppression (slug-only — windowing) →
 *   cap (3 default / 5 max)
 *
 * Zero-LLM, deterministic, precision-biased: push noise is worse than pull
 * silence (#2095). At the default gate, slug-suffix matches (0.6+0.05 < 0.7)
 * never volunteer — they need an explicit lower min_confidence.
 *
 * Consumed by three channels: the volunteer_context op, the retrieval-reflex
 * window path, and `gbrain watch`. Event logging lives in
 * volunteer-events.ts; usage stats here derive "used" from
 * pages.last_retrieved_at — APPROXIMATE by design (the 5-min last-retrieved
 * throttle causes false negatives; unrelated reads cause false positives).
 */

import type { BrainEngine } from '../engine.ts';
import { normalizeAlias } from '../search/alias-normalize.ts';
import {
  extractCandidatesFromWindow,
  type WindowTurn,
  type WindowEntityCandidate,
} from './entity-salience.ts';
import {
  resolveEntitiesToPointers,
  ARM_CONFIDENCE,
  type ResolveArm,
} from './retrieval-reflex.ts';

export const VOLUNTEER_DEFAULT_MAX_PAGES = 3;
export const VOLUNTEER_MAX_PAGES_CAP = 5;
export const VOLUNTEER_DEFAULT_MIN_CONFIDENCE = 0.7;
/** Deterministic boost for ≥2-turn or newest-turn mentions. */
export const VOLUNTEER_SALIENCE_BOOST = 0.05;

export interface VolunteeredPage {
  slug: string;
  source_id: string;
  display: string;
  confidence: number;
  arm: ResolveArm;
  /** Deterministic template string — never raw conversation text. */
  rationale: string;
  synopsis: string;
}

export interface VolunteerOpts {
  /** Resolved source scope (federated array > scalar — sourceScopeOpts shape). */
  sourceIds: string[];
  /** Prior context (already-surfaced pointers/pages) for slug-only suppression. */
  priorContext?: string;
  /**
   * Slugs to skip BEFORE the confidence gate and the maxPages cap (O(1)
   * membership). `gbrain watch` passes its session-dedupe set here — a
   * post-call filter would let a recurring already-pushed entity consume cap
   * slots every turn and starve new pages behind it (red-team finding).
   */
  excludeSlugs?: ReadonlySet<string>;
  maxPages?: number;
  minConfidence?: number;
}

/** Shared wire protocol for window turns — watch.ts imports this so the two
 * channels can never desynchronize on the prefix grammar. */
export const TURN_PREFIX_RE = /^(user|assistant)\s*:\s?(.*)$/i;

/**
 * Lenient window parser: `user:` / `assistant:` line prefixes start a new
 * turn (oldest → newest); unprefixed lines continue the current turn; input
 * with no prefixes at all is ONE user turn (so `echo "..." | volunteer-context`
 * just works). CRLF-tolerant. Empty/whitespace input → [].
 */
export function parseWindow(text: string): WindowTurn[] {
  if (!text || !text.trim()) return [];
  const turns: WindowTurn[] = [];
  let current: WindowTurn | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const m = TURN_PREFIX_RE.exec(rawLine);
    if (m) {
      if (current) turns.push(current);
      current = { role: m[1].toLowerCase() as WindowTurn['role'], text: m[2] ?? '' };
    } else if (current) {
      current.text += (current.text ? '\n' : '') + rawLine;
    } else if (rawLine.trim()) {
      // No prefix seen yet — accumulate into an implicit user turn.
      current = { role: 'user', text: rawLine };
    }
  }
  if (current) turns.push(current);
  // Trim trailing whitespace-only turn bodies.
  return turns
    .map((t) => ({ role: t.role, text: t.text.trim() }))
    .filter((t) => t.text.length > 0);
}

function clampMaxPages(n: number | undefined): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 1) return VOLUNTEER_DEFAULT_MAX_PAGES;
  return Math.min(Math.floor(n), VOLUNTEER_MAX_PAGES_CAP);
}

function rationaleFor(arm: ResolveArm, display: string, c: WindowEntityCandidate | undefined, windowSize: number): string {
  const armText =
    arm === 'alias' ? `alias match "${display}"`
    : arm === 'title' ? `exact title match "${display}"`
    : `slug match "${display}"`;
  if (!c) return armText;
  const parts = [armText];
  if (c.occurrences >= 2) parts.push(`mentioned in ${c.occurrences} of last ${windowSize} turns`);
  else if (c.inNewestTurn) parts.push('mentioned in the newest turn');
  if (!c.userMention) parts.push('assistant-introduced');
  return parts.join('; ');
}

/**
 * Volunteer confidence-gated pages for a conversation window. Pure read —
 * event logging is the CALLER's job (through the volunteer-events sink).
 * Non-relational, zero-LLM; returns [] when nothing clears the gate.
 */
export async function volunteerContext(
  engine: BrainEngine,
  turns: WindowTurn[],
  opts: VolunteerOpts,
): Promise<VolunteeredPage[]> {
  if (!turns.length || !opts.sourceIds?.length) return [];
  const candidates = extractCandidatesFromWindow(turns);
  if (!candidates.length) return [];
  const byNorm = new Map<string, WindowEntityCandidate>();
  for (const c of candidates) {
    const norm = normalizeAlias(c.query);
    if (norm && !byNorm.has(norm)) byNorm.set(norm, c);
  }

  const maxPages = clampMaxPages(opts.maxPages);
  const minConfidence =
    typeof opts.minConfidence === 'number' && opts.minConfidence >= 0 && opts.minConfidence <= 1
      ? opts.minConfidence
      : VOLUNTEER_DEFAULT_MIN_CONFIDENCE;

  // Resolve up to the hard cap so the confidence gate sees the full pool —
  // a gated-out alias hit must not shadow a passing title hit behind it.
  const block = await resolveEntitiesToPointers(engine, opts.sourceIds[0], candidates, {
    sourceIds: opts.sourceIds,
    priorContextText: opts.priorContext,
    suppression: 'slug-only',
    maxPointers: VOLUNTEER_MAX_PAGES_CAP * 2,
  });
  if (!block) return [];

  const out: VolunteeredPage[] = [];
  for (const p of block.pointers) {
    if (opts.excludeSlugs?.has(p.slug)) continue; // before gate + cap — see VolunteerOpts
    // matchedNorm is the resolver's provenance join-key (the candidate that
    // resolved the pointer); display-based lookup is the fallback for the
    // rare suffix rows where provenance couldn't be recovered.
    const cand = (p.matchedNorm ? byNorm.get(p.matchedNorm) : undefined) ?? byNorm.get(normalizeAlias(p.display));
    const boost = cand && (cand.occurrences >= 2 || cand.inNewestTurn) ? VOLUNTEER_SALIENCE_BOOST : 0;
    const confidence = Math.min(0.99, ARM_CONFIDENCE[p.arm] + boost);
    if (confidence < minConfidence) continue;
    out.push({
      slug: p.slug,
      source_id: p.source_id,
      display: p.display,
      confidence,
      arm: p.arm,
      rationale: rationaleFor(p.arm, p.display, cand, turns.length),
      synopsis: p.synopsis,
    });
    if (out.length >= maxPages) break;
  }
  return out;
}

/**
 * Canonical human rendering of one volunteered page — shared by
 * `gbrain volunteer-context` (cli.ts formatResult) and `gbrain watch` so the
 * two surfaces can't drift.
 */
export function formatVolunteeredPage(p: VolunteeredPage): string {
  return (
    `${p.display} → ${p.slug} (${p.confidence.toFixed(2)}, ${p.arm}) — ${p.rationale}` +
    (p.synopsis ? `\n    ${p.synopsis}` : '')
  );
}

// ── Usage stats (the feedback loop) ──────────────────────────────────────

export interface VolunteerArmStats {
  match_arm: string;
  channel: string;
  volunteered: number;
  used: number;
  /** used / volunteered, 0 when nothing volunteered. */
  precision: number;
}

export interface VolunteerUsageStats {
  days: number;
  /** The join is approximate — see the note (false +/- documented in #2095 D9). */
  approximate: true;
  note: string;
  total_volunteered: number;
  total_used: number;
  by_arm: VolunteerArmStats[];
}

export const VOLUNTEER_STATS_NOTE =
  'approximate: "used" = pages.last_retrieved_at > volunteered_at. The 5-min ' +
  'last-retrieved throttle causes false negatives; unrelated reads of the same ' +
  'page cause false positives.';

/**
 * Per-arm/channel precision over the last N days, source-scoped. Read-only;
 * returns zeroed stats on pre-v117 brains (no table).
 */
export async function volunteerUsageStats(
  engine: BrainEngine,
  sourceIds: string[],
  days = 30,
): Promise<VolunteerUsageStats> {
  const safeDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 30;
  let rows: Array<{ match_arm: string; channel: string; volunteered: string | number; used: string | number }> = [];
  try {
    rows = await engine.executeRaw(
      `SELECT e.match_arm, e.channel,
              count(*)::text AS volunteered,
              count(*) FILTER (WHERE p.last_retrieved_at > e.volunteered_at)::text AS used
         FROM context_volunteer_events e
         LEFT JOIN pages p
           ON p.source_id = e.source_id AND p.slug = e.slug AND p.deleted_at IS NULL
        WHERE e.source_id = ANY($1::text[])
          AND e.volunteered_at > now() - ($2 || ' days')::interval
        GROUP BY e.match_arm, e.channel
        ORDER BY e.match_arm, e.channel`,
      [sourceIds, String(safeDays)],
    );
  } catch {
    rows = []; // pre-v117 brain — table doesn't exist yet
  }
  const by_arm: VolunteerArmStats[] = rows.map((r) => {
    const volunteered = Number(r.volunteered);
    const used = Number(r.used);
    return {
      match_arm: r.match_arm,
      channel: r.channel,
      volunteered,
      used,
      precision: volunteered > 0 ? Number((used / volunteered).toFixed(3)) : 0,
    };
  });
  return {
    days: safeDays,
    approximate: true,
    note: VOLUNTEER_STATS_NOTE,
    total_volunteered: by_arm.reduce((s, a) => s + a.volunteered, 0),
    total_used: by_arm.reduce((s, a) => s + a.used, 0),
    by_arm,
  };
}
