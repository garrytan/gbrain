/**
 * GBRA-161 PR 3 (C-2, C-3, C-6): Life Chronicle events publish through the generation primitive. A re-judged depth page
 * publishes a new event generation: the events it dropped retire (versioned, `retired_by: life-chronicle`) together
 * with their timeline projection rows, in the activation, and `gbrain repair generations --kind chronicle-event` brings
 * both back. A model `[]` or a shrink below the floor retires nothing; a deleted depth page retires its events only
 * through `originGone`. Managed (database-only, coordinated) and unmanaged brains end in the same state. PGLite;
 * Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { runPhaseChronicle } from '../../src/core/cycle/chronicle.ts';
import type { ChronicleJudgeResult } from '../../src/core/chronicle/extract-events.ts';
import { maintenanceTransaction } from '../../src/core/persistence/attribution.ts';
import { managedPersistenceEnabled } from '../../src/core/persistence/ownership.ts';
import type { GenerationsSelection } from '../../src/core/generations/repair.ts';
import { resolveRepairScope, type RepairResult } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { managedBrain, pathologicalArms } from './harness.ts';

const today = new Date().toISOString().slice(0, 10);
const BODY = 'Alice and Bob reviewed the launch plan and agreed on the next steps for the beta. '.repeat(3);
const DEPTH = 'meetings/sync';
const ev = (what: string) => ({ when: today, who: ['people/alice-example'], what, kind: 'commitment' });

/** One brain in one mode, driven the way its writers drive it. */
interface World {
  engine: BrainEngine;
  managed: boolean;
  put(slug: string, body: string): Promise<void>;
  remove(slug: string): Promise<void>;
  /** One chronicle phase run whose judge answers `events`. */
  judge(events: string[] | null): Promise<Record<string, unknown>>;
}

async function managedWorld(databaseUrl: string | undefined, run: (world: World) => Promise<void>): Promise<void> {
  await managedBrain(async ({ engine, ctx }) => {
    expect(await managedPersistenceEnabled(engine)).toBe(true);
    const put = async (slug: string, body: string) => {
      const current = await engine.readPageSnapshot(slug, { sourceId: 'default' });
      await operationsByName.put_page.handler(ctx, { slug, content: `---\ntype: meeting\ntitle: Sync\ndate: ${today}\n---\n\n${body}`,
        ...(current ? { expected_revision: current.revision } : {}) });
    };
    const remove = async (slug: string) => {
      const current = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
      await operationsByName.delete_page.handler(ctx as OperationContext, { slug, expected_revision: current.revision });
    };
    await run({ engine, managed: true, put, remove, judge: events => phase(engine, events) });
  }, { databaseUrl });
}

