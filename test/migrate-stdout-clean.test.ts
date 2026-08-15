/**
 * Migrations must never write to stdout — regression for the heavy-tests
 * fm_wallclock failure (run 29731426470).
 *
 * Migrations run lazily inside ANY command's first DB connect (initSchema →
 * runMigrations), including JSON-emitting commands like `gbrain doctor --json`.
 * The v123 FTS migration (#2941) printed its completion notice via
 * `console.log`, which landed as the first line of `doctor --json` stdout and
 * broke every jq consumer ("Invalid numeric literal at line 1, column 7").
 * runMigrations' own contract (see the comment above its progress writes)
 * routes ALL migration noise to stderr.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runMigrations } from '../src/core/migrate.ts';

describe('migration output stays off stdout', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('re-running pending migrations (v122 → latest) writes nothing to stdout', async () => {
    // Rewind the version stamp so the v123 handler actually re-executes —
    // the exact state a CI Postgres/older brain is in when doctor connects.
    await engine.setConfig('version', '122');

    const stdoutWrites: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    const origLog = console.log;
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      stdoutWrites.push(String(chunk));
      return (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
    console.log = (...args: unknown[]) => { stdoutWrites.push(args.map(String).join(' ')); };

    try {
      const res = await runMigrations(engine);
      // Load-bearing: the migration must have actually run for the stdout
      // assertion to prove anything.
      expect(res.applied).toBeGreaterThanOrEqual(1);
    } finally {
      process.stdout.write = origWrite;
      console.log = origLog;
    }

    expect(stdoutWrites).toEqual([]);
  }, 60000);

  test('migrate.ts contains no console.log (all migration noise goes to stderr)', () => {
    const src = readFileSync(join(import.meta.dir, '../src/core/migrate.ts'), 'utf8');
    const offenders = src
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => line.includes('console.log('));
    expect(offenders).toEqual([]);
  });
});
