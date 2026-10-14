/**
 * #6503: fact extraction over text longer than the extractor ceiling.
 *
 * The extractor reads at most MAX_TURN_TEXT_CHARS characters per call
 * (extract.ts keeps that slice only as a defensive guard). Before this module
 * the facts pipeline handed a page's whole `compiled_truth` (and any long
 * `extract_facts` turn text) to one call, so everything past 8,000 characters
 * was silently dropped. Now a text that fits is one call, unchanged; a longer
 * text is split into overlapping windows (text-windows.ts) that each fit the
 * ceiling with a one-line part header, one call per window, and the facts are
 * merged. Windows break on blank lines, then lines, then sentences, and share
 * FACT_WINDOW_OVERLAP_CHARS characters so a claim straddling a boundary is
 * read whole at least once.
 *
 * Any failed window fails the whole text with that window's outcome: the
 * caller's existing failure contract (throw on transport failures, a
 * skipped_reason otherwise) applies to the text as a unit, so a page is never
 * reported as extracted when part of it was not read.
 *
 * Resumable: a long text can need more windows than one bounded execution
 * (a facts-absorb budget cap, a worker timeout) can pay for. So that a retry
 * continues instead of re-paying the same prefix forever, each settled
 * window's facts are banked in `op_checkpoints` (op FACT_WINDOW_OP) under a
 * key built from the caller's scope, every extraction input that shapes the
 * answer, the whole text's hash and the window's position and text hash. A
 * retry reuses a banked window instead of calling the model; an edited text,
 * a changed model or hint is a new key, so stale answers are never reused.
 * The rows are cleared once every window settled and otherwise expire with
 * the cycle's 7-day checkpoint purge. Single-window text never touches the
 * table, and every read and write is fail-soft (a lost row only costs a
 * repeated call).
 *
 * Merging: an exact repeat across windows (the same claim fingerprint as the
 * facts index uses, gbrain_fact_normalize, about the same entity and speaker)
 * keeps its first occurrence; the caller may pass `isRepeat` to also drop
 * near-repeats of the previous window's facts with its own dedup verdict. Everything else then flows through
 * the pipeline's usual DB dedup and write decision.
 */
import { extractFactsFromTurnWithOutcome, MAX_TURN_TEXT_CHARS, type ExtractedFact, type ExtractFactsOutcome, type ExtractInput } from './extract.ts';
import { normalizeLoweredClaim } from './withdrawal-schema.ts';
import { planTextWindows, type TextWindow } from '../text-windows.ts';
import { digest, sha256 } from '../persistence/digest.ts';
import type { BrainEngine } from '../engine.ts';

/** Room kept in every window for the part header. */
export const FACT_WINDOW_HEADER_RESERVE = 200;
/** Text characters per window: the extractor ceiling minus the header. */
export const FACT_WINDOW_CHARS = MAX_TURN_TEXT_CHARS - FACT_WINDOW_HEADER_RESERVE;
/** Characters consecutive windows share (~6% of a window). */
export const FACT_WINDOW_OVERLAP_CHARS = 500;

/** One window (the text itself) when it fits the ceiling; otherwise overlapping windows of FACT_WINDOW_CHARS. */
export function planFactWindows(text: string): TextWindow[] {
  if (text.length <= MAX_TURN_TEXT_CHARS) return [{ index: 0, count: 1, start: 0, end: text.length, text }];
  return planTextWindows(text, FACT_WINDOW_CHARS, FACT_WINDOW_OVERLAP_CHARS);
}

/** The text one window's call receives: a part header (within FACT_WINDOW_HEADER_RESERVE) and the window. */
export function factWindowText(window: TextWindow, totalChars: number): string {
  return `[Part ${window.index + 1} of ${window.count} of one longer text, characters ${window.start}-${window.end} of ${totalChars}. ` +
    `Parts overlap slightly; a claim near an edge may appear in two parts.]\n${window.text}`;
}

const claimKey = (f: ExtractedFact): string =>
  `${(f.entity_slug ?? '').toLowerCase()}\u0000${f.attributed_to ?? ''}\u0000${normalizeLoweredClaim(f.fact.toLowerCase().trim().replace(/\s+/g, ' '))}`;

/**
 * Merge per-window facts in window order, dropping exact repeats of any kept
 * fact and (when given) `isRepeat` near-repeats of the facts kept from the
 * PREVIOUS window. Only neighbouring windows share text, so that is where a
 * claim is read twice; comparing every pair across a long page would cost
 * O(facts²) verdicts for nothing (a near-repeat further apart is what the
 * pipeline's DB dedup decides, exactly as for two separate pages).
 */
export async function mergeWindowFacts(
  perWindow: ExtractedFact[][],
  isRepeat?: (candidate: ExtractedFact, kept: ExtractedFact) => Promise<boolean>,
): Promise<ExtractedFact[]> {
  const kept: ExtractedFact[] = [];
  const byKey = new Map<string, ExtractedFact>();
  let previous: ExtractedFact[] = [];
  for (const facts of perWindow) {
    // The kept facts this window stated (new, or a repeat of an earlier one): what the next window is compared against.
    const current = new Set<ExtractedFact>();
    for (const fact of facts) {
      const key = claimKey(fact);
      let match = byKey.get(key);
      if (!match && isRepeat) for (const prior of previous) if (await isRepeat(fact, prior)) { match = prior; break; }
      if (match) { current.add(match); continue; }
      byKey.set(key, fact);
      kept.push(fact);
      current.add(fact);
    }
    previous = [...current];
  }
  return kept;
}

