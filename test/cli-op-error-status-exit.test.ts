/**
 * #4488 — an op that reports failure IN-BAND (`{status: 'error'}`) must exit
 * non-zero at the CLI.
 *
 * `gbrain put <slug>` with unparseable frontmatter returned the
 * `{status:'error', error:'YAML parse failed…'}` envelope on stdout and
 * exited 0 — the page was never created, but scripts (and agents checking
 * `$?`) read it as success. The op runner only set a non-zero verdict on
 * THROW. It now inspects the normalized result: `status === 'error'` → exit
 * verdict 1 + the error echoed to stderr. No-op statuses ('skipped',
 * 'unchanged', 'created_or_updated') keep exit 0.
 *
 * Subprocess tests against a shared temp PGLite home (schema init paid once
 * in beforeAll; later spawns reuse the persisted brain).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;

function run(args: string[], stdin?: string): { stdout: string; stderr: string; status: number } {
  const r = spawnSync('bun', ['run', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    input: stdin,
    env: {
      ...process.env,
      GBRAIN_HOME: home,
      DATABASE_URL: '',
      GBRAIN_DATABASE_URL: '',
      GBRAIN_SKIP_STARTUP_HOOKS: '1',
    },
    timeout: 240_000,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1 };
}

const GOOD_PAGE = `---
type: concept
title: Good Page
---

A perfectly fine body.
`;

const BAD_YAML_PAGE = `---
title: [unclosed
type: concept
---

Body under broken frontmatter.
`;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-4488-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  const dbPath = join(home, '.gbrain', 'brain.pglite');
  writeFileSync(
    join(home, '.gbrain', 'config.json'),
    JSON.stringify({ engine: 'pglite', database_path: dbPath }),
  );
  // Pay schema init in-process (a cold spawn can exceed spawn timeouts on a
  // loaded machine); the CLI spawns below reuse the persisted brain.
  const { createEngine } = await import('../src/core/engine-factory.ts');
  const engineConfig = { engine: 'pglite' as const, database_path: dbPath };
  const engine = await createEngine(engineConfig);
  await engine.connect(engineConfig);
  await engine.initSchema();
  await engine.disconnect();
}, 480_000);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('#4488 in-band {status:error} → CLI exit 1', () => {
  test('put with unparseable frontmatter exits 1 and echoes the error to stderr', () => {
    const r = run(['put', 'notes/bad-yaml'], BAD_YAML_PAGE);
    expect(r.stdout).toContain('"status"');
    expect(r.stdout).toContain('error');
    // Pre-fix: exit 0 with the error envelope on stdout only.
    expect(r.status).toBe(1);
    expect(r.stderr.toLowerCase()).toContain('yaml');
    // The page really was never created.
    const get = run(['get', 'notes/bad-yaml']);
    expect(get.status).not.toBe(0);
  }, 240_000);

  test("a dedup 'skipped' put stays exit 0 (no-op is not a failure)", () => {
    const first = run(['put', 'notes/good-page'], GOOD_PAGE);
    expect(first.status).toBe(0);
    const second = run(['put', 'notes/good-page'], GOOD_PAGE);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('skipped');
  }, 480_000);
});
