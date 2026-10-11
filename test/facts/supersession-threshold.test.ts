/**
 * Per-model fact supersession threshold (supersession-threshold.ts): table
 * lookup and operator overrides; voyage-4@1024 decides exactly as the old
 * fixed 0.95 rule did; an uncalibrated model never supersedes by cosine,
 * keeps exact-text dedup, and its pair reaches the conflict review sweep.
 * PGLite in-memory, no provider calls.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { decideSingleFact } from '../../src/core/facts/single-prepare.ts';
import { writeSingleFact } from '../../src/core/facts/write-single.ts';
import { conflictNeighbours, factsAfter } from '../../src/core/ai/decide/proposals-store.ts';
import {
  SUPERSESSION_CALIBRATIONS, SUPERSESSION_THRESHOLDS_KEY, calibrationKey, parseThresholdOverrides, resolveSupersessionThreshold,
} from '../../src/core/facts/supersession-threshold.ts';

const DIM = 1024;
const VOYAGE = 'voyage:voyage-4';
const OPENAI = 'openai:text-embedding-3-large';
let engine: PGLiteEngine;

beforeAll(async () => {
  resetGateway();
  configureGateway({ embedding_model: VOYAGE, embedding_dimensions: DIM, env: { VOYAGE_API_KEY: 'test-voyage-key' } });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  __setEmbedTransportForTests(null);
  await engine.disconnect();
  resetGateway();
});

/** Unit vector whose cosine to `vec(1)` is exactly `c`. */
const vec = (c: number, axis = 1): Float32Array => {
  const a = new Float32Array(DIM);
  a[0] = c;
  a[axis] = Math.sqrt(1 - c * c);
  return a;
};

let n = 0;
async function seedPair(model: string, cosine: number) {
  const slug = `companies/threshold-${++n}`;
  const old = await engine.insertFact({ fact: `Threshold Example ${n} has 40 employees.`, kind: 'fact', entity_slug: slug, visibility: 'world', source: 'test',
    embedding: vec(1), embedding_model: model }, { source_id: 'default' });
  const decide = (fact = `Threshold Example ${n} has 45 employees.`) =>
    decideSingleFact(engine, 'default', { fact, kind: 'fact', visibility: 'world', entity_slug: slug }, vec(cosine, 2), model);
  return { slug, oldId: old.id, decide, oldText: `Threshold Example ${n} has 40 employees.` };
}

describe('lookup', () => {
  test('voyage-4 at 1024 dimensions is calibrated at 0.95; other widths and models are not', () => {
    expect(SUPERSESSION_CALIBRATIONS['voyage:voyage-4@1024'].threshold).toBe(0.95);
    expect(resolveSupersessionThreshold(VOYAGE, 1024)).toEqual({ key: 'voyage:voyage-4@1024', threshold: 0.95, source: 'calibrated' });
    expect(resolveSupersessionThreshold('Voyage:Voyage-4', 1024).threshold).toBe(0.95);
    expect(resolveSupersessionThreshold(VOYAGE, 2048)).toEqual({ key: 'voyage:voyage-4@2048', threshold: null, source: 'uncalibrated' });
    expect(resolveSupersessionThreshold(OPENAI, 1536)).toEqual({ key: 'openai:text-embedding-3-large@1536', threshold: null, source: 'uncalibrated' });
    expect(resolveSupersessionThreshold(null, 1024).source).toBe('uncalibrated');
    expect(calibrationKey(' OpenAI:Text-Embedding-3-Large ', 1536)).toBe('openai:text-embedding-3-large@1536');
  });

  test('operator overrides win, "off" disables, malformed values are ignored', () => {
    const o = parseThresholdOverrides(JSON.stringify({ 'OpenAI:text-embedding-3-large@1536': 0.97, 'voyage:voyage-4@1024': 'off', 'x@1': 1.5, 'y@1': 'high', 'z@1': 0 }));
    expect([...o.entries()]).toEqual([['openai:text-embedding-3-large@1536', 0.97], ['voyage:voyage-4@1024', null]]);
    expect(resolveSupersessionThreshold(OPENAI, 1536, o)).toEqual({ key: 'openai:text-embedding-3-large@1536', threshold: 0.97, source: 'override' });
    expect(resolveSupersessionThreshold(VOYAGE, 1024, o)).toEqual({ key: 'voyage:voyage-4@1024', threshold: null, source: 'override' });
    for (const raw of [null, '', 'not json', '[1]', '"x"']) expect(parseThresholdOverrides(raw).size).toBe(0);
  });
});

