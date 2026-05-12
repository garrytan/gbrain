/**
 * v0.32.2 — migration orchestrator tests.
 *
 * Covers phaseASchema (asserts v51 ran), phaseBFenceFacts (legacy
 * row → fence backfill happy path, idempotent re-run, dry-run, NULL
 * entity_slug skip, missing local_path skip), and phaseCVerify
 * (mismatch detection).
 *
 * Real PGLite + real tempdir filesystem. Engine injected via
 * __setTestEngineOverride so we don't need a configured brain.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { v0_32_2, __setTestEngineOverride, __testing } from '../src/commands/migrations/v0_32_2.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  __setTestEngineOverride(engine);
});

afterAll(async () => {
  __setTestEngineOverride(null);
  await engine.disconnect();
});

beforeEach(async () => {
  brainDir = mkdtempSync(join(tmpdir(), 'mig-v0_32_2-test-'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query('DELETE FROM facts');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query(
    `UPDATE sources SET local_path = $1 WHERE id = 'default'`,
    [brainDir],
  );
});

const OPTS = { yes: true, dryRun: false, noAutopilotInstall: true };
const DRY_OPTS = { ...OPTS, dryRun: true };

async function seedLegacyFact(input: {
  entity_slug: string | null;
  fact: string;
  source_id?: string;
  visibility?: 'private' | 'world';
  notability?: 'high' | 'medium' | 'low';
}): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await (engine as any).db.query(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                        valid_from, source, confidence)
     VALUES ($1, $2, $3, 'fact', $4, $5, now(), 'mcp:put_page', 1.0)
     RETURNING id`,
    [
      input.source_id ?? 'default',
      input.entity_slug,
      input.fact,
      input.visibility ?? 'private',
      input.notability ?? 'medium',
    ],
  );
  return r.rows[0].id;
}

function makeDirtyGitWorktree(dir: string): void {
  const init = Bun.spawnSync({
    cmd: ['git', 'init'],
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(init.exitCode).toBe(0);
  writeFileSync(join(dir, 'uncommitted.md'), 'dirty', 'utf-8');
}

describe('phaseASchema', () => {
  test('passes when schema is at v51', async () => {
    // initSchema ran v51, so the version config + columns are set.
    const r = await __testing.phaseASchema(engine, OPTS);
    expect(r.status).toBe('complete');
  });

  test('skipped under dry-run', async () => {
    const r = await __testing.phaseASchema(engine, DRY_OPTS);
    expect(r.status).toBe('skipped');
    expect(r.detail).toBe('dry-run');
  });

  test('skipped when no engine is available', async () => {
    const r = await __testing.phaseASchema(null, OPTS);
    expect(r.status).toBe('skipped');
    expect(r.detail).toBe('no_brain_configured');
  });
});

describe('isLocalPathDirty', () => {
  test('treats non-git source directories as untracked rather than dirty', () => {
    expect(__testing.isLocalPathDirty(brainDir)).toBe(false);
  });

  test('fails closed on unexpected git probe errors', () => {
    const notDirectory = join(brainDir, 'not-a-directory');
    writeFileSync(notDirectory, 'file, not directory', 'utf-8');

    expect(() => __testing.isLocalPathDirty(notDirectory)).toThrow();
  });
});

describe('phaseBFenceFacts — dry-run reporting', () => {
  test('reports counts without writing FS or updating DB', async () => {
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Founded Acme' });
    await seedLegacyFact({ entity_slug: 'people/bob', fact: 'Met at YC W22' });
    await seedLegacyFact({ entity_slug: null, fact: 'Unparented claim' });

    const r = await __testing.phaseBFenceFacts(engine, DRY_OPTS);
    expect(r.status).toBe('skipped');
    expect(r.detail).toContain('dry-run');
    expect(r.detail).toContain('would fence 2 rows');  // 3 total - 1 unparented
    expect(r.detail).toContain('1 unfenceable');

    // No files created.
    expect(existsSync(join(brainDir, 'people/alice.md'))).toBe(false);
    // DB rows still have NULL row_num.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      'SELECT row_num FROM facts WHERE entity_slug IS NOT NULL',
    );
    expect(rows.rows.every((r: { row_num: number | null }) => r.row_num === null)).toBe(true);
  });
});

describe('phaseBFenceFacts — happy path backfill', () => {
  test('fences legacy DB rows into entity pages + updates row_num', async () => {
    const id1 = await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Founded Acme in 2017' });
    const id2 = await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Prefers async over meetings' });

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('complete');
    expect(r.detail).toContain('fenced=2');
    expect(r.detail).toContain('pages=1');

    // Stub-page exists with fence content.
    const filePath = join(brainDir, 'people/alice.md');
    expect(existsSync(filePath)).toBe(true);
    const body = readFileSync(filePath, 'utf-8');
    expect(body).toContain('## Facts');
    expect(body).toContain('Founded Acme in 2017');
    expect(body).toContain('Prefers async over meetings');

    // DB rows now have row_num + source_markdown_slug populated.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      'SELECT id, row_num, source_markdown_slug FROM facts ORDER BY id',
    );
    expect(rows.rows[0]).toMatchObject({ id: id1, row_num: 1, source_markdown_slug: 'people/alice' });
    expect(rows.rows[1]).toMatchObject({ id: id2, row_num: 2, source_markdown_slug: 'people/alice' });
  });

  test('groups by entity page — multi-entity batch touches multiple files', async () => {
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'A1' });
    await seedLegacyFact({ entity_slug: 'companies/acme', fact: 'C1' });
    await seedLegacyFact({ entity_slug: 'deals/seed', fact: 'D1' });

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('complete');
    expect(r.detail).toContain('fenced=3');
    expect(r.detail).toContain('pages=3');

    expect(existsSync(join(brainDir, 'people/alice.md'))).toBe(true);
    expect(existsSync(join(brainDir, 'companies/acme.md'))).toBe(true);
    expect(existsSync(join(brainDir, 'deals/seed.md'))).toBe(true);
  });

  test('appends to existing entity page without overwriting body', async () => {
    mkdirSync(join(brainDir, 'people'), { recursive: true });
    writeFileSync(
      join(brainDir, 'people/alice.md'),
      '---\ntype: person\ntitle: Alice\nslug: people/alice\n---\n\n# Alice\n\nNotes about Alice.\n',
      'utf-8',
    );
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Founded Acme' });

    await __testing.phaseBFenceFacts(engine, OPTS);

    const body = readFileSync(join(brainDir, 'people/alice.md'), 'utf-8');
    expect(body).toContain('Notes about Alice.');  // preserved
    expect(body).toContain('## Facts');
    expect(body).toContain('Founded Acme');
  });

  test('idempotent: re-running after partial completion does NOT duplicate rows', async () => {
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'First' });
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Second' });

    await __testing.phaseBFenceFacts(engine, OPTS);

    // Manually clear one row's row_num to simulate a partial state.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `UPDATE facts SET row_num = NULL, source_markdown_slug = NULL
       WHERE fact = 'Second'`,
    );

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('complete');

    // The re-run should reuse the existing row_num=2 (matched by claim
    // content) rather than appending a new row_num=3.
    const body = readFileSync(join(brainDir, 'people/alice.md'), 'utf-8');
    const parsed = parseFactsFence(body);
    expect(parsed.facts).toHaveLength(2);
    expect(parsed.facts.map(f => f.claim).sort()).toEqual(['First', 'Second']);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      'SELECT row_num FROM facts WHERE row_num IS NOT NULL ORDER BY row_num',
    );
    expect(rows.rows.map((r: { row_num: number }) => r.row_num)).toEqual([1, 2]);
  });

  test('skips facts with NULL entity_slug (unfenceable)', async () => {
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Fenceable' });
    await seedLegacyFact({ entity_slug: null, fact: 'Unfenceable' });

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('complete');
    expect(r.detail).toContain('fenced=1');
    expect(r.detail).toContain('skipped_no_entity=1');

    // The unparented fact's row_num remains NULL.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT entity_slug, row_num FROM facts ORDER BY id`,
    );
    expect(rows.rows[0]).toMatchObject({ entity_slug: 'people/alice', row_num: 1 });
    expect(rows.rows[1]).toMatchObject({ entity_slug: null, row_num: null });
  });

  test('skips when source has no local_path', async () => {
    // Wipe default source's local_path.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Whatever' });

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('complete');
    expect(r.detail).toContain('skipped_no_local_path=1');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query('SELECT row_num FROM facts');
    expect(rows.rows[0].row_num).toBeNull();
  });

  test('does not refuse a dirty source when there are no legacy facts to write', async () => {
    makeDirtyGitWorktree(brainDir);

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('complete');
    expect(r.detail).toContain('scanned=0');
    expect(r.detail).toContain('fenced=0');
  });

  test('does not refuse a dirty source when all legacy facts are structurally unfenceable', async () => {
    makeDirtyGitWorktree(brainDir);
    await seedLegacyFact({ entity_slug: null, fact: 'Unparented claim' });

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('complete');
    expect(r.detail).toContain('skipped_no_entity=1');
    expect(r.detail).toContain('fenced=0');
  });

  test('does not refuse a dirty source that has no fenceable writes in this migration', async () => {
    const unusedDir = mkdtempSync(join(tmpdir(), 'mig-v0_32_2-unused-source-'));
    try {
      makeDirtyGitWorktree(unusedDir);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (engine as any).db.query(
        `INSERT INTO sources (id, name, local_path, config)
         VALUES ('unused-dirty', 'unused-dirty', $1, '{}'::jsonb)
         ON CONFLICT (id) DO UPDATE SET local_path = excluded.local_path`,
        [unusedDir],
      );
      await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Default source write only' });

      const r = await __testing.phaseBFenceFacts(engine, OPTS);
      expect(r.status).toBe('complete');
      expect(r.detail).toContain('fenced=1');
      expect(existsSync(join(brainDir, 'people/alice.md'))).toBe(true);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (engine as any).db.query(`DELETE FROM sources WHERE id = 'unused-dirty'`);
      rmSync(unusedDir, { recursive: true, force: true });
    }
  });

  test('still refuses a dirty source before writing fenceable facts', async () => {
    makeDirtyGitWorktree(brainDir);
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Needs a fenced write' });

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('failed');
    expect(r.detail).toContain('source "default" has uncommitted changes');
    expect(existsSync(join(brainDir, 'people/alice.md'))).toBe(false);
  });
});

describe('phaseCVerify', () => {
  test('returns complete when fence + DB row counts match', async () => {
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'F1' });
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'F2' });
    await __testing.phaseBFenceFacts(engine, OPTS);

    const r = await __testing.phaseCVerify(engine, OPTS);
    expect(r.status).toBe('complete');
    expect(r.detail).toContain('pages_checked=1');
  });

  test('returns failed when fence row count drifts from DB', async () => {
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'F1' });
    await __testing.phaseBFenceFacts(engine, OPTS);

    // Corrupt the fence: append a row manually that's not in the DB.
    const path = join(brainDir, 'people/alice.md');
    const body = readFileSync(path, 'utf-8');
    const corrupted = body.replace(
      '<!--- gbrain:facts:end -->',
      '| 99 | extra row | fact | 1.0 | world | medium | 2026-01-01 |  | manual |  |\n<!--- gbrain:facts:end -->',
    );
    writeFileSync(path, corrupted, 'utf-8');

    const r = await __testing.phaseCVerify(engine, OPTS);
    expect(r.status).toBe('failed');
    expect(r.detail).toContain('drifted');
    expect(r.detail).toContain('people/alice');
  });
});

describe('orchestrator end-to-end', () => {
  test('clean run returns status:complete with 3 phases', async () => {
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Founded Acme' });

    const result = await v0_32_2.orchestrator(OPTS);
    expect(result.version).toBe('0.32.2');
    expect(result.status).toBe('complete');
    expect(result.phases.map(p => p.name)).toEqual(['schema', 'fence_facts', 'verify']);
    expect(result.phases.every(p => p.status === 'complete')).toBe(true);
  });

  test('dry-run returns 3 phases all skipped (no FS or DB changes)', async () => {
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Should not get fenced' });

    const result = await v0_32_2.orchestrator(DRY_OPTS);
    expect(result.status).toBe('complete');
    expect(result.phases.every(p => p.status === 'skipped')).toBe(true);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query('SELECT row_num FROM facts');
    expect(rows.rows[0].row_num).toBeNull();
    expect(existsSync(join(brainDir, 'people/alice.md'))).toBe(false);
  });
});

afterAll(() => {
  try {
    if (brainDir) rmSync(brainDir, { recursive: true, force: true });
  } catch { /* best-effort */ }
});
