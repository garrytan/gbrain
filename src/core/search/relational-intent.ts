/**
 * Relational-query parser (typed-edge retrieval, v0.43).
 *
 * Detects queries whose answer is a RELATIONSHIP (an edge between entities)
 * rather than a passage — "who invested in widget-co", "who at acme works on
 * payments", "who introduced me to alice", "what connects fund-a and fund-b",
 * "who is assigned to <task>", "what tasks does <person> have", "who manages
 * <person>", "<person> đang có task gì", "ai phụ trách <task>". The relational
 * recall arm uses the parse to resolve seed entities and walk the typed-edge
 * graph.
 *
 * Two domains are covered: the original VC/startup bank (founded/invested_in/
 * works_at/advises/attended) and a work-management bank (assigned_to/
 * managed_by/owned_by, EN+VI) added for company-knowledge-brain sources (Jira, Asana,
 * or any in-house work tracker). `assigned_to` in particular is the SAME canonical
 * schema-pack edge name all three of those collectors already emit (grep-
 * verified), so this bank is provider-agnostic, not tied to any one tracker —
 * a future tracker that reuses these edge names is covered without a new
 * pattern. Confluence/git-doc sources have no assignee/owner concept and
 * aren't expected to match either bank.
 *
 * Pure module. No DB, no LLM, no async. Detection is regex-only and
 * deterministic, parsed from the ORIGINAL query (never the LLM-expanded
 * variant) so the recall arm stays bit-for-bit reproducible.
 *
 * Precision-first (D4): this returns a CANDIDATE. The arm fires only when a
 * resolvable seed entity is also found (seed resolution lives in
 * relational-recall.ts). Patterns require the relation phrase and the entity
 * to be adjacent, so "who invested TIME in learning Rust" does not match the
 * "who invested in <seed>" pattern.
 *
 * Vocabulary (D2): the default bank covers the common archetypes; a schema
 * pack can extend it with `extraVerbs`. Every emitted link_type is validated
 * against KNOWN_LINK_TYPES so the query side can't drift from what ingest
 * actually produces (see link-extraction.ts:inferLinkType). intro/connects
 * traverse type-agnostically (linkTypes = null) because gbrain has no
 * `introduced`/`knows` edge — any edge touching the seed is the signal.
 *
 * ReDoS: seed captures are length-bounded (`.{1,80}?`) and every pattern is
 * anchored, so there is no catastrophic-backtracking surface.
 *
 * Tested in test/relational-intent.test.ts.
 */

export type RelationalKind = 'who_rel' | 'who_at' | 'connects' | 'intro';
export type RelationDirection = 'in' | 'out' | 'both';

export interface RelationalQuery {
  /** Which archetype matched. */
  kind: RelationalKind;
  /** Raw entity phrases to resolve, in query order. 1 for most, 2 for connects. */
  seeds: string[];
  /** Typed edges to traverse, or null for type-agnostic traversal. */
  linkTypes: string[] | null;
  /** Traversal direction from the seed. */
  direction: RelationDirection;
  /** The matched relation phrase, for telemetry / --explain. */
  relationPhrase: string;
}

/** Schema-pack vocab extension (D2=B). */
export interface RelationVerbSpec {
  /** A regex-source alternation of phrasings, e.g. `acquired|bought`. */
  verb: string;
  /** Edges this verb maps to. MUST be a subset of KNOWN_LINK_TYPES. */
  linkTypes: string[];
  /** Direction from the seed entity named after the verb. */
  direction: RelationDirection;
}

export interface RelationVocab {
  extraVerbs?: RelationVerbSpec[];
}

/**
 * Link types ingest can actually produce (link-extraction.ts + frontmatter
 * map + schema packs). The query parser may only emit a SUBSET of these, so a
 * relation phrase can never traverse an edge type that ingest never writes.
 * `validateVocab` enforces this for pack-supplied verbs.
 */
export const KNOWN_LINK_TYPES: ReadonlySet<string> = new Set([
  'founded',
  'invested_in',
  'advises',
  'works_at',
  'attended',
  'yc_partner',
  'led_round',
  'mentions',
  'image_of',
  'discussed_in',
  'source',
  'related_to',
  'wikilink_basename',
  // v0.43.x — company/work-management domain (task assignment + org
  // hierarchy + ownership), added alongside EN+VI verb patterns below so a
  // brain built from a work-tracker collector can answer
  // "who has what task" / "who manages whom" / "who owns X" relationally,
  // not just via the VC/startup domain the original bank covered.
  'assigned_to',
  'managed_by',
  'owned_by',
  // Open-loop engine (google source kind): thread-page → person-page edges
  // written by loops-extract.ts with link_source 'google-loops'.
  //   owes_to              — the account owner promised something to them
  //   awaiting_reply_from  — the account owner is waiting on them
  'owes_to',
  'awaiting_reply_from',
]);

