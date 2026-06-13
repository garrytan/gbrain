import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const repoRoot = new URL('..', import.meta.url).pathname;
const workflowsDir = join(repoRoot, '.github', 'workflows');
const workflowFiles = readdirSync(workflowsDir)
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .sort();

function getWorkflowJob(source: string, jobName: string): string {
  const marker = `\n  ${jobName}:\n`;
  const start = source.indexOf(marker);
  if (start === -1) return '';
  const rest = source.slice(start + marker.length);
  const nextJob = rest.search(/\n  [a-zA-Z0-9_-]+:\n/);
  return nextJob === -1 ? rest : rest.slice(0, nextJob);
}

function getWorkflowUseLines(action: string): string[] {
  return workflowFiles.flatMap((workflow) => {
    const source = readFileSync(join(workflowsDir, workflow), 'utf-8');
    return source
      .split('\n')
      .filter((line) => line.includes(`${action}@`))
      .map((line) => `${workflow}: ${line.trim()}`);
  });
}

for (const workflow of workflowFiles) {
  test(`${workflow} pins the Bun toolchain`, () => {
    const source = readFileSync(join(workflowsDir, workflow), 'utf-8');

    expect(source).not.toContain('bun-version: latest');
    expect(source).toContain('bun-version: 1.3.12');
  });
}

test('release workflow typechecks before publishing binaries', () => {
  const source = readFileSync(join(workflowsDir, 'release.yml'), 'utf-8');

  expect(source).toContain('name: Typecheck');
  expect(source).toContain('bunx tsc --noEmit --pretty false');
});

test('release workflow smoke-tests compiled binaries before upload', () => {
  const source = readFileSync(join(workflowsDir, 'release.yml'), 'utf-8');
  const buildJob = getWorkflowJob(source, 'build');

  expect(buildJob).toContain('name: Repair macOS compiled signature');
  expect(buildJob).toContain("if: matrix.os == 'macos-latest'");
  expect(buildJob).toContain('codesign --remove-signature bin/${{ matrix.artifact }} || true');
  expect(buildJob).toContain('codesign --sign - --force bin/${{ matrix.artifact }}');
  expect(buildJob).toContain('name: Smoke compiled binary');
  expect(buildJob).toContain('bin/${{ matrix.artifact }} --version');
  expect(buildJob.indexOf('name: Repair macOS compiled signature')).toBeLessThan(
    buildJob.indexOf('name: Smoke compiled binary'),
  );
  expect(buildJob.indexOf('name: Smoke compiled binary')).toBeLessThan(
    buildJob.indexOf('actions/upload-artifact@'),
  );
});

test('workflows avoid GitHub actions pinned to deprecated Node 20 majors', () => {
  const checkoutUses = getWorkflowUseLines('actions/checkout');
  const downloadArtifactUses = getWorkflowUseLines('actions/download-artifact');
  const gitleaksUses = getWorkflowUseLines('gitleaks/gitleaks-action');
  const releaseUses = getWorkflowUseLines('softprops/action-gh-release');
  const uploadArtifactUses = getWorkflowUseLines('actions/upload-artifact');

  expect(checkoutUses.length).toBeGreaterThan(0);
  expect(downloadArtifactUses.length).toBeGreaterThan(0);
  expect(gitleaksUses.length).toBeGreaterThan(0);
  expect(releaseUses.length).toBeGreaterThan(0);
  expect(uploadArtifactUses.length).toBeGreaterThan(0);
  expect(checkoutUses.filter((line) => !/actions\/checkout@[0-9a-f]{40}\s+#\s+v5\b/.test(line))).toEqual([]);
  expect(
    downloadArtifactUses.filter((line) => !/actions\/download-artifact@[0-9a-f]{40}\s+#\s+v8\b/.test(line)),
  ).toEqual([]);
  expect(gitleaksUses.filter((line) => !/gitleaks\/gitleaks-action@[0-9a-f]{40}\s+#\s+v3\b/.test(line))).toEqual([]);
  expect(releaseUses.filter((line) => !/softprops\/action-gh-release@[0-9a-f]{40}\s+#\s+v3\b/.test(line))).toEqual(
    [],
  );
  expect(uploadArtifactUses.filter((line) => !/actions\/upload-artifact@[0-9a-f]{40}\s+#\s+v7\b/.test(line))).toEqual(
    [],
  );
});

test('test workflow keeps full git history for history-backed scenario guards', () => {
  const source = readFileSync(join(workflowsDir, 'test.yml'), 'utf-8');
  const shardJob = getWorkflowJob(source, 'test-shard');

  expect(shardJob).toContain('fetch-depth: 0');
  expect(shardJob).toContain('bun run test:ci-shard');
});

test('test workflow checks generated schemas before typecheck', () => {
  const source = readFileSync(join(workflowsDir, 'test.yml'), 'utf-8');
  const typecheckJob = getWorkflowJob(source, 'typecheck');

  expect(typecheckJob).toContain('bun run build:schema --check');
  expect(typecheckJob.indexOf('bun run build:schema --check')).toBeLessThan(
    typecheckJob.indexOf('bunx tsc --noEmit --pretty false'),
  );
});

test('test workflow shards the unit suite to keep PR feedback fast', () => {
  const source = readFileSync(join(workflowsDir, 'test.yml'), 'utf-8');
  const shardJob = getWorkflowJob(source, 'test-shard');

  expect(shardJob).toContain('strategy:');
  expect(shardJob).toContain('fail-fast: false');
  expect(shardJob).toContain('shard: [1, 2, 3, 4]');
  expect(shardJob).toContain('TEST_SHARD_INDEX: ${{ matrix.shard }}');
  expect(shardJob).toContain('TEST_SHARD_TOTAL: 4');
});

test('test workflow keeps the legacy test check as a shard aggregator', () => {
  const source = readFileSync(join(workflowsDir, 'test.yml'), 'utf-8');
  const testJob = getWorkflowJob(source, 'test');

  expect(testJob).toContain('needs: [typecheck, test-shard, test-macos]');
  expect(testJob).toContain('if: ${{ always() }}');
  expect(testJob).toContain('needs.typecheck.result');
  expect(testJob).toContain('needs.test-shard.result');
  expect(testJob).toContain('needs.test-macos.result');
  expect(testJob).toContain('exit 1');
  expect(testJob).toContain('Typecheck and all unit test shards passed');
});

test('test workflow runs the unit suite on macOS at PR time', () => {
  const source = readFileSync(join(workflowsDir, 'test.yml'), 'utf-8');
  const macosJob = getWorkflowJob(source, 'test-macos');

  expect(macosJob).toContain('runs-on: macos-latest');
  expect(macosJob).toContain('timeout-minutes:');
  expect(macosJob).toContain('fetch-depth: 0');
  // Pin the exact command: the macOS job must run the full unsharded suite,
  // not a ci-shard subset.
  expect(macosJob).toContain('- run: bun run test\n');
});

test('release workflow gates publishing on runtime and OAuth smokes', () => {
  const source = readFileSync(join(workflowsDir, 'release.yml'), 'utf-8');
  const smokeJob = getWorkflowJob(source, 'smoke');
  const releaseJob = getWorkflowJob(source, 'release');

  expect(smokeJob).toContain('image: pgvector/pgvector:pg16');
  expect(smokeJob).toContain('bun run smoke:postgres-runtime');
  expect(smokeJob).toContain('bun run smoke:http-oauth');
  expect(releaseJob).toContain('needs: [build, smoke]');
});
