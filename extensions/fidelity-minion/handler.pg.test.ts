import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { runPhaseSynthesizeConcepts } from '../../src/core/cycle/synthesize-concepts.ts';
import { cycleLockIdFor } from '../../src/core/cycle.ts';
import { withRefreshingLock } from '../../src/core/db-lock.ts';
import { makeExtractAtomsDrainHandler } from '../../src/core/minions/handlers/extract-atoms-drain.ts';
import { MinionQueue, MinionWorker } from '../../src/core/minions/index.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { __setMaintenanceWriteWaitForTests } from '../../src/core/persistence/maintenance-wait.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { guardedDatabasePagePreflight, maintenancePreflight, publishMaintenancePage } from '../../src/core/persistence/prepared-maintenance.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from '../../test/helpers/persistence-postgres.ts';
import { withEnv } from '../../test/helpers/with-env.ts';
import { fidelityQueue, JOB, prepareConcept, publishConcept, registerFidelityMinion } from './handler.ts';
import { dreamFidelityScopeKey, readCompletedDreamInputs, readDreamFidelityScope } from './dream-scope.ts';

const url = process.env.FIDELITY_ISOLATED_DATABASE_URL;
let db: Awaited<ReturnType<typeof isolatedPersistencePostgres>>;
let other: PostgresEngine;
const topic = 'writeback-acceptance';
const output = `concepts/minion-fidelity-${topic}`;
const atom = 'atoms/receipt-branches';
const rule = 'On timeout inspect the original request. On revision_conflict read the latest page and use a new request ID.';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

beforeAll(async () => {
  if (!url || new URL(url).hostname !== '127.0.0.1' || new URL(url).pathname !== '/gbrain_fidelity_test') throw new Error('Explicit isolated PostgreSQL required');
  db = await isolatedPersistencePostgres(url);
  other = new PostgresEngine();
  await other.connect({ database_url: db.databaseUrl, poolSize: 2 });
}, 60000);
afterAll(async () => {
  if (other) await other.disconnect();
  if (db) { await disposePersistenceConsumer(db.engine); await db.close(); }
});

async function fixture(run: (ctx: {
  sourceId: string; key: string; contract: string; root: string; put: (body: string, membership?: string, native?: string) => Promise<unknown>;
}) => Promise<void>) {
  const { engine } = db;
  const path = mkdtempSync(join(tmpdir(), 'gbrain-minion-fidelity-test-'));
  const root = join(path, 'content');
  mkdirSync(root);
  const sourceId = `minion-${randomUUID().slice(0, 8)}`;
  const key = `cycle.synthesize_concepts.fidelity.${sourceId}`;
  const contract = JSON.stringify({ [topic]: [{ atom, sha256: sha(rule) }] });
  await withEnv({ GBRAIN_HOME: join(path, 'home') }, async () => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
    await engine.setConfig('sync.write_through', 'true');
    await claimWorktree(engine, sourceId, root);
    const put = async (body: string, membership = topic, native = '') => {
      const snapshot = await engine.readPageSnapshot(atom, { sourceId });
      return submitPageMutation({
      engine, sourceId, remote: false, config: { engine: 'postgres', embedding_disabled: true } as never,
      dryRun: false, logger: {info() {}, warn() {}, error() {}},
    }, { operation: 'put_page', params: { slug: atom, request_id: randomUUID(), expected_revision: snapshot?.revision,
      content: `---\ntype: atom\ntitle: Request handling\nvisibility: private\nfidelity_concepts: [${membership}]\n${native}---\n${body}` } });
    };
    await put(rule);
    await engine.setConfig(key, contract);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    try { await run({ sourceId, key, contract, root, put }); }
    finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    }
  });
}

