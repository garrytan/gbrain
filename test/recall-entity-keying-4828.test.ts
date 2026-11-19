/**
 * #4828: recall answered "No matching facts." while the entity's facts were
 * saved. Two shapes, both local CLI, PGLite only, synthetic names:
 *  - a fact saved before its page existed is keyed by the bare name
 *    (`acme-example`), the page is `companies/acme-example`, and the local
 *    CLI read only the page slug (the recall op already read siblings and the
 *    title subject);
 *  - `foresights recall "<name> <topic>"` resolved the whole phrase as one
 *    entity and grepped it as one literal, so neither matched.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runRecall, entitySplitSpans, rankByTopic } from '../src/commands/recall.ts';
import { factEntitySlugs } from '../src/core/mentions/siblings.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { FactRow } from '../src/core/engine.ts';

let engine: PGLiteEngine;
const origOut = process.stdout.write.bind(process.stdout);
const origErr = process.stderr.write.bind(process.stderr);

async function recall(args: string[]): Promise<{ facts: string[]; err: string }> {
  let out = '';
  let err = '';
  process.stdout.write = ((c: string | Uint8Array) => { out += typeof c === 'string' ? c : Buffer.from(c).toString(); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => { err += typeof c === 'string' ? c : Buffer.from(c).toString(); return true; }) as typeof process.stderr.write;
  try {
    await runRecall(engine, [...args, '--json', '--source', 'default']);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { facts: (JSON.parse(out) as { facts: Array<{ fact: string }> }).facts.map(f => f.fact), err };
}

const fact = (fact: string, entity_slug: string, valid_from?: Date) =>
  engine.insertFact({ fact, kind: 'fact', entity_slug, source: 'test', visibility: 'world', ...(valid_from ? { valid_from } : {}) } as never, { source_id: 'default' });

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => {
  await engine.disconnect();
});
beforeEach(async () => {
  await resetPgliteState(engine);
});
afterEach(() => {
  _resetCliExitVerdictForTests();
  process.exitCode = 0;
});

describe('facts keyed by the bare basename', () => {
  beforeEach(async () => {
    await engine.putPage('companies/acme-example', { title: 'Acme Example Holdings', type: 'company', compiled_truth: 'A company.' } as never);
    await fact('raised a seed round', 'acme-example', new Date('2026-01-01'));
    await fact('hired a new CFO', 'companies/acme-example', new Date('2026-02-01'));
  });

  test('recall <page slug> shows facts saved under the bare basename too, newest first', async () => {
    const r = await recall(['companies/acme-example']);
    expect(r.facts).toEqual(['hired a new CFO', 'raised a seed round']);
  });

  test('--entity reads the same slugs', async () => {
    expect((await recall(['--entity', 'companies/acme-example'])).facts).toEqual(['hired a new CFO', 'raised a seed round']);
  });

  test('a basename another page claims is not read', async () => {
    await engine.putPage('people/acme-example', { title: 'Acme Example', type: 'person', compiled_truth: 'A person.' } as never);
    expect(await factEntitySlugs(engine, 'default', 'companies/acme-example')).not.toContain('acme-example');
    expect((await recall(['companies/acme-example'])).facts).toEqual(['hired a new CFO']);
  });

  test('a page at the bare slug itself claims it', async () => {
    await engine.putPage('acme-example', { title: 'Acme notes', type: 'note', compiled_truth: 'Notes.' } as never);
    expect(await factEntitySlugs(engine, 'default', 'companies/acme-example')).not.toContain('acme-example');
  });
});

describe('a name followed by topic words', () => {
  beforeEach(async () => {
    await engine.putPage('people/alice-example', { title: 'Alice Example', type: 'person', compiled_truth: 'Founder.' } as never);
    await fact('prefers morning meetings', 'people/alice-example', new Date('2026-03-01'));
    await fact('pricing for the enterprise plan is per seat', 'people/alice-example', new Date('2026-01-01'));
    await fact('unrelated pricing note', 'people/bob-example', new Date('2026-03-02'));
  });

  test('the leading name resolves; its facts show, topic matches first, with a note', async () => {
    const r = await recall(['alice example enterprise pricing']);
    expect(r.facts).toEqual(['pricing for the enterprise plan is per seat', 'prefers morning meetings']);
    expect(r.err).toContain("'alice example' is people/alice-example");
    expect(r.err).toContain('foresights recall --entity people/alice-example');
  });

  test('a trailing name works too', async () => {
    const r = await recall(['enterprise pricing Alice Example']);
    expect(r.facts).toEqual(['pricing for the enterprise plan is per seat', 'prefers morning meetings']);
    expect(r.err).toContain("'Alice Example' is people/alice-example");
  });

  test('a first name only one page expands to resolves; a shared one does not', async () => {
    expect((await recall(['alice enterprise pricing'])).facts).toEqual(['pricing for the enterprise plan is per seat', 'prefers morning meetings']);
    await engine.putPage('people/alice-other', { title: 'Alice Other', type: 'person', compiled_truth: 'Investor.' } as never);
    expect((await recall(['alice enterprise pricing'])).facts).not.toContain('prefers morning meetings');
  });

  test('a leading name that is only a page alias still resolves', async () => {
    await engine.putPage('people/robert-example', { title: 'Robert Example', type: 'person', compiled_truth: 'Advisor.' } as never);
    await engine.setPageAliases('people/robert-example', 'default', ['bobby example']);
    await fact('prefers tea at board meetings', 'people/robert-example', new Date('2026-03-03'));
    const r = await recall(['Bobby Example board']);
    expect(r.facts).toEqual(['prefers tea at board meetings']);
    expect(r.err).toContain("'Bobby Example' is people/robert-example");
  });

  test('an explicit --entity is never split or widened to text', async () => {
    const r = await recall(['--entity', 'alice example enterprise pricing']);
    expect(r.facts).toEqual([]);
    expect(r.err).not.toContain('is people/alice-example');
  });

  test('a single-word positional keeps its text fallback', async () => {
    expect((await recall(['morning'])).facts).toEqual(['prefers morning meetings']);
  });
});

describe('pure helpers', () => {
  test('entitySplitSpans tries the longest leading and trailing names first', () => {
    expect(entitySplitSpans('a b c d').map(s => s.name)).toEqual(['a b c', 'b c d', 'a b', 'c d', 'a', 'd']);
    expect(entitySplitSpans('a b')).toEqual([{ name: 'a', topic: 'b' }, { name: 'b', topic: 'a' }]);
  });

  test('rankByTopic keeps recency order among equal matches', () => {
    const rows = ['x one', 'pricing two', 'y three', 'priced four'].map((f, i) => ({ id: i, fact: f }) as unknown as FactRow);
    expect(rankByTopic(rows, 'pricing').map(r => r.fact)).toEqual(['pricing two', 'priced four', 'x one', 'y three']);
  });
});