describe('decideSingleFact', () => {
  test('voyage-4@1024 keeps the 0.95 boundary exactly', async () => {
    expect((await (await seedPair(VOYAGE, 0.9505)).decide()).status).toBe('superseded');
    expect((await (await seedPair(VOYAGE, 0.9495)).decide()).status).toBe('inserted');
    const near = await seedPair(VOYAGE, 0.99);
    const d = await near.decide();
    expect(d.status).toBe('superseded');
    expect(d.candidate?.id).toBe(near.oldId);
  });

  test('an uncalibrated model inserts instead of superseding, keeps exact-text dedup, and its pair reaches conflict review', async () => {
    const before = Number((await engine.executeRaw<{ m: number }>('SELECT COALESCE(MAX(id), 0) AS m FROM facts'))[0].m);
    const pair = await seedPair(OPENAI + '-uncal', 0.99);
    expect((await pair.decide()).status).toBe('inserted');
    expect((await pair.decide(pair.oldText)).status).toBe('duplicate');
    const added = await engine.insertFact({ fact: `Threshold Example ${n} has 45 employees.`, kind: 'fact', entity_slug: pair.slug, visibility: 'world', source: 'test',
      embedding: vec(0.99, 2), embedding_model: OPENAI + '-uncal' }, { source_id: 'default' });
    const swept = await factsAfter(engine, 'default', before, 100);
    expect(swept.map(f => Number(f.id))).toContain(added.id);
    const neighbours = await conflictNeighbours(engine, added.id, 'default');
    expect(neighbours.map(c => c.id)).toContain(pair.oldId);
    expect(neighbours.find(c => c.id === pair.oldId)!.similarity).toBeGreaterThan(0.98);
  });

  test('an operator threshold makes an uncalibrated model supersede; "off" stops a calibrated one', async () => {
    const pair = await seedPair(OPENAI + '-op', 0.97);
    await engine.setConfig(SUPERSESSION_THRESHOLDS_KEY, JSON.stringify({ [`${OPENAI}-op@${DIM}`]: 0.96, [`${VOYAGE}@${DIM}`]: 'off' }));
    try {
      expect((await pair.decide()).status).toBe('superseded');
      expect((await (await seedPair(VOYAGE, 0.99)).decide()).status).toBe('inserted');
    } finally {
      await engine.unsetConfig(SUPERSESSION_THRESHOLDS_KEY);
    }
  });
});

describe('writeSingleFact (unmanaged path)', () => {
  test('an uncalibrated model never supersedes, and identical text is still a duplicate', async () => {
    configureGateway({ embedding_model: OPENAI, embedding_dimensions: DIM, env: { OPENAI_API_KEY: 'sk-test-deterministic' } });
    __setEmbedTransportForTests((async (opts: { values: string[] }) => ({
      embeddings: opts.values.map(t => Array.from(t.includes('PAIR') ? vec(1) : vec(0.1, 3))),
    })) as never);
    try {
      const remember = (fact: string) => writeSingleFact(engine, 'default', { fact, provenance: 'test', entity: 'people/uncalibrated-example', kind: 'fact' });
      const a = await remember('PAIR alice works at acme-example');
      expect(a.status).toBe('inserted');
      const dup = await remember('PAIR alice works at acme-example');
      expect(dup.status).toBe('duplicate');
      expect(dup.id).toBe(a.id);
      const changed = await remember('PAIR alice left acme-example');
      expect(changed.status).toBe('inserted');
      expect(changed.id).not.toBe(a.id);
    } finally {
      __setEmbedTransportForTests(null);
      configureGateway({ embedding_model: VOYAGE, embedding_dimensions: DIM, env: { VOYAGE_API_KEY: 'test-voyage-key' } });
    }
  });
});
