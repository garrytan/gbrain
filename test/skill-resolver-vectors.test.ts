/**
 * Skill vectors (V1, src/core/skills/resolver/vectors.ts) in builds and turns.
 *
 * 1. Protects: a catalog gets vectors only when the brain has an embedding
 *    model with a key and the catalog is a Claude Code, Codex or hand-built
 *    one in user scope; a failed or keyless embed still publishes the index;
 *    a turn fuses words and vectors by rank, shows a skill that shares no
 *    word with the message, gates on the cosine floor, and falls back to the
 *    word matcher's exact output on every failure; with no embedder nothing
 *    changes and nothing is sent.
 * 2. Fails when: a build without an embedder writes vectors or a vectors key
 *    other than skipped, a fallback changes the word matcher's answer, or an
 *    OpenClaw, Pi or project catalog gets vectors.
 * 3. Scratch GBRAIN_HOME with no brain; the embedding call is the test
 *    transport, so nothing leaves the machine.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __setEmbedTransportForTests, EMBED_SKIP_CODES, embedOverHttp, type EmbedRequest } from '../src/core/skills/resolver/embed-http.ts';
import { releaseLease, tryAcquireLease } from '../src/core/skills/resolver/lock.ts';
import { catalogFile } from '../src/core/skills/resolver/paths.ts';
import { __setPickerTransportForTests } from '../src/core/skills/resolver/router-http.ts';
import { buildSkillIndex, resolveSkills } from '../src/core/skills/resolver/index.ts';
import { __setVectorFloorForTests, BUILD_BATCH_CHARS, RRF_K, skillVectorText, VECTOR_FLOOR, vectorFloor, VECTOR_RETRY_MAX, VECTOR_RETRY_MS } from '../src/core/skills/resolver/vectors.ts';
import { RRF_K as SEARCH_RRF_K } from '../src/core/search/hybrid.ts';
import { loadSchema, validate } from './helpers/json-schema-lite.ts';

const scratch: string[] = [];
const tmp = (p = 'skvec-') => { const d = mkdtempSync(join(tmpdir(), p)); scratch.push(d); return d; };
beforeEach(() => { __setEmbedTransportForTests(async () => { throw new Error('a test reached the embedding provider'); }); });
afterEach(() => { __setEmbedTransportForTests(null); __setPickerTransportForTests(null); __setVectorFloorForTests(null); });
afterAll(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

const SKILLS = [
  { id: 'deploy', name: 'deploy', description: 'Ship the service to production' },
  { id: 'notes', name: 'notes', description: 'Summarize meeting notes into action items' },
  { id: 'people', name: 'people', description: 'Look up what the brain knows about a person' },
];
/** A three-axis meaning space: releases, meetings, people; anything else points nowhere near them. */
const AXES: [RegExp, number][] = [[/ship|release|production|launch|go live/i, 0], [/meeting|notes|standup|call/i, 1], [/person|people|who is|colleague/i, 2]];
function vectorOf(text: string): number[] {
  const v = [0, 0, 0, 0.05];
  for (const [re, i] of AXES) if (re.test(text)) v[i] = 1;
  return v;
}
const calls: EmbedRequest[] = [];
function embedder(fn: (req: EmbedRequest) => Promise<number[][]> = async req => req.texts.map(vectorOf)) {
  calls.length = 0;
  __setEmbedTransportForTests(async req => { calls.push(req); return fn(req); });
}
const CONFIG = { embedding_model: 'voyage:voyage-4', embedding_dimensions: 1024 };

async function home(config: Record<string, unknown> | null, build: Record<string, unknown> = {}): Promise<string> {
  const h = tmp();
  if (config) writeFileSync(join(h, 'config.json'), JSON.stringify(config));
  const f = join(tmp('skvec-src-'), 'catalog.json');
  writeFileSync(f, JSON.stringify(SKILLS));
  await buildSkillIndex({ catalog: 'c', fromJson: f, ...build }, { home: h });
  return h;
}
const turn = (h: string, message: string, extra: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) => resolveSkills({ message, harness: 'claude-code', ...extra }, { home: h, catalogs: ['c'], ...opts });
const strip = (o: object) => JSON.stringify({ ...o, meta: undefined, vectors: undefined });
const ids = (o: { suggestions: { id: string }[] }) => o.suggestions.map(s => s.id);