// Seeds that are pronouns / generic nouns, not entities. If a pattern's seed
// cleans down to one of these, the parse is rejected (precision-first).
const STOPWORD_SEEDS: ReadonlySet<string> = new Set([
  'it', 'that', 'this', 'them', 'these', 'those', 'here', 'there',
  'everyone', 'anyone', 'someone', 'anybody', 'somebody', 'people',
  'things', 'us', 'me', 'him', 'her', 'you', 'who', 'what', 'which',
]);

export interface CompiledPattern {
  re: RegExp;
  kind: RelationalKind;
  linkTypes: string[] | null;
  direction: RelationDirection;
  /** Number of seed capture groups (1, or 2 for connects). */
  seedGroups: 1 | 2;
}

// Bounded seed capture: 1–80 chars, lazy, so the trailing anchor decides the
// boundary without catastrophic backtracking.
const SEED = '(.{1,80}?)';

// ── who_rel verb bank: "who <verb> <seed>" → traverse INTO the seed ──
// Each entry is explicit (linkTypes inline) so there is no second lookup.
const WHO_REL_VERBS: Array<{ verb: string; linkTypes: string[]; direction: RelationDirection }> = [
  { verb: 'invested in|invests in|funded|backed|backs|led the round in|led the seed in|led the series [a-z] in', linkTypes: ['invested_in', 'led_round'], direction: 'in' },
  { verb: 'founded|co-?founded|started', linkTypes: ['founded'], direction: 'in' },
  { verb: 'advises|advised', linkTypes: ['advises'], direction: 'in' },
  { verb: 'works at|worked at|works for', linkTypes: ['works_at'], direction: 'in' },
  { verb: 'attended', linkTypes: ['attended'], direction: 'in' },
  // v0.43.x — work-management domain. Edge direction convention: `task
  // --assigned_to--> person`, `person --managed_by--> manager`,
  // `objective --owned_by--> person` (the direction every work-tracker collector writes).
  // "who is assigned to <task>" walks the TASK's own outgoing edge (the
  // task points at its assignee) → direction 'out', unlike the VC verbs
  // above where the seed is the edge's TARGET.
  { verb: 'is assigned to|assigned to', linkTypes: ['assigned_to'], direction: 'out' },
  { verb: 'manages|is the manager of', linkTypes: ['managed_by'], direction: 'out' },
  { verb: 'owns|is the owner of', linkTypes: ['owned_by'], direction: 'out' },
  // "who reports to <manager>" — seed is the MANAGER (edge target), so this
  // one IS direction 'in', like the VC verbs.
  { verb: 'reports to', linkTypes: ['managed_by'], direction: 'in' },
];

