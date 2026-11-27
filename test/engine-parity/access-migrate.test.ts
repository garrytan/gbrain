/**
 * BrainEngine parity: `gbrain access rule migrate` (src/core/access/policy-migrate.ts), the whole flow on every engine arm.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: moving a source's folder rules between the database store and the git store journals each phase and
 *    switches the store last, the same on every arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with
 *    GBRAIN_TEST_RUST_ARM=1): `--to database` from no store, `--to git` on a source with a git work tree (the rules, both
 *    policy files and both commits), a migration that stopped at 'committed' resumes from its journal, a move the other
 *    way is refused with its exact message until the unfinished one finishes, and the preview reports `resume`.
 *  - Regression: a journal read or write that differs on an arm strands a half-done store switch, resumes the wrong
 *    migration, or lets a second one start the other way.
 *  - Why existing coverage misses it: access-setup.test.ts compares the four journal members one call at a time, and the
 *    end-to-end migrate test (access-first-import-gst2638.test.ts) runs on PGLite only.
 *  - Seam: migrateSeams.afterPhase reads the journal after each phase. Generated ids and times are not compared.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource, parityArms, resetArm } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';
import { addMember } from '../../src/core/access/members.ts';
import { policyStatus, proposeRevision } from '../../src/core/access/policy.ts';
import { migrateAccessStore, migrateSeams, previewMigrate } from '../../src/core/access/policy-migrate.ts';
import { APPROVED_FILE, POLICY_FILE } from '../../src/core/access/policy-git.ts';

const { parityTest, arms } = parityArms(testBackends());

describe('engine parity: moving a source\'s folder rules between the database and git', () => {
  const journal = async (engine: BrainEngine, sourceId: string) => {
    const j = await engine.readUnfinishedAccessMigration(sourceId);
    return j && { id: j.id.startsWith('mig_'), phase: j.phase, direction: j.direction, receipts: Object.keys(j.receipts).sort() };
  };
  const plain = (text: string) => text.replace(/mig_[0-9a-f-]{36}/g, '<id>');
  /** One migrate: the journal after each phase (the seam), a stop at phase `stop`, and the result or the refusal. */
  async function migrate(engine: BrainEngine, sourceId: string, requested?: 'git' | 'database', stop?: string) {
    const seen: unknown[] = [];
    migrateSeams.afterPhase = async (phase) => { seen.push([phase, await journal(engine, sourceId)]); if (phase === stop) throw new Error('interrupted'); };
    try {
      const done = await migrateAccessStore(engine, sourceId, requested);
      const receipts = Object.fromEntries(Object.entries(done.receipts).map(([k, v]) => [k, typeof v === 'object' && v ? (v as { outcome?: string }).outcome : v]));
      return { seen, id: done.id, done: { from: done.from, to: done.to, phase: done.phase, receipts } };
    } catch (e) { return { seen, id: null, error: plain((e as Error).message) }; } finally { migrateSeams.afterPhase = undefined; }
  }

  parityTest('migrate --to database from no store journals each phase and switches the store', { methods: ['readUnfinishedAccessMigration', 'insertAccessMigration', 'recordAccessMigrationPhase', 'switchAccessMigration', 'writeAccessStoreConfig'] }, async (engine) => {
    await engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
    const before = await previewMigrate(engine, 'default', 'database');
    const run = await migrate(engine, 'default', 'database');
    const after = { store: (await policyStatus(engine, 'default')).store, journal: await journal(engine, 'default'), resume: await previewMigrate(engine, 'default').then(p => p.resume, (e: Error) => plain(e.message)) };
    const again = await migrate(engine, 'default', 'database');
    expect({ from: before.from, to: before.to, resume: before.resume, store: after.store, journal: after.journal }).toEqual({ from: null, to: 'database', resume: null, store: 'database', journal: null });
    expect(run.seen).toEqual([['committed', { id: true, phase: 'committed', direction: 'to_database', receipts: [] }], ['switched', null]]);
    return { run: { ...run, id: run.id?.startsWith('mig_') }, after, again };
  });

  parityTest('an interrupted migrate resumes from its journal; a move the other way is refused until it finishes', { methods: ['readUnfinishedAccessMigration', 'insertAccessMigration', 'recordAccessMigrationPhase', 'switchAccessMigration', 'writeAccessStoreConfig'] }, async (engine) => {
    await engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
    const stopped = await migrate(engine, 'default', 'database', 'committed');
    const left = await engine.readUnfinishedAccessMigration('default');
    const preview = await previewMigrate(engine, 'default');
    const refused = await previewMigrate(engine, 'default', 'git').then(() => 'allowed', (e: Error) => plain(e.message));
    const refusedRun = await migrate(engine, 'default', 'git');
    const untouched = { store: (await policyStatus(engine, 'default')).store, journal: await journal(engine, 'default') };
    const resumed = await migrate(engine, 'default');
    expect({ stopped: stopped.error, resume: preview.resume?.phase, same: preview.resume?.id === left?.id, finished: resumed.id === left?.id }).toEqual({ stopped: 'interrupted', resume: 'committed', same: true, finished: true });
    expect(refused).toBe('Source default has an unfinished migration <id> to the database store, so it cannot move to the git store now; nothing was written.');
    return { stopped, preview: { ...preview, resume: preview.resume && { ...preview.resume, id: true } }, refused, refusedRun, untouched, resumed: { ...resumed, id: true }, after: await journal(engine, 'default') };
  });

  parityTest('migrate --to git writes the rules into the work tree, journals each phase and switches the store', { methods: ['readUnfinishedAccessMigration', 'insertAccessMigration', 'recordAccessMigrationPhase', 'switchAccessMigration', 'writeAccessStoreConfig'] }, async (engine, backend) => {
    const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const root = mkdtempSync(join(tmpdir(), 'gbrain-parity-mig-'));
    try {
      git(root, 'init', '-q', '-b', 'main');
      git(root, 'config', 'user.email', 't@t.co');
      git(root, 'config', 'user.name', 't');
      writeFileSync(join(root, 'README.md'), 'repo\n');
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'init');
      await engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
      await createSource(engine, backend, 'mg', {}, root);
      await addMember(engine, 'alice-example');
      await proposeRevision(engine, 'mg', [{ id: 'alice', prefix: 'partners/alice/', readable_by: ['member:alice-example'] }], { origin: 'cli', store: 'database' });
      const run = await migrate(engine, 'mg', 'git');
      const status = await policyStatus(engine, 'mg');
      const files = { yml: readFileSync(join(root, POLICY_FILE), 'utf8'), approved: readFileSync(join(root, APPROVED_FILE), 'utf8'), commits: git(root, 'log', '--format=%s').replaceAll('mg', '<src>').split('\n') };
      expect({ store: status.store, rules: status.rules.map(r => r.id), phase: run.done?.phase }).toEqual({ store: 'git', rules: ['alice'], phase: 'switched' });
      return { run: { ...run, id: run.id?.startsWith('mig_') }, files, journal: await journal(engine, 'mg') };
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// A parity case counts a typed refusal as a pass, so this reads the Rust arm's own engine: it fails unless the journal is
// written and the store switches.
describe('the Rust arm migrates a source\'s folder rules', () => {
  test('gbrain access rule migrate journals its phases and switches the store on Rust', async () => {
    const rust = arms().find((arm) => arm.backend === 'rust');
    if (!rust) return;
    await resetArm(rust);
    await rust.engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
    const done = await migrateAccessStore(rust.engine, 'default', 'database');
    expect({ to: done.to, phase: done.phase, store: (await policyStatus(rust.engine, 'default')).store, left: await rust.engine.readUnfinishedAccessMigration('default') })
      .toEqual({ to: 'database', phase: 'switched', store: 'database', left: null });
  });
});
