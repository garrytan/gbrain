/**
 * get_page omit_facts — edit an entity page without carrying its facts table.
 *
 * An entity page's `## Facts` fence grows with every remembered fact, and a
 * get_page → edit → put_page round trip carries all of it both ways. With
 * omit_facts the read replaces the fence with FACTS_FENCE_OMITTED, and
 * put_page swaps the stored fence back in at that position:
 *   - the read has no fence rows; prose and timeline are intact
 *   - an edit put back with the placeholder keeps the stored fence byte for byte
 *   - a placeholder next to a fence, or with no stored fence, is refused
 *   - a placeholder quoted inside prose is text, not a placeholder
 *   - without omit_facts the read is unchanged
 *
 * Hermetic in-memory PGLite.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway } from '../src/core/ai/gateway.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, FACTS_FENCE_OMITTED } from '../src/core/facts-fence.ts';
import type { GBrainConfig } from '../src/core/config.ts';

let engine: PGLiteEngine;
const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

const getPage = operations.find((o) => o.name === 'get_page')!;
const putPage = operations.find((o) => o.name === 'put_page')!;

function localCtx(): OperationContext {
  return {
    engine,
    config: {} as GBrainConfig,
    logger: noopLogger,
    dryRun: false,
    remote: false,
    sourceId: 'default',
  } as OperationContext;
}

beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
}, 30_000);

const FENCE = `${FACTS_FENCE_BEGIN}
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Alice founded Acme | fact | 0.9 | world | high | 2024-01-01 |  | intro call |  |
| 2 | Alice prefers async updates | preference | 0.8 | world | medium | 2024-03-01 |  | email |  |
${FACTS_FENCE_END}`;

const PAGE = `---
type: person
title: Alice Example
---

Alice runs Acme.

## Facts

${FENCE}

<!-- timeline -->

- **2024-05-01** | call — Series A closed
`;

async function read(slug: string, extra: Record<string, unknown> = {}) {
  return (await getPage.handler(localCtx(), { slug, include_content: true, ...extra })) as Record<string, unknown>;
}

function storedFence(content: string): string {
  const begin = content.indexOf(FACTS_FENCE_BEGIN);
  return content.slice(begin, content.indexOf(FACTS_FENCE_END, begin) + FACTS_FENCE_END.length);
}

describe('get_page omit_facts', () => {
  test('the read replaces the facts fence with the placeholder and keeps prose and timeline', async () => {
    await putPage.handler(localCtx(), { slug: 'people/alice-omit', content: PAGE });
    const page = await read('people/alice-omit', { omit_facts: true });
    const content = page.content as string;
    expect(content).toContain(FACTS_FENCE_OMITTED);
    expect(content).not.toContain(FACTS_FENCE_BEGIN);
    expect(content).not.toContain('Alice founded Acme');
    expect(content).toContain('Alice runs Acme.');
    expect(content).toContain('Series A closed');
    expect(page.compiled_truth as string).not.toContain(FACTS_FENCE_BEGIN);
  }, 30_000);

  test('an edit put back with the placeholder keeps the stored fence byte for byte', async () => {
    await putPage.handler(localCtx(), { slug: 'people/alice-edit', content: PAGE });
    const before = storedFence((await read('people/alice-edit')).content as string);
    const lean = await read('people/alice-edit', { omit_facts: true });
    const edited = (lean.content as string).replace('Alice runs Acme.', 'Alice runs Acme and advises Beta.');
    await putPage.handler(localCtx(), { slug: 'people/alice-edit', content: edited, expected_revision: lean.revision });
    const after = (await read('people/alice-edit')).content as string;
    expect(after).toContain('Alice runs Acme and advises Beta.');
    expect(after).not.toContain(FACTS_FENCE_OMITTED);
    expect(storedFence(after)).toBe(before);
    expect(after).toContain('Series A closed');
  }, 30_000);

  test('a placeholder next to a facts fence is refused', async () => {
    await putPage.handler(localCtx(), { slug: 'people/alice-both', content: PAGE });
    const full = await read('people/alice-both');
    const both = (full.content as string).replace('Alice runs Acme.', `Alice runs Acme.\n\n${FACTS_FENCE_OMITTED}`);
    await expect(putPage.handler(localCtx(), { slug: 'people/alice-both', content: both, expected_revision: full.revision }))
      .rejects.toThrow(/omitted-facts placeholder/);
  }, 30_000);

  test('a placeholder on a page without a stored facts fence is refused', async () => {
    const plain = PAGE.replace(`## Facts\n\n${FENCE}\n\n`, '');
    await putPage.handler(localCtx(), { slug: 'people/alice-nofence', content: plain });
    const page = await read('people/alice-nofence');
    const withPlaceholder = (page.content as string).replace('Alice runs Acme.', `Alice runs Acme.\n\n${FACTS_FENCE_OMITTED}`);
    await expect(putPage.handler(localCtx(), { slug: 'people/alice-nofence', content: withPlaceholder, expected_revision: page.revision }))
      .rejects.toThrow(/no facts fence to restore/);
  }, 30_000);

  test('a placeholder quoted in prose is text: no restore, no refusal, and the real one still works', async () => {
    const quoted = PAGE.replace('Alice runs Acme.', 'Alice runs Acme. Editors leave `' + FACTS_FENCE_OMITTED + '` where it stands.');
    await putPage.handler(localCtx(), { slug: 'people/alice-quoted', content: quoted });
    const full = await read('people/alice-quoted');
    await putPage.handler(localCtx(), { slug: 'people/alice-quoted', content: full.content, expected_revision: full.revision });
    const lean = await read('people/alice-quoted', { omit_facts: true });
    const edited = (lean.content as string).replace('Alice runs Acme.', 'Alice runs Acme and Beta.');
    await putPage.handler(localCtx(), { slug: 'people/alice-quoted', content: edited, expected_revision: lean.revision });
    const after = (await read('people/alice-quoted')).content as string;
    expect(after).toContain('Alice runs Acme and Beta. Editors leave `' + FACTS_FENCE_OMITTED + '` where it stands.');
    expect(storedFence(after)).toBe(storedFence(full.content as string));

    const plain = quoted.replace(`## Facts\n\n${FENCE}\n\n`, '');
    await putPage.handler(localCtx(), { slug: 'people/alice-quoted-nofence', content: plain });
    const page = await read('people/alice-quoted-nofence');
    const reput = (page.content as string).replace('Alice runs Acme.', 'Alice runs Acme today.');
    await putPage.handler(localCtx(), { slug: 'people/alice-quoted-nofence', content: reput, expected_revision: page.revision });
    expect((await read('people/alice-quoted-nofence')).content as string).toContain('Alice runs Acme today.');
  }, 30_000);

  test('without omit_facts the read still carries the fence', async () => {
    await putPage.handler(localCtx(), { slug: 'people/alice-default', content: PAGE });
    const content = (await read('people/alice-default')).content as string;
    expect(content).toContain('Alice founded Acme');
    expect(content).not.toContain(FACTS_FENCE_OMITTED);
  }, 30_000);
});
