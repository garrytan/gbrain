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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __setEmbedTransportForTests, EMBED_SKIP_CODES, type EmbedRequest } from '../src/core/skills/resolver/embed-http.ts';
import { __setPickerTransportForTests } from '../src/core/skills/resolver/router-http.ts';
import { buildSkillIndex, resolveSkills } from '../src/core/skills/resolver/index.ts';
import { __setVectorFloorForTests, RRF_K, skillVectorText, VECTOR_FLOOR, vectorFloor } from '../src/core/skills/resolver/vectors.ts';
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
    expect(r.vectors).toEqual({ skipped: 'provider_error' });
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
    expect((await turn(h, 'summarize meeting notes')).output.vectors).toMatchObject({ used: false, fallback: { code: 'stale_vectors' } });
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
