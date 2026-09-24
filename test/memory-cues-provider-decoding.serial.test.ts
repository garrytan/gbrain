import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __setChatTransportForTests, __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { runMemoryCueBuild } from '../src/core/memory-cues/index.ts';
import { CUE_SYSTEM_PROMPT } from '../src/core/memory-cues/providers.ts';
import { formatCueEvidence } from '../src/core/memory-cues/evidence.ts';
import { cueEvidence, cueVector, enrollCues, seedCuePage, startCueBuild } from './helpers/memory-cues.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { cueSlots } from './helpers/memory-cues-wire.ts';

const model = 'openrouter:anthropic/claude-sonnet-4.6';
const cue = { kind: 'horizon:explicit_constraint_applies', evidence_ref: 1, text: 'Scheduling an early meeting' };
const empty = JSON.stringify(cueSlots());
const valid = JSON.stringify(cueSlots(cue));
let engine: PGLiteEngine;
let responseText: string;
let generated = 0;
let embedded = 0;
let evidence = cueEvidence;
let includeBridge = false;
let stopReason: 'end' | 'refusal' | 'length' = 'end';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM memory_cue_builds');
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw('DELETE FROM pages');
  await engine.setConfig('chat_model', model);
  await engine.setConfig('embedding_model', 'openai:text-embedding-3-large');
  await engine.setConfig('embedding_dimensions', '1536');
  await seedCuePage(engine);
  await enrollCues(engine);
  generated = 0;
  embedded = 0;
  evidence = cueEvidence;
  includeBridge = false;
  stopReason = 'end';
  configureGateway({ chat_model: model, embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
    env: { OPENROUTER_API_KEY: 'test-fixture-not-a-key', OPENAI_API_KEY: 'test-fixture-not-a-key' } });
  __setChatTransportForTests(async opts => {
    generated++;
    expect(opts.model).toBe(model);
    expect(opts.system).toBe(CUE_SYSTEM_PROMPT);
    expect(opts.messages[0].content).toBe(formatCueEvidence(evidence, includeBridge).content);
    expect(opts.maxTokens).toBe(1200);
    expect(opts.temperature).toBe(0);
    return { text: responseText, blocks: [], stopReason, model, providerId: 'openrouter',
      usage: { input_tokens: 20, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 } };
  });
  __setEmbedTransportForTests(async ({ values }) => {
    embedded++;
    return { values, embeddings: values.map(() => Array.from(cueVector())), usage: { tokens: 20 }, warnings: [], response: { headers: {} } };
  });
});

afterEach(() => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
});
afterAll(async () => { await engine.disconnect(); });

for (const [name, text, count] of [
  ['bare all-null slots', empty, 0],
  ['bare grounded slots', valid, 1],
  ['JSON-fenced all-null slots', `\`\`\`json\n${empty}\n\`\`\``, 0],
  ['JSON-fenced grounded slots', `\`\`\`json\n${valid}\n\`\`\``, 1],
  ['unlabelled full fence', `\`\`\`\n${valid}\n\`\`\``, 1],
  ['outer whitespace and CRLF fence', ` \n\`\`\`JSON \r\n${valid}\r\n\`\`\`\n `, 1],
] as const) {
  test(`production cue decoding accepts ${name} without rewriting evidence`, async () => {
    responseText = text;
    const build = await startCueBuild(engine);
    expect(await runMemoryCueBuild(engine, { buildId: build.buildId })).toMatchObject({ status: 'complete', windowsProcessed: 1 });
    expect(await engine.executeRaw('SELECT status FROM memory_cue_windows WHERE build_id=$1::uuid', [build.buildId]))
      .toEqual([{ status: count ? 'ready' : 'empty' }]);
    expect(await engine.executeRaw('SELECT quote FROM memory_cues')).toEqual(count ? [{ quote: cueEvidence }] : []);
    expect(generated).toBe(1);
    expect(embedded).toBe(count);
    expect((await engine.getPage('cue-example', { sourceId: 'default' }))!.compiled_truth).toBe(cueEvidence);
  });
}

