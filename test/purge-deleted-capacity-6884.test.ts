/**
 * #6884: the managed purge (`gbrain pages purge-deleted`, the cycle purge
 * phase, the Minion job) submitted every expired tombstone whatever the
 * writer's outstanding-request room, so a large backlog became thousands of
 * `queue_capacity` failures, each recorded toward a park, while the admitted
 * purges sat ahead of interactive writes.
 *
 * Protects (fail-first against master): a run submits only while the writer
 * has outstanding room; the rest is `capacity_deferred` (blocked code
 * `write_capacity_deferred`), never a failure, never a park and never a
 * permanent request id, and the phase warns instead of failing; a background
 * run stops at `persistence.capacity.background_pause_pct` of the cap while
 * an interactive run uses the whole cap; freed room is used by the next run.
 * Master: `failed` per tombstone, `managed_purge_failed`, a park record each.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { requestPrincipalForContext, submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { purgeDeletedPagesCoordinated, purgePhaseNote, purgePhaseStatus } from '../src/core/persistence/purge-deleted.ts';
import { readPurgeParks } from '../src/core/persistence/purge-parks.ts';
import { withAdmissionOrigin } from '../src/core/persistence/admission-origin.ts';
import { principalKey } from '../src/core/persistence/model.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const SOURCE = 'purge-capacity';
const SLUGS = ['notes/expired-a', 'notes/expired-b', 'notes/expired-c'];
let engine: PGLiteEngine;
let dir: string;
let key: string;

const env = () => ({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_SOURCE: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
  OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined });
const ctx = (): OperationContext => ({ engine, sourceId: SOURCE, remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} },
  config: { engine: engine.kind, embedding_disabled: true } as never });

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });

beforeEach(async () => {
  await disposePersistenceConsumer(engine);
  await resetPgliteState(engine);
  dir = mkdtempSync(join(tmpdir(), 'gb-purge-capacity-'));
  const root = join(dir, 'brain');
  mkdirSync(root);
  await withEnv(env(), async () => {
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [SOURCE, root]);
    await engine.setConfig('sync.write_through', 'true');
    await claimWorktree(engine, SOURCE, root);
    for (const slug of SLUGS) {
      await submitPageMutation(ctx(), { operation: 'put_page', params: { slug, content: `---\ntitle: ${slug}\ntype: note\n---\nGone soon.`, request_id: randomUUID() } });
      const snapshot = await engine.readPageSnapshot(slug, { sourceId: SOURCE });
      await submitPageMutation(ctx(), { operation: 'delete_page', params: { slug, expected_revision: snapshot!.revision, request_id: randomUUID() } });
    }
    await engine.executeRaw("UPDATE pages SET deleted_at=now() - interval '100 hours' WHERE source_id=$1", [SOURCE]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    key = principalKey(await requestPrincipalForContext(ctx()));
  });
});
afterEach(async () => { await disposePersistenceConsumer(engine); rmSync(dir, { recursive: true, force: true }); });

const purge = () => withEnv(env(), () => purgeDeletedPagesCoordinated(engine, 72));
const purgeRequests = async () => (await engine.executeRaw(`SELECT 1 FROM persistence_requests WHERE source_id=$1 AND operation='delete_page' AND intent->>'purge'='true'`, [SOURCE])).length;
const lifetimeIds = async () => Number((await engine.executeRaw<{ n: string }>("SELECT lifetime_ids::text AS n FROM persistence_counters WHERE key='brain'"))[0]?.n ?? 0);
const tombstones = async () => (await engine.executeRaw('SELECT 1 FROM pages WHERE source_id=$1', [SOURCE])).length;
/** Outstanding requests of the purge's own principal held by another owner's worktree (never claimable here). */
async function occupy(count: number): Promise<string[]> {
  const [worktree] = await engine.executeRaw<{ id: string }>("INSERT INTO persistence_worktrees(owner_host_id,state) VALUES (gen_random_uuid(),'active') RETURNING id::text AS id");
  const [kind, id] = [key.split(':')[1]!, key.split(':').slice(2).join(':')];
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const requestId = randomUUID();
    await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,worktree_id,digest,intent,authority,state,intent_bytes,terminal_reservation)
      VALUES ($1,$2,$3::uuid,'put_page',$4,(SELECT incarnation FROM sources WHERE id=$4),'held/'||$3,$5::uuid,'d','{}'::jsonb,'{}'::jsonb,'queued',0,0)`, [kind, id, requestId, SOURCE, worktree!.id]);
    ids.push(requestId);
  }
  await engine.executeRaw("UPDATE persistence_counters SET lifetime_ids=lifetime_ids+$2,outstanding_count=outstanding_count+$2 WHERE key IN ('brain',$1)", [key, count]);
  return ids;
}
async function release(requestId: string): Promise<void> {
  await engine.executeRaw("UPDATE persistence_requests SET state='committed',completed_at=now() WHERE request_id=$1::uuid", [requestId]);
  await engine.executeRaw("UPDATE persistence_counters SET outstanding_count=outstanding_count-1 WHERE key IN ('brain',$1)", [key]);
}

describe('#6884 managed purge capped to the free write capacity', () => {
  // A caller that sets no origin is background (admission-origin.ts), so this run stops at 80% of the cap of 3, i.e. below 2.
  test('no outstanding room: every tombstone is deferred, nothing fails, parks or takes a request id; freed room is used by the next run', async () => {
    await engine.setConfig('persistence.limits.principal_outstanding', '3');
    const held = await occupy(3);
    const ids = await lifetimeIds();
    const deferred = await purge();
    expect(deferred).toMatchObject({ count: 0, failed: 0, capacity_deferred: 3, parked: 0 });
    expect(deferred.error).toBeUndefined();
    expect(deferred.blocked.map(b => b.code)).toEqual(['write_capacity_deferred', 'write_capacity_deferred', 'write_capacity_deferred']);
    expect(deferred.blocked[0]!.reason).toContain('3 principal outstanding write requests are in use, and this run submits only below 2');
    expect(purgePhaseStatus(deferred)).toBe('warn');
    expect(purgePhaseNote(deferred)).toContain('3 deferred to the next run');
    expect(await purgeRequests()).toBe(0);
    expect(await lifetimeIds()).toBe(ids);
    expect((await readPurgeParks(engine)).size).toBe(0);
    await release(held[0]!);
    await release(held[1]!);
    const next = await purge();
    expect(next).toMatchObject({ count: 3, failed: 0, capacity_deferred: 0 });
    expect(await tombstones()).toBe(0);
  }, 60_000);

  test('a background run stops at the pause line of the outstanding cap; an interactive run uses the rest', async () => {
    await engine.setConfig('persistence.limits.principal_outstanding', '10');
    await occupy(8);
    const background = await withAdmissionOrigin('background', () => purge());
    expect(background).toMatchObject({ count: 0, failed: 0, capacity_deferred: 3 });
    expect(background.blocked[0]!.reason).toContain('a background run stops at 80% of the cap');
    expect(await purgeRequests()).toBe(0);
    const interactive = await withAdmissionOrigin('interactive', () => purge());
    expect(interactive).toMatchObject({ count: 3, failed: 0, capacity_deferred: 0 });
  }, 60_000);
});
