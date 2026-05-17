/**
 * Unit tests for the functional-area-resolver A/B eval harness.
 * Run with: bun test evals/functional-area-resolver/harness-runner.test.ts
 *
 * Covers every pure function so contributors can debug without spending
 * money on every iteration. main() smoke test is omitted in this slice
 * (it would require mocking gateway transport + filesystem; the harness's
 * --limit 1 mode is a sufficient real smoke check at ~$0.01 per run).
 */

import { test, expect } from 'bun:test';
import {
  parseFixtures,
  buildPrompt,
  parseModelResponse,
  scoreFixture,
  scoreFixtureLenient,
  parseDispatcherLists,
  meanAndCI95,
  estimateCost,
  hashContent,
  parseArgs,
  resolveModel,
  PROMPT_TEMPLATE,
  MODEL_ID,
  MODEL_ALIASES,
} from './harness-runner.ts';

test('parseFixtures: parses valid JSONL', () => {
  const raw = `{"intent":"foo","expected_skill":"bar"}\n{"intent":"baz","expected_skill":"qux"}\n`;
  const out = parseFixtures(raw);
  expect(out).toEqual([
    { intent: 'foo', expected_skill: 'bar' },
    { intent: 'baz', expected_skill: 'qux' },
  ]);
});

test('parseFixtures: skips // comments and blank lines', () => {
  const raw = `// header comment\n{"intent":"a","expected_skill":"b"}\n\n// another comment\n{"intent":"c","expected_skill":"d"}\n`;
  const out = parseFixtures(raw);
  expect(out).toHaveLength(2);
  expect(out[0].intent).toBe('a');
});

test('parseFixtures: throws on missing required fields', () => {
  expect(() => parseFixtures(`{"intent":"foo"}\n`)).toThrow(/missing required fields/);
});

test('parseFixtures: throws on invalid JSON', () => {
  expect(() => parseFixtures(`{not json}\n`)).toThrow(/Bad fixture JSON/);
});

test('buildPrompt: injects variant content and intent', () => {
  const prompt = buildPrompt('RESOLVER X', 'INTENT Y');
  expect(prompt).toContain('RESOLVER X');
  expect(prompt).toContain('INTENT Y');
  expect(prompt).not.toContain('<<<RESOLVER_CONTENT>>>');
  expect(prompt).not.toContain('<<<INTENT>>>');
});

test('parseModelResponse: bare slug', () => {
  expect(parseModelResponse('enrich')).toBe('enrich');
});

test('parseModelResponse: strips fenced output', () => {
  expect(parseModelResponse('```\nenrich\n```')).toBe('enrich');
  expect(parseModelResponse('```text\nenrich\n```')).toBe('enrich');
});

test('parseModelResponse: extracts from JSON object', () => {
  expect(parseModelResponse('{"skill": "book-mirror"}')).toBe('book-mirror');
  expect(parseModelResponse('{"skill_slug": "query"}')).toBe('query');
});

test('parseModelResponse: strips quotes and backticks', () => {
  expect(parseModelResponse('"enrich"')).toBe('enrich');
  expect(parseModelResponse('`enrich`')).toBe('enrich');
});

test('parseModelResponse: picks first slug-shaped token if model prefaces with prose', () => {
  expect(parseModelResponse('The skill is enrich.')).toBe('the');  // first token wins; documents permissive matcher
  expect(parseModelResponse('enrich is the answer')).toBe('enrich');
});

test('parseModelResponse: lowercases output', () => {
  expect(parseModelResponse('ENRICH')).toBe('enrich');
});

test('scoreFixture: exact match returns 1', () => {
  expect(scoreFixture('enrich', 'enrich')).toBe(1);
});

test('scoreFixture: mismatch returns 0', () => {
  expect(scoreFixture('enrich', 'query')).toBe(0);
});

test('scoreFixture: case-sensitive at this layer (caller lowercases via parseModelResponse)', () => {
  expect(scoreFixture('Enrich', 'enrich')).toBe(0);
});

test('meanAndCI95: empty array returns zeros', () => {
  expect(meanAndCI95([])).toEqual({ mean: 0, halfWidthCI: 0 });
});

test('meanAndCI95: single value returns mean with zero CI', () => {
  expect(meanAndCI95([0.95])).toEqual({ mean: 0.95, halfWidthCI: 0 });
});