for (const [name, text, reason] of [
  ['malformed bare JSON', '[}', 'invalid_output'],
  ['malformed fenced JSON', '```json\n[}\n```', 'invalid_output'],
  ['leading prose', `Here is the result:\n\`\`\`json\n${empty}\n\`\`\``, 'invalid_output'],
  ['trailing prose', `\`\`\`json\n${empty}\n\`\`\`\nDone.`, 'invalid_output'],
  ['multiple fences', `\`\`\`json\n${empty}\n\`\`\`\n\`\`\`json\n${empty}\n\`\`\``, 'invalid_output'],
  ['unclosed fence', `\`\`\`json\n${empty}`, 'invalid_output'],
  ['non-JSON language fence', `\`\`\`javascript\n${empty}\n\`\`\``, 'invalid_output'],
  ['inline fence', `\`\`\`json ${empty}\`\`\``, 'invalid_output'],
  ['missing slots', '```json\n{}\n```', 'invalid_output'],
  ['invalid array element', '```json\n[null]\n```', 'invalid_output'],
  ['unsupported relation', JSON.stringify(cueSlots({ ...cue, kind: 'horizon:invented_relation' })), 'unsupported_relation'],
  ['ungrounded quote', JSON.stringify(cueSlots({ ...cue, quote: 'A claim absent from the original source.' })), 'invalid_output'],
  ['unknown reference', JSON.stringify(cueSlots({ ...cue, evidence_ref: 2 })), 'unsupported_cue'],
  ['zero reference', JSON.stringify(cueSlots({ ...cue, evidence_ref: 0 })), 'unsupported_cue'],
  ['negative reference', JSON.stringify(cueSlots({ ...cue, evidence_ref: -1 })), 'unsupported_cue'],
  ['fractional reference', JSON.stringify(cueSlots({ ...cue, evidence_ref: 1.5 })), 'unsupported_cue'],
  ['string reference', JSON.stringify(cueSlots({ ...cue, evidence_ref: '1' })), 'unsupported_cue'],
  ['array reference', JSON.stringify(cueSlots({ ...cue, evidence_ref: [1] })), 'unsupported_cue'],
  ['object reference', JSON.stringify(cueSlots({ ...cue, evidence_ref: { id: 1 } })), 'unsupported_cue'],
  ['null reference', JSON.stringify(cueSlots({ ...cue, evidence_ref: null })), 'unsupported_cue'],
  ['missing reference', JSON.stringify(cueSlots({ kind: cue.kind, text: cue.text })), 'invalid_output'],
  ['duplicate reference property', valid.replace('"evidence_ref":1', '"evidence_ref":99,"evidence_ref":1'), 'invalid_output'],
  ['extra reference shape', JSON.stringify(cueSlots({ ...cue, evidence_refs: [1] })), 'invalid_output'],
  ['model-supplied quote offset', JSON.stringify(cueSlots({ ...cue, quoteStart: 0 })), 'invalid_output'],
  ['sensitive profile', JSON.stringify(cueSlots({ ...cue, text: 'An introvert personality' })), 'unsupported_cue'],
  ['legacy empty array', '[]', 'invalid_output'],
  ['legacy four horizons', JSON.stringify(Array.from({ length: 4 }, () => ({ family: 'horizon', relation: 'explicit_constraint_applies', evidence_ref: 1, text: cue.text }))), 'invalid_output'],
  ['legacy four horizons with scene relation', JSON.stringify(Array.from({ length: 4 }, (_, i) => ({ family: 'horizon', relation: i === 0 ? 'situation_description' : 'explicit_constraint_applies', evidence_ref: 1, text: cue.text }))), 'invalid_output'],
  ['fourth association slot', JSON.stringify({ ...cueSlots(cue), association_2: cue, association_3: cue, association_4: cue }), 'invalid_output'],
  ['scene carrying association kind', JSON.stringify({ ...cueSlots(), scene: cue }), 'invalid_output'],
  ['horizon situation description', JSON.stringify(cueSlots({ ...cue, kind: 'horizon:situation_description' })), 'unsupported_relation'],
  ['independent family and relation', JSON.stringify(cueSlots({ ...cue, family: 'horizon', relation: 'situation_description' })), 'invalid_output'],
  ['duplicate top-level slot', valid.replace('"scene":null', '"scene":null,"scene":null'), 'invalid_output'],
  ['escaped duplicate slot name', valid.replace('"scene":null', '"scene":null,"sc\\u0065ne":null'), 'invalid_output'],
  ['duplicate association kind', valid.replace('"kind":', '"kind":"horizon:situation_description","kind":'), 'invalid_output'],
  ['duplicate association text', valid.replace('"text":', '"text":"ignored duplicate","text":'), 'invalid_output'],
  ['malformed association slot', JSON.stringify(cueSlots([])), 'invalid_output'],
  ['malformed scene slot', JSON.stringify({ ...cueSlots(), scene: false }), 'invalid_output'],
  ['forbidden bridge', JSON.stringify(cueSlots({ ...cue, kind: 'bridge:explicit_constraint_applies' })), 'unsupported_relation'],
  ['invalid text type', JSON.stringify(cueSlots({ ...cue, text: 123 })), 'unsupported_cue'],
  ['blank text', JSON.stringify(cueSlots({ ...cue, text: '  ' })), 'unsupported_cue'],
  ['overlong text', JSON.stringify(cueSlots({ ...cue, text: 'x'.repeat(241) })), 'unsupported_cue'],
] as const) {
  test(`production cue decoding rejects ${name} rather than publishing an empty success`, async () => {
    responseText = text;
    const build = await startCueBuild(engine);
    expect(await runMemoryCueBuild(engine, { buildId: build.buildId })).toMatchObject({ status: 'failed', reason, windowsProcessed: 0 });
    expect(await engine.executeRaw('SELECT id FROM memory_cue_windows WHERE build_id=$1::uuid', [build.buildId])).toHaveLength(0);
    expect(await engine.executeRaw('SELECT id FROM memory_cues')).toHaveLength(0);
    expect(generated).toBe(1);
    expect(embedded).toBe(0);
    expect((await engine.getPage('cue-example', { sourceId: 'default' }))!.compiled_truth).toBe(cueEvidence);
  });
}

