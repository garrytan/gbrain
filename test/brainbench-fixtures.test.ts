/**
 * BrainBench fixture loader/validator — the sealed-gold seal and the corpus
 * integrity rules. The committed corpus must load clean; every documented
 * rejection class must actually reject.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FixtureValidationError,
  loadCorpus,
  validateFixture,
  validateGold,
} from '../src/eval/brainbench/fixtures.ts';
import { toPublicTurn } from '../src/eval/brainbench/types.ts';

const FIXTURES = 'evals/brainbench/fixtures';
const GOLD = 'evals/brainbench/gold';

const BASE_FIXTURE = {
  schema_version: 1,
  fixture_id: 'test-001',
  suites: ['know-to-ask'],
  seed_pages: [{ slug: 'people/alice-example', content: '---\ntitle: Alice Example\n---\nA.\n' }],
  turns: [{ turn_id: 1, role: 'user', text: 'Hi Alice Example' }],
};
const BASE_GOLD = {
  fixture_id: 'test-001',
  turns: { '1': { should_retrieve: true, gold_slugs: ['people/alice-example'] } },
};

describe('committed corpus', () => {
  test('loads clean, hash is stable across loads, pairs are complete', async () => {
    const a = await loadCorpus(FIXTURES, GOLD);
    const b = await loadCorpus(FIXTURES, GOLD);
    expect(a.fixtures.length).toBeGreaterThanOrEqual(141);
    expect(a.fixtures_hash).toBe(b.fixtures_hash);
    // every continuity fixture's partner exists (loader enforces; assert shape)
    const pairs = new Map<string, number>();
    for (const { fixture } of a.fixtures) {
      if (fixture.continuity) pairs.set(fixture.continuity.pair_id, (pairs.get(fixture.continuity.pair_id) ?? 0) + 1);
    }
    for (const [pairId, n] of pairs) {
      expect(`${pairId}:${n}`).toBe(`${pairId}:2`);
    }
  });

  test('_ledger.json counts match the committed corpus (drift guard)', async () => {
    const ledger = JSON.parse(readFileSync('evals/brainbench/_ledger.json', 'utf-8'));
    const genFixtures = readdirSync(FIXTURES).filter((f) => f.startsWith('gen-') && f.endsWith('.fixture.json'));
    expect(genFixtures.length).toBe(ledger.generated_fixtures);
    const corpus = await loadCorpus(FIXTURES, GOLD);
    const holdout = corpus.fixtures.filter((f) => f.fixture.holdout).length;
    expect(holdout).toBe(ledger.holdout_fixtures);
    const goldTurns = corpus.fixtures
      .filter((f) => f.fixture.fixture_id.startsWith('gen-'))
      .reduce((n, f) => n + Object.keys(f.gold.turns).length, 0);
    expect(goldTurns).toBe(ledger.gold_turns);
  });

  test('holdout split: continuity pairs move together (no orphaned partner in gate mode)', async () => {
    const corpus = await loadCorpus(FIXTURES, GOLD);
    const holdoutByPair = new Map<string, Set<boolean>>();
    for (const { fixture } of corpus.fixtures) {
      if (!fixture.continuity) continue;
      const set = holdoutByPair.get(fixture.continuity.pair_id) ?? new Set<boolean>();
      set.add(!!fixture.holdout);
      holdoutByPair.set(fixture.continuity.pair_id, set);
    }
    for (const [pairId, set] of holdoutByPair) {
      expect(`${pairId}:${set.size}`).toBe(`${pairId}:1`);
    }
  });

  test('published JSON Schemas exist and parse (foreign-runner contract)', () => {
    for (const f of ['fixture', 'gold', 'result', 'baseline']) {
      const schema = JSON.parse(readFileSync(`evals/brainbench/schema/${f}.schema.json`, 'utf-8'));
      expect(schema.$schema).toContain('json-schema.org');
    }
  });
});

describe('validator rejection classes', () => {
  test('SEALED GOLD: a `gold` key inside a fixture turn is a hard error with a pointer', () => {
    const bad = structuredClone(BASE_FIXTURE) as Record<string, unknown>;
    (bad.turns as Array<Record<string, unknown>>)[0].gold = { should_retrieve: true };
    expect(() => validateFixture('f.json', bad)).toThrow(/gold is SEALED/);
  });

  test('unknown fixture key rejected', () => {
    const bad = { ...structuredClone(BASE_FIXTURE), surprise: 1 };
    expect(() => validateFixture('f.json', bad)).toThrow(FixtureValidationError);
  });

  test('duplicate turn_id rejected', () => {
    const bad = structuredClone(BASE_FIXTURE) as typeof BASE_FIXTURE;
    bad.turns.push({ turn_id: 1, role: 'user', text: 'again' });
    expect(() => validateFixture('f.json', bad)).toThrow(/duplicate turn_id/);
  });

  test('write-back fixture without ts on every turn rejected', () => {
    const bad = structuredClone(BASE_FIXTURE) as Record<string, unknown>;
    bad.suites = ['write-back'];
    expect(() => validateFixture('f.json', bad)).toThrow(/requires ts/);
  });

  test('continuity WRITER without ts rejected (runs the write-back pipeline)', () => {
    const bad = structuredClone(BASE_FIXTURE) as Record<string, unknown>;
    bad.continuity = { pair_id: 'p1', pair_role: 'writer' };
    expect(() => validateFixture('f.json', bad)).toThrow(/requires ts/);
  });

  test('gold for a turn that does not exist rejected', () => {
    const fixture = validateFixture('f.json', structuredClone(BASE_FIXTURE));
    const badGold = structuredClone(BASE_GOLD) as Record<string, unknown>;
    (badGold.turns as Record<string, unknown>)['99'] = { should_retrieve: false };
    expect(() => validateGold('g.json', badGold, fixture)).toThrow(/no matching fixture turn/);
  });

  test('retrieval-suite gold with should_retrieve=true and empty gold_slugs rejected (unpassable item)', () => {
    const fixture = validateFixture('f.json', structuredClone(BASE_FIXTURE));
    const badGold = structuredClone(BASE_GOLD) as { fixture_id: string; turns: Record<string, Record<string, unknown>> };
    badGold.turns['1'] = { should_retrieve: true, gold_slugs: [] };
    expect(() => validateGold('g.json', badGold, fixture)).toThrow(/must be non-empty/);
    delete badGold.turns['1'].gold_slugs;
    badGold.turns['1'].gold_facts = [
      { gist: 'x', fact: 'y', entity_slug: null, match_keywords: ['k'] },
    ];
    expect(() => validateGold('g.json', badGold, fixture)).toThrow(/must be non-empty/);
  });

  test('gold_facts without match_keywords rejected', () => {
    const fixture = validateFixture('f.json', structuredClone(BASE_FIXTURE));
    const badGold = structuredClone(BASE_GOLD) as { turns: Record<string, Record<string, unknown>> };
    badGold.turns['1'].gold_facts = [{ gist: 'x', fact: 'y', entity_slug: null, match_keywords: [] }];
    expect(() => validateGold('g.json', badGold, fixture)).toThrow(/match_keywords/);
  });
});

describe('loadCorpus integrity', () => {
  function writeTmp(files: Record<string, unknown>): { fixtures: string; gold: string } {
    const root = mkdtempSync(join(tmpdir(), 'bb-fixtures-'));
    const fdir = join(root, 'fixtures');
    const gdir = join(root, 'gold');
    rmSync(fdir, { recursive: true, force: true });
    rmSync(gdir, { recursive: true, force: true });
    require('node:fs').mkdirSync(fdir, { recursive: true });
    require('node:fs').mkdirSync(gdir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      const dir = name.endsWith('.gold.json') ? gdir : fdir;
      writeFileSync(join(dir, name), JSON.stringify(content, null, 2));
    }
    return { fixtures: fdir, gold: gdir };
  }

  test('fixture without a gold file rejected', async () => {
    const dirs = writeTmp({ 'test-001.fixture.json': BASE_FIXTURE });
    await expect(loadCorpus(dirs.fixtures, dirs.gold)).rejects.toThrow(/no gold file/);
  });

  test('orphan gold file rejected (renamed fixture must rename its gold)', async () => {
    const dirs = writeTmp({
      'test-001.fixture.json': BASE_FIXTURE,
      'test-001.gold.json': BASE_GOLD,
      'ghost.gold.json': { fixture_id: 'ghost', turns: {} },
    });
    await expect(loadCorpus(dirs.fixtures, dirs.gold)).rejects.toThrow(/orphan gold/);
  });

  test('incomplete continuity pair rejected', async () => {
    const writer = {
      ...structuredClone(BASE_FIXTURE),
      fixture_id: 'pair-writer',
      continuity: { pair_id: 'p1', pair_role: 'writer' },
      turns: [{ turn_id: 1, role: 'user', text: 'decide', ts: '2026-01-01T10:00:00Z' }],
    };
    const dirs = writeTmp({
      'pair-writer.fixture.json': writer,
      'pair-writer.gold.json': { fixture_id: 'pair-writer', turns: {} },
    });
    await expect(loadCorpus(dirs.fixtures, dirs.gold)).rejects.toThrow(/incomplete/);
  });

  test('gold edit changes fixtures_hash (gate keys off BOTH dirs)', async () => {
    const dirs = writeTmp({
      'test-001.fixture.json': BASE_FIXTURE,
      'test-001.gold.json': BASE_GOLD,
    });
    const before = (await loadCorpus(dirs.fixtures, dirs.gold)).fixtures_hash;
    const edited = structuredClone(BASE_GOLD) as typeof BASE_GOLD;
    edited.turns['1'].should_retrieve = false;
    writeFileSync(join(dirs.gold, 'test-001.gold.json'), JSON.stringify(edited, null, 2));
    const after = (await loadCorpus(dirs.fixtures, dirs.gold)).fixtures_hash;
    expect(after).not.toBe(before);
  });
});

describe('PublicTurn sanitizer (the adapter-visible boundary)', () => {
  test('toPublicTurn picks exactly the public fields — smuggled keys dropped', () => {
    const dirty = {
      turn_id: 1,
      role: 'user' as const,
      text: 'hello',
      ts: '2026-01-01T00:00:00Z',
      gold: { should_retrieve: true },
      anything: 'else',
    };
    const pub = toPublicTurn(dirty as never);
    expect(Object.keys(pub).sort()).toEqual(['role', 'text', 'ts', 'turn_id']);
    expect((pub as unknown as Record<string, unknown>).gold).toBeUndefined();
  });
});