describe('building vectors', () => {
  test('no embedding model: no vectors.bin, receipt says no_embedder, no call', async () => {
    embedder();
    const h = await home(null);
    expect(existsSync(join(h, 'skill-index', 'c', 'vectors.bin'))).toBe(false);
    const { readReceipt } = await import('../src/core/skills/resolver/build.ts');
    expect(readReceipt(h, 'c')!.vectors).toEqual({ skipped: 'no_embedder' });
    expect(calls).toHaveLength(0);
  });

  test('an embedder with a key: one document vector per skill, tied to the model and the width', async () => {
    embedder();
    const h = await home(CONFIG);
    const { readReceipt } = await import('../src/core/skills/resolver/build.ts');
    expect(readReceipt(h, 'c')!.vectors).toEqual({ model: 'voyage:voyage-4', dims: 4, count: 3 });
    expect(existsSync(join(h, 'skill-index', 'c', 'vectors.bin'))).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ provider: 'voyage', id: 'voyage-4', dims: 1024, inputType: 'document' });
    expect(calls[0]!.texts[0]).toBe(skillVectorText({ name: 'deploy', description: 'Ship the service to production', triggers: [], body: '' }));
  });

  test('catalogs whose turns never read vectors get none: OpenClaw, Pi, Hermes, project scope, disabled embeddings, an unmeasured model', async () => {
    embedder();
    const { readReceipt } = await import('../src/core/skills/resolver/build.ts');
    for (const [config, build, code] of [
      [CONFIG, { harness: 'openclaw' }, 'not_this_harness'], [CONFIG, { harness: 'pi' }, 'not_this_harness'], [CONFIG, { harness: 'hermes' }, 'not_this_harness'],
      [CONFIG, { harness: 'claude-code', scope: 'project' }, 'project_scope'], [{ ...CONFIG, embedding_disabled: true }, {}, 'embedding_disabled'],
      [{ embedding_model: 'voyage:voyage-code-4' }, {}, 'unmeasured_model'], [{ embedding_model: 'ollama:nomic-embed-text' }, {}, 'unsupported_provider'],
    ] as const) {
      const h = await home(config, build);
      expect(readReceipt(h, 'c')!.vectors).toEqual({ skipped: code });
      expect(existsSync(join(h, 'skill-index', 'c', 'vectors.bin'))).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  test('a keyless or failing embed publishes the index without vectors and removes old ones', async () => {
    const { readReceipt } = await import('../src/core/skills/resolver/build.ts');
    const h = tmp();
    writeFileSync(join(h, 'config.json'), JSON.stringify(CONFIG));
    const f = join(tmp('skvec-src-'), 'catalog.json');
    writeFileSync(f, JSON.stringify(SKILLS));
    embedder();
    await buildSkillIndex({ catalog: 'c', fromJson: f }, { home: h });
    expect(existsSync(join(h, 'skill-index', 'c', 'vectors.bin'))).toBe(true);
    embedder(async () => { throw new Error('HTTP 500'); });
    const r = await buildSkillIndex({ catalog: 'c', fromJson: f }, { home: h });
    expect(r.vectors).toEqual({ skipped: 'provider_error', attempts: 1 });
    expect(existsSync(join(h, 'skill-index', 'c', 'vectors.bin'))).toBe(false);
    __setEmbedTransportForTests(null);
    const keyless = await buildSkillIndex({ catalog: 'c', fromJson: f }, { home: h, env: { PATH: process.env.PATH } });
    expect(keyless.vectors).toEqual({ skipped: 'missing_key' });
    expect(readReceipt(h, 'c')!.index.index_hash).toBe(r.index.index_hash);
  });
});

describe('vectors in a turn', () => {
  test('a message that shares no word with the skill finds it by meaning; the output says why', async () => {
    embedder();
    const h = await home(CONFIG);
    const r = (await turn(h, 'can we go live with it today?')).output;
    expect(ids(r)).toEqual(['deploy']);
    expect(r.suggestions[0]).toMatchObject({ match_strength: 'vector', reason: 'meaning: cosine 1.000' });
    expect(r.vectors).toMatchObject({ used: true, model: 'voyage:voyage-4', fallback: null });
    expect(calls.at(-1)).toMatchObject({ inputType: 'query', texts: ['can we go live with it today?'] });
    const why = await turn(h, 'can we go live with it today?', {}, { explainTarget: 'deploy' });
    expect(why.explain).toMatchObject({ rank: null, in_block: true, vector: { cosine: 1, floor: VECTOR_FLOOR['voyage:voyage-4'] } });
    expect(validate(loadSchema('skill-resolver.v1.turn-output'), JSON.parse(JSON.stringify({ ...why.output, explain: why.explain })))).toEqual([]);
    __setEmbedTransportForTests(null);
    const words = (await turn(h, 'can we go live with it today?', {}, { env: { PATH: process.env.PATH } })).output;
    expect(words.block).toBe('');
  });

  test('words and vectors fuse by rank; the cosine floor replaces top_gate as the no-skill gate', async () => {
    embedder();
    const h = await home(CONFIG);
    const both = (await turn(h, 'summarize the notes from the production launch call')).output;
    expect(ids(both).slice(0, 2).sort()).toEqual(['deploy', 'notes']);
    const weakWords = (await turn(h, 'what is the weather like')).output;
    expect(weakWords.block).toBe('');
    __setVectorFloorForTests(0.01);
    expect((await turn(h, 'what is the weather like')).output.block).not.toBe('');
  });

  test('every failure answers with the word matcher, unchanged, and says why', async () => {
    embedder();
    const h = await home(CONFIG);
    __setEmbedTransportForTests(null);
    const words = (await turn(h, 'summarize meeting notes', {}, { env: { PATH: process.env.PATH } })).output;
    expect(words.vectors).toMatchObject({ used: false, fallback: { code: 'missing_key' } });
    embedder(async () => { throw new Error('HTTP 503'); });
    const failed = (await turn(h, 'summarize meeting notes')).output;
    expect(failed.vectors).toMatchObject({ used: false, fallback: { code: 'provider_error' } });
    expect(strip(failed)).toBe(strip(words));
    embedder(req => new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(new Error('aborted')))));
    const slow = (await turn(h, 'summarize meeting notes', {}, { deadlineMs: 300 })).output;
    expect(slow.vectors).toMatchObject({ used: false, fallback: { code: 'timeout' } });
    expect(strip(slow)).toBe(strip(words));
    embedder(async () => [[1, 0]]);
    const narrow = (await turn(h, 'summarize meeting notes')).output;
    expect(narrow.vectors).toMatchObject({ used: false, fallback: { code: 'stale_vectors' } });
    expect(narrow.meta.index_stale).toBe(true);
    writeFileSync(join(h, 'config.json'), JSON.stringify({ embedding_model: 'voyage:voyage-4-large' }));
    embedder();
    const moved = (await turn(h, 'summarize meeting notes')).output;
    expect(moved.vectors).toMatchObject({ used: false, model: 'voyage:voyage-4-large', fallback: { code: 'stale_vectors' } });
    expect(calls).toHaveLength(0);
    expect(strip(moved)).toBe(strip(words));
  });

  test('with no embedder the turn is byte-identical to a catalog built before vectors, and sends nothing', async () => {
    embedder();
    const h = await home(null);
    const r = (await turn(h, 'summarize meeting notes')).output;
    expect(r.vectors).toBeUndefined();
    expect(calls).toHaveLength(0);
    const ack = await home(CONFIG);
    calls.length = 0;
    expect((await turn(ack, 'thanks')).output.vectors).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  test('when the picker answers a small catalog, the message vector is not waited for', async () => {
    embedder(req => (req.inputType === 'query' ? new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(new Error('aborted')))) : Promise.resolve(req.texts.map(vectorOf))));
    const h = await home(CONFIG);
    writeFileSync(join(h, 'config.json'), JSON.stringify({ ...CONFIG, skills: { resolver: { router: true } } }));
    __setPickerTransportForTests(async () => ({ text: '{"needed": true, "skills": ["people"]}', refused: false, usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 10 } }));
    const t0 = performance.now();
    const r = (await turn(h, 'who is the new colleague', {}, { router: true })).output;
    expect(performance.now() - t0).toBeLessThan(900);
    expect(ids(r)).toEqual(['people']);
    expect(r.vectors).toMatchObject({ used: false, fallback: { code: 'not_needed' } });
  });

  test('outputs with vectors validate against the turn-output schema, and receipts against the receipt schema', async () => {
    embedder();
    const h = await home(CONFIG);
    const { readReceipt } = await import('../src/core/skills/resolver/build.ts');
    expect(validate(loadSchema('skill-resolver.v1.build-receipt'), JSON.parse(JSON.stringify(readReceipt(h, 'c'))))).toEqual([]);
    for (const m of ['can we go live today', 'what is the weather like', 'summarize meeting notes']) {
      expect(validate(loadSchema('skill-resolver.v1.turn-output'), JSON.parse(JSON.stringify((await turn(h, m)).output)))).toEqual([]);
    }
  });

  test('both schemas list every vector skip code the code can write', () => {
    const codes = (file: string): string[] => {
      const found: string[][] = [];
      const walk = (n: unknown): void => { if (n && typeof n === 'object') { const o = n as Record<string, unknown>; if (Array.isArray(o.enum) && o.enum.includes('no_embedder')) found.push(o.enum as string[]); Object.values(o).forEach(walk); } };
      walk(JSON.parse(readFileSync(join(import.meta.dir, '..', file), 'utf8')));
      expect(found).toHaveLength(1);
      return found[0]!;
    };
    expect(codes('docs/schemas/skill-resolver.v1.build-receipt.json')).toEqual([...EMBED_SKIP_CODES]);
    expect(codes('docs/schemas/skill-resolver.v1.turn-output.json')).toEqual([...EMBED_SKIP_CODES]);
  });

  test('the fusion constant is the brain search one, and every measured model has a floor', () => {
    expect(RRF_K).toBe(SEARCH_RRF_K);
    expect(vectorFloor('voyage:voyage-4')).toBe(VECTOR_FLOOR['voyage:voyage-4']!);
    expect(vectorFloor('voyage:voyage-code-4')).toBeNull();
  });
});

