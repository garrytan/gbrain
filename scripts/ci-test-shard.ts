import { spawnSync } from 'child_process';
import { readdirSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

export interface TestShardSpec {
  shard: number;
  total: number;
}

type EnvLike = Record<string, string | undefined>;
type TestFileWeightOptions = {
  weightForFile?: (file: string) => number;
};

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

function normalizeWeight(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }
  return Math.max(1, Math.ceil(value));
}

export function estimateTestFileWeight(file: string, root = process.cwd()): number {
  let weight = 1;

  try {
    const bytes = statSync(join(root, file)).size;
    weight += Math.ceil(bytes / 4096);
  } catch {
    return weight;
  }

  if (file.includes('/e2e/') || file.includes('/scenarios/')) weight += 4;
  if (file.includes('pglite') || file.includes('postgres') || file.includes('engine')) weight += 3;
  if (file.includes('import') || file.includes('sync') || file.includes('phase8')) weight += 2;
  if (file.includes('auto-promote')) weight += 2;

  return weight;
}

export function partitionTestFiles(
  files: string[],
  total: number,
  options: TestFileWeightOptions = {},
): string[][] {
  if (!Number.isSafeInteger(total) || total < 1) {
    throw new Error('total must be a positive integer');
  }

  const weightForFile = options.weightForFile ?? (() => 1);
  const shards = Array.from({ length: total }, (_, index) => ({
    index,
    files: [] as string[],
    weight: 0,
  }));
  const candidates = [...new Set(files.map(normalizeTestPath))]
    .map(file => ({ file, weight: normalizeWeight(weightForFile(file)) }))
    .sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file));

  for (const candidate of candidates) {
    shards.sort((a, b) => a.weight - b.weight || a.files.length - b.files.length || a.index - b.index);
    shards[0]!.files.push(candidate.file);
    shards[0]!.weight += candidate.weight;
  }

  return shards
    .sort((a, b) => a.index - b.index)
    .map(shard => shard.files.sort());
}

export function selectShardFiles(
  files: string[],
  spec: TestShardSpec,
  options: TestFileWeightOptions = {},
): string[] {
  if (!Number.isSafeInteger(spec.total) || spec.total < 1) {
    throw new Error('TEST_SHARD_TOTAL must be a positive integer');
  }
  if (!Number.isSafeInteger(spec.shard) || spec.shard < 1 || spec.shard > spec.total) {
    throw new Error('TEST_SHARD_INDEX must be between 1 and TEST_SHARD_TOTAL');
  }

  return partitionTestFiles(files, spec.total, options)[spec.shard - 1]!;
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
  const files = selectShardFiles(discoverTestFiles(), spec, {
    weightForFile: file => estimateTestFileWeight(file),
  });
  const timeoutMs = process.env.TEST_TIMEOUT_MS ?? '20000';
  const listOnly = process.argv.includes('--list') || process.argv.includes('--dry-run');

  console.log(`Running test shard ${spec.shard}/${spec.total}: ${files.length} files`);
  if (listOnly) {
    console.log(files.join('\n'));
    process.exit(0);
  }
  if (files.length === 0) {
    process.exit(0);
  }

  const args = ['test', '--timeout', timeoutMs];
  if (process.env.TEST_MAX_CONCURRENCY) {
    args.push('--max-concurrency', process.env.TEST_MAX_CONCURRENCY);
  }
  args.push(...files);

  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MBRAIN_TEST_SILENCE_MIGRATIONS: process.env.MBRAIN_TEST_SILENCE_MIGRATIONS ?? '1',
    },
    stdio: 'inherit',
  });

  process.exit(result.status ?? 1);
}

if (import.meta.main) {
  runCli();
}