test('meanAndCI95: three equal values returns mean with zero CI', () => {
  const r = meanAndCI95([1, 1, 1]);
  expect(r.mean).toBe(1);
  expect(r.halfWidthCI).toBe(0);
});

test('meanAndCI95: three different values returns plausible CI', () => {
  const r = meanAndCI95([0.8, 0.9, 1.0]);
  expect(r.mean).toBeCloseTo(0.9, 5);
  expect(r.halfWidthCI).toBeGreaterThan(0);
  expect(r.halfWidthCI).toBeLessThan(0.5);
});

test('estimateCost: uses Opus 4.7 pricing by default', () => {
  const cost = estimateCost(100, 'claude-opus-4-7', 1000, 50);
  // 100 calls * 1000 input tokens = 100K input → $0.50 at $5/MTok
  // 100 calls * 50 output tokens = 5K output → $0.125 at $25/MTok
  expect(cost).toBeCloseTo(0.625, 2);
});

test('estimateCost: Sonnet pricing differs from Opus', () => {
  const opus = estimateCost(100, 'claude-opus-4-7', 1000, 50);
  const sonnet = estimateCost(100, 'claude-sonnet-4-6', 1000, 50);
  const haiku = estimateCost(100, 'claude-haiku-4-5-20251001', 1000, 50);
  expect(sonnet).toBeLessThan(opus);
  expect(haiku).toBeLessThan(sonnet);
});

test('estimateCost: zero calls returns zero', () => {
  expect(estimateCost(0)).toBe(0);
});

test('estimateCost: unknown model returns zero', () => {
  expect(estimateCost(100, 'unknown-model')).toBe(0);
});

test('hashContent: produces stable 16-char hex prefix', () => {
  const h1 = hashContent('hello world');
  const h2 = hashContent('hello world');
  expect(h1).toBe(h2);
  expect(h1).toHaveLength(16);
  expect(h1).toMatch(/^[0-9a-f]+$/);
});

test('hashContent: different inputs produce different hashes', () => {
  expect(hashContent('a')).not.toBe(hashContent('b'));
});

test('parseArgs: defaults are sensible', () => {
  expect(parseArgs([])).toEqual({
    limit: null,
    parallel: 1,
    output: null,
    help: false,
    yes: false,
    model: MODEL_ID,
    variantsDir: 'variants',
    variantFiles: null,
  });
});

test('parseArgs: --model alias', () => {
  expect(parseArgs(['--model', 'sonnet']).model).toBe('sonnet');
  expect(parseArgs(['--model', 'anthropic:claude-haiku-4-5-20251001']).model).toBe('anthropic:claude-haiku-4-5-20251001');
});

test('parseArgs: --variants comma-list', () => {
  expect(parseArgs(['--variants', 'a,b,c']).variantFiles).toEqual(['a', 'b', 'c']);
});

test('parseArgs: --variants-dir', () => {
  expect(parseArgs(['--variants-dir', 'variants-sweep']).variantsDir).toBe('variants-sweep');
});

test('resolveModel: aliases', () => {
  expect(resolveModel('opus')).toEqual({ full: 'anthropic:claude-opus-4-7', bare: 'claude-opus-4-7' });
  expect(resolveModel('sonnet')).toEqual({ full: 'anthropic:claude-sonnet-4-6', bare: 'claude-sonnet-4-6' });
  expect(resolveModel('haiku').full).toBe(MODEL_ALIASES.haiku);
});

test('resolveModel: passthrough for full id', () => {
  expect(resolveModel('anthropic:claude-opus-4-7').bare).toBe('claude-opus-4-7');
  expect(resolveModel('anthropic:claude-something-future').bare).toBe('claude-something-future');
});

test('resolveModel: non-anthropic provider passes through unchanged', () => {
  expect(resolveModel('openai:gpt-4o')).toEqual({ full: 'openai:gpt-4o', bare: 'openai:gpt-4o' });
});

test('parseDispatcherLists: extracts dispatcher → sub-skills', () => {
  const variant = `
- **Brain**: foo bar → \`brain-ops\` (dispatcher for: enrich, query, citation-fixer)
- **Comms**: email → \`exec-assist\` (dispatcher for: gmail, slack)
- Bare row → \`bare-skill\`
`;
  const m = parseDispatcherLists(variant);
  expect(m.size).toBe(2);
  expect(m.get('brain-ops')).toEqual(new Set(['brain-ops', 'enrich', 'query', 'citation-fixer']));
  expect(m.get('exec-assist')).toEqual(new Set(['exec-assist', 'gmail', 'slack']));
});