async function unmanagedWorld(databaseUrl: string | undefined, run: (world: World) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-g3-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      _resetWriteThroughCacheForTest();
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        expect(await managedPersistenceEnabled(engine)).toBe(false);
        await engine.setConfig('chronicle.auto_settle_seconds', '0');
        await engine.setConfig('chronicle.activated_at', new Date(Date.now() - 60_000).toISOString());
        const put = async (slug: string, body: string) => {
          await maintenanceTransaction(engine, tx => tx.putPage(slug, { type: 'meeting', title: 'Sync', compiled_truth: body, frontmatter: { date: today } }, { sourceId: 'default' }));
        };
        const remove = async (slug: string) => { await maintenanceTransaction(engine, async tx => { await tx.createVersion(slug, { sourceId: 'default' }); await tx.softDeletePage(slug, { sourceId: 'default' }); }); };
        await run({ engine, managed: false, put, remove, judge: events => phase(engine, events) });
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

async function phase(engine: BrainEngine, events: string[] | null): Promise<Record<string, unknown>> {
  await engine.executeRaw("UPDATE chronicle_page_state SET next_attempt_at=now()-interval '1 second', decided_at=now()-interval '1 hour' WHERE state='pending'");
  const answer: ChronicleJudgeResult = events === null ? { events: [], failure: 'parse_failed' } : { events: events.map(ev) };
  return (await runPhaseChronicle(engine, { judge: async () => answer })).details as Record<string, unknown>;
}

/** Every event page with its liveness, stamp and the projection rows that point at it. */
async function eventState(engine: BrainEngine) {
  return engine.executeRaw<{ what: string; deleted: boolean; retired_by: string | null; projections: number }>(
    `SELECT p.frontmatter->'event'->>'what' AS what, p.deleted_at IS NOT NULL AS deleted, p.frontmatter->>'retired_by' AS retired_by,
            (SELECT count(*)::int FROM timeline_entries t WHERE t.event_page_id = p.id) AS projections
       FROM pages p WHERE p.type='event' ORDER BY what`);
}

async function repair(engine: BrainEngine, selection: GenerationsSelection, expectHash?: string): Promise<RepairResult> {
  const scope = await resolveRepairScope(engine, 'default');
  const quiet = { info: () => {}, warn: () => {}, error: () => {} };
  return (await repairRunner(engine, { apply: expectHash !== undefined, noEmbed: true, logger: quiet })).run('generations', scope,
    { explicit: true, sourceFlag: 'default', generations: selection, ...(expectHash ? { expect: expectHash } : {}) });
}

const MODES = [['managed', managedWorld], ['unmanaged', unmanagedWorld]] as const;

for (const { backend, databaseUrl } of pathologicalArms()) {
  for (const [mode, world] of MODES) {
    describe(`GBRA-161 PR 3 chronicle generations (${backend}, ${mode})`, () => {
      test('C-2/C-3: a re-judgment that drops an event retires it with its timeline row, and restore brings both back', async () => {
        await world(databaseUrl, async w => {
          await w.put(DEPTH, BODY);
          await w.judge(['Alice agreed to ship the beta', 'Bob owns the launch email']);
          expect(await eventState(w.engine)).toEqual([
            { what: 'Alice agreed to ship the beta', deleted: false, retired_by: null, projections: 1 },
            { what: 'Bob owns the launch email', deleted: false, retired_by: null, projections: 1 }]);
          await w.put(DEPTH, `${BODY} Wording changed.`);
          await w.judge(['Alice agreed to ship the beta']);
          expect(await eventState(w.engine)).toEqual([
            { what: 'Alice agreed to ship the beta', deleted: false, retired_by: null, projections: 1 },
            { what: 'Bob owns the launch email', deleted: true, retired_by: 'life-chronicle', projections: 0 }]);
          const selection: GenerationsSelection = { kind: 'chronicle-event', mode: 'restore', key: `depth:${DEPTH}` };
          const preview = await repair(w.engine, selection);
          expect(preview.listing?.map(row => row.class)).toEqual(['restore']);
          const applied = await repair(w.engine, selection, preview.preview_hash!);
          expect(applied.outcome_items?.map(item => item.outcome)).toEqual(['restored']);
          expect((await eventState(w.engine)).map(e => [e.what, e.deleted, e.projections])).toEqual([
            ['Alice agreed to ship the beta', false, 1], ['Bob owns the launch email', false, 1]]);
        });
      }, 240_000);

      test('a model [] or a shrink below the floor retires nothing', async () => {
        await world(databaseUrl, async w => {
          await w.put(DEPTH, BODY);
          await w.judge(['Alice agreed to ship the beta', 'Bob owns the launch email', 'Carol books the venue', 'Dan drafts the agenda']);
          await w.put(DEPTH, `${BODY} v2.`);
          await w.judge([]);
          expect((await eventState(w.engine)).map(e => e.deleted)).toEqual([false, false, false, false]);
          await w.put(DEPTH, `${BODY} v3.`);
          await w.judge(['Alice agreed to ship the beta']);
          expect((await eventState(w.engine)).map(e => [e.deleted, e.projections])).toEqual([[false, 1], [false, 1], [false, 1], [false, 1]]);
          expect(await w.engine.executeRaw("SELECT held_reason FROM derived_generations WHERE kind='chronicle_event' AND state='held'")).toEqual([{ held_reason: 'shrunk' }]);
        });
      }, 240_000);

      test('C-6: a deleted depth page retires its events through originGone', async () => {
        await world(databaseUrl, async w => {
          await w.put(DEPTH, BODY);
          await w.judge(['Alice agreed to ship the beta']);
          await w.remove(DEPTH);
          await w.judge([]);
          expect(await eventState(w.engine)).toEqual([{ what: 'Alice agreed to ship the beta', deleted: true, retired_by: 'life-chronicle', projections: 0 }]);
          expect(await w.engine.executeRaw(
            "SELECT completeness->>'proof' AS proof FROM derived_generations WHERE kind='chronicle_event' AND state='live'")).toEqual([{ proof: 'originGone' }]);
        });
      }, 240_000);
    });
  }

  test(`managed and unmanaged brains end in the same chronicle state (${backend})`, async () => {
    const script = async (w: World) => {
      await w.put(DEPTH, BODY);
      await w.judge(['Alice agreed to ship the beta', 'Bob owns the launch email', 'Carol books the venue']);
      await w.put(DEPTH, `${BODY} v2.`);
      await w.judge(['Alice agreed to ship the beta', 'Carol books the venue']);
      await w.put(DEPTH, `${BODY} v3.`);
      await w.judge(null);
      await w.put('meetings/other', BODY);
      await w.judge(['Erin signs the lease']);
      await w.remove('meetings/other');
      await w.judge([]);
      return {
        events: await eventState(w.engine),
        ledger: await w.engine.executeRaw(`SELECT owner_key, state, generation, completeness->>'proof' AS proof,
            (SELECT count(*)::int FROM derived_generation_items i WHERE i.generation_id = g.id AND i.action = 'retired') AS retired
          FROM derived_generations g WHERE kind='chronicle_event' ORDER BY owner_key, generation`),
      };
    };
    const states: unknown[] = [];
    for (const [, world] of MODES) await world(databaseUrl, async w => { states.push(await script(w)); });
    expect(states[0]).toEqual(states[1]);
    expect((states[0] as { events: unknown[] }).events).toEqual([
      { what: 'Alice agreed to ship the beta', deleted: false, retired_by: null, projections: 1 },
      { what: 'Bob owns the launch email', deleted: true, retired_by: 'life-chronicle', projections: 0 },
      { what: 'Carol books the venue', deleted: false, retired_by: null, projections: 1 },
      { what: 'Erin signs the lease', deleted: true, retired_by: 'life-chronicle', projections: 0 }]);
  }, 480_000);
}
