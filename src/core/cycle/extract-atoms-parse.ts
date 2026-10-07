/**
 * extract_atoms response parsing: the typed parse outcome, the bounded `[`
 * anchor scan and the atom shape gate. Peeled out of extract-atoms.ts, which
 * re-exports the public names.
 */
import { matchingCloseBracket, stripReasoningBlocks } from '../llm-json.ts';
import { ATOM_TYPES } from './extract-atoms-schema.ts';

export interface ExtractedAtom {
  title: string;
  atom_type: typeof ATOM_TYPES[number];
  body: string;
  source_quote?: string;
  lesson?: string;
  /**
   * 1-3 kebab-case topic labels for concept clustering. Consumed by
   * synthesize_concepts (groups atoms by `frontmatter.concepts`; only
   * labels shared by >=2 atoms materialize a concept page, so the prompt
   * biases reuse-over-coinage). #2123.
   */
  concepts?: string[];
  virality_score?: number;
  emotional_register?: string;
}

/** kebab-case validator for concept labels ("captive-portal", "channel-pricing"). */
const CONCEPT_LABEL_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * gbrain#4148 — typed parse outcome. Malformed model output and a legitimate
 * zero-yield extraction both used to collapse into `[]`, so malformed output
 * was tombstoned as success (the page never retried, its atoms silently
 * lost). `ok: false` means the response was not parseable as an atoms array
 * AT ALL — a content-deterministic failure class the caller counts toward a
 * bounded tombstone; `ok: true, atoms: []` means the model genuinely
 * extracted nothing.
 */
export type AtomsParseOutcome =
  | { ok: true; atoms: ExtractedAtom[] }
  | { ok: false; reason: string };

export function parseAtomsOutcome(raw: string): AtomsParseOutcome {
  const direct = parseAtomsOutcomeInner(raw);
  if (direct.ok) return direct;
  // Same reasoning-block hazard as the facts extractor: `indexOf('[')` below
  // finds a bracket inside <think> when the model drafts its array while
  // reasoning, so the parse fails and the page is halted. Ladder, not a
  // pre-filter: raw first, stripped only on failure — and the ORIGINAL
  // outcome is returned when the retry also fails, so error reasons are
  // unchanged for non-reasoning models.
  const stripped = stripReasoningBlocks(raw);
  if (stripped && stripped !== raw.trim()) {
    const retry = parseAtomsOutcomeInner(stripped);
    if (retry.ok) return retry;
  }
  return direct;
}

/**
 * Bound on how many `[` offsets the anchor scan will try. Completions are
 * already capped by `max_output_tokens`, so this is a belt-and-braces guard
 * against a pathological bracket-dense response, not a functional limit —
 * every failing candidate fails at ~offset 0 of its own slice, so the scan is
 * cheap. Reached-the-cap behaves exactly like found-nothing: the FIRST
 * offset's outcome is returned, i.e. today's behaviour.
 */
const MAX_ARRAY_ANCHOR_CANDIDATES = 64;

/**
 * Parse the JSON array anchored at ONE `[` offset: whole-slice parse, then a
 * trim-back to the array's own closing `]` so trailing prose cannot hijack it
 * (the first complete array wins). Split out of parseAtomsOutcomeInner so the
 * anchor scan can try successive offsets without duplicating the reason
 * strings — those are asserted by tests and ride the drain's `last_error`.
 */
function parseArrayAtOffset(
  cleaned: string,
  start: number,
): { ok: true; parsed: unknown[] } | { ok: false; reason: string } {
  const slice = cleaned.slice(start);
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    // Trim back to the array's own closing bracket to drop trailing prose.
    const arrayEnd = matchingCloseBracket(slice);
    if (arrayEnd === -1) return { ok: false, reason: 'unterminated JSON array' };
    try {
      parsed = JSON.parse(slice.slice(0, arrayEnd + 1));
    } catch {
      return { ok: false, reason: 'unparseable JSON array' };
    }
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: 'JSON value is not an array' };
  return { ok: true, parsed };
}

