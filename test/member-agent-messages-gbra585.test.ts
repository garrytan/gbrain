/**
 * GBRA-585 item 13: refusals a member's agent gets point the right way, and say nothing about pages it cannot read.
 *
 * 1. Protects: (a) a member-bound remote caller's page_not_found reads the same for a missing page and a page kept to
 *    another member, says it may not exist or may not be readable by this connection, and carries no soft-delete chase
 *    and no host CLI command; an unbound stdio caller keeps the soft-delete check. (b) sources_not_readable says what it
 *    checked: pages every reader of the source can read, so a member whose own pages sit in default is not told that
 *    default holds no page. (c) a blocked remember share:true onto an entity page this connection cannot read keeps its
 *    frozen code (unavailable) with page_not_found as its canonical code, and points at saving without share instead of
 *    gbrain doctor.
 * 2. Fails when: a member is sent to include_deleted or a host command, the restricted and missing replies differ, the
 *    sources_not_readable message claims the readable sources hold no page, or the share refusal points at doctor.
 * 3. Real seams: member-bound legacy tokens (as setup --serves several mints), MCP dispatch as a remote HTTP caller,
 *    a repo-less PGLite brain with a non-federated second source.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';

let engine: BrainEngine;
const tokens: Record<string, string> = {};
const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

async function call(who: string, op: string, params: Record<string, unknown>) {
  const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
  const out = await dispatchToolCall(engine, op, { ...params }, { remote: true, transport: 'http', auth, sourceId: 'default', takesHoldersAllowList: ['world'] });
  const text = out.content.map(c => c.text).join('\n');
  let json: Record<string, any> = {};
  try { json = JSON.parse(out.content[0]!.text); } catch { /* prose */ }
  return { isError: out.isError === true, text, json };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
  __resetPrivateVisibilityCacheForTests();
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('company', 'company') ON CONFLICT (id) DO NOTHING");
  for (const id of ['alice-example', 'bob-example']) await addMember(engine, id);
  await importFromContent(engine, 'companies/initech-example', '---\ntype: company\ntitle: Initech Example\nreadable_by: [bob-example]\n---\n# Initech Example\n\nKept to bob-example.', { sourceId: 'default', noEmbed: true });
  await importFromContent(engine, 'notes/alice-pricing-idea', '---\ntitle: Pricing idea\nreadable_by: [alice-example]\n---\n# Pricing idea\n\nalice-example walrusword.', { sourceId: 'default', noEmbed: true });
  await importFromContent(engine, 'notes/team-roadmap', '# Team roadmap\n\nThe team otterword roadmap.', { sourceId: 'company', noEmbed: true });
  for (const m of ['alice', 'bob']) {
    const minted = await mintLegacyToken(engine, { name: `member-${m}-example`, scopes: ['read', 'write'], takesHolders: ['world'] });
    await bindCredential(engine, { kind: 'token', id: minted.id }, { member: `${m}-example` });
    tokens[m] = minted.token;
  }
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

describe('member-facing refusals (GBRA-585 item 13)', () => {
  test('(a) a member reads the same not-found for a missing page and a page kept to another member, with no deletion chase or host command', async () => {
    expect((await call('bob', 'get_page', { slug: 'companies/initech-example' })).isError).toBe(false);
    const restricted = await call('alice', 'get_page', { slug: 'companies/initech-example' });
    const missing = await call('alice', 'get_page', { slug: 'companies/initrode-example' });
    for (const r of [restricted, missing]) {
      expect(r.isError).toBe(true);
      expect(r.json.code).toBe('page_not_found');
      expect(r.text).not.toContain('soft-deleted');
      expect(r.text).not.toContain('include_deleted');
      expect(r.json.fix?.argv).toBeUndefined();
      expect(r.json.suggestion).toContain('may not exist');
      expect(r.json.suggestion).toContain('not be readable by this connection');
    }
    const strip = (r: typeof restricted) => JSON.stringify({ ...r.json, message: undefined }).replaceAll('initech', 'X').replaceAll('initrode', 'X');
    expect(strip(restricted)).toBe(strip(missing));
    const stdio = await dispatchToolCall(engine, 'get_page', { slug: 'companies/initrode-example' }, { remote: true, transport: 'stdio', sourceId: 'default', takesHoldersAllowList: ['world'] });
    expect(JSON.parse(stdio.content[0]!.text).suggestion).toContain('include_deleted');
  });

  test('(b) sources_not_readable says it counted pages every reader of the source can read, not that the source holds none', async () => {
    expect((await call('alice', 'search', { query: 'walrusword' })).text).toContain('notes/alice-pricing-idea');
    const out = await call('alice', 'search', { query: 'otterword' });
    expect(out.isError).toBe(true);
    expect(out.json.code).toBe('sources_not_readable');
    expect(out.json.message).not.toMatch(/none of them holds a page,|could only come back empty/);
    expect(out.json.message).toContain('every reader');
    expect(out.text).not.toContain('company');
  });

  test('(c) a share onto an entity page this connection cannot read keeps code unavailable, names page_not_found and never points at doctor', async () => {
    const out = await call('alice', 'remember', { fact: 'Initech example CFO is unhappy', entity: 'companies/initech-example', provenance: 'heard from bob-example', share: true });
    expect(out.isError).toBe(true);
    expect(out.json.error).toBe('unavailable');
    expect(out.json.code).toBe('page_not_found');
    expect(out.json.write_error).toBe('page_not_found');
    expect(out.text).not.toContain('doctor');
    expect(out.json.suggestion).toContain('without share');
    const kept = await call('alice', 'remember', { fact: 'Initech example CFO is unhappy', entity: 'companies/initech-example', provenance: 'heard from bob-example' });
    expect([kept.isError, kept.json.status]).toEqual([false, 'inserted']);
    expect((await engine.executeRaw<Record<string, unknown>>('SELECT visibility, source_markdown_slug FROM facts WHERE id = $1', [Number(kept.json.id)]))[0])
      .toEqual({ visibility: 'private', source_markdown_slug: 'memory/members/alice-example' });
  });
});
