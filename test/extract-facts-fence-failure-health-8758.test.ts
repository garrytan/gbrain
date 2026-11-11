/**
 * #8568 / #8758 — a legacy fact-fence step that fails must not book a healthy
 * extract_facts round. A fence write that errors (real I/O: the page's .tmp
 * path is a directory) counts the page in pagesFailed, and a fence step that
 * throws as a whole halts the round with item_error, so doctor extract_health
 * warns. Holds by design (a page whose file lives on another host) still book
 * a completed round. Real PGLite (and Postgres through testBackends).
 */
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCycle } from '../src/core/cycle.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { computeExtractHealthCheck } from '../src/commands/doctor/checks/extraction-sync.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { opError } from '../src/core/ops/contract.ts';
import { LEGACY_FILE_SLUG, seedLegacyManagedContent } from './helpers/managed-legacy-fixture.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const SLUG = 'people/alice-example';

async function unmanagedBrain(databaseUrl: string | undefined, run: (brain: { engine: BrainEngine; root: string; path: string }) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-fence-health-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        const root = join(home, 'brain');
        mkdirSync(root, { recursive: true });
        await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
        const page = await engine.putPage(SLUG, { type: 'person', title: 'Alice Example', compiled_truth: '# Alice Example\n\nProse.' });
        await engine.executeRaw('UPDATE pages SET source_path = $1 WHERE id = $2', [`${SLUG}.md`, page.id]);
        const snapshot = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!;
        const path = join(root, `${SLUG}.md`);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, serializePageToMarkdown(snapshot.page, snapshot.tags));
        await engine.executeRaw(
          `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence)
           VALUES ('default', $1, 'Alice example moved to Lisbon', 'fact', 'private', 'medium', '2026-02-05', 'mcp:remember', 0.9)`, [SLUG]);
        await run({ engine, root, path });
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

async function extractFactsPhase(engine: BrainEngine, root: string) {
  const report = await runCycle(engine, { brainDir: root, sourceId: 'default', phases: ['extract_facts'] });
  return report.phases.find(p => p.phase === 'extract_facts')!;
}

async function fenceRollup(engine: BrainEngine) {
  const [row] = await engine.executeRaw<{ halts: number; rounds: number }>(
    `SELECT COALESCE(SUM(halt_count), 0)::int AS halts, COALESCE(SUM(round_completed_count), 0)::int AS rounds
       FROM extract_rollup_7d WHERE kind = 'facts.fence' AND source_id = 'default'`);
  return { halts: Number(row!.halts), rounds: Number(row!.rounds), doctor: (await computeExtractHealthCheck(engine)).status };
}

/** The engine with one method answering `fail` when `when` matches its first argument. */
function failing(engine: BrainEngine, method: 'executeRaw' | 'readPageSnapshot', when: (first: unknown) => boolean, message: string, typed = false): BrainEngine {
  return new Proxy(engine, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      if (prop !== method) return value.bind(target);
      const error = () => typed ? opError('revision_conflict', message, 'Run maintenance again.') : new Error(message);
      return (first: unknown, ...rest: unknown[]) => when(first) ? Promise.reject(error()) : value.call(target, first, ...rest);
    },
  }) as BrainEngine;
}

