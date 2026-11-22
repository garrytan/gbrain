/**
 * `entity`: a failed page-lookup read is never a confident miss.
 *
 * Drives the real verb (buildEntityCard, and the MCP path through dispatchToolCall) on a PGLite brain whose lookup read
 * throws. Before the fix the arm-2 / alias / hydrate reads each ended in a bare `catch`, so the call answered
 * `found:false` with nothing marking it partial and an agent told the user the entity does not exist. Now the answer
 * carries the typed degraded stage `entity_lookup_failed` (the shape search uses): `_meta.degraded` plus the
 * `[gbrain degraded: ...]` text block on MCP. The Rust engine's typed capability refusal still ends the call.
 * Synthetic names only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { buildEntityCard } from '../src/core/verbs/entity-card.ts';
import { lookupEntityNames } from '../src/core/verbs/entity-names.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { DEGRADED_STAMP_PREFIX } from '../src/core/degraded-stamp.ts';
import { NoticeLedger } from '../src/core/notice-ledger.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { entityLookupFault, FAULT_MESSAGE } from './helpers/entity-lookup-fault.ts';

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
  await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Alice Example runs operations at Acme Example.', timeline: '' });
  await engine.putPage('companies/acme-example', { type: 'company', title: 'Acme Example', compiled_truth: 'Acme Example builds widgets.', timeline: '' });
});

// Exact names only: the name-variant arm reads `pages` through its own query and would still find "Alice Example" by
// title when arm 2 is down. That hit carries the degraded marker too (see the variants case below).
const card = (e: BrainEngine, name: string, variants = false) =>
  buildEntityCard(e, 'default', name, { remote: false, includeReferences: true, variants });

type Out = { content: Array<{ type: string; text: string }>; _meta?: Record<string, unknown>; isError?: boolean };
const mcp = async (e: BrainEngine, params: Record<string, unknown>) =>
  await dispatchToolCall(e, 'entity', params, { remote: true, transport: 'stdio', sourceId: 'default', noticeLedger: new NoticeLedger() } as never) as Out;
const stampOf = (out: Out) => (out._meta?.degraded as { reasons: string[] } | undefined)?.reasons;

describe('arm 2 (exact title / slug) read fails', () => {
  test('the card verb reports entity_lookup_failed beside the miss', async () => {
    const res = await card(entityLookupFault(engine, { arm2: () => new Error(FAULT_MESSAGE) }), 'Alice Example');
    expect(res.found).toBe(false);
    expect(res.degraded).toEqual([{ stage: 'entity_lookup_failed', reason: 'provider_error' }]);
  });

  test('a statement timeout is reason timeout', async () => {
    const res = await card(entityLookupFault(engine, { arm2: () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }) }), 'people/alice-example');
    expect(res.found).toBe(false);
    expect(res.degraded).toEqual([{ stage: 'entity_lookup_failed', reason: 'timeout' }]);
  });

  test('a name-variant hit found while arm 2 is down still carries the marker', async () => {
    const res = await card(entityLookupFault(engine, { arm2: () => new Error(FAULT_MESSAGE) }), 'Alice Example', true);
    expect(res.found).toBe(true);
    expect(res.card?.match?.kind).toBeDefined();
    expect(res.degraded).toEqual([{ stage: 'entity_lookup_failed', reason: 'provider_error' }]);
  });

  test('MCP: found:false body, marked degraded, no raw error text on the wire', async () => {
    const out = await mcp(entityLookupFault(engine, { arm2: () => new Error(FAULT_MESSAGE) }), { name: 'people/alice-example' });
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content[0]!.text).found).toBe(false);
    expect(stampOf(out)).toContain('entity_lookup_failed');
    expect((out._meta?.retrieval as { degraded: unknown }).degraded).toEqual([{ stage: 'entity_lookup_failed', reason: 'provider_error' }]);
    const blocks = out.content.filter(c => c.text.startsWith(DEGRADED_STAMP_PREFIX));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toContain('entity_lookup_failed');
    expect(blocks[0]!.text).toContain('never report "no notes" or "not found"');
    expect(JSON.stringify(out)).not.toContain(FAULT_MESSAGE);
  });

  test('MCP names batch: the rows stay found:false and the call is marked degraded', async () => {
    const out = await mcp(entityLookupFault(engine, { arm2: () => new Error(FAULT_MESSAGE) }), { names: ['Alice Example', 'Acme Example'], variants: false });
    expect(out.isError).toBeFalsy();
    const body = JSON.parse(out.content[0]!.text);
    expect(body.results.map((r: { found: boolean }) => r.found)).toEqual([false, false]);
    expect(body.degraded).toBeUndefined();
    expect(stampOf(out)).toContain('entity_lookup_failed');
  });

  test('lookupEntityNames hands the stage to its caller', async () => {
    const out = await lookupEntityNames(entityLookupFault(engine, { arm2: () => new Error(FAULT_MESSAGE) }), 'default', ['Alice Example'], { remote: false, variants: false });
    expect(out.found).toBe(0);
    expect(out.degraded).toEqual([{ stage: 'entity_lookup_failed', reason: 'provider_error' }]);
  });
});

describe('the name-variant arm read fails', () => {
  // "Alice Exampel" matches no page by alias, title or slug; only the variant arm (a one-letter surname typo) finds Alice Example.
  test('variants on, the precision arms miss, the variant read throws: found:false carries the marker', async () => {
    const res = await card(entityLookupFault(engine, { variants: () => new Error(FAULT_MESSAGE) }), 'Alice Exampel', true);
    expect(res.found).toBe(false);
    expect(res.degraded).toEqual([{ stage: 'entity_lookup_failed', reason: 'provider_error' }]);
  });

  test('a variant read statement timeout is reason timeout', async () => {
    const res = await card(entityLookupFault(engine, { variants: () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }) }), 'Alice Exampel', true);
    expect(res.degraded).toEqual([{ stage: 'entity_lookup_failed', reason: 'timeout' }]);
  });

  test('MCP: the miss is marked degraded', async () => {
    const out = await mcp(entityLookupFault(engine, { variants: () => new Error(FAULT_MESSAGE) }), { name: 'Alice Exampel' });
    expect(JSON.parse(out.content[0]!.text).found).toBe(false);
    expect(stampOf(out)).toContain('entity_lookup_failed');
  });

  // The follow-up reads the variant arm makes per candidate (is the page retired, where does its redirect point) are lookup
  // reads too: a failure there drops a real candidate and must not read as "no such entity".
  test('the retirement follow-up read fails: found:false carries the marker, over the card and MCP', async () => {
    const faulty = entityLookupFault(engine, { retirement: () => new Error(FAULT_MESSAGE) });
    const res = await card(faulty, 'Alice Exampel', true);
    expect(res.found).toBe(false);
    expect(res.degraded).toEqual([{ stage: 'entity_lookup_failed', reason: 'provider_error' }]);
    const out = await mcp(faulty, { name: 'Alice Exampel' });
    expect(JSON.parse(out.content[0]!.text).found).toBe(false);
    expect(stampOf(out)).toContain('entity_lookup_failed');
  });

  test('a retirement follow-up statement timeout is reason timeout', async () => {
    const res = await card(entityLookupFault(engine, { retirement: () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }) }), 'Alice Exampel', true);
    expect(res.degraded).toEqual([{ stage: 'entity_lookup_failed', reason: 'timeout' }]);
  });

  test('the redirect-target fetch fails: found:false carries the marker', async () => {
    // A retired page redirecting to a page the candidate read does not return (its title shares no word with the query),
    // so the arm fetches the target itself.
    const put = (slug: string, title: string, frontmatter: Record<string, unknown>) =>
      engine.putPage(slug, { type: 'person', title, compiled_truth: title + '.', timeline: '', frontmatter } as never);
    await put('people/quentin-brightwater', 'Quentin Brightwater', { merged_into: 'people/zed-renamed' });
    await put('people/zed-renamed', 'Zed Renamed', {});
    try {
      const healthy = await card(engine, 'Quentin Brightwatter', true);
      expect(healthy.found).toBe(true);
      expect(healthy.degraded).toBeUndefined();
      expect(healthy.card?.entity.slug).toBe('people/zed-renamed');
      const res = await card(entityLookupFault(engine, { redirect: () => new Error(FAULT_MESSAGE) }), 'Quentin Brightwatter', true);
      expect(res.found).toBe(false);
      expect(res.degraded).toEqual([{ stage: 'entity_lookup_failed', reason: 'provider_error' }]);
    } finally {
      await engine.executeRaw("DELETE FROM pages WHERE slug IN ('people/quentin-brightwater', 'people/zed-renamed')");
    }
  });

  test('the typed capability refusal on a follow-up read ends the call', async () => {
    const refusal = Object.assign(new Error('executeRaw is not served by this engine'), { code: 'engine_capability_missing', reason: 'raw_sql' });
    await expect(card(entityLookupFault(engine, { retirement: () => refusal }), 'Alice Exampel', true)).rejects.toBe(refusal);
  });

  test('healthy variant read: the same name resolves as a variant and carries no marker', async () => {
    const res = await card(engine, 'Alice Exampel', true);
    expect(res.found).toBe(true);
    expect(res.card?.match?.kind).toBe('typo');
    expect(res.degraded).toBeUndefined();
  });

  test('the typed capability refusal ends the call', async () => {
    const refusal = Object.assign(new Error('executeRaw is not served by this engine'), { code: 'engine_capability_missing', reason: 'raw_sql' });
    await expect(card(entityLookupFault(engine, { variants: () => refusal }), 'Alice Exampel', true)).rejects.toBe(refusal);
  });
});

describe('the alias arm and the alias hydrate read', () => {
  beforeEach(async () => {
    await engine.setPageAliases('people/alice-example', 'default', ['ally']);
  });

  test('an alias read that fails (not a missing table) is degraded, and arm 2 still answers', async () => {
    const res = await card(entityLookupFault(engine, { aliases: () => new Error(FAULT_MESSAGE) }), 'people/alice-example');
    expect(res.found).toBe(true);
    expect(res.degraded).toEqual([{ stage: 'entity_lookup_failed', reason: 'provider_error' }]);
  });

  test('a pre-migration brain (no page_aliases table) is not degraded and arm 2 resolves', async () => {
    const missing = () => Object.assign(new Error('relation "page_aliases" does not exist'), { code: '42P01' });
    const res = await card(entityLookupFault(engine, { aliases: missing }), 'people/alice-example');
    expect(res.found).toBe(true);
    expect(res.degraded).toBeUndefined();
  });

  test('a different missing table is not "not migrated yet": degraded', async () => {
    const other = () => Object.assign(new Error('relation "pages" does not exist'), { code: '42P01' });
    const res = await card(entityLookupFault(engine, { aliases: other }), 'people/alice-example');
    expect(res.degraded).toEqual([{ stage: 'entity_lookup_failed', reason: 'provider_error' }]);
  });

  test('a hydrate read that fails is degraded, not a dropped stale alias', async () => {
    const res = await card(entityLookupFault(engine, { hydrate: () => new Error(FAULT_MESSAGE) }), 'ally');
    expect(res.found).toBe(false);
    expect(res.degraded).toEqual([{ stage: 'entity_lookup_failed', reason: 'provider_error' }]);
  });

  test('a genuinely stale alias (its page is gone) is still dropped quietly', async () => {
    await engine.softDeletePage('people/alice-example');
    const res = await card(engine, 'ally');
    expect(res.found).toBe(false);
    expect(res.degraded).toBeUndefined();
  });
});

describe('what does not change', () => {
  test('a healthy lookup carries no degraded marker (card, miss and MCP marker)', async () => {
    const hit = await card(engine, 'Alice Example');
    expect(hit.found).toBe(true);
    expect(hit.degraded).toBeUndefined();
    const miss = await card(engine, 'Nobody Example');
    expect(miss.found).toBe(false);
    expect(miss.degraded).toBeUndefined();
    // The brain's own mention-index notice may mark a miss; the lookup stage is never among the reasons.
    const out = await mcp(engine, { name: 'Nobody Example' });
    expect(stampOf(out) ?? []).not.toContain('entity_lookup_failed');
    expect(out._meta?.retrieval).toBeUndefined();
  });

  test('the Rust engine typed capability refusal ends the call, it is not a miss', async () => {
    const refusal = Object.assign(new Error('executeRaw is not served by this engine'), { code: 'engine_capability_missing', reason: 'raw_sql' });
    const faulty = entityLookupFault(engine, { arm2: () => refusal });
    await expect(card(faulty, 'Alice Example')).rejects.toBe(refusal);
    await expect(card(entityLookupFault(engine, { aliases: () => refusal }), 'Alice Example')).rejects.toBe(refusal);
    await engine.setPageAliases('people/alice-example', 'default', ['ally']);
    await expect(card(entityLookupFault(engine, { hydrate: () => refusal }), 'ally')).rejects.toBe(refusal);
  });
});

// A lookup that SUCCEEDS and finds nothing is a real miss: it must stay a plain `found:false`, never a degraded result,
// and it still exits 12 under GBRAIN_FAIL_ON_EMPTY=1 (#7177). Only a failed read earns `entity_lookup_failed`.
describe('a lookup that succeeds and finds nothing stays a real miss', () => {
  let home: string;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-entity-miss-'));
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(home, '.gbrain', 'brain.pglite') }));
  });
  afterAll(() => { rmSync(home, { recursive: true, force: true }); });

  const cli = (env: Record<string, string>) => {
    const r = spawnSync('bun', ['run', 'src/cli.ts', 'entity', 'Nobody Example', '--json'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, GBRAIN_HOME: home, DATABASE_URL: '', GBRAIN_DATABASE_URL: '', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_FAIL_ON_EMPTY: '', ...env },
      timeout: 120_000,
    });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1 };
  };

  test('CLI --json: found:false with no degraded key, exit 0', () => {
    const r = cli({});
    expect(r.status).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body.found).toBe(false);
    expect('degraded' in body).toBe(false);
    expect(r.stdout).not.toContain('entity_lookup_failed');
    expect(r.stderr).not.toContain('entity_lookup_failed');
  }, 180_000);

  test('CLI --json with GBRAIN_FAIL_ON_EMPTY=1: still exits 12, still no degraded key', () => {
    const r = cli({ GBRAIN_FAIL_ON_EMPTY: '1' });
    expect(r.status).toBe(12);
    const body = JSON.parse(r.stdout);
    expect(body.found).toBe(false);
    expect('degraded' in body).toBe(false);
    expect(r.stderr).toContain('[entity] exit 12 (no_results)');
    expect(r.stderr).not.toContain('entity_lookup_failed');
  }, 180_000);

  test('MCP: found:false with no _meta.degraded and no entity_lookup_failed anywhere in the answer', async () => {
    // An empty brain, like the CLI cases: with pages present the mention index reports its own pending coverage, which is
    // a different, older notice and not what this case pins.
    await resetPgliteState(engine);
    const out = await mcp(engine, { name: 'Nobody Example' });
    expect(JSON.parse(out.content[0]!.text).found).toBe(false);
    expect(out._meta?.degraded).toBeUndefined();
    expect(out._meta?.retrieval).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('entity_lookup_failed');
    expect(out.content.some(c => c.text.startsWith(DEGRADED_STAMP_PREFIX))).toBe(false);
  });
});
