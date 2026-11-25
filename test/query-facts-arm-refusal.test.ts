/**
 * The query facts arm names a fact's entity page through the typed member every engine serves, and a refused read of it
 * surfaces (src/core/search/facts-arm.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a fact row of `query` carries `page_slug` when the caller may read the fact's entity page, read through
 *    `readAdmittedPageRefs`; when the engine refuses that read (engine_capability_missing), `query` answers the refusal,
 *    never fact rows quietly stripped of their page.
 *  - Regression: the arm read the entity pages with raw SQL and caught every failure as "no readable page", so on a
 *    Rust brain every fact row lost its `page_slug` and nothing said why
 *    (test/engine-parity/remote-access-matrix.test.ts).
 *  - Why existing coverage misses it: no test refuses the read; the parity matrix shows the missing slug, not the swallow.
 *  - Seam: the refusal is injected at the typed member the arm calls (readAdmittedPageRefs), never at statement text.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { drainProjections } from '../src/core/page-state/projections.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';

const PAGE = 'notes/harbor-example';
const QUERY = 'harbor ledger planning notes';
let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await importFromContent(engine, PAGE, `---\ntitle: Harbor\ntype: note\n---\nHarbor ledger page body.\n`, { sourceId: 'default', noEmbed: true } as never);
  const out = await dispatchToolCall(engine, 'remember', { fact: `Harbor ledger planning notes cnryqueryfactzz`, provenance: 'fixture', entity: PAGE, visibility: 'world' }, { remote: false, sourceId: 'default' });
  if (out.isError) throw new Error(out.content.map(c => c.text).join(' '));
  await drainProjections(engine);
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

function refusing(base: BrainEngine, member: string): BrainEngine {
  return new Proxy(base, {
    get(target, key, receiver) {
      if (key === member) return async () => { throw capabilityMissing('pages', member); };
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const query = (e: BrainEngine) => dispatchToolCall(e, 'query', { query: QUERY, expand: false, fields: 'full', limit: 20 }, { remote: false, transport: 'stdio', sourceId: 'default' });

describe('query facts arm and the entity page read', () => {
  test('a fact row names its readable entity page', async () => {
    const out = await query(engine);
    expect(out.isError).not.toBe(true);
    const text = out.content.map(c => c.text).join('\n');
    expect(text).toContain('cnryqueryfactzz');
    expect(text).toContain(`"page_slug":"${PAGE}"`);
  });

  test('the entity page read takes only page-read fields, never the search knobs of the arm', async () => {
    const seen: unknown[] = [];
    const spy = new Proxy(engine as BrainEngine, {
      get(target, key, receiver) {
        if (key === 'readAdmittedPageRefs') return async (refs: unknown, scope: unknown) => { seen.push(scope); return (target as BrainEngine).readAdmittedPageRefs(refs as never, scope as never); };
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const out = await query(spy);
    expect(out.isError).not.toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    for (const scope of seen) expect(Object.keys(scope as object).every(k => ['sourceId', 'sourceIds', 'excludePrivate', 'minTrust', 'suppressFlagged'].includes(k))).toBe(true);
  });

  test('a refused entity page read surfaces as the refusal, not as fact rows without their page', async () => {
    const out = await query(refusing(engine, 'readAdmittedPageRefs'));
    expect(out.isError).toBe(true);
    const text = out.content.map(c => c.text).join('\n');
    expect(text).toContain('engine_capability_missing');
    expect(text).toContain('readAdmittedPageRefs');
  });
});
