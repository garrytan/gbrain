/**
 * #7190: a per-source applied-through watermark on write receipts, in `gbrain sources status --json` and in a sync
 * result. Red on master (no watermark, no receipt `applied`):
 * - indexed_through moves only when a pass finishes: a sliced pass that stops after one page leaves it where it was;
 * - pending counts the commits and files on HEAD that have not synced yet;
 * - get_write_request answers whether a write is searchable yet, with the gap, while the write's own reply stays frozen;
 * - committed_through_request never passes an unsettled request;
 * - a pending write hint names the applied read.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { formatAppliedWatermark, readAppliedWatermark, readWriteWatermark } from '../src/core/persistence/applied-watermark.ts';
import { readWriteApplied } from '../src/core/persistence/write-applied.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { pendingWriteHint } from '../src/core/persistence/health.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-watermark-7190-'));
let engine: BrainEngine;
const git = (root: string, args: string[], env?: Record<string, string>) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } }).trim();
const commit = (root: string, message: string, at?: number) => {
  const env = at ? { GIT_COMMITTER_DATE: `@${at} +0000`, GIT_AUTHOR_DATE: `@${at} +0000` } : undefined;
  git(root, ['add', '.'], env);
  git(root, ['-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message], env);
  return git(root, ['rev-parse', 'HEAD']);
};
const note = (body: string) => `---\ntitle: Example\n---\n${body}\n`;

async function syncedSource(): Promise<{ id: string; root: string; head: string }> {
  const id = `wm-${randomUUID().replace(/-/g, '').slice(0, 20)}`, root = join(home, id);
  mkdirSync(root); git(root, ['init', '-q']);
  writeFileSync(join(root, 'alice-example.md'), note('Alice one.'));
  const head = commit(root, 'fixture', Math.floor(Date.now() / 1000) - 7200);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  expect((await performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true })).status).toBe('first_sync');
  return { id, root, head };
}

beforeAll(async () => { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite; }, 60_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

test('indexed_through is the last finished pass, and pending counts what HEAD has not synced', () => withEnv({ GBRAIN_HOME: home }, async () => {
  const { id, root, head } = await syncedSource();
  const synced = await readAppliedWatermark(engine, id);
  expect(synced.indexed_through.commit).toBe(head);
  expect(synced.pending).toMatchObject({ count: 0, requests: { count: 0 }, commits_behind: { count: 0 }, files_behind: 0, held_files: 0, deletes_withheld: 0 });
  expect(synced.writer_heartbeat.holder).toBeNull();
  expect(synced.embedded_through.state).not.toBe('complete');
  expect(synced.embedded_through.unembedded_pages + (synced.embedded_through.state === 'embeddings_off' ? 1 : 0)).toBeGreaterThan(0);

  for (const name of ['bob-example', 'carol-example', 'dana-example']) writeFileSync(join(root, `${name}.md`), note(name));
  const next = commit(root, 'three more', Math.floor(Date.now() / 1000) - 600);
  const behind = await readAppliedWatermark(engine, id);
  expect(behind.indexed_through.commit).toBe(head);
  expect(behind.pending.commits_behind!.count).toBe(1);
  expect(behind.pending.files_behind).toBe(3);
  expect(behind.pending.count).toBe(3);
  expect(behind.pending.oldest_age_seconds).toBeGreaterThanOrEqual(600);
  expect(formatAppliedWatermark(behind)).toContain(`${id}: indexed through ${head.slice(0, 12)}`);

  const sliced = await performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true }, { maxPages: 1, maxMs: 60_000 });
  expect(sliced.status).not.toBe('synced');
  expect((await readWriteWatermark(engine, id)).indexed_through.commit).toBe(head);

  expect((await performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true })).status).toBe('synced');
  const done = await readAppliedWatermark(engine, id);
  expect(done.indexed_through.commit).toBe(next);
  expect(done.pending.files_behind).toBe(0);
}), 240_000);

test('get_write_request says whether a put_page is searchable yet; the write reply stays frozen for replays', () => withEnv({ GBRAIN_HOME: home }, async () => {
  const { id } = await syncedSource();
  const ctx = { engine, config: { engine: engine.kind } as never, remote: false, sourceId: id } as never;
  const reply = await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'erin-example', source_id: id, content: note('Erin wrote this.') } });
  expect(reply.applied).toBeUndefined();
  const { operationsByName } = await import('../src/core/operations.ts');
  const read = await operationsByName.get_write_request!.handler(ctx, { request_id: reply.request_id, applied: true }) as { applied?: Awaited<ReturnType<typeof readWriteApplied>> };
  expect((await operationsByName.get_write_request!.handler(ctx, { request_id: reply.request_id }) as { applied?: unknown }).applied).toBeUndefined();
  const applied = read.applied!;
  expect(applied).toBeDefined();
  expect(applied.state).not.toBe('pending_write');
  expect(applied.page!.slug).toBe('erin-example');
  expect(applied.searchable_yet).toBe(applied.searchable === true && !applied.embedding_hold);
  expect(applied.gap.unembedded_chunks).toBe(applied.page!.unembedded);
  expect(applied.watermark.committed_through_request).toBeGreaterThanOrEqual(applied.sequence);

}), 240_000);

test('committed_through_request stops below an unsettled request, which counts the requests queued before it', () => withEnv({ GBRAIN_HOME: home }, async () => {
  const { id } = await syncedSource();
  const [row] = await engine.executeRaw<{ id: string; source_incarnation: string; slug: string; sequence: string }>(
    "SELECT id, source_incarnation::text AS source_incarnation, slug, sequence::text AS sequence FROM persistence_requests WHERE source_id=$1 AND state='committed' ORDER BY sequence DESC LIMIT 1", [id]);
  await engine.executeRaw("UPDATE persistence_requests SET state='queued', completed_at=NULL WHERE id=$1", [row!.id]);
  try {
    const mark = await readWriteWatermark(engine, id);
    expect(mark.committed_through_request).toBe(Number(row!.sequence) - 1);
    expect(mark.requests_pending.count).toBe(1);
    const pending = await readWriteApplied(engine, { source_id: id, source_incarnation: row!.source_incarnation, slug: row!.slug, sequence: row!.sequence, state: 'queued' });
    expect(pending).toMatchObject({ state: 'pending_write', searchable: false, searchable_yet: false, gap: { requests_ahead: 0 } });
  } finally {
    await engine.executeRaw("UPDATE persistence_requests SET state='committed', completed_at=now() WHERE id=$1", [row!.id]);
  }
}), 240_000);

test('a pending write hint names the applied read; an inspect-owner hint does not', () => {
  const request_id = randomUUID();
  const poll = pendingWriteHint({ request_id, state: 'queued', retry_after_ms: 800, target: { slug: 'people/alice-example' } } as any, 'remember');
  expect(poll).toContain('applied: true');
  expect(poll).toContain(`gbrain write-request ${request_id} --applied --json`);
  expect(poll).toContain('page people/alice-example');
  const inspect = pendingWriteHint({ request_id, state: 'queued', retry_after_ms: 30_000, diagnostic: { next_action: 'inspect_owner' } } as any);
  expect(inspect).not.toContain('--applied');
});
