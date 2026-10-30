/**
 * #6712 PR 4b: the post-effects hook (coordinator.ts `PreparedMutation.afterEffects`) runs only for a pass's writeback
 * import that carries the folded stamp. Every other write publishes exactly as before the hook existed.
 *
 * Protects: the publication transaction of a `put_page` and of a canonical one-file import whose stamp folds into its
 * apply runs the same SQL statements, in the same order, as the golden sequence recorded on the commit before the hook
 * (c64799845, the pre-hook side of the merge with master v0.60.300.0; test/fixtures/fold-hook-noop-6712.json). Statements are the publication's own round trips (begin to
 * commit), captured through the statement seam (PGLite: `countPgliteStatements`; Postgres: the `GBRAIN_SQL_TRACE` wire
 * trace), with whitespace collapsed and the per-call statement timeout masked. A hook that adds, drops or reorders a
 * statement for any other write fails here.
 *
 * PGLite runs `pipelined` branches one after another, so its sequence is compared exactly. Postgres sends them together
 * (page-state/transactions.ts `pipelined`): a branch's later statement goes out when its earlier one returns, so where
 * two branches interleave varies run to run (put_page's origin claim probe beside the takes projection). There the
 * publication is compared as its exact statement multiset plus its exact ordered tail from the effects insert (the
 * canonical import queues none: from its fold's `RELEASE SAVEPOINT`, the end of its apply) to the commit, the stretch the
 * hook runs in, which no pipelined call reaches.
 *
 * PGLite here; Postgres through test/e2e/fold-hook-noop-6712-postgres.test.ts.
 * CAPTURE_FOLD_NOOP=1 rewrites the fixture for the engine under test (only ever from the pre-hook commit).
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OPEN_PASS_WORK_SQL } from '../src/core/persistence/checkpoint-validation.ts';
import { admitWrite } from '../src/core/persistence/journal.ts';
import { preparePageAdmission } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { FOLD_PASS_ROW_WRITE } from './helpers/managed-import-budget.ts';
import { countPgliteStatements, readSqlTrace, type StatementRecord } from './helpers/statement-counter.ts';
import { testBackends } from './helpers/test-backends.ts';
import { waitFor } from './helpers/wait-for.ts';
import { withEnv } from './helpers/with-env.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'fold-hook-noop-6712.json');
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (const slug of ['a', 'b']) writeFileSync(join(root, `notes/${slug}.md`), note(`notes/${slug}`, `The committed body of notes/${slug}.`));
  commit(root, 'notes');
};

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim().replace(/statement_timeout = \d+/gi, 'statement_timeout = N');
const isStatement = (record: StatementRecord) => record.kind === 'execute' || record.kind === 'simple';
/** The committed transaction (begin to commit on one connection) one of whose statements `marks`, normalized. */
function transactionOf(records: StatementRecord[], marks: (sql: string) => boolean): string[] {
  const open = new Map<number, string[]>();
  for (const record of [...records].sort((a, b) => a.t - b.t)) {
    if (!isStatement(record)) continue;
    const sql = normalize(record.sql), lower = sql.toLowerCase();
    if (lower === 'begin' || lower === 'begin read write' || lower.startsWith('begin;')) { open.set(record.conn, [sql]); continue; }
    const group = open.get(record.conn);
    if (!group) continue;
    group.push(sql);
    if (lower !== 'commit' && lower !== 'rollback') continue;
    open.delete(record.conn);
    if (lower === 'commit' && group.some(marks)) return group;
  }
  throw new Error(`no committed transaction carried the marked statement among ${records.length} records`);
}

/** Runs `act` and returns its statement records (PGLite: the datastore seam; Postgres: the wire trace in `trace`). */
async function recorded(engine: BrainEngine, trace: string, act: () => Promise<void>, marks: (sql: string) => boolean): Promise<string[]> {
  if (engine.kind === 'pglite') {
    const counter = countPgliteStatements(engine as PGLiteEngine);
    try { await act(); } finally { counter.stop(); }
    return transactionOf(counter.records, marks);
  }
  const started = performance.timeOrigin + performance.now();
  await act();
  const ended = performance.timeOrigin + performance.now();
  for (let i = 0; ; i++) {
    try { return transactionOf(readSqlTrace(trace).filter(record => record.t >= started && record.t <= ended), marks); }
    catch (error) { if (i >= 50) throw error; }
    await Bun.sleep(100);
  }
}

async function sequences(engine: BrainEngine, ctx: Parameters<typeof preparePageAdmission>[0], root: string, trace: string): Promise<Record<string, string[]>> {
  expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
  writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'A committed change of notes/a.')); commit(root, 'change a, canonical');
  const canonicalImport = await recorded(engine, trace, async () => { expect((await performManagedSync(engine, OPTS)).status).toBe('synced'); },
    sql => sql === normalize(OPEN_PASS_WORK_SQL));
  const putPage = await recorded(engine, trace, async () => {
    const prepared = await preparePageAdmission(ctx, { operation: 'put_page', params: { slug: 'notes/new', request_id: randomUUID(), content: note('notes/new', 'An agent page.') } });
    const { request_id } = await admitWrite(engine, prepared.admission!);
    await waitFor(async () => (await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [request_id]))[0]?.state === 'committed',
      { timeoutMs: 30_000, label: 'the put_page commits' });
  }, sql => sql.startsWith('INSERT INTO persistence_effects ('));
  await disposePersistenceConsumer(engine);
  return { put_page: putPage, canonical_import: canonicalImport };
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  describe(`#6712 PR 4b post-effects hook is a no-op for other writes (${backend})`, () => {
    test('a put_page and a canonical folded import publish the statements they published before the hook', async () => {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-fold-noop-')), trace = join(home, 'trace.jsonl');
      try {
        let got: Record<string, string[]> = {};
        await withEnv(backend === 'postgres' ? { GBRAIN_SQL_TRACE: trace, GBRAIN_SQL_TRACE_LABEL: 'fold-noop' } : {}, () =>
          managedBrain(async ({ engine, ctx, root }) => { got = await sequences(engine, ctx, root, trace); }, { ...(databaseUrl ? { databaseUrl } : {}), setup }));
        const golden = existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, Record<string, string[]>> : {};
        if (process.env.CAPTURE_FOLD_NOOP === '1') { mkdirSync(join(import.meta.dir, 'fixtures'), { recursive: true }); writeFileSync(FIXTURE, `${JSON.stringify({ ...golden, [backend]: got }, null, 1)}\n`); }
        expect(got.put_page!.length).toBeGreaterThan(5);
        expect(got.canonical_import!.length).toBeGreaterThan(5);
        const want = process.env.CAPTURE_FOLD_NOOP === '1' ? got : golden[backend]!;
        const tailFrom = (sequence: string[]) => { const at = sequence.findLastIndex(sql => sql.startsWith('INSERT INTO persistence_effects (') || FOLD_PASS_ROW_WRITE.test(sql)); expect(at).toBeGreaterThan(0); return at; };
        const shape = (sequences: Record<string, string[]>) => backend === 'pglite' ? sequences : Object.fromEntries(Object.entries(sequences).map(([write, sequence]) =>
          [write, { statements: [...sequence].sort(), tail: sequence.slice(tailFrom(sequence)) }]));
        expect(shape(got)).toEqual(shape(want));
      } finally { rmSync(home, { recursive: true, force: true }); }
    }, 180_000);
  });
}
