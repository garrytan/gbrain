/**
 * #6712 PR 4b: a confirm round's proof (sync-pass-confirm.ts `proveConfirm`) scans `pages` and `op_checkpoints` with
 * parallel workers, its settings scoped to the proof by a savepoint it rolls back to (`parallelProof`).
 *
 * Protects (Postgres, direct and through transaction-mode PgBouncer): the settings hold inside the proof and nowhere else:
 * after it, SHOW in the same transaction and session gives what it gave before; the proof's verdict equals the plain
 * proof's, for an unchanged source and for a foreign page write. A server that refuses the setting (the
 * `sync:confirm_parallel` seam) aborts only the savepoint: the proof runs without the settings, gives the same verdict, and
 * the transaction stays usable; a pass's round 2 still confirms, and so does a next pass whose round 1 reuses the kept
 * read across passes (GBRA-133), its proof refused too. PGLite never sets them (no savepoint, no seam).
 *
 * PGLite and Postgres here; Postgres also through test/e2e/sync-pass-confirm-parallel-6712-postgres.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { proveConfirm, readLevelMark, type LevelMark } from '../src/core/persistence/sync-pass-confirm.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { __resetTreeReuseForTests } from '../src/core/persistence/sync-tree-reuse.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (const slug of ['a', 'b', 'c']) writeFileSync(join(root, `notes/${slug}.md`), note(`notes/${slug}`, `The committed body of notes/${slug}.`));
  commit(root, 'notes');
};
const SETTINGS = ['parallel_setup_cost', 'parallel_tuple_cost', 'min_parallel_table_scan_size'];
type Exec = Pick<BrainEngine, 'executeRaw'>;
const show = async (exec: Exec) => Object.fromEntries(await Promise.all(SETTINGS.map(async name => [name, (await exec.executeRaw<Record<string, string>>(`SHOW ${name}`))[0]![name]])));
const incarnationOf = async (engine: BrainEngine) => (await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text FROM sources WHERE id='default'"))[0]!.incarnation;

/** Every statement the proof sends, and the settings in effect right after its proof statement (queued behind it). */
function recording(exec: Exec) {
  const sent: string[] = [];
  let during: Promise<Record<string, string>> | null = null;
  const wrapped: Exec = { executeRaw: ((sql: string, params?: unknown[]) => {
    sent.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
    const result = exec.executeRaw(sql, params);
    if (sql.includes('pages_changed') && !during) { during = show(exec); during.catch(() => undefined); }
    return result;
  }) as Exec['executeRaw'] };
  return { exec: wrapped, sent, during: () => during };
}

/** The proof in a round-like snapshot (repeatable read, read only), parallel and plain, with the settings around it. */
async function proveBoth(engine: BrainEngine, base: LevelMark, incarnation: string) {
  return engine.transaction(async tx => {
    await tx.executeRaw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const before = await show(tx);
    const input = { sourceId: 'default', incarnation, passId: crypto.randomUUID(), base, postgres: engine.kind === 'postgres' };
    const probe = recording(tx);
    const parallel = await proveConfirm(probe.exec, { ...input, parallel: true });
    const during = await probe.during();
    const after = await show(tx);
    const plain = await proveConfirm(tx, input);
    return { before, during, after, parallel, plain, sent: probe.sent };
  });
}

afterEach(() => installFaultHook(undefined));

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  const brain = (run: Parameters<typeof managedBrain>[0]) => managedBrain(run, { ...(databaseUrl ? { databaseUrl } : {}), setup });

  describe(`#6712 PR 4b parallel confirm proof (${backend})`, () => {
    if (backend === 'postgres') {
      test('the settings hold for the proof alone, and its verdict equals the plain proof (unchanged, then a foreign page write)', () => brain(async ({ engine }) => {
        expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
        const incarnation = await incarnationOf(engine), base = await readLevelMark(engine, 'default', incarnation), session = await show(engine);
        const clean = await proveBoth(engine, base, incarnation);
        expect(clean.during).toEqual({ parallel_setup_cost: '0', parallel_tuple_cost: '0', min_parallel_table_scan_size: '0' });
        expect(clean.after).toEqual(clean.before);
        expect(clean.parallel).toEqual(clean.plain);
        expect(clean.parallel.ok).toBe(true);
        expect(clean.sent).toEqual(['SET LOCAL jit', 'SAVEPOINT gbrain_confirm_proof', 'DO $$ BEGIN', 'WITH x AS', 'ROLLBACK TO SAVEPOINT', 'RELEASE SAVEPOINT gbrain_confirm_proof']);
        await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw("UPDATE pages SET title='A foreign title.' WHERE source_id='default' AND slug='notes/b'"), TEST_WRITE_ATTRIBUTION));
        const foreign = await proveBoth(engine, base, incarnation);
        expect(foreign.parallel).toEqual(foreign.plain);
        expect(foreign.parallel).toMatchObject({ ok: false, reason: 'foreign_page_write' });
        expect(foreign.after).toEqual(foreign.before);
        expect(await show(engine)).toEqual(session);
      }), 120_000);

      test('a server that refuses the setting: the proof runs without it, gives the same verdict, and the transaction goes on', () => brain(async ({ engine }) => {
        expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
        const incarnation = await incarnationOf(engine), base = await readLevelMark(engine, 'default', incarnation);
        let refusals = 0;
        installFaultHook(point => { if (point === 'sync:confirm_parallel') { refusals++; throw new Error('the server refuses the setting'); } });
        const refused = await proveBoth(engine, base, incarnation);
        expect(refusals).toBe(1);
        expect(refused.parallel).toEqual(refused.plain);
        expect(refused.parallel.ok).toBe(true);
        expect(refused.during).toEqual(refused.before);
        expect(refused.after).toEqual(refused.before);
      }), 120_000);
    }

    test('a pass round 2 confirms with the parallel proof, and with a server that refuses it; PGLite never sets it', () => brain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      const run = async (refuse: boolean, keep = false) => {
        if (!keep) __resetTreeReuseForTests();
        const seen = { seam: 0, confirm: null as unknown, across: null as unknown };
        installFaultHook(async (point, detail) => {
          if (point === 'sync:confirm_parallel') { seen.seam++; if (refuse) throw new Error('the server refuses the setting'); }
          if (point === 'sync:level_read' && detail.round === 1) seen.across = detail.level?.confirm?.across ?? null;
          if (point === 'sync:level_read' && detail.round === 2) seen.confirm = detail.level?.confirm ?? null;
        });
        try { return { status: (await performManagedSync(engine, OPTS)).status, ...seen }; } finally { installFaultHook(undefined); }
      };
      writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'A committed change of notes/a.')); commit(root, 'change a');
      const plain = await run(false);
      writeFileSync(join(root, 'notes/b.md'), note('notes/b', 'A committed change of notes/b.')); commit(root, 'change b');
      const refused = await run(true);
      writeFileSync(join(root, 'notes/c.md'), note('notes/c', 'A committed change of notes/c.')); commit(root, 'change c');
      const across = await run(true, true);
      const seam = backend === 'postgres' ? 1 : 0;
      expect(plain).toEqual({ status: 'synced', seam, confirm: { taken: true, reason: null, rows: 1, narrow: 'taken' }, across: null });
      expect(refused).toEqual({ status: 'synced', seam, confirm: { taken: true, reason: null, rows: 1, narrow: 'taken' }, across: null });
      expect(across).toMatchObject({ status: 'synced', seam: 2 * seam, across: true, confirm: { taken: true, reason: null, rows: 1, narrow: 'taken' } });
    }), 120_000);
  });
}
