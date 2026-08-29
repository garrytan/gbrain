/**
 * v0.29.1 — merged query-intent classifier.
 *
 * Replaces v0.29.0's `intent.ts` (which only emitted a detail suggestion).
 * After D1 + D4 the codebase needs ONE classifier that returns three
 * suggestions from a single regex pass:
 *
 *   - intent:           original v0.29.0 type ('entity' | 'temporal' | 'event' | 'general')
 *   - suggestedDetail:  v0.29.0 mapping (entity→low, temporal/event→high)
 *   - suggestedSalience: NEW for v0.29.1 — 'off' | 'on' | 'strong'
 *   - suggestedRecency:  NEW for v0.29.1 — 'off' | 'on' | 'strong'
 *
 * Salience and recency are TRULY ORTHOGONAL (per D9):
 *   - salience boosts pages with high emotional_weight + take_count (mattering)
 *   - recency boosts pages with recent effective_date (per-prefix decay)
 * Both can fire, neither can fire, or just one.
 *
 * The classifier follows "current state → on. canonical truth → off." with
 * a NARROW exception per D6: explicit temporal bounds (today / this week /
 * right now / since X / last N days) override canonical-pattern wins. So
 * "who is X right now" → suggestedRecency='on' even though "who is" is a
 * canonical pattern.
 *
 * Pure module. No DB, no LLM, no async — with ONE seam: the shipped banks
 * are English-only regex, so a brain queried in another language never fired
 * the recency/salience stages at all (#4415). `applyIntentPatternConfig`
 * merges per-brain pattern extensions (the `search.intent_patterns` config
 * key, same operator-extension shape as `emotional_weight.high_tags`) over
 * the shipped banks; `classifyQueryWithBrainPatterns` is the async
 * config-loading wrapper hybridSearch calls. classifyQuery itself stays
 * sync + deterministic for a given applied config.
 *
 * wave-g: the config-backed extensions are cached PER ENGINE (WeakMap +
 * short TTL — no config-write invalidation seam exists), so hybridSearch's
 * hot path pays one engine.getConfig round-trip per TTL window instead of
 * one per call, and a multi-engine process (migrate source+target, tests)
 * can't apply one brain's patterns to another brain's queries. The
 * process-global `applyIntentPatternConfig` seam remains for sync callers
 * and tests. `loadEngineIntentPatterns` also exposes a fingerprint of the
 * applied config for the query-cache knobs hash (a pattern-config change
 * changes classification → results, so it must key cache rows).
 * Tested in test/query-intent.test.ts + test/query-intent-config.test.ts.
 */

import { createHash } from 'node:crypto';

export type QueryIntent = 'entity' | 'temporal' | 'event' | 'concept' | 'general';

export type SalienceMode = 'off' | 'on' | 'strong';
export type RecencyMode = 'off' | 'on' | 'strong';

/**
 * v0.36 cross-modal wave: modality axis (D6).
 *
 * - 'text' (default): existing text-embedding path, no behavior change
 * - 'image': route through the multimodal model + embedding_image column
 *   (visually-similar matching + image OCR text)
 * - 'both': run text + image searches in parallel and merge via
 *   weighted RRF (recall-leaning when the query is ambiguous)
 *
 * Parallel axis to intent/detail/salience/recency. Returned by
 * classifyQuery from one regex pass over the query.
 */
export type ModalityMode = 'text' | 'image' | 'both';

export interface QuerySuggestions {
  intent: QueryIntent;
  /** v0.29.0 detail mapping. entity→low, temporal/event→high, general→undefined. */
  suggestedDetail: 'low' | 'medium' | 'high' | undefined;
  /** v0.29.1 — emotional_weight + take_count boost. */
  suggestedSalience: SalienceMode;
  /** v0.29.1 — per-prefix age-decay boost. */
  suggestedRecency: RecencyMode;
  /** v0.36 — cross-modal routing axis. Defaults to 'text' when nothing matches. */
  suggestedModality: ModalityMode;
}

// ─────────────────────────────────────────────────────────
// Pattern banks (organized by axis they signal)
// ─────────────────────────────────────────────────────────

