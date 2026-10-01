import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { parseAtomsOutcome, runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import { configureGateway, resetGateway, __setGenerateTextTransportForTests } from '../../src/core/ai/gateway.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { validateAgainstSchema } from '../../src/core/verbs/conformance.ts';

const MODEL = 'ollama:gemma3:4b';
const CONTENT = 'A small reversible experiment can reveal a mistaken assumption before a costly rollout.';
const ATOM = {
  title: 'Test assumptions before rollout', atom_type: 'insight', body: CONTENT,
  source_quote: CONTENT, lesson: 'Test an assumption before expanding a rollout.',
  concepts: ['small-experiments'], virality_score: 40, emotional_register: 'practical',
};
let engine: PGLiteEngine;
let calls: any[];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);
beforeEach(async () => {
  await resetPgliteState(engine);
  resetGateway();
  configureGateway({ chat_model: MODEL, env: {} });
  await engine.setConfig('models.dream.extract_atoms', MODEL);
  calls = [];
});
afterEach(() => {
  __setGenerateTextTransportForTests(null);
  resetGateway();
});
afterAll(async () => {
  await engine.disconnect();
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { ...process.env } });
});

function respond(text: string) {
  // Keep the extractor and gateway real; replace only the provider transport.
  __setGenerateTextTransportForTests(async (args: any) => {
    calls.push(args);
    return { content: [{ type: 'text', text }], finishReason: 'stop', usage: { inputTokens: 20, outputTokens: 20 } } as any;
  });
}

function extract(hash = 'a') {
  return runPhaseExtractAtoms(engine, {
    sourceId: 'default', _pages: [],
    _transcripts: [{ filePath: '/synthetic/2026-01-01-example.txt', content: CONTENT, contentHash: hash.repeat(64) }],
  });
}

async function findFreePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => resolve());
  });
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error('failed to allocate a free test port');
  return port;
}

describe('atom extraction structured output (#5627)', () => {
  test('sends an object schema on the wire and persists a grounded atom', async () => {
    const requests: any[] = [];
    // This local protocol fixture exercises SDK serialization, not live decoding.
    // Bun 1.3.12 on macOS rejects port 0, so probe a free port with node:net.
    const port = await findFreePort();
    const server = Bun.serve({ hostname: '127.0.0.1', port, async fetch(request) {
      requests.push(await request.json());
      return Response.json({
        id: 'synthetic-completion', object: 'chat.completion', created: 0, model: 'gemma3:4b',
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ atoms: [ATOM] }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
      });
    } });
    let outcome;
    try {
      __setGenerateTextTransportForTests(null);
      configureGateway({ chat_model: MODEL, env: {}, base_urls: { ollama: `http://127.0.0.1:${server.port}/v1` } });
      outcome = await extract();
    } finally {
      await server.stop(true);
    }
    expect(requests).toHaveLength(1);
    expect(requests[0].response_format?.type).toBe('json_schema');
    const format = requests[0].response_format.json_schema;
    expect(format.schema.type).toBe('object');
    expect(format.schema.required).toEqual(['atoms']);
    expect(format.schema.additionalProperties).toBe(false);
    const item = format.schema.properties.atoms.items;
    expect(item.properties.atom_type.enum).toContain('insight');
    expect(item.required).toEqual(Object.keys(item.properties));
    expect(item.additionalProperties).toBe(false);
    expect(validateAgainstSchema({ atoms: [] }, format.schema)).toEqual([]);
    expect(validateAgainstSchema({ atoms: [ATOM] }, format.schema)).toEqual([]);
    expect(validateAgainstSchema({ atoms: [{ ...ATOM, atom_type: 'invalid' }] }, format.schema).length).toBeGreaterThan(0);
    expect(validateAgainstSchema({ atoms: [{ ...ATOM, body: 123 }] }, format.schema).length).toBeGreaterThan(0);
    expect(outcome.details?.atoms_extracted).toBe(1);
    expect(outcome.details?.failures).toEqual([]);
    const rows = await engine.executeRaw<{ frontmatter: Record<string, unknown> }>(
      "SELECT frontmatter FROM pages WHERE type = 'atom' AND source_id = 'default' AND deleted_at IS NULL",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].frontmatter.source_quote).toBe(CONTENT);
    expect(rows[0].frontmatter.source_quote_verified).toBe(true);
  });

  test('an ignored schema cannot turn malformed output into successful completion', async () => {
    respond('not valid JSON');
    const outcome = await extract();
    expect(outcome.details?.malformed_outputs).toBe(1);
    expect(outcome.details?.atoms_extracted).toBe(0);
    expect(outcome.details?.tombstoned_transcripts).toEqual([]);
    const again = await extract();
    expect(calls).toHaveLength(2);
    expect(again.details?.malformed_outputs).toBe(1);
  });

  test.each(['[]', '{"atoms":[]}'])('empty reply %s completes work without another provider call', async (reply) => {
    respond(reply);
    const first = await extract();
    expect(first.details?.malformed_outputs).toBe(0);
    expect(first.details?.atoms_extracted).toBe(0);
    await extract();
    expect(calls).toHaveLength(1);
  });

  test('nullable optional metadata and legacy omitted metadata preserve the same atom', async () => {
    const legacy = { title: ATOM.title, atom_type: ATOM.atom_type, body: ATOM.body };
    const nullable = { ...legacy, source_quote: null, lesson: null, concepts: null, virality_score: null, emotional_register: null };
    expect(parseAtomsOutcome(JSON.stringify({ atoms: [nullable] }))).toEqual(parseAtomsOutcome(JSON.stringify([legacy])));
    respond(JSON.stringify({ atoms: [nullable] }));
    const outcome = await extract();
    const format = await calls[0].output.responseFormat;
    expect(validateAgainstSchema({ atoms: [nullable] }, format.schema)).toEqual([]);
    expect(outcome.details?.atoms_extracted).toBe(1);
    expect(outcome.details?.failures).toEqual([]);
    const rows = await engine.executeRaw<{ frontmatter: Record<string, unknown> }>("SELECT frontmatter FROM pages WHERE type='atom' AND deleted_at IS NULL");
    expect(rows).toHaveLength(1);
    for (const key of ['source_quote', 'source_quote_verified', 'lesson', 'concepts', 'virality_score', 'emotional_register']) {
      expect(rows[0].frontmatter[key]).toBeUndefined();
    }
  });

  test('malformed envelopes and invalid required fields remain parse failures', () => {
    for (const reply of [{}, { atoms: null }, { atoms: {} }, { atoms: [{ ...ATOM, body: 123 }] }]) {
      expect(parseAtomsOutcome(JSON.stringify(reply)).ok).toBe(false);
    }
  });

  test('schema rejection retries once, then later extraction uses the cached schemaless path', async () => {
    __setGenerateTextTransportForTests(async (args: any) => {
      calls.push(args);
      if (args.output) throw Object.assign(new Error('response_format json_schema is unsupported'), { name: 'AI_APICallError', statusCode: 400 });
      return { content: [{ type: 'text', text: '{"atoms":[]}' }], finishReason: 'stop', usage: { inputTokens: 20, outputTokens: 20 } } as any;
    });
    const first = await extract();
    expect(first.details?.failures).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(calls[0].output).toBeDefined();
    expect(calls[1].output).toBeUndefined();
    const second = await extract('b');
    expect(second.details?.failures).toEqual([]);
    expect(calls).toHaveLength(3);
    expect(calls[2].output).toBeUndefined();
  });
});
