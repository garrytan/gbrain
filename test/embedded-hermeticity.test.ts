/**
 * GBRA-248 W1: the embedded core's hermeticity test, and the run that keeps
 * examples/embedded-two-brains.ts (the docs quickstart) working.
 *
 * A cold child process runs the example with canary HOME, GBRAIN_HOME and
 * TMPDIR directories (each holding a conflicting config.json) and canary
 * provider keys in its environment. The quickstart must work. The hermetic
 * case also requires that nothing under the canary directories changes and
 * that no code under src/ reads an environment variable; today the core reads
 * GBRAIN_* tuning variables during connect, migrate, search and close, so it
 * is expected to fail until W7 (plans/GBRA-248-embeddable-core.md), which
 * turns it into the required Linux lane that also denies filesystem and
 * child-process access outside the injected paths.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..');
const root = mkdtempSync(join(tmpdir(), 'gbrain-hermetic-'));
const canaries = { HOME: join(root, 'home'), GBRAIN_HOME: join(root, 'gbrain-home'), TMPDIR: join(root, 'tmp') };
const brains = { a: join(root, 'brain-a'), b: join(root, 'brain-b') };
const canaryConfig = JSON.stringify({ engine: 'postgres', database_url: 'postgresql://canary@127.0.0.1:1/canary', embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 768 });

function snapshot(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      const st = statSync(p);
      if (st.isDirectory()) walk(p); else out[p] = st.mtimeMs;
    }
  };
  walk(dir);
  return out;
}

let run: { code: number | null; stdout: string; stderr: string; envReads: string[]; before: Record<string, number>; after: Record<string, number> };

beforeAll(async () => {
  for (const dir of [...Object.values(canaries), ...Object.values(brains)]) mkdirSync(dir, { recursive: true });
  mkdirSync(join(canaries.HOME, '.gbrain'));
  writeFileSync(join(canaries.HOME, '.gbrain', 'config.json'), canaryConfig);
  writeFileSync(join(canaries.GBRAIN_HOME, 'config.json'), canaryConfig);
  const before = Object.assign({}, ...Object.values(canaries).map(snapshot));
  const log = join(root, 'env-reads.json');
  const proc = Bun.spawn(['bun', '--preload', join(REPO, 'test/helpers/hermetic-preload.ts'), join(REPO, 'examples/embedded-two-brains.ts'), brains.a, brains.b], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '',
      ...canaries,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
      HERMETIC_LOG: log,
      OPENAI_API_KEY: 'sk-canary-openai',
      ANTHROPIC_API_KEY: 'sk-ant-canary',
      DATABASE_URL: 'postgresql://canary@127.0.0.1:1/canary',
      GBRAIN_DATABASE_URL: 'postgresql://canary@127.0.0.1:1/canary',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const after = Object.assign({}, ...Object.values(canaries).map(snapshot));
  let envReads: string[] = [];
  try { envReads = JSON.parse(readFileSync(log, 'utf8')); } catch { envReads = ['<no log: the child did not exit cleanly>']; }
  run = { code, stdout, stderr, envReads, before, after };
}, 120_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

test('the quickstart opens two brains in one process and each sees only its own page', () => {
  expect(run.code, run.stderr).toBe(0);
  const report = JSON.parse(run.stdout.trim().split('\n').pop()!);
  expect(report).toEqual({
    a: { slug: 'notes/quickstart-a', found: ['notes/quickstart-a'], reopened: 'Quickstart a' },
    b: { slug: 'notes/quickstart-b', found: ['notes/quickstart-b'], reopened: 'Quickstart b' },
  });
});

test.failing('hermetic: write, search, close and reopen touch no canary directory and read no environment (expected to fail until W7)', () => {
  expect(run.code, run.stderr).toBe(0);
  expect(run.after).toEqual(run.before);
  expect(run.envReads).toEqual([]);
});
