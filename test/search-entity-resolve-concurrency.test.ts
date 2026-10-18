/**
 * #6721: resolving the entity a query names costs one round trip of wall
 * time, not four.
 *
 * 1. Protects: `resolveQueryEntities` (search's alias fan-out, provenance
 *    demotion and entity facts) issues its alias, title and case-sensitive
 *    alias reads at once, and inside a request's config snapshot the mention
 *    policy it needs costs no statement. On a pooled Postgres they were four
 *    reads in series (alias, `config WHERE key = ANY`, titles, page_aliases),
 *    about 30 ms each.
 * 2. Fails when: the reads are awaited one after another again, or the
 *    policy is read with its own config statement inside a request snapshot.
 *    Outside a snapshot the policy keeps its one keyed read (the write path
 *    counts statements).
 * 3. Existing coverage: test/search-alias-fanout.test.ts pins what the
 *    fan-out finds, not when its reads are issued.
 * 4. Seam: a recording engine whose reads finish only when the test releases
 *    them, so a read issued after another finished is visible.
 *    Contributed by @troyhoffman-oss (#6734).
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { withRequestConfigSnapshot } from '../src/core/config-snapshot.ts';
import { readMentionPolicy } from '../src/core/mentions/policy.ts';
import { resolveQueryEntities } from '../src/core/search/alias-fanout.ts';

function gatedEngine() {
  const started: string[] = [];
  const gates: Array<() => void> = [];
  const gate = <T>(label: string, value: T) => new Promise<T>(resolve => { started.push(label); gates.push(() => resolve(value)); });
  const engine = {
    kind: 'postgres',
    resolveAliases: (norms: string[]) => gate('aliases', new Map([[norms.find(n => n === 'acme example')!, [{ slug: 'companies/acme-example', source_id: 'default' }]]])),
    executeRaw: (sql: string) => gate(sql.includes('page_aliases') ? 'case-sensitive aliases' : sql.includes('lower(title)') ? 'titles' : `other: ${sql.slice(0, 40)}`, []),
    getAllConfig: async () => { started.push('config (snapshot)'); return {}; },
    getConfig: async () => null,
  } as unknown as BrainEngine;
  return { engine, started, release: () => { for (const open of gates.splice(0)) open(); } };
}

describe('resolveQueryEntities', () => {
  test('the alias, title and case-sensitive reads are all issued before any of them answers', async () => {
    const { engine, started, release } = gatedEngine();
    const found = await withRequestConfigSnapshot(engine, async () => {
      const pending = resolveQueryEntities(engine, 'Acme Example renewal', { sourceId: 'default', excludePrivate: true });
      for (let i = 0; i < 50 && started.length < 4; i++) await new Promise(r => setTimeout(r, 1));
      expect([...started].sort()).toEqual(['aliases', 'case-sensitive aliases', 'config (snapshot)', 'titles']);
      release();
      return pending;
    });
    expect(found.map(f => f.pages)).toEqual([[{ slug: 'companies/acme-example', source_id: 'default' }]]);
  });
});

describe('readMentionPolicy', () => {
  const config = { 'mentions.entity_types': '+product,-person', 'mentions.ignore': 'Acme', unrelated: 'x' };

  test('inside a request snapshot: the policy keys come from the snapshot, with no config statement of their own', async () => {
    const statements: string[] = [];
    const engine = {
      kind: 'postgres',
      executeRaw: async (sql: string) => { statements.push(sql); return []; },
      getAllConfig: async () => config,
      getConfig: async () => { throw new Error('per-key read not expected'); },
    } as unknown as BrainEngine;
    const policy = await withRequestConfigSnapshot(engine, () => readMentionPolicy(engine));
    expect(statements).toEqual([]);
    expect(policy).toMatchObject({ enabled: true, typeAdds: ['product'], typeRemoves: ['person'], ignore: ['Acme'] });
  });

  test('outside a snapshot: one keyed config read, unchanged', async () => {
    const statements: string[] = [];
    const engine = {
      kind: 'postgres',
      executeRaw: async (sql: string) => { statements.push(sql); return Object.entries(config).map(([key, value]) => ({ key, value })); },
      getAllConfig: async () => { throw new Error('whole-table read not expected'); },
      getConfig: async () => { throw new Error('per-key read not expected'); },
    } as unknown as BrainEngine;
    const policy = await readMentionPolicy(engine);
    expect(statements).toEqual(['SELECT key, value FROM config WHERE key = ANY($1::text[])']);
    expect(policy).toMatchObject({ enabled: true, typeAdds: ['product'], typeRemoves: ['person'], ignore: ['Acme'] });
  });

  test('an engine without SQL reads each key', async () => {
    const keys: string[] = [];
    const policy = await readMentionPolicy({ getConfig: async (key: string) => { keys.push(key); return key === 'auto_link' ? 'false' : null; } });
    expect(keys).toContain('mentions.entity_types');
    expect(policy).toMatchObject({ enabled: false, disabledBy: 'auto_link' });
  });
});
