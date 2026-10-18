import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { disposePersistenceConsumer, startPersistenceConsumer, waitForWrite } from '../src/core/persistence/service.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { connectorCheckpointKey, connectorIdentity, connectorIdentityLeaves } from '../src/core/persistence/connector-identity.ts';
import { orphanConnectorCheckpoints } from '../src/core/persistence/connector-checkpoint-migration.ts';
import { digest } from '../src/core/persistence/digest.ts';
import { MIGRATIONS } from '../src/core/schema-migrations/registry.generated.ts';
import { runMigrations } from '../src/core/migrate.ts';
import { resumeCheckpoint } from '../src/core/persistence/connector-sync.ts';
import { connectorCheckpointsRepair, ORPHAN_CHECKPOINT_MIN_AGE_DAYS } from '../src/core/repair/connector-checkpoints.ts';
import { resolveRepairScope, runRepair } from '../src/core/repair/core.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, options, json, googleConfig, contact, withPausedOwnerBudget } from './helpers/connector-fixture.ts';

const { engines, env, source, boundSource, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

async function mark(engine: BrainEngine, sourceId: string): Promise<string> {
  const [row] = await engine.executeRaw<{ seq: string | null }>('SELECT max(sequence)::text AS seq FROM persistence_requests WHERE source_id=$1', [sourceId]);
  return row?.seq ?? '0';
}

/** Page and checkpoint admissions since `after`, classified across both intent namespaces. */
async function admissions(engine: BrainEngine, sourceId: string, after: string) {
  const rows = await engine.executeRaw<{ kind: string }>('SELECT intent->>\'kind\' AS kind FROM persistence_requests WHERE source_id=$1 AND sequence>$2::bigint', [sourceId, after]);
  return { pages: rows.filter(r => /_(import|delete)$/.test(r.kind)).length, checkpoints: rows.filter(r => r.kind.endsWith('_checkpoint')).length };
}

async function stamp(engine: BrainEngine, sourceId: string): Promise<void> {
  const now = new Date().toISOString();
  expect(await engine.updateSourceConfig(sourceId, { last_source_cycle_at: now, last_full_cycle_at: now })).toBe(true);
}

/** A People fixture: `rotate` changes the sync token every sweep; `rewalk` ignores the token and lists everything. */
function peopleFetcher(opts: { rotate?: boolean; rewalk?: boolean; onList?: () => Promise<void> } = {}) {
  const calls: string[] = [];
  let sweep = 0;
  const fetcher = async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    if (url.includes('/settings/sendAs')) return json({ sendAs: [] });
    if (u.pathname.endsWith('/people/me')) return json({ resourceName: 'people/me', emailAddresses: [{ value: googleConfig.g_account, metadata: { primary: true } }] });
    if (u.pathname.endsWith('/people/me/connections')) {
      await opts.onList?.();
      const token = opts.rotate ? `contacts-${++sweep}` : 'contacts-stable';
      if (u.searchParams.has('syncToken') && !opts.rewalk) return json({ connections: [], nextSyncToken: token });
      return json({ connections: [contact('first', 'First Example'), contact('second', 'Second Example')], nextSyncToken: token });
    }
    throw new Error(`Unexpected external fixture route ${u.pathname}`);
  };
  return { fetcher, calls };
}

test('#5686: two connector cycles with a cycle stamp between them resume one checkpoint and admit nothing new', async () => withEnv(env, async () => {
  for (const engine of engines) for (const bound of [false, true]) {
    const f = bound ? await boundSource(engine, googleConfig) : await source(engine, googleConfig);
    const cfg = parseGoogleSourceConfig(googleConfig, f.dir);
    const { fetcher, calls } = peopleFetcher();
    expect((await runGoogleSync(engine, f.id, cfg, options, fetcher)).added).toBe(2);
    await stamp(engine, f.id);
    await disposePersistenceConsumer(engine);
    const before = await mark(engine, f.id);
    calls.length = 0;
    const second = await runGoogleSync(engine, f.id, cfg, options, fetcher);
    expect(second.status).not.toBe('partial');
    expect(calls.some(url => url.includes('syncToken=contacts-stable'))).toBe(true);
    expect(await admissions(engine, f.id, before)).toEqual({ pages: 0, checkpoints: 0 });
  }
}), 180_000);