test('registered Minion writes one private page and the next job is unchanged', async () => {
  await fixture(async ({ sourceId }) => {
    const queueName = fidelityQueue({ sourceId, topic });
    const queue = new MinionQueue(db.engine);
    const worker = new MinionWorker(db.engine, { queue: queueName, pollInterval: 50 });
    registerFidelityMinion(worker, db.engine, { sourceId, topic });
    const task = worker.start();
    async function execute(data = { sourceId, topic }) {
      const job = await queue.add(JOB, data, { queue: queueName, max_attempts: 1 });
      for (let i = 0; i < 120; i++) {
        const current = await queue.getJob(job.id);
        if (current && ['completed', 'failed', 'dead'].includes(current.status)) return current;
        await Bun.sleep(100);
      }
      throw new Error('Minion did not settle');
    }
    try {
      const wrong = await execute({ sourceId: `${sourceId}-other`, topic });
      expect(wrong.status).toBe('dead');
      expect(wrong.error_text).toMatch(/target does not match/);
      expect(await other.getPage(output, { sourceId })).toBeNull();
      const first = await execute();
      expect(first.result).toMatchObject({ status: 'published', receipt: { state: 'committed' } });
      const before = await other.readPageSnapshot(output, { sourceId });
      expect(before?.page.compiled_truth).toBe(`${rule}\n\n[[${atom}]]`);
      expect(before?.page.frontmatter?.visibility).toBe('private');
      const edges = await other.executeRaw<{ direction: string }>(`
        SELECT l.link_type AS direction FROM links l
        JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
        WHERE f.source_id=$1 AND t.source_id=$1 AND l.link_source='concept-provenance'
          AND ((f.slug=$2 AND t.slug=$3) OR (f.slug=$3 AND t.slug=$2))
        ORDER BY direction`, [sourceId, output, atom]);
      expect(edges.map(edge => edge.direction)).toEqual(['synthesized_from', 'synthesizes']);
      const second = await execute();
      expect(second.result).toMatchObject({ status: 'unchanged', revision: before?.revision });
      expect((await other.readPageSnapshot(output, { sourceId }))?.revision).toBe(before?.revision);
    } finally { worker.stop(); await task; }
  });
}, 45000);

test('Dream waits for complete evidence and rechecks the source revision and activation before publication', async () => {
  await fixture(async ({ sourceId }) => {
    const engine = db.engine;
    const slug = 'notes/example-review';
    const scopeKey = `cycle.synthesize_concepts.fidelity_dream.${sourceId}`;
    const activation = JSON.stringify({ topic, pages: [slug] });
    const writeEvidence = async (text: string) => {
      const current = await engine.readPageSnapshot(slug, { sourceId });
      await submitPageMutation({
        engine, sourceId, remote: false, config: { engine: 'postgres', embedding_disabled: true } as never,
        dryRun: false, logger: {info() {}, warn() {}, error() {}},
      }, { operation: 'put_page', params: { slug, request_id: randomUUID(), expected_revision: current?.revision,
        content: `---\ntype: note\ntitle: Example review\nfacts_backstop: false\n---\n${text}` } });
    };
    const checkpoint = async (partial: boolean) => {
      await engine.executeRaw(`INSERT INTO extract_atoms_page_state
        (source_incarnation, page_id, content_hash, fail_count, tombstoned, partial_input_chars)
        SELECT s.incarnation, p.id, p.content_hash, 0, true, $3::integer
          FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.source_id=$1 AND p.slug=$2
        ON CONFLICT (source_incarnation, page_id, content_hash)
        DO UPDATE SET partial_input_chars=excluded.partial_input_chars`, [sourceId, slug, partial ? 100 : null]);
    };
    await writeEvidence('A synthetic decision was recorded.');
    expect(await readDreamFidelityScope(engine, sourceId)).toBeNull();
    await engine.setConfig(scopeKey, activation);
    const scope = (await readDreamFidelityScope(engine, sourceId))!;
    expect(await readCompletedDreamInputs(engine, sourceId, scope)).toBeNull();
    await checkpoint(true);
    expect(await readCompletedDreamInputs(engine, sourceId, scope)).toBeNull();
    await checkpoint(false);
    const evidence = (await readCompletedDreamInputs(engine, sourceId, scope))!;
    expect(evidence).toEqual([expect.objectContaining({ slug })]);
    const prepared = await prepareConcept(engine, { sourceId, topic });
    prepared.guard.evidencePages = evidence;
    prepared.guard.activation = scope.activation;

    await writeEvidence('A later revision contains a different decision.');
    expect(await readCompletedDreamInputs(engine, sourceId, scope)).toBeNull();
    await expect(publishConcept(engine, prepared)).rejects.toMatchObject({ code: 'revision_conflict' });

    await checkpoint(false);
    prepared.guard.evidencePages = (await readCompletedDreamInputs(engine, sourceId, scope))!;
    await engine.unsetConfig(scopeKey);
    await engine.setConfig(scopeKey, activation);
    await expect(publishConcept(engine, prepared)).rejects.toMatchObject({ code: 'revision_conflict' });
    expect(await other.getPage(output, { sourceId })).toBeNull();

    prepared.guard.activation = (await readDreamFidelityScope(engine, sourceId))!.activation;
    expect(await publishConcept(engine, prepared)).toMatchObject({ status: 'published', receipt: { state: 'committed' } });
    const first = await other.readPageSnapshot(output, { sourceId });
    expect(await publishConcept(engine, prepared)).toMatchObject({ status: 'unchanged', revision: first?.revision });
  });
}, 45000);

