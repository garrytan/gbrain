/**
 * #6712 PR 4 shadow validation on seeded fixtures (the evidence that replaces the production baseline; it rides PR 4b).
 *
 * Authoring gate: (1) protects the read-only shadow's per-path class and action tag (design v3.2 §2.3 rows 1-19, the
 * in_flight overlay, the §2.6 valve, §2.7 bootstrap and §6 --full) on a managed brain seeded through real gbrain calls,
 * the totality of the level, and the CLI surfaces (the redacted dry run and status --detail) agreeing with the library;
 * (2) a classifier or read change that moves any seeded path's class, action, sub-label, side or state, drops a path
 * from the domain, double-counts one, leaks a path under --redact-paths or writes a row fails here; (3) the pure
 * classifier test and the 4a shadow test each cover a few states, not the mix together on one brain; (4) no seam: the
 * seeding and the reads are the production calls (scripts/bench/sync-convergence-seeded.ts names the raw SQL it needs).
 *
 * Cases whose 4a prediction differs from the design carry it as today: the mix asserts today, so a fix turns the mix red
 * until the case drops it. PR 4b's rulings b1-b6 set the design values the mix now asserts (no case carries today): a
 * re-screen-due hold is held (b2), a page-less file with no deletion proof imports (b1), an absorbed dirty path is
 * matched (b3), --full imports legacy-marked paths (b5). The mix is read as PR 4b's first pass finds it (no pass row). The (a) findings this validation found (a write-through-off request outside U_db, an absent
 * working-mode path read as unreadable, a spelling refusal without its dry-run receipt) are fixed in 4a; each keeps a
 * focused test below.
 *
 * PGLite, and Postgres with DATABASE_URL (test/e2e/sync-convergence-seeded-6712-postgres.test.ts). Synthetic content only.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { idleTickProbe, shadowConvergence } from '../src/core/persistence/sync-pass.ts';
import { preparePageAdmission } from '../src/core/persistence/page-mutations.ts';
import { admitWrite } from '../src/core/persistence/journal.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runSync } from '../src/commands/sync.ts';
import { captureCli, cliChecks, evaluate, fullCases, mixSetup, seedMassDelete, seedMix, seedSpelling, workingCases, type EvalRun } from '../scripts/bench/sync-convergence-seeded.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string, body: string) => `---\ntitle: ${title}\n---\n\n${body}\n`;
const SYNC = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const small = ({ root }: { root: string }) => {
  git(root, 'init', '-q');
  mkdirSync(join(root, 'notes'), { recursive: true });
  for (const name of ['alpha', 'beta', 'gamma']) writeFileSync(join(root, 'notes', `${name}.md`), note(name, `Synthetic ${name} one.`));
  commit(root, 'notes');
};

/** Every row a shadow could write: requests, effects, checkpoints (holds, markers, records, pass rows, cursors) and pages. */
async function footprint(engine: BrainEngine): Promise<string> {
  return JSON.stringify(await engine.executeRaw(`SELECT 'requests' AS t, count(*)::int AS n, md5(string_agg(id::text||state, ',' ORDER BY id)) AS h FROM persistence_requests
    UNION ALL SELECT 'effects', count(*)::int, md5(string_agg(id::text||state, ',' ORDER BY id)) FROM persistence_effects
    UNION ALL SELECT 'checkpoints', count(*)::int, md5(string_agg(op||fingerprint||completed_keys::text, ',' ORDER BY op, fingerprint)) FROM op_checkpoints
    UNION ALL SELECT 'pages', count(*)::int, md5(string_agg(id::text||knowledge_revision::text||coalesce(deleted_at::text,''), ',' ORDER BY id)) FROM pages`));
}