test('#5686: a cycle stamp landing mid-sweep does not abort the connector sweep', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, googleConfig);
    const { fetcher } = peopleFetcher({ onList: () => stamp(engine, f.id) });
    const result = await runGoogleSync(engine, f.id, parseGoogleSourceConfig(googleConfig, f.dir), options, fetcher);
    expect(result.status).not.toBe('partial');
    expect(result.added).toBe(2);
  }
}), 120_000);

test('#5686: a connector write still pending when the stamp lands publishes instead of failing source_changed', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await boundSource(engine, googleConfig);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("UPDATE persistence_worktrees SET state='draining' WHERE id=$1::uuid", [f.binding.worktree_id]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const { fetcher } = peopleFetcher();
    try { await withPausedOwnerBudget(() => runGoogleSync(engine, f.id, parseGoogleSourceConfig(googleConfig, f.dir), options, fetcher)); } catch { /* pending admission */ }
    const pending = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND intent->>'kind' LIKE '%import' AND state='queued'", [f.id]);
    expect(pending.length).toBeGreaterThan(0);
    await stamp(engine, f.id);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw("UPDATE persistence_worktrees SET state='active' WHERE id=$1::uuid", [f.binding.worktree_id]);
    startPersistenceConsumer(engine, { engine: engine.kind });
    for (const row of pending) expect((await waitForWrite(engine, row, { engine: engine.kind }, 20_000)).state).toBe('committed');
    expect(readFileSync(join(f.dir, 'people/first-example.md'), 'utf8')).toContain('First Example');
  }
}), 120_000);

test('#5470: a re-walk of unchanged provider content admits no page and, with a stable cursor, no checkpoint', async () => withEnv(env, async () => {
  for (const engine of engines) for (const bound of [false, true]) {
    const f = bound ? await boundSource(engine, googleConfig) : await source(engine, googleConfig);
    const cfg = parseGoogleSourceConfig(googleConfig, f.dir);
    const { fetcher } = peopleFetcher({ rewalk: true });
    expect((await runGoogleSync(engine, f.id, cfg, options, fetcher)).added).toBe(2);
    await disposePersistenceConsumer(engine);
    const before = await mark(engine, f.id);
    const second = await runGoogleSync(engine, f.id, cfg, options, fetcher);
    expect(second.status).toBe('up_to_date');
    expect(await admissions(engine, f.id, before)).toEqual({ pages: 0, checkpoints: 0 });
  }
}), 180_000);

test('#5470: a rotating provider cursor costs exactly one checkpoint admission and no page admission per quiet run', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, googleConfig);
    const cfg = parseGoogleSourceConfig(googleConfig, f.dir);
    const { fetcher } = peopleFetcher({ rotate: true, rewalk: true });
    expect((await runGoogleSync(engine, f.id, cfg, options, fetcher)).added).toBe(2);
    for (let run = 0; run < 2; run++) {
      await stamp(engine, f.id);
      await disposePersistenceConsumer(engine);
      const before = await mark(engine, f.id);
      expect((await runGoogleSync(engine, f.id, cfg, options, fetcher)).status).toBe('up_to_date');
      expect(await admissions(engine, f.id, before)).toEqual({ pages: 0, checkpoints: 1 });
    }
  }
}), 180_000);

// #6561: v0.60.176.0 hashed the new default `contactsDir` into the identity, so a source upgraded across it had
// a completed pre-field cursor and an interim one. Nothing rewrites those rows on upgrade: the loader picks the
// cursor at run time and every write goes to the stable (pre-field) key. Keys are derived here from the leaves
// themselves (not from the fixed identity function), so the same test runs against a build that still hashes
// the default.
async function identityKeys(engine: BrainEngine, f: { id: string; dir: string }) {
  const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text FROM sources WHERE id=$1', [f.id]);
  const interimLeaves = connectorIdentityLeaves('google', connectorIdentity('google', googleConfig, f.dir).config, false);
  const { contactsDir: _default, ...preFieldLeaves } = interimLeaves;
  const key = (identity: Record<string, unknown>) => connectorCheckpointKey(f.id, incarnation, { kind: 'google', digest: digest({ kind: 'google', identity }) });
  return { preField: key(preFieldLeaves), interim: key(interimLeaves) };
}
type Checkpoint = Array<{ generation?: number; state?: Record<string, unknown> | null }>;
const readRow = async (engine: BrainEngine, fingerprint: string) => (await engine.executeRaw<{ completed_keys: Checkpoint }>(
  "SELECT completed_keys FROM op_checkpoints WHERE op='managed-connector' AND fingerprint=$1", [fingerprint]))[0]?.completed_keys ?? null;
