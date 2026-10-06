/**
 * Validity ranges on typed relation lines (`- works_at @effective[a,b) [[x]]`)
 * stored as dated edge transitions (producer 'inline', core/link-effective.ts)
 * (`line_grammar.effective_ranges`, on by default; applies only while the
 * grammar, off by default, is on: setup checks nothing is stored before enabling it).
 *
 * Protects: an ended range hides the edge from default graph reads and shows
 * it to as_of reads; an open range keeps it live; editing the range replaces
 * the stored transitions; a range on an event type stores only its start; a
 * range on a link the page does not store with that type stores nothing; with
 * the flag off nothing is stored.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { inlineTransitions } from '../src/core/link-effective.ts';

setDefaultTimeout(60_000);
let engine: PGLiteEngine;

const ctx = (): OperationContext => ({
  engine, config: { engine: 'pglite' as const }, logger: { info: () => {}, warn: () => {}, error: () => {} },
  dryRun: false, remote: false, sourceId: 'default', emitNotice: () => {}, emitResponseMeta: () => {},
} as OperationContext);
const op = (name: string) => operations.find(o => o.name === name)!;

async function put(slug: string, fm: string, body: string) {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
  await op('put_page').handler(ctx(), { slug, ...(snapshot ? { expected_revision: snapshot.revision } : {}), content: `---\n${fm}\n---\n\n${body}` });
}
const worksAt = async (params: Record<string, unknown> = {}) =>
  ((await op('get_links').handler(ctx(), { slug: 'people/alice-example', link_type: 'works_at', ...params })) as Array<{ to_slug: string }>).map(r => r.to_slug).sort();
const inline = () => engine.executeRaw<{ kind: string; occurred_on: unknown; link_type: string }>(
  `SELECT kind, occurred_on::text AS occurred_on, link_type FROM link_transitions WHERE producer = 'inline' ORDER BY link_type, kind`);

beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); resetGateway();
  await put('companies/acme-example', 'type: company\ntitle: Acme', 'A company.');
  await put('companies/widget-co', 'type: company\ntitle: Widget', 'Another company.');
  await put('people/alice-example', 'type: person\ntitle: Alice', '- works_at @effective[2021-03,2024-06) [[companies/acme-example]]');
  expect(await inline()).toEqual([]);
  await engine.setConfig('line_grammar.enabled', 'true');
});
afterAll(async () => { await engine.disconnect(); resetGateway(); });

describe('line_grammar.effective_ranges', () => {
  test('turned off: a range is parsed but nothing is stored', async () => {
    await engine.setConfig('line_grammar.effective_ranges', 'false');
    await put('people/alice-example', 'type: person\ntitle: Alice',
      '- works_at @effective[2021-03,2024-06) [[companies/acme-example]]\n- works_at @effective[2024-06,) [[companies/widget-co]]');
    expect(await inline()).toEqual([]);
    expect(await worksAt()).toEqual(['companies/acme-example', 'companies/widget-co']);
  });

  test('on by default: an ended range hides the edge from default reads; as_of finds it', async () => {
    await engine.executeRaw("DELETE FROM config WHERE key = 'line_grammar.effective_ranges'");
    await put('people/alice-example', 'type: person\ntitle: Alice',
      'Alice.\n\n- works_at @effective[2021-03,2024-06) [[companies/acme-example]]\n- works_at @effective[2024-06,) [[companies/widget-co]]');
    expect(await inline()).toEqual([
      { kind: 'end', occurred_on: '2024-06-01', link_type: 'works_at' },
      { kind: 'start', occurred_on: '2021-03-01', link_type: 'works_at' },
      { kind: 'start', occurred_on: '2024-06-01', link_type: 'works_at' },
    ]);
    expect(await worksAt()).toEqual(['companies/widget-co']);
    expect(await worksAt({ as_of: '2022-01-01' })).toEqual(['companies/acme-example']);
    expect(await worksAt({ status: 'all' })).toEqual(['companies/acme-example', 'companies/widget-co']);
  });

  test('editing the range replaces the stored transitions', async () => {
    await put('people/alice-example', 'type: person\ntitle: Alice',
      '- works_at @effective[2021-03,) [[companies/acme-example]]\n- works_at @effective[2024-06,) [[companies/widget-co]]');
    expect((await inline()).filter(r => r.kind === 'end')).toEqual([]);
    expect(await worksAt()).toEqual(['companies/acme-example', 'companies/widget-co']);
    await put('people/alice-example', 'type: person\ntitle: Alice', '- works_at [[companies/widget-co]]');
    expect(await inline()).toEqual([]);
  });

  test('turning the flag off drops the stored ranges on the next extraction', async () => {
    await put('people/alice-example', 'type: person\ntitle: Alice', '- works_at @effective[2021-03,2024-06) [[companies/acme-example]]');
    expect((await inline()).length).toBe(2);
    await engine.setConfig('line_grammar.effective_ranges', 'false');
    await put('people/alice-example', 'type: person\ntitle: Alice', '- works_at @effective[2021-03,2024-06) [[companies/acme-example]]\n\nEdited.');
    expect(await inline()).toEqual([]);
    expect(await worksAt()).toEqual(['companies/acme-example']);
  });
});

describe('inlineTransitions', () => {
  const rows = [{ from_slug: 'people/alice-example', to_slug: 'companies/acme-example', link_type: 'works_at', link_source: 'markdown' },
    { from_slug: 'people/alice-example', to_slug: 'companies/widget-co', link_type: 'invested_in', link_source: 'markdown' }];

  test('an event type stores its start and reports the end', () => {
    const r = inlineTransitions('people/alice-example', '- invested_in @effective[2021,2023) [[companies/widget-co]]', rows);
    expect(r.transitions.map(t => [t.kind, t.occurred_on, t.producer])).toEqual([['start', '2021-01-01', 'inline']]);
    expect(r.unmatched.map(u => u.reason)).toEqual(['event_cannot_end']);
  });

  test('a link the page does not store with the line type, or a reference type, stores nothing', () => {
    const r = inlineTransitions('people/alice-example',
      '- advises @effective[2021,) [[companies/acme-example]]\n- mentions @effective[2021,) [[companies/acme-example]]', rows);
    expect(r.transitions).toEqual([]);
    expect(r.unmatched.map(u => u.reason).sort()).toEqual(['no_target', 'not_temporal']);
  });
});
