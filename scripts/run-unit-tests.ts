import { spawn } from 'child_process';
import { availableParallelism } from 'os';
import type { TestShardSpec } from './ci-test-shard.ts';

type EnvLike = Record<string, string | undefined>;

function parsePositiveInteger(name: string, value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function resolveWorkerCount(env: EnvLike = process.env, available = availableParallelism()): number {
  if (env.TEST_WORKERS) {
    return parsePositiveInteger('TEST_WORKERS', env.TEST_WORKERS);
  }

  return Math.max(1, Math.min(4, available));
}

export function buildShardSpecs(total: number): TestShardSpec[] {
  if (!Number.isSafeInteger(total) || total < 1) {
    throw new Error('total must be a positive integer');
  }

  return Array.from({ length: total }, (_, index) => ({
    shard: index + 1,
    total,
  }));
}

function runShard(spec: TestShardSpec): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['run', 'scripts/ci-test-shard.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEST_SHARD_INDEX: String(spec.shard),
        TEST_SHARD_TOTAL: String(spec.total),
        MBRAIN_TEST_SILENCE_MIGRATIONS: process.env.MBRAIN_TEST_SILENCE_MIGRATIONS ?? '1',
      },
      stdio: 'inherit',
    });

    child.on('close', code => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

async function runCli(): Promise<never> {
  const workers = resolveWorkerCount();
  console.log(`Running unit tests in ${workers} parallel shard${workers === 1 ? '' : 's'}`);

  const results = await Promise.all(buildShardSpecs(workers).map(runShard));
  const failed = results.filter(code => code !== 0).length;
  process.exit(failed > 0 ? 1 : 0);
}

if (import.meta.main) {
  await runCli();
}
