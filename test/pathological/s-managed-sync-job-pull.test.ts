/**
 * Latency finding 6.8 (GBRA-133): a `sync` job submitted without pull options
 * (`gbrain jobs submit sync --params '{"sourceId":"default"}'`, an MCP
 * submit_job) defaulted to pulling. On a managed brain the managed sync refuses
 * a pull, so the job failed permanently ("Managed sync requires skipping the
 * Git pull") on every submission, while the CLI implies --no-pull there
 * (implyManagedNoPull).
 *
 * Protects: the sync handler applies the CLI's managed default before
 * performSync, so a job that does not say whether to pull imports the
 * checkout's HEAD and completes; a job that explicitly asks to pull is still
 * refused. Real worker. PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';
import { makeSyncHandler } from '../../src/core/minions/handlers/sync.ts';
import { expectUnitNotAborted, managedBrain, pathologicalArms } from './harness.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

function commitFixture(root: string): void {
  git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
  mkdirSync(join(root, 'notes'), { recursive: true });
  writeFileSync(join(root, 'notes', 'job-example.md'), '---\ntype: note\ntitle: Job example\n---\n# Job example\n\nBody.\n');
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'fixture');
}

async function runJob(engine: BrainEngine, data: Record<string, unknown>) {
  const queue = new MinionQueue(engine);
  const job = await queue.add('sync', data, { max_attempts: 1 });
  const worker = new MinionWorker(engine, { pollInterval: 25, concurrency: 1 });
  worker.register('sync', makeSyncHandler(engine));
  const running = worker.start();
  try {
    for (let i = 0; i < 2_400; i++) {
      const status = (await queue.getJob(job.id))?.status;
      if (status === 'completed' || status === 'failed' || status === 'dead') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  } finally { worker.stop(); await running; }
  return (await queue.getJob(job.id))!;
}

const live = async (engine: BrainEngine) => (await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id='default' AND deleted_at IS NULL ORDER BY slug")).map(row => row.slug);

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`managed sync job without pull options (${backend})`, () => {
    test('managed job: a sync job that does not say whether to pull imports HEAD and completes', async () => {
      await managedBrain(async ({ engine }) => {
        const job = await expectUnitNotAborted(() => runJob(engine, { sourceId: 'default' }));
        expect({ status: job.status, error: job.error_text ?? null }).toEqual({ status: 'completed', error: null });
        expect(await live(engine)).toContain('notes/job-example');
      }, { databaseUrl, setup: ({ root }) => commitFixture(root) });
    }, 180_000);

    test('managed job: a sync job that explicitly asks to pull is still refused', async () => {
      await managedBrain(async ({ engine }) => {
        const job = await runJob(engine, { sourceId: 'default', pull: true });
        expect(job.status).not.toBe('completed');
        expect(job.error_text ?? '').toMatch(/skipping the Git pull/);
        expect(await live(engine)).not.toContain('notes/job-example');
      }, { databaseUrl, setup: ({ root }) => commitFixture(root) });
    }, 180_000);
  });
}