// Original v0.29.0 intent patterns. Drive .intent + .suggestedDetail.
const TEMPORAL_PATTERNS = [
  /\bwhen\b/i,
  /\blast\s+(met|meeting|call|conversation|chat|talked|spoke|seen|heard|time)\b/i,
  /\brecent(ly)?\b/i,
  /\bhistory\b/i,
  /\btimeline\b/i,
  /\bmeeting\s+notes?\b/i,
  /\bwhat('s| is| was)\s+new\b/i,
  /\blatest\b/i,
  /\bupdate(s)?\s+(on|from|about)\b/i,
  /\bhow\s+long\s+(ago|since)\b/i,
  /\b\d{4}[-/]\d{2}\b/i,
  /\blast\s+(week|month|quarter|year)\b/i,
];

const EVENT_PATTERNS = [
  /\bannounce[ds]?(ment)?\b/i,
  /\blaunch(ed|es|ing)?\b/i,
  /\braised?\s+\$?\d/i,
  /\bfund(ing|raise)\b/i,
  /\bIPO\b/i,
  /\bacquisition\b/i,
  /\bmerge[drs]?\b/i,
  /\bnews\b/i,
  /\bhappened?\b/i,
];

const ENTITY_PATTERNS = [
  /\bwho\s+is\b/i,
  /\bwhat\s+(is|does|are)\b/i,
  /\btell\s+me\s+about\b/i,
  /\bdescribe\b/i,
  /\bsummar(y|ize)\b/i,
  /\boverview\b/i,
  /\bbackground\b/i,
  /\bprofile\b/i,
  /\bwhat\s+do\s+(i|you|we)\s+know\b/i,
];

const FULL_CONTEXT_PATTERNS = [
  /\beverything\b/i,
  /\ball\s+(about|info|information|details)\b/i,
  /\bfull\s+(history|context|picture|story|details)\b/i,
  /\bcomprehensive\b/i,
  /\bdeep\s+dive\b/i,
  /\bgive\s+me\s+everything\b/i,
];

// v0.29.1 — recency-axis patterns
//
// Canonical patterns: queries asking for the authoritative / definitional
// answer. These signal recency='off' even when other axes match — UNLESS
// an explicit temporal bound is present (per D6 narrow exception).
const CANONICAL_PATTERNS = [
  /\bwho\s+is\b/i,
  /\bwhat\s+(is|are|does|means?)\b/i,
  /\bdefin(e|ition|ing)\b/i,
  /\bexplain\s+(what|how|why)\b/i,
  /\b(history|origin|background)\s+of\b/i,
  /\bconcept\s+of\b/i,
  /\boverview\s+of\b/i,
  /\btell\s+me\s+about\b/i,
  /\bcompiled\s+truth\b/i,
  /::|->|\.\w+\(/,
  /\b(function|class|method|module)\s+\w+/i,
  /\b(graph|traversal|backlinks?|inbound|outbound)\b/i,
];

// Aggressive recency: "today", "right now", "this morning", "just now".
const STRONG_RECENCY_PATTERNS = [
  /\btoday\b/i,
  /\bright\s+now\b/i,
  /\bthis\s+morning\b/i,
  /\bjust\s+now\b/i,
];

// Moderate recency: "what's going on", "latest", "recent", "this week",
// meeting prep, conversation recall, status updates.
const RECENCY_ON_PATTERNS = [
  /\bwhat'?s\s+(going\s+on|happening|new|latest|up)\b/i,
  /\b(latest|recent(ly)?|currently)\b/i,
  /\b(this|last|past)\s+(week|month|few\s+days|couple\s+days)\b/i,
  /\bmeeting\s+(prep|with|for|notes?|brief)\b/i,
  /\bbefore\s+(my|the|our)\s+(meeting|call|sync|chat)\b/i,
  /\bprep(are)?\s+(for|me)\b/i,
  /\bcatch(es|ing)?\b[\s\w]{0,15}\bup\b/i,  // "catch up", "catch me up", "catching X up"
  /\bremind\s+me\s+(what|about|of)\b/i,
  /\b(update|status|progress)\s+(on|with|from)\b/i,
];

// Per D6: explicit temporal bounds override canonical-wins. "Who is X today"
// → recency='on' (temporal bound wins). "Who is X" alone → recency='off'.
const EXPLICIT_TEMPORAL_BOUND_PATTERNS = [
  /\btoday\b/i,
  /\bright\s+now\b/i,
  /\bthis\s+morning\b/i,
  /\bthis\s+week\b/i,
  /\bsince\s+(launch|last|the|\d)/i,
  /\blast\s+\d+\s+(day|days|week|weeks|month|months)\b/i,
];

// v0.29.1 — salience-axis patterns
//
// Salience suggests "what matters in this brain right now" — when the user
// is asking about people/companies/deals in the current context, they
// usually want the emotionally-weighted + take-rich pages to surface.
// Salience patterns are a subset of recency-on patterns (meeting prep,
// catch-up, update language) plus people-centric phrasings.
const SALIENCE_ON_PATTERNS = [
  /\bwhat'?s\s+(going\s+on|happening|been\s+going|been\s+up)\b/i,
  /\bcatch(es|ing)?\b[\s\w]{0,15}\bup\b/i,
  /\bremind\s+me\s+(what|about|of)\b/i,
  /\bprep(are)?\s+(for|me)\b/i,
  /\bbefore\s+(my|the|our)\s+(meeting|call|sync|chat)\b/i,
  /\bmeeting\s+(prep|with|for|brief)\b/i,
  /\b(update|status|progress)\s+(on|with|from)\b/i,
  /\bwhat\s+matters\b/i,
  /\bwhat'?s\s+important\b/i,
];

// v0.36 cross-modal wave — modality-axis patterns (D6).
//
// CROSS_MODAL_PATTERNS fires the 'image' modality when the query explicitly
// names visual artifacts ("show me photos", "find images of", "screenshot of",
// "what does X look like", "diagram of"). Module-scope const so regexes
// compile once at module load (D15).
//
// Conservative on purpose — false positives cost "one cheaper image search
// where text might have worked." False negatives cost nothing (the legacy
// text path still runs). The LLM-intent escalation in Commit 4 catches
// genuinely ambiguous phrasings.
//
// CJK note: the English patterns are unreachable for Chinese and Japanese
// queries, because JavaScript's `\b` is an ASCII word boundary.
// A Han or Kana character is not a `\w` character, so no boundary ever exists
// beside it — /\b照片\b/ cannot match the string "照片". CJK queries therefore
// always fell through to 'text' and never reached the embedding_image column,
// however many image chunks the brain holds.
//
// The CJK bank anchors on structure instead of word boundaries: the possessive
// 的 / の, a picture measure word (张/幅/组), or an action verb next to the
// visual noun. Conservatism matches the English bank on purpose — a bare
// visual noun ("截图", like a bare "screenshot") stays 'text', because 'image'
// modality is exclusive (D9 skips keyword search), so a false positive drops
// text results rather than merely adding an image search.
const CJK_VISUAL_NOUNS =
  '照片|相片|图片|圖片|图像|圖像|截图|截圖|截屏|画面|畫面|影像|图表|圖表|' +
  '写真|画像|イラスト|スクショ|スクリーンショット';

const CJK_VISUAL_VERBS =
  '找|搜|搜索|查找|翻出|给我|給我|看看|显示|顯示|展示';

const CROSS_MODAL_PATTERNS_CJK: RegExp[] = [
  // "蓝色羽绒服的照片" / "小花笑的图片" / "那张截图" / "猫の写真"
  new RegExp(`(的|の|[张張幅组組])\\s*(${CJK_VISUAL_NOUNS})`),
  // verb-initial (zh): "找一下蓝色羽绒服照片"
  new RegExp(`(${CJK_VISUAL_VERBS})[^\\n]{0,20}?(${CJK_VISUAL_NOUNS})`),
  // verb-final (ja): "写真を見せて" / "画像を探して"
  new RegExp(`(${CJK_VISUAL_NOUNS})\\s*(を|が|は)?\\s*(見せ|見たい|探し|見つけ)`),
  // "X 长什么样" — the CJK form of "what does X look like"
  /长(得)?(什么|甚么|啥)样|長(得)?(什麼|甚麼)樣/,
];

const CROSS_MODAL_PATTERNS: RegExp[] = [
  /\b(show|find|get|pull)\s+(me\s+)?(the\s+)?(photos?|images?|pictures?|pics?|screenshots?)\b/i,
  /\b(photos?|images?|pictures?|pics?|screenshots?)\s+(of|from|at|with|showing|featuring)\b/i,
  /\bwhat\s+does\s+[\w\s']{1,40}?\s+look\s+like\b/i,
  /\b(whiteboard|diagram|slide|screenshot|infographic|chart)s?\s+(of|from|about|showing)\b/i,
  /\bdiagram\s+(of|for|showing)\b/i,
  /\bvisual(s|ly)?\s+(of|from|about|showing|representation)\b/i,
  ...CROSS_MODAL_PATTERNS_CJK,
];

// v0.36 cross-modal wave (Commit 4 prep): visual nouns that combined with
// ambiguous-pronoun phrasings ("any pics from last week's offsite?") trigger
// the optional LLM intent escalation. Subset of cross-modal patterns plus
// looser noun-form matches.
const AMBIGUOUS_MODALITY_NOUNS: RegExp[] = [
  /\b(photo|image|picture|pic|screenshot|diagram|whiteboard|slide|chart)s?\b/i,
  /\blook(s|ed)?\s+like\b/i,
  /\bvisual(s|ly)?\b/i,
];

// Pronoun + filler markers that signal "the user is referencing something
// they can't quite name" — combined with AMBIGUOUS_MODALITY_NOUNS, triggers
// the LLM tie-break in Commit 4.
const AMBIGUOUS_REFERENCE_MARKERS: RegExp[] = [
  // Match all the visual nouns (pic/pics, picture/pictures, photo/photos, image/images,
  // screenshot/screenshots, diagram/diagrams, whiteboard/whiteboards, slide/slides, chart/charts).
  /\b(any|some|that|those|these|the)\s+(pic|pics|picture|pictures|photo|photos|image|images|screenshot|screenshots|diagram|diagrams|whiteboard|whiteboards|slide|slides|chart|charts)\b/i,
  /\bfrom\s+(last|this|the)\s+(week|month|year|offsite|meeting|hackathon|deck)\b/i,
];

// ─────────────────────────────────────────────────────────
// #4415 — per-brain pattern extensions (search.intent_patterns)
// ─────────────────────────────────────────────────────────

/**
 * Every shipped bank above is English-only `\b`-anchored regex, so a brain
 * queried in another language classified 'general' with recency AND salience
 * permanently 'off' — the ranking stages never executed at all. The
 * `search.intent_patterns` config key (same operator-extension shape as
 * `emotional_weight.high_tags`) merges per-brain patterns OVER the shipped
 * banks: a JSON object of bank-name → array of regex sources, e.g.
 *
 *   {"recency_on": ["לאחרונה", "מה חדש"], "strong_recency": ["היום"]}
 *
 * Sources compile with the 'iu' flags ('i' fallback when 'u' rejects the
 * source). Extensions only ever ADD matches — the shipped banks stay in
 * force, and a bad config (unparseable JSON, unknown bank, invalid regex)
 * fail-opens to the shipped behavior per entry.
 */
export const INTENT_PATTERN_BANKS = [
  'temporal', 'event', 'entity', 'full_context', 'canonical',
  'strong_recency', 'recency_on', 'salience_on', 'explicit_temporal_bound',
] as const;
export type IntentPatternBank = (typeof INTENT_PATTERN_BANKS)[number];

/**
 * Typed builder for an empty per-bank pattern record. A plain
 * `Object.fromEntries(...) as Record<...>` is rejected by tsc 5.9 (TS2352:
 * fromEntries returns `{ [k: string]: never[] }`, which doesn't overlap the
 * literal-keyed Record). The loop below assigns EVERY member of
 * INTENT_PATTERN_BANKS, so the narrowing assertion on the empty literal is
 * safe by construction.
 */
function emptyBankSet(): Record<IntentPatternBank, RegExp[]> {
  const out = {} as Record<IntentPatternBank, RegExp[]>;
  for (const b of INTENT_PATTERN_BANKS) out[b] = [];
  return out;
}

const EXTENSIONS: Record<IntentPatternBank, RegExp[]> = emptyBankSet();

// Idempotence cache: recompile only when the raw config value changes
// (applyIntentPatternConfig runs per search on the hot path).
let appliedRaw: string | null | undefined;
let appliedErrors: string[] = [];

/**
 * Compile the raw `search.intent_patterns` config value INTO a bank set
 * (cleared first; null/undefined/'' leaves it empty). Returns per-entry
 * compile errors (empty = fully applied). Never throws. Shared by the
 * process-global seam and the per-engine cache.
 */
function compileIntentPatternConfig(
  raw: string | null | undefined,
  into: Record<IntentPatternBank, RegExp[]>,
): string[] {
  const errors: string[] = [];
  for (const bank of INTENT_PATTERN_BANKS) into[bank].length = 0;
  if (!raw) return errors;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    errors.push(`search.intent_patterns is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    return errors;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    errors.push('search.intent_patterns must be a JSON object of bank-name → array of regex sources');
    return errors;
  }
  for (const [bank, sources] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(INTENT_PATTERN_BANKS as readonly string[]).includes(bank)) {
      errors.push(`unknown pattern bank '${bank}' (valid: ${INTENT_PATTERN_BANKS.join(', ')})`);
      continue;
    }
    if (!Array.isArray(sources)) {
      errors.push(`bank '${bank}' must be an array of regex sources`);
      continue;
    }
    for (const src of sources) {
      if (typeof src !== 'string' || src.length === 0) {
        errors.push(`bank '${bank}': entries must be non-empty strings`);
        continue;
      }
      try {
        into[bank as IntentPatternBank].push(new RegExp(src, 'iu'));
      } catch {
        try {
          into[bank as IntentPatternBank].push(new RegExp(src, 'i'));
        } catch (e) {
          errors.push(`bank '${bank}': invalid regex '${src}': ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }
  return errors;
}

/**
 * Compile + install the `search.intent_patterns` config value (raw string
 * from engine.getConfig; null/undefined/'' clears the extensions). Returns
 * the per-entry compile errors (empty = fully applied). Never throws.
 * Process-wide DEFAULT state — sync classifyQuery callers that don't thread
 * a bank set read it. Engine-bound callers use loadEngineIntentPatterns.
 */
export function applyIntentPatternConfig(raw: string | null | undefined): string[] {
  if (raw === appliedRaw) return appliedErrors;
  appliedRaw = raw;
  appliedErrors = compileIntentPatternConfig(raw, EXTENSIONS);
  return appliedErrors;
}

/** Test seam: reset the process-wide extension state AND the per-engine cache. */
export function clearIntentPatternConfigForTests(): void {
  appliedRaw = undefined;
  appliedErrors = [];
  for (const bank of INTENT_PATTERN_BANKS) EXTENSIONS[bank].length = 0;
  engineIntentStates = new WeakMap();
}

/**
 * Short stable fingerprint of a raw `search.intent_patterns` config value —
 * folded into the query-cache knobs hash (mode.ts `ipat=`) because the
 * patterns change classification (intent weights + auto salience/recency/
 * detail) and therefore results. 'none' for unset/empty config so legacy
 * and pattern-less brains hash identically.
 */
export function intentPatternFingerprint(raw: string | null | undefined): string {
  if (!raw) return 'none';
  return createHash('sha256').update(raw).digest('hex').slice(0, 12);
}

/** Per-engine compiled pattern state (wave-g). */
export interface EngineIntentPatternState {
  banks: Record<IntentPatternBank, RegExp[]>;
  /** intentPatternFingerprint of the applied raw config. */
  fingerprint: string;
  /** Per-entry compile errors from the last (re)compile. */
  errors: string[];
  /** Raw config value the banks were compiled from. */
  raw: string | null | undefined;
  /** Last successful-or-attempted fetch time (ms epoch) — TTL anchor. */
  fetchedAt: number;
}

/**
 * How long a per-engine compiled pattern set is trusted before the next
 * classify re-reads `search.intent_patterns`. There is no config-write
 * invalidation seam (engines have no write hooks), so a short TTL bounds
 * both the hot-path getConfig rate AND the staleness window after a
 * `gbrain config set`.
 */
export const INTENT_PATTERN_TTL_MS = 30_000;

let engineIntentStates = new WeakMap<object, EngineIntentPatternState>();

/**
 * The engine's compiled `search.intent_patterns` state, cached per engine
 * object with a short TTL (see INTENT_PATTERN_TTL_MS). Fail-open: a
 * throwing getConfig keeps the last-compiled banks (shipped-only on first
 * failure) and still advances the TTL anchor so a down config plane isn't
 * hammered per query. Never throws.
 */
export async function loadEngineIntentPatterns(
  engine: { getConfig(key: string): Promise<string | null> },
): Promise<EngineIntentPatternState> {
  const now = Date.now();
  let state = engineIntentStates.get(engine);
  if (state && now - state.fetchedAt < INTENT_PATTERN_TTL_MS) return state;
  if (!state) {
    state = { banks: emptyBankSet(), fingerprint: 'none', errors: [], raw: undefined, fetchedAt: now };
    engineIntentStates.set(engine, state);
  }
  state.fetchedAt = now;
  try {
    const raw = await engine.getConfig('search.intent_patterns');
    if (raw !== state.raw) {
      state.raw = raw;
      state.errors = compileIntentPatternConfig(raw, state.banks);
      state.fingerprint = intentPatternFingerprint(raw);
    }
  } catch { /* fail-open: keep the last-compiled banks */ }
  return state;
}

/**
 * classifyQuery with the brain's `search.intent_patterns` merged over the
 * shipped banks — the wrapper hybridSearch calls (it has the engine; the
 * classifier stays sync). Per-engine banks (wave-g): a multi-engine process
 * never applies one brain's patterns to another brain's queries, and the
 * config read is TTL-cached off the hot path. Fail-open: an unreadable
 * config leaves the shipped banks in force.
 */
export async function classifyQueryWithBrainPatterns(
  engine: { getConfig(key: string): Promise<string | null> },
  query: string,
): Promise<QuerySuggestions> {
  const state = await loadEngineIntentPatterns(engine);
  return classifyQuery(query, state.banks);
}

// ─────────────────────────────────────────────────────────
// Classifier
// ─────────────────────────────────────────────────────────

function matches(patterns: RegExp[], q: string): boolean {
  for (const re of patterns) if (re.test(q)) return true;
  return false;
}

/** Shipped bank OR the configured extension bank (#4415). Defaults to the
 * process-global extensions; engine-bound callers thread their own set. */
function matchesBank(
  bank: IntentPatternBank,
  shipped: RegExp[],
  q: string,
  ext: Record<IntentPatternBank, RegExp[]> = EXTENSIONS,
): boolean {
  return matches(shipped, q) || matches(ext[bank], q);
}

/**
 * Classify a query and return all three axis suggestions.
 *
 * Resolution rules:
 *   - intent:            original v0.29.0 priority (full-context > temporal > event > entity > general)
 *   - suggestedDetail:   intent → detail mapping (entity=low, temporal/event=high)
 *   - suggestedRecency:  STRONG_RECENCY > RECENCY_ON; CANONICAL wins UNLESS
 *                        EXPLICIT_TEMPORAL_BOUND also matches; default 'off'
 *   - suggestedSalience: SALIENCE_ON; CANONICAL wins UNLESS
 *                        EXPLICIT_TEMPORAL_BOUND; default 'off'
 *
 * Note: salience and recency are independent. A "what's going on with X"
 * query gets BOTH on; "who is X" gets BOTH off; "today's news" gets
 * recency='strong' but salience='off' (the user wants newest, not
 * emotionally-weighted).
 */
export function classifyQuery(
  query: string,
  ext: Record<IntentPatternBank, RegExp[]> = EXTENSIONS,
): QuerySuggestions {
  const intent = classifyQueryIntent(query, ext);
  const suggestedDetail = intentToDetail(intent);

  const hasCanonical = matchesBank('canonical', CANONICAL_PATTERNS, query, ext);
  const hasTemporalBound = matchesBank('explicit_temporal_bound', EXPLICIT_TEMPORAL_BOUND_PATTERNS, query, ext);
  const hasStrongRecency = matchesBank('strong_recency', STRONG_RECENCY_PATTERNS, query, ext);
  const hasRecencyOn = matchesBank('recency_on', RECENCY_ON_PATTERNS, query, ext);
  const hasSalienceOn = matchesBank('salience_on', SALIENCE_ON_PATTERNS, query, ext);

  // Recency axis
  let suggestedRecency: RecencyMode;
  if (hasCanonical && !hasTemporalBound) {
    suggestedRecency = 'off';
  } else if (hasStrongRecency) {
    suggestedRecency = 'strong';
  } else if (hasRecencyOn) {
    suggestedRecency = 'on';
  } else {
    suggestedRecency = 'off';
  }

  // Salience axis (orthogonal)
  let suggestedSalience: SalienceMode;
  if (hasCanonical && !hasTemporalBound) {
    suggestedSalience = 'off';
  } else if (hasSalienceOn) {
    suggestedSalience = 'on';
  } else {
    suggestedSalience = 'off';
  }

  // v0.36 cross-modal — modality axis. Independent of intent/detail/salience/recency.
  // Conservative default 'text'; only flips to 'image' on explicit cross-modal regex match.
  // 'both' is reserved for explicit per-call opts (LLM-intent escalation in Commit 4
  // can also produce 'both' via tie-break).
  const suggestedModality: ModalityMode = matches(CROSS_MODAL_PATTERNS, query) ? 'image' : 'text';

  return { intent, suggestedDetail, suggestedSalience, suggestedRecency, suggestedModality };
}

/**
 * v0.36 — heuristic gate for the optional LLM intent escalation (Commit 4).
 *
 * Fires when the query contains a visual noun ("any pics", "the diagram",
 * "what does it look like") combined with an ambiguous reference marker
 * ("from last week's offsite"). These are the phrasings the conservative
 * regex misses but a Haiku tie-break catches.
 *
 * Returns false for unambiguous text queries (no LLM call burned). Returns
 * false for queries the regex ALREADY caught (no need to tie-break a
 * confident classification). Returns true only for the narrow band where
 * the LLM call earns its $0.0001 cost.
 *
 * Pure function. No LLM call. No DB access. Used by hybridSearch's
 * escalation branch only when `search.cross_modal.llm_intent: true`.
 */
export function isAmbiguousModalityQuery(query: string): boolean {
  // Already-confident classification → no LLM needed.
  if (matches(CROSS_MODAL_PATTERNS, query)) return false;

  const hasVisualNoun = matches(AMBIGUOUS_MODALITY_NOUNS, query);
  if (!hasVisualNoun) return false;

  const hasReferenceMarker = matches(AMBIGUOUS_REFERENCE_MARKERS, query);
  return hasReferenceMarker;
}

// ─────────────────────────────────────────────────────────
// v0.29.0 compatibility shims
// ─────────────────────────────────────────────────────────

/** v0.29.0 intent type. Preserved verbatim for back-compat. */
export function classifyQueryIntent(
  query: string,
  ext: Record<IntentPatternBank, RegExp[]> = EXTENSIONS,
): QueryIntent {
  if (matchesBank('full_context', FULL_CONTEXT_PATTERNS, query, ext)) return 'temporal';
  if (matchesBank('temporal', TEMPORAL_PATTERNS, query, ext)) return 'temporal';
  if (matchesBank('event', EVENT_PATTERNS, query, ext)) return 'event';
  // v0.46.15 (Cat 13): concept BEFORE entity — definitional paraphrases
  // ("What is the ownership economy?") previously classified entity and got
  // the keyword tilt, making hybrid LOSE to its own vector arm on
  // paraphrase queries. Full-context/temporal/event keep their queries;
  // only entity/general-bound queries can re-route here.
  if (isConceptShapedQuery(query)) return 'concept';
  if (matchesBank('entity', ENTITY_PATTERNS, query, ext)) return 'entity';
  return 'general';
}

/** v0.29.0 mapping. */
export function intentToDetail(intent: QueryIntent): 'low' | 'medium' | 'high' | undefined {
  switch (intent) {
    case 'entity': return 'low';
    case 'temporal': return 'high';
    case 'event': return 'high';
    // v0.46.15: concept queries keep the default detail — the vector-lean
    // weights (intent-weights.ts) are the mechanism, not source filtering.
    case 'concept': return undefined;
    case 'general': return undefined;
  }
}

/** v0.29.0 helper. Routes through classifyQuery internally. */
export function autoDetectDetail(query: string): 'low' | 'medium' | 'high' | undefined {
  return classifyQuery(query).suggestedDetail;
}

// ─────────────────────────────────────────────────────────
// #2416 — concept-shaped query detection (CLI nudge)
// ─────────────────────────────────────────────────────────

// Fuzzy-quantifier / landscape cues. A concept-shaped question asks for a
// SET defined by meaning ("all the X that do Y", "the landscape of Z") —
// exactly where `query`'s multi-query expansion recovers synonym- and
// outcome-phrased matches that the expansion-off `search` op can miss.
//
// Deliberately EXCLUDED cues (owned by other routers — a nudge toward
// `query` on these would fight their descriptions):
//   - "who are the …"        → find_experts
//   - bare "anything …"      → get_recent_salience / find_anomalies
// v0.46.15 (Cat 13): the ONE shared concept cue bank — consumed by BOTH the
// intent classifier (ranking weights) and the CLI nudge below. Two drifting
// concept definitions was the DRY failure the outside voice flagged (R2-11).
//
// Landscape/quantifier cues: the query asks for a SET defined by meaning.
export const CONCEPT_CUE_PATTERNS: RegExp[] = [
  /\b(all|every)\b.+\b(that|who|which|doing|with|about|related to)\b/i,
  /\b(find|list|show)\s+(all|every|everything)\b/i,
  /\beverything\s+(about|on|matching|related)\b/i,
  /\bthe\s+(landscape|ecosystem|space|universe)\s+of\b/i,
  /\b(landscape|ecosystem)\s+(of|around)\b/i,
  /\bwhich\s+\w+[\w\s]*\b(do|does|are|have|use|work)\b/i,
];

// Definitional-paraphrase cues (v0.46.15): the query asks what an IDEA means
// — exactly where the vector arm wins and the keyword tilt hurt (Cat 13:
// hybrid 47.0 nDCG@5 vs bare vector 49.1 on paraphrase probes).
// DELIBERATELY DISJOINT from FULL_CONTEXT_PATTERNS ("everything about X",
// "all about X" stay full-context → temporal ordering unchanged).
export const CONCEPT_DEFINITIONAL_PATTERNS: RegExp[] = [
  // Lowercase MULTI-WORD subject required (adversarial ship-review F5): the
  // identity wave's own premise is that users type NAMES lowercase — "what
  // is saoirse working on" / "what do i know about galewright" must keep the
  // entity keyword tilt. Concepts in definitional paraphrases are noun
  // PHRASES ("ownership economy", "founder liquidity"); a single lowercase
  // subject word is undecidable without the alias table, so it conservatively
  // stays entity (pre-wave behavior).
  /\b[Ww]hat\s+(is|are)\s+(the\s+)?[a-z][\w'’-]*\s+[a-z]/,               // "What is the ownership economy"
  /\b[Ww]hat\s+do\s+(i|you|we)\s+know\s+about\s+[a-z][\w'’-]*\s+[a-z]/,  // multi-word lowercase subject
  /\b(notes|ideas|thinking|thoughts|writing)\s+(on|about)\b/i,
  /\bways\s+to\b/i,
  /\bhow\s+to\s+think\s+about\b/i,
  /\bconcept\s+of\b/i,
];

/**
 * Status-verb anti-signal for the DEFINITIONAL route only (adversarial F5):
 * "what is <name> working on / up to" asks what an entity is DOING, not what
 * a concept IS — the definitional cue is a false match there. Applies only
 * in isConceptShapedQuery (the ranking route); the CLI nudge's vocabulary is
 * deliberately untouched.
 */
const CONCEPT_STATUS_ANTI_RE = /\b(working on|up to|doing|saying|talking about|focused on|meeting with)\b/i;

// Exact-identifier anti-signals: the query names a specific thing, so the
// cheap `search` op is the right tool and a nudge would be noise.
const CONCEPT_ANTI_PATTERNS: RegExp[] = [
  /["'“”][^"'“”]+["'“”]/,               // quoted phrase — exact-match intent
  /\b[a-z0-9]+(?:-[a-z0-9]+){1,}\b/,    // slug-like token (kebab-case)
];

/**
 * v1-conservative proper-noun anti-signal (v0.46.15): any capitalized token
 * that is NOT sentence-initial is treated as evidence the query names a
 * specific entity — the entity keyword tilt is correct there, not the
 * concept vector lean. Sentence-initial capitalization alone never blocks.
 */
function hasMidSentenceCapital(q: string): boolean {
  const re = /\s(\p{Lu})/gu;
  for (const m of q.matchAll(re)) {
    const idx = m.index ?? 0;
    // Walk back past the whitespace to the previous non-space char.
    let i = idx;
    while (i >= 0 && /\s/.test(q[i])) i--;
    if (i < 0) continue; // start of string → sentence-initial
    if (!/[.!?:;\n\r•\-(["“]/.test(q[i])) return true;
  }
  return false;
}

/**
 * v0.46.15 — concept-shape detection for the INTENT classifier. A query is
 * concept-shaped when it carries a landscape/quantifier OR definitional-
 * paraphrase cue, and NO exact-identifier or proper-noun anti-signal.
 * Precision-biased: quoted phrases, slugs, mid-sentence capitalized tokens,
 * and sub-3-word queries never trigger.
 */
export function isConceptShapedQuery(query: string): boolean {
  const q = query.trim();
  if (q.split(/\s+/).length < 3) return false; // bare token / proper-noun lookup
  const definitional = matches(CONCEPT_DEFINITIONAL_PATTERNS, q);
  if (!matches(CONCEPT_CUE_PATTERNS, q) && !definitional) return false;
  if (matches(CONCEPT_ANTI_PATTERNS, q)) return false;
  if (hasMidSentenceCapital(q)) return false;
  // Definitional-route only (F5): a status verb means the subject is an
  // entity being asked about, not a concept being defined.
  if (definitional && !matches(CONCEPT_CUE_PATTERNS, q) && CONCEPT_STATUS_ANTI_RE.test(q)) return false;
  return true;
}

/**
 * True when a query is concept-shaped for the CLI NUDGE (#2416). Consumes
 * the SAME shared cue/anti banks as the intent detector above (single
 * concept vocabulary — R2-11), composed differently for a different
 * decision: the nudge steers `search` → `query` (breadth/expansion), so it
 * keeps the landscape-cue subset, skips the proper-noun anti-signal (a
 * landscape query about a capitalized techonym still wants expansion), and
 * only backs off when the classifier is confident the query names an
 * ENTITY. The ranking detector is stricter because a wrong vector-lean
 * costs precision; a wrong nudge costs one stderr line.
 */
export function looksConceptShaped(query: string): boolean {
  const q = query.trim();
  if (q.split(/\s+/).length < 3) return false; // bare token / proper-noun lookup
  if (!matches(CONCEPT_CUE_PATTERNS, q)) return false;
  if (matches(CONCEPT_ANTI_PATTERNS, q)) return false;
  if (classifyQueryIntent(q) === 'entity') return false;
  return true;
}

/**
 * One-line CLI hint steering a concept-shaped `search` toward `query`.
 * Returns null when the query is not concept-shaped. Message generation
 * lives here (not in cli.ts) so the full string is unit-testable; the CLI
 * wiring is a two-liner per dispatch path, stderr only, `--quiet`-gated.
 */
export function conceptNudge(query: string): string | null {
  if (!looksConceptShaped(query)) return null;
  const preview = query.length > 60 ? `${query.slice(0, 57)}...` : query;
  return (
    `hint: concept-shaped question — try \`gbrain query "${preview}"\` ` +
    `(adds multi-query expansion; recovers synonym-phrased matches search can miss). ` +
    `A nonzero search count is not proof of completeness.`
  );
}

// ─────────────────────────────────────────────────────────
// #1663 — query-shape router (factual vs open)
// ─────────────────────────────────────────────────────────

/**
 * #1663 — coarse query SHAPE, orthogonal to intent:
 *
 *   'factual' — a bounded lookup with a small, checkable answer (who/when/
 *               where/which, attribute possessives, quoted names, slug-ish
 *               tokens, short entity lookups). Retrieval either has the row
 *               or it doesn't; the CRAG gate's retrieval-side escalation is
 *               worth one re-run here.
 *   'open'    — synthesis-shaped (how/why/explain/summarize/compare,
 *               long multi-clause). When retrieval confidence is weak on an
 *               open query, MORE retrieval rarely fixes it — the honest
 *               escalation target is `think` (multi-round gather+synthesis).
 *
 * Consumed by the CRAG confidence gate (crag.ts + the `query` op) and
 * surfaced in the retrieval response meta for auditability.
 */
export type QueryShape = 'factual' | 'open';

const OPEN_SHAPE_PATTERNS: RegExp[] = [
  /^\s*(how|why)\b/i,
  /\b(explain|describe|summariz\w*|overview of|walk me through|brainstorm|compare|contrast|catch me up|tell me about|history of)\b/i,
  /\bwhat\s+do\s+(i|we|you)\s+know\s+about\b/i,
  /\b(pros\s+and\s+cons|trade-?offs|implications|open\s+questions)\b/i,
];

const FACTUAL_SHAPE_PATTERNS: RegExp[] = [
  /^\s*(who|whom|whose|when|where|which)\b/i,
  // Attribute possessive / attribute-of lookups ("alice's email", "the url of X").
  /\b(email|phone|address|birthday|date|deadline|url|link|title|name|number|id|slug|handle)\b/i,
  /["'“”][^"'“”]+["'“”]/, // quoted phrase — exact-match intent
  /\b[a-z0-9]+(?:-[a-z0-9]+){1,}\b/i, // slug-like token
];

/** Word-count threshold above which an unmatched query reads as open-ended. */
const OPEN_SHAPE_TOKEN_THRESHOLD = 9;

export function classifyQueryShape(query: string): QueryShape {
  const q = query.trim();
  if (!q) return 'open';
  // Explicit factual leads win over embedded open verbs: "who explained the
  // outage" is still a who-lookup.
  if (/^\s*(who|whom|whose|when|where|which)\b/i.test(q)) return 'factual';
  if (matches(OPEN_SHAPE_PATTERNS, q)) return 'open';
  if (isConceptShapedQuery(q)) return 'open'; // set-by-meaning ≈ open-ended
  if (matches(FACTUAL_SHAPE_PATTERNS, q)) return 'factual';
  // Unmatched: short queries are lookups; long multi-clause reads as open.
  return q.split(/\s+/).length > OPEN_SHAPE_TOKEN_THRESHOLD ? 'open' : 'factual';
}

/**
 * #1663 — gate for the structural exact-lookup tier (exact-lookup.ts): a
 * query short enough to plausibly BE a page identity (slug, exact title,
 * declared alias). Mirrors the alias hop's ≤6-token guard; slug-shaped
 * single tokens ('people/alice-example') always qualify. Pure + cheap —
 * called per query on the hot path.
 */
export function isLookupShapedQuery(query: string): boolean {
  const q = query.trim();
  if (!q) return false;
  if (!/\s/.test(q) && q.includes('/')) return true; // slug-shaped
  return q.split(/\s+/).length <= 6;
}