export const FACT_WINDOW_OP = 'facts-window';

/** The per-window bank key: scope + the inputs that shape the answer + text hash + window position and content. */
export function factWindowKey(scope: string, input: ExtractInput, textHash: string, window: TextWindow): string {
  return digest(['facts-window-v1', scope, input.source, input.sessionId ?? null, input.model ?? null, input.entityHints ?? [],
    input.notabilityAdmission ?? null, input.observationDate ?? null, input.variant ?? null, input.maxFactsPerTurn ?? null,
    input.embedding === undefined ? 'default' : input.embedding, textHash,
    window.index, window.count, window.start, window.end, sha256(window.text)]);
}

const DATE_FIELDS = ['valid_from', 'valid_until', 'expired_at'] as const;

/** JSON-safe form of a fact: the embedding as a number array, dates as ISO strings. */
function bankable(f: ExtractedFact): Record<string, unknown> {
  const out: Record<string, unknown> = { ...f };
  if (f.embedding) out.embedding = Array.from(f.embedding);
  for (const k of DATE_FIELDS) { const d = f[k]; if (d instanceof Date) out[k] = d.toISOString(); }
  return out;
}

function unbanked(raw: Record<string, unknown>): ExtractedFact {
  const f = { ...raw } as Record<string, unknown>;
  if (Array.isArray(raw.embedding)) f.embedding = Float32Array.from(raw.embedding as number[]);
  for (const k of DATE_FIELDS) if (typeof raw[k] === 'string') f[k] = new Date(raw[k] as string);
  return f as unknown as ExtractedFact;
}

/** The facts a settled window returned, or null when it has not settled (or the read failed). */
export async function readSettledFactWindow(engine: BrainEngine, key: string): Promise<ExtractedFact[] | null> {
  try {
    const [row] = await engine.executeRaw<{ facts: unknown }>(
      `SELECT completed_keys->0->'facts' AS facts FROM op_checkpoints WHERE op=$1 AND fingerprint=$2`, [FACT_WINDOW_OP, key]);
    const facts = typeof row?.facts === 'string' ? JSON.parse(row.facts) : row?.facts;
    return Array.isArray(facts) ? facts.map(f => unbanked(f as Record<string, unknown>)) : null;
  } catch {
    return null;
  }
}

/** Bank a settled window's facts (an empty list is a settled zero-yield window). */
export async function recordSettledFactWindow(engine: BrainEngine, key: string, scope: string, textHash: string, window: TextWindow,
  facts: ExtractedFact[]): Promise<void> {
  const entry = [{ scope, text: textHash, window: window.index, of: window.count, facts: facts.map(bankable) }];
  try {
    await engine.executeRaw(
      `INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
       ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys, updated_at=now()`,
      [FACT_WINDOW_OP, key, JSON.stringify(entry)]);
  } catch (err) {
    console.error(`[facts-extract] could not bank window ${window.index + 1}/${window.count} (a retry calls the model for it again): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Drop every banked window of a text (in this scope) once all of its windows settled. */
export async function clearSettledFactWindows(engine: BrainEngine, scope: string, textHash: string): Promise<void> {
  try {
    await engine.executeRaw(`DELETE FROM op_checkpoints WHERE op=$1 AND completed_keys->0->>'scope'=$2 AND completed_keys->0->>'text'=$3`,
      [FACT_WINDOW_OP, scope, textHash]);
  } catch { /* fail-soft: the 7-day checkpoint purge removes them */ }
}

/**
 * Extract facts from text of any length. A text within the ceiling is the
 * single historical call with the input untouched; a longer one is one call
 * per window (same model, hints, observation date and admission), stopping at
 * the first failed window and returning its outcome. With `input.engine`, a
 * window an earlier execution already settled is reused from the bank and a
 * newly settled one is banked, so a bounded execution that stops part-way
 * (failed window, budget stop, timeout, abort) is resumed by the next.
 */
export async function extractFactsFromTextWithOutcome(
  input: ExtractInput,
  opts: {
    isRepeat?: (candidate: ExtractedFact, kept: ExtractedFact) => Promise<boolean>;
    /** Bank scope (e.g. the brain source id), so equal text in another scope never reuses this one's windows. */
    bankScope?: string;
    /** Test seam: the per-call extractor. */
    extractOne?: (input: ExtractInput) => Promise<ExtractFactsOutcome>;
  } = {},
): Promise<ExtractFactsOutcome> {
  const extractOne = opts.extractOne ?? extractFactsFromTurnWithOutcome;
  if (input.isDreamGenerated || !input.turnText) return extractOne(input);
  const windows = planFactWindows(input.turnText);
  if (windows.length === 1) return extractOne(input);
  const engine = input.engine;
  const scope = opts.bankScope ?? '';
  const textHash = sha256(input.turnText);
  const perWindow: ExtractedFact[][] = [];
  for (const window of windows) {
    const key = engine ? factWindowKey(scope, input, textHash, window) : null;
    const banked = engine && key ? await readSettledFactWindow(engine, key) : null;
    if (banked) { perWindow.push(banked); continue; }
    const outcome = await extractOne({ ...input, turnText: factWindowText(window, input.turnText.length) });
    if (!outcome.ok) return outcome;
    if (engine && key) await recordSettledFactWindow(engine, key, scope, textHash, window, outcome.facts);
    perWindow.push(outcome.facts);
  }
  if (engine) await clearSettledFactWindows(engine, scope, textHash);
  return { ok: true, facts: await mergeWindowFacts(perWindow, opts.isRepeat) };
}