describe('vectors: freshness, the build lease and mixed catalogs', () => {
  test('a turn asks for a rebuild when the vectors no longer match the brain: model changed, embedder added, or a passing failure gone stale', async () => {
    embedder();
    const h = await home(CONFIG);
    const stale = async (at?: number) => (await turn(h, 'summarize meeting notes', {}, at === undefined ? {} : { now: () => at })).output.meta.index_stale;
    expect(await stale()).toBe(false);
    writeFileSync(join(h, 'config.json'), JSON.stringify({ embedding_model: 'voyage:voyage-4-large' }));
    expect(await stale()).toBe(true);
    writeFileSync(join(h, 'config.json'), JSON.stringify({ embedding_model: 'voyage:voyage-code-4' }));
    expect(await stale()).toBe(false);
    const added = await home(null);
    writeFileSync(join(added, 'config.json'), JSON.stringify(CONFIG));
    expect((await turn(added, 'summarize meeting notes')).output.meta.index_stale).toBe(true);
    const failed = tmp();
    writeFileSync(join(failed, 'config.json'), JSON.stringify(CONFIG));
    const f = join(tmp('skvec-src-'), 'catalog.json');
    writeFileSync(f, JSON.stringify(SKILLS));
    embedder(async () => { throw new Error('HTTP 503'); });
    const r = await buildSkillIndex({ catalog: 'c', fromJson: f }, { home: failed });
    expect(r.vectors).toEqual({ skipped: 'provider_error', attempts: 1 });
    const built = Date.parse(r.build.built_at);
    const at = async (ms: number) => (await turn(failed, 'summarize meeting notes', {}, { now: () => ms })).output.meta.index_stale;
    expect(await at(built + 60_000)).toBe(false);
    expect(await at(built + VECTOR_RETRY_MS)).toBe(true);
    let last = r;
    for (let n = 2; n <= VECTOR_RETRY_MAX; n++) {
      last = await buildSkillIndex({ catalog: 'c', fromJson: f }, { home: failed });
      expect(last.vectors).toEqual({ skipped: 'provider_error', attempts: n });
    }
    expect(await at(Date.parse(last.build.built_at) + 100 * VECTOR_RETRY_MS)).toBe(false);
    embedder();
    expect((await buildSkillIndex({ catalog: 'c', fromJson: f }, { home: failed })).vectors).toEqual({ model: 'voyage:voyage-4', dims: 4, count: 3 });
    embedder(async () => { throw new Error('HTTP 503'); });
    __setEmbedTransportForTests(null);
    expect((await turn(failed, 'summarize meeting notes', {}, { env: { PATH: process.env.PATH }, now: () => built + VECTOR_RETRY_MS })).output.meta.index_stale).toBe(false);
  });

  test('the build lease is not held while the skills are embedded', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    embedder(async req => { await gate; return req.texts.map(vectorOf); });
    const h = tmp();
    writeFileSync(join(h, 'config.json'), JSON.stringify(CONFIG));
    const f = join(tmp('skvec-src-'), 'catalog.json');
    writeFileSync(f, JSON.stringify(SKILLS));
    const build = buildSkillIndex({ catalog: 'c', fromJson: f }, { home: h });
    while (calls.length === 0) await Bun.sleep(5);
    const probe = tryAcquireLease(catalogFile(h, 'c', 'lock'), { purpose: 'probe', leaseMs: 1000 });
    expect('token' in probe).toBe(true);
    if ('token' in probe) releaseLease(probe);
    release();
    expect((await build).vectors).toEqual({ model: 'voyage:voyage-4', dims: 4, count: 3 });
  });

  test('a merged turn gates each catalog its own way: the floor where it has vectors, top_gate where it has none', async () => {
    embedder();
    const h = await home(CONFIG);
    const f = join(tmp('skvec-src-'), 'catalog.json');
    writeFileSync(f, JSON.stringify([{ id: 'weather', name: 'weather', description: 'Check the weather forecast for a city' }]));
    await buildSkillIndex({ catalog: 'b', fromJson: f, harness: 'openclaw' }, { home: h });
    const both = (await resolveSkills({ message: 'check the weather forecast for paris', harness: 'claude-code' }, { home: h, catalogs: ['c', 'b'] })).output;
    expect(ids(both)).toEqual(['weather']);
    expect((await turn(h, 'deploy the service now')).output.block).toBe('');
    __setEmbedTransportForTests(null);
    expect(ids((await turn(h, 'deploy the service now', {}, { env: { PATH: process.env.PATH } })).output)).toContain('deploy');
  });
});