function parseAtomsOutcomeInner(raw: string): AtomsParseOutcome {
  // Strip markdown code fences if the LLM wrapped JSON in them.
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  const firstStart = cleaned.indexOf('[');
  if (firstStart === -1) return { ok: false, reason: 'no JSON array in response' };

  // ANCHOR SCAN. Pre-fix this committed to `indexOf('[')` — the FIRST bracket
  // anywhere in the response. Any bracket in a preamble hijacked the anchor,
  // and a brain whose house style mandates inline `[Source: …]` citations and
  // `[[wikilink]]` backlinks (or whose transcripts carry `[user]` / `[tool: …]`
  // role markers) makes the model echo one while narrating, so a response
  // carrying a perfectly good array was reported `unparseable JSON array`.
  //
  // Acceptance requires the candidate to parse AND to yield >= 1 atom-shaped
  // element (`atomsFromParsedArray` is the single source of truth for
  // "atom-shaped"). Parseability alone is NOT enough: a zero-yield result is
  // exactly what TOMBSTONES an item (#2144), so only ONE parseable shape may
  // produce it — the literal `[]` the #4948 prompt asks for when nothing is
  // extractable, accepted at ANY offset (a model that echoes a `[Source: …]`
  // citation before obeying must not lose its honest `[]` to this gate and
  // burn three strikes into a tombstone + halt). A NON-empty array whose
  // elements all fail the shape gate is malformed output: it rides the
  // failure streak like every other parse failure instead of tombstoning the
  // item forever on the first try.
  let firstAttempt: ReturnType<typeof parseArrayAtOffset> | null = null;
  let sawEmptyArray = false;
  let candidates = 0;
  for (
    let start = firstStart;
    start !== -1 && candidates < MAX_ARRAY_ANCHOR_CANDIDATES;
    start = cleaned.indexOf('[', start + 1)
  ) {
    candidates++;
    const attempt = parseArrayAtOffset(cleaned, start);
    // Captured on the FIRST iteration only — every reason string this function
    // can return still describes the first bracket, unchanged.
    if (firstAttempt === null) firstAttempt = attempt;
    if (attempt.ok) {
      if (attempt.parsed.length === 0) { sawEmptyArray = true; continue; }
      const atoms = atomsFromParsedArray(attempt.parsed);
      if (atoms.length > 0) return { ok: true, atoms };
    }
  }

  // Nothing yielded a real atom. An honest `[]` anywhere is the zero-yield
  // success (#4148 keeps "found nothing" distinct from "malformed"); otherwise
  // fall back to the FIRST offset's outcome — never a later one — so the
  // failure reason the drain surfaces as `last_error` still describes the
  // first bracket.
  if (sawEmptyArray) return { ok: true, atoms: [] };
  if (firstAttempt === null) return { ok: false, reason: 'no JSON array in response' };
  if (firstAttempt.ok) return { ok: false, reason: 'array had no atom-shaped elements' };
  return firstAttempt;
}

/**
 * Back-compat wrapper: parse the response into ExtractedAtom[], returning []
 * for BOTH malformed output and a legitimate zero-yield (legacy callers/tests
 * that don't need the typed distinction — new code uses parseAtomsOutcome).
 */
export function parseAtomsResponse(raw: string): ExtractedAtom[] {
  const outcome = parseAtomsOutcome(raw);
  return outcome.ok ? outcome.atoms : [];
}

function atomsFromParsedArray(parsed: unknown[]): ExtractedAtom[] {

  const atoms: ExtractedAtom[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    const title = typeof obj.title === 'string' ? obj.title.slice(0, 200) : null;
    const atomType = typeof obj.atom_type === 'string' ? obj.atom_type.trim().toLowerCase() : null;
    const body = typeof obj.body === 'string' ? obj.body : null;
    if (!title || !atomType || !body) continue;
    if (!ATOM_TYPES.includes(atomType as typeof ATOM_TYPES[number])) continue;
    atoms.push({
      title,
      atom_type: atomType as typeof ATOM_TYPES[number],
      body,
      source_quote: typeof obj.source_quote === 'string' ? obj.source_quote.slice(0, 500) : undefined,
      lesson: typeof obj.lesson === 'string' ? obj.lesson : undefined,
      concepts: (() => {
        if (!Array.isArray(obj.concepts)) return undefined;
        const labels = obj.concepts
          .filter((c): c is string => typeof c === 'string' && CONCEPT_LABEL_RE.test(c))
          .slice(0, 3);
        return labels.length > 0 ? labels : undefined;
      })(),
      virality_score:
        typeof obj.virality_score === 'number' &&
        obj.virality_score >= 0 &&
        obj.virality_score <= 100
          ? obj.virality_score
          : undefined,
      emotional_register:
        typeof obj.emotional_register === 'string' ? obj.emotional_register : undefined,
    });
  }
  return atoms;
}
