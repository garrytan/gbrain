/**
 * Latency finding 6.9 (GBRA-133): on a brain that is keyless by choice
 * (`init --no-embedding`), every sync job auto-submitted an embed-backfill.
 * The backfill drained every stale chunk against a gateway with no embedding
 * model, logged "This brain has no explicit embedding model" per page (30k
 * lines at 10k pages), failed its honesty gate and retried, holding the
 * concurrency-1 worker for ~90 s while the next sync jobs waited behind it.
 *
 * Protects: on a keyless brain a sync job queues no embed-backfill (its result
 * says embed_skip_reason embedding_disabled); a backfill already queued (an
 * older build, or an explicit submit) ends once on its first attempt with
 * outcome embed_backfill_skipped and reason embedding_disabled, without
 * touching a page; the embed_backfill_skipped notice (keyless is a valid
 * choice, and the step that turns embedding on) is reported once per brain
 * state, not on every sync. Real worker, 1,000 pages. PGLite always, Postgres
 * when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { buildGatewayConfig } from '../../src/core/ai/build-gateway-config.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';
import { makeSyncHandler } from '../../src/core/minions/handlers/sync.ts';
import { makeEmbedBackfillHandler } from '../../src/core/minions/handlers/embed-backfill.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { expectUnitNotAborted, pathologicalArms } from './harness.ts';

const PAGES = 1000;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

function writeNotes(root: string, from: number, to: number): void {
  for (let i = from; i < to; i++) writeFileSync(join(root, 'notes', `n-${i}.md`), `---\ntype: note\ntitle: Note ${i}\n---\n# Note ${i}\n\nBody of example note ${i}.\n`);
  git(root, 'add', '-A'); git(root, 'commit', '-qm', `notes ${from}-${to}`);
}

/** Runs the queue on a real worker until every listed job is terminal. */
async function runJobs(engine: BrainEngine, ids: number[]): Promise<void> {
  const queue = new MinionQueue(engine);
  const worker = new MinionWorker(engine, { pollInterval: 25, concurrency: 1 });
  worker.register('sync', makeSyncHandler(engine));
  worker.register('embed-backfill', makeEmbedBackfillHandler(engine));
  const running = worker.start();
  try {
    for (let i = 0; i < 4_800; i++) {
      const statuses = await Promise.all(ids.map(async id => (await queue.getJob(id))?.status));
      if (statuses.every(status => status === 'completed' || status === 'failed' || status === 'dead')) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  } finally { worker.stop(); await running; }
}

/** Every line written to stderr and console while `run` runs. */
async function captureOutput<T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  const original = { error: console.error, warn: console.warn, log: console.log };
  const record = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  process.stderr.write = ((chunk: unknown) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  Object.assign(console, { error: record, warn: record, log: record });
  try { return { value: await run(), lines }; } finally { process.stderr.write = write; Object.assign(console, original); }
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`keyless embed-backfill (${backend})`, () => {
    test('keyless item: a 1k-page sync job queues no embed-backfill, a queued one ends once skipped, and the notice is reported once', async () => {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-keyless-backfill-'));
      const root = join(home, 'repo');
      try {
        await withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
          const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
          try {
            // A keyless brain as `gbrain init --no-embedding` leaves it, and the worker's gateway as the CLI builds it.
            await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
            await engine.setConfig('embedding_disabled', 'true');
            configureGateway(buildGatewayConfig({ engine: engine.kind, embedding_disabled: true } as never));
            mkdirSync(join(root, 'notes'), { recursive: true });
            git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
            writeNotes(root, 0, PAGES);
            const sourceId = 'keyless-example';
            await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
            const queue = new MinionQueue(engine);
            // A sync job submitted without options, then a backfill queued for the stale chunks it left (an older build's
            // auto-submit or an explicit submit; on PGLite the inline-worker submit `jobs submit --follow` uses).
            const sync = await queue.add('sync', { sourceId, noPull: true, concurrency: 1 });
            const first = await captureOutput(async () => {
              await expectUnitNotAborted(() => runJobs(engine, [sync.id]));
              const queued = await queue.add('embed-backfill', { sourceId, batchSize: 500, reason: 'sync_handler' }, {}, { allowPgliteInlineWorker: true });
              await expectUnitNotAborted(() => runJobs(engine, [queued.id]));
              return queued;
            });
            const queued = first.value;
            const backfill = (await queue.getJob(queued.id))!;
            expect({ status: backfill.status, started: backfill.attempts_started, failed: backfill.attempts_made }).toEqual({ status: 'completed', started: 1, failed: 0 });
            expect(backfill.result).toMatchObject({ status: 'skipped', outcome: 'embed_backfill_skipped', reason: 'embedding_disabled', sourceId,
              embedded: 0, chunksProcessed: 0, pagesProcessed: 0 });
            expect(first.lines.filter(line => /no explicit embedding model/i.test(line))).toEqual([]);
            const syncJob = (await queue.getJob(sync.id))!;
            expect(syncJob.status).toBe('completed');
            expect(syncJob.result).toMatchObject({ embed_job_id: null, embed_skip_reason: 'embedding_disabled' });
            const [pages] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND deleted_at IS NULL', [sourceId]);
            expect(pages!.n).toBe(PAGES);
            const backfills = await engine.executeRaw<{ id: number }>("SELECT id FROM minion_jobs WHERE name='embed-backfill'");
            expect(backfills.map(row => Number(row.id))).toEqual([queued.id]);
            const notices = (lines: string[]) => lines.filter(line => line.includes('embed_backfill_skipped'));
            expect(notices(first.lines)).toHaveLength(1);
            const notice = [backfill.result, syncJob.result].map(result => (result as { notice?: Record<string, any> }).notice).find(Boolean)!;
            expect(notice).toMatchObject({ code: 'embed_backfill_skipped', kind: 'info', why: expect.stringMatching(/keyless/i),
              fix: { next: expect.any(String), why: expect.stringMatching(/valid choice/i) } });

            // The next sync on the same keyless brain reports nothing new.
            writeNotes(root, PAGES, PAGES + 5);
            const again = await queue.add('sync', { sourceId, noPull: true, concurrency: 1 });
            const second = await captureOutput(() => runJobs(engine, [again.id]));
            expect((await queue.getJob(again.id))!.result).toMatchObject({ embed_job_id: null, embed_skip_reason: 'embedding_disabled' });
            expect((await queue.getJob(again.id))!.result).not.toHaveProperty('notice');
            expect(notices(second.lines)).toEqual([]);
            expect((await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='embed-backfill'")).length).toBe(1);
          } finally { resetGateway(); await close(); }
        });
      } finally { rmSync(home, { recursive: true, force: true }); }
    }, 600_000);
  });
}