const writeRow = (engine: BrainEngine, fingerprint: string, value: Checkpoint, daysAgo: number) => engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at)
  VALUES('managed-connector',$1,$2::text::jsonb,now()-make_interval(days => $3::integer)) ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=EXCLUDED.updated_at`,
[fingerprint, JSON.stringify(value), daysAgo]);
const snapshotRows = (engine: BrainEngine, keys: string[]) => engine.executeRaw<{ fingerprint: string; completed_keys: unknown; at: string }>(
  "SELECT fingerprint,completed_keys,updated_at::text AS at FROM op_checkpoints WHERE fingerprint = ANY($1::text[]) ORDER BY fingerprint", [keys]);

/** One completed sweep, then its cursor laid out the way an upgrade across the interim releases leaves it. */
async function upgradedSource(engine: BrainEngine, layout: 'pre-field completed + interim partial' | 'interim only') {
  const f = await source(engine, googleConfig);
  const { fetcher, calls } = peopleFetcher();
  expect((await runGoogleSync(engine, f.id, parseGoogleSourceConfig(googleConfig, f.dir), options, fetcher)).added).toBe(2);
  await disposePersistenceConsumer(engine);
  const keys = await identityKeys(engine, f);
  const completed = (await readRow(engine, keys.preField)) ?? (await readRow(engine, keys.interim));
  expect(completed?.[0]?.state?.contacts_sync_token).toBe('contacts-stable');
  await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='managed-connector' AND fingerprint = ANY($1::text[])", [[keys.preField, keys.interim]]);
  if (layout === 'interim only') await writeRow(engine, keys.interim, completed!, 30);
  else {
    await writeRow(engine, keys.preField, completed!, 40);
    await writeRow(engine, keys.interim, [{ generation: 1, state: { ...completed![0]!.state, contacts_sync_token: null } }], 30);
  }
  return { f, keys, fetcher, calls };
}
const quietCapture = async (engine: BrainEngine, f: { id: string; dir: string }, fetcher: (url: string) => Promise<Response>, calls: string[]) => {
  const before = await mark(engine, f.id);
  calls.length = 0;
  expect((await runGoogleSync(engine, f.id, parseGoogleSourceConfig(googleConfig, f.dir), options, fetcher)).status).toBe('up_to_date');
  await disposePersistenceConsumer(engine);
  return { usedCursor: calls.some(url => url.includes('syncToken=contacts-stable')), admitted: await admissions(engine, f.id, before) };
};

test('#6561: only the interim key holds a cursor: the run resumes from it, its one save lands on the stable key, and the next run admits nothing', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const { f, keys, fetcher, calls } = await upgradedSource(engine, 'interim only');
    const interim = await readRow(engine, keys.interim);
    expect(await quietCapture(engine, f, fetcher, calls)).toEqual({ usedCursor: true, admitted: { pages: 0, checkpoints: 1 } });
    const stable = await readRow(engine, keys.preField);
    expect(stable?.[0]?.state?.contacts_sync_token).toBe('contacts-stable');
    expect(stable?.[0]?.generation).toBe(Number(interim![0]!.generation ?? 0) + 1);
    expect(await readRow(engine, keys.interim)).toEqual(interim);
    expect(await quietCapture(engine, f, fetcher, calls)).toEqual({ usedCursor: true, admitted: { pages: 0, checkpoints: 0 } });
    expect((await orphanConnectorCheckpoints(engine, { minAgeDays: ORPHAN_CHECKPOINT_MIN_AGE_DAYS })).map(row => row.fingerprint)).not.toContain(keys.interim);
  }
}), 180_000);

test('#6561: when the interim cursor is the newer completed backfill, the run resumes from it and saves to the stable key', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const { f, keys, fetcher, calls } = await upgradedSource(engine, 'interim only');
    const interim = (await readRow(engine, keys.interim))!;
    const gmail = (newest: number) => ({ gmail_history_id: `h-${newest}`, gmail_backfill_floor_ms: 1, gmail_backfill_done: true, gmail_newest_ms: newest });
    await writeRow(engine, keys.preField, [{ generation: 5, state: { ...interim[0]!.state, ...gmail(1_000), contacts_sync_token: 'contacts-old' } }], 40);
    await writeRow(engine, keys.interim, [{ generation: 2, state: { ...interim[0]!.state, ...gmail(2_000) } }], 30);
    expect(await quietCapture(engine, f, fetcher, calls)).toEqual({ usedCursor: true, admitted: { pages: 0, checkpoints: 1 } });
    expect(calls.some(url => url.includes('syncToken=contacts-old'))).toBe(false);
    const stable = await readRow(engine, keys.preField);
    expect(stable?.[0]).toMatchObject({ generation: 6, state: { gmail_newest_ms: 2_000, contacts_sync_token: 'contacts-stable' } });
  }
}), 180_000);

test('#6561: a pre-field completed cursor and a newer interim partial one both survive the orphan scan; the run resumes the completed cursor and admits nothing', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const { f, keys, fetcher, calls } = await upgradedSource(engine, 'pre-field completed + interim partial');
    const retryKey = `retry-${f.id}`;
    await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at)
      VALUES('managed-connector-retry',$1,$2::text::jsonb,now()-interval '30 days')`, [retryKey, JSON.stringify([{ checkpointKey: keys.interim, baseRequestId: retryKey }])]);
    const orphans = (await orphanConnectorCheckpoints(engine, { minAgeDays: ORPHAN_CHECKPOINT_MIN_AGE_DAYS })).map(row => row.fingerprint);
    for (const kept of [keys.preField, keys.interim, retryKey]) expect(orphans).not.toContain(kept);
    const ctx = { engine, config: { engine: engine.kind }, remote: false, logger: console } as unknown as OperationContext;
    expect((await runRepair(ctx, connectorCheckpointsRepair, await resolveRepairScope(engine), { apply: false })).residuals?.alias_protected).toBeGreaterThanOrEqual(2);
    expect(await quietCapture(engine, f, fetcher, calls)).toEqual({ usedCursor: true, admitted: { pages: 0, checkpoints: 0 } });
  }
}), 180_000);