test('native Dream skips the reserved topic after resolving spelling variants and still publishes other topics', async () => {
  await fixture(async ({ sourceId }) => {
    const engine = db.engine;
    const scopeKey = `cycle.synthesize_concepts.fidelity_dream.${sourceId}`;
    await engine.setConfig(scopeKey, JSON.stringify({ topic, pages: ['notes/example-review'] }));
    const _atoms = [
      { slug: 'atoms/native-example-a', title: 'First example', body: 'First synthetic finding.', concept_refs: ['writebackacceptance', 'other-topic'] },
      { slug: 'atoms/native-example-b', title: 'Second example', body: 'Second synthetic finding.', concept_refs: ['Writeback acceptance', 'other-topic'] },
    ];
    const result = await runPhaseSynthesizeConcepts(engine, { sourceId, _atoms, dryRun: true });
    expect(result.details.concepts_written).toBe(1);
    await engine.unsetConfig(scopeKey);
    const ordinary = await runPhaseSynthesizeConcepts(engine, { sourceId, _atoms, dryRun: true });
    expect(ordinary.details.concepts_written).toBe(2);
  });
}, 45000);

test('a busy source lock retries the original scoped job instead of completing its daily slot', async () => {
  await fixture(async ({ sourceId }) => {
    const engine = db.engine;
    await engine.setConfig(`cycle.synthesize_concepts.fidelity_dream.${sourceId}`,
      JSON.stringify({ topic, pages: ['notes/example-review'] }));
    const scope = (await readDreamFidelityScope(engine, sourceId))!;
    const queueName = `lock-fixture-${sourceId}`;
    const queue = new MinionQueue(engine);
    const worker = new MinionWorker(engine, { queue: queueName, pollInterval: 50 });
    worker.register('extract-atoms-fidelity', makeExtractAtomsDrainHandler(engine, true));
    await withRefreshingLock(engine, cycleLockIdFor(sourceId), async () => {
      const idempotencyKey = `test-fidelity:${sourceId}`;
      const job = await queue.add('extract-atoms-fidelity', { sourceId, fidelityScopeKey: dreamFidelityScopeKey(scope) },
        { queue: queueName, idempotency_key: idempotencyKey, max_attempts: 3, backoff_type: 'fixed', backoff_delay: 60_000 },
        { allowProtectedSubmit: true });
      const running = worker.start();
      try {
        let result = await queue.getJob(job.id);
        for (let i = 0; i < 100 && result?.status !== 'delayed' && result?.status !== 'completed'; i++) {
          await Bun.sleep(50);
          result = await queue.getJob(job.id);
        }
        expect(result).toMatchObject({ id: job.id, idempotency_key: idempotencyKey, status: 'delayed', attempts_made: 1 });
        expect(result?.error_text).toContain('waiting for the source cycle lock');
        expect(await other.getPage(output, { sourceId })).toBeNull();
      } finally {
        worker.stop();
        await running;
      }
    });
  });
}, 45000);

