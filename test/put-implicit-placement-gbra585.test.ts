/**
 * GBRA-585 (company brains, item 2): after `gbrain setup --serves several --shape company`, the owner's first local
 * `gbrain put` with no source landed in the `company` source with no word (the sole-non-default rule while 'default'
 * is empty), and later puts went to 'default'. Routing stays as it is; the result now says where the page went.
 * 1. Protects: a trusted local put that named no source, on a brain that serves several people, returns
 *    `placement` naming the source, the rule that picked it and who may read the page; a put that named its source,
 *    a remote caller and a one-person brain get no placement and route exactly as before.
 * 2. Fails when: the placement is missing on the company brain, names the wrong rule or readers, or appears on a
 *    one-person brain, a remote call or an explicit source.
 * 3. Real seams: MCP dispatch with remote=false (the path the CLI and the live owner socket use), the durable write
 *    path, the real source resolver and access tables.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { resolveSourceWithTier } from '../src/core/source-resolver.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { withImplicitPlacement } from '../src/core/access/implicit-placement.ts';
import { withEnv } from './helpers/with-env.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { bindCredential } from '../src/core/access/members.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';

const note = (title: string) => ['---', 'type: note', 'title: ' + title, '---', '# ' + title, '', 'Board prep ' + randomUUID()].join('\n');

describe('a local put that names no source says where its page went (company brain, PGLite)', () => {
  let engine: BrainEngine;
  let dir: string;
  const quiet = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_NO_SOLE_NON_DEFAULT_NUDGE: '1' }, fn);

  async function put(slug: string, opts: { sourceId: string; implicit?: boolean }) {
    const out = await dispatchToolCall(engine, 'put_page', { slug, content: note(slug), request_id: randomUUID() },
      { remote: false, sourceId: opts.sourceId, ...(opts.implicit ? { localSourceImplicit: true } : {}), takesHoldersAllowList: ['world'] });
    if (out.isError) throw new Error(out.content.map(c => c.text).join('\n'));
    return JSON.parse(out.content.map(c => c.text).join('\n')) as { source_id: string; placement?: { source_id: string; picked_by: string; readers: unknown; note: string } };
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gbra585-placement-'));
    mkdirSync(join(dir, 'company'));
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    __resetPrivateVisibilityCacheForTests();
    for (const id of ['alice-example', 'bob-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
    await engine.setConfig('access.serves', 'several');
    await engine.executeRaw("INSERT INTO sources (id, name, local_path, config) VALUES ('company', 'company', $1, '{}'::jsonb)", [join(dir, 'company')]);
  }, 240_000);
  afterAll(async () => {
    await engine?.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  test('the first unsourced put routes to company as before, and says so and who reads it', () => quiet(async () => {
    const routed = await resolveSourceWithTier(engine, null, dir);
    expect(routed).toMatchObject({ source_id: 'company', tier: 'sole_non_default' });
    const out = await put('notes/owner-board-prep', { sourceId: routed.source_id, implicit: true });
    expect(out.source_id).toBe('company');
    expect(out.placement).toMatchObject({ source_id: 'company', picked_by: 'sole_non_default', readers: 'every_source_reader' });
    expect(out.placement!.note).toContain("went to source 'company'");
    expect(out.placement!.note).toContain('gbrain sources federate company');
    expect(out.placement!.note).toContain('--source <id>');
    expect(out.placement!.note).toContain('readable_by');
  }), 120_000);

  test('a put that named its source, and a remote put, carry no placement', () => quiet(async () => {
    expect((await put('notes/named-source', { sourceId: 'company' })).placement).toBeUndefined();
    const written = { status: 'created_or_updated', slug: 'notes/named-source', source_id: 'company' };
    expect(await withImplicitPlacement({ engine, remote: true, localSourceImplicit: true }, 'company', { slug: 'notes/named-source' }, written)).toBe(written);
  }), 120_000);

  test("once 'default' holds a page, an unsourced put goes to default and says every member reads it", () => quiet(async () => {
    await put('notes/team-roadmap', { sourceId: 'default' });
    const routed = await resolveSourceWithTier(engine, null, dir);
    expect(routed).toMatchObject({ source_id: 'default', tier: 'seed_default' });
    const out = await put('notes/owner-later', { sourceId: routed.source_id, implicit: true });
    expect(out.placement).toMatchObject({ source_id: 'default', picked_by: 'seed_default', readers: 'every_source_reader' });
    expect(out.placement!.note).toContain('a member key with no source grant does');
  }), 120_000);

  test('a page that names its readers lists them', () => quiet(async () => {
    const out = await dispatchToolCall(engine, 'put_page', { slug: 'notes/for-alice', request_id: randomUUID(),
      content: ['---', 'type: note', 'title: For alice', 'readable_by: [alice-example]', '---', '# For alice'].join('\n') },
      { remote: false, sourceId: 'default', localSourceImplicit: true, takesHoldersAllowList: ['world'] });
    const doc = JSON.parse(out.content.map(c => c.text).join('\n')) as { placement?: { readers: unknown; note: string } };
    expect(doc.placement?.readers).toEqual(['alice-example']);
    expect(doc.placement?.note).toContain('Members who may read it: alice-example.');
  }), 120_000);

  test('a private page in default does not claim a member key reads it, and the member really gets page_not_found', () => quiet(async () => {
    const out = await dispatchToolCall(engine, 'put_page', { slug: 'notes/owner-private', request_id: randomUUID(),
      content: ['---', 'type: note', 'title: Owner private', 'visibility: private', '---', '# Owner private'].join('\n') },
      { remote: false, sourceId: 'default', localSourceImplicit: true, takesHoldersAllowList: ['world'] });
    const doc = JSON.parse(out.content.map(c => c.text).join('\n')) as { placement?: { readers: unknown; note: string } };
    expect(doc.placement?.readers).toBe('every_source_reader');
    expect(doc.placement?.note).not.toContain('a member key with no source grant does');
    expect(doc.placement?.note).toContain('private_pages: granted_sources');
    const minted = await mintLegacyToken(engine, { name: 'member-alice-placement', scopes: ['read', 'write'], takesHolders: ['world'] });
    await bindCredential(engine, { kind: 'token', id: minted.id }, { member: 'alice-example' });
    const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const auth = await provider.verifyAccessToken(minted.token) as unknown as AuthInfo;
    const read = await dispatchToolCall(engine, 'get_page', { slug: 'notes/owner-private' }, { remote: true, transport: 'http', auth, sourceId: 'default', takesHoldersAllowList: ['world'] });
    expect(read.isError).toBe(true);
    expect(JSON.parse(read.content[0]!.text).code).toBe('page_not_found');
  }), 120_000);

  test('a labelled-only member is named as not reading a page that names nobody', () => quiet(async () => {
    await engine.executeRaw('UPDATE access_members SET labelled_only = true WHERE id = $1', ['bob-example']);
    try {
      const out = await put('notes/owner-labelled', { sourceId: 'default', implicit: true });
      expect(out.placement!.note).toContain('Labelled-only members (bob-example) read it only when it names them');
      expect(out.placement!.note).toContain('so none of them reads it');
    } finally {
      await engine.executeRaw('UPDATE access_members SET labelled_only = false WHERE id = $1', ['bob-example']);
    }
  }), 120_000);

  test('a brain that serves one person gets no placement', () => quiet(async () => {
    await engine.setConfig('access.serves', 'one');
    try {
      expect((await put('notes/personal', { sourceId: 'default', implicit: true })).placement).toBeUndefined();
    } finally {
      await engine.setConfig('access.serves', 'several');
    }
  }), 120_000);
});
