/**
 * Coverage gate for the destructive-SQL guard.
 *
 * Any test file that connects a PostgresEngine to DATABASE_URL can TRUNCATE or
 * DELETE from whatever brain that URL points at. setupDB() calls
 * assertSafeE2eDatabaseUrl() before it does so; files that connect directly
 * bypass that check unless they call the guard themselves.
 *
 * This test scans the suite and fails when a file connects to DATABASE_URL
 * without either going through setupDB() or calling the guard. Static scan
 * only: no database connection, no DATABASE_URL required.
 *
 * KNOWN BLIND SPOTS (documented, not silent): a test that only passes the
 * ambient URL into a SPAWNED subprocess (gbrain CLI) has no in-file connect
 * idiom and is invisible here — the preload guard and the spawned CLI's own
 * config path are the layers that cover it. Destructive helpers living in
 * non-test files (other than setupDB) are likewise unscanned.
 */

import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join, resolve, relative } from 'path';

// Walk from the REPO root, not test/: a bare `bun test` at the repo root
// discovers *.test.ts repo-wide (evals/, examples/, …), so a test/-only scan
// would be a permanent blind spot for destructive tests outside test/.
const REPO_ROOT = resolve(import.meta.dir, '..');

function walk(dir: string, out: string[] = []): string[] {
  // fixtures/ IS scanned: `bun test` discovers *.test.ts there too, so an
  // exemption would be a blind spot. Only node_modules (never collected by
  // bun) and .git are skipped.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    // Match every pattern bun test collects (.test/.spec/.bench and _test/_spec,
    // all JS/TS extensions) — a destructive foo.spec.ts must not evade the scan.
    // Skip this file itself: the classifier positive-control fixtures below
    // are string literals that would otherwise scan as real test code.
    else if (
      /(\.(test|spec|bench)|_(test|spec))\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name) &&
      full !== import.meta.path
    ) out.push(full);
  }
  return out;
}

/**
 * Reads an ambient database URL AND constructs a connection path. Detection is
 * at the ASSIGNMENT site (any binding name), not a connect-site identifier
 * allowlist — `const url = process.env.DATABASE_URL!; connect({ database_url:
 * url })` and GBRAIN_DATABASE_URL spellings must not evade the scan
 * (fail-closed: prefer flagging a guarded file over missing an unguarded one).
 */
/**
 * Yields only non-comment lines: skips `//` lines, tracks multi-line block
 * comments statefully (a block comment written WITHOUT leading `*` per line
 * must still be excluded — the fail-open direction), and JSDoc `*` lines.
 */
