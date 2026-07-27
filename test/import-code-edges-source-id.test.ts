/**
 * Regression — importCodeFile stamps source_id on extracted call-graph edges.
 *
 * Pre-fix bug: importCodeFile built CodeEdgeInput rows WITHOUT source_id, so
 * every extracted edge landed NULL in code_edges_symbol. getCallersOf /
 * getCalleesOf add `AND source_id = <scoped>` whenever a worktree pin or
 * --source is in play — NULL never matches that filter, so scoped call-graph
 * queries silently returned 0 rows on multi-source brains even though the
 * edges existed. Pre-existing coverage (cathedral-ii-brainbench.test.ts,
 * code-edges.test.ts) only ever queried with { allSources: true }, which
 * bypasses the filter — exactly why the NULL never surfaced.
 *
 * This test imports a caller/callee pair under a non-default source and
 * asserts (a) the persisted code_edges_symbol rows carry the source_id, and
 * (b) the SCOPED getCallersOf/getCalleesOf — the user-visible path that
 * returned 0 — now find the edge, while a different source scope does not.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importCodeFile } from '../src/core/import-file.ts';
import { runSources } from '../src/commands/sources.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await runSources(engine, ['add', 'testsrc', '--no-federated']);

  // Same fixture shape as cathedral-ii-brainbench: runner() calls helper(),
  // Layer 5 edge extraction captures the unresolved 'calls' edge — but here
  // the import is pinned to a non-default source.
  await importCodeFile(
    engine,
    'src/a.ts',
    'export function runner() { return helper(); }\n',
    { noEmbed: true, sourceId: 'testsrc' },
  );
  await importCodeFile(
    engine,
    'src/b.ts',
    'export function helper() { return 42; }\n',
    { noEmbed: true, sourceId: 'testsrc' },
  );
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 30_000);

describe('importCodeFile — source_id stamped on extracted call-graph edges', () => {
  test('edges land with the import source_id and scoped caller/callee queries match', async () => {
    // (a) The persisted unresolved edge rows carry the source, not NULL.
    const rows = await engine.executeRaw<{ source_id: string | null }>(
      `SELECT source_id FROM code_edges_symbol WHERE from_symbol_qualified = $1`,
      ['runner'],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const r of rows) {
      expect(r.source_id).toBe('testsrc');
    }

    // (b) The scoped queries — the path that silently returned 0 pre-fix.
    const callers = await engine.getCallersOf('helper', { sourceId: 'testsrc' });
    const fromRunner = callers.find(r => r.from_symbol_qualified === 'runner');
    expect(fromRunner).toBeDefined();
    expect(fromRunner!.edge_type).toBe('calls');
    expect(fromRunner!.source_id).toBe('testsrc');

    const callees = await engine.getCalleesOf('runner', { sourceId: 'testsrc' });
    expect(callees.some(r => r.to_symbol_qualified === 'helper')).toBe(true);

    // Source isolation still holds: a different scope must NOT see the edge.
    const otherScope = await engine.getCallersOf('helper', { sourceId: 'default' });
    expect(otherScope.find(r => r.from_symbol_qualified === 'runner')).toBeUndefined();
  });

  test('UNSCOPED import stamps edges with the schema-default source, not NULL', async () => {
    // The other door of the same bug: an import WITHOUT opts.sourceId (legacy
    // unscoped callers — `gbrain reindex --code` with no --source) lands its
    // pages under the schema default (pages.source_id DEFAULT 'default').
    // If its edges were stamped NULL, the matching scoped query
    // getCallersOf(sym, { sourceId: 'default' }) — a worktree pinned to
    // default, --source default, GBRAIN_SOURCE=default — would miss them.
    await importCodeFile(
      engine,
      'src/c.ts',
      'export function unscopedRunner() { return unscopedHelper(); }\n',
      { noEmbed: true },
    );
    await importCodeFile(
      engine,
      'src/d.ts',
      'export function unscopedHelper() { return 7; }\n',
      { noEmbed: true },
    );

    const rows = await engine.executeRaw<{ source_id: string | null }>(
      `SELECT source_id FROM code_edges_symbol WHERE from_symbol_qualified = $1`,
      ['unscopedRunner'],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const r of rows) {
      expect(r.source_id).toBe('default');
    }

    const callers = await engine.getCallersOf('unscopedHelper', { sourceId: 'default' });
    expect(callers.some(r => r.from_symbol_qualified === 'unscopedRunner')).toBe(true);
  });
});
