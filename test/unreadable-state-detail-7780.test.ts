/**
 * #7780: one `unreadable_state` refusal covers four raises: the managed-writer guard's hidden or missing
 * `persistence_brain` or `git_canonical_brain` singleton, a source or page row-level security hides, and the git-canonical
 * recount, which refuses whenever row-level security applies to `sources`, even under a policy that shows every row.
 * The text claimed "row-level security hides it" for all of them, and the detail dropped the `state` each raise names, so
 * an operator could not tell which table to fix. Contract: the text holds for every raise, the owner-only detail keeps
 * `state` (never on the public receipt), and an unreadable_state receipt gets the role remedy, not the version-mismatch one.
 * Runs on PGLite, and on an isolated Postgres database through test/e2e/unreadable-state-detail-7780-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite, receiptFor } from '../src/core/persistence/journal.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { databaseRefusal, publicFailureDetail } from '../src/core/persistence/publication-failure.ts';
import { readWriterDiagnostics } from '../src/core/persistence/diagnostics.ts';
import { writeResponse } from '../src/core/persistence/service.ts';
import { DATABASE_REFUSAL_HINT } from '../src/core/persistence/connector-errors.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const sourceId = 'source-a';
const hostId = randomUUID();
const ROLLBACK = 'unreadable-probe-rollback';
const UNREADABLE = 'writer_coordinator_required: writer state is unreadable to this database role';
const TEXT = 'writer state this database role cannot fully read (row-level security hides it or applies to the role, or a singleton row is missing)';

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({}); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
  for (const engine of engines) {
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [sourceId]);
    await registerLocalWriter(engine, 'cli');
  }
}, 180_000);
afterAll(async () => {
  for (const engine of engines) if (engine.kind === 'pglite') await engine.disconnect();
  await closePostgres?.();
});

async function refusal(engine: BrainEngine, statements: string[]): Promise<unknown> {
  try {
    await engine.transaction(async tx => {
      for (const statement of statements) await tx.executeRaw(statement);
      throw new Error(ROLLBACK);
    });
  } catch (error) { return error; }
  return null;
}
async function managed<T>(engine: BrainEngine, fn: () => Promise<T>): Promise<T> {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  try { return await fn(); } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1'); }
}
const newPage = `INSERT INTO pages(source_id,slug,type,title,compiled_truth) VALUES('${sourceId}','notes/unreadable-probe','note','Probe','body')`;
const ctx = (engine: BrainEngine): OperationContext => ({ engine, config: { engine: engine.kind }, sourceId, remote: false,
  dryRun: false, logger: { info() {}, warn() {}, error() {} } });
const input = (body: string) => ({ type: 'note', title: 'Example', compiled_truth: body, timeline: '', frontmatter: {} });

for (const backend of backends) describe(`${backend}: unreadable_state names its table (#7780)`, () => {
  const engine = () => engines.find(e => e.kind === backend)!;

  test('each real unreadable_state raise keeps its state owner-side under a text true for all of them', async () => {
    const db = engine();
    const brain = databaseRefusal(await refusal(db, ['DELETE FROM persistence_brain WHERE singleton=1', newPage]))!;
    expect(brain).toEqual({ code: 'writer_coordinator_required',
      message: `The managed-writer database guard refused an INSERT on pages: ${TEXT}. Nothing was committed.`,
      detail: { origin: 'database_guard', sqlstate: 'P0001', raiser: 'gbrain_require_managed_writer', table: 'pages', op: 'INSERT',
        branch: 'unreadable_state', relationship: 'unreadable_state', state: 'persistence_brain' } });
    expect(publicFailureDetail(brain.detail)).not.toHaveProperty('state');

    const git = await managed(db, () => refusal(db, [
      `SELECT set_config('gbrain.write_sources','["${sourceId}"]',true),set_config('gbrain.git_protocol','',true)`,
      'DELETE FROM git_canonical_brain WHERE singleton=1', newPage]));
    expect(databaseRefusal(git)).toMatchObject({ code: 'writer_coordinator_required',
      detail: { sqlstate: 'P0001', relationship: 'unreadable_state', state: 'git_canonical_brain' } });

    const [request] = await db.executeRaw<{ id: string }>(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,
        source_id,source_incarnation,slug,digest,authority,intent_bytes,terminal_reservation)
      SELECT 'application','unreadable-7780',gen_random_uuid(),'put_page',id,incarnation,'notes/unreadable-7780','digest','{}'::jsonb,0,0
      FROM sources WHERE id=$1 RETURNING id::text AS id`, [sourceId]);
    try {
      const floor = databaseRefusal(await refusal(db, ['DELETE FROM persistence_brain WHERE singleton=1',
        `UPDATE persistence_requests SET updated_at=now() WHERE id='${request!.id}'::uuid`]));
      expect(floor).toMatchObject({ code: 'writer_coordinator_required',
        detail: { sqlstate: '42501', raiser: 'gbrain_guard_request_protocol', relationship: 'unreadable_state', state: 'persistence_brain' } });
    } finally {
      await db.executeRaw('DELETE FROM persistence_requests WHERE id=$1::uuid', [request!.id]);
    }
  });

  test('an unreadable_state publication receipt carries the role remedy, and its state stays owner-only', async () => {
    const db = engine();
    await managed(db, async () => {
      const slug = `notes/unreadable-publication-${backend}`;
      const [source] = await db.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
      const authority = await submissionAuthority(ctx(db), 'put_page', sourceId, source!.incarnation, slug);
      await admitWrite(db, { principal: authority.principal, operation: 'put_page', sourceId, sourceIncarnation: source!.incarnation, slug,
        pageId: null, requestId: randomUUID(), callerIntent: { content: slug }, intent: { content: slug }, authority });
      const row = (await claimNextWrite(db, hostId))!;
      const done = await publishMutation(db, row, { observedRevision: null, apply: async tx => {
        await tx.putPage(slug, input('must roll back'), { sourceId });
        // The managed-writer guard reads persistence_brain as the writing role; a missing row is what row-level security shows it.
        await tx.executeRaw('DELETE FROM persistence_brain WHERE singleton=1');
        await tx.putPage(`${slug}-second`, input('refused'), { sourceId });
        return { status: 'created' };
      } }, hostId);

      expect(done.state).toBe('failed');
      expect(done.error_code).toBe('writer_coordinator_required');
      expect(done.error_detail).toMatchObject({ origin: 'database_guard', sqlstate: 'P0001', relationship: 'unreadable_state', state: 'persistence_brain' });
      expect(await db.readPageSnapshot(slug, { sourceId })).toBeNull();
      expect((receiptFor(done) as Record<string, unknown>).write_error_detail).not.toHaveProperty('state');

      let refused: Record<string, unknown> = {};
      try { writeResponse(done); } catch (error) { refused = error as Record<string, unknown>; }
      expect(refused).toMatchObject({ code: 'writer_coordinator_required', detail: 'database_guard',
        docs: 'docs/guides/write-refusals.md#writer-coordinator-required' });
      expect(refused.suggestion).not.toBe(DATABASE_REFUSAL_HINT);
      expect(refused.suggestion).toContain('Upgrading gbrain does not fix this');
      expect(refused.suggestion).toContain('recent_failures[].error_detail.state names the table');
      expect(refused.suggestion).toContain('Ask the user before changing the database role');
      const failure = (await readWriterDiagnostics(db)).recent_failures.find(f => f.request_id === done.request_id)!;
      expect(failure.error_detail).toMatchObject({ state: 'persistence_brain' });
      expect(failure.next_action).toBe(refused.suggestion as string);
    });
  });
});

describe('unreadable_state state is a closed set (#7780)', () => {
  const raised = (state: unknown) => Object.assign(new Error(UNREADABLE), { code: 'P0001', table: 'sources',
    constraint: 'managed_writer_guard:unreadable_state', where: 'PL/pgSQL function gbrain_count_git_canonical_sources() line 5 at RAISE',
    detail: JSON.stringify({ op: 'UPDATE', relationship: 'unreadable_state', state }) });

  test('the recount refusal names sources; a state outside the four guard tables is dropped', () => {
    expect(databaseRefusal(raised('sources'))?.detail).toMatchObject({ relationship: 'unreadable_state', state: 'sources' });
    for (const state of ['alice-example', 'pages; DROP', 42, null]) expect(databaseRefusal(raised(state))?.detail).not.toHaveProperty('state');
  });
});
