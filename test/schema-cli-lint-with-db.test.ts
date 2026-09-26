/**
 * `gbrain schema lint --with-db` — the flag must never be mistaken for the
 * optional pack-name positional argument, regardless of where it appears
 * on the command line, and the DB-plane lint rules it opts into
 * (extractable_empty_corpus, mutation_count_anomaly — see runLintCmd) must
 * actually run through `withConnectedEngine` when it is passed with no
 * name. Neither path had test coverage before this file (TODOS.md: "the
 * v0.50.1.0 wave re-plumbed `gbrain schema lint --with-db` inside
 * `withConnectedEngine`... nothing in test/ drives it").
 *
 * Hermetic subprocess tests, same pattern as test/schema-cli-lint-extends.test.ts.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const CLI = join(REPO_ROOT, 'src', 'cli.ts');

let GBRAIN_HOME: string;

function gbrain(args: string[]): { stdout: string; stderr: string; code: number } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: GBRAIN_HOME, GBRAIN_HOME };
  for (const key of [
    'DATABASE_URL',
    'GBRAIN_DATABASE_URL',
    'OPENAI_API_KEY',
    'VOYAGE_API_KEY',
    'ANTHROPIC_API_KEY',
    'DEEPSEEK_API_KEY',
    'DEEP_SEEK_API_KEY',
  ]) delete env[key];
  const result = spawnSync('bun', ['run', CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env,
    timeout: 120_000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    code: result.status ?? -1,
  };
}

beforeAll(() => {
  GBRAIN_HOME = mkdtempSync(join(tmpdir(), 'gbrain-schema-lint-with-db-'));
  const init = gbrain(['init', '--pglite', '--no-embedding', '--non-interactive']);
  expect(init.code, init.stderr).toBe(0);
}, 60000);

afterAll(() => {
  rmSync(GBRAIN_HOME, { recursive: true, force: true });
});

describe('gbrain schema lint --with-db does not swallow itself as the pack name', () => {
  test('bare `--with-db` (no pack name) lints the active pack through the DB plane, not a pack literally named --with-db', () => {
    const r = gbrain(['schema', 'lint', '--with-db']);
    expect(r.stdout + r.stderr).not.toContain('Pack not found: --with-db');
    expect(r.code).toBe(0);
    // The DB-plane-only rule set includes extractable_empty_corpus; seeing
    // it (as a warn on a freshly-initialized, page-less brain) confirms the
    // lint actually ran through withConnectedEngine's DB-backed path, not
    // just the file-plane rules that run unconditionally.
    expect(r.stdout).toContain('extractable_empty_corpus');
  }, 30000);

  test('`--with-db` BEFORE a nonexistent pack name reports the pack name, not the flag', () => {
    const r = gbrain(['schema', 'lint', '--with-db', 'nonexistent-pack-xyz']);
    expect(r.stdout + r.stderr).toContain('Pack not found: nonexistent-pack-xyz');
    expect(r.stdout + r.stderr).not.toContain('Pack not found: --with-db');
    expect(r.code).toBe(1);
  }, 30000);

  test('`--with-db` AFTER a nonexistent pack name still reports the pack name (order-independence regression guard)', () => {
    const r = gbrain(['schema', 'lint', 'nonexistent-pack-xyz', '--with-db']);
    expect(r.stdout + r.stderr).toContain('Pack not found: nonexistent-pack-xyz');
    expect(r.code).toBe(1);
  }, 30000);

  test('plain `schema lint` (no --with-db, no name) is unaffected and does not run the DB-plane rules', () => {
    const r = gbrain(['schema', 'lint']);
    expect(r.code).toBe(0);
    // extractable_empty_corpus only runs when --with-db opts into the
    // engine-backed rule set (see runLintCmd) — its absence here is the
    // file-plane/DB-plane split actually working, not a fluke of the fixture.
    expect(r.stdout).not.toContain('extractable_empty_corpus');
  }, 30000);

});