/** The engine with the fence planner's source read failing, so the whole fence step throws. */
const failingFencePlanner = (engine: BrainEngine) =>
  failing(engine, 'executeRaw', sql => sql === 'SELECT id, local_path, archived, config FROM sources', 'synthetic fence planner failure');

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test(`${backend}: a fence write that fails with an I/O error counts as a failed page and halts the round, then recovers`, async () => {
    await unmanagedBrain(databaseUrl, async ({ engine, root, path }) => {
      mkdirSync(`${path}.tmp`);
      const first = await extractFactsPhase(engine, root);
      expect((first.details as { warnings: string[] }).warnings.join('\n')).toContain('EISDIR');
      expect(first.details).toMatchObject({ pagesFailed: 1, unfencedRowsFenced: 0 });
      expect(await fenceRollup(engine)).toEqual({ halts: 1, rounds: 0, doctor: 'warn' });

      rmSync(`${path}.tmp`, { recursive: true });
      const second = await extractFactsPhase(engine, root);
      expect(second.details).toMatchObject({ pagesFailed: 0, unfencedRowsFenced: 1 });
      expect(await fenceRollup(engine)).toMatchObject({ halts: 1, rounds: 1 });
    });
  }, 120_000);

  test(`${backend}: a fence step that throws halts the round instead of booking it healthy`, async () => {
    await unmanagedBrain(databaseUrl, async ({ engine, root }) => {
      const result = await extractFactsPhase(failingFencePlanner(engine), root);
      expect((result.details as { warnings: string[] }).warnings.join('\n')).toContain('FACTS_FENCE_FAILED: synthetic fence planner failure');
      expect(await fenceRollup(engine)).toEqual({ halts: 1, rounds: 0, doctor: 'warn' });
    });
  }, 120_000);

  test(`${backend}: managed: one page whose fence adoption throws counts once; the other page still fences`, async () => {
    await managedBrain(async ({ engine, root }) => {
      const broken = failing(engine, 'readPageSnapshot', slug => slug === LEGACY_FILE_SLUG, 'synthetic snapshot failure');
      const result = await extractFactsPhase(broken, root);
      expect((result.details as { warnings: string[] }).warnings.join('\n')).toContain(`FACTS_FENCE_FAILED: ${LEGACY_FILE_SLUG} (synthetic snapshot failure)`);
      expect(result.details).toMatchObject({ pagesFailed: 1, unfencedRowsFenced: 1 });
      expect(await fenceRollup(engine)).toMatchObject({ halts: 1, rounds: 0 });
    }, { databaseUrl, setup: async ({ engine, root }) => { await seedLegacyManagedContent(engine, root); } });
  }, 120_000);

  test(`${backend}: managed: a typed refusal (a concurrent writer moved the page) is a hold, not a failure`, async () => {
    await managedBrain(async ({ engine, root }) => {
      const moved = failing(engine, 'readPageSnapshot', slug => slug === LEGACY_FILE_SLUG, 'synthetic revision conflict', true);
      const result = await extractFactsPhase(moved, root);
      expect((result.details as { warnings: string[] }).warnings.join('\n')).toContain('synthetic revision conflict');
      expect(result.details).toMatchObject({ pagesFailed: 0 });
      expect(await fenceRollup(engine)).toMatchObject({ halts: 0, rounds: 1 });
    }, { databaseUrl, setup: async ({ engine, root }) => { await seedLegacyManagedContent(engine, root); } });
  }, 120_000);

  test(`${backend}: a fence step refused with a typed error (owner checks) is a hold, not a halt`, async () => {
    await unmanagedBrain(databaseUrl, async ({ engine, root }) => {
      const refused = failing(engine, 'executeRaw', sql => sql === 'SELECT id, local_path, archived, config FROM sources', 'synthetic owner refusal', true);
      const result = await extractFactsPhase(refused, root);
      expect((result.details as { warnings: string[] }).warnings.join('\n')).toContain('FACTS_FENCE_FAILED: synthetic owner refusal');
      expect(await fenceRollup(engine)).toMatchObject({ halts: 0, rounds: 1 });
    });
  }, 120_000);

  test(`${backend}: a page whose file lives on another host is a hold, not a failure`, async () => {
    await unmanagedBrain(databaseUrl, async ({ engine, root, path }) => {
      rmSync(path);
      const result = await extractFactsPhase(engine, root);
      expect(result.details).toMatchObject({ pagesFailed: 0 });
      expect(await fenceRollup(engine)).toMatchObject({ halts: 0, rounds: 1 });
    });
  }, 120_000);
}
