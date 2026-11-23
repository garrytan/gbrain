/**
 * buildEntityCard (src/core/verbs/entity-card.ts): an engine that refuses one of the card's later reads with the
 * typed `engine_capability_missing` refusal refuses the whole card. It never answers with that part of the card empty
 * (no aliases, no edges, no coverage), which would be a wrong answer. Other read errors keep their fail-soft fallback.
 *
 * The engine here is PGLite with one member (or the one remaining raw statement) swapped for the refusal, the way the Rust engine
 * refuses a member it does not serve. Synthetic data only.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { buildEntityCard } from '../src/core/verbs/entity-card.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';

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
  await engine.putPage('people/alice-example',
    { title: 'Alice Example', type: 'person', compiled_truth: 'Alice Example, a founder at acme-example.', frontmatter: { aliases: ['alice'] } });
  await engine.putPage('companies/acme-example', { title: 'Acme Example', type: 'company', compiled_truth: 'A company.' });
  await engine.addLink('people/alice-example', 'companies/acme-example', 'founder', 'works_at');
  await engine.setPageAliases('people/alice-example', 'default', ['alice']);
});

/** `engine` with raw statements that match `sqlMatch`, or the member `member`, refused the way the Rust engine refuses. */
function refusing(opts: { sqlMatch?: RegExp; member?: keyof BrainEngine; error?: Error }): BrainEngine {
  const refusal = opts.error ?? capabilityMissing('raw_sql', 'executeRaw');
  return new Proxy(engine, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      if (prop === opts.member) return async () => { throw refusal; };
      if (prop === 'executeRaw' && opts.sqlMatch) {
        return async (sql: string, params?: unknown[]) => {
          if (opts.sqlMatch!.test(sql)) throw refusal;
          return target.executeRaw(sql, params);
        };
      }
      return value.bind(target);
    },
  }) as BrainEngine;
}

const CASES: Array<[string, Parameters<typeof refusing>[0]]> = [
  ['the alias member (readEntityAliasRows)', { member: 'readEntityAliasRows' }],
  ['the inbound edge member (readEntityInboundEdges)', { member: 'readEntityInboundEdges' }],
  ['the open-loop member (readEntityOpenLoops)', { member: 'readEntityOpenLoops' }],
  // The coverage read was a raw `FROM mention_index_status` statement on rust-engine/main; the cli-members line reads it
  // through the typed readMentionIndexStatus member (engine-sql/entity-reads.ts, the same statement), so that is the
  // member refused here (main join da99c637a7).
  ['the mention coverage member (readMentionIndexStatus)', { member: 'readMentionIndexStatus' }],
  ['the outbound link member (getLinks)', { member: 'getLinks' }],
  ['the timeline member (getTimeline)', { member: 'getTimeline' }],
];

describe('buildEntityCard refuses the whole card when a later read refuses', () => {
  test('the unrefused card has the parts the refusal would empty', async () => {
    const res = await buildEntityCard(engine, 'default', 'Alice Example', { remote: false, includeReferences: true });
    expect(res.found).toBe(true);
    expect(res.card!.edges.map(e => `${e.direction}:${e.type}:${e.slug}`)).toEqual(['out:works_at:companies/acme-example']);
    expect(res.card!.coverage).toBeDefined();
    expect(res.card!.aka).toContain('alice');
  });

  for (const [what, opts] of CASES) {
    test(`${what}: typed refusal, not a card with that part empty`, async () => {
      const err = await buildEntityCard(refusing(opts), 'default', 'Alice Example', { remote: false, includeReferences: true })
        .then(() => null, (e: unknown) => e);
      expect((err as { code?: string } | null)?.code).toBe('engine_capability_missing');
    });
  }

  test('an untyped read error keeps the fail-soft fallback: the card answers without aliases', async () => {
    const res = await buildEntityCard(refusing({ member: 'readEntityAliasRows', error: new Error('relation "page_aliases" does not exist') }),
      'default', 'Alice Example', { remote: false, includeReferences: true });
    expect(res.found).toBe(true);
    expect(res.card!.aka).toEqual([]);
  });
});
