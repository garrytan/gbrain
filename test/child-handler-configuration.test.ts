import { expect, test } from 'bun:test';
import { checkChildReadiness } from '../src/core/minions/child-readiness.ts';
import { runJobInChild } from '../src/core/minions/child-job-runner.ts';
import { LocalConfigurationError } from '../src/core/minions/configuration-error.ts';
import { detectTini } from '../src/core/minions/spawn-helpers.ts';

test('actual isolated handler fault after healthy readiness preserves typed outcome and confirms supported cleanup', async () => {
  const invocation = { cmd: process.execPath, argsPrefix: [new URL('./fixtures/child-configuration-handler.ts', import.meta.url).pathname] };
  const tiniPath = detectTini();
  await checkChildReadiness({ invocation, tiniPath });
  const events: string[] = [];
  const error = await runJobInChild({
    invocation, tiniPath, jobId: 1, jobName: 'sync', lockToken: 'fixture-token',
    abortSignal: new AbortController().signal, shutdownSignal: new AbortController().signal,
    killGraceMs: 50,
    onConfigurationError: error => { events.push(error.reasonCode); },
    onExecutionStopped: () => { events.push('stopped'); },
  }).then(() => null, (error: unknown) => error);
  expect(error).toBeInstanceOf(LocalConfigurationError);
  expect((error as LocalConfigurationError).reasonCode).toBe('postgres_cancellation_unavailable');
  expect(events[0]).toBe('postgres_cancellation_unavailable');
  if (process.platform === 'linux') expect(events).toEqual(['postgres_cancellation_unavailable', 'stopped']);
  else expect(events).toEqual(['postgres_cancellation_unavailable']);
}, 30_000);