function* codeLines(src: string): Generator<string> {
  let inBlock = false;
  for (const line of src.split('\n')) {
    if (inBlock) {
      if (/\*\//.test(line)) inBlock = false;
      continue;
    }
    if (/^\s*\/\*/.test(line)) {
      if (!/\*\//.test(line)) inBlock = true;
      continue;
    }
    if (/^\s*(\/\/|\*)/.test(line)) continue;
    yield line;
  }
}

function readsAmbientDatabaseUrl(src: string): boolean {
  for (const line of codeLines(src)) {
    // A `delete` of the env var is a scrub, not a read — files that explicitly
    // REMOVE the ambient URL before building fixture engines must not be
    // classified as connecting to it. (The regex is split from its match
    // target here so the R1 isolation lint doesn't read this scanner's own
    // pattern as a mutation.)
    if (/delete\s+process\.env/.test(line)) continue;
    if (/process\.env\.(GBRAIN_)?DATABASE_URL\b/.test(line)) return true;
    // bracket notation: process.env['DATABASE_URL'] / ["GBRAIN_DATABASE_URL"]
    if (/process\.env\[\s*['"`](GBRAIN_)?DATABASE_URL['"`]\s*\]/.test(line)) return true;
  }
  return false;
}

function connectsToAmbientDatabaseUrl(src: string): boolean {
  if (!readsAmbientDatabaseUrl(src)) return false;
  return /new\s+PostgresEngine\s*\(/.test(src)
    || /\bdb\.connect\s*\(/.test(src)
    // engine-factory idiom (env-inferred postgres) and raw postgres.js clients
    || /\bcreateEngine\s*\(/.test(src)
    || /\bpostgres\s*\(\s*[A-Za-z_$'"`]/.test(src);
}

/** Runs SQL that destroys data or schema. initSchema() counts: it migrates. */
function runsDestructiveSql(src: string): boolean {
  return /\b(TRUNCATE|DELETE\s+FROM|DROP\s+(TABLE|SCHEMA|INDEX|TRIGGER|FUNCTION|DATABASE|EXTENSION|OWNED)|ALTER\s+TABLE\s+\w+\s+DROP)\b/i.test(src)
    || /\.initSchema\s*\(/.test(src);
}

/**
 * Guarded either by the shared helper, by setupDB() (which calls it), or by an
 * inline db-name floor. schema-drift.test.ts uses the last form: its pattern is
 * deliberately different from the shared one (it also accepts *_e2e), so it is
 * recognized rather than rewritten.
 *
 * Comment-hardened: a guard token on a comment line (`// unlike setupDB() ...`)
 * must NOT count — this classifier is the exempting (fail-open) direction, so
 * it only accepts tokens on non-comment lines. Residual limitation: a trailing
 * comment after real code on the same line still counts that line.
 */
function isGuarded(src: string): boolean {
  for (const line of codeLines(src)) {
    if (/\b(assertSafeE2eDatabaseUrl|setupDB)\s*\(/.test(line)) return true;
    if (/looksLikeTestDb/.test(line)) return true;
  }
  return false;
}

function scan(): { unguarded: string[]; guarded: string[] } {
  const unguarded: string[] = [];
  const guarded: string[] = [];
  for (const file of walk(REPO_ROOT)) {
    const src = readFileSync(file, 'utf-8');
    if (!connectsToAmbientDatabaseUrl(src)) continue;
    if (!runsDestructiveSql(src)) continue;
    (isGuarded(src) ? guarded : unguarded).push(relative(REPO_ROOT, file));
  }
  return { unguarded, guarded };
}

describe('destructive-SQL guard coverage', () => {
  test('every test that runs destructive SQL on DATABASE_URL is guarded', () => {
    expect(scan().unguarded).toEqual([]);
  });

  test('positive control: the scan actually detects known destructive files', () => {
    // Guards against regex rot: if connectsToAmbientDatabaseUrl or
    // runsDestructiveSql stopped matching anything, the gate above would pass
    // vacuously forever. These two files connect to the ambient URL, run
    // destructive SQL, and call the guard — the scan must classify them so.
    const { guarded } = scan();
    expect(guarded).toContain('test/e2e/multimodal-postgres.test.ts');
    expect(guarded).toContain('test/phantom-redirect-engine-parity.test.ts');
  });
});

describe('scan classifiers (the gate must be able to fire)', () => {
  test('connectsToAmbientDatabaseUrl matches every ambient spelling in the suite', () => {
    const spellings = [
      `engine = new PostgresEngine();\nawait engine.connect({ database_url: process.env.DATABASE_URL });`,
      `const DATABASE_URL = process.env.DATABASE_URL;\nconst engine = new PostgresEngine();\nawait engine.connect({ database_url: DATABASE_URL! });`,
      `const dbUrl = process.env.DATABASE_URL;\npg = new PostgresEngine();\nawait pg.connect({ database_url: dbUrl } as never);`,
      // arbitrary binding name — the exact idiom the old allowlist missed
      `const url = process.env.DATABASE_URL!;\nengine = new PostgresEngine();\nawait engine.connect({ database_url: url });`,
      // GBRAIN_DATABASE_URL is honored by the runtime and must not evade the scan
      `const u = process.env.GBRAIN_DATABASE_URL;\nconst engine = new PostgresEngine();\nawait engine.connect({ database_url: u });`,
      // db.connect() path (no engine construction in the test file itself)
      `const url = process.env.DATABASE_URL;\nawait db.connect({ database_url: url });`,
    ];
    for (const src of spellings) expect(connectsToAmbientDatabaseUrl(src)).toBe(true);
  });

  test('connectsToAmbientDatabaseUrl ignores fixture-URL connections and non-connecting files', () => {
    expect(
      connectsToAmbientDatabaseUrl(
        `const engine = new PostgresEngine();\nawait engine.connect({ database_url: fixtureUrl });`,
      ),
    ).toBe(false);
    expect(
      connectsToAmbientDatabaseUrl(`const url = process.env.DATABASE_URL; // read, no engine/connect`),
    ).toBe(false);
  });

  test('runsDestructiveSql matches each destructive arm and not plain reads', () => {
    for (const src of [
      'await engine.executeRaw(`TRUNCATE pages`);',
      "await engine.executeRaw('DELETE FROM pages');",
      'await engine.executeRaw(`DROP TABLE takes`);',
      'await engine.executeRaw(`ALTER TABLE pages DROP COLUMN x`);',
      'await engine.initSchema();',
    ]) {
      expect(runsDestructiveSql(src)).toBe(true);
    }
    expect(runsDestructiveSql('await engine.executeRaw(`SELECT 1`);')).toBe(false);
  });

  test('isGuarded recognizes each accepted guard form and nothing else', () => {
    expect(isGuarded('assertSafeE2eDatabaseUrl(url);')).toBe(true);
    expect(isGuarded('await setupDB();')).toBe(true);
    expect(isGuarded('if (!looksLikeTestDb(name)) return;')).toBe(true);
    expect(isGuarded('// totally unguarded')).toBe(false);
  });

  test('isGuarded rejects comment-only guard mentions (fail-open hardening)', () => {
    expect(isGuarded('// unlike setupDB() we connect directly')).toBe(false);
    expect(isGuarded('/* assertSafeE2eDatabaseUrl( would go here */')).toBe(false);
    expect(isGuarded(' * setupDB() runs SCHEMA_SQL — JSDoc mention')).toBe(false);
    // multi-line block comment WITHOUT leading * per line — must not count
    expect(isGuarded('/*\nsetupDB() would be wrong here\n*/\nconnect();')).toBe(false);
    // real call on a code line still counts even with comments elsewhere
    expect(isGuarded('// intro comment\nawait setupDB();')).toBe(true);
    expect(isGuarded('/* block */\nawait setupDB();')).toBe(true);
  });

  test('readsAmbientDatabaseUrl catches bracket notation and skips scrubs', () => {
    expect(
      connectsToAmbientDatabaseUrl(
        `const u = process.env['DATABASE_URL'];\nconst engine = new PostgresEngine();`,
      ),
    ).toBe(true);
    // Fixture built by concatenation: the classifier must see the contiguous
    // scrub statement, but the R1 isolation lint must not read this test's
    // own fixture as a real env mutation.
    const scrub = 'delete ' + 'process.env.';
    expect(
      connectsToAmbientDatabaseUrl(
        `${scrub}DATABASE_URL;\n${scrub}GBRAIN_DATABASE_URL;\nconst e = await createEngine(cfg);`,
      ),
    ).toBe(false);
  });

  test('runsDestructiveSql catches the non-TABLE DROP arms', () => {
    for (const src of [
      'await sql.unsafe(`DROP TRIGGER IF EXISTS t ON oauth_tokens`);',
      'await sql.unsafe(`DROP FUNCTION IF EXISTS f()`);',
      "psqlish('DROP DATABASE gbrain');",
    ]) {
      expect(runsDestructiveSql(src)).toBe(true);
    }
  });

  test('an unguarded destructive source would be flagged end-to-end', () => {
    const bad = [
      `const engine = new PostgresEngine();`,
      `await engine.connect({ database_url: process.env.DATABASE_URL });`,
      `await engine.executeRaw('TRUNCATE pages');`,
    ].join('\n');
    expect(connectsToAmbientDatabaseUrl(bad)).toBe(true);
    expect(runsDestructiveSql(bad)).toBe(true);
    expect(isGuarded(bad)).toBe(false);
  });
});