test.each(['revoke', 'restore approval', 'edit atom', 'change membership'])(
  'durable guard rejects %s between preparation and commit', async change => {
    await fixture(async ({ sourceId, key, contract, put }) => {
      const prepared = await prepareConcept(db.engine, { sourceId, topic });
      if (change === 'revoke') await other.unsetConfig(key);
      if (change === 'restore approval') { await other.unsetConfig(key); await other.setConfig(key, contract); }
      if (change === 'edit atom') await put('Later atom body');
      if (change === 'change membership') await put(rule, 'other-topic');
      await expect(publishConcept(db.engine, prepared)).rejects.toMatchObject({ code: 'revision_conflict' });
      expect(await other.getPage(output, { sourceId })).toBeNull();
    });
  }, 45000,
);

test('revocation immediately before the coordinator locks the approval refuses publication', async () => {
  await fixture(async ({ sourceId, key }) => {
    const engine = db.engine;
    const prepared = await prepareConcept(engine, { sourceId, topic });
    const raw = engine.executeRaw;
    let revoked = false;
    engine.executeRaw = async function (this: PostgresEngine, ...args: Parameters<typeof raw>) {
      if (!revoked && args[0].includes('SELECT xmin::text AS version FROM config')) {
        revoked = true;
        await other.unsetConfig(key);
      }
      return raw.apply(this, args);
    } as typeof raw;
    try {
      await expect(publishConcept(engine, prepared)).rejects.toMatchObject({ code: 'revision_conflict' });
      expect(revoked).toBe(true);
      expect(await other.getPage(output, { sourceId })).toBeNull();
      const [request] = await other.executeRaw<{ state: string; error_code: string }>(
        'SELECT state,error_code FROM persistence_requests WHERE source_id=$1 AND slug=$2', [sourceId, output]);
      expect(request?.error_code).toBe('revision_conflict');
      expect(request?.state).not.toBe('committed');
    } finally { engine.executeRaw = raw; }
  });
}, 45000);

test('old input trust cannot be used by a guarded request', async () => {
  await fixture(async ({ sourceId }) => {
    const prepared = await prepareConcept(db.engine, { sourceId, topic });
    const pages = prepared.guard.pages.map(page => ({
      ...page, trustTier: page.trustTier === 'user_confirmed' ? 'unknown' : 'user_confirmed',
    }));
    await expect(publishConcept(db.engine, { ...prepared, guard: { ...prepared.guard, pages } }))
      .rejects.toMatchObject({ code: 'revision_conflict' });
    expect(await other.getPage(output, { sourceId })).toBeNull();
  });
}, 45000);

test('revocation after the approval lock waits for the committed publication', async () => {
  await fixture(async ({ sourceId, key }) => {
    const engine = db.engine;
    const prepared = await prepareConcept(engine, { sourceId, topic });
    const raw = engine.executeRaw;
    let revocation: Promise<number> | undefined;
    let waited = false;
    engine.executeRaw = async function (this: PostgresEngine, ...args: Parameters<typeof raw>) {
      const rows = await raw.apply(this, args);
      if (!revocation && args[0].includes('SELECT xmin::text AS version FROM config')) {
        revocation = other.unsetConfig(key);
        for (let i = 0; i < 100; i++) {
          const [row] = await other.executeRaw<{ waiting: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE 'delete%from config%') AS waiting");
          if (row?.waiting) { waited = true; break; }
          await Bun.sleep(10);
        }
      }
      return rows;
    } as typeof raw;
    try {
      expect(await publishConcept(engine, prepared)).toMatchObject({ status: 'published', receipt: { state: 'committed' } });
      expect(waited).toBe(true);
      expect(await revocation).toBe(1);
      expect(await other.getConfig(key)).toBeNull();
    } finally { engine.executeRaw = raw; }
  });
}, 45000);

const stockDispatch = process.env.FIDELITY_STOCK_MAINTENANCE_MODULE;
test.skipIf(!stockDispatch)('unmodified baseline dispatcher refuses the persisted guarded request', async () => {
  await fixture(async ({ sourceId }) => {
    const engine = db.engine;
    const prepared = await prepareConcept(engine, { sourceId, topic });
    await publishConcept(engine, prepared);
    const [row] = await other.executeRaw<WriteRequest>(
      'SELECT * FROM persistence_requests WHERE source_id=$1 AND slug=$2', [sourceId, output]);
    expect(row?.state).toBe('committed');
    expect(row?.intent?.kind).toBe('managed_maintenance_guarded_page_v1');
    const before = await other.readPageSnapshot(output, { sourceId });
    const baseline = await import(stockDispatch!);
    await expect(baseline.prepareMaintenanceMutation(engine, row, { engine: 'postgres' }))
      .rejects.toMatchObject({ code: 'invalid_params', message: 'Unsupported maintenance request.' });
    expect((await other.readPageSnapshot(output, { sourceId }))?.revision).toBe(before?.revision);
  });
}, 45000);

