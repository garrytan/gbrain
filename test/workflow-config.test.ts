import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const repoRoot = new URL('..', import.meta.url).pathname;
const workflowsDir = join(repoRoot, '.github', 'workflows');
const workflowFiles = readdirSync(workflowsDir)
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .sort();

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf-8');
}

function readWorkflow(path: string): string {
  return readRepoFile(join('.github', 'workflows', path));
}

function getWorkflowName(source: string): string {
  return source.match(/^name:\s*(.+)$/m)?.[1].trim() ?? '';
}

function getWorkflowJobIds(source: string): string[] {
  const jobsStart = source.indexOf('\njobs:\n');
  if (jobsStart === -1) return [];
  const jobsSource = source.slice(jobsStart);
  return Array.from(jobsSource.matchAll(/^  ([a-zA-Z0-9_-]+):\n/gm)).map((match) => match[1]);
}

function getWorkflowJobDisplayName(jobSource: string): string {
  return jobSource.match(/^    name:\s*(.+)$/m)?.[1].trim() ?? '';
}

function getReleaseBuildMatrixRows(source: string): Array<Record<string, string>> {
  const buildJob = getWorkflowJob(source, 'build');
  const rows = Array.from(buildJob.matchAll(/^          - os:\s*(.+)$/gm));

  return rows.map((match, index) => {
    const start = match.index ?? 0;
    const end = index + 1 < rows.length ? rows[index + 1].index ?? buildJob.length : buildJob.length;
    const rowSource = buildJob.slice(start, end);
    return {
      os: match[1].trim(),
      target: rowSource.match(/^            target:\s*(.+)$/m)?.[1].trim() ?? '',
      artifact: rowSource.match(/^            artifact:\s*(.+)$/m)?.[1].trim() ?? '',
    };
  });
}

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
    const source = readWorkflow(workflow);

    expect(source).not.toContain('bun-version: latest');
    expect(source).toContain('bun-version: 1.3.12');
  });
}

test('release workflow typechecks before publishing binaries', () => {
  const source = readWorkflow('release.yml');

  expect(source).toContain('name: Typecheck');
  expect(source).toContain('bunx tsc --noEmit --pretty false');
});

