/**
 * #2942 / #2947 (GBRA-215 L1): the near-name matcher and the two review lists extraction_pending adds.
 *
 * Flag only: nothing here merges or writes entity_identities. The lists are read-only, so a repo-less brain
 * (this PGLite brain has no repository) and a repository-backed one read the same rows; the Postgres parity
 * run lives in test/e2e/extraction-review-postgres.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { classifyNearName, nameKeys, buildNearNameIndex, queryNearNames, normalizeEntityName, type EntityName } from '../src/core/entities/near-name.ts';
import { operationsByName, OperationError, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
const pending = operationsByName['extraction_pending']!;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => { await engine.disconnect(); });

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM facts');
  await engine.executeRaw('DELETE FROM content_chunks');
  await engine.executeRaw('DELETE FROM links');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw('DELETE FROM entity_identities').catch(() => undefined);
});

function ctx(over: Partial<OperationContext> = {}): OperationContext {
  return {
    engine, config: {} as OperationContext['config'],
    logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as OperationContext['logger'],
    dryRun: false, remote: true, sourceId: 'default', ...over,
  } as OperationContext;
}

async function page(slug: string, title: string, frontmatter: Record<string, unknown> = {}, type = slug.startsWith('people/') ? 'person' : 'company') {
  await engine.putPage(slug, { title, type, compiled_truth: `# ${title}`, timeline: '', frontmatter });
}

async function fact(text: string, visibility: 'world' | 'private' = 'world', entity: string | null = null) {
  await engine.executeRaw(
    `INSERT INTO facts (fact, source, source_id, visibility, entity_slug) VALUES ($1, 'fixture', 'default', $2, $3)`,
    [text, visibility, entity],
  );
}

describe('classifyNearName', () => {
  test('one-letter transcription slips are typos', () => {
    expect(classifyNearName('ACMX', 'ACME')).toBe('typo');
    expect(classifyNearName('Brex Example', 'Drex Example')).toBe('typo');
    expect(classifyNearName('Acme Exmaple', 'Acme Example')).toBe('typo');
  });
  test('corporate suffixes and case normalize to the same name, never a different entity', () => {
    expect(classifyNearName('Acme Example Inc.', 'acme example')).toBe('same');
    expect(classifyNearName('Acme Labs', 'ACME')).toBe('same');
    expect(classifyNearName('Dr. Alice Example', 'Alice Example')).toBe('same');
    expect(classifyNearName('Allie Example', 'Alice Example')).toBe('same');
  });
  test('an acronym of a multi-word name, with at most one letter different', () => {
    expect(classifyNearName('NXE', 'Northstar Xeno Example')).toBe('acronym');
    expect(classifyNearName('NEL', 'Northstar Example Labs')).toBe(null);
    expect(classifyNearName('NXF', 'Northstar Example')).toBe(null);
    expect(classifyNearName('NEF', 'Northstar Example Fund')).toBe('acronym');
    expect(classifyNearName('NEX', 'Northstar Example Fund')).toBe('acronym');
  });
  test('short names and unrelated names are never flagged', () => {
    expect(classifyNearName('AB', 'AC')).toBe(null);
    expect(classifyNearName('Acme Example', 'Globex Example')).toBe(null);
    expect(nameKeys('ab')).toEqual([]);
    expect(nameKeys('x'.repeat(65))).toEqual([]);
  });
});

describe('near-name index', () => {
  const names: EntityName[] = [
    { slug: 'companies/acme', name: 'ACME' },
    { slug: 'companies/brex-example', name: 'Brex Example' },
    { slug: 'companies/xacme', name: 'Xacme' },
    ...Array.from({ length: 200 }, (_, i) => ({ slug: `companies/filler-${i}`, name: `Filler Company Number ${i}` })),
  ];

  test('finds every distance-1 pair, including ones that differ in the first letter', () => {
    const index = buildNearNameIndex(names);
    expect(queryNearNames(index, 'ACMX').map(m => m.slug).sort()).toEqual(['companies/acme']);
    expect(queryNearNames(index, 'Drex Example').map(m => m.slug)).toEqual(['companies/brex-example']);
    expect(queryNearNames(index, 'Acme').find(m => m.slug === 'companies/xacme')?.kind).toBe('typo');
  });

  test('a sharded index finds the same pairs once every shard is walked', () => {
    const queries = ['ACMX', 'Drex Example', 'Acme', 'Filler Company Numbr 7'];
    const whole = queries.map(q => queryNearNames(buildNearNameIndex(names), q).map(m => m.slug).sort());
    for (const shards of [2, 5, 13]) {
      const sharded = queries.map(q => [...new Set(Array.from({ length: shards }, (_, s) =>
        queryNearNames(buildNearNameIndex(names, s, shards), q).map(m => m.slug)).flat())].sort());
      expect(sharded).toEqual(whole);
    }
  });

  test('normalizeEntityName strips corporate suffixes', () => {
    expect(normalizeEntityName('The Acme Example Company, LLC')).toBe('acmeexample');
  });
});

describe('extraction_pending review lists', () => {
  test('default output keeps pending and count, adds unattributed, and runs no matcher', async () => {
    await fact('the quarterly offsite moved to march');
    const out = await pending.handler(ctx(), {}) as Record<string, any>;
    expect(out.count).toBe(0);
    expect(out.pending).toEqual([]);
    expect(out.include).toEqual(['pending', 'unattributed']);
    expect(out.unattributed.rows.map((r: any) => r.fact)).toEqual(['the quarterly offsite moved to march']);
    expect(out.possible_duplicates).toBeUndefined();
  });

  test('unattributed rows carry the relink action and never a forget', async () => {
    await fact('a world claim');
    const out = await pending.handler(ctx(), {}) as Record<string, any>;
    const [action] = out.unattributed.rows[0].actions;
    expect(action.kind).toBe('relink');
    expect(action.mcp.tool).toBe('remember');
    expect(action.mcp.arguments.replaces).toBe(out.unattributed.rows[0].fact_id);
    expect(JSON.stringify(out.unattributed)).not.toContain('forget"');
  });

  test('remote callers see only world facts; the local owner sees private ones too', async () => {
    await fact('world claim', 'world');
    await fact('private claim', 'private');
    await fact('linked claim', 'world', 'people/alice-example');
    const remote = await pending.handler(ctx(), {}) as Record<string, any>;
    expect(remote.unattributed.rows.map((r: any) => r.fact)).toEqual(['world claim']);
    const local = await pending.handler(ctx({ remote: false }), {}) as Record<string, any>;
    expect(local.unattributed.rows.map((r: any) => r.fact).sort()).toEqual(['private claim', 'world claim']);
  });

  test('unattributed pages with next_offset until complete', async () => {
    for (let i = 0; i < 5; i++) await fact(`claim ${i}`);
    const first = await pending.handler(ctx(), { limit: 2 }) as Record<string, any>;
    expect(first.unattributed.rows.length).toBe(2);
    expect(first.unattributed.complete).toBe(false);
    const seen = [...first.unattributed.rows.map((r: any) => r.fact)];
    let next = first.unattributed.next_offset;
    while (next !== null) {
      const more = await pending.handler(ctx(), { limit: 2, unattributed_offset: next }) as Record<string, any>;
      seen.push(...more.unattributed.rows.map((r: any) => r.fact));
      next = more.unattributed.next_offset;
    }
    expect(seen.sort()).toEqual(['claim 0', 'claim 1', 'claim 2', 'claim 3', 'claim 4']);
  });

  test('possible_duplicates flags a near name on request, without merging anything', async () => {
    await page('companies/acme', 'ACME');
    await page('companies/acmx', 'ACMX');
    await page('companies/globex-example', 'Globex Example');
    const out = await pending.handler(ctx(), { include: ['possible_duplicates'] }) as Record<string, any>;
    const flagged = out.possible_duplicates.rows.map((r: any) => [r.slug, r.near.map((n: any) => `${n.slug}:${n.kind}`)]);
    expect(flagged).toContainEqual(['companies/acmx', ['companies/acme:typo']]);
    expect(flagged.find((f: any) => f[0] === 'companies/globex-example')).toBeUndefined();
    expect(out.possible_duplicates.complete).toBe(true);
    const [{ n }] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM entity_identities');
    expect(n).toBe(0);
    const link = out.possible_duplicates.rows[0].actions.find((a: any) => a.kind === 'link_identity');
    expect(link.run_by).toBe('owner');
  });

  test('an alias or a distinct_from decision silences a pair', async () => {
    await page('companies/acme', 'ACME', { aliases: ['ACMX'] });
    await page('companies/acmx', 'ACMX');
    await page('people/alice-example', 'Alice Example');
    await page('people/alicia-example', 'Alicx Example', { distinct_from: ['people/alice-example'] });
    const out = await pending.handler(ctx(), { include: ['possible_duplicates'] }) as Record<string, any>;
    expect(out.possible_duplicates.rows).toEqual([]);
  });

  test('a private page never shapes what a remote caller is shown', async () => {
    await engine.setConfig('search.exclude_private_pages', 'true').catch(() => undefined);
    await page('companies/acme', 'ACME', { visibility: 'private' });
    await page('companies/acmx', 'ACMX');
    const remote = await pending.handler(ctx(), { include: ['possible_duplicates'] }) as Record<string, any>;
    expect(JSON.stringify(remote.possible_duplicates)).not.toContain('companies/acme"');
    const local = await pending.handler(ctx({ remote: false }), { include: ['possible_duplicates'] }) as Record<string, any>;
    expect(local.possible_duplicates.rows.map((r: any) => r.slug)).toContain('companies/acmx');
  });

  test('possible_duplicates only looks at recently created pages', async () => {
    await page('companies/acme', 'ACME');
    await page('companies/acmx', 'ACMX');
    await engine.executeRaw(`UPDATE pages SET created_at = now() - interval '90 days'`);
    const out = await pending.handler(ctx(), { include: ['possible_duplicates'] }) as Record<string, any>;
    expect(out.possible_duplicates.rows).toEqual([]);
    const wider = await pending.handler(ctx(), { include: ['possible_duplicates'], since_days: 120 }) as Record<string, any>;
    expect(wider.possible_duplicates.rows.length).toBeGreaterThan(0);
  });

  test('an unknown include is refused with the valid names', async () => {
    const err = await pending.handler(ctx(), { include: ['everything'] }).catch((e: unknown) => e) as OperationError;
    expect(err).toBeInstanceOf(OperationError);
    expect(String(err.message)).toContain('everything');
  });
});
