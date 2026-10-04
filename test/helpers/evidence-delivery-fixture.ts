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
    out[label] = JSON.stringify({ result, meta });
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
      const content = res.content.filter(c => !c.text.startsWith('[gbrain notice '));
      const { gbrain_notices: _notices, ...meta } = res._meta ?? {};
      out[`mcp-${name}`] = JSON.stringify({ ...res, content, ...(res._meta ? { _meta: meta } : {}) });
    }
  });
  const prompts: string[] = [];
  await runThink(engine, {
    question: 'ocelot pricing', remote: false,
    client: { create: async (params: { messages: unknown[] }) => {
      prompts.push(JSON.stringify(params.messages));
      return { content: [{ type: 'text', text: '{"answer":"ok","citations":[],"gaps":[]}' }], usage: { input_tokens: 1, output_tokens: 1 } };
    } } as never,
  });
  out['think-prompt'] = prompts[0];
  return out;
}

export async function seedOffPath(engine: BrainEngine, pages = OFF_PATH_PAGES): Promise<void> {
  for (const p of pages) {
    await engine.putPage(p.slug, { type: 'note', title: p.slug, compiled_truth: p.body, timeline: p.timeline ?? '', frontmatter: p.frontmatter ?? {} });
    await installFixtureChunks(engine, p.slug, await prepareMarkdownChunks({ compiled_truth: p.body, timeline: p.timeline ?? '' }));
  }
  await engine.setConfig('search.mcp_keyword_only', 'true');
}