describe('vectors: the provider request shapes', () => {
  async function serve(reply: unknown, run: (base: string) => Promise<number[][]>) {
    const seen: { path: string; headers: Headers; body: any }[] = [];
    const s = Bun.serve({ port: 0, async fetch(r) { seen.push({ path: new URL(r.url).pathname, headers: r.headers, body: await r.json() }); return Response.json(reply); } });
    try { return { seen, vectors: await run(`http://127.0.0.1:${s.port}`) }; } finally { s.stop(true); }
  }
  const req = (provider: 'voyage' | 'google', id: string, dims: number, baseUrl: string) => ({ provider, id, dims, texts: ['a', 'b'], inputType: 'query' as const, signal: new AbortController().signal, baseUrl });

  test('voyage: /v1/embeddings with input_type and output_dimension; replies reordered by index', async () => {
    const { seen, vectors } = await serve({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }, base => embedOverHttp(req('voyage', 'voyage-4', 1024, base), 'k-test'));
    expect(seen[0]!.path).toBe('/v1/embeddings');
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer k-test');
    expect(seen[0]!.body).toEqual({ model: 'voyage-4', input: ['a', 'b'], input_type: 'query', output_dimension: 1024 });
    expect(vectors).toEqual([[1, 0], [0, 1]]);
  });

  test('google: batchEmbedContents with taskType and outputDimensionality', async () => {
    const { seen, vectors } = await serve({ embeddings: [{ values: [1, 0] }, { values: [0, 1] }] }, base => embedOverHttp(req('google', 'gemini-embedding-001', 768, base), 'k-test'));
    expect(seen[0]!.path).toBe('/v1beta/models/gemini-embedding-001:batchEmbedContents');
    expect(seen[0]!.headers.get('x-goog-api-key')).toBe('k-test');
    expect(seen[0]!.body.requests[1]).toEqual({ model: 'models/gemini-embedding-001', content: { parts: [{ text: 'b' }] }, taskType: 'RETRIEVAL_QUERY', outputDimensionality: 768 });
    expect(vectors).toEqual([[1, 0], [0, 1]]);
  });
});


