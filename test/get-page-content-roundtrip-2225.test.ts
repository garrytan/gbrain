/**
 * #2225 — get_page must hand clients a round-trippable `content` field.
 *
 * Pre-fix, get_page returned compiled_truth and timeline as separate fields
 * with no canonical serialized form; a naive MCP client reassembling them
 * (or putting compiled_truth back alone) destroyed pages.timeline on the
 * next put_page. Post-fix:
 *   - get_page with include_content: true returns `content` — serializeMarkdown
 *     output with the `<!-- timeline -->` sentinel — so get→edit→put preserves
 *     the timeline. Opt-in: `content` roughly duplicates compiled_truth +
 *     timeline, and get_page is the most-called read op, so read-only callers
 *     don't pay double payload by default.
 *   - splitBody's bare `## Timeline` heading fallback (see markdown.test.ts)
 *     rescues clients that still hand-concatenate.
 *
 * Hermetic in-memory PGLite.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway } from '../src/core/ai/gateway.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
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
  // Keyless gateway so put_page's embed path degrades instead of calling out.
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
}, 30_000);

const ORIGINAL = `---
type: company
title: Acme Example
---

Acme builds widgets and has 42 employees.

<!-- timeline -->

- 2024-05-01: Series A closed
- 2025-02-10: Widget 2.0 launched
`;

describe('get_page content round-trip (#2225)', () => {
  test('get_page with include_content: true returns canonical `content` with the timeline sentinel', async () => {
    await putPage.handler(localCtx(), { slug: 'companies/acme-example', content: ORIGINAL });

    const page = (await getPage.handler(localCtx(), { slug: 'companies/acme-example', include_content: true })) as Record<string, unknown>;
    expect(typeof page.content).toBe('string');
    const content = page.content as string;
    expect(content).toContain('<!-- timeline -->');
    expect(content).toContain('Series A closed');
    expect(content).toContain('Acme builds widgets');
  }, 30_000);

  test('content is opt-in: absent by default so the hot read path does not double its payload', async () => {
    await putPage.handler(localCtx(), { slug: 'companies/optin-example', content: ORIGINAL });

    const page = (await getPage.handler(localCtx(), { slug: 'companies/optin-example' })) as Record<string, unknown>;
    expect('content' in page).toBe(false);
    // The split fields are still there for read-only consumers.
    expect(page.compiled_truth as string).toContain('Acme builds widgets');
    expect(page.timeline as string).toContain('Series A closed');
  }, 30_000);

  test('naive get_page.content → put_page preserves pages.timeline', async () => {
    await putPage.handler(localCtx(), { slug: 'companies/roundtrip-example', content: ORIGINAL });

    const before = (await getPage.handler(localCtx(), { slug: 'companies/roundtrip-example', include_content: true })) as Record<string, unknown>;
    expect((before.timeline as string)).toContain('Series A closed');

    // The naive client edit: take `content` verbatim (or with a body edit
    // above the sentinel) and put it straight back.
    const edited = (before.content as string).replace('42 employees', '43 employees');
    await putPage.handler(localCtx(), { slug: 'companies/roundtrip-example', content: edited });

    const row = await engine.getPage('companies/roundtrip-example', { sourceId: 'default' });
    expect(row).not.toBeNull();
    expect(row!.timeline ?? '').toContain('Series A closed');
    expect(row!.timeline ?? '').toContain('Widget 2.0 launched');
    expect(row!.compiled_truth ?? '').toContain('43 employees');
    expect(row!.compiled_truth ?? '').not.toContain('Series A closed');
  }, 30_000);

  test('hand-concatenated compiled_truth + ## Timeline + timeline also survives put_page (splitBody fallback)', async () => {
    await putPage.handler(localCtx(), { slug: 'companies/concat-example', content: ORIGINAL });
    const page = (await getPage.handler(localCtx(), { slug: 'companies/concat-example' })) as Record<string, unknown>;

    const naive = `---
type: company
title: Acme Example
---

${page.compiled_truth as string}

## Timeline

${page.timeline as string}
`;
    await putPage.handler(localCtx(), { slug: 'companies/concat-example', content: naive });

    const row = await engine.getPage('companies/concat-example', { sourceId: 'default' });
    expect(row!.timeline ?? '').toContain('Series A closed');
    expect(row!.compiled_truth ?? '').not.toContain('Series A closed');
  }, 30_000);
});
