/**
 * Standing rules on a keyless solo brain (GST-4031): with no owner configured and no access members, the brain has one
 * user, so an unbound caller (a stdio MCP server or a token bound to no member) saves a scope me correction as a
 * private proposal the host approves, as it did before #10497. A brain with members keeps refusing a member-less me rule
 * (test/correct-rules-trust-hardening.test.ts).
 *
 * Keyless repo-less PGLite brain, no model calls (tripwire). Synthetic names only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { addMember } from '../src/core/access/members.ts';
import { approveRule } from '../src/core/rules/correct.ts';
import { rulesSectionFor } from '../src/core/rules/section.ts';
import { CONFIRM_CODE_LENGTH, type TerminalProbe } from '../src/core/policy/authority.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { installTripwire, type Tripwire } from './helpers/ai-tripwire.ts';

let engine: PGLiteEngine;
let tripwire: Tripwire;
let token = '';

const ownerTty = (): TerminalProbe => ({ env: {}, stdinIsTTY: true, stderrIsTTY: true,
  readAnswer: async prompt => /Type ([0-9a-f]+) /.exec(prompt)![1]!.slice(0, CONFIRM_CODE_LENGTH) });
const parse = (out: { content: Array<{ text: string }>; isError?: boolean }) => {
  const text = out.content.map(c => c.text).join('\n');
  let json: any = {};
  try { json = JSON.parse(text); } catch { /* prose */ }
  return { isError: out.isError === true, json };
};
const stdio = (params: Record<string, unknown>) => dispatchToolCall(engine, 'correct', params, { remote: true, transport: 'stdio', sourceId: 'default' } as never).then(parse);
async function viaToken(params: Record<string, unknown>) {
  const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  const auth = await provider.verifyAccessToken(token) as unknown as AuthInfo;
  return parse(await dispatchToolCall(engine, 'correct', params, { remote: true, transport: 'http', auth, sourceId: 'default', takesHoldersAllowList: ['world'], inboundFrameBytes: 4 * 1024 * 1024 } as never));
}
const frontmatter = async (slug: string) => (await engine.getPage(slug, { sourceId: 'default' }))?.frontmatter as Record<string, unknown> | undefined;
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = () => true;
  try { return await fn(); } finally { (process.stderr as any).write = orig; }
};

beforeAll(async () => {
  tripwire = installTripwire();
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  token = (await mintLegacyToken(engine, { name: 'solo-agent', scopes: ['read', 'write'], takesHolders: ['world'] })).token;
}, 120_000);

afterAll(async () => {
  tripwire.dispose();
  await engine.disconnect();
});

describe('correct on a keyless solo brain with no owner (GST-4031)', () => {
  test('an unbound stdio caller saves a private me proposal that loads on the host once approved', async () => {
    const r = await stdio({ rule: 'Keep status notes to three lines.' });
    expect({ isError: r.isError, state: r.json.state, scope: r.json.scope }).toEqual({ isError: false, state: 'proposed', scope: 'me' });
    const fm = await frontmatter('rules/' + r.json.rule_id);
    expect({ visibility: fm?.visibility, readable_by: fm?.readable_by }).toEqual({ visibility: 'private', readable_by: undefined });
    expect((await quiet(() => approveRule(engine, r.json.rule_id + '@' + r.json.revision, { probe: ownerTty() }))).approved).toBe(true);
    expect((await rulesSectionFor(engine, { remote: false, sourceId: 'default' }))?.text).toContain('Keep status notes to three lines.');
  });

  test('a token bound to no member saves a private me proposal too', async () => {
    const r = await viaToken({ rule: 'Dates are written as year-month-day.', scope: 'me' });
    expect({ isError: r.isError, state: r.json.state }).toEqual({ isError: false, state: 'proposed' });
    expect((await frontmatter('rules/' + r.json.rule_id))?.visibility).toBe('private');
  });

  test('once the brain has a member, a member-less me rule is refused again', async () => {
    await addMember(engine, 'dana-example', { remote: false });
    const r = await stdio({ rule: 'Meetings end five minutes early.' });
    expect({ isError: r.isError, code: r.json.code }).toEqual({ isError: true, code: 'invalid_params' });
  });
});
