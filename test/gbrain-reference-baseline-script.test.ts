import { describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SCRIPT_PATH = new URL('../scripts/check-gbrain-reference-baseline.ts', import.meta.url).pathname;
const PATH_BOUNDARY_SCRIPT_PATH = new URL('../scripts/check-diff-path-boundary.ts', import.meta.url).pathname;

function git(referencePath: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: referencePath,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'MBrain Test',
      GIT_AUTHOR_EMAIL: 'mbrain-test@example.com',
      GIT_COMMITTER_NAME: 'MBrain Test',
      GIT_COMMITTER_EMAIL: 'mbrain-test@example.com',
    },
  }).trim();
}

function createReferenceRepo(): { root: string; sha: string } {
  const root = mkdtempSync(join(tmpdir(), 'mbrain-gbrain-reference-'));
  git(root, ['init', '--initial-branch=main']);
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'fixture baseline']);
  git(root, ['tag', 'v-test-baseline']);
  return { root, sha: git(root, ['rev-parse', 'HEAD']) };
}

function writeFixture(root: string, sha: string): string {
  const fixturePath = `${root}.fixture.json`;
  writeFileSync(
    fixturePath,
    `${JSON.stringify({
      upstream_baseline: {
        path: 'reference/gbrain',
        sha,
        tag: 'v-test-baseline',
      },
    }, null, 2)}\n`,
  );
  return fixturePath;
}

describe('gbrain reference baseline check script', () => {
  test('accepts a reference checkout that matches the classified baseline', () => {
    const { root, sha } = createReferenceRepo();
    const fixturePath = writeFixture(root, sha);

    try {
      const result = spawnSync('bun', ['run', SCRIPT_PATH], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GBRAIN_BASELINE_FIXTURE_PATH: fixturePath,
          GBRAIN_REFERENCE_PATH: root,
        },
      });

      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.status).toBe('matching');
      expect(parsed.actual.sha).toBe(sha);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(fixturePath, { force: true });
    }
  });

  test('fails when the local reference checkout has drifted from the classified baseline', () => {
    const { root, sha } = createReferenceRepo();
    const fixturePath = writeFixture(root, sha);
    writeFileSync(join(root, 'README.md'), '# fixture\n\nchanged\n');
    git(root, ['add', 'README.md']);
    git(root, ['commit', '-m', 'drift reference']);

    try {
      const result = spawnSync('bun', ['run', SCRIPT_PATH], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GBRAIN_BASELINE_FIXTURE_PATH: fixturePath,
          GBRAIN_REFERENCE_PATH: root,
        },
      });

      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.status).toBe('drifted');
      expect(parsed.expected.sha).toBe(sha);
      expect(parsed.actual.sha).not.toBe(sha);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(fixturePath, { force: true });
    }
  });

  test('fails when the local reference checkout matches the baseline but is dirty', () => {
    const { root, sha } = createReferenceRepo();
    const fixturePath = writeFixture(root, sha);
    writeFileSync(join(root, 'scratch.md'), 'uncommitted\n');

    try {
      const result = spawnSync('bun', ['run', SCRIPT_PATH], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GBRAIN_BASELINE_FIXTURE_PATH: fixturePath,
          GBRAIN_REFERENCE_PATH: root,
        },
      });

      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.status).toBe('drifted');
      expect(parsed.actual.sha).toBe(sha);
      expect(parsed.actual.dirty).toBe(true);
      expect(parsed.actual.dirtyPaths).toEqual(['?? scratch.md']);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(fixturePath, { force: true });
    }
  });
});

describe('changed path boundary check script', () => {
  test('accepts changed paths outside the configured disallowed prefixes', () => {
    const result = spawnSync('bun', ['run', PATH_BOUNDARY_SCRIPT_PATH], {
      encoding: 'utf8',
      env: {
        ...process.env,
        MBRAIN_CHANGED_PATHS: 'docs/UPSTREAM_SYNC.md,test/scenarios/s32-gbrain-upstream-discipline.test.ts',
        MBRAIN_DISALLOWED_PATH_PREFIXES: 'src/,supabase/,.github/workflows/',
      },
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.violations).toEqual([]);
  });

  test('fails when changed paths cross a configured disallowed prefix', () => {
    const result = spawnSync('bun', ['run', PATH_BOUNDARY_SCRIPT_PATH], {
      encoding: 'utf8',
      env: {
        ...process.env,
        MBRAIN_CHANGED_PATHS: 'docs/UPSTREAM_SYNC.md,src/core/runtime.ts',
        MBRAIN_DISALLOWED_PATH_PREFIXES: 'src/,supabase/,.github/workflows/',
      },
    });

    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.violations).toEqual(['src/core/runtime.ts']);
  });
});
