import { afterEach, beforeEach, expect, test } from 'bun:test';
import { configureGateway, resetGateway, __setChatTransportForTests, __setGenerateTextTransportForTests, chat } from '../src/core/ai/gateway.ts';
import { formatCueRequest, liveMemoryCueProviders } from '../src/core/memory-cues/providers.ts';
import { CUE_ASSOCIATION_PAIRS, CUE_OUTPUT_SLOTS, formatCueEvidence, MAX_CUE_WIRE_BYTES, STRUCTURED_CUE_MODEL } from '../src/core/memory-cues/evidence.ts';
import { buildCueWindows, validateCueOutput } from '../src/core/memory-cues/windows.ts';
import { cueSlots } from './helpers/memory-cues-wire.ts';

let server: ReturnType<typeof Bun.serve>;
let requests: Array<{ body: any; bytes: number }>;
let output: unknown;
let status: number;
const source = 'I keep mornings free for practice.';
const cue = { kind: 'horizon:explicit_constraint_applies', evidence_ref: 1, text: 'Planning a morning meeting' };
const configured = {
  openrouter: {
    provider: { only: ['anthropic'], ignore: ['example-host'], zdr: true, data_collection: 'deny',
      max_price: { prompt: 3, completion: 15 }, allow_fallbacks: false, require_parameters: false },
    response_format: { type: 'json_schema', json_schema: { name: 'weaker', strict: false,
      schema: { type: 'object', properties: { injected: { type: 'string' } }, required: [], additionalProperties: true } } },
  },
  [STRUCTURED_CUE_MODEL]: { provider: { sort: 'price', max_price: { completion: 15 } } },
};

beforeEach(() => {
  requests = [];
  output = cueSlots(cue);
  status = 200;
  __setChatTransportForTests(null);
  __setGenerateTextTransportForTests(null);
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const raw = await request.text();
    requests.push({ body: JSON.parse(raw), bytes: Buffer.byteLength(raw) });
    if (status !== 200) return Response.json({ error: { message: 'response_format json_schema rejected', type: 'invalid_request_error' } }, { status });
    return Response.json({ id: 'fixture', model: 'anthropic/claude-sonnet-4.6', object: 'chat.completion', created: 1,
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(output) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 20 } });
  } });
  configureGateway({ chat_model: STRUCTURED_CUE_MODEL, base_urls: { openrouter: `http://127.0.0.1:${server.port}/v1` },
    provider_chat_options: configured, env: { OPENROUTER_API_KEY: 'test-fixture-not-a-key' } });
});
afterEach(() => { server.stop(true); resetGateway(); });

for (const includeBridge of [false, true]) {
  test(`real SDK transmits strict nullable slots and preserves routing with bridge=${includeBridge}`, async () => {
    const formatted = formatCueRequest(source, includeBridge, STRUCTURED_CUE_MODEL);
    const result = await liveMemoryCueProviders.generate({ evidence: source, includeBridge, model: STRUCTURED_CUE_MODEL });
    expect(validateCueOutput(result.output, buildCueWindows([{ id: 1, chunk_text: source }])[0]!, includeBridge)).toHaveLength(1);
    expect(requests).toHaveLength(1);
    const { body, bytes } = requests[0]!;
    expect(body.response_format).toEqual(JSON.parse(JSON.stringify(formatted.providerOptions!.openrouter.response_format)));
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
    const schema = body.response_format.json_schema.schema;
    expect(schema.required).toEqual([...CUE_OUTPUT_SLOTS]);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toEqual([...CUE_OUTPUT_SLOTS]);
    for (const slot of CUE_OUTPUT_SLOTS) {
      expect(schema.properties[slot].anyOf[0]).toEqual({ type: 'null' });
      const object = schema.properties[slot].anyOf[1];
      expect(object.additionalProperties).toBe(false);
      expect(object.required).toEqual(slot === 'scene' ? ['evidence_ref', 'text'] : ['kind', 'evidence_ref', 'text']);
      expect(object.properties.evidence_ref).toEqual({ type: 'integer', enum: [1] });
      expect(object.properties.text.type).toBe('string');
      if (slot !== 'scene') expect(object.properties.kind.enum).toEqual(Object.entries(CUE_ASSOCIATION_PAIRS)
        .filter(([, pair]) => includeBridge || pair.family === 'horizon').map(([kind]) => kind));
    }
    for (const keyword of ['minLength', 'maxLength', 'minimum', 'maximum']) expect(JSON.stringify(schema)).not.toContain(`"${keyword}"`);
    expect(body.provider).toEqual({ ...configured.openrouter.provider, sort: 'price', require_parameters: true });
    expect(body.max_tokens).toBe(1200);
    expect(body.temperature).toBe(0);
    expect(bytes).toBeLessThanOrEqual(formatted.wireByteCeiling!);
    expect(formatted.inputTokenCeiling).toBe(formatted.wireByteCeiling! + 1024);
  });
}