function buildPatterns(vocab?: RelationVocab): CompiledPattern[] {
  const patterns: CompiledPattern[] = [];

  // connects — two seeds, type-agnostic. Most specific, checked first.
  patterns.push({
    re: new RegExp(
      `\\b(?:what|which)\\s+(?:companies?|people|things|entities|deals?)?\\s*(?:connects?|links?|ties? together|is (?:the )?(?:connection|link|relationship) between)\\s+${SEED}\\s+(?:and|&)\\s+${SEED}\\s*\\??$`,
      'i',
    ),
    kind: 'connects', linkTypes: null, direction: 'both', seedGroups: 2,
  });
  patterns.push({
    re: new RegExp(
      `\\bhow\\s+(?:are|is|do|does)\\s+${SEED}\\s+(?:and|&)\\s+${SEED}\\s+(?:connected|related|linked|associated)\\b`,
      'i',
    ),
    kind: 'connects', linkTypes: null, direction: 'both', seedGroups: 2,
  });

  // intro — type-agnostic walk around the named person (no `introduced` edge).
  patterns.push({
    re: new RegExp(
      `\\bwho\\s+(?:introduced|connected|referred)\\s+(?:me|us|him|her|them)\\s+to\\s+${SEED}\\s*\\??$`,
      'i',
    ),
    kind: 'intro', linkTypes: null, direction: 'both', seedGroups: 1,
  });

  // who_at — entity in the middle: "who at acme works on payments".
  patterns.push({
    re: new RegExp(
      `\\bwho\\s+(?:at|from|in)\\s+${SEED}\\s+(?:works? on|works?|leads?|runs?|builds?|owns?|handles?|manages?)\\b`,
      'i',
    ),
    kind: 'who_at', linkTypes: ['works_at'], direction: 'in', seedGroups: 1,
  });

  // who_rel — "who <verb> <seed>".
  for (const v of WHO_REL_VERBS) {
    patterns.push({
      re: new RegExp(`\\bwho\\s+(?:${v.verb})\\s+${SEED}\\s*\\??$`, 'i'),
      kind: 'who_rel', linkTypes: v.linkTypes, direction: v.direction, seedGroups: 1,
    });
  }

  // outgoing variants — "what did <seed> invest in", "where does <seed> work".
  patterns.push({
    re: new RegExp(
      `\\bwhat\\s+(?:companies?|startups?|deals?)?\\s*(?:has|have|did|does)?\\s*${SEED}\\s+(?:invest(?:ed)? in)\\b`,
      'i',
    ),
    kind: 'who_rel', linkTypes: ['invested_in', 'led_round'], direction: 'out', seedGroups: 1,
  });
  patterns.push({
    re: new RegExp(`\\bwhere\\s+(?:does|did|has)\\s+${SEED}\\s+work\\b`, 'i'),
    kind: 'who_rel', linkTypes: ['works_at'], direction: 'out', seedGroups: 1,
  });

  // v0.43.x — work-management domain, outgoing variants (seed in the
  // middle/start, not the "who <verb> <seed>" shape the loop above covers).
  // `assigned_to`/`owned_by` are the canonical schema-pack edge names
  // shared across work-tracker collectors (Jira and
  // Asana mappers both emit `type: 'assigned_to'`) — this is
  // provider-agnostic by construction, not one tracker's vocabulary.
  // The noun alternation below (task/issue/ticket/priority/item) covers the
  // different words each tracker's own UI uses for the same "assigned unit
  // of work" concept, so a future Confluence/git-doc source that reuses
  // `assigned_to` for its own work-item concept is covered too without
  // needing its own pattern.
  patterns.push({
    re: new RegExp(
      `\\bwhat\\s+(?:tasks?|issues?|tickets?|priorities|work\\s*items?)\\s+(?:does|has|is)\\s+${SEED}\\s+(?:have|got|working on|assigned to)\\b`,
      'i',
    ),
    kind: 'who_rel', linkTypes: ['assigned_to'], direction: 'in', seedGroups: 1,
  });
  patterns.push({
    re: new RegExp(`\\bwhat\\s+is\\s+${SEED}\\s+(?:working on|assigned to)\\b`, 'i'),
    kind: 'who_rel', linkTypes: ['assigned_to'], direction: 'in', seedGroups: 1,
  });
  patterns.push({
    re: new RegExp(`\\bwho\\s+does\\s+${SEED}\\s+report\\s+to\\b`, 'i'),
    kind: 'who_rel', linkTypes: ['managed_by'], direction: 'out', seedGroups: 1,
  });
  patterns.push({
    re: new RegExp(`\\bwhat\\s+(?:does|has)\\s+${SEED}\\s+own\\b`, 'i'),
    kind: 'who_rel', linkTypes: ['owned_by'], direction: 'in', seedGroups: 1,
  });

  // v0.43.x — Vietnamese phrasings for the same work-management domain.
  // None of these fit the "who <verb> <seed>" template above (Vietnamese
  // question words don't lead the sentence the way English "who"/"what"
  // does — the subject/seed usually comes first), so they're standalone.
  // No leading `\b` before a seed that may start with a Vietnamese
  // diacritic letter (e.g. "Đ") — JS's `\b` uses an ASCII-only word-char
  // definition, so it can fail to recognize a boundary before non-ASCII
  // letters. The lazy SEED capture plus the required trailing phrase is
  // sufficient to bound the match without it.
  patterns.push({
    re: new RegExp(
      `${SEED}\\s+(?:đang\\s+)?(?:có|làm|phụ trách|đảm nhận)\\s+(?:những\\s+)?(?:task|công việc|việc)\\s+(?:gì|nào)\\s*\\??$`,
      'iu',
    ),
    kind: 'who_rel', linkTypes: ['assigned_to'], direction: 'in', seedGroups: 1,
  });
  patterns.push({
    re: new RegExp(
      `\\bai\\s+(?:đang\\s+)?(?:làm|phụ trách|đảm nhận|được giao)\\s+${SEED}\\s*\\??$`,
      'iu',
    ),
    kind: 'who_rel', linkTypes: ['assigned_to'], direction: 'out', seedGroups: 1,
  });
  patterns.push({
    re: new RegExp(`\\bai\\s+quản lý\\s+${SEED}\\s*\\??$`, 'iu'),
    kind: 'who_rel', linkTypes: ['managed_by'], direction: 'out', seedGroups: 1,
  });
  patterns.push({
    re: new RegExp(`${SEED}\\s+báo cáo cho\\s+ai\\s*\\??$`, 'iu'),
    kind: 'who_rel', linkTypes: ['managed_by'], direction: 'out', seedGroups: 1,
  });
  patterns.push({
    re: new RegExp(`\\bai\\s+báo cáo cho\\s+${SEED}\\s*\\??$`, 'iu'),
    kind: 'who_rel', linkTypes: ['managed_by'], direction: 'in', seedGroups: 1,
  });

  // schema-pack extensions: "who <verb> <seed>" for each extra verb.
  for (const v of vocab?.extraVerbs ?? []) {
    patterns.push({
      re: new RegExp(`\\bwho\\s+(?:${v.verb})\\s+${SEED}\\s*\\??$`, 'i'),
      kind: 'who_rel', linkTypes: v.linkTypes, direction: v.direction, seedGroups: 1,
    });
  }

  return patterns;
}

