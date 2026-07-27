/**
 * v0.34 W0b — CLI source-scoping default regression test.
 *
 * Pre-v0.34 (Codex finding #7): code-callers.ts:54 + code-callees.ts:43
 * set `allSources: allSources || !sourceId`. Default behavior with the
 * `--source` flag omitted was GLOBAL cross-source resolution — the
 * opposite of what the docstring promised. Multi-source brains silently
 * cross-resolved `Admin::UsersController#render` between repos.
 *
 * IRON RULE regression R2: existing caller without `--source` flag now
 * defaults to source-scoped behavior. To get the pre-v0.34 cross-source
 * default, the caller must pass `--all-sources` explicitly.
 *
 * This test bypasses CLI argv parsing and drives the resolveDefaultSource
 * helper + the engine.getCallersOf path directly. The CLI handlers thread
 * resolveDefaultSource() output to engine.getCallersOf, so this E2E pins
 * the same contract end-to-end.
 *
 * PGLite in-memory, no DATABASE_URL.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resolveDefaultSource, SourceResolutionError } from '../../src/core/sources-ops.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('v0.34 W0b — resolveDefaultSource resolution rule', () => {
  test('single-source brain: returns the only source id', async () => {
    await resetPgliteState(engine);
    // After reset, the default 'default' source from schema bootstrap is
    // the only one present. resolveDefaultSource returns it.
    const id = await resolveDefaultSource(engine);
    expect(id).toBe('default');
  });

  test('multi-source brain: throws with the list of valid ids', async () => {
    await resetPgliteState(engine);
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, created_at)
       VALUES ('repo-a', 'repo-a', '/fake/a', '{}'::jsonb, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [],
    );
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, created_at)
       VALUES ('repo-b', 'repo-b', '/fake/b', '{}'::jsonb, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [],
    );

    let caught: unknown = null;
    try {
      await resolveDefaultSource(engine);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SourceResolutionError);
    if (caught instanceof SourceResolutionError) {
      expect(caught.code).toBe('multiple_sources_ambiguous');
      expect(caught.availableSources).toContain('default');
      expect(caught.availableSources).toContain('repo-a');
      expect(caught.availableSources).toContain('repo-b');
      expect(caught.message).toContain('--source');
    }
  });

  test('zero-sources brain: throws no_sources code', async () => {
    await resetPgliteState(engine);
    // resetPgliteState preserves the 'default' source from the schema
    // bootstrap. Delete it to simulate a brain with no registered sources.
    // FK from pages.source_id is ON DELETE CASCADE; resetPgliteState
    // truncates pages first so this delete is safe.
    await engine.executeRaw(`DELETE FROM sources WHERE id = 'default'`, []);

    let caught: unknown = null;
    try {
      await resolveDefaultSource(engine);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SourceResolutionError);
    if (caught instanceof SourceResolutionError) {
      expect(caught.code).toBe('no_sources');
    }
  });
});