test('schema rejection never triggers a schemaless retry or downgrades later calls', async () => {
  status = 400;
  await expect(liveMemoryCueProviders.generate({ evidence: source, includeBridge: false, model: STRUCTURED_CUE_MODEL })).rejects.toThrow();
  expect(requests).toHaveLength(1);
  status = 200;
  await liveMemoryCueProviders.generate({ evidence: source, includeBridge: false, model: STRUCTURED_CUE_MODEL });
  expect(requests).toHaveLength(2);
  expect(requests.every(({ body }) => body.response_format?.json_schema?.strict === true)).toBe(true);
});

test('unrelated chat callers and unverified cue routes receive no new strict options', async () => {
  await chat({ model: STRUCTURED_CUE_MODEL, messages: [{ role: 'user', content: 'Fixture' }] });
  expect(requests[0]!.body.response_format).toEqual(configured.openrouter.response_format);
  for (const model of ['anthropic:claude-sonnet-4-6', 'openrouter:anthropic/claude-sonnet-4', 'openai:gpt-4o-mini']) {
    expect(formatCueEvidence(source, false, model).providerOptions).toBeUndefined();
  }
});

test('empty eligible reference set has a valid all-null-only schema', async () => {
  output = cueSlots();
  expect((await liveMemoryCueProviders.generate({ evidence: ' \n', includeBridge: false, model: STRUCTURED_CUE_MODEL })).output).toEqual([]);
  const schema = requests[0]!.body.response_format.json_schema.schema;
  expect(schema.properties).toEqual(Object.fromEntries(CUE_OUTPUT_SLOTS.map(slot => [slot, { type: 'null' }])));
  expect(JSON.stringify(schema)).not.toContain('"enum":[]');
});

test('schema reference enums exclude short trimmed excerpts without removing their source input', async () => {
  const evidence = 'a'.repeat(639) + '\n' + 'b';
  const formatted = formatCueRequest(evidence, false, STRUCTURED_CUE_MODEL);
  expect(formatted.excerpts).toHaveLength(2);
  expect(formatted.excerpts.map(excerpt => excerpt.text).join('')).toBe(evidence);
  await liveMemoryCueProviders.generate({ evidence, includeBridge: false, model: STRUCTURED_CUE_MODEL });
  const schema = requests[0]!.body.response_format.json_schema.schema;
  for (const slot of CUE_OUTPUT_SLOTS) expect(schema.properties[slot].anyOf[1].properties.evidence_ref.enum).toEqual([1]);
});

for (const invalid of [cueSlots({ evidence_ref: 1, text: cue.text }), cueSlots({ ...cue, text: 'x'.repeat(241) }),
  cueSlots({ ...cue, evidence_ref: 99 }), cueSlots({ ...cue, kind: 'bridge:stated_goal_tradeoff' })]) {
  test(`local strict decoder rejects invalid HTTP output ${JSON.stringify(invalid)}`, async () => {
    output = invalid;
    await expect(liveMemoryCueProviders.generate({ evidence: source, includeBridge: false, model: STRUCTURED_CUE_MODEL })).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });
}

test('schema-conforming sensitive profile still fails the unchanged local validator', async () => {
  output = cueSlots({ ...cue, text: 'An introvert personality' });
  const result = await liveMemoryCueProviders.generate({ evidence: source, includeBridge: false, model: STRUCTURED_CUE_MODEL });
  expect(() => validateCueOutput(result.output, buildCueWindows([{ id: 1, chunk_text: source }])[0]!)).toThrow('unsupported_cue');
});

test('worst-case escaped real HTTP wire including routing/schema stays within 64 KiB and reservations', async () => {
  output = cueSlots();
  for (const includeBridge of [false, true]) {
    const evidence = '\u0001'.repeat(8192);
    const formatted = formatCueRequest(evidence, includeBridge, STRUCTURED_CUE_MODEL);
    await liveMemoryCueProviders.generate({ evidence, includeBridge, model: STRUCTURED_CUE_MODEL });
    expect(requests.at(-1)!.bytes).toBeLessThanOrEqual(formatted.wireByteCeiling!);
    expect(formatted.wireByteCeiling!).toBeLessThanOrEqual(formatted.maximumWireByteCeiling!);
    expect(formatted.maximumWireByteCeiling!).toBeLessThanOrEqual(MAX_CUE_WIRE_BYTES);
    expect(formatted.inputTokenCeiling).toBeLessThanOrEqual(formatted.maximumInputTokenCeiling);
    console.log(JSON.stringify({ includeBridge, actualWireBytes: requests.at(-1)!.bytes,
      wireByteCeiling: formatted.wireByteCeiling, maximumWireByteCeiling: formatted.maximumWireByteCeiling }));
  }
  expect(() => formatCueEvidence(source, false, STRUCTURED_CUE_MODEL, { openrouter: { provider: { only: ['x'.repeat(65536)] } } }))
    .toThrow('unsupported_window');
});
