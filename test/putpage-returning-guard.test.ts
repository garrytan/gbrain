// #2189 regression guard: putPage's INSERT … ON CONFLICT DO UPDATE … RETURNING
// can yield 0 rows when brain-local DB state (e.g. a BEFORE INSERT trigger)
// suppresses the write. Pre-fix, rowToPage(rows[0]) crashed with the opaque
// "undefined is not an object (evaluating 'row.deleted_at')" that failed
// ~all files of a code sync. Post-fix, putPage throws a descriptive error
// naming the slug + source_id so the failure is diagnosable per-file.
//
// Same guard lands in postgres-engine.ts (engine-parity invariant); this test
// exercises the PGLite side, where the issue was reported.

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Simulate the reporter's state-dependent failure: a trigger that
  // suppresses inserts for one slug, making RETURNING produce no row.
  await engine.executeRaw(`
    CREATE OR REPLACE FUNCTION suppress_pages_insert() RETURNS trigger AS $$
    BEGIN
      IF NEW.slug = 'suppressed-page' THEN RETURN NULL; END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await engine.executeRaw(`
    CREATE TRIGGER suppress_pages_insert_trg
    BEFORE INSERT ON pages
    FOR EACH ROW EXECUTE FUNCTION suppress_pages_insert();
  `);
});

afterAll(async () => {
  await engine.executeRaw('DROP TRIGGER IF EXISTS suppress_pages_insert_trg ON pages');
  await engine.executeRaw('DROP FUNCTION IF EXISTS suppress_pages_insert');
  await engine.disconnect();
});

describe('putPage RETURNING guard (#2189)', () => {
  test('0-row RETURNING throws a descriptive error, not row.deleted_at TypeError', async () => {
    let err: Error | undefined;
    try {
      await engine.putPage('suppressed-page', {
        type: 'code',
        title: 'Suppressed',
        compiled_truth: 'x',
        timeline: '',
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain('putPage');
    expect(err!.message).toContain("slug='suppressed-page'");
    expect(err!.message).toContain("source_id='default'");
    // The pre-fix crash signature must be gone.
    expect(err!.message).not.toContain('deleted_at');
  });

  test('unsuppressed slugs still upsert normally with the trigger installed', async () => {
    const page = await engine.putPage('normal-page', {
      type: 'concept',
      title: 'Normal',
      compiled_truth: 'y',
      timeline: '',
    });
    expect(page.slug).toBe('normal-page');
    expect(page.source_id).toBe('default');
  });
});
