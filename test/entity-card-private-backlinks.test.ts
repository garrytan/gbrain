/**
 * The entity card (entity, context_pack, delta) must not disclose inbound
 * links from pages a remote caller cannot read: a `visibility: private`
 * page, a derived page (private by default), a soft-deleted page, or an edge
 * whose origin page is private. Such an edge carries the hidden page's slug
 * and a sentence of its body in `links.context`, and it must not be counted
 * in `backlink_count` either. get_backlinks already hides them; the card
 * must agree with it on every transport, while the trusted local caller
 * keeps seeing everything. (gbrain-evals N6 visibility-leak-fuzz, bug 1.)
 *
 * Synthetic data only.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

let engine: PGLiteEngine;
const config = { engine: 'pglite' } as any;

const put = (slug: string, content: string) =>
  dispatchToolCall(engine, 'put_page', { slug, content }, { remote: false, sourceId: 'default', config });

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await put('notes/hub', '---\ntitle: Hub\ntype: note\n---\nTeam hub.\n');
  await put('notes/public-ref', '---\ntitle: Public ref\ntype: note\n---\nPUBLICMARKER agenda. See [[notes/hub]].\n');
  await put('notes/secret', '---\ntitle: Secret\ntype: note\nvisibility: private\n---\nSECRETMARKER layoff plan. See [[notes/hub]].\n');
  await put('atoms/derived-note', '---\ntitle: Derived\ntype: atom\n---\nATOMMARKER derived claim. See [[notes/hub]].\n');
  await put('notes/deleted-ref', '---\ntitle: Deleted ref\ntype: note\n---\nDELETEDMARKER old memo. See [[notes/hub]].\n');
  await engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE slug = 'notes/deleted-ref'`);
  // A public page whose edge to the hub was authored by a private page.
  await put('notes/relay', '---\ntitle: Relay\ntype: note\n---\nRelay page.\n');
  await engine.executeRaw(
    `INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source, origin_page_id)
     SELECT r.id, h.id, 'mentions', 'ORIGINMARKER relayed sentence', 'frontmatter', s.id
       FROM pages r, pages h, pages s
      WHERE r.slug = 'notes/relay' AND h.slug = 'notes/hub' AND s.slug = 'notes/secret'`,
  );
});

afterAll(async () => {
  await engine.disconnect();
});

const HIDDEN = ['notes/secret', 'SECRETMARKER', 'atoms/derived-note', 'ATOMMARKER', 'notes/deleted-ref', 'DELETEDMARKER', 'ORIGINMARKER'];

const remoteCallers = {
  stdio: { remote: true, transport: 'stdio' as const, sourceId: 'default', takesHoldersAllowList: ['world'], config },
  http: {
    remote: true,
    transport: 'http' as const,
    sourceId: 'default',
    takesHoldersAllowList: ['world'],
    config,
    auth: { token: 't', clientId: 'c', scopes: ['read'], allowedSources: ['default'] } as any,
  },
};

async function call(op: string, args: Record<string, unknown>, opts: Record<string, unknown>) {
  const r = await dispatchToolCall(engine, op, args, opts as any);
  expect(r.isError).toBeFalsy();
  return r.content[0].text;
}

describe('entity card inbound edges respect private visibility', () => {
  for (const [name, opts] of Object.entries(remoteCallers)) {
    test(`${name}: entity hides private, derived, deleted and private-origin backlinks and does not count them`, async () => {
      const text = await call('entity', { name: 'notes/hub' }, opts);
      for (const marker of HIDDEN) expect(text).not.toContain(marker);
      const card = JSON.parse(text).card;
      expect(card.edges.filter((e: any) => e.direction === 'in').map((e: any) => e.slug)).toEqual(['notes/public-ref']);
      expect(card.backlink_count).toBe(1);
    });

    test(`${name}: context_pack hides the same edges`, async () => {
      const text = await call('context_pack', { entities: 'notes/hub' }, opts);
      for (const marker of HIDDEN) expect(text).not.toContain(marker);
      expect(text).toContain('notes/public-ref');
    });

    test(`${name}: entity card inbound edges agree with get_backlinks`, async () => {
      const card = JSON.parse(await call('entity', { name: 'notes/hub' }, opts)).card;
      const backlinks = JSON.parse(await call('get_backlinks', { slug: 'notes/hub' }, opts));
      const fromBacklinks = new Set(backlinks.map((l: any) => l.from_slug));
      for (const e of card.edges.filter((e: any) => e.direction === 'in')) expect(fromBacklinks.has(e.slug)).toBe(true);
    });
  }

  test('local caller still sees private and derived backlinks (soft-deleted stay hidden)', async () => {
    const text = await call('entity', { name: 'notes/hub' }, { remote: false, sourceId: 'default', config });
    const card = JSON.parse(text).card;
    const inbound = card.edges.filter((e: any) => e.direction === 'in').map((e: any) => e.slug).sort();
    expect(inbound).toEqual(['atoms/derived-note', 'notes/public-ref', 'notes/relay', 'notes/secret']);
    expect(card.backlink_count).toBe(4);
    expect(text).not.toContain('DELETEDMARKER');
  });
});
