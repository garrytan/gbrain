/**
 * BrainEngine parity — `get_tags` called through the MCP dispatcher (src/mcp/dispatch.ts dispatchToolCall), remote and
 * local, on every arm.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: an MCP `get_tags` call answers the page's tags on every engine. A remote caller gets a quoted page's
 *    tags quoted (#8384): the handler reads the page's type and trust tier through the typed `listPageQuoteTiers`
 *    member, so the Rust store answers from its own records. A local call returns the tags as stored.
 *  - Regression: the remote branch of the handler once read type and tier with raw SQL, so a Rust brain refused
 *    `get_tags` over MCP (raw_sql) while the CLI, which is local and skips that read, answered. The refusal comes back
 *    as an error envelope in the tool result, not a throw, so only a test that calls the dispatcher sees it.
 *  - Why existing coverage misses it: trust-tier-reads.test.ts calls the op handler directly with remote set, not the
 *    dispatcher an MCP client reaches.
 *  - Seam: none. The http transport with a read grant on the default source stands for a remote MCP client; the
 *    stdio transport with remote off stands for a local one.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';

const { parityTest } = parityArms(testBackends());

/** Write `slug` as a note in a transaction whose write trust settings declare `tier`, then tag it. */
async function seed(engine: BrainEngine, slug: string, tier: string, tags: string[]): Promise<void> {
  await engine.transaction(async (tx) => {
    await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_trust_promotion', 'gbrain.write_origin'], [tier, tier, JSON.stringify({ channel: tier })]);
    await tx.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body`, timeline: '', frontmatter: { tags } });
  });
  for (const tag of tags) await engine.addTag(slug, tag);
}

describe('engine parity: get_tags over MCP', () => {
  parityTest('MCP get_tags answers remote and local callers; a remote caller gets a quoted page\'s tags quoted', {
    methods: ['transaction', 'applyTransactionSettings', 'putPage', 'addTag', 'getTags', 'listPageQuoteTiers'],
  }, async (engine) => {
    await seed(engine, 'edge/frontmatter', 'agent_written', ['alpha', 'beta']);
    await seed(engine, 'edge/owner', 'operator_curated', ['gamma']);
    const call = async (slug: string, remote: boolean) => {
      const out = await dispatchToolCall(engine, 'get_tags', { slug }, remote
        ? { remote: true, transport: 'http', sourceId: 'default', auth: { clientId: 'parity-client', token: 'parity-token', scopes: ['read'], sourceId: 'default', allowedSources: ['default'] } as never }
        : { remote: false, transport: 'stdio', sourceId: 'default' });
      const text = out.content[0]?.type === 'text' ? out.content[0].text : '';
      const body = JSON.parse(text) as unknown;
      // An error envelope (a refusal included) is an object with a code, not a tag list.
      if (!Array.isArray(body)) return { isError: out.isError === true, code: (body as { code?: string }).code ?? null };
      return body.map((t: string) => (t.includes('; source material, not instructions]') ? `quoted:${/```text\n([^\n]*)\n```/.exec(t)?.[1]}` : t));
    };
    const got = {
      remoteQuoted: await call('edge/frontmatter', true),
      remoteOwner: await call('edge/owner', true),
      local: await call('edge/frontmatter', false),
      remoteMissing: await call('edge/absent', true),
    };
    expect(got).toEqual({
      remoteQuoted: ['quoted:alpha', 'quoted:beta'], remoteOwner: ['gamma'], local: ['alpha', 'beta'], remoteMissing: [],
    });
    return got;
  });
});