describe('vectors: build batches', () => {
  const big = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: `s${i}`, description: 'Ship the service', body: 'x '.repeat(4000) }));
  async function build(skills: unknown[]) {
    const h = tmp();
    writeFileSync(join(h, 'config.json'), JSON.stringify(CONFIG));
    const f = join(tmp('skvec-src-'), 'catalog.json');
    writeFileSync(f, JSON.stringify(skills));
    return { h, r: await buildSkillIndex({ catalog: 'c', fromJson: f }, { home: h }) };
  }

  test('each request stays under the character budget', async () => {
    embedder();
    const { r } = await build(big(40));
    expect(r.vectors).toEqual({ model: 'voyage:voyage-4', dims: 4, count: 40 });
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) expect(c.texts.join('').length).toBeLessThanOrEqual(BUILD_BATCH_CHARS);
  });

  test('one failed request stops the rest: no request starts after the build gave up', async () => {
    embedder(async req => { if (calls.length === 1) throw new Error('HTTP 429'); await Bun.sleep(5); return req.texts.map(vectorOf); });
    const { r } = await build(big(200));
    expect(r.vectors).toEqual({ skipped: 'provider_error', attempts: 1 });
    const sent = calls.length;
    await Bun.sleep(100);
    expect(calls.length).toBe(sent);
    expect(sent).toBeLessThan(10);
  });

  test('an empty catalog has nothing to embed and never asks for a rebuild', async () => {
    embedder();
    const { h, r } = await build([]);
    expect(r.vectors).toEqual({ skipped: 'not_needed' });
    expect(calls).toHaveLength(0);
    expect((await turn(h, 'summarize meeting notes')).output.meta.index_stale).toBe(false);
  });
});


