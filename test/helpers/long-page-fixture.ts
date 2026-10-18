/**
 * Shared corpus and calls for the long-page delivery tests (F2,
 * `search.long_page_unit`): the PGLite unit arm (test/evidence-long-page.test.ts)
 * and the Postgres arm (test/e2e/evidence-long-page.test.ts).
 *
 * `contracts/msa-example` is the one long page (over the default
 * `search.long_page_min_chars`, 20,000 rendered characters, with ATX
 * sections). Its term words ("renewal fee") recur in clauses that do not
 * decide the value, so a delivered unit has to be anchored on the ranked hit,
 * never on term overlap. `notes/policy-example` is medium (over the old
 * 8,000-byte line, under 20,000 characters), the others are short;
 * `chat/session-example` is a conversation for the mixed case.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { prepareMarkdownChunks } from '../../src/core/markdown-chunks.ts';
import { installFixtureChunks } from './page-projection.ts';
import { offPathMcpBytes } from './evidence-delivery-fixture.ts';
import { withEnv } from './with-env.ts';

const filler = (topic: string, n: number) => Array.from({ length: n }, (_, i) => `Clause ${i + 1} on ${topic} restates the general obligations of both parties and the notice address for correspondence.`).join(' ');

export const LONG_SLUG = 'contracts/msa-example';
export const MEDIUM_SLUG = 'notes/policy-example';
export const DECIDING = 'Effective 2026-03-01 the annual renewal fee for acme-example is 4,200 USD.';

export const LONG_PAGE_CORPUS: Array<{ slug: string; type: string; body: string }> = [
  {
    slug: LONG_SLUG,
    type: 'note',
    body: [
      `## Definitions\n\nThe renewal fee means the amount stated in the order form. ${filler('definitions', 48)}`,
      `## Fees\n\nNo renewal fee applies to trial seats, and the renewal fee is invoiced in advance. ${filler('fees', 48)}`,
      `## Term and renewal\n\nThe agreement renews each year; a renewal fee change needs written notice. ${filler('term', 48)}`,
      `## Amendment 2\n\n${DECIDING} ${filler('amendment', 6)}`,
      `## Notices\n\n${filler('notices', 48)}`,
    ].join('\n\n'),
  },
  { slug: 'notes/short-example', type: 'note', body: 'A short note: ask about the renewal fee before the call.' },
  { slug: MEDIUM_SLUG, type: 'note', body: `## Renewal policy\n\nThe renewal fee policy is reviewed once a year. ${filler('policy', 100)}` },
  { slug: 'notes/handbook-example', type: 'note', body: `## Renewals\n\nThe handbook describes how a renewal fee is quoted. ${filler('handbook', 3)}` },
];

export const CONVERSATION_PAGE = {
  slug: 'chat/session-example', type: 'note',
  body: Array.from({ length: 6 }, (_, i) => `**user:** question ${i} about the renewal fee\n\n**assistant:** answer ${i} about the renewal fee and the notice period`).join('\n\n'),
};

export async function seedLongPages(engine: BrainEngine, pages = LONG_PAGE_CORPUS): Promise<void> {
  for (const p of pages) {
    await engine.putPage(p.slug, { type: p.type as never, title: p.slug, compiled_truth: p.body, timeline: '', frontmatter: {} });
    await installFixtureChunks(engine, p.slug, await prepareMarkdownChunks({ compiled_truth: p.body, timeline: '' }));
  }
  await engine.setConfig('search.mcp_keyword_only', 'true');
  await engine.setConfig('feedback.enabled', 'false');
}

/** One remote stdio MCP call, as the agent receives it (notice blocks removed); `rows` is the parsed content[0]. */
export async function mcpCall(engine: BrainEngine, name: string, params: Record<string, unknown>): Promise<{ bytes: string; rows: Array<Record<string, unknown>> }> {
  return withEnv({ GBRAIN_BACKUP_CHECK: '0' }, async () => {
    const res = await dispatchToolCall(engine, name, params, { remote: true, transport: 'stdio', sourceId: 'default' });
    const bytes = offPathMcpBytes(res as never);
    const body = JSON.parse((JSON.parse(bytes) as { content: Array<{ text: string }> }).content[0].text) as unknown;
    return { bytes, rows: Array.isArray(body) ? body as Array<Record<string, unknown>> : [] };
  });
}

/** One op call through the handler (trusted local unless `remote`), returning the full rows and the retrieval meta. */
export async function opCall(engine: BrainEngine, name: string, params: Record<string, unknown>, remote = false): Promise<{ result: unknown; meta: Record<string, unknown> | undefined }> {
  let meta: Record<string, unknown> | undefined;
  const ctx = {
    engine, config: {}, logger: console, dryRun: false, remote, sourceId: 'default',
    emitResponseMeta: (key: string, value: unknown) => { if (key === 'retrieval') meta = value as Record<string, unknown>; },
  } as unknown as OperationContext;
  const result = await operations.find(o => o.name === name)!.handler(ctx, params);
  return { result, meta };
}

export async function withConfig<T>(engine: BrainEngine, values: Record<string, string>, run: () => Promise<T>): Promise<T> {
  for (const [k, v] of Object.entries(values)) await engine.setConfig(k, v);
  try { return await run(); } finally {
    await engine.executeRaw(`DELETE FROM config WHERE key = ANY($1::text[])`, [Object.keys(values)]);
  }
}
