import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __setChatTransportForTests, __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { runMemoryCueBuild } from '../src/core/memory-cues/index.ts';
import { CUE_SYSTEM_PROMPT } from '../src/core/memory-cues/providers.ts';
import { cueEvidence, cueVector, enrollCues, seedCuePage, startCueBuild } from './helpers/memory-cues.ts';

const model = 'openrouter:anthropic/claude-sonnet-4.6';
const cue = { family: 'horizon', relation: 'explicit_constraint_applies', quote: cueEvidence, text: 'Scheduling an early meeting' };
const valid = JSON.stringify([cue]);
let engine: PGLiteEngine;
let responseText: string;
let generated = 0;
let embedded = 0;

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
  configureGateway({ chat_model: model, embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
    env: { OPENROUTER_API_KEY: 'test-fixture-not-a-key', OPENAI_API_KEY: 'test-fixture-not-a-key' } });
  __setChatTransportForTests(async opts => {
    generated++;
    expect(opts.model).toBe(model);
    expect(opts.system).toBe(CUE_SYSTEM_PROMPT);
    expect(JSON.parse(String(opts.messages[0].content))).toMatchObject({ includeBridge: false, evidence: cueEvidence });
    return { text: responseText, blocks: [], stopReason: 'end', model, providerId: 'openrouter',
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
  ['bare empty array', '[]', 0],
  ['bare grounded array', valid, 1],
  ['JSON-fenced empty array', '```json\n[]\n```', 0],
  ['JSON-fenced grounded array', `\`\`\`json\n${valid}\n\`\`\``, 1],
  ['unlabelled full fence', `\`\`\`\n${valid}\n\`\`\``, 1],
  ['outer whitespace and CRLF fence', ` \n\`\`\`JSON \r\n${valid}\r\n\`\`\`\n `, 1],
] as const) {
  test(`production cue decoding accepts ${name} without rewriting evidence`, async () => {
    responseText = text;
    const build = await startCueBuild(engine);
    expect(await runMemoryCueBuild(engine, { buildId: build.buildId })).toMatchObject({ status: 'complete', windowsProcessed: 1 });
    expect(await engine.executeRaw('SELECT status FROM memory_cue_windows WHERE build_id=$1::uuid', [build.buildId]))
      .toEqual([{ status: count ? 'ready' : 'empty' }]);
    expect(await engine.executeRaw('SELECT id FROM memory_cues')).toHaveLength(count);
    expect(generated).toBe(1);
    expect(embedded).toBe(count);
    expect((await engine.getPage('cue-example', { sourceId: 'default' }))!.compiled_truth).toBe(cueEvidence);
  });
}

for (const [name, text, reason] of [
  ['malformed bare JSON', '[}', 'invalid_output'],
  ['malformed fenced JSON', '```json\n[}\n```', 'invalid_output'],
  ['leading prose', 'Here is the result:\n```json\n[]\n```', 'invalid_output'],
  ['trailing prose', '```json\n[]\n```\nDone.', 'invalid_output'],
  ['multiple fences', '```json\n[]\n```\n```json\n[]\n```', 'invalid_output'],
  ['unclosed fence', '```json\n[]', 'invalid_output'],
  ['non-JSON language fence', '```javascript\n[]\n```', 'invalid_output'],
  ['inline fence', '```json []```', 'invalid_output'],
  ['non-array schema', '```json\n{}\n```', 'invalid_output'],
  ['invalid array element', '```json\n[null]\n```', 'invalid_output'],
  ['unsupported relation', `\`\`\`json\n${JSON.stringify([{ ...cue, relation: 'invented_relation' }])}\n\`\`\``, 'unsupported_relation'],
  ['ungrounded quote', `\`\`\`json\n${JSON.stringify([{ ...cue, quote: 'A claim absent from the original source.' }])}\n\`\`\``, 'unsupported_cue'],
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