describe('vectors: zero replies, the file cap, a removed catalog and the plain explanation', () => {
  async function source(skills: unknown[]): Promise<string> {
    const f = join(tmp('skvec-src-'), 'catalog.json');
    writeFileSync(f, JSON.stringify(skills));
    return f;
  }

  test('a zero vector is a bad reply: the build keeps no vectors and the turn answers with words', async () => {
    embedder(async req => req.texts.map(() => [0, 0, 0, 0]));
    const h = tmp();
    writeFileSync(join(h, 'config.json'), JSON.stringify(CONFIG));
    const r = await buildSkillIndex({ catalog: 'c', fromJson: await source(SKILLS) }, { home: h });
    expect(r.vectors).toEqual({ skipped: 'bad_reply', attempts: 1 });
    expect(existsSync(join(h, 'skill-index', 'c', 'vectors.bin'))).toBe(false);
    embedder();
    const good = await home(CONFIG);
    __setEmbedTransportForTests(null);
    const words = (await turn(good, 'deploy the service', {}, { env: { PATH: process.env.PATH } })).output;
    embedder(async req => req.texts.map(() => [0, 0, 0, 0]));
    const zero = (await turn(good, 'deploy the service')).output;
    expect(zero.vectors).toMatchObject({ used: false, fallback: { code: 'bad_reply' } });
    expect(strip(zero)).toBe(strip(words));
  });

  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${String(i).padStart(4, '0')}`, name: `s${i}`, description: 'Ship the service' }));

  test('the file cap counts the header: a catalog whose file would pass it is refused before any request when the width is configured', async () => {
    embedder();
    const h = tmp();
    writeFileSync(join(h, 'config.json'), JSON.stringify({ embedding_model: 'voyage:voyage-4', embedding_dimensions: 4096 }));
    const r = await buildSkillIndex({ catalog: 'c', fromJson: await source(many(4095)) }, { home: h });
    expect(4095 * 4096 * 4 + 8).toBeLessThan(64 * 1024 * 1024);
    expect(r.vectors).toEqual({ skipped: 'too_many_skills' });
    expect(calls).toHaveLength(0);
  });

  test('with no configured width the first reply sizes the file and the rest of the requests are not sent', async () => {
    embedder(async req => req.texts.map(() => Array.from({ length: 4096 }, (_, i) => (i === 0 ? 1 : 0))));
    const h = tmp();
    writeFileSync(join(h, 'config.json'), JSON.stringify({ embedding_model: 'voyage:voyage-4' }));
    const r = await buildSkillIndex({ catalog: 'c', fromJson: await source(many(4095)) }, { home: h });
    expect(r.vectors).toEqual({ skipped: 'too_many_skills' });
    expect(calls.length).toBeLessThanOrEqual(4);
  });

  test('a catalog removed, or removed and made again, while its skills are embedded is not written back', async () => {
    const { removeSkillIndex } = await import('../src/core/skills/resolver/index.ts');
    const h = tmp();
    writeFileSync(join(h, 'config.json'), JSON.stringify(CONFIG));
    const f = await source(SKILLS);
    embedder(async req => { if (calls.length === 1) await removeSkillIndex('c', { home: h }); return req.texts.map(vectorOf); });
    await expect(buildSkillIndex({ catalog: 'c', fromJson: f }, { home: h })).rejects.toMatchObject({ code: 'skill_index_removed' });
    expect(existsSync(join(h, 'skill-index', 'c'))).toBe(false);
    const dir = join(h, 'skill-index', 'c');
    embedder(async req => {
      if (calls.length === 1) { await removeSkillIndex('c', { home: h }); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'replacement'), 'x'); }
      return req.texts.map(vectorOf);
    });
    await expect(buildSkillIndex({ catalog: 'c', fromJson: f }, { home: h })).rejects.toMatchObject({ code: 'skill_index_removed' });
    expect(existsSync(join(dir, 'replacement'))).toBe(true);
    expect(existsSync(join(dir, 'index.bin'))).toBe(false);
    expect(existsSync(join(dir, 'receipt.json'))).toBe(false);
  });

  test('plain --explain-target prints the cosine and the floor', async () => {
    embedder();
    const h = await home(CONFIG);
    const { explainText } = await import('../src/commands/skill-resolver.ts');
    const why = await turn(h, 'can we go live with it today?', {}, { explainTarget: 'deploy' });
    expect(explainText(why.explain!)).toContain(`meaning: cosine 1.000, floor ${VECTOR_FLOOR['voyage:voyage-4']}`);
  });
});

