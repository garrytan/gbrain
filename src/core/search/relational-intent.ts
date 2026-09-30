/**
 * Relational-query parser (typed-edge retrieval, v0.43).
 *
 * Detects queries whose answer is a RELATIONSHIP (an edge between entities)
 * rather than a passage — "who invested in widget-co", "who at acme works on
 * payments", "who introduced me to alice", "what connects fund-a and fund-b".
 * The relational recall arm uses the parse to resolve seed entities and walk
 * the typed-edge graph.
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

// ── Relation lexicon ──
// One row per edge family. The query frames below combine each row's
// phrasings, so a new synonym lands in every frame at once:
//   inVerbs     "who <verb> X", "which funds <verb> X", "people who <verb> X"
//   agentNouns  "X's <noun>", "<noun> of|in|at... X"   (incoming: X is the target)
//   outVerbs    "what (companies) did X <verb>"          (outgoing: X is the source)
//   outWho      "who does X <verb>"                      (outgoing)
//   outNouns    "X's <noun>"                             (outgoing)
interface RelationLexicon {
  linkTypes: string[];
  inVerbs: string;
  agentNouns: string;
  nounPreps: string;
  outVerbs?: string;
  outWho?: string;
  outNouns?: string;
}

const ROUND = '(?:the\\s+)?(?:[a-z0-9-]+\\s+)?(?:round|seed|series\\s+[a-z])';

const RELATIONS: RelationLexicon[] = [
  {
    linkTypes: ['invested_in', 'led_round'],
    inVerbs: `invested in|invests in|invest in|investing in|funded|funds|fund|funding|backed|backs|back|backing|financed|finances|finance|put money (?:into|in)|led ${ROUND} (?:in|for|of|at)|participated in ${ROUND} (?:of|for|in|at)`,
    agentNouns: 'investors?|backers?|funders?|financiers?|shareholders?',
    nounPreps: 'in|of|behind|for|into|at',
    outVerbs: 'invest(?:ed)? in|backed|back|funded|fund|financed|finance',
    outWho: 'invest in|back|fund|finance',
    outNouns: 'portfolio(?:\\s+companies)?|investments',
  },
  {
    linkTypes: ['founded'],
    inVerbs: 'founded|co-?founded|started|founds',
    agentNouns: 'founders?|co-?founders?|founding team',
    nounPreps: 'of|at|behind',
    outVerbs: 'found|co-?found|start|founded|co-?founded|started',
  },
  {
    linkTypes: ['works_at'],
    inVerbs: 'works at|worked at|works for|worked for|work at|work for|working at|working for|employed (?:at|by)|on the team at',
    agentNouns: 'employees?|staff(?:ers)?|team members?',
    nounPreps: 'at|of|in',
    outWho: 'work for|work at|worked for|worked at',
    outNouns: 'employer',
  },
  {
    linkTypes: ['advises'],
    inVerbs: 'advises|advised|advise|advising|(?:sits|sat|serves|served|is) on the advisory board (?:of|at|for)|on the advisory board (?:of|at|for)',
    agentNouns: 'advis[eo]rs?|advisory board(?:\\s+members)?',
    nounPreps: 'to|of|for|at',
    outVerbs: 'advise',
    outWho: 'advise',
  },
  {
    linkTypes: ['attended'],
    inVerbs: 'attended',
    agentNouns: 'attendees',
    nounPreps: 'of|at',
  },
];

// Leading request words a noun-phrase query may carry ("who are X's investors",
// "list the founders of X"). Anchored at the start so the noun phrase has to BE
// the query, not a fragment of a longer content question.
const ASK = "(?:(?:who|what)(?:'s|’s|\\s+(?:are|is|were|was))\\s+|(?:list|show|name|find|give)(?:\\s+me)?\\s+(?:all\\s+)?|tell me\\s+)?(?:the\\s+|all\\s+)?";
const POSS = "(?:'s|’s|')";
const AUX = "(?:'s|’s|\\s+has|\\s+have|\\s+had|\\s+did|\\s+is|\\s+are|\\s+was|\\s+were)?";
const HEADS = 'people|persons|individuals|folks|investors|firms|funds|vcs|angels|companies|founders|employees|advis[eo]rs|partners|entities';
const END = '\\s*[?.!]?$';

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
  for (const re of [
    `^(?:what(?:'s|’s|\\s+is|\\s+was)\\s+)?(?:the\\s+)?(?:relationship|connection|link|relation|tie)\\s+between\\s+${SEED}\\s+(?:and|&)\\s+${SEED}${END}`,
    `\\bhow\\s+(?:is|was|are|were)\\s+${SEED}\\s+(?:connected|related|linked|tied)\\s+(?:to|with)\\s+${SEED}${END}`,
    `^what\\s+do(?:es)?\\s+${SEED}\\s+(?:and|&)\\s+${SEED}\\s+have in common${END}`,
    `\\bhow\\s+do(?:es)?\\s+${SEED}\\s+(?:and|&)\\s+${SEED}\\s+know each other${END}`,
  ]) {
    patterns.push({ re: new RegExp(re, 'i'), kind: 'connects', linkTypes: null, direction: 'both', seedGroups: 2 });
  }

  // intro — type-agnostic walk around the named person (no `introduced` edge).
  patterns.push({
    re: new RegExp(
      `\\bwho\\s+(?:introduced|connected|referred)\\s+(?:me|us|him|her|them)\\s+to\\s+${SEED}\\s*\\??$`,
      'i',
    ),
    kind: 'intro', linkTypes: null, direction: 'both', seedGroups: 1,
  });
  for (const re of [
    `\\bwho\\s+(?:can|could|would|might)\\s+(?:introduce|intro|connect|refer)\\s+(?:me|us)\\s+(?:to|with)\\s+${SEED}${END}`,
    `^who\\s+knows\\s+${SEED}${END}`,
  ]) {
    patterns.push({ re: new RegExp(re, 'i'), kind: 'intro', linkTypes: null, direction: 'both', seedGroups: 1 });
  }

  // who_at — entity in the middle: "who at acme works on payments".
  patterns.push({
    re: new RegExp(
      `\\bwho\\s+(?:at|from|in)\\s+${SEED}\\s+(?:works? on|works?|leads?|runs?|builds?|owns?|handles?|manages?)\\b`,
      'i',
    ),
    kind: 'who_at', linkTypes: ['works_at'], direction: 'in', seedGroups: 1,
  });

  for (const r of RELATIONS) {
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- sources are this module's constant RELATIONS lexicon (default patterns are memoized); query text is only matched against them, never compiled
    const out = (re: string) => patterns.push({ re: new RegExp(re, 'i'), kind: 'who_rel', linkTypes: r.linkTypes, direction: 'out', seedGroups: 1 });
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- same constant vocabulary as `out` above
    const inc = (re: string) => patterns.push({ re: new RegExp(re, 'i'), kind: 'who_rel', linkTypes: r.linkTypes, direction: 'in', seedGroups: 1 });
    // Outgoing first: "which companies has X backed" must not read as incoming.
    if (r.outVerbs) out(`^(?:what|which)\\s+(?:companies|startups|deals|businesses|firms|organizations)?\\s*(?:has|have|did|does|do)\\s+${SEED}\\s+(?:${r.outVerbs})${END}`);
    if (r.outWho) out(`^who\\s+(?:does|did|has)\\s+${SEED}\\s+(?:${r.outWho})${END}`);
    if (r.outNouns) out(`^${ASK}${SEED}${POSS}\\s+(?:${r.outNouns})${END}`);
    // Incoming.
    inc(`\\bwho${AUX}\\s+(?:${r.inVerbs})\\s+${SEED}${END}`);
    inc(`^(?:which|what)\\s+(?:${HEADS})\\s+(?:(?:have|has|had|did|are|were|is)\\s+)?(?:${r.inVerbs})\\s+${SEED}${END}`);
    inc(`^(?:the\\s+)?(?:${HEADS}|those|everyone|anyone)\\s+(?:who|that)\\s+(?:(?:have|has|had|are)\\s+)?(?:${r.inVerbs})\\s+${SEED}${END}`);
    inc(`^${ASK}(?:${r.agentNouns})\\s+(?:${r.nounPreps})\\s+${SEED}${END}`);
    inc(`^${ASK}${SEED}${POSS}\\s+(?:${r.agentNouns})${END}`);
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
    re: new RegExp(`\\bwhere\\s+(?:does|did|has|is)\\s+${SEED}\\s+(?:work|employed)\\b`, 'i'),
    kind: 'who_rel', linkTypes: ['works_at'], direction: 'out', seedGroups: 1,
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
    .replace(/[?.!]+$/, '')
    .replace(/^["'`]|["'`]$/g, '')
    .replace(/^(?:the|a|an)\s+/i, '')
    .trim();
}

// A seed is an entity name, never a clause: "who knows how to deploy X",
// "who at the company wants to ...".
const CLAUSE_START = /^(?:how|what|why|when|where|whether|if|to|which|who)\b/i;
// ... and a name does not end in a dangling preposition ("the founders of
// stoicism known for").
const DANGLING_END = /\b(?:for|to|of|in|on|with|about|by|from|at|as|like)$/i;

function validSeed(s: string): boolean {
  if (s.length === 0 || s.length > 80) return false;
  if (STOPWORD_SEEDS.has(s.toLowerCase())) return false;
  if (CLAUSE_START.test(s) || DANGLING_END.test(s)) return false;
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
