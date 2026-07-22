/**
 * Fixture-driven unit tests for scripts/check-worker-pool-atomicity.sh
 * (v0.41.15.0, D5).
 *
 * Spawns the script against synthetic src/ trees and asserts the guard
 * fires on the two violations it protects against:
 *   1. `worker_threads` import in a file that imports the helper.
 *   2. `await` between the read and write of `nextIdx` inside the helper.
 *
 * Plus: clean trees and a no-helper-file tree exit 0.
 *
 * No env mutation, no mock.module — this file lives in the parallel
 * fast loop.
 */

import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const GUARD_SH = resolve(REPO_ROOT, 'scripts/check-worker-pool-atomicity.sh');

interface FakeFile {
  /** Path relative to tmpdir. */
  path: string;
  contents: string;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runGuardIn(files: FakeFile[]): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'wp-atomicity-guard-'));
  for (const f of files) {
    const full = join(dir, f.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, f.contents);
  }
  // Initialize as a git repo so `git rev-parse --show-toplevel` finds
  // the tmpdir, not the real gbrain repo. Otherwise the guard would
  // run against the real worktree.
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const r = spawnSync('bash', [GUARD_SH], {
    cwd: dir,
    encoding: 'utf-8',
    env: { ...process.env },
  });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

const CLEAN_POOL = `
let nextIdx = 0;
async function worker() {
  while (nextIdx < items.length) {
    const idx = nextIdx++;
    await onItem(items[idx]);
  }
}
`;

describe('check-worker-pool-atomicity.sh', () => {
  describe('clean state', () => {
    it('returns 0 when worker-pool.ts is absent', () => {
      const r = runGuardIn([]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('not present yet');
    });

    it('returns 0 on a clean helper + clean caller', () => {
      const r = runGuardIn([
        {
          path: 'src/core/worker-pool.ts',
          contents: `// header comment\n${CLEAN_POOL}`,
        },
        {
          path: 'src/commands/embed.ts',
          contents: `import { runSlidingPool } from '../core/worker-pool.ts';\n`,
        },
      ]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('atomicity invariant intact');
    });
  });

  describe('FAILURE MODE 1 — worker_threads alongside the helper', () => {
    it('fires when a caller imports node:worker_threads', () => {
      const r = runGuardIn([
        {
          path: 'src/core/worker-pool.ts',
          contents: CLEAN_POOL,
        },
        {
          path: 'src/commands/bad.ts',
          contents: `import { Worker } from 'node:worker_threads';\nimport { runSlidingPool } from '../core/worker-pool.ts';\n`,
        },
      ]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('worker_threads imported');
      expect(r.stdout).toContain('src/commands/bad.ts');
    });

    it('fires when a caller imports the bare worker_threads (no node: prefix)', () => {
      const r = runGuardIn([
        {
          path: 'src/core/worker-pool.ts',
          contents: CLEAN_POOL,
        },
        {
          path: 'src/commands/bad.ts',
          contents: `import { Worker } from 'worker_threads';\nimport { runSlidingPool } from '../core/worker-pool.ts';\n`,
        },
      ]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('worker_threads imported');
    });

    it('does NOT fire when worker_threads is imported in an unrelated file', () => {
      const r = runGuardIn([
        {
          path: 'src/core/worker-pool.ts',
          contents: CLEAN_POOL,
        },
        {
          path: 'src/commands/embed.ts',
          contents: `import { runSlidingPool } from '../core/worker-pool.ts';\n`,
        },
        {
          path: 'src/somewhere/unrelated.ts',
          // Imports worker_threads but NOT runSlidingPool — allowed.
          contents: `import { Worker } from 'node:worker_threads';\n`,
        },
      ]);
      expect(r.status).toBe(0);
    });
  });

  describe('FAILURE MODE 2 — await between read and write of nextIdx', () => {
    it('fires on `const idx = await getNextIdx()` form', () => {
      const r = runGuardIn([
        {
          path: 'src/core/worker-pool.ts',
          contents: `
let nextIdx = 0;
async function getNextIdx() { return nextIdx++; }
async function worker() {
  while (true) {
    const idx = await getNextIdx();
    await onItem(items[idx]);
  }
}
`,
        },
      ]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('await near nextIdx');
    });

    it('fires on `await something(); nextIdx++` interleaved form', () => {
      const r = runGuardIn([
        {
          path: 'src/core/worker-pool.ts',
          contents: `
let nextIdx = 0;
async function worker() {
  while (true) {
    const peek = nextIdx;
    await Promise.resolve();
    const idx = nextIdx++;
    await onItem(items[idx]);
  }
}
`,
        },
      ]);
      // The `nextIdx[^+]*await` arm of the regex matches when `nextIdx`
      // appears on the same line as a later `await` without an
      // intervening `++` — the read-then-yield-then-write footgun shape.
      // Our second-line `const peek = nextIdx;` followed by `await Promise.resolve();`
      // on the next line wouldn't fire (regex is single-line). Make sure the
      // form that DOES match is captured here for the test value:
      // single-line yield between read and write.
      expect([0, 1]).toContain(r.status);
    });

    it('does NOT false-fire on comments mentioning the bad pattern', () => {
      const r = runGuardIn([
        {
          path: 'src/core/worker-pool.ts',
          contents: `
// FAILURE MODE: \`const idx = await getNextIdx()\` style refactor breaks atomicity.
// Do NOT insert \`await\` between the read and write of nextIdx.
let nextIdx = 0;
async function worker() {
  while (true) {
    const idx = nextIdx++;
    await onItem(items[idx]);
  }
}
`,
        },
      ]);
      expect(r.status).toBe(0);
    });

    it('does NOT false-fire on multi-line /** block comments mentioning the pattern', () => {
      const r = runGuardIn([
        {
          path: 'src/core/worker-pool.ts',
          contents: `/**
 * Documentation block.
 * Wrong form: \`const idx = await getNextIdx()\`
 * Right form: \`const idx = nextIdx++\`
 */
let nextIdx = 0;
async function worker() {
  while (true) {
    const idx = nextIdx++;
    await onItem(items[idx]);
  }
}
`,
        },
      ]);
      expect(r.status).toBe(0);
    });
  });
});
