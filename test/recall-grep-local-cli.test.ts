/**
 * gbrain#5607 — `gbrain recall --grep` on the local (non-thin-client) path
 * must filter in SQL, BEFORE the LIMIT.
 *
 * fetchRowsLocal used to fetch `limit` rows and leave grep to a client-side
 * post-limit filter, so any match older than the newest-N window reported
 * "No matching facts." while the fact existed and was active — and
 * `--limit` caps at 100, so older facts were unreachable.
 *
 * Seed order matters: the needle goes in FIRST, then `limit`-plus fillers,
 * so the needle falls outside the newest-N window — a post-limit filter
 * finds nothing. PGLite-only; no DATABASE_URL, no API keys.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runRecall } from '../src/commands/recall.ts';
import { OperationError } from '../src/core/ops/contract.ts';

let engine: PGLiteEngine;
const origWrite = process.stdout.write.bind(process.stdout);
let captured = '';

const SRC = 'default';
const FILLER = 10;
const LIMIT = 5;

async function recallJson(args: string[]): Promise<{ facts: Array<{ fact: string }>; total: number }> {
  captured = '';
  await runRecall(engine, [...args, '--json', '--source', SRC]);
  return JSON.parse(captured);
}

async function seed(opts: { entity: string; session?: string }): Promise<string> {
  const needle = `g5607 needle ${opts.entity}`;
  await engine.insertFact(
    { fact: needle, kind: 'fact', entity_slug: opts.entity, source: 'test', source_session: opts.session },
    { source_id: SRC },
  );
  for (let i = 0; i < FILLER; i++) {
    await engine.insertFact(
      { fact: `g5607 filler ${i} ${opts.entity} (no match)`, kind: 'fact', entity_slug: opts.entity, source: 'test', source_session: opts.session },
      { source_id: SRC },
    );
  }
  return needle;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  process.stdout.write = origWrite;
});

beforeEach(() => {
  captured = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
});

describe('gbrain#5607 — local recall --grep filters in SQL before LIMIT', () => {
  test('rejects malformed --limit values and accepts a positive integer', async () => {
    // Agent contract v1: an invalid_params usage error (exit 2 through renderCliError).
    for (const value of ['3x', 'abc', '0']) {
      const error = await runRecall(engine, ['--limit', value]).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).code).toBe('invalid_params');
      expect((error as OperationError).message).toContain(`got "${value}"`);
    }
    const needle = await seed({ entity: 'g5607-limit-valid' });
    const out = await recallJson(['--grep', needle, '--limit', '3']);
    expect(out.facts.map(f => f.fact)).toEqual([needle]);
    await engine.executeRaw(`DELETE FROM facts WHERE entity_slug='g5607-limit-valid'`);
  });

  test('needle older than the newest-N window is still found (no-filter arm)', async () => {
    const needle = await seed({ entity: 'g5607-a' });
    const out = await recallJson(['--grep', 'g5607 needle', '--limit', String(LIMIT)]);
    expect(out.total).toBe(1);
    expect(out.facts[0].fact).toBe(needle);
    await engine.executeRaw(`DELETE FROM facts WHERE entity_slug='g5607-a'`);
  });

  test('entity arm: --grep narrows entity rows in SQL too', async () => {
    const needle = await seed({ entity: 'g5607-b' });
    const out = await recallJson(['g5607-b', '--grep', 'g5607 needle', '--limit', String(LIMIT)]);
    expect(out.total).toBe(1);
    expect(out.facts[0].fact).toBe(needle);
    await engine.executeRaw(`DELETE FROM facts WHERE entity_slug='g5607-b'`);
  });

  test('session arm: --grep reaches facts outside the newest-N window', async () => {
    const needle = await seed({ entity: 'g5607-c', session: 'g5607-sess' });
    const out = await recallJson(['--session', 'g5607-sess', '--grep', 'g5607 needle', '--limit', String(LIMIT)]);
    expect(out.total).toBe(1);
    expect(out.facts[0].fact).toBe(needle);
    await engine.executeRaw(`DELETE FROM facts WHERE entity_slug='g5607-c'`);
  });

  test('non-matching grep returns empty, not the unfiltered window', async () => {
    await seed({ entity: 'g5607-d' });
    const out = await recallJson(['--grep', 'absent-needle-xyz', '--limit', String(LIMIT)]);
    expect(out.total).toBe(0);
    await engine.executeRaw(`DELETE FROM facts WHERE entity_slug='g5607-d'`);
  });

  test('since arm: --grep reaches facts outside the newest-N window', async () => {
    const needle = await seed({ entity: 'g5607-e' });
    const out = await recallJson(['--since', '1 day', '--grep', 'g5607 needle', '--limit', String(LIMIT)]);
    expect(out.facts.map(f => f.fact)).toEqual([needle]);
    await engine.executeRaw(`DELETE FROM facts WHERE entity_slug='g5607-e'`);
  });

  test('LIKE metacharacters in --grep match literally', async () => {
    await engine.insertFact({ fact: 'g5607 rollout at 50%_done', kind: 'fact', entity_slug: 'g5607-f', source: 'test' }, { source_id: SRC });
    await engine.insertFact({ fact: 'g5607 rollout at 50 and more done', kind: 'fact', entity_slug: 'g5607-f', source: 'test' }, { source_id: SRC });
    const out = await recallJson(['--grep', '50%_d', '--limit', String(LIMIT)]);
    expect(out.facts.map(f => f.fact)).toEqual(['g5607 rollout at 50%_done']);
    await engine.executeRaw(`DELETE FROM facts WHERE entity_slug='g5607-f'`);
  });
});
