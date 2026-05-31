import { spawnSync } from 'child_process';
import { readdirSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

export interface TestShardSpec {
  shard: number;
  total: number;
}

type EnvLike = Record<string, string | undefined>;

function normalizeTestPath(path: string): string {
  return path.split(sep).join('/');
}

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

export function parseShardEnv(env: EnvLike = process.env): TestShardSpec {
  const shard = parsePositiveInteger('TEST_SHARD_INDEX', env.TEST_SHARD_INDEX);
  const total = parsePositiveInteger('TEST_SHARD_TOTAL', env.TEST_SHARD_TOTAL);
  if (shard > total) {
    throw new Error('TEST_SHARD_INDEX must be less than or equal to TEST_SHARD_TOTAL');
  }
  return { shard, total };
}

export function stableShardIndex(file: string, total: number): number {
  if (!Number.isSafeInteger(total) || total < 1) {
    throw new Error('total must be a positive integer');
  }

  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(normalizeTestPath(file))) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % total;
}

export function selectShardFiles(files: string[], spec: TestShardSpec): string[] {
  if (!Number.isSafeInteger(spec.total) || spec.total < 1) {
    throw new Error('TEST_SHARD_TOTAL must be a positive integer');
  }
  if (!Number.isSafeInteger(spec.shard) || spec.shard < 1 || spec.shard > spec.total) {
    throw new Error('TEST_SHARD_INDEX must be between 1 and TEST_SHARD_TOTAL');
  }

  return [...files]
    .map(normalizeTestPath)
    .sort()
    .filter(file => stableShardIndex(file, spec.total) === spec.shard - 1);
}

export function discoverTestFiles(root = process.cwd()): string[] {
  const testRoot = join(root, 'test');
  const discovered: string[] = [];

  function visit(dir: string): void {
    for (const entry of readdirSync(dir).sort()) {
      const absolute = join(dir, entry);
      const stats = statSync(absolute);
      if (stats.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (stats.isFile() && entry.endsWith('.test.ts')) {
        discovered.push(normalizeTestPath(relative(root, absolute)));
      }
    }
  }

  visit(testRoot);
  return discovered.sort();
}

function runCli(): never {
  const spec = parseShardEnv();
  const files = selectShardFiles(discoverTestFiles(), spec);
  const timeoutMs = process.env.TEST_TIMEOUT_MS ?? '20000';

  console.log(`Running test shard ${spec.shard}/${spec.total}: ${files.length} files`);
  if (files.length === 0) {
    process.exit(0);
  }

  const result = spawnSync(process.execPath, ['test', '--timeout', timeoutMs, ...files], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });

  process.exit(result.status ?? 1);
}

if (import.meta.main) {
  runCli();
}
