/**
 * #6858 ask 6: commit→searchable and commit→embedded latency (src/core/persistence/sync-freshness.ts), doctor
 * `managed_sync_latency` (src/commands/doctor/checks/managed-sync-latency.ts) and the additive `freshness` block of
 * `gbrain sync status --json`. Fixtures: a claimed managed worktree whose commit carries a chosen committer time, and
 * committed `managed_sync_import` receipts stamped at chosen `completed_at` values, with pages and chunks for the
 * embedded side. PGLite always; Postgres when DATABASE_URL is set (test/postgres-unit-arms.txt).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { readSyncFreshness, formatSyncFreshness } from '../src/core/persistence/sync-freshness.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { managedSyncLatencyEntry } from '../src/commands/doctor/checks/managed-sync-latency.ts';
import { runSyncStatus } from '../src/commands/sync/operator.ts';
import { renderHuman, type StatusReport } from '../src/commands/status.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-freshness-'));
const engines: Array<{ name: string; engine: BrainEngine }> = [];
let closePostgres: (() => Promise<void>) | undefined;
const FROM = 'f'.repeat(40);

interface Fixture { id: string; root: string; worktreeId: string; incarnation: string; sha: string; committedAt: number }
/** A managed source whose HEAD commit was made `ageSeconds` ago (committer time). */
async function managedSource(engine: BrainEngine, ageSeconds: number): Promise<Fixture> {
  const id = `fresh-${randomUUID().replace(/-/g, '').slice(0, 12)}`, root = join(home, id);
  mkdirSync(root, { recursive: true });
  const committedAt = Math.floor(Date.now() / 1000) - ageSeconds;
  const env = { ...process.env, GIT_COMMITTER_DATE: `@${committedAt} +0000`, GIT_AUTHOR_DATE: `@${committedAt} +0000` };
  execFileSync('git', ['-C', root, 'init', '-q'], { env });
  writeFileSync(join(root, 'alice-example.md'), '# Alice Example\n');
  execFileSync('git', ['-C', root, 'add', '.'], { env });
  execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes'], { env });
  const sha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const [row] = await engine.executeRaw<{ worktree_id: string; incarnation: string }>(
    'SELECT b.worktree_id::text AS worktree_id, b.source_incarnation::text AS incarnation FROM persistence_source_bindings b WHERE b.source_id=$1', [id]);
  return { id, root, worktreeId: row!.worktree_id, incarnation: row!.incarnation, sha, committedAt };
}
/** A committed sync receipt `afterSeconds` after the fixture's commit; `chunks` embeds a page for it (null = a chunk not embedded yet). */
async function receipt(engine: BrainEngine, f: Fixture, afterSeconds: number, opts: { intent?: Record<string, unknown>; chunks?: Array<number | null> } = {}): Promise<void> {
  const slug = `notes/${randomUUID().slice(0, 8)}`;
  const completed = (f.committedAt + afterSeconds) * 1000;
  let pageId: number | null = null;
  if (opts.chunks) {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const [page] = await engine.executeRaw<{ id: number }>("INSERT INTO pages(source_id,slug,type,title) VALUES($1,$2,'note',$2) RETURNING id", [f.id, slug]);
    pageId = page!.id;
    await engine.executeRaw('UPDATE pages SET text_projection_revision=knowledge_revision WHERE id=$1', [pageId]);
    for (const [i, at] of opts.chunks.entries()) {
      await engine.executeRaw('INSERT INTO content_chunks(page_id,chunk_index,chunk_text,embedded_at) VALUES($1,$2,$3,$4::timestamptz)',
        [pageId, i, `chunk ${i}`, at === null ? null : new Date(completed + at * 1000).toISOString()]);
    }
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  }
  const intent = { kind: 'managed_sync_import', path: `${slug}.md`, target: f.sha, from: FROM, runId: randomUUID(), index: 0, total: 1, ...opts.intent };
  await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,page_id,worktree_id,digest,authority,intent,intent_bytes,terminal_reservation,state,completed_at)
    VALUES('local_cli','cli:example',$1::uuid,'submit_job',$2,$3::uuid,$4,$5,$6::uuid,'d','{}'::jsonb,$7::text::jsonb,1,16384,'committed',$8::timestamptz)`,
  [randomUUID(), f.id, f.incarnation, slug, pageId, f.worktreeId, JSON.stringify(intent), new Date(completed).toISOString()]);
}
const doctor = async (engine: BrainEngine, scope: { sourceIds?: string[]; orphanRatioSourceId?: string } = {}) =>
  (await managedSyncLatencyEntry.run({ engine, ...scope } as unknown as Parameters<typeof managedSyncLatencyEntry.run>[0]) as unknown as Array<Record<string, any>>)[0]!;
async function reset(engine: BrainEngine): Promise<void> {
  await engine.executeRaw('DELETE FROM persistence_requests');
  await engine.executeRaw("DELETE FROM config WHERE key IN ('sync.on_commit','sync.freshness_target_seconds')");
}

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push({ name: 'pglite', engine: lite });
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push({ name: 'postgres', engine: pg.engine }); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    for (const { engine } of engines) {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      if (engine.kind === 'pglite') await engine.disconnect();
    }
  });
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

describe('sync freshness (#6858 ask 6)', () => {
  test('no receipts: no samples; doctor ok; a brain that is not managed is skipped', () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const { engine } of engines) {
      await reset(engine);
      const f = await managedSource(engine, 60);
      const [fresh] = await readSyncFreshness(engine, { sourceIds: [f.id] });
      expect(fresh).toEqual({ source_id: f.id, window_hours: 24, commit_to_searchable: { samples: 0, p50_seconds: null, p95_seconds: null },
        commit_to_embedded: { samples: 0, p50_seconds: null, p95_seconds: null, pending: 0 }, commits: 0, unresolved_commits: 0 });
      expect(formatSyncFreshness(fresh!)).toBe('no commit→searchable samples in the last 24 h');
      await engine.setConfig('sync.on_commit', 'true');
      expect(await doctor(engine)).toMatchObject({ name: 'managed_sync_latency', status: 'ok', message: expect.stringContaining('No commit→searchable samples') });
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      try { expect(await doctor(engine)).toMatchObject({ status: 'ok', message: expect.stringContaining('Not a managed brain') }); }
      finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
    }
  }), 120_000);

  test('receipts give p50/p95 commit→searchable and commit→embedded; first syncs, working-tree entries and deletes are not samples', () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const { name, engine } of engines) {
      await reset(engine);
      const f = await managedSource(engine, 3600);
      await receipt(engine, f, 10, { chunks: [5, 8] });
      await receipt(engine, f, 20, { chunks: [2] });
      await receipt(engine, f, 30, { chunks: [1, null] });
      await receipt(engine, f, 400);
      await receipt(engine, f, 5, { intent: { from: null } });
      await receipt(engine, f, 5, { intent: { working: true } });
      await receipt(engine, f, 5, { intent: { kind: 'managed_sync_delete' } });
      const [fresh] = await readSyncFreshness(engine, { sourceIds: [f.id] });
      // searchable: [10, 20, 30, 400] -> p50 25, p95 30 + 0.85 * 370; embedded: [18, 22] (the page waiting on a chunk is pending).
      expect(fresh, name).toEqual({ source_id: f.id, window_hours: 24, commits: 1, unresolved_commits: 0,
        commit_to_searchable: { samples: 4, p50_seconds: 25, p95_seconds: 344.5 },
        commit_to_embedded: { samples: 2, p50_seconds: 20, p95_seconds: 21.8, pending: 1 } });
      expect(formatSyncFreshness(fresh!)).toBe('commit→searchable p50 25s, p95 5.7m (4 page(s), last 24 h); commit→embedded p50 20s, p95 21.8s (2 page(s), 1 pending)');
    }
  }), 120_000);

  test('a later revision of the page does not rewrite an earlier receipt\'s commit→embedded; an embed before the write is no sample', () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const { name, engine } of engines) {
      await reset(engine);
      const f = await managedSource(engine, 7200);
      const later = 'b'.repeat(40);
      const commitTimes = async () => new Map([[f.sha, f.committedAt], [later, f.committedAt + 3600]]);
      const slug = 'notes/alice-example';
      const at = (s: number) => new Date((f.committedAt + s) * 1000).toISOString();
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      const [page] = await engine.executeRaw<{ id: number }>("INSERT INTO pages(source_id,slug,type,title) VALUES($1,$2,'note',$2) RETURNING id", [f.id, slug]);
      await engine.executeRaw('UPDATE pages SET text_projection_revision=knowledge_revision WHERE id=$1', [page!.id]);
      await engine.executeRaw("INSERT INTO content_chunks(page_id,chunk_index,chunk_text,embedded_at) VALUES($1,0,'first revision',$2::timestamptz)", [page!.id, at(12)]);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const write = async (target: string, completedAfter: number) => engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,page_id,worktree_id,digest,authority,intent,intent_bytes,terminal_reservation,state,completed_at)
        VALUES('local_cli','cli:example',$1::uuid,'submit_job',$2,$3::uuid,$4,$5,$6::uuid,'d','{}'::jsonb,$7::text::jsonb,1,16384,'committed',$8::timestamptz)`,
      [randomUUID(), f.id, f.incarnation, slug, page!.id, f.worktreeId, JSON.stringify({ kind: 'managed_sync_import', path: `${slug}.md`, target, from: FROM, runId: randomUUID(), index: 0, total: 1 }), at(completedAfter)]);
      await write(f.sha, 10);
      const [first] = await readSyncFreshness(engine, { sourceIds: [f.id], commitTimes });
      expect(first!.commit_to_embedded, name).toEqual({ samples: 1, p50_seconds: 12, p95_seconds: 12, pending: 0 });
      // The second revision: committed 3600 s later, written 10 s after it and embedded 12 s after it.
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw("UPDATE content_chunks SET chunk_text='second revision', embedded_at=$1::timestamptz WHERE page_id=$2", [at(3612), page!.id]);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      await write(later, 3610);
      const [both] = await readSyncFreshness(engine, { sourceIds: [f.id], commitTimes });
      expect(both, name).toMatchObject({ commits: 2, commit_to_searchable: { samples: 2, p50_seconds: 10, p95_seconds: 10 },
        commit_to_embedded: { samples: 1, p50_seconds: 12, p95_seconds: 12, pending: 0 } });
      // A third write whose chunks kept the earlier embed time (nothing re-embedded): searchable, but no embedding sample.
      await write(later, 3700);
      const [kept] = await readSyncFreshness(engine, { sourceIds: [f.id], commitTimes });
      expect(kept!.commit_to_searchable.samples, name).toBe(3);
      expect(kept!.commit_to_embedded, name).toEqual({ samples: 0, p50_seconds: null, p95_seconds: null, pending: 0 });
    }
  }), 120_000);

  test('a commit this checkout cannot date is counted unresolved, not sampled', () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const { engine } of engines) {
      await reset(engine);
      const f = await managedSource(engine, 60);
      await receipt(engine, f, 10, { intent: { target: 'e'.repeat(40) } });
      const [fresh] = await readSyncFreshness(engine, { sourceIds: [f.id] });
      expect(fresh).toMatchObject({ commits: 0, unresolved_commits: 1, commit_to_searchable: { samples: 0 } });
    }
  }), 120_000);

  test('doctor warns when grading is on and synced commits cannot be dated; ok only when there was nothing to measure', () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const { name, engine } of engines) {
      await reset(engine);
      const f = await managedSource(engine, 60);
      await receipt(engine, f, 10, { intent: { target: 'e'.repeat(40) } });
      await receipt(engine, f, 12, { intent: { target: 'd'.repeat(40) } });
      const ungraded = await doctor(engine, { sourceIds: [f.id] });
      expect(ungraded, name).toMatchObject({ status: 'ok', details: { graded: false } });
      expect(ungraded.message).toContain('2 synced commit(s) are not in this host');
      await engine.setConfig('sync.on_commit', 'true');
      const warn = await doctor(engine, { sourceIds: [f.id] });
      expect(warn, name).toMatchObject({ status: 'warn', details: { graded: true, sources: [{ source_id: f.id, unresolved_commits: 2 }] } });
      expect(warn.message).toBe(`Commit→searchable latency could not be measured for 2 commit(s) synced in the last 24 h: ${f.id} (2). The commit is not in this host's local git checkout, so its commit time is unknown.`);
      expect(warn.fix.argv).toEqual(['gbrain', 'sync', 'status', '--source', f.id, '--json']);
      await engine.executeRaw('DELETE FROM persistence_requests');
      expect(await doctor(engine, { sourceIds: [f.id] }), name).toMatchObject({ status: 'ok', message: expect.stringContaining('no managed sync imported a new commit') });
    }
  }), 120_000);

  test('doctor --source grades only that source', () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const { name, engine } of engines) {
      await reset(engine);
      const scoped = await managedSource(engine, 3600);
      const other = await managedSource(engine, 3600);
      await receipt(engine, scoped, 20);
      for (const after of [400, 500]) await receipt(engine, other, after);
      await engine.setConfig('sync.on_commit', 'true');
      for (const scope of [{ orphanRatioSourceId: scoped.id }, { sourceIds: [scoped.id] }]) {
        const check = await doctor(engine, scope);
        expect(check, name).toMatchObject({ status: 'ok' });
        expect(check.details.sources.map((s: { source_id: string }) => s.source_id)).toEqual([scoped.id]);
        expect(check.message).not.toContain(other.id);
      }
      const all = await doctor(engine, { sourceIds: [scoped.id, other.id] });
      expect(all, name).toMatchObject({ status: 'warn' });
      expect(all.message).toContain(other.id);
    }
  }), 120_000);

  test('doctor grades only with sync.on_commit on or a target set: warn over the target, fail over 1 h', () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const { engine } of engines) {
      await reset(engine);
      const slow = await managedSource(engine, 3600);
      for (const after of [400, 500, 600]) await receipt(engine, slow, after);
      const off = await doctor(engine);
      expect(off).toMatchObject({ status: 'ok', severity: 'info', details: { graded: false, target_seconds: 300 } });
      expect(off.message).toContain('not graded');
      await engine.setConfig('sync.on_commit', 'true');
      const warn = await doctor(engine);
      expect(warn).toMatchObject({ status: 'warn', details: { graded: true, on_commit: true, target_seconds: 300, fail_seconds: 3600 } });
      expect(warn.message).toContain(slow.id);
      expect(warn.fix.argv).toEqual(['gbrain', 'sync', 'status', '--source', slow.id, '--json']);
      await engine.setConfig('sync.on_commit', 'false');
      await engine.setConfig('sync.freshness_target_seconds', '900');
      expect(await doctor(engine)).toMatchObject({ status: 'ok', details: { graded: true, on_commit: false, target_seconds: 900 } });
      const stale = await managedSource(engine, 3 * 3600);
      await receipt(engine, stale, 2 * 3600);
      const fail = await doctor(engine);
      expect(fail).toMatchObject({ status: 'fail', details: { graded: true, fail_seconds: 3600 } });
      expect(fail.message).toContain(stale.id);
      expect(fail.message).not.toContain(slow.id);
    }
  }), 120_000);

  test('sync status --json gains only the freshness block; the human view prints one freshness line', () => withEnv({ GBRAIN_HOME: home, GBRAIN_SOURCE: undefined }, async () => {
    for (const { engine } of engines) {
      await reset(engine);
      const f = await managedSource(engine, 600);
      await receipt(engine, f, 12);
      const capture = async (args: string[]) => {
        const lines: string[] = [];
        const log = console.log;
        console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
        try { await runSyncStatus(engine, ['--source', f.id, ...args]); } finally { console.log = log; }
        return lines;
      };
      const json = JSON.parse((await capture(['--json'])).join('\n')) as Record<string, unknown>;
      const core = await readSyncStatus(engine, f.id, {});
      const added = Object.keys(json).filter(k => !(k in core)).sort();
      expect(added).toEqual(['capacity', 'freshness', ...(json.notices ? ['notices'] : [])].sort());
      expect(json.freshness).toMatchObject({ source_id: f.id, commit_to_searchable: { samples: 1, p50_seconds: 12, p95_seconds: 12 } });
      const human = await capture([]);
      expect(human.filter(l => l.startsWith('  freshness: '))).toEqual(['  freshness: commit→searchable p50 12s, p95 12s (1 page(s), last 24 h); commit→embedded no samples (0 page(s), 0 pending)']);
    }
  }), 120_000);

  test('gbrain status prints one freshness line per managed source with samples, and none for a source without', () => {
    const sampled = { source_id: 'acme-example', window_hours: 24, commits: 2, unresolved_commits: 0,
      commit_to_searchable: { samples: 3, p50_seconds: 8, p95_seconds: 14 }, commit_to_embedded: { samples: 3, p50_seconds: 15, p95_seconds: 31, pending: 0 } };
    const quiet = { ...sampled, source_id: 'alice-example', commits: 0, commit_to_searchable: { samples: 0, p50_seconds: null, p95_seconds: null },
      commit_to_embedded: { samples: 0, p50_seconds: null, p95_seconds: null, pending: 0 } };
    const report = { schema_version: 1, version: 'test', generated_at: '2026-10-16T00:00:00.000Z', mode: 'local',
      sync: { sources: [{ source_id: 'acme-example', last_sync_at: null, staleness_class: 'fresh', pages: 2, embedding_coverage_pct: 100 }], unacknowledged_failures: 0 },
      freshness: [sampled, quiet] } as unknown as StatusReport;
    const lines = renderHuman(report).split('\n').filter(l => l.includes('freshness'));
    expect(lines).toEqual(['  freshness acme-example: commit→searchable p50 8s, p95 14s (3 page(s), last 24 h); commit→embedded p50 15s, p95 31s (3 page(s), 0 pending)']);
  });
});