/** Each case as asserted (today where 4a knowingly differs, else the design), against the prediction, restricted to the asserted fields. */
function asAsserted(run: EvalRun) {
  return run.results.map(result => {
    const want = result.entry.today ?? result.entry.expect;
    const got = result.predicted ? Object.fromEntries(Object.keys(want).map(field => [field, (result.predicted as unknown as Record<string, unknown>)[field] ?? (typeof (want as unknown as Record<string, unknown>)[field] === 'boolean' ? false : undefined)]))
      : { key: 'outside_domain' };
    return { want: { path: result.entry.path, ...want }, got: { path: result.entry.path, ...got } };
  });
}
function expectRun(run: EvalRun, { partial = false } = {}) {
  const rows = asAsserted(run);
  expect(rows.map(row => row.got)).toEqual(rows.map(row => row.want));
  if (partial) return;
  expect(run.unseeded).toEqual([]);
  expect(run.totality).toMatchObject({ ok: true, missing: [], duplicates: [] });
  const tally: Record<string, number> = {};
  for (const row of rows) if (row.want.key !== 'outside_domain') tally[row.want.key] = (tally[row.want.key] ?? 0) + 1;
  expect(run.receipt.counts).toEqual(tally);
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  const brain = (run: Parameters<typeof managedBrain>[0], setup: (b: { root: string }) => void) => managedBrain(run, { ...(databaseUrl ? { databaseUrl } : {}), setup });

  describe(`#6712 PR 4 shadow on the seeded mix (${backend})`, () => {
    test('every seeded path classifies as design v3.2 says (or as its pinned finding), the level is total, the CLI agrees, and nothing is written', () => brain(async ({ engine, ctx, root }) => {
      const mix = await seedMix({ engine, ctx, root });
      const before = await footprint(engine);
      const committed = await evaluate(engine, mix, { label: 'committed' });
      expectRun(committed);
      // delete-proof and kept-file (#5459: a Git-imported page whose file left Git is a delete even with a lingering copy).
      expect(committed.receipt.deletes).toMatchObject({ count: 2, verdict: 'apply' });
      expect(committed.receipt.db_ahead).toMatchObject({ pending: 1, db_only: 2, unproven: 1 });
      expect(committed.receipt).toMatchObject({ keep_db_admitted: 2, legacy_unverified: 1, legacy_pageless: 1, decisions: { both: 0, unknown: 0, deleted: 3 } });

      const cli = await cliChecks(engine, committed);
      expect({ dry: cli.dryRunExit, status: cli.statusExit }).toEqual({ dry: 0, status: 0 });
      expect(cli.dryRunCounts).toBe(cli.libraryCounts);
      expect(cli.statusCounts).toBe(cli.libraryCounts);
      expect(cli.redactionLeaks).toEqual([]);
      expect(cli.redactedSampleMismatches).toEqual([]);
      expect(cli.redactedSamplesChecked).toBe(Object.values(committed.receipt.counts).reduce((sum, n) => sum + (n ?? 0), 0) - (committed.receipt.counts.matched ?? 0));
      expect(cli.dryRunConvergence).toMatchObject({ redacted: true, dry_run: true });

      const cases = seedSpelling(root, mix);
      const spelled = await evaluate(engine, cases, { label: 'spelled' });
      expectRun(spelled);
      const spelledCli = await cliChecks(engine, spelled);
      // The real run would refuse the spelling pairs; the refused dry run still carries the convergence receipt.
      expect(spelledCli.dryRunError?.code).toBe('page_identity_changed');
      expect(spelledCli.dryRunCounts).toBe(spelledCli.libraryCounts);
      expect(spelledCli.statusCounts).toBe(spelledCli.libraryCounts);
      expect(spelledCli.redactionLeaks).toEqual([]);
      expect(spelledCli.redactedSampleMismatches).toEqual([]);

      expectRun(await evaluate(engine, fullCases(cases), { label: 'full', full: true }));
      expectRun(await evaluate(engine, workingCases(cases), { label: 'working', workingTree: true, partial: true }), { partial: true });
      expect(await footprint(engine)).toBe(before);

      const mass = await evaluate(engine, seedMassDelete(root, cases), { label: 'mass' });
      expectRun(mass);
      expect(mass.receipt.deletes).toMatchObject({ count: 62, verdict: 'withheld' });
      expect(mass.receipt.deletes_withheld).toMatchObject({ count: 62, set_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(await footprint(engine)).toBe(before);
    }, mixSetup), 600_000);

    test('a queued put_page admitted with write-through off (no worktree) is open work, so the changed file is in_flight', () => brain(async ({ engine, ctx, root }) => {
      expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
      await engine.setConfig('sync.write_through', 'false');
      writeFileSync(join(root, 'notes', 'alpha.md'), note('alpha', 'Synthetic alpha two.'));
      commit(root, 'alpha two');
      await disposePersistenceConsumer(engine);
      const snapshot = (await engine.readPageSnapshot('notes/alpha', { sourceId: 'default' }))!;
      const prepared = await preparePageAdmission(ctx, { operation: 'put_page', params: { slug: 'notes/alpha', request_id: crypto.randomUUID(), expected_revision: snapshot.revision, content: note('alpha', 'A queued agent edit.') } });
      const [{ hwm }] = await engine.executeRaw<{ hwm: number }>('SELECT COALESCE(max(sequence), 0)::int AS hwm FROM persistence_requests');
      expect((await admitWrite(engine, prepared.admission!)).state).toBe('queued');
      expect((await shadowConvergence(engine, { sourceId: 'default' }))!.counts).toEqual({ matched: 2, in_flight: 1 });
      // The idle tick sees the same request above a watermark taken before it, so the source is not idle.
      const idle = await idleTickProbe(engine, { sourceId: 'default', assumeConverged: { target: git(root, 'rev-parse', 'HEAD'), requestHwm: hwm! } });
      expect(idle.idle).toBe(false);
    }, small), 120_000);

    test('in working mode a committed git rm of a synced file is a delete, not an import (its absent level is absent)', () => brain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
      git(root, 'rm', '-q', 'notes/beta.md');
      git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'remove beta');
      expect((await shadowConvergence(engine, { sourceId: 'default' }))!.counts).toEqual({ matched: 2, delete: 1 });
      expect((await shadowConvergence(engine, { sourceId: 'default', workingTree: true }))!.counts).toEqual({ matched: 2, delete: 1 });
    }, small), 120_000);

    test('a spelling collision still leaves the refused dry run its convergence receipt, the pair under spelling', () => brain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
      writeFileSync(join(root, 'notes', 'Pair.md'), note('Pair', 'Synthetic pair.'));
      writeFileSync(join(root, 'notes', 'pair.md'), note('pair', 'Synthetic pair.'));
      commit(root, 'a case-only pair');
      const dry = await captureCli(() => runSync(engine, ['--source', 'default', '--no-pull', '--dry-run', '--json', '--no-embed', '--redact-paths']));
      expect({ exit: dry.exit !== 0, code: dry.json?.code }).toEqual({ exit: true, code: 'page_identity_changed' });
      expect((dry.json?.convergence as { counts?: Record<string, number> } | undefined)?.counts).toEqual({ matched: 3, spelling: 2 });
    }, small), 120_000);
  });
}
