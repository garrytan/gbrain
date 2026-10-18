/**
 * GBRA-130 A-41 (hardening): `gbrain maintain --safe` runs one dream cycle per
 * stale source. A cycle that throws for one source used to end maintain and
 * skip every later source; now that source is reported blocked with its code
 * and the rest still cycle, while a run-scoped error still stops maintain.
 *
 * Authoring gate: (1) protects per-source isolation in runMaintain and its
 * non-zero exit verdict; (2) fails when the per-source loop loses its catch or
 * stops classifying run-scoped errors; (3) test/maintain.test.ts covers args
 * and JSON output only; (4) no production seam: runCycle is spied on its module.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cycle from '../../src/core/cycle.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runMaintain, type MaintainReport, type MaintenanceAction } from '../../src/commands/maintain.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../../src/core/cli-force-exit.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, pathologicalArms, runScopedErrors, snapshotItems } from './harness.ts';

const STALE = new Date(Date.now() - 48 * 3_600_000).toISOString();
const SOURCES = ['src-a', 'src-b'];

async function withStaleSources(databaseUrl: string | undefined, run: (engine: BrainEngine) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-a41-'));
  try {
    await withEnv({ GBRAIN_HOME: join(dir, 'home'), DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        for (const id of SOURCES) {
          const root = join(dir, id); mkdirSync(root);
          await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::jsonb)', [id, root, JSON.stringify({ last_full_cycle_at: STALE })]);
          await engine.putPage(`notes/${id}-note`, { type: 'note', title: `Note ${id}`, compiled_truth: `A note in ${id}.` }, { sourceId: id });
        }
        await run(engine);
      } finally { await close(); }
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const cycleActions = (report: MaintainReport) => report.actions.filter(a => a.name === 'cycle_freshness');
const bySource = (report: MaintainReport, id: string) => cycleActions(report).find(a => a.details?.source_id === id) as MaintenanceAction | undefined;
const maintain = async (engine: BrainEngine) => {
  const log = spyOn(console, 'log').mockImplementation(() => {});
  try { return await runMaintain(engine, ['--safe', '--json']) as MaintainReport; } finally { log.mockRestore(); }
};

describe('A-41 maintain isolates one source whose cycle throws', () => {
  beforeEach(() => { _resetCliExitVerdictForTests(); });
  afterEach(() => { _resetCliExitVerdictForTests(); process.exitCode = 0; });

  for (const { backend, databaseUrl } of pathologicalArms()) {
    test(`[${backend}] a source whose cycle throws is blocked with its code and the next source still cycles`, async () => {
      await withStaleSources(databaseUrl, async engine => {
        const real = cycle.runCycle;
        const cycled: string[] = [];
        const spy = spyOn(cycle, 'runCycle').mockImplementation(async (e, opts) => {
          if (opts.sourceId === 'src-a') throw new TypeError('listSourceChangedPages exploded on src-a');
          cycled.push(opts.sourceId!);
          return real(e, { ...opts, phases: ['orphans'] });
        });
        try {
          const before = await snapshotItems(engine, 'src-a');
          const report = await expectUnitNotAborted(() => maintain(engine));
          expect(cycled).toEqual(['src-b']);
          const blocked = bySource(report, 'src-a');
          expect(blocked?.status).toBe('blocked');
          expectItemFailure({ key: blocked?.details?.source_id as string, code: blocked?.details?.code as string, fix: blocked?.details?.fix },
            { key: 'src-a', code: 'internal', fix: /^gbrain dream --source src-a$/ });
          expect(bySource(report, 'src-b')?.status).toBe('applied');
          expectOthersUnchanged(before, await snapshotItems(engine, 'src-a'));
          const [b] = await engine.executeRaw<{ at: string | null }>(`SELECT config->>'last_full_cycle_at' AS at FROM sources WHERE id='src-b'`);
          expect({ progressed: b!.at !== STALE }).toEqual({ progressed: true });
          expect(currentExitCode()).toBe(1);
        } finally { spy.mockRestore(); }
      });
    }, 120_000);

    for (const { name, error } of runScopedErrors()) {
      test(`[${backend}] a run-scoped error in one source's cycle still stops maintain (${name})`, async () => {
        await withStaleSources(databaseUrl, async engine => {
          const injected = error();
          const cycled: string[] = [];
          const spy = spyOn(cycle, 'runCycle').mockImplementation(async (_e, opts) => {
            cycled.push(opts.sourceId!);
            throw injected;
          });
          try {
            await expect(maintain(engine)).rejects.toBe(injected);
            expect(cycled).toEqual(['src-a']);
          } finally { spy.mockRestore(); }
        });
      }, 120_000);
    }

    test(`[${backend}] most sources failing trips the breaker instead of blocking every source`, async () => {
      await withStaleSources(databaseUrl, async engine => {
        for (const id of ['src-c', 'src-d', 'src-e']) {
          const root = join(String((await engine.executeRaw<{ p: string }>(`SELECT local_path AS p FROM sources WHERE id='src-a'`))[0]!.p), '..', id);
          mkdirSync(root);
          await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::jsonb)', [id, root, JSON.stringify({ last_full_cycle_at: STALE })]);
          await engine.putPage(`notes/${id}-note`, { type: 'note', title: `Note ${id}`, compiled_truth: `A note in ${id}.` }, { sourceId: id });
        }
        const spy = spyOn(cycle, 'runCycle').mockImplementation(async () => { throw new OperationError('invalid_params', 'bad cycle input'); });
        try {
          await expect(maintain(engine)).rejects.toMatchObject({ code: 'item_failures_systemic' });
        } finally { spy.mockRestore(); }
      });
    }, 120_000);
  }
});
