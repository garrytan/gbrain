/**
 * Changing a line-grammar setting so the graph follows it. The setting and
 * the extraction generation (`_internal.link_extraction_generation`) commit
 * in one transaction, and the generation moves only when the effective
 * extraction behavior changes (`lineGrammarFingerprint`), so `set`, `unset`
 * and pattern unset converge the same way and repeated identical settings are
 * no-ops. A moved generation makes every page's links stale; managed link
 * extraction (dream cycle, managed sync, the serve owner) or
 * `gbrain extract --stale` re-derives them.
 */
import type { BrainEngine } from './engine.ts';
import {
  LINE_GRAMMAR_KEYS, LINK_EXTRACTION_GENERATION_KEY, lineGrammarFingerprint, parseGrammarBoolean, readLineGrammarSettings,
  type LineGrammarSettings,
} from './line-grammar.ts';
import { linkExtractorWatermarkFor } from './link-extraction-watermark.ts';

export const isLineGrammarKey = (key: string): key is (typeof LINE_GRAMMAR_KEYS)[number] =>
  (LINE_GRAMMAR_KEYS as readonly string[]).includes(key);

/** Keys `gbrain config` never sets or unsets on a user's behalf. */
export const isInternalConfigKey = (key: string) => key.startsWith('_internal.');

/** A refusal message for a value that is not a grammar boolean, or null when the value is valid. */
export function invalidLineGrammarValue(key: string, value: string): string | null {
  return parseGrammarBoolean(value) === 'invalid'
    ? `${key} takes true or false (also accepted: 1/0, yes/no, on/off); "${value}" was not saved. Run: gbrain config set ${key} true`
    : null;
}

export interface LineGrammarChange {
  before: LineGrammarSettings;
  after: LineGrammarSettings;
  changed: boolean;
  generation: string | null;
}

/** Run `mutate` and move the extraction generation if the effective behavior changed, in one transaction. */
export async function applyLineGrammarConfigChange(engine: BrainEngine, mutate: (tx: BrainEngine) => Promise<void>): Promise<LineGrammarChange> {
  return engine.transaction(async tx => {
    // Lock the generation row (when it exists) so a concurrent change serializes behind this one.
    await tx.executeRaw('SELECT value FROM config WHERE key = $1 FOR UPDATE', [LINK_EXTRACTION_GENERATION_KEY]);
    const before = await readLineGrammarSettings(tx);
    await mutate(tx);
    const after = await readLineGrammarSettings(tx);
    if (lineGrammarFingerprint(before) === lineGrammarFingerprint(after)) return { before, after, changed: false, generation: before.generation };
    // The database clock, at microsecond precision: page stamps come from the same clock.
    const [row] = await tx.executeRaw<{ at: string }>(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`);
    await tx.setConfig(LINK_EXTRACTION_GENERATION_KEY, row.at);
    return { before, after: { ...after, generation: row.at }, changed: true, generation: row.at };
  });
}

/** What changed and what happens next, for the operator. */
export async function describeLineGrammarChange(engine: BrainEngine, change: LineGrammarChange): Promise<{ lines: string[]; json: Record<string, unknown> }> {
  const state = (s: LineGrammarSettings) => s.enabled ? `on (undeclared types ${s.allowUndeclaredTypes ? 'allowed' : 'refused'}, ranges ${s.effectiveRanges ? 'stored' : 'not stored'})` : 'off';
  if (!change.changed) {
    return { lines: [`Line grammar is ${state(change.after)}; extraction behavior did not change, so no pages need re-extraction.`],
      json: { effective: change.after, changed: false, pages_queued: 0 } };
  }
  const queued = await engine.countStalePagesForExtraction({ versionTs: linkExtractorWatermarkFor(change.generation) }).catch(() => null);
  const lines = [
    `Line grammar is now ${state(change.after)} (was ${state(change.before)}).`,
    `${queued ?? 'All'} page(s) are queued for link re-extraction (zero model calls). Managed extraction (dream cycle, managed sync, a running \`gbrain serve\`) finishes it in the background; run \`gbrain extract --stale\` to finish now.`,
    'Verify: `gbrain doctor --json` reports links_extraction_lag 0 when done. A gbrain process started before this change keeps the old setting until it restarts.',
  ];
  return { lines, json: { effective: change.after, previous: change.before, changed: true, pages_queued: queued,
    next: { argv: ['gbrain', 'extract', '--stale'] }, verify: { argv: ['gbrain', 'doctor', '--json'] } } };
}
