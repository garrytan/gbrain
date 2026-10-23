/**
 * The saved-fact match beside search/query blocks (ops/search.ts
 * matchingSavedFacts) gates its LIKE scan on an uncorrelated EXISTS probe so
 * a brain with no qualifying fact skips the scan. The probe must read the
 * facts table alone: with the page-eligibility filters inside it (private
 * provenance, quarantine, needs-rederive), Postgres planned it as merge anti
 * joins against the pages index, which read every page on every search once
 * a brain held many facts, so the probe's cost grew with the page count.
 * The filters stay on the scan, so the returned facts are unchanged: a
 * private-sourced or quarantined fact is still left out. PGLite, keyword-only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { newSource, page, putPage } from '../helpers/pinned-questions-fixture.ts';

let engine: PGLiteEngine;
let sourceId: string;
const statements: string[] = [];
const Q = 'harbor ferry timetable';
const search = operations.find(o => o.name === 'search')!;

async function savedFacts(remote: boolean): Promise<string[]> {
  let meta: Record<string, any> | null = null;
  const ctx = {
    engine, config: { engine: engine.kind } as never, logger: { info() {}, warn() {}, error() {} } as never, dryRun: false, remote, sourceId,
    emitResponseMeta: (key: string, value: unknown) => { if (key === 'retrieval') meta = value as Record<string, any>; },
  } as OperationContext;
  await search.handler(ctx, { query: Q, source_id: sourceId });
  return ((meta as Record<string, any> | null)?.saved_facts ?? []).map((f: { fact: string }) => f.fact).sort();
}

/** The EXISTS probe of the saved-fact statement the last search ran. */
function probeOf(sql: string): string {
  const at = sql.indexOf('AND EXISTS (SELECT 1 FROM facts f WHERE');
  expect(at).toBeGreaterThan(-1);
  return sql.slice(at, sql.indexOf('LIMIT 1)', at));
}

beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  sourceId = await newSource(engine);
  await putPage(engine, sourceId, 'notes/harbor-public', page('note', 'Harbor public', 'Public notes on the harbor ferry timetable.'));
  await putPage(engine, sourceId, 'notes/harbor-private', page('note', 'Harbor private', 'Private notes on the harbor ferry.', 'visibility: private\n'));
  await putPage(engine, sourceId, 'notes/harbor-held', page('note', 'Harbor held', 'Held notes on the harbor ferry.'));
  await engine.executeRaw(`UPDATE pages SET frontmatter = COALESCE(frontmatter, '{}'::jsonb) || '{"quarantine": {"reason": "test"}}'::jsonb WHERE source_id = $1 AND slug = 'notes/harbor-held'`, [sourceId]);
  const add = (fact: string, day: string) =>
    engine.insertFact({ fact, kind: 'fact', entity_slug: 'harbor', source: 'notes', visibility: 'world', valid_from: new Date(`2025-07-${day}T00:00:00Z`) }, { source_id: sourceId });
  await add('The harbor ferry timetable changes in May.', '12');
  await add('The harbor ferry timetable moves to the private schedule.', '13');
  await add('The harbor ferry timetable is under review.', '14');
  await engine.executeRaw(`UPDATE facts SET source_markdown_slug = CASE
      WHEN fact LIKE '%private%' THEN 'notes/harbor-private' WHEN fact LIKE '%review%' THEN 'notes/harbor-held' ELSE 'notes/harbor-public' END
    WHERE source_id = $1`, [sourceId]);
  // Unbound and called with the caller's `this`: a transaction-scoped view of the engine must keep its own executor.
  const run = engine.executeRaw;
  engine.executeRaw = function (this: PGLiteEngine, ...args: Parameters<typeof run>) {
    if (args[0].includes('LIKE ANY($3::text[])') && args[0].includes('FROM facts f')) statements.push(args[0]);
    return run.apply(this, args);
  } as typeof engine.executeRaw;
}, 120_000);

afterAll(async () => { resetGateway(); await engine?.disconnect(); }, 60_000);

describe('saved-fact match probe', () => {
  test('the probe reads only the facts table; the scan keeps the page-eligibility filters', async () => {
    statements.length = 0;
    await savedFacts(true);
    expect(statements).toHaveLength(1);
    const probe = probeOf(statements[0]!);
    expect(probe).not.toMatch(/\bpages\b/);
    expect(probe).not.toContain('needs_rederive');
    expect(probe).toContain("f.visibility = 'world'");
    const scan = statements[0]!.slice(0, statements[0]!.indexOf('AND EXISTS (SELECT 1 FROM facts f WHERE'));
    expect(scan).toContain('FROM pages pp');
    expect(scan).toContain('needs_rederive');
  });

  test('a remote caller still gets only the fact whose provenance page it may read', async () => {
    expect(await savedFacts(true)).toEqual(['The harbor ferry timetable changes in May.']);
  });

  test('a local caller sees the private-sourced fact; the quarantined page still hides its fact', async () => {
    expect(await savedFacts(false)).toEqual(['The harbor ferry timetable changes in May.', 'The harbor ferry timetable moves to the private schedule.']);
  });

  test('when only ineligible facts exist, the match is empty', async () => {
    await engine.executeRaw(`UPDATE facts SET expired_at = now() WHERE source_id = $1 AND source_markdown_slug = 'notes/harbor-public'`, [sourceId]);
    try {
      expect(await savedFacts(true)).toEqual([]);
    } finally {
      await engine.executeRaw(`UPDATE facts SET expired_at = NULL WHERE source_id = $1`, [sourceId]);
    }
  });
});
