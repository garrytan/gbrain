import { Glob } from 'bun';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadWeights, partition } from './sharding.ts';

export function verifyNightlyE2E(artifacts: string, expected: string[][], sha: string): void {
  if (!sha || !expected.length || expected.some(files => !files.length)) throw new Error('missing expected E2E corpus or commit');
  const corpus = expected.flat();
  if (new Set(corpus).size !== corpus.length) throw new Error('expected E2E partitions overlap');
  const manifests = [...new Glob('*/lane-manifest.json').scanSync({ cwd: artifacts })]
    .map(path => ({ path, data: JSON.parse(readFileSync(join(artifacts, path), 'utf8')) }))
    .filter(({ data }) => typeof data.lane === 'string' && /^e2e(?:-|$)/.test(data.lane));
  const lanes = expected.map((_, index) => `e2e-${index + 1}`);
  if (manifests.length !== lanes.length || manifests.some(({ data }) => !lanes.includes(data.lane))) {
    throw new Error(`expected exactly ${lanes.join(',')} execution manifests`);
  }
  for (const [index, lane] of lanes.entries()) {
    const matches = manifests.filter(({ data }) => data.lane === lane);
    if (matches.length !== 1) throw new Error(`${lane}: missing or duplicate execution manifest`);
    const { data, path } = matches[0];
    if (data.sha !== sha || data.complete !== true) throw new Error(`${lane}: incomplete or wrong-commit execution`);
    const files = readFileSync(join(artifacts, dirname(path), 'executed-files.txt'), 'utf8').trimEnd().split('\n');
    if (JSON.stringify(files.sort()) !== JSON.stringify([...expected[index]].sort())) {
      throw new Error(`${lane}: executed files differ from the full-corpus partition`);
    }
  }
}

if (import.meta.main) {
  try {
    const [artifacts, count, sha] = process.argv.slice(2);
    const shards = Number(count);
    if (!artifacts || !sha || !Number.isInteger(shards) || shards < 1) throw new Error('usage: bun scripts/verify-nightly-e2e.ts <artifacts> <shards> <sha>');
    const discovered = spawnSync('bash', ['scripts/run-e2e.sh', '--dry-run-list'], {
      encoding: 'utf8', env: { ...process.env, SHARD: '', COVERAGE_DIR: '' },
    });
    if (discovered.status !== 0) throw new Error(`full E2E discovery failed: ${discovered.stderr}`);
    const files = discovered.stdout.trim().split('\n').filter(Boolean);
    verifyNightlyE2E(artifacts, partition(files, loadWeights('scripts/e2e-weights.json'), shards), sha);
    console.log(`nightly E2E: all ${files.length} files accounted for across ${shards} isolated workers`);
  } catch (error) {
    console.error(`nightly E2E: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
