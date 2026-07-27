/**
 * Postgres-only regression for archive/restore config recovery (#3420).
 *
 * restoreSource patches `config.federated` by binding a JS JSON string to a
 * jsonb placeholder. With a bare `$n::jsonb` bind, postgres.js double-encodes
 * the value into a jsonb STRING scalar (#2339 class); the coerced object then
 * gets `object || string` concatenated, which Postgres evaluates as
 * array-concat — so restore RE-CORRUPTS the exact shape this path repairs.
 * PGLite cannot reproduce this (its driver parses the bind natively), so this
 * is DATABASE_URL-gated per the engine-parity convention. Pins the
 * `$n::text::jsonb` bind shape: after archive → restore of a corrupted
 * string-scalar config, config must be jsonb_typeof = 'object', the federated
 * flag must be applied, and pre-existing keys must survive.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupDB, teardownDB, hasDatabase } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { softDeleteSource, restoreSource } from '../../src/core/destructive-guard.ts';

const skip = !hasDatabase();
const describeIfDB = skip ? describe.skip : describe;

let engine: PostgresEngine;

beforeAll(async () => {
  if (skip) return;
  engine = await setupDB();
});

afterAll(async () => {
  if (skip) return;
  await engine.executeRaw(`DELETE FROM sources WHERE id = 'restore-corrupt-cfg'`);
  await teardownDB();
});

describeIfDB('restoreSource config jsonb encoding — Postgres regression (#3420)', () => {
  test('archive → restore of a string-scalar config yields an object with federated preserved', async () => {
    const id = 'restore-corrupt-cfg';
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`,
      [id],
    );
    // Corrupted shape: config is a jsonb STRING scalar whose text is valid JSON.
    await engine.executeRaw(
      `UPDATE sources SET config = $2::text::jsonb, archived = false WHERE id = $1`,
      [id, JSON.stringify(JSON.stringify({ federated: false, remote_url: 'https://example.invalid/repo' }))],
    );
    const seeded = await engine.executeRaw<{ kind: string }>(
      `SELECT jsonb_typeof(config) AS kind FROM sources WHERE id = $1`,
      [id],
    );
    expect(seeded[0]!.kind).toBe('string');

    expect(await softDeleteSource(engine, id)).not.toBeNull();
    expect(await restoreSource(engine, id, true)).toBe(true);

    const rows = await engine.executeRaw<{ kind: string; federated: string | null; remote_url: string | null }>(
      `SELECT jsonb_typeof(config) AS kind,
              config->>'federated' AS federated,
              config->>'remote_url' AS remote_url
         FROM sources WHERE id = $1`,
      [id],
    );
    expect(rows[0]!.kind).toBe('object');
    expect(rows[0]!.federated).toBe('true');
    expect(rows[0]!.remote_url).toBe('https://example.invalid/repo');
  });
});
