/**
 * BrainBench fixture loader + strict validator + corpus hash.
 *
 * Strictness is the seal: a fixture turn carrying a `gold` key (or any unknown
 * key) is a hard validation error, because the fixture file is the
 * adapter-visible surface — gold lives in the sealed gold dir only
 * (decision 22, gbrain-evals sealed-gold discipline).
 *
 * fixtures_hash covers BOTH fixture and gold files (sorted relative path +
 * content), so a gold-only edit invalidates baseline comparisons exactly like
 * a fixture edit (decision 4's same-hash vs corpus-bless modes key off it).
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ALL_SUITES,
  FIXTURE_SCHEMA_VERSION,
  type BrainBenchFixture,
  type BrainBenchSuite,
  type FixtureGold,
  type FixtureTurn,
  type LoadedCorpus,
  type LoadedFixture,
} from './types.ts';

export class FixtureValidationError extends Error {
  constructor(
    public readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = 'FixtureValidationError';
  }
}

const FIXTURE_KEYS = new Set([
  'schema_version', 'fixture_id', 'suites', 'category', 'holdout', 'sources',
  'active_source', 'seed_pages', 'seed_facts', 'turns', 'continuity',
]);
const TURN_KEYS = new Set(['turn_id', 'role', 'text', 'ts']);
const SEED_PAGE_KEYS = new Set(['slug', 'content', 'source_id']);
const SEED_FACT_KEYS = new Set(['fact', 'entity_slug', 'source', 'source_session', 'source_id']);
const GOLD_KEYS = new Set(['fixture_id', 'turns', 'continuity']);
const TURN_GOLD_KEYS = new Set(['should_retrieve', 'gold_slugs', 'acceptable_slugs', 'gold_facts']);
const GOLD_FACT_KEYS = new Set(['gist', 'fact', 'entity_slug', 'match_keywords', 'kind']);

function assertOnlyKeys(
  file: string,
  obj: Record<string, unknown>,
  allowed: Set<string>,
  where: string,
): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      const hint =
        k === 'gold'
          ? ' — gold is SEALED: it belongs in the gold dir (<fixture_id>.gold.json), never inline'
          : '';
      throw new FixtureValidationError(file, `unknown key "${k}" in ${where}${hint}`);
    }
  }
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export function validateFixture(file: string, raw: unknown): BrainBenchFixture {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new FixtureValidationError(file, 'fixture must be a JSON object');
  }
  const f = raw as Record<string, unknown>;
  assertOnlyKeys(file, f, FIXTURE_KEYS, 'fixture');

  if (f.schema_version !== FIXTURE_SCHEMA_VERSION) {
    throw new FixtureValidationError(
      file,
      `schema_version must be ${FIXTURE_SCHEMA_VERSION} (got ${JSON.stringify(f.schema_version)})`,
    );
  }
  if (typeof f.fixture_id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(f.fixture_id)) {
    throw new FixtureValidationError(file, 'fixture_id must be a kebab-case string');
  }
  if (!isStringArray(f.suites) || f.suites.length === 0) {
    throw new FixtureValidationError(file, 'suites must be a non-empty string array');
  }
  for (const s of f.suites) {
    if (!(ALL_SUITES as readonly string[]).includes(s)) {
      throw new FixtureValidationError(file, `unknown suite "${s}" (valid: ${ALL_SUITES.join(', ')})`);
    }
  }
  if (f.holdout !== undefined && typeof f.holdout !== 'boolean') {
    throw new FixtureValidationError(file, 'holdout must be boolean');
  }
  if (f.sources !== undefined && !isStringArray(f.sources)) {
    throw new FixtureValidationError(file, 'sources must be a string array');
  }
  if (f.active_source !== undefined && typeof f.active_source !== 'string') {
    throw new FixtureValidationError(file, 'active_source must be a string');
  }

  if (f.seed_pages !== undefined) {
    if (!Array.isArray(f.seed_pages)) throw new FixtureValidationError(file, 'seed_pages must be an array');
    for (const p of f.seed_pages as Array<Record<string, unknown>>) {
      assertOnlyKeys(file, p, SEED_PAGE_KEYS, 'seed_pages[]');
      if (typeof p.slug !== 'string' || !p.slug) throw new FixtureValidationError(file, 'seed_pages[].slug required');
      if (typeof p.content !== 'string' || !p.content) {
        throw new FixtureValidationError(file, `seed_pages[${p.slug}].content required`);
      }
    }
  }
  if (f.seed_facts !== undefined) {
    if (!Array.isArray(f.seed_facts)) throw new FixtureValidationError(file, 'seed_facts must be an array');
    for (const sf of f.seed_facts as Array<Record<string, unknown>>) {
      assertOnlyKeys(file, sf, SEED_FACT_KEYS, 'seed_facts[]');
      if (typeof sf.fact !== 'string' || !sf.fact) throw new FixtureValidationError(file, 'seed_facts[].fact required');
    }
  }

  if (!Array.isArray(f.turns) || f.turns.length === 0) {
    throw new FixtureValidationError(file, 'turns must be a non-empty array');
  }
  const seenTurnIds = new Set<number>();
  for (const t of f.turns as Array<Record<string, unknown>>) {
    assertOnlyKeys(file, t, TURN_KEYS, 'turns[]');
    if (typeof t.turn_id !== 'number' || !Number.isInteger(t.turn_id)) {
      throw new FixtureValidationError(file, 'turns[].turn_id must be an integer');
    }
    if (seenTurnIds.has(t.turn_id)) {
      throw new FixtureValidationError(file, `duplicate turn_id ${t.turn_id}`);
    }
    seenTurnIds.add(t.turn_id);
    if (t.role !== 'user' && t.role !== 'assistant') {
      throw new FixtureValidationError(file, `turns[${t.turn_id}].role must be user|assistant`);
    }
    if (typeof t.text !== 'string' || !t.text) {
      throw new FixtureValidationError(file, `turns[${t.turn_id}].text required`);
    }
    if (t.ts !== undefined && (typeof t.ts !== 'string' || Number.isNaN(Date.parse(t.ts)))) {
      throw new FixtureValidationError(file, `turns[${t.turn_id}].ts must be ISO 8601`);
    }
  }

  if (f.continuity !== undefined) {
    const c = f.continuity as Record<string, unknown>;
    assertOnlyKeys(file, c, new Set(['pair_id', 'pair_role']), 'continuity');
    if (typeof c.pair_id !== 'string' || !c.pair_id) {
      throw new FixtureValidationError(file, 'continuity.pair_id required');
    }
    if (c.pair_role !== 'writer' && c.pair_role !== 'reader') {
      throw new FixtureValidationError(file, 'continuity.pair_role must be writer|reader');
    }
  }

  // write-back fixtures (and continuity WRITERS, which run the write-back
  // pipeline to persist their decisions) need timestamps on every turn —
  // segmentation is time-based.
  const continuityRole = (f.continuity as Record<string, unknown> | undefined)?.pair_role;
  if ((f.suites as string[]).includes('write-back') || continuityRole === 'writer') {
    for (const t of f.turns as Array<Record<string, unknown>>) {
      if (t.ts === undefined) {
        throw new FixtureValidationError(
          file,
          `write-back fixture requires ts on every turn (missing on turn_id ${t.turn_id})`,
        );
      }
    }
  }

  return raw as BrainBenchFixture;
}

export function validateGold(file: string, raw: unknown, fixture: BrainBenchFixture): FixtureGold {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new FixtureValidationError(file, 'gold must be a JSON object');
  }
  const g = raw as Record<string, unknown>;
  assertOnlyKeys(file, g, GOLD_KEYS, 'gold');
  if (g.fixture_id !== fixture.fixture_id) {
    throw new FixtureValidationError(
      file,
      `gold.fixture_id "${String(g.fixture_id)}" does not match fixture "${fixture.fixture_id}"`,
    );
  }
  if (typeof g.turns !== 'object' || g.turns === null) {
    throw new FixtureValidationError(file, 'gold.turns must be an object keyed by turn_id');
  }
  const turnIds = new Set(fixture.turns.map((t: FixtureTurn) => String(t.turn_id)));
  const turnRoleById = new Map(fixture.turns.map((t: FixtureTurn) => [String(t.turn_id), t.role]));
  for (const [key, val] of Object.entries(g.turns as Record<string, unknown>)) {
    if (!turnIds.has(key)) {
      throw new FixtureValidationError(file, `gold.turns["${key}"] has no matching fixture turn`);
    }
    const tg = val as Record<string, unknown>;
    assertOnlyKeys(file, tg, TURN_GOLD_KEYS, `gold.turns["${key}"]`);
    if (typeof tg.should_retrieve !== 'boolean') {
      throw new FixtureValidationError(file, `gold.turns["${key}"].should_retrieve must be boolean`);
    }
    // Retrieval gold on ASSISTANT turns would never be scored — the harness
    // replays user turns only (adversarial finding: silent coverage loss).
    // Assistant-turn gold may carry gold_facts (write-back reads every turn)
    // but never a retrieval expectation.
    if (
      turnRoleById.get(key) === 'assistant' &&
      (tg.should_retrieve === true || tg.gold_slugs !== undefined || tg.acceptable_slugs !== undefined)
    ) {
      throw new FixtureValidationError(
        file,
        `gold.turns["${key}"] carries retrieval gold on an ASSISTANT turn — only user turns are replayed for retrieval scoring`,
      );
    }
    {
      // On a retrieval-suite fixture, should_retrieve=true REQUIRES non-empty
      // gold_slugs — a slug-less retrieve-turn is a guaranteed miss no harness
      // can pass (review finding: it silently poisons the failure rate).
      const retrievalSuites = fixture.suites.some(
        (s: BrainBenchSuite) => s === 'know-to-ask' || s === 'push',
      );
      if (
        retrievalSuites &&
        tg.should_retrieve &&
        (!isStringArray(tg.gold_slugs) || tg.gold_slugs.length === 0)
      ) {
        throw new FixtureValidationError(
          file,
          `gold.turns["${key}"].gold_slugs must be non-empty when should_retrieve=true on a retrieval-suite fixture (a slug-less retrieve turn is an unpassable gold item)`,
        );
      }
    }
    if (tg.gold_slugs !== undefined && !isStringArray(tg.gold_slugs)) {
      throw new FixtureValidationError(file, `gold.turns["${key}"].gold_slugs must be a string array`);
    }
    if (tg.acceptable_slugs !== undefined && !isStringArray(tg.acceptable_slugs)) {
      throw new FixtureValidationError(file, `gold.turns["${key}"].acceptable_slugs must be a string array`);
    }
    if (tg.gold_facts !== undefined) {
      if (!Array.isArray(tg.gold_facts)) {
        throw new FixtureValidationError(file, `gold.turns["${key}"].gold_facts must be an array`);
      }
      for (const gf of tg.gold_facts as Array<Record<string, unknown>>) {
        assertOnlyKeys(file, gf, GOLD_FACT_KEYS, `gold.turns["${key}"].gold_facts[]`);
        if (typeof gf.gist !== 'string' || !gf.gist) {
          throw new FixtureValidationError(file, 'gold_facts[].gist required');
        }
        if (typeof gf.fact !== 'string' || !gf.fact) {
          throw new FixtureValidationError(file, 'gold_facts[].fact required');
        }
        if (gf.entity_slug !== null && typeof gf.entity_slug !== 'string') {
          throw new FixtureValidationError(file, 'gold_facts[].entity_slug must be string or null');
        }
        if (!isStringArray(gf.match_keywords) || gf.match_keywords.length === 0) {
          throw new FixtureValidationError(file, 'gold_facts[].match_keywords must be non-empty');
        }
      }
    }
  }

  if (fixture.continuity) {
    const gc = g.continuity as Record<string, unknown> | undefined;
    if (fixture.continuity.pair_role === 'reader') {
      if (!gc) throw new FixtureValidationError(file, 'reader continuity fixture requires gold.continuity');
    }
    if (gc) {
      assertOnlyKeys(file, gc, new Set(['pair_id', 'decisions']), 'gold.continuity');
      if (gc.pair_id !== fixture.continuity.pair_id) {
        throw new FixtureValidationError(file, 'gold.continuity.pair_id mismatch');
      }
      if (!Array.isArray(gc.decisions) || gc.decisions.length === 0) {
        throw new FixtureValidationError(file, 'gold.continuity.decisions must be non-empty');
      }
      for (const d of gc.decisions as Array<Record<string, unknown>>) {
        assertOnlyKeys(file, d, new Set(['decision_id', 'expected_slugs', 'match_keywords']), 'decisions[]');
        if (typeof d.decision_id !== 'string') throw new FixtureValidationError(file, 'decisions[].decision_id required');
        if (!isStringArray(d.expected_slugs)) throw new FixtureValidationError(file, 'decisions[].expected_slugs required');
        if (!isStringArray(d.match_keywords)) throw new FixtureValidationError(file, 'decisions[].match_keywords required');
      }
    }
  } else if (g.continuity !== undefined) {
    throw new FixtureValidationError(file, 'gold.continuity present but fixture has no continuity block');
  }

  return raw as FixtureGold;
}

/**
 * Load + validate the corpus. Every *.fixture.json must have a matching
 * <fixture_id>.gold.json in goldDir; orphan gold files are an error too
 * (a renamed fixture must rename its gold).
 */