test('different scene and horizon cues may select the same supporting excerpt', async () => {
  responseText = JSON.stringify({ ...cueSlots(cue), scene: { evidence_ref: 1, text: 'A morning scheduling constraint' } });
  const build = await startCueBuild(engine);
  expect(await runMemoryCueBuild(engine, { buildId: build.buildId })).toMatchObject({ status: 'complete', windowsProcessed: 1 });
  expect(await engine.executeRaw('SELECT quote FROM memory_cues')).toEqual([{ quote: cueEvidence }, { quote: cueEvidence }]);
  expect(embedded).toBe(1);
});

for (const bridge of [false, true]) {
  test(`live fixed slots publish one scene and exactly three valid associations with bridge=${bridge}`, async () => {
    includeBridge = bridge;
    responseText = JSON.stringify({
      scene: { evidence_ref: 1, text: 'A morning scheduling constraint' },
      association_1: cue,
      association_2: { ...cue, kind: 'horizon:explicit_preference_applies', text: 'Choosing a meeting time' },
      association_3: { ...cue, kind: `${bridge ? 'bridge' : 'horizon'}:stated_goal_tradeoff`, text: 'Balancing meeting time and practice' },
    });
    const build = await startCueBuild(engine, { includeBridge });
    expect(await runMemoryCueBuild(engine, { buildId: build.buildId })).toMatchObject({ status: 'complete', windowsProcessed: 1 });
    const stored = await engine.executeRaw('SELECT family,relation,quote FROM memory_cues');
    expect(stored).toHaveLength(4);
    expect(stored).toContainEqual({ family: 'scene', relation: 'situation_description', quote: cueEvidence });
    expect(stored).toContainEqual({ family: bridge ? 'bridge' : 'horizon', relation: 'stated_goal_tradeoff', quote: cueEvidence });
    expect(generated).toBe(1);
    expect(embedded).toBe(1);
  });
}

for (const reason of ['refusal', 'length'] as const) {
  test(`production cue decoding rejects ${reason} even with valid slots`, async () => {
    responseText = valid;
    stopReason = reason;
    const build = await startCueBuild(engine);
    expect(await runMemoryCueBuild(engine, { buildId: build.buildId })).toMatchObject({ status: 'failed',
      reason: reason === 'refusal' ? 'provider_refusal' : 'incomplete_output', windowsProcessed: 0 });
    expect(await engine.executeRaw('SELECT id FROM memory_cue_windows')).toHaveLength(0);
    expect(embedded).toBe(0);
  });
}

test('source-selected bold heading and clipped text are stored exactly, not regenerated', async () => {
  evidence = '**Goal 2: Balance video watching time**\n- Limit viewing to a short evening break.\n- Keep mornings for practice.\nA clipped final sent';
  await seedCuePage(engine, 'cue-example', 'default', evidence);
  responseText = JSON.stringify(cueSlots({ ...cue, kind: 'horizon:stated_goal_tradeoff', text: 'Planning evening video time' }));
  const build = await startCueBuild(engine);
  expect(await runMemoryCueBuild(engine, { buildId: build.buildId })).toMatchObject({ status: 'complete', windowsProcessed: 1 });
  expect(await engine.executeRaw('SELECT quote FROM memory_cues')).toEqual([{ quote: evidence }]);
  expect((await engine.getPage('cue-example', { sourceId: 'default' }))!.compiled_truth).toBe(evidence);
  expect(embedded).toBe(1);
});

test('live publication preserves selected chunk identity and grounds excerpts ending at synthetic separators', async () => {
  const repeated = 'a'.repeat(500);
  const first = '🌱'.repeat(7) + repeated;
  evidence = first + '\n' + repeated;
  await seedCuePage(engine, 'cue-example', 'default', evidence);
  await installFixtureChunks(engine, 'cue-example', [
    { chunk_index: 0, chunk_text: first, chunk_source: 'compiled_truth' },
    { chunk_index: 1, chunk_text: repeated, chunk_source: 'compiled_truth' },
  ]);
  const chunks = await engine.executeRaw<{ id: number }>('SELECT id FROM content_chunks ORDER BY chunk_index');
  responseText = JSON.stringify({ ...cueSlots(cue), association_2: { ...cue, evidence_ref: 2, text: 'Applying the second constraint' } });
  const build = await startCueBuild(engine);
  expect(await runMemoryCueBuild(engine, { buildId: build.buildId })).toMatchObject({ status: 'complete', windowsProcessed: 1 });
  expect(await engine.executeRaw('SELECT chunk_id,quote,grounding FROM memory_cues ORDER BY chunk_id')).toEqual([
    { chunk_id: chunks[0]!.id, quote: first, grounding: [{ chunk_id: chunks[0]!.id, start: 0, end: 507, separator: '' }] },
    { chunk_id: chunks[1]!.id, quote: repeated, grounding: [{ chunk_id: chunks[1]!.id, start: 0, end: 500, separator: '' }] },
  ]);
  expect((await engine.getPage('cue-example', { sourceId: 'default' }))!.compiled_truth).toBe(evidence);
});
