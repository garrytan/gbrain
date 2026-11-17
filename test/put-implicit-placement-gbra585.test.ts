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

const note = (title: string) => ['---', 'type: note', 'title: ' + title, '---', '# ' + title, '', 'Board prep ' + randomUUID()].join('\n');

describe('a local put that names no source says where its page went (company brain, PGLite)', () => {
  let engine: BrainEngine;
  let dir: string;
  const env = process.env.GBRAIN_NO_SOLE_NON_DEFAULT_NUDGE;

  async function put(slug: string, opts: { sourceId: string; implicit?: boolean }) {
    const out = await dispatchToolCall(engine, 'put_page', { slug, content: note(slug), request_id: randomUUID() },
      { remote: false, sourceId: opts.sourceId, ...(opts.implicit ? { localSourceImplicit: true } : {}), takesHoldersAllowList: ['world'] });
    if (out.isError) throw new Error(out.content.map(c => c.text).join('\n'));
    return JSON.parse(out.content.map(c => c.text).join('\n')) as { source_id: string; placement?: { source_id: string; picked_by: string; readers: unknown; note: string } };
  }

  beforeAll(async () => {
    process.env.GBRAIN_NO_SOLE_NON_DEFAULT_NUDGE = '1';
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
    if (env === undefined) delete process.env.GBRAIN_NO_SOLE_NON_DEFAULT_NUDGE; else process.env.GBRAIN_NO_SOLE_NON_DEFAULT_NUDGE = env;
  }, 60_000);

  test('the first unsourced put routes to company as before, and says so and who reads it', async () => {
    const routed = await resolveSourceWithTier(engine, null, dir);
    expect(routed).toMatchObject({ source_id: 'company', tier: 'sole_non_default' });
    const out = await put('notes/owner-board-prep', { sourceId: routed.source_id, implicit: true });
    expect(out.source_id).toBe('company');
    expect(out.placement).toMatchObject({ source_id: 'company', picked_by: 'sole_non_default', readers: 'every_source_reader' });
    expect(out.placement!.note).toContain("went to source 'company'");
    expect(out.placement!.note).toContain('gbrain sources federate company');
    expect(out.placement!.note).toContain('--source <id>');
    expect(out.placement!.note).toContain('readable_by');
  }, 120_000);

  test('a put that named its source, and a remote put, carry no placement', async () => {
    expect((await put('notes/named-source', { sourceId: 'company' })).placement).toBeUndefined();
    const written = { status: 'created_or_updated', slug: 'notes/named-source', source_id: 'company' };
    expect(await withImplicitPlacement({ engine, remote: true, localSourceImplicit: true }, 'company', { slug: 'notes/named-source' }, written)).toBe(written);
  }, 120_000);

  test("once 'default' holds a page, an unsourced put goes to default and says every member reads it", async () => {
    await put('notes/team-roadmap', { sourceId: 'default' });
    const routed = await resolveSourceWithTier(engine, null, dir);
    expect(routed).toMatchObject({ source_id: 'default', tier: 'seed_default' });
    const out = await put('notes/owner-later', { sourceId: routed.source_id, implicit: true });
    expect(out.placement).toMatchObject({ source_id: 'default', picked_by: 'seed_default', readers: 'every_source_reader' });
    expect(out.placement!.note).toContain('a member key with no source grant does');
  }, 120_000);

  test('a page that names its readers lists them', async () => {
    const out = await dispatchToolCall(engine, 'put_page', { slug: 'notes/for-alice', request_id: randomUUID(),
      content: ['---', 'type: note', 'title: For alice', 'readable_by: [alice-example]', '---', '# For alice'].join('\n') },
      { remote: false, sourceId: 'default', localSourceImplicit: true, takesHoldersAllowList: ['world'] });
    const doc = JSON.parse(out.content.map(c => c.text).join('\n')) as { placement?: { readers: unknown; note: string } };
    expect(doc.placement?.readers).toEqual(['alice-example']);
    expect(doc.placement?.note).toContain('Members who may read it: alice-example.');
  }, 120_000);

  test('a brain that serves one person gets no placement', async () => {
    await engine.setConfig('access.serves', 'one');
    try {
      expect((await put('notes/personal', { sourceId: 'default', implicit: true })).placement).toBeUndefined();
    } finally {
      await engine.setConfig('access.serves', 'several');
    }
  }, 120_000);
});