export async function loadCorpus(fixtureDir: string, goldDir: string): Promise<LoadedCorpus> {
  let fixtureFiles: string[];
  try {
    fixtureFiles = (await readdir(fixtureDir)).filter((f) => f.endsWith('.fixture.json')).sort();
  } catch (err) {
    throw new Error(`brainbench: cannot read fixtures dir ${fixtureDir}: ${(err as Error).message}`);
  }
  let goldFiles: string[];
  try {
    goldFiles = (await readdir(goldDir)).filter((f) => f.endsWith('.gold.json')).sort();
  } catch (err) {
    throw new Error(`brainbench: cannot read gold dir ${goldDir}: ${(err as Error).message}`);
  }

  const hash = createHash('sha256');
  const fixtures: LoadedFixture[] = [];
  const goldByFixtureId = new Map<string, { raw: unknown; file: string }>();

  // Parallel I/O; hashing stays in sorted order over the resolved array
  // (determinism needs ordered hash.update, not serial reads).
  const goldContents = await Promise.all(goldFiles.map((gf) => readFile(join(goldDir, gf), 'utf-8')));
  const fixtureContents = await Promise.all(
    fixtureFiles.map((ff) => readFile(join(fixtureDir, ff), 'utf-8')),
  );

  for (let i = 0; i < goldFiles.length; i++) {
    const gf = goldFiles[i];
    const content = goldContents[i];
    hash.update(`gold/${gf}\n`);
    hash.update(content);
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new FixtureValidationError(gf, `invalid JSON: ${(err as Error).message}`);
    }
    const id = (parsed as Record<string, unknown>)?.fixture_id;
    if (typeof id !== 'string') throw new FixtureValidationError(gf, 'gold.fixture_id required');
    if (goldByFixtureId.has(id)) throw new FixtureValidationError(gf, `duplicate gold for fixture_id ${id}`);
    goldByFixtureId.set(id, { raw: parsed, file: gf });
  }

  const seenIds = new Set<string>();
  for (let i = 0; i < fixtureFiles.length; i++) {
    const ff = fixtureFiles[i];
    const path = join(fixtureDir, ff);
    const content = fixtureContents[i];
    hash.update(`fixtures/${ff}\n`);
    hash.update(content);
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new FixtureValidationError(ff, `invalid JSON: ${(err as Error).message}`);
    }
    const fixture = validateFixture(ff, parsed);
    if (seenIds.has(fixture.fixture_id)) {
      throw new FixtureValidationError(ff, `duplicate fixture_id ${fixture.fixture_id}`);
    }
    seenIds.add(fixture.fixture_id);
    const goldEntry = goldByFixtureId.get(fixture.fixture_id);
    if (!goldEntry) {
      throw new FixtureValidationError(ff, `no gold file for fixture_id ${fixture.fixture_id} in ${goldDir}`);
    }
    const gold = validateGold(goldEntry.file, goldEntry.raw, fixture);
    fixtures.push({ fixture, gold, path });
  }

  for (const [id, entry] of goldByFixtureId) {
    if (!seenIds.has(id)) {
      throw new FixtureValidationError(entry.file, `orphan gold file: no fixture with fixture_id ${id}`);
    }
  }

  // Continuity pairing integrity: every pair_id has exactly one writer + one reader.
  const pairs = new Map<string, { writer?: string; reader?: string }>();
  for (const { fixture } of fixtures) {
    if (!fixture.continuity) continue;
    const p = pairs.get(fixture.continuity.pair_id) ?? {};
    const role = fixture.continuity.pair_role;
    if (p[role]) {
      throw new FixtureValidationError(
        fixture.fixture_id,
        `continuity pair ${fixture.continuity.pair_id} has two ${role}s`,
      );
    }
    p[role] = fixture.fixture_id;
    pairs.set(fixture.continuity.pair_id, p);
  }
  for (const [pairId, p] of pairs) {
    if (!p.writer || !p.reader) {
      throw new FixtureValidationError(
        pairId,
        `continuity pair ${pairId} incomplete (writer=${p.writer ?? '∅'}, reader=${p.reader ?? '∅'})`,
      );
    }
  }

  return {
    fixtures,
    fixtures_hash: hash.digest('hex'),
    fixture_dir: fixtureDir,
    gold_dir: goldDir,
  };
}
