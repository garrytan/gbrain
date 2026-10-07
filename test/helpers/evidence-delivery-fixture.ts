/**
 * Shared fixture for the evidence-delivery off-path golden (PGLite unit arm
 * and Postgres e2e arm). The captured bytes were generated on the release
 * before evidence delivery; do not change the corpus or the captured calls.
 * `chat/session-a` is the corpus's one conversation page (the `auto` default
 * expands it); every other page is off the conversation path.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { runThink } from '../../src/core/think/index.ts';
import { prepareMarkdownChunks } from '../../src/core/markdown-chunks.ts';
import { installFixtureChunks } from './page-projection.ts';
import { withEnv } from './with-env.ts';
import { leanRow } from '../../src/core/search/lean-rows.ts';

export const OFF_PATH_PAGES: Array<{ slug: string; body: string; timeline?: string; frontmatter?: Record<string, unknown> }> = [
  {
    slug: 'chat/session-a',
    body: Array.from({ length: 16 }, (_, i) => `**user:** turn ${i} about the ocelot renewal ${'and the roadmap '.repeat(10)}\n\n**assistant:** answer ${i} ${'owners and timelines '.repeat(10)}`).join('\n\n'),
  },
  {
    slug: 'notes/ocelot-handbook',
    body: `## Overview\n\nThe ocelot program. ${'Background prose for the handbook. '.repeat(30)}\n\n## Pricing\n\nOcelot pricing is tiered. ${'Pricing details repeat here. '.repeat(30)}`,
    timeline: '- 2026-02-01 ocelot pricing changed',
  },
  { slug: 'notes/ocelot-private', body: 'Private ocelot memo body.', frontmatter: { visibility: 'private' } },
  { slug: 'notes/short', body: 'A short ocelot note.' },
];

function ctxOf(engine: BrainEngine, meta: Record<string, unknown>[], overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as never, config: {} as never, logger: console as never, dryRun: false, remote: false, sourceId: 'default',
    emitResponseMeta: (key: string, value: unknown) => { meta.push({ key, value }); },
    ...overrides,
  } as OperationContext;
}

export async function captureOffPath(engine: BrainEngine): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const op = (name: string) => operations.find(o => o.name === name)!;
  const run = async (label: string, name: string, params: Record<string, unknown>, overrides: Partial<OperationContext> = {}) => {
    const meta: Record<string, unknown>[] = [];
    const result = await op(name).handler(ctxOf(engine, meta, overrides), params);
    out[label] = JSON.stringify({ result, meta: meta.map(m => m.key === 'retrieval' ? { ...m, value: withoutCounts(m.value as Record<string, unknown>) } : m) });
  };
  for (const variant of [{}, { return_unit: 'chunk' }]) {
    const tag = Object.keys(variant).length ? ':chunk' : '';
    await run(`search${tag}`, 'search', { query: 'ocelot', ...variant });
    await run(`search-remote${tag}`, 'search', { query: 'ocelot pricing', ...variant }, { remote: true });
    await run(`search-subagent${tag}`, 'search', { query: 'ocelot', ...variant }, { viaSubagent: true } as Partial<OperationContext>);
    await run(`query${tag}`, 'query', { query: 'ocelot pricing', expand: false, ...variant });
    await run(`query-budget${tag}`, 'query', { query: 'ocelot', expand: false, token_budget: 300, ...variant });
    await run(`query-low${tag}`, 'query', { query: 'ocelot pricing', expand: false, detail: 'low', ...variant });
    await run(`recall${tag}`, 'recall', { query: 'ocelot', ...variant });
    await run(`recall-budget${tag}`, 'recall', { query: 'ocelot', budget_tokens: 1500, budget_policy: 'query_first', ...variant });
  }
  // The stdio dispatcher appends a once-per-process monthly backup notice when GBRAIN_HOME holds a warn
  // backup-status.json (an earlier file's sync or serve leaves one in the shared test home). That notice is host
  // posture, not search output, so the off-path capture runs with the backup check off.
  await withEnv({ GBRAIN_BACKUP_CHECK: '0' }, async () => {
    for (const name of ['search', 'query', 'recall']) {
      const res = await dispatchToolCall(engine, name, { query: 'ocelot', ...(name === 'query' ? { expand: false } : {}) },
        { remote: true, transport: 'stdio', sourceId: 'default' });
      // Agent contract v1 notices (extra prefixed blocks + _meta.gbrain_notices, e.g. degraded_recall on this
      // keyless corpus) are additive and pinned in test/mcp-notice-channels.test.ts; the off path compares the rest.
      // Cat 40 Hard F2's keyword count line and fields and F4's row-date line are additive too
      // (pinned in test/search-keyword-paging.test.ts and test/search-date-labels.test.ts).
      const content = res.content.filter(c => !/^\[gbrain (notice |search\] |dates\] )/.test(c.text));
      const { gbrain_notices: _notices, ...meta } = res._meta ?? {};
      if (meta.retrieval) meta.retrieval = withoutCounts(meta.retrieval as Record<string, unknown>);
      out[`mcp-${name}`] = JSON.stringify({ ...res, content, ...(res._meta ? { _meta: meta } : {}) });
    }
  });
  const prompts: string[] = [];
  await runThink(engine, {
    question: 'ocelot pricing', remote: false, referenceDate: '2026-01-15',
    client: { create: async (params: { messages: unknown[] }) => {
      prompts.push(JSON.stringify(params.messages));
      return { content: [{ type: 'text', text: '{"answer":"ok","citations":[],"gaps":[]}' }], usage: { input_tokens: 1, output_tokens: 1 } };
    } } as never,
  });
  out['think-prompt'] = prompts[0];
  return out;
}

const leanRetrieval = (meta: Record<string, unknown>) => ({ ...meta, rows: 'lean' });

/** Cat 40 Hard F2's additive keyword count fields, compared in test/search-keyword-paging.test.ts instead. */
function withoutCounts(meta: Record<string, unknown>): Record<string, unknown> {
  const { keyword_total: _t, keyword_truncated: _r, keyword_total_capped: _c, ...rest } = meta;
  return rest;
}

