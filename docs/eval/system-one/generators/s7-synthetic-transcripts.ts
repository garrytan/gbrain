/**
 * S7 triage eval: synthetic transcripts that extend the Cat 35 corpus with
 * enough routine negatives (and buried-signal positives) for qualification.
 *
 *   bun docs/eval/system-one/generators/s7-synthetic-transcripts.ts [--out DIR] [--dry-run]
 *
 * Labels are BY CONSTRUCTION (label_source "synthetic-construction"): each
 * spec tells the generator model what the transcript must and must not
 * contain; nobody hand-labelled these. Specs are deterministic (seeded
 * PRNG over fixed theme/signal/name pools); the text comes from
 * openai:gpt-5.6-luna (reasoning none, temperature 1), cached per id so a
 * rerun only fills gaps. Output is the cat35 builder layout:
 *   gold/<id>.json            {transcript_id, scenario, expected_triage, label_source, generator, spec}
 *   transcripts-txt/<date>-<id>.txt
 * Spend is appended to docs/eval/system-one/ledger.jsonl.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const MODEL = 'gpt-5.6-luna';
const PRICE = { input: 0.2, output: 1.2 };
const HARD_STOP_USD = 2.5;
const SEED = 7_350_001;

const args = process.argv.slice(2);
const OUT = args.includes('--out') ? args[args.indexOf('--out') + 1]! : 'docs/eval/system-one/datasets/s7-triage';
const DRY = args.includes('--dry-run');
const LEDGER = 'docs/eval/system-one/ledger.jsonl';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

const ROUTINE_THEMES = [
  'planning the week\'s dinners around leftovers and writing a grocery list',
  'tracking a delayed package and drafting a polite support message',
  'converting recipe units and oven temperatures for a scaled recipe',
  'a shell session freeing disk space with pasted `du` output and deletions',
  'fixing a spreadsheet formula that returns #REF after a column was moved',
  'working out a call time across three timezones with daylight-saving edge cases',
  'reformatting a CSV export so a budgeting app will import it',
  'troubleshooting home wifi dropping in one room: router restart, channel change',
  'renaming a folder of vacation photos by date with a small script',
  'resolving a git merge conflict in a lockfile step by step, pure mechanics',
  'debugging a failing unit test caused by a typo in a fixture path, no reflection',
  'choosing between two identical-looking phone chargers by wattage specs',
  'setting up a printer on a laptop and clearing a stuck print queue',
  'asking for synonyms and grammar fixes on a dull office notice about parking',
  'comparing grocery unit prices for olive oil and paper towels',
  'looking up how to reset a forgotten router admin password',
  'formatting a bibliography in a citation style for a school handout',
  'figuring out a bus and train route across town for a dentist appointment',
  'a regex to strip trailing whitespace from log lines, with test strings',
  'converting a short list of temperatures and distances between metric and imperial',
  'cleaning up an overflowing email inbox with filter rules for newsletters',
  'picking a houseplant watering schedule from care-label instructions',
  'sorting out a laptop that will not connect to bluetooth headphones',
  'trivia chat about why the sky is blue and how rainbows form',
  'building a packing checklist for a two-night trip with laundry logistics',
  'a linter complaining about import order, fixed by running the formatter',
  'calculating tip and splitting a restaurant bill among four people',
  'installing a Python package that fails because of a missing system library',
  'drafting a generic out-of-office auto-reply with dates filled in',
  'deciding how many AA batteries a set of toys needs and where to buy them',
] as const;

const SIGNALS = [
  { kind: 'decision', brief: 'the user makes a consequential decision about their own project (for example committing to shut down a side product, pick a co-founder role, or change pricing), with the reason' },
  { kind: 'commitment', brief: 'the user commits to a specific future action with a named person and a date (for example promising to send a named collaborator a term sheet by Friday)' },
  { kind: 'person-fact', brief: 'the user reveals a new durable fact about a named person they work with (their new role, a health situation they are handling, a move, a preference that matters for working together)' },
  { kind: 'project-fact', brief: 'the user states a new durable fact about their project or company (a metric milestone, a lost customer and why, a key hire, a legal constraint)' },
  { kind: 'idea', brief: 'the user articulates an original idea or thesis (a product concept, a mental model about their market) in a few sentences with some reasoning' },
  { kind: 'reflection', brief: 'the user reflects on themselves: names a recurring pattern in how they work or feel, and what they want to change' },
] as const;

const FIRST = ['Marisol', 'Tobin', 'Anneke', 'Dario', 'Priyanka', 'Otto', 'Leilani', 'Bram', 'Yusra', 'Cormac', 'Ingrid', 'Teo', 'Wren', 'Hollis', 'Saoirse', 'Ravi'];
const LAST = ['Veen', 'Arkwright', 'Solberg', 'Quintero', 'Hale-Ober', 'Lindqvist', 'Moradi', 'Okonkwo-Bell', 'Fairweather', 'Castellan', 'Drummond', 'Ishikawa-Roe'];
const PROJECTS = ['fernpost', 'lumenkit', 'harbor-ledger', 'quillmesh', 'saltbox', 'northgate-labs', 'tidewell', 'brambleworks'];

export interface Spec {
  id: string;
  scenario: 'synthetic-routine' | 'synthetic-buried-signal';
  expected_triage: 'low' | 'high';
  theme: string;
  turns: number;
  signal?: { kind: string; brief: string; person: string; project: string; position: string };
}

export function buildSpecs(): Spec[] {
  const specs: Spec[] = [];
  for (let i = 0; i < 110; i++) {
    const theme = ROUTINE_THEMES[i % ROUTINE_THEMES.length]!;
    specs.push({ id: `syn-routine-${String(i + 1).padStart(3, '0')}`, scenario: 'synthetic-routine', expected_triage: 'low', theme, turns: 10 + Math.floor(rand() * 14) });
  }
  for (let i = 0; i < 50; i++) {
    const sig = SIGNALS[i % SIGNALS.length]!;
    specs.push({
      id: `syn-buried-${String(i + 1).padStart(3, '0')}`, scenario: 'synthetic-buried-signal', expected_triage: 'high',
      theme: pick(ROUTINE_THEMES), turns: 12 + Math.floor(rand() * 14),
      signal: { kind: sig.kind, brief: sig.brief, person: `${pick(FIRST)} ${pick(LAST)}`, project: pick(PROJECTS), position: pick(['in the middle', 'about two thirds of the way through', 'near the end, before the wrap-up']) },
    });
  }
  // Second batch (appended after the first so the first batch's PRNG draws are unchanged):
  // more routine negatives so the eval half can reach the qualification minimum.
  for (let i = 110; i < 180; i++) {
    const theme = ROUTINE_THEMES[(i * 7) % ROUTINE_THEMES.length]!;
    specs.push({ id: `syn-routine-${String(i + 1).padStart(3, '0')}`, scenario: 'synthetic-routine', expected_triage: 'low', theme, turns: 10 + Math.floor(rand() * 14) });
  }
  return specs;
}

function prompt(s: Spec): string {
  const base = `Write a realistic chat transcript between a user and an AI assistant, ${s.turns} turns total, alternating, starting with the user.
Format exactly: a line "[user]" or "[assistant]", then the message, then a blank line. No title, no commentary, no markdown fences.
Length: about ${s.turns * 450} characters overall; assistant replies are practical and specific; include pasted command output or lists where natural.
Topic: ${s.theme}.`;
  if (s.scenario === 'synthetic-routine') {
    return `${base}
This transcript must be ENTIRELY ROUTINE: nothing a personal knowledge base should remember. Hard rules: no decisions of consequence, no commitments to other people, no facts about named people or companies, no original ideas or theses, no self-reflection or emotions beyond mild annoyance or relief. Do not name any real or fictional person. Mundane details (quantities, times, file names) are fine.`;
  }
  const g = s.signal!;
  return `${base}
The transcript is mostly routine, but ${g.position} the user briefly goes off-topic for one or two messages in which ${g.brief}. Use the person name "${g.person}" and/or the project name "${g.project}" where a name fits. Keep that passage natural and concrete (4-8 sentences from the user), then the conversation returns to the routine topic. Everything else follows these rules: no other people, decisions or reflections.`;
}

async function generate(s: Spec): Promise<{ text: string; usage: { in: number; out: number } }> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, reasoning_effort: 'none', temperature: 1, max_completion_tokens: 6000, messages: [{ role: 'user', content: prompt(s) }] }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const d = await res.json() as { choices: Array<{ message: { content: string } }>; usage: { prompt_tokens: number; completion_tokens: number } };
  return { text: d.choices[0]!.message.content.trim() + '\n', usage: { in: d.usage.prompt_tokens, out: d.usage.completion_tokens } };
}

async function main(): Promise<void> {
  const specs = buildSpecs();
  mkdirSync(join(OUT, 'gold'), { recursive: true });
  mkdirSync(join(OUT, 'transcripts-txt'), { recursive: true });
  const todo = specs.filter((s) => !existsSync(join(OUT, 'gold', `${s.id}.json`)));
  console.log(`${specs.length} specs, ${todo.length} to generate`);
  if (DRY) return;
  let usd = 0, tin = 0, tout = 0;
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const s = todo[next++]!;
      if (usd > HARD_STOP_USD) throw new Error(`hard stop at $${usd.toFixed(3)}`);
      const { text, usage } = await generate(s);
      tin += usage.in; tout += usage.out;
      usd += (usage.in * PRICE.input + usage.out * PRICE.output) / 1e6;
      if (!/^\[user\]/m.test(text) || !/^\[assistant\]/m.test(text)) { console.error(`${s.id}: malformed, skipped`); continue; }
      writeFileSync(join(OUT, 'transcripts-txt', `2026-09-30-${s.id}.txt`), text);
      writeFileSync(join(OUT, 'gold', `${s.id}.json`), JSON.stringify({
        schema_version: 1, transcript_id: s.id, scenario: s.scenario, expected_triage: s.expected_triage,
        label_source: 'synthetic-construction', generator: { model: `openai:${MODEL}`, reasoning: 'none', temperature: 1, seed: SEED }, spec: s,
      }, null, 2) + '\n');
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), purpose: 'S7 synthetic transcripts', provider: 'openai', model: MODEL, input_tokens: tin, output_tokens: tout, usd: Number(usd.toFixed(4)) }) + '\n');
  console.log(`done: ${todo.length} generated, $${usd.toFixed(4)} (${tin} in / ${tout} out)`);
}

if (import.meta.main) await main();