test('#6561: upgrade writes no connector checkpoint row: schema migrations, including the v176 re-key handler, leave both cursors untouched', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const { keys } = await upgradedSource(engine, 'pre-field completed + interim partial');
    const before = await snapshotRows(engine, [keys.preField, keys.interim]);
    expect(before).toHaveLength(2);
    await runMigrations(engine);
    for (const migration of MIGRATIONS.filter(m => /connector/.test(m.name) && m.handler)) await migration.handler!(engine);
    expect(await snapshotRows(engine, [keys.preField, keys.interim])).toEqual(before);
  }
}), 180_000);

test('#6561 loader rule: an alias wins only when written after the stable row and it is the newer completed backfill; a reset or reopened stable row never falls back', () => {
  const row = (fingerprint: string, at: number, generation: number, state: Record<string, unknown> | null) => ({ fingerprint, at, completed_keys: [{ generation, state }] });
  const done = (newest: number) => ({ gmail_backfill_done: true, gmail_newest_ms: newest });
  expect(resumeCheckpoint(null, [])).toEqual([]);
  expect(resumeCheckpoint(null, [row('a', 1, 3, done(5))])).toEqual([{ generation: 3, state: done(5) }]);
  expect(resumeCheckpoint(row('s', 1, 7, done(5)), [row('a', 2, 3, done(9))])).toEqual([{ generation: 7, state: done(9) }]);
  expect(resumeCheckpoint(row('s', 1, 7, done(9)), [row('a', 2, 3, done(5))])).toEqual([{ generation: 7, state: done(9) }]);
  expect(resumeCheckpoint(row('s', 1, 7, done(5)), [row('a', 2, 3, { ...done(9), gmail_backfill_done: false })])).toEqual([{ generation: 7, state: done(5) }]);
  // The stable row this release saved is newer than any alias: a reset (state null) or a reopened backfill stays.
  expect(resumeCheckpoint(row('s', 3, 8, null), [row('a', 2, 3, done(9))])).toEqual([{ generation: 8, state: null }]);
  expect(resumeCheckpoint(row('s', 3, 8, { ...done(1), gmail_backfill_done: false }), [row('a', 2, 3, done(9))]))
    .toEqual([{ generation: 8, state: { ...done(1), gmail_backfill_done: false } }]);
});