/**
 * The cost wave changes remote output on purpose: C1 projects remote
 * search/query rows to lean rows (and reports `rows: "lean"` in the retrieval
 * meta), and C2 serializes MCP content[0] as compact JSON. The frozen
 * pre-feature bytes stay as captured; this applies exactly those two declared
 * transforms to them, so every other byte of the capture is still compared.
 */
export function withCostWave(key: string, frozen: string): string {
  const base = key.replace(/:chunk$/, '');
  if (base === 'search-remote') {
    const v = JSON.parse(frozen) as { result: Record<string, unknown>[]; meta: Array<{ key: string; value: Record<string, unknown> }> };
    return JSON.stringify({
      result: v.result.map(leanRow),
      meta: v.meta.map(m => m.key === 'retrieval' ? { key: m.key, value: leanRetrieval(m.value) } : m),
    });
  }
  if (!base.startsWith('mcp-')) return frozen;
  const res = JSON.parse(frozen) as { content: Array<{ type: string; text: string }>; _meta?: Record<string, Record<string, unknown>> };
  const body = JSON.parse(res.content[0].text);
  const lean = base === 'mcp-search' || base === 'mcp-query';
  res.content[0].text = JSON.stringify(lean ? (body as Record<string, unknown>[]).map(leanRow) : body);
  if (lean && res._meta?.retrieval) res._meta.retrieval = leanRetrieval(res._meta.retrieval);
  return JSON.stringify(res);
}

export async function seedOffPath(engine: BrainEngine, pages = OFF_PATH_PAGES): Promise<void> {
  for (const p of pages) {
    await engine.putPage(p.slug, { type: 'note', title: p.slug, compiled_truth: p.body, timeline: p.timeline ?? '', frontmatter: p.frontmatter ?? {} });
    await installFixtureChunks(engine, p.slug, await prepareMarkdownChunks({ compiled_truth: p.body, timeline: p.timeline ?? '' }));
  }
  await engine.setConfig('search.mcp_keyword_only', 'true');
  // Answer ids are minted per call, so the frozen off-path output is captured with retrieval feedback off.
  await engine.setConfig('feedback.enabled', 'false');
}
