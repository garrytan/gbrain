import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv } from './helpers/with-env.ts';
import { reportInlineWorkerConfiguration, reportWorkerReady, reportWorkerStarting } from '../src/commands/jobs-readiness.ts';
import { LocalConfigurationError } from '../src/core/minions/configuration-error.ts';

describe('selected child readiness CLI', () => {
  test('a supervised worker without any status channel proceeds (legacy owner)', async () => {
    await withEnv({ GBRAIN_SUPERVISED: '1', GBRAIN_WORKER_STATUS_PATH: undefined, GBRAIN_WORKER_STATUS_TOKEN: undefined }, () => {
      expect(() => reportWorkerReady()).not.toThrow();
    });
    await withEnv({ GBRAIN_SUPERVISED: undefined, GBRAIN_WORKER_STATUS_PATH: undefined, GBRAIN_WORKER_STATUS_TOKEN: undefined }, () => {
      expect(() => reportWorkerReady()).not.toThrow();
    });
  });

  test('a legacy-shaped supervised worker passes every readiness publication stage', async () => {
    await withEnv({ GBRAIN_SUPERVISED: '1', GBRAIN_WORKER_STATUS_PATH: undefined, GBRAIN_WORKER_STATUS_TOKEN: undefined }, () => {
      expect(() => reportWorkerStarting('database_readiness')).not.toThrow();
      expect(() => reportWorkerStarting('child_readiness')).not.toThrow();
      expect(() => reportWorkerReady()).not.toThrow();
    });
  });

  test('a partial status channel fails closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'worker-status-partial-'));
    try {
      await withEnv({ GBRAIN_SUPERVISED: undefined, GBRAIN_WORKER_STATUS_PATH: join(dir, 'worker.json'), GBRAIN_WORKER_STATUS_TOKEN: undefined }, () => {
        expect(() => reportWorkerReady()).toThrow('no jobs were admitted');
      });
      await withEnv({ GBRAIN_SUPERVISED: undefined, GBRAIN_WORKER_STATUS_PATH: undefined, GBRAIN_WORKER_STATUS_TOKEN: 'token' }, () => {
        expect(() => reportWorkerReady()).toThrow('no jobs were admitted');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a full status channel whose publication fails refuses to start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'worker-status-full-'));
    try {
      await withEnv({ GBRAIN_SUPERVISED: '1', GBRAIN_WORKER_STATUS_PATH: join(dir, 'worker.json'), GBRAIN_WORKER_STATUS_TOKEN: 'token' }, () => {
        expect(() => reportWorkerStarting('database_readiness')).toThrow('no jobs were admitted');
        expect(() => reportWorkerReady()).toThrow('no jobs were admitted');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('inline worker configuration faults name the reason and the runbook', () => {
    const lines: string[] = [];
    const error = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
    try {
      reportInlineWorkerConfiguration(new LocalConfigurationError('postgres_cancellation_unavailable', 'fixture'));
    } finally {
      error.mockRestore();
    }
    expect(lines.join('\n')).toContain('postgres_cancellation_unavailable');
    expect(lines.join('\n')).toContain('docs/guides/minions-fix.md');
    expect(lines.join('\n')).not.toContain('restart its owner');
  });

  test('database connection failure produces a transient protocol reply', async () => {
    const home = mkdtempSync(join(tmpdir(), 'child-readiness-offline-'));
    try {
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({
        engine: 'postgres',
        database_url: 'postgresql://127.0.0.1:1/gbrain_test',
      }));
      const result = await runCli(['jobs', 'child-readiness', '--json'], { home, timeoutMs: 10_000 });
      expect(result.exitCode).toBe(1);
      const reply = JSON.parse(result.stdout);
      expect(reply.protocolVersion).toBe(1);
      expect(reply.status).toBe('transient_error');
      expect(reply.reasonCode).toBeUndefined();
      expect(reply.features).toContain('local-configuration-outcome-v1');
      expect(result.stdout).not.toContain('postgresql://');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
