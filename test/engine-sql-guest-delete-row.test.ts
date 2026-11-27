/**
 * readGuestDeleteRow (engine-sql/cli-reads-import.ts) and the remote guest-delete check that reads it
 * (guests/admission.ts refuseRemoteGuestDelete), on PGLite and on Postgres with DATABASE_URL.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: for one page by source and slug, the read answers whether row-level security hides guest_sources, whether
 *    the page's source is a guest source (a guest_sources row), whether the owner kept the page (a guest_promotions row)
 *    and the `<kind>:<id>` writer of its guest mark. A page that does not exist answers all false with no writer. The
 *    check refuses a remote delete of a kept page `guest_page_promoted` and of another writer's note `permission_denied`,
 *    and lets the writer's own note, an unmarked plain page and a missing page through.
 *  - Regression: the check ran its own raw SQL, so an engine without SQL (the Rust store) refused every remote delete;
 *    it now reads one typed member every engine implements. A read that joined the wrong page, dropped the promotion or
 *    spelled the writer differently changes who may delete what.
 *  - Why existing coverage misses it: test/guest-notes-delete-rights.test.ts and guest-notes-promotion.test.ts drive the
 *    whole delete on PGLite only, and the parity file (engine-parity/cli-reads-import.test.ts) cannot seed guest records,
 *    which the Rust store does not keep.
 *  - Seam: the guest records are seeded with executeRaw after the pages (a guest source takes pages only through a guest
 *    put, and a guest mark and a promotion are written only by that put and by promote_guest_note, which need an OAuth or
 *    token writer); the read and the check run through the engine.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { refuseRemoteGuestDelete } from '../src/core/guests/admission.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const GUESTS = 'guests';
const PLAIN = 'plain';
const WRITER = { kind: 'legacy_token', id: 'writer-a' } as const;
const OTHER = { kind: 'oauth_client', id: 'writer-b' } as const;
const NOTE = (title: string) => ({ type: 'note' as never, title, compiled_truth: `${title} body.`, timeline: '', frontmatter: {} });

for (const kind of testBackends()) {
  describe(`readGuestDeleteRow and the remote guest-delete check (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const mark = async (slug: string, writer: { kind: string; id: string }) => {
      await engine.executeRaw(`INSERT INTO guest_marks (page_id, source_id, slug_at_write, audience_member, group_slug, sender_label, saved_at, writer_kind, writer_id)
        SELECT p.id, p.source_id, p.slug, 'bob-example', 'team-a', 'Bob Example', now(), $3, $4 FROM pages p WHERE p.source_id = $1 AND p.slug = $2`, [GUESTS, slug, writer.kind, writer.id]);
    };
    const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => String((e as { code?: string }).code ?? (e as Error).message));

    beforeAll(async () => {
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      for (const id of [GUESTS, PLAIN]) await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [id]);
      for (const slug of ['notes/own', 'notes/theirs', 'notes/kept', 'notes/unmarked']) await engine.putPage(slug, NOTE(slug), { sourceId: GUESTS });
      // The pages exist before the source becomes a guest source: a guest source takes pages only through a guest put.
      await engine.executeRaw('INSERT INTO guest_sources (source_id, writers) VALUES ($1, $2::text[])', [GUESTS, [`${WRITER.kind}:${WRITER.id}`]]);
      await engine.putPage('notes/plain', NOTE('plain'), { sourceId: PLAIN });
      await mark('notes/own', WRITER);
      await mark('notes/theirs', OTHER);
      await mark('notes/kept', WRITER);
      await engine.executeRaw(`INSERT INTO guest_promotions (guest_page_id, target_source_id, target_slug, promoted_by_kind, promoted_by_id)
        SELECT p.id, $3, 'notes/kept-owner', 'local_cli', 'owner' FROM pages p WHERE p.source_id = $1 AND p.slug = $2`, [GUESTS, 'notes/kept', PLAIN]);
    }, 120_000);
    afterAll(async () => { await close?.(); });

    test('the read answers the guest source, the promotion and the guest mark writer of one page', async () => {
      const rows = {
        own: await engine.readGuestDeleteRow(GUESTS, 'notes/own'),
        theirs: await engine.readGuestDeleteRow(GUESTS, 'notes/theirs'),
        kept: await engine.readGuestDeleteRow(GUESTS, 'notes/kept'),
        unmarked: await engine.readGuestDeleteRow(GUESTS, 'notes/unmarked'),
        plain: await engine.readGuestDeleteRow(PLAIN, 'notes/plain'),
        wrongSource: await engine.readGuestDeleteRow(PLAIN, 'notes/own'),
        missing: await engine.readGuestDeleteRow(GUESTS, 'notes/missing'),
      };
      const none = { hidden: false, guest: false, kept: false, writer: null };
      expect(rows).toEqual({
        own: { hidden: false, guest: true, kept: false, writer: 'legacy_token:writer-a' },
        theirs: { hidden: false, guest: true, kept: false, writer: 'oauth_client:writer-b' },
        kept: { hidden: false, guest: true, kept: true, writer: 'legacy_token:writer-a' },
        unmarked: { hidden: false, guest: true, kept: false, writer: null },
        plain: none, wrongSource: none, missing: none,
      });
    });

    test('the check refuses a kept page and another writer\'s note, and lets the own note, a plain page and a missing page through', async () => {
      const out = {
        own: await codeOf(refuseRemoteGuestDelete(engine, GUESTS, 'notes/own', WRITER)),
        theirs: await codeOf(refuseRemoteGuestDelete(engine, GUESTS, 'notes/theirs', WRITER)),
        theirsByThem: await codeOf(refuseRemoteGuestDelete(engine, GUESTS, 'notes/theirs', OTHER)),
        kept: await codeOf(refuseRemoteGuestDelete(engine, GUESTS, 'notes/kept', WRITER)),
        unmarked: await codeOf(refuseRemoteGuestDelete(engine, GUESTS, 'notes/unmarked', WRITER)),
        plain: await codeOf(refuseRemoteGuestDelete(engine, PLAIN, 'notes/plain', WRITER)),
        missing: await codeOf(refuseRemoteGuestDelete(engine, GUESTS, 'notes/missing', WRITER)),
      };
      expect(out).toEqual({ own: 'ok', theirs: 'permission_denied', theirsByThem: 'ok', kept: 'guest_page_promoted', unmarked: 'permission_denied', plain: 'ok', missing: 'ok' });
    });

    test('the check runs in a transaction, as the delete\'s publication calls it', async () => {
      const out = await engine.transaction(async tx => ({
        own: await codeOf(refuseRemoteGuestDelete(tx, GUESTS, 'notes/own', WRITER)),
        kept: await codeOf(refuseRemoteGuestDelete(tx, GUESTS, 'notes/kept', WRITER)),
      }));
      expect(out).toEqual({ own: 'ok', kept: 'guest_page_promoted' });
    });
  });
}