/** Trim, drop a leading article and surrounding quotes, strip trailing `?`. */
function cleanSeed(raw: string): string {
  return raw
    .trim()
    .replace(/\?+$/, '')
    .replace(/^["'`]|["'`]$/g, '')
    .replace(/^(?:the|a|an)\s+/i, '')
    .trim();
}

function validSeed(s: string): boolean {
  if (s.length === 0 || s.length > 80) return false;
  if (STOPWORD_SEEDS.has(s.toLowerCase())) return false;
  return true;
}

/**
 * Validate that every link_type a vocab emits is one ingest can produce.
 * Throws on an unknown type so a misconfigured schema pack fails loudly at
 * load time rather than silently traversing an edge that never exists.
 */
export function validateVocab(vocab: RelationVocab): void {
  for (const v of vocab.extraVerbs ?? []) {
    for (const lt of v.linkTypes) {
      if (!KNOWN_LINK_TYPES.has(lt)) {
        throw new Error(
          `relational vocab: unknown link_type "${lt}" for verb /${v.verb}/ — must be one of ${[...KNOWN_LINK_TYPES].join(', ')}`,
        );
      }
    }
  }
}

// The default (vocab-less) pattern set, compiled ONCE per process. hybrid.ts
// parses every search's query at least twice (relational-recall.ts for the
// arm, composeFusionLists' `relationalQuery` flag), so rebuilding ~10 RegExp
// objects per call was pure waste. Sharing is safe: every pattern uses the
// `i` flag only (no `g`/`y`), so `exec` carries no lastIndex state between
// calls. A vocab with extra verbs builds a fresh set (uncached) — packs are
// rare and the set depends on their contents.
let defaultPatternsMemo: ReadonlyArray<CompiledPattern> | null = null;

/** The memoized default pattern set (exported so a test can pin identity across calls). */
export function defaultRelationalPatterns(): ReadonlyArray<CompiledPattern> {
  return (defaultPatternsMemo ??= buildPatterns());
}

function patternsFor(vocab?: RelationVocab): ReadonlyArray<CompiledPattern> {
  return vocab?.extraVerbs?.length ? buildPatterns(vocab) : defaultRelationalPatterns();
}

/**
 * Parse a query into a RelationalQuery, or null if it isn't relational.
 * First matching pattern wins (patterns are ordered specific → general).
 */
export function parseRelationalQuery(query: string, vocab?: RelationVocab): RelationalQuery | null {
  if (!query || query.length > 512) return null; // bound work; real queries are short
  const patterns = patternsFor(vocab);

  for (const p of patterns) {
    const m = p.re.exec(query);
    if (!m) continue;

    if (p.seedGroups === 2) {
      const a = cleanSeed(m[1] ?? '');
      const b = cleanSeed(m[2] ?? '');
      if (!validSeed(a) || !validSeed(b)) continue;
      return { kind: p.kind, seeds: [a, b], linkTypes: p.linkTypes, direction: p.direction, relationPhrase: m[0].trim() };
    }

    const seed = cleanSeed(m[1] ?? '');
    if (!validSeed(seed)) continue;
    return { kind: p.kind, seeds: [seed], linkTypes: p.linkTypes, direction: p.direction, relationPhrase: m[0].trim() };
  }

  return null;
}
