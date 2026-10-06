/**
 * scripts/check-search-path.sh — every plpgsql function definition under src/
 * pins search_path (#1647, #5190, C-NEW-1).
 *
 * Protects: the static half of the search_path invariant (the runtime half is
 * test/fact-fingerprint-search-path.test.ts).
 * Fails when: the guard stops matching the `LANGUAGE plpgsql AS` header form,
 * headers with arguments or spread over lines, functions in TS schema modules,
 * or when it starts flagging LANGUAGE sql functions or historical migration
 * bodies.
 * Seam: GBRAIN_GUARD_ROOT (fixture tree).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..', '..');
const SCRIPT = join(REPO, 'scripts/check-search-path.sh');

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'search-path-guard-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function write(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(resolve(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}
function guard(dir = root) {
  const run = spawnSync('bash', [SCRIPT], { env: { ...process.env, GBRAIN_GUARD_ROOT: dir }, encoding: 'utf8' });
  return { code: run.status, out: run.stdout + run.stderr };
}

describe('check-search-path.sh', () => {
  it('passes on the repository', () => {
    const run = guard(REPO);
    expect(run).toMatchObject({ code: 0 });
  });

  it('flags an unpinned LANGUAGE plpgsql header in schema.sql', () => {
    write('src/schema.sql', 'CREATE OR REPLACE FUNCTION example_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END $fn$;\n');
    const run = guard();
    expect(run.code).toBe(1);
    expect(run.out).toContain('src/schema.sql:1: example_guard');
  });

  it('flags a function with arguments in a TS schema module', () => {
    write('src/core/example/schema.ts', "export const SQL = `\nCREATE OR REPLACE FUNCTION example_require(required integer) RETURNS void LANGUAGE plpgsql AS $$\nBEGIN END $$`;\n");
    const run = guard();
    expect(run.code).toBe(1);
    expect(run.out).toContain('src/core/example/schema.ts:2: example_require');
  });

  it('flags the legacy RETURNS trigger AS form and accepts a pinned header spread over lines', () => {
    write('src/a.sql', 'CREATE OR REPLACE FUNCTION legacy_fn() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$;\n');
    write('src/b.ts', 'const s = `CREATE OR REPLACE FUNCTION pinned_fn() RETURNS trigger\n    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$ BEGIN RETURN NEW; END $fn$`;\n');
    const run = guard();
    expect(run.code).toBe(1);
    expect(run.out).toContain('src/a.sql:1: legacy_fn');
    expect(run.out).not.toContain('pinned_fn');
  });

  it('exempts LANGUAGE sql functions and historical migration bodies', () => {
    write('src/core/facts/fn.ts', 'const s = `CREATE OR REPLACE FUNCTION inlinable(claim TEXT) RETURNS TEXT\n    LANGUAGE SQL IMMUTABLE STRICT AS $fn$ SELECT pg_catalog.lower(claim) $fn$`;\n');
    write('src/core/schema-migrations/v001-old.ts', 'const s = `CREATE OR REPLACE FUNCTION old_fn() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$`;\n');
    expect(guard()).toMatchObject({ code: 0 });
  });
});
