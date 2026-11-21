/**
 * GBRA-574: conversation fact slots, tagged after extraction. The main extraction call never asks for a slot (asking
 * cost wishes and preferences); this second, small call reads only the facts the main call produced whose entity is a
 * live person page named exactly (an exact page or alias match, or subject inference) or a name key the window kept
 * for a full name with no page (facts.unbacked_entity_keys), and tags each with at most one slot (facts/slots.ts). A
 * failed call leaves the facts without slots; abort and an exhausted budget propagate.
 */
import { chat, isAvailable } from '../ai/gateway.ts';
import { BudgetExhausted } from '../budget/budget-tracker.ts';
import type { BrainEngine } from '../engine.ts';
import { getFactsExtractionModel } from './extract.ts';
import { normalizeSlot, SLOT_DIMENSIONS } from './slots.ts';

/** Kinds that can state where a person lives, who employs them or their role. */
const SLOT_KINDS: ReadonlySet<string> = new Set(['fact', 'event']);
/** Characters of one fact the tagging call sees; the main call returns at most 10 facts a window. */
export const SLOT_TAG_FACT_CHARS = 400;
export const SLOT_TAG_MAX_FACTS = 10;
export const SLOT_TAG_MAX_TOKENS = 400;

export const SLOT_TAG_SYSTEM = [
  'You tag facts about people with a slot when the fact states one: where the person lives (location), which',
  'organization employs them (employer), or their role or job title (role).',
  'Each input line is "<n>. [<person>] <fact>". Reply with JSON only:',
  '{"slots":[{"i":<n>,"dimension":"location|employer|role","value":"<the place, organization or title alone>"}]}',
  'with one entry for each fact that states a slot for the bracketed person, and nothing for every other fact.',
  '- The value must belong to the bracketed person and be stated by the fact.',
  '- A fact saying the value changed (moved, joined, was promoted) carries the new value. A fact that only ends a value',
  '  ("left the company") or states a past one ("used to live in ...") has no slot.',
  '- No slot for plans, wishes, trips, visits or guesses.',
  '- At most one slot per fact.',
].join('\n');

const SLOT_TAG_SCHEMA = { name: 'slot_tagging', schema: {
  type: 'object',
  properties: {
    slots: {
      type: 'array',
      items: {
        type: 'object',
        properties: { i: { type: 'integer' }, dimension: { type: 'string', enum: [...SLOT_DIMENSIONS] }, value: { type: 'string' } },
        required: ['i', 'dimension', 'value'],
      },
    },
  },
  required: ['slots'],
} };

/** The longest input one tagging call sends, for cost bounds. */
export const SLOT_TAG_INPUT_CHARS = SLOT_TAG_SYSTEM.length + SLOT_TAG_MAX_FACTS * (SLOT_TAG_FACT_CHARS + 120);

type TaggableRow = { fact: string; kind?: string | null; entity_slug?: string | null; dimension?: string | null; value?: string | null };

/**
 * Returns `rows` with a slot on each fact the model tagged (tagged rows are copies). `exact[i]` says row i's entity was
 * named exactly; `unbacked` maps a row whose entity is a name key this window kept to the extractor's name for it, which
 * the call shows in brackets. `called` says a tagging call went out, `failed` that it errored or its reply could not be read.
 */
export async function tagSlots<T extends TaggableRow>(engine: BrainEngine, sourceId: string, rows: T[], exact: readonly boolean[],
  abortSignal?: AbortSignal, unbacked?: ReadonlyMap<number, string>): Promise<{ rows: T[]; called: boolean; failed: boolean }> {
  const picked = rows.map((row, i) => ({ row, i }))
    .filter(({ row, i }) => (exact[i] || unbacked?.has(i)) && row.entity_slug && SLOT_KINDS.has(row.kind ?? 'fact'));
  if (!picked.length) return { rows, called: false, failed: false };
  const people = new Map((await engine.listLivePersonTitles(sourceId, [...new Set(picked.map(p => p.row.entity_slug!))]))
    .map(p => [p.slug, p.title || p.slug]));
  const named = (p: { row: T; i: number }) => exact[p.i] ? people.get(p.row.entity_slug!) : unbacked?.get(p.i);
  const candidates = picked.filter(p => named(p)).slice(0, SLOT_TAG_MAX_FACTS);
  if (!candidates.length) return { rows, called: false, failed: false };
  const model = await getFactsExtractionModel(engine);
  if (!isAvailable('chat', model)) return { rows, called: false, failed: false };

  const lines = candidates.map((c, n) => `${n + 1}. [${named(c)}] ${c.row.fact.replace(/\s+/g, ' ').slice(0, SLOT_TAG_FACT_CHARS)}`);
  let text: string;
  try {
    const result = await chat({ model, system: SLOT_TAG_SYSTEM, messages: [{ role: 'user', content: lines.join('\n') }],
      maxTokens: SLOT_TAG_MAX_TOKENS, abortSignal, responseSchema: SLOT_TAG_SCHEMA, cacheSystem: true });
    if (result.stopReason === 'length') return { rows, called: true, failed: true };
    text = result.text;
  } catch (err) {
    if (err instanceof BudgetExhausted || abortSignal?.aborted || (err instanceof Error && err.name === 'AbortError')) throw err;
    return { rows, called: true, failed: true };
  }
  let slots: unknown;
  try {
    slots = (JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) as { slots?: unknown }).slots;
  } catch {
    return { rows, called: true, failed: true };
  }
  if (!Array.isArray(slots)) return { rows, called: true, failed: true };
  const out = [...rows];
  const tagged = new Set<number>();
  for (const s of slots as Array<{ i?: unknown; dimension?: unknown; value?: unknown }>) {
    const c = typeof s?.i === 'number' && Number.isInteger(s.i) ? candidates[s.i - 1] : undefined;
    if (!c || tagged.has(c.i)) continue;
    const slot = normalizeSlot(s.dimension, s.value, c.row.entity_slug);
    if (!slot) continue;
    tagged.add(c.i);
    out[c.i] = { ...c.row, ...slot };
  }
  return { rows: out, called: true, failed: false };
}
