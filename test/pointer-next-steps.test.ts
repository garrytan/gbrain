/**
 * GBRA-789: the ambient next steps name calls an agent can make. A page
 * pointer gives the exact get_page call, and the pointer block says how to
 * reach get_page from the starter tool list (request_tools); an entity card
 * gives entity {name: <slug>}; and entity called with slug says to pass name.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { renderPointerBlock, renderPointerLine } from '../src/core/context/retrieval-reflex.ts';
import { renderCardLine } from '../src/core/context/turn-context.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

const pointer = { display: 'Acme Example', slug: 'companies/acme-example', synopsis: 'Acme Example is a customer.' } as never;
const card = (sourceId: string) => ({ entity: { slug: 'people/alice-example', title: 'Alice Example', type: 'person', source_id: sourceId }, summary: 'Alice Example runs the pilot.' }) as never;

describe('ambient pointers name callable next steps', () => {
  test('a page pointer gives the exact get_page call', () => {
    expect(renderPointerLine(pointer)).toContain('get_page {slug: "companies/acme-example"}');
  });

  test('the pointer block says how to reach get_page from the starter tool list', () => {
    expect(renderPointerBlock([pointer])).toContain('request_tools {tools: ["get_page"]}');
    expect(renderPointerBlock([pointer])).toContain('this connection cannot open pages');
  });

  test('an entity card gives entity {name: <slug>} and the get_page call, with the source when it is not home', () => {
    const home = renderCardLine(card('default'), 'default');
    expect(home).toContain('entity {name: "people/alice-example"}');
    expect(home).toContain('get_page {slug: "people/alice-example"}');
    const other = renderCardLine(card('source-a'), 'default');
    expect(other).toContain('entity {name: "people/alice-example", source_id: "source-a"}');
    expect(other).toContain('get_page {slug: "people/alice-example", source_id: "source-a"}');
  });

  test('entity called with slug says to pass it as name', async () => {
    const out = await dispatchToolCall(engine, 'entity', { slug: 'companies/acme-example' }, { remote: false, sourceId: 'default' });
    expect(out.isError).toBe(true);
    const text = out.content.map(c => c.text).join('\n');
    expect(text).toContain('name: \\"companies/acme-example\\"');
  });
});
