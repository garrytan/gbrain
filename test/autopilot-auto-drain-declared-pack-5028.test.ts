/**
 * #5028 (fix wave 9) — a pack that declares extract_atoms must not switch off
 * the autopilot atom auto-drain.
 *
 * Pre-fix submitAutoDrains returned early whenever the active pack declared
 * extract_atoms, on the theory that the routine cycle drains it. On the
 * Postgres daemon it does not: per-source cycles run only
 * SOURCE_FRESHNESS_PHASES and the maintenance job runs no source phase, so
 * declaring the phase stopped the only thing that ran it.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { submitAutoDrains } from '../src/commands/autopilot-dispatch.ts';
import { SOURCE_FRESHNESS_PHASES, MAINTENANCE_PHASES, packDeclaresPhase } from '../src/core/cycle.ts';
import { __setPackLocatorForTests, _resetPackLocatorForTests } from '../src/core/schema-pack/load-active.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { withEnv } from './helpers/with-env.ts';
import { stampExtractAtomsRun } from '../src/core/cycle/extract-atoms-stamp.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;
const HOME = mkdtempSync(join(tmpdir(), 'gbrain-5028-'));
const PACK_NAME = 'declares-xa-5028';
const ENV = { GBRAIN_HOME: HOME, GBRAIN_SCHEMA_PACK: PACK_NAME };

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  queue = new MinionQueue(engine);
  const dir = join(HOME, 'schema-packs', PACK_NAME);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'pack.yaml');
  writeFileSync(path, [
    'api_version: gbrain-schema-pack-v1', `name: ${PACK_NAME}`, 'version: 1.0.0', 'description: ""',
    'gbrain_min_version: 0.38.0', 'extends: null', 'borrow_from: []', 'page_types: []', 'link_types: []',
    'frontmatter_links: []', 'takes_kinds:', '  - fact', 'enrichable_types: []', 'filing_rules: []',
    'phases:', '  - extract_atoms', '',
  ].join('\n'), 'utf-8');
  __setPackLocatorForTests((name) => (name === PACK_NAME ? path : null));
}, 120_000);

afterAll(async () => {
  _resetPackLocatorForTests();
  _resetPackCacheForTests();
  await engine.disconnect();
});

beforeEach(async () => {
  _resetPackCacheForTests();
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw("DELETE FROM sources WHERE id <> 'default'");
  await engine.setConfig('autopilot.auto_drain.threshold', '1');
});

const prose = (n: string) => `A durable decision about ${n}, recorded in prose with context. `.repeat(12);

test('the daemon cycle split never runs extract_atoms, so a declaring pack cannot rely on it', () => {
  expect(SOURCE_FRESHNESS_PHASES).not.toContain('extract_atoms');
  expect(MAINTENANCE_PHASES).not.toContain('extract_atoms');
});

test('a backlogged source still gets its daily drain when the active pack declares extract_atoms', async () => {
  const root = join(HOME, 'vault');
  mkdirSync(root, { recursive: true });
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['vault', root]);
  for (let i = 0; i < 3; i++) {
    await engine.putPage(`articles/vault-${i}`, { type: 'article', title: `vault ${i}`, compiled_truth: prose(`vault ${i}`) } as never, { sourceId: 'vault' });
  }
  await withEnv(ENV, async () => {
    expect(await packDeclaresPhase(engine, 'extract_atoms')).toBe(true);
    await submitAutoDrains(engine, queue, { timeoutMs: 60_000, jsonMode: true, now: () => Date.parse('2026-10-05T12:00:00Z') });
  });
  const jobs = await engine.executeRaw<{ source: string; key: string }>(
    "SELECT data->>'sourceId' AS source, idempotency_key AS key FROM minion_jobs WHERE name = 'extract-atoms-drain'");
  expect(jobs).toEqual([{ source: 'vault', key: 'autopilot-extract-atoms-drain:vault:2026-10-05' }]);
});

test('extract_atoms stamps last_extract_atoms_at only for a pass that ran', async () => {
  const stamp = async () => (await engine.executeRaw<{ s: string | null }>(
    "SELECT config->>'last_extract_atoms_at' AS s FROM sources WHERE id = 'default'"))[0]?.s ?? null;
  await engine.executeRaw("UPDATE sources SET config = config - 'last_extract_atoms_at' WHERE id = 'default'");
  const base = { phase: 'extract_atoms' as const, duration_ms: 0, summary: '' };
  await stampExtractAtomsRun(engine, 'default', { ...base, status: 'fail', details: {} });
  await stampExtractAtomsRun(engine, 'default', { ...base, status: 'skipped', details: {} });
  await stampExtractAtomsRun(engine, 'default', { ...base, status: 'warn', details: { pages_processed: 0, transcripts_processed: 0 } });
  expect(await stamp()).toBeNull();
  await stampExtractAtomsRun(engine, 'default', { ...base, status: 'warn', details: { pages_processed: 2 } });
  expect(await stamp()).not.toBeNull();
  await engine.executeRaw("UPDATE sources SET config = config - 'last_extract_atoms_at' WHERE id = 'default'");
  await stampExtractAtomsRun(engine, 'default', { ...base, status: 'ok', details: {} });
  expect(Number.isFinite(new Date((await stamp())!).getTime())).toBe(true);
});