test('parseDispatcherLists: accepts ASCII -> arrow (SKILL.md template format)', () => {
  // Codex review P2-2: SKILL.md Step 4 documents the template with `->`,
  // but the production variants use Unicode `→`. The regex must match
  // both or downstream users following the template silently fall through
  // to strict-only scoring.
  const variant = `
- **Brain**: foo bar -> \`brain-ops\` (dispatcher for: enrich, query)
- **Comms**: email -> \`exec-assist\` (dispatcher for: gmail)
`;
  const m = parseDispatcherLists(variant);
  expect(m.size).toBe(2);
  expect(m.get('brain-ops')).toEqual(new Set(['brain-ops', 'enrich', 'query']));
  expect(m.get('exec-assist')).toEqual(new Set(['exec-assist', 'gmail']));
});

test('parseDispatcherLists: mixed Unicode + ASCII arrows in same file', () => {
  // A real-world fork could migrate gradually; harness must handle both.
  const variant = `
- **Brain**: foo → \`brain-ops\` (dispatcher for: enrich, query)
- **Comms**: email -> \`exec-assist\` (dispatcher for: gmail, slack)
`;
  const m = parseDispatcherLists(variant);
  expect(m.size).toBe(2);
  expect(m.get('brain-ops')?.has('enrich')).toBe(true);
  expect(m.get('exec-assist')?.has('gmail')).toBe(true);
});

test('parseDispatcherLists: zero dispatchers when no clauses present', () => {
  const variant = `
- Row 1 → \`alpha\`
- Row 2 → \`beta\`
`;
  expect(parseDispatcherLists(variant).size).toBe(0);
});

test('scoreFixtureLenient: exact match = 1', () => {
  expect(scoreFixtureLenient('enrich', 'enrich', new Map())).toBe(1);
});

test('scoreFixtureLenient: same-area sub-skill = 1', () => {
  const lists = new Map([['brain-ops', new Set(['brain-ops', 'enrich', 'query'])]]);
  expect(scoreFixtureLenient('enrich', 'query', lists)).toBe(1);
  expect(scoreFixtureLenient('brain-ops', 'enrich', lists)).toBe(1);
  expect(scoreFixtureLenient('enrich', 'brain-ops', lists)).toBe(1);
});

test('scoreFixtureLenient: cross-area = 0', () => {
  const lists = new Map([
    ['brain-ops', new Set(['brain-ops', 'enrich'])],
    ['comms',     new Set(['comms', 'gmail'])],
  ]);
  expect(scoreFixtureLenient('enrich', 'gmail', lists)).toBe(0);
});

test('scoreFixtureLenient: no dispatcher map = falls back to strict', () => {
  expect(scoreFixtureLenient('foo', 'bar', new Map())).toBe(0);
});

test('parseArgs: --limit', () => {
  expect(parseArgs(['--limit', '5']).limit).toBe(5);
});

test('parseArgs: --limit rejects non-positive', () => {
  expect(() => parseArgs(['--limit', '0'])).toThrow();
  expect(() => parseArgs(['--limit', '-3'])).toThrow();
  expect(() => parseArgs(['--limit', 'foo'])).toThrow();
});

test('parseArgs: --parallel', () => {
  expect(parseArgs(['--parallel', '4']).parallel).toBe(4);
});

test('parseArgs: --output', () => {
  expect(parseArgs(['--output', '/tmp/x.jsonl']).output).toBe('/tmp/x.jsonl');
});

test('parseArgs: --help and --yes', () => {
  expect(parseArgs(['--help']).help).toBe(true);
  expect(parseArgs(['--yes']).yes).toBe(true);
});

test('parseArgs: rejects unknown flags', () => {
  expect(() => parseArgs(['--bogus'])).toThrow(/Unknown flag/);
});

test('MODEL_ID is pinned to Opus 4.7', () => {
  expect(MODEL_ID).toBe('anthropic:claude-opus-4-7');
});

test('PROMPT_TEMPLATE contains both placeholders', () => {
  expect(PROMPT_TEMPLATE).toContain('<<<RESOLVER_CONTENT>>>');
  expect(PROMPT_TEMPLATE).toContain('<<<INTENT>>>');
});
