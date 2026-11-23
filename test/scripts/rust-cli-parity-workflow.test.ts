import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

// The Rust CLI parity workflow is the only CI that runs test/rust-cli-parity.serial.test.ts on a
// Rust engine lane push (lane branches reach rust-engine/main through the trunk, with no pull
// request, and rust-engine.yml runs only on pull requests and master pushes). These checks keep
// it from silently going blind again: its triggers, its path lists, the required-addon flag and
// the exact command.
type Step = { id?: string; name?: string; if?: string; uses?: string; run?: string; env?: Record<string, string>; 'timeout-minutes'?: number };
type Job = { 'runs-on'?: string; 'timeout-minutes'?: number; steps?: Step[] };
type Workflow = {
  on: { push?: { branches?: string[]; paths?: string[] }; pull_request?: { branches?: string[]; paths?: string[] } | null; workflow_dispatch?: unknown };
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
};

const root = join(import.meta.dir, '../..');
const file = '.github/workflows/rust-cli-parity.yml';
const workflow = load(readFileSync(join(root, file), 'utf8')) as Workflow;
const job = workflow.jobs['cli-parity']!;
const steps = job.steps ?? [];
const index = (match: (s: Step) => boolean) => steps.findIndex(match);

describe('Rust CLI parity workflow', () => {
  test('runs on every Rust lane push, on pull requests to any base and on dispatch', () => {
    expect(workflow.on.push?.branches).toEqual(['rust-engine/**']);
    expect(workflow.on.pull_request?.branches).toBeUndefined();
    expect('workflow_dispatch' in workflow.on).toBe(true);
    expect(workflow.permissions).toEqual({ contents: 'read' });
  });

  test('push and pull request use one broad path list that covers every input the job runs', () => {
    const push = workflow.on.push?.paths ?? [];
    expect(workflow.on.pull_request?.paths).toEqual(push);
    for (const path of [
      'src/**', 'rust/**', 'test/rust-cli-parity.serial.test.ts', 'test/fixtures/rust-cli-parity-brain/**', 'test/helpers/**',
      'package.json', 'bun.lock', 'bunfig.toml', 'tsconfig.json', 'scripts/ci-bun-install.ts', 'scripts/ci-bounded-run.ts', file,
    ]) expect(push).toContain(path);
  });

  test('a persistence-only change selects the job (the jw3 regression changed only src/core/persistence/coordinator.ts)', () => {
    const globs = (workflow.on.push?.paths ?? []).map(p => new Bun.Glob(p));
    const selects = (path: string) => globs.some(g => g.match(path));
    expect(selects('src/core/persistence/coordinator.ts')).toBe(true);
    expect(selects('src/commands/put.ts')).toBe(true);
    expect(selects('rust/crates/gbrain-store/src/persistence.rs')).toBe(true);
    expect(selects('docs/guides/example.md')).toBe(false);
  });

  test('builds the addon, installs bounded, then runs the parity file with the addon required', () => {
    expect(job['runs-on']).toBe('ubicloud-standard-4-ubuntu-2404');
    expect(job['timeout-minutes']).toBeGreaterThan(0);
    const build = index(s => s.run === 'bun run rust:build');
    const install = index(s => s.run === 'bun scripts/ci-bun-install.ts --frozen-lockfile --ignore-scripts');
    const parity = index(s => s.run === 'bun test --timeout=60000 test/rust-cli-parity.serial.test.ts');
    expect(build).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(build);
    expect(parity).toBeGreaterThan(install);
    expect(steps[parity]!.env).toEqual({ GBRAIN_TEST_RUST_ADDON_REQUIRED: '1' });
    expect(steps[parity]!.if).toBeUndefined();
    for (const i of [build, install, parity]) expect(steps[i]!['timeout-minutes']).toBeGreaterThan(0);
  });

  test('is classified in the event-parity table', () => {
    const doc = readFileSync(join(root, 'docs/ci-event-parity.md'), 'utf8');
    expect(doc).toContain('| `rust-cli-parity.yml` |');
  });
});
