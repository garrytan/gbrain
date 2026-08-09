/**
 * Local CI must use the same Bun runtime and bounded intra-shard concurrency
 * as the hosted test gate. A floating runner image plus four uncapped Bun
 * processes can turn one local run into dozens of concurrent PGLite tests,
 * exposing process-global gateway races and exhausting the Docker VM.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const CI_LOCAL = readFileSync(resolve(REPO_ROOT, 'scripts/ci-local.sh'), 'utf8');
const COMPOSE = readFileSync(resolve(REPO_ROOT, 'docker-compose.ci.yml'), 'utf8');
const HOSTED_WORKFLOW = readFileSync(resolve(REPO_ROOT, '.github/workflows/test.yml'), 'utf8');
const HOSTED_SHARD = readFileSync(resolve(REPO_ROOT, 'scripts/test-shard.sh'), 'utf8');

describe('ci:local runtime parity', () => {
  test('runner image matches the Bun version pinned by hosted CI', () => {
    const hostedVersions = [...HOSTED_WORKFLOW.matchAll(/bun-version:\s*([^\s]+)/g)]
      .map(match => match[1]);
    expect(hostedVersions.length).toBeGreaterThan(0);
    expect(new Set(hostedVersions).size).toBe(1);

    const runnerImage = COMPOSE.match(/runner:\s*\n\s*image:\s*oven\/bun:([^\s]+)/)?.[1];
    expect(runnerImage).toBe(hostedVersions[0]);
  });

  test('every local unit-shard invocation isolates files and intra-file tests', () => {
    const invocations = CI_LOCAL.split('\n')
      .filter(line => line.includes('bash scripts/run-unit-shard.sh'));

    expect(invocations.length).toBe(3);
    for (const invocation of invocations) {
      expect(invocation).toContain('-u GBRAIN_PGLITE_SNAPSHOT');
      expect(invocation).toContain('--max-concurrency=1');
      expect(invocation).toContain('--isolate-files');
    }
    expect(CI_LOCAL).not.toContain('export GBRAIN_PGLITE_SNAPSHOT=');
    expect(CI_LOCAL).not.toContain('bun run build:pglite-snapshot');
  });

  test('hosted unit shards use the same per-file process isolation', () => {
    expect(HOSTED_SHARD).toContain('while IFS= read -r file');
    expect(HOSTED_SHARD).toContain('bun test --max-concurrency=1 --timeout=60000 "$file"');
    expect(HOSTED_SHARD).not.toContain('xargs bun test');
  });

  test('local CI runs at most two memory-heavy shard processes at once', () => {
    expect(CI_LOCAL).toContain("printf '%s\\\\n' 1 2 3 4 | xargs -P2");
    expect(CI_LOCAL).not.toContain("printf '%s\\\\n' 1 2 3 4 | xargs -P4");
  });
});