test('a provenance write failure rolls back the concept publication', async () => {
  await fixture(async ({ sourceId }) => {
    const engine = db.engine;
    const prepared = await prepareConcept(engine, { sourceId, topic });
    const add = engine.addLinksBatch;
    let failedProjection = false;
    engine.addLinksBatch = async function (this: PostgresEngine, ...args: Parameters<typeof add>) {
      if (args[0].some(link => link.link_source === 'concept-provenance')) {
        failedProjection = true;
        throw new Error('injected provenance failure');
      }
      return add.apply(this, args);
    };
    try {
      await expect(publishConcept(engine, prepared)).rejects.toMatchObject({ code: 'storage_error' });
      expect(failedProjection).toBe(true);
      expect(await other.getPage(output, { sourceId })).toBeNull();
      const [receipt] = await other.executeRaw<{ state: string; error_code: string }>(
        'SELECT state,error_code FROM persistence_requests WHERE source_id=$1 AND slug=$2', [sourceId, output]);
      expect(receipt).toMatchObject({ state: 'failed', error_code: 'storage_error' });
    } finally { engine.addLinksBatch = add; }
  });
}, 45000);


test('source and topic pairs cannot collide at a hyphen', () => {
  expect(fidelityQueue({ sourceId: 'a-b', topic: 'c' })).not.toBe(fidelityQueue({ sourceId: 'a', topic: 'b-c' }));
});

test('atoms assigned to native Dream are rejected', async () => {
  await fixture(async ({ sourceId, put }) => {
    await put(rule, topic, `concepts: [${topic}]\n`);
    await expect(prepareConcept(db.engine, { sourceId, topic })).rejects.toThrow('changed membership');
  });
}, 45000);

test('a pending durable publication keeps its original receipt identity on replay', async () => {
  await fixture(async ({ sourceId }) => {
    const prepared = await prepareConcept(db.engine, { sourceId, topic });
    const restore = __setMaintenanceWriteWaitForTests(0);
    let id: string;
    try {
      let error: unknown;
      try { await publishConcept(db.engine, prepared); } catch (err) { error = err; }
      expect(error).toMatchObject({ code: 'write_pending', writeRequest: { request_id: expect.any(String) } });
      id = (error as { writeRequest: { request_id: string } }).writeRequest.request_id;
    } finally { restore(); }
    const replay = await publishConcept(db.engine, prepared);
    expect(replay).toMatchObject({ receipt: { request_id: id!, state: 'committed' } });
    const rows = await other.executeRaw('SELECT request_id FROM persistence_requests WHERE source_id=$1 AND slug=$2', [sourceId, output]);
    expect(rows).toHaveLength(1);
  });
}, 45000);


test('only guarded database publication can preflight without a readable worktree', async () => {
  await fixture(async ({ sourceId, root }) => {
    const engine = db.engine;
    const hidden = root + '-offline';
    renameSync(root, hidden);
    try {
      await expect(maintenancePreflight(engine, sourceId)).rejects.toThrow();
      const authority = await guardedDatabasePagePreflight(engine, sourceId);
      expect(authority?.binding).toBeNull();
      await expect(publishMaintenancePage(engine, authority!, 'notes/should-not-publish', 'test', { expectedRevision: null }))
        .rejects.toThrow('Guarded database-only authority');
      const prepared = await prepareConcept(engine, { sourceId, topic });
      expect(await publishConcept(engine, prepared)).toMatchObject({ receipt: { state: 'committed' } });
      expect((await other.getPage(output, { sourceId }))?.source_path).toBeNull();
      expect(existsSync(join(hidden, output + '.md'))).toBe(false);
    } finally { renameSync(hidden, root); }
  });
}, 45000);
