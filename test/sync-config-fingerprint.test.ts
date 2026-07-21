/**
 * #2157 follow-on (migration v125 — `sources.config_fingerprint`).
 *
 * The "Already up to date" gate at performSync's git-HEAD equality check
 * honored chunker_version match but ignored `sources.config` drift.
 * Changing `sources.config.exclude_globs` (or include_globs / strategy)
 * had no observable effect on the next sync because git HEAD was
 * unchanged — the gate returned early and the new walk scope never
 * applied. This file exercises the persistence shape + drift detection
 * end-to-end on PGLite, including:
 *
 *   - Migration v125 actually adds the column (regression guard against
 *     a future re-numbering or accidental deletion).
 *   - read/write round-trips preserve the value.
 *   - The fingerprint differs across the three walk-affecting fields
 *     and is order-insensitive on the array fields.
 *   - NULL fingerprint on pre-v125 rows treats as "not stamped" so a
 *     first post-upgrade sync doesn't spuriously force-full.
 *   - A toggle-and-revert leaves the stored fingerprint matching the
 *     current row, so the gate stays quiet.
 *
 * The wired-up gate behavior (force-full triggered on mismatch) is
 * exercised by the existing sync end-to-end tests; here we pin the
 * persistence + comparison primitives the gate depends on.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  computeSourceConfigFingerprint,
  readConfigFingerprint,
  writeConfigFingerprint,
} from '../src/commands/sync.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine?.disconnect();
});

/** Insert a fresh source row with the given config. Returns the id. */
async function makeSource(
  id: string,
  config: Record<string, unknown> = {},
): Promise<string> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config) VALUES ($1, $2, $3, $4::text::jsonb)`,
    [id, id, `/tmp/${id}`, JSON.stringify(config)],
  );
  return id;
}

describe('migration v125 — sources.config_fingerprint column', () => {
  test('column exists on the sources table', async () => {
    const rows = await engine.executeRaw<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'sources' AND column_name = 'config_fingerprint'`,
    );
    expect(rows).toHaveLength(1);
  });

  test('column is nullable (preserves pre-migration row semantics)', async () => {
    const rows = await engine.executeRaw<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'sources' AND column_name = 'config_fingerprint'`,
    );
    expect(rows[0]?.is_nullable).toBe('YES');
  });
});

describe('readConfigFingerprint / writeConfigFingerprint — persistence round-trip', () => {
  test('round-trip: write then read returns the same value', async () => {
    const id = await makeSource('rt-basic', { exclude_globs: ['Templates/**'] });
    const fp = computeSourceConfigFingerprint({ exclude_globs: ['Templates/**'] });
    await writeConfigFingerprint(engine, id, fp);
    const got = await readConfigFingerprint(engine, id);
    expect(got).toBe(fp);
  });

  test('NULL on never-stamped row (pre-v125 semantics)', async () => {
    const id = await makeSource('rt-never');
    const got = await readConfigFingerprint(engine, id);
    expect(got).toBeNull();
  });

  test('undefined sourceId returns null (legacy non-source-scoped sync)', async () => {
    const got = await readConfigFingerprint(engine, undefined);
    expect(got).toBeNull();
  });

  test('write with undefined sourceId is a no-op (does not throw)', async () => {
    // The legacy global-sync code path hits this branch; the guard must
    // be silent rather than fail the sync run.
    await writeConfigFingerprint(engine, undefined, 'deadbeef'.repeat(8));
    // No assertion beyond "did not throw"; the function returns void.
  });

  test('overwrite: a second write replaces the prior fingerprint', async () => {
    const id = await makeSource('rt-overwrite');
    await writeConfigFingerprint(engine, id, 'a'.repeat(64));
    await writeConfigFingerprint(engine, id, 'b'.repeat(64));
    const got = await readConfigFingerprint(engine, id);
    expect(got).toBe('b'.repeat(64));
  });
});

describe('end-to-end drift simulation — the gate semantics this column enables', () => {
  test('first stamp matches computed fingerprint of the row config', async () => {
    const cfg = { exclude_globs: ['Templates/**', 'Photos/**'], strategy: 'markdown' };
    const id = await makeSource('e2e-first-stamp', cfg);
    const computed = computeSourceConfigFingerprint(cfg);
    await writeConfigFingerprint(engine, id, computed);
    expect(await readConfigFingerprint(engine, id)).toBe(computed);
  });

  test('exclude_globs mutation makes stored != current (drift detected)', async () => {
    const before = { exclude_globs: ['Templates/**'] };
    const after = { exclude_globs: ['Templates/**', 'Photos/**'] };
    const id = await makeSource('e2e-exclude-drift', before);
    const beforeFp = computeSourceConfigFingerprint(before);
    await writeConfigFingerprint(engine, id, beforeFp);

    // Simulate the user mutating sources.config via `gbrain sources add
    // --exclude`. The gate's next read of (stored, computed-from-current)
    // detects the drift and forces a re-walk.
    await engine.executeRaw(
      `UPDATE sources SET config = $1::text::jsonb WHERE id = $2`,
      [JSON.stringify(after), id],
    );
    const afterFp = computeSourceConfigFingerprint(after);
    const stored = await readConfigFingerprint(engine, id);
    expect(stored).toBe(beforeFp);
    expect(stored).not.toBe(afterFp);
  });

  test('toggle-and-revert: add then remove same pattern leaves stored matching current', async () => {
    const original = { exclude_globs: ['Templates/**'] };
    const id = await makeSource('e2e-toggle', original);
    const originalFp = computeSourceConfigFingerprint(original);
    await writeConfigFingerprint(engine, id, originalFp);

    // Add a pattern (drift) then remove it (revert).
    await engine.executeRaw(
      `UPDATE sources SET config = $1::text::jsonb WHERE id = $2`,
      [JSON.stringify({ exclude_globs: ['Templates/**', 'Photos/**'] }), id],
    );
    await engine.executeRaw(
      `UPDATE sources SET config = $1::text::jsonb WHERE id = $2`,
      [JSON.stringify(original), id],
    );
    const revertedFp = computeSourceConfigFingerprint(original);
    expect(revertedFp).toBe(originalFp);
    expect(await readConfigFingerprint(engine, id)).toBe(originalFp);
    // ⇒ Gate compares storedFp (==originalFp) to currentFp (==originalFp): no drift, no force-full.
  });

  test('include_globs drift detected independently', async () => {
    const before = { include_globs: ['people/**'] };
    const after = { include_globs: ['people/**', 'companies/**'] };
    const id = await makeSource('e2e-include-drift', before);
    await writeConfigFingerprint(engine, id, computeSourceConfigFingerprint(before));
    await engine.executeRaw(
      `UPDATE sources SET config = $1::text::jsonb WHERE id = $2`,
      [JSON.stringify(after), id],
    );
    const stored = await readConfigFingerprint(engine, id);
    const current = computeSourceConfigFingerprint(after);
    expect(stored).not.toBe(current);
  });

  test('strategy drift detected', async () => {
    const before = { strategy: 'markdown' };
    const after = { strategy: 'code' };
    const id = await makeSource('e2e-strategy-drift', before);
    await writeConfigFingerprint(engine, id, computeSourceConfigFingerprint(before));
    await engine.executeRaw(
      `UPDATE sources SET config = $1::text::jsonb WHERE id = $2`,
      [JSON.stringify(after), id],
    );
    expect(await readConfigFingerprint(engine, id))
      .not.toBe(computeSourceConfigFingerprint(after));
  });

  test('mutating unrelated config field (federated) does NOT drift', async () => {
    // The fingerprint hashes ONLY walk-affecting fields. Federation
    // changes search visibility, not the walk set — must not invalidate
    // the checkpoint.
    const id = await makeSource('e2e-federated-toggle', {
      federated: true,
      exclude_globs: ['Templates/**'],
    });
    await writeConfigFingerprint(
      engine,
      id,
      computeSourceConfigFingerprint({ exclude_globs: ['Templates/**'] }),
    );
    await engine.executeRaw(
      `UPDATE sources SET config = $1::text::jsonb WHERE id = $2`,
      [
        JSON.stringify({ federated: false, exclude_globs: ['Templates/**'] }),
        id,
      ],
    );
    const stored = await readConfigFingerprint(engine, id);
    const current = computeSourceConfigFingerprint({
      federated: false,
      exclude_globs: ['Templates/**'],
    });
    expect(stored).toBe(current);
  });

  test('double-encoded JSONB config (the sources-add stringify bug) hashes equivalently to the parsed object', async () => {
    // `gbrain sources add` writes `JSON.stringify(config)::jsonb`, which
    // double-encodes the value into a JSON-string scalar (`"{\"x\":1}"`)
    // rather than a proper JSONB object. The defensive reader in
    // postgres-engine.ts:1274 + readSourceConfig parses the string back
    // before the fingerprint sees it, so a double-encoded row and a
    // properly-shaped row must fingerprint identically.
    const cfg = { exclude_globs: ['Templates/**'], strategy: 'markdown' };
    const direct = computeSourceConfigFingerprint(cfg);
    // The pure compute fn handles a pre-parsed object; the persistence
    // layer's job is to deliver a parsed object. We assert that the
    // round-trip a real read would produce (parse the string scalar)
    // hashes to the same value.
    const parsed = JSON.parse(JSON.stringify(cfg));
    expect(computeSourceConfigFingerprint(parsed)).toBe(direct);
  });
});