test('release workflow smoke-tests compiled binaries before upload', () => {
  const source = readWorkflow('release.yml');
  const buildJob = getWorkflowJob(source, 'build');

  expect(buildJob).toContain('name: Repair macOS compiled signature');
  expect(buildJob).toContain("if: matrix.os == 'macos-latest'");
  expect(buildJob).toContain('codesign --remove-signature bin/${{ matrix.artifact }} || true');
  expect(buildJob).toContain('codesign --sign - --force bin/${{ matrix.artifact }}');
  expect(buildJob).toContain('name: Smoke compiled binary');
  expect(buildJob).toContain('bin/${{ matrix.artifact }} --version');
  expect(buildJob).toContain('name: Smoke compiled MCP binary');
  expect(buildJob).toContain('bun run smoke:installed-mcp');
  expect(buildJob).toContain('MBRAIN_SMOKE_COMMAND: bin/${{ matrix.artifact }}');
  expect(buildJob.indexOf('name: Repair macOS compiled signature')).toBeLessThan(
    buildJob.indexOf('name: Smoke compiled binary'),
  );
  expect(buildJob.indexOf('name: Smoke compiled binary')).toBeLessThan(
    buildJob.indexOf('name: Smoke compiled MCP binary'),
  );
  expect(buildJob.indexOf('name: Smoke compiled MCP binary')).toBeLessThan(
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
  const source = readWorkflow('test.yml');
  const shardJob = getWorkflowJob(source, 'test-shard');

  expect(shardJob).toContain('fetch-depth: 0');
  expect(shardJob).toContain('bun run test:ci-shard');
});

test('test workflow checks generated schemas before typecheck', () => {
  const source = readWorkflow('test.yml');
  const typecheckJob = getWorkflowJob(source, 'typecheck');

  expect(typecheckJob).toContain('bun run build:schema --check');
  expect(typecheckJob.indexOf('bun run build:schema --check')).toBeLessThan(
    typecheckJob.indexOf('bunx tsc --noEmit --pretty false'),
  );
});

test('test workflow shards the unit suite to keep PR feedback fast', () => {
  const source = readWorkflow('test.yml');
  const shardJob = getWorkflowJob(source, 'test-shard');

  expect(shardJob).toContain('strategy:');
  expect(shardJob).toContain('fail-fast: false');
  expect(shardJob).toContain('shard: [1, 2, 3, 4]');
  expect(shardJob).toContain('TEST_SHARD_INDEX: ${{ matrix.shard }}');
  expect(shardJob).toContain('TEST_SHARD_TOTAL: 4');
});

test('test workflow keeps the legacy test check as a shard aggregator', () => {
  const source = readWorkflow('test.yml');
  const testJob = getWorkflowJob(source, 'test');

  expect(testJob).toContain('needs: [typecheck, test-shard, test-macos, postgres-jsonb]');
  expect(testJob).toContain('if: ${{ always() }}');
  expect(testJob).toContain('needs.typecheck.result');
  expect(testJob).toContain('needs.test-shard.result');
  expect(testJob).toContain('needs.test-macos.result');
  expect(testJob).toContain('needs.postgres-jsonb.result');
  expect(testJob).toContain('exit 1');
  expect(testJob).toContain('Typecheck and all unit test shards passed');
});

test('test workflow gates PRs on Postgres target-runtime coverage', () => {
  const source = readWorkflow('test.yml');
  const postgresJob = getWorkflowJob(source, 'postgres-jsonb');
  const testJob = getWorkflowJob(source, 'test');

  expect(postgresJob).toContain('name: Postgres Target Runtime');
  expect(postgresJob).toContain('image: pgvector/pgvector:pg16');
  expect(postgresJob).toContain('test/postgres-jsonb-engine.test.ts');
  expect(postgresJob).toContain('test/memory-inbox-schema.test.ts');
  expect(postgresJob).toContain('test/memory-mutation-ledger-engine.test.ts');
  expect(postgresJob).toContain('test/canonical-handoff-engine.test.ts');
  expect(postgresJob).toContain('DATABASE_URL: postgresql://postgres:postgres@localhost:5432/mbrain_test');
  expect(testJob).toContain('needs.postgres-jsonb.result');
});

test('test workflow runs the unit suite on macOS at PR time', () => {
  const source = readWorkflow('test.yml');
  const macosJob = getWorkflowJob(source, 'test-macos');

  expect(macosJob).toContain('runs-on: macos-latest');
  expect(macosJob).toContain('timeout-minutes:');
  expect(macosJob).toContain('fetch-depth: 0');
  // Pin the exact command: the macOS job must run the full unsharded suite,
  // not a ci-shard subset.
  expect(macosJob).toContain('- run: bun run test\n');
});

test('release workflow keeps macOS full-test concurrency aligned with PR CI', () => {
  const releaseSource = readWorkflow('release.yml');
  const testSource = readWorkflow('test.yml');
  const releaseBuildJob = getWorkflowJob(releaseSource, 'build');
  const testMacosJob = getWorkflowJob(testSource, 'test-macos');

  expect(testMacosJob).toContain('timeout-minutes: 40');
  expect(releaseBuildJob).toContain('timeout-minutes: 40');
  expect(testMacosJob).toContain('TEST_WORKERS: 2');
  expect(releaseBuildJob).toContain('TEST_WORKERS: 2');
  expect(testMacosJob).toContain('TEST_TIMEOUT_MS: 120000');
  expect(releaseBuildJob).toContain('TEST_TIMEOUT_MS: 120000');
});

test('e2e workflow runs HTTP OAuth smoke in default Tier 1 CI', () => {
  const source = readWorkflow('e2e.yml');
  const tier1Job = getWorkflowJob(source, 'tier1');
  const httpOAuthSmokeStart = tier1Job.indexOf('HTTP OAuth smoke');
  const httpOAuthSmokeBlock = httpOAuthSmokeStart === -1 ? '' : tier1Job.slice(httpOAuthSmokeStart);

  expect(source).toContain('pull_request:');
  expect(tier1Job).toContain('timeout-minutes:');
  expect(tier1Job).not.toContain('github.event_name ==');
  expect(tier1Job).toContain('Run Tier 1 E2E tests');
  expect(tier1Job).toContain('HTTP OAuth smoke');
  expect(tier1Job).toContain('bun run smoke:http-oauth');
  expect(httpOAuthSmokeBlock).toContain('DATABASE_URL: postgresql://postgres:postgres@localhost:5432/mbrain_test');
  expect(tier1Job.indexOf('Run Tier 1 E2E tests')).toBeLessThan(
    tier1Job.indexOf('HTTP OAuth smoke'),
  );
});

test('e2e workflow passes DATABASE_URL into Tier 2 MCP configuration', () => {
  const source = readWorkflow('e2e.yml');
  const tier2Job = getWorkflowJob(source, 'tier2');

  expect(tier2Job).toContain('env:');
  expect(tier2Job).toContain('DATABASE_URL: postgresql://postgres:postgres@localhost:5432/mbrain_test');
  expect(tier2Job).toContain('"DATABASE_URL": "${{ env.DATABASE_URL }}"');
  expect(tier2Job.indexOf('DATABASE_URL: postgresql://postgres:postgres@localhost:5432/mbrain_test')).toBeLessThan(
    tier2Job.indexOf('"DATABASE_URL": "${{ env.DATABASE_URL }}"'),
  );
});

test('release workflow gates publishing on runtime and OAuth smokes', () => {
  const source = readWorkflow('release.yml');
  const smokeJob = getWorkflowJob(source, 'smoke');
  const releaseJob = getWorkflowJob(source, 'release');

  expect(smokeJob).toContain('image: pgvector/pgvector:pg16');
  expect(smokeJob).toContain('bun run smoke:postgres-runtime');
  expect(smokeJob).toContain('bun run smoke:http-oauth');
  expect(releaseJob).toContain('needs: [build, smoke]');
});

test('active docs reference existing release workflow jobs and build targets', () => {
  const readme = readRepoFile('README.md');
  const verifyRunbook = readRepoFile('docs/MBRAIN_VERIFY.md');
  const releaseSource = readWorkflow('release.yml');
  const releaseJobIds = getWorkflowJobIds(releaseSource);
  const buildMatrixRows = getReleaseBuildMatrixRows(releaseSource);

  expect(readme).toContain('Release workflow through the final `release` job');
  expect(verifyRunbook).toContain('the Release workflow `smoke`, Linux build, macOS build, and final `release`');
  expect(getWorkflowName(releaseSource)).toBe('Release');
  expect(releaseJobIds).toEqual(expect.arrayContaining(['build', 'smoke', 'release']));
  expect(buildMatrixRows).toEqual([
    { os: 'macos-latest', target: 'bun-darwin-arm64', artifact: 'mbrain-darwin-arm64' },
    { os: 'ubuntu-latest', target: 'bun-linux-x64', artifact: 'mbrain-linux-x64' },
  ]);
});

test('active docs reference the existing E2E Tier 2 workflow job', () => {
  const runtimeStatus = readRepoFile('docs/superpowers/specs/2026-05-31-mbrain-postgres-runtime-status.md');
  const e2eSource = readWorkflow('e2e.yml');
  const tier2Job = getWorkflowJob(e2eSource, 'tier2');

  expect(runtimeStatus).toContain('provider-key-gated Tier 2');
  expect(getWorkflowName(e2eSource)).toBe('E2E Tests');
  expect(getWorkflowJobIds(e2eSource)).toContain('tier2');
  expect(getWorkflowJobDisplayName(tier2Job)).toBe('Tier 2 (LLM Skills)');
});
