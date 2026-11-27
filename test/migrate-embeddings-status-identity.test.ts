/**
 * `gbrain migrate embeddings --status --json` names the engine its config file names.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the `identity` field of the status answer reads `{ engine: 'rust', target: <database_path> }` for a Rust
 *    brain's config (`engine: 'rust'` with a `database_path`), and exactly what it read before for a PGLite config
 *    (`database_path` only) and a Postgres config (`database_url`, redacted).
 *  - Regression: every config with a `database_path` printed `engine: 'pglite'`, so a Rust brain's status said it was a
 *    PGLite brain.
 *  - Why existing coverage misses it: the parity cases run with no config file, where every engine prints the default
 *    identity.
 *  - Seam: GBRAIN_HOME holds the config file; the engine is a PGLite engine in memory (the identity reads only config).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runMigrateEmbeddings } from '../src/commands/migrate-embeddings.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });

/** The `identity` field of `--status --json` with `config` as the brain's config file. */
async function identityFor(config: Record<string, unknown>): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-status-identity-'));
  try {
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(config));
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_EMBEDDING_MODEL: undefined,
      GBRAIN_EMBEDDING_DIMENSIONS: undefined }, async () => {
      const exited = new Error('exited');
      const lines: string[] = [];
      const log = console.log;
      console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
      try {
        await runMigrateEmbeddings(engine, ['--status', '--json'], { exit: (() => { throw exited; }) as never })
          .catch((e: unknown) => { if (e !== exited) throw e; });
      } finally { console.log = log; }
      return JSON.stringify((JSON.parse(lines.join('\n')) as { identity: unknown }).identity);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

describe('migrate embeddings --status names the configured engine', () => {
  test('a Rust config prints rust and its database path', async () => {
    expect(await identityFor({ engine: 'rust', database_path: '/var/tmp/brain-example.rust' }))
      .toBe('{"engine":"rust","target":"/var/tmp/brain-example.rust"}');
  });

  test('a PGLite config and a Postgres config print what they printed before, byte for byte', async () => {
    expect(await identityFor({ engine: 'pglite', database_path: '/var/tmp/brain-example.pglite' }))
      .toBe('{"engine":"pglite","target":"/var/tmp/brain-example.pglite"}');
    expect(await identityFor({ database_path: '/var/tmp/brain-example.pglite' }))
      .toBe('{"engine":"pglite","target":"/var/tmp/brain-example.pglite"}');
    expect(await identityFor({ engine: 'postgres', database_url: 'postgres://user:secret@db.example:5432/brain' }))
      .toBe(`{"engine":"postgres","target":${JSON.stringify(await redacted('postgres://user:secret@db.example:5432/brain'))}}`);
  });
});

/** The status answer's own redaction of a Postgres URL (the field is redacted, never the raw URL). */
async function redacted(url: string): Promise<string> {
  const { redactPgUrl } = await import('../src/core/url-redact.ts');
  return redactPgUrl(url);
}
