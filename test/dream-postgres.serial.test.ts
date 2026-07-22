/**
 * v0.41.30.0 — `gbrain dream` runs against a checkout-less (postgres-shaped)
 * brain (BUG 2).
 *
 * Pre-fix dream.ts:resolveBrainDir process.exit(1)'d with "No brain directory
 * found" when neither --dir nor an on-disk sync.repo_path existed — so the
 * DB-only maintenance phases (notably resolve_symbol_edges, the call-graph
 * builder) could never run on a Supabase brain. Now brainDir can be null: the
 * 6 filesystem phases skip with reason `no_brain_dir` and the DB phases run.
 *
 * Covers: the null-brainDir path, A1 (the --source per-source scope fix),
 * A7 (deriveStatus reports `ok` not `clean` when edges resolve), and the
 * both-null hard error. PGLite in-memory (the bug branches on
 * `brainDir === null`, not engine.kind, so PGLite is a faithful proxy).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runDream } from '../src/commands/dream.ts';
import { runCycle } from '../src/core/cycle.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function phase(report: any, name: string) {
  return report.phases.find((p: any) => p.phase === name);
}

// ─── BUG 2: no checkout → DB phases run, FS phases skip ──────────────

describe('runDream — checkout-less brain (no --dir, no sync.repo_path)', () => {
  test('full --dry-run returns a report with brain_dir null (no "No brain directory found" exit)', async () => {
    const report = await runDream(engine, ['--dry-run', '--json']);
    expect(report).toBeTruthy();
    if (!report) return;
    expect(report.brain_dir).toBeNull();
    // A filesystem phase is present and skipped with the no_brain_dir reason.
    const lint = phase(report, 'lint');
    expect(lint?.status).toBe('skipped');
    expect(lint?.details?.reason).toBe('no_brain_dir');
    // A DB-only phase ran (not a no_brain_dir skip).
    const orphans = phase(report, 'orphans');
    expect(orphans).toBeTruthy();
    expect(orphans?.details?.reason).not.toBe('no_brain_dir');
  });

  test('--phase resolve_symbol_edges runs on a checkout-less brain (the call-graph phase)', async () => {
    const report = await runDream(engine, ['--phase', 'resolve_symbol_edges', '--json']);
    expect(report).toBeTruthy();
    if (!report) return;
    expect(report.brain_dir).toBeNull();
    const rse = phase(report, 'resolve_symbol_edges');
    expect(rse).toBeTruthy();
    // It RAN — not skipped for no_brain_dir / no_database, not failed.
    expect(rse?.status).not.toBe('fail');
    expect(rse?.details?.reason).not.toBe('no_brain_dir');
    expect(rse?.details?.reason).not.toBe('no_database');
  });

  test('--phase lint skips with no_brain_dir (does not exit 1)', async () => {
    const report = await runDream(engine, ['--phase', 'lint', '--json']);
    expect(report).toBeTruthy();
    if (!report) return;
    const lint = phase(report, 'lint');
    expect(lint?.status).toBe('skipped');
    expect(lint?.details?.reason).toBe('no_brain_dir');
  });

  test('--source <id> --dry-run on a checkout-less brain succeeds (the command doctor recommends)', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, created_at)
       VALUES ('repo-a', 'repo-a', NULL, '{}'::jsonb, NOW()) ON CONFLICT (id) DO NOTHING`,
      [],
    );
    const report = await runDream(engine, ['--source', 'repo-a', '--dry-run', '--json']);
    expect(report).toBeTruthy();
    if (!report) return;
    expect(report.brain_dir).toBeNull();
    expect(report.status).not.toBe('failed');
  });
});

// ─── A1: --source scopes per-source DB phases correctly on null brainDir ──

describe('runDream — A1 per-source scope (no checkout)', () => {
  test('dream --source repo-a --phase extract_facts reconciles facts for repo-a, not default', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, created_at)
       VALUES ('repo-a', 'repo-a', '/fake/repo-a', '{}'::jsonb, NOW()) ON CONFLICT (id) DO NOTHING`,
      [],
    );
    // A page that exists ONLY under repo-a, carrying a Facts fence. With the
    // pre-fix bug, brainDir===null → resolveSourceForDir(null)→undefined →
    // xfSourceId='default' → getPage('people/bob',{sourceId:'default'}) → null →
    // 0 facts. The fix makes cycleSourceId = opts.sourceId = 'repo-a'.
    const fence =
      `# Bob\n\nBody.\n\n## Facts\n\n` +
      `<!--- gbrain:facts:begin -->\n` +
      `| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n` +
      `|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n` +
      `| 1 | Founded Acme | fact | 1.0 | world | high | 2017-01-01 |  | linkedin |  |\n` +
      `<!--- gbrain:facts:end -->\n`;
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, title, type, page_kind, compiled_truth, timeline, frontmatter, updated_at, created_at)
       VALUES ('people/bob', 'repo-a', 'Bob', 'person', 'markdown', $1, '', '{}'::jsonb, NOW(), NOW())`,
      [fence],
    );

    const report = await runDream(engine, ['--source', 'repo-a', '--phase', 'extract_facts', '--json']);
    expect(report).toBeTruthy();
    if (!report) return;
    expect(report.brain_dir).toBeNull();

    const rows = await engine.executeRaw<{ source_id: string; fact: string }>(
      `SELECT source_id, fact FROM facts WHERE source_markdown_slug = 'people/bob'`,
      [],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source_id).toBe('repo-a'); // NOT 'default' (the A1 bug)
    expect(rows[0].fact).toBe('Founded Acme');
  });

  test('--source repo-a (no checkout) does NOT borrow the global sync.repo_path of a different source', async () => {
    // codex P1 regression: with --source set but that source having no on-disk
    // checkout, resolveBrainDir must return null (DB-only) and NOT fall through
    // to the global sync.repo_path — otherwise FS phases run against the default
    // brain's checkout while DB phases + the freshness stamp target repo-a.
    const globalRepo = mkdtempSync(join(tmpdir(), 'gbrain-global-repo-'));
    try {
      await engine.setConfig('sync.repo_path', globalRepo); // exists on disk
      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path, config, created_at)
         VALUES ('repo-a', 'repo-a', NULL, '{}'::jsonb, NOW()) ON CONFLICT (id) DO NOTHING`,
        [],
      );
      const report = await runDream(engine, ['--source', 'repo-a', '--phase', 'lint', '--json']);
      expect(report).toBeTruthy();
      if (!report) return;
      // brain_dir must be null — NOT the globalRepo path.
      expect(report.brain_dir).toBeNull();
      const lint = report.phases.find((p: any) => p.phase === 'lint');
      expect(lint?.status).toBe('skipped');
      expect(lint?.details?.reason).toBe('no_brain_dir');
    } finally {
      rmSync(globalRepo, { recursive: true, force: true });
    }
  });
});

// ─── A7: edges-only cycle reports ok, not clean ─────────────────────

describe('runCycle — A7 deriveStatus counts resolved edges as work', () => {
  test('an edges-only cycle that resolves an edge reports status ok (not clean)', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, created_at)
       VALUES ('src-a', 'src-a', '/fake/src-a', '{}'::jsonb, NOW()) ON CONFLICT (id) DO NOTHING`,
      [],
    );
    const pageRows = await engine.executeRaw<{ id: number }>(
      `INSERT INTO pages (slug, source_id, title, type, page_kind, compiled_truth, frontmatter, updated_at, created_at)
       VALUES ('src/foo.ts', 'src-a', 'src/foo.ts', 'code', 'code', '', '{}'::jsonb, NOW(), NOW())
       RETURNING id`,
      [],
    );
    const pageId = pageRows[0]!.id;
    const caller = await engine.executeRaw<{ id: number }>(
      `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, language, symbol_name_qualified, symbol_type)
       VALUES ($1, 0, '// caller', 'compiled_truth', 'typescript', 'callerA', 'function') RETURNING id`,
      [pageId],
    );
    await engine.executeRaw(
      `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, language, symbol_name_qualified, symbol_type)
       VALUES ($1, 1, '// def', 'compiled_truth', 'typescript', 'targetFn', 'function')`,
      [pageId],
    );
    await engine.executeRaw(
      `INSERT INTO code_edges_symbol (from_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, source_id, edge_metadata)
       VALUES ($1, 'callerA', 'targetFn', 'calls', 'src-a', '{}'::jsonb)`,
      [caller[0]!.id],
    );

    const report = await runCycle(engine, { brainDir: null, phases: ['resolve_symbol_edges'] });
    expect(report.totals.edges_resolved).toBe(1);
    expect(report.status).toBe('ok'); // pre-A7 this was 'clean'
  });
});

// ─── both-null hard error preserved ─────────────────────────────────

describe('runDream — both-null (no engine, no dir) still exits 1', () => {
  test('runDream(null, []) exits 1', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => { throw new Error('EXIT'); }) as never);
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    let threw = '';
    try {
      await runDream(null, []);
    } catch (e) {
      threw = (e as Error).message;
    }
    // Assert BEFORE mockRestore — bun's mockRestore clears recorded calls.
    expect(threw).toBe('EXIT');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  test("runDream(null, ['--phase','orphans']) exits 1", async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => { throw new Error('EXIT'); }) as never);
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    let threw = '';
    try {
      await runDream(null, ['--phase', 'orphans']);
    } catch (e) {
      threw = (e as Error).message;
    }
    expect(threw).toBe('EXIT');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});
