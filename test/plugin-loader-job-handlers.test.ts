import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import {
  loadSinglePlugin,
  registerPluginJobHandlersFromEnv,
} from '../src/core/minions/plugin-loader.ts';

const tempDirs: string[] = [];

function tempPluginDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-plugin-job-handlers-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

async function waitTerminal(queue: MinionQueue, id: number, timeoutMs = 10000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await queue.getJob(id);
    if (job && ['completed', 'failed', 'dead', 'cancelled'].includes(job.status)) {
      return job.status;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const job = await queue.getJob(id);
  throw new Error(`job ${id} did not reach terminal state; last status=${job?.status}`);
}

describe('GBRAIN_PLUGIN_PATH job handler loading', () => {
  test('rejects job_handlers paths that escape the plugin root', () => {
    const root = tempPluginDir();
    writeFileSync(join(root, 'gbrain.plugin.json'), JSON.stringify({
      name: 'bad-job-plugin',
      version: '1.0.0',
      plugin_version: 'gbrain-plugin-v1',
      job_handlers: '../outside',
    }));

    const loaded = loadSinglePlugin(root);
    expect('error' in loaded).toBe(true);
    if ('error' in loaded) {
      expect(loaded.error).toContain('job_handlers path escapes plugin root');
    }
  });

  test('registers a local job handler module and executes it through MinionWorker', async () => {
    const root = tempPluginDir();
    const handlersDir = join(root, 'job-handlers');
    mkdirSync(handlersDir);
    writeFileSync(join(root, 'gbrain.plugin.json'), JSON.stringify({
      name: 'aios-test-plugin',
      version: '1.0.0',
      plugin_version: 'gbrain-plugin-v1',
      job_handlers: 'job-handlers',
    }));
    writeFileSync(join(handlersDir, 'aios-task.mjs'), `
      export function registerJobHandlers(worker) {
        worker.register('aios-task-test', async (job) => {
          await job.updateProgress({ phase: 'smoke', task_id: job.data.task_id });
          return { ok: true, task_id: job.data.task_id };
        });
      }
    `);

    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    try {
      const worker = new MinionWorker(engine, { pollInterval: 50, lockDuration: 30000 });
      const result = await registerPluginJobHandlersFromEnv(worker, engine, { envPath: root });
      expect(result.warnings).toEqual([]);
      expect(worker.registeredNames).toContain('aios-task-test');

      const queue = new MinionQueue(engine);
      const job = await queue.add('aios-task-test', { task_id: 'task-smoke' }, { queue: 'default' });
      const runPromise = worker.start();
      try {
        const status = await waitTerminal(queue, job.id);
        expect(status).toBe('completed');
        const final = await queue.getJob(job.id);
        expect(final?.result).toEqual({ ok: true, task_id: 'task-smoke' });
        expect(final?.progress).toEqual({ phase: 'smoke', task_id: 'task-smoke' });
      } finally {
        worker.stop();
        await runPromise;
      }
    } finally {
      await engine.disconnect();
    }
  }, 20000);
});
