#!/usr/bin/env bun
import { loadAppConfig } from './config.ts';
import { runDoctor } from './doctor.ts';
import { createWorker } from './gbrain.ts';
import { pmWorkItemHandler } from './handlers/pmWorkItem.ts';
import { log } from './log.ts';

async function main(): Promise<void> {
  const config = loadAppConfig();

  const doctor = await runDoctor(config);
  if (!doctor.ok) {
    log('error', 'Doctor failed; refusing to start worker.', { checks: doctor.checks });
    process.exit(1);
  }

  const { engine, worker } = await createWorker(config);

  worker.register('hq.pm.work_item.v1', pmWorkItemHandler as never);

  log('info', 'Starting worker.', {
    queue: config.queue,
    concurrency: config.concurrency,
    handlers: ['hq.pm.work_item.v1']
  });

  const shutdown = async (signal: string) => {
    log('info', 'Shutdown requested.', { signal });
    worker.stop?.();
    setTimeout(async () => {
      await engine.disconnect().catch(() => undefined);
      process.exit(0);
    }, 1000);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await worker.start();
  } finally {
    await engine.disconnect().catch(() => undefined);
  }
}

main().catch((error) => {
  log('error', 'Worker failed.', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  });
  process.exit(1);
});
