/**
 * BrainEngine parity — the page visibility guards (engine-sql/page-visibility.ts): whether the caller sees one page,
 * which of a list of pages the caller reads, the opening probe of a remote write's visibility check, and the slug fence
 * a stored writer carries.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: readPageHiddenFromCaller, readCallerPageAccess, readWriteVisibilityProbe and readWriterSlugFence return the same observable result
 *    on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm through test/engine-parity/harness.ts),
 *    under the no-caller rendering and under a caller with a reader identity and a private-readable grant.
 *  - Regression: an engine that answers one of these differently lets a remote write touch a page its caller may not
 *    see (a private page, a page whose readers do not name the caller), reports an unreadable page as readable in the
 *    ingest log, or lets a fenced writer act as the owner on an owner-only source. The Rust engine has no SQL, so each
 *    statement has to exist as a typed member.
 *  - Why existing coverage misses it: these statements ran through `executeRaw` inside persistence/page-visibility.ts,
 *    which the parity cases cannot call (D18).
 *  - Seam: none in the cases. Typed members only (no executeRaw: D18). Access rows are compared in pair order, since
 *    the SQL sets none.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';

const { parityTest } = parityArms(testBackends());

const NOTE = { type: 'note' as const, title: 'Visibility note', compiled_truth: 'A visibility example.', timeline: '' };
const SLUGS = ['notes/vis-open', 'notes/vis-private', 'notes/vis-alice', 'notes/vis-gone'];
const MEMBER = { identity: ['member:alice-example', 'group:team-a'], hidePrivate: true };
const GRANTED = { identity: ['member:alice-example'], privateReadableSources: ['default'], hidePrivate: true };
/** An anonymous remote caller on a brain whose config holds no member-access restriction. */
const UNRESTRICTED = { identity: [], hidePrivate: true, restricted: false };
const WRITER = 'a0000000-0000-4000-8000-0000000000b1';
const FENCED_WRITER = 'a0000000-0000-4000-8000-0000000000b2';
const HASH = 'e'.repeat(64);
const GRANT = { sourceIds: ['*'], operations: null, scopes: ['read', 'write'], slugPrefixes: null };

async function seed(engine: BrainEngine): Promise<void> {
  await engine.putPage('notes/vis-open', NOTE);
  await engine.putPage('notes/vis-private', { ...NOTE, frontmatter: { visibility: 'private' } });
  await engine.putPage('notes/vis-alice', { ...NOTE, frontmatter: { readable_by: ['member:alice-example'] } });
  await engine.putPage('notes/vis-gone', NOTE);
  await engine.softDeletePage('notes/vis-gone');
}

describe('engine parity: page visibility guards', () => {
  parityTest('readPageHiddenFromCaller judges the page row by the read or the member-access policy of the caller', {
    methods: ['putPage', 'softDeletePage', 'readPageHiddenFromCaller'],
  }, async (engine) => {
    await seed(engine);
    const hidden = async (policy: 'read' | 'access') => {
      const out: Record<string, boolean> = {};
      for (const slug of [...SLUGS, 'notes/vis-missing']) out[slug] = await engine.readPageHiddenFromCaller('default', slug, { policy });
      return out;
    };
    const answers = {
      read: await hidden('read'),
      access: await hidden('access'),
      memberRead: await withCallerAccess(MEMBER, () => hidden('read')),
      memberAccess: await withCallerAccess(MEMBER, () => hidden('access')),
      grantedRead: await withCallerAccess(GRANTED, () => hidden('read')),
      otherSource: await engine.readPageHiddenFromCaller('parity-missing', 'notes/vis-private', { policy: 'read' }),
    };
    const row = (open: boolean, priv: boolean, alice: boolean) =>
      ({ 'notes/vis-open': open, 'notes/vis-private': priv, 'notes/vis-alice': alice, 'notes/vis-gone': false, 'notes/vis-missing': false });
    expect(answers).toEqual({
      read: row(false, true, true),
      access: row(false, false, true),
      memberRead: row(false, true, false),
      memberAccess: row(false, false, false),
      grantedRead: row(false, false, false),
      otherSource: false,
    });
    return answers;
  });

  parityTest('readCallerPageAccess names each page row once, readable only when live and allowed', {
    methods: ['putPage', 'softDeletePage', 'readCallerPageAccess'],
  }, async (engine) => {
    await seed(engine);
    const pages = [...SLUGS, 'notes/vis-missing', 'notes/vis-open'].map(slug => ({ source_id: 'default', slug }));
    const read = async (policy: 'read' | 'access') => (await engine.readCallerPageAccess(pages, { policy }))
      .map(r => ({ source_id: r.source_id, slug: r.slug, readable: r.readable }))
      .sort((a, b) => a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
    const row = (slug: string, readable: boolean) => ({ source_id: 'default', slug, readable });
    const answers = {
      read: await read('read'),
      memberRead: await withCallerAccess(MEMBER, () => read('read')),
      memberAccess: await withCallerAccess(MEMBER, () => read('access')),
      empty: await engine.readCallerPageAccess([], { policy: 'read' }),
    };
    expect(answers).toEqual({
      read: [row('notes/vis-alice', false), row('notes/vis-gone', false), row('notes/vis-open', true), row('notes/vis-private', false)],
      memberRead: [row('notes/vis-alice', true), row('notes/vis-gone', false), row('notes/vis-open', true), row('notes/vis-private', false)],
      memberAccess: [row('notes/vis-alice', true), row('notes/vis-gone', false), row('notes/vis-open', true), row('notes/vis-private', true)],
      empty: [],
    });
    return answers;
  });

  parityTest('a caller on a brain with no member-access restriction gets the same answers as the no-caller policy', {
    methods: ['putPage', 'softDeletePage', 'readPageHiddenFromCaller', 'readCallerPageAccess'],
  }, async (engine) => {
    // An anonymous remote request on a brain whose config says no member-access restriction is present renders the
    // short member-access form (restricted: false). No page carries readable_by, so the answers match the no-caller
    // policy: the open page is readable, the private page is hidden by the read policy only.
    await engine.putPage('notes/vis-open', NOTE);
    await engine.putPage('notes/vis-private', { ...NOTE, frontmatter: { visibility: 'private' } });
    await engine.putPage('notes/vis-gone', NOTE);
    await engine.softDeletePage('notes/vis-gone');
    const slugs = ['notes/vis-open', 'notes/vis-private', 'notes/vis-gone', 'notes/vis-missing'];
    const hidden = async (policy: 'read' | 'access') => {
      const out: Record<string, boolean> = {};
      for (const slug of slugs) out[slug] = await engine.readPageHiddenFromCaller('default', slug, { policy });
      return out;
    };
    const access = async (policy: 'read' | 'access') => (await engine.readCallerPageAccess(slugs.map(slug => ({ source_id: 'default', slug })), { policy }))
      .map(r => `${r.slug}:${r.readable}`).sort();
    const answers = await withCallerAccess(UNRESTRICTED, async () => ({
      read: await hidden('read'), access: await hidden('access'), readRows: await access('read'), accessRows: await access('access'),
    }));
    expect(answers).toEqual({
      read: { 'notes/vis-open': false, 'notes/vis-private': true, 'notes/vis-gone': false, 'notes/vis-missing': false },
      access: { 'notes/vis-open': false, 'notes/vis-private': false, 'notes/vis-gone': false, 'notes/vis-missing': false },
      readRows: ['notes/vis-gone:false', 'notes/vis-open:true', 'notes/vis-private:false'],
      accessRows: ['notes/vis-gone:false', 'notes/vis-open:true', 'notes/vis-private:true'],
    });
    return answers;
  });

  parityTest('readWriteVisibilityProbe says what a reader identity could open and which sources are owner-only', {
    methods: ['putPage', 'softDeletePage', 'readWriteVisibilityProbe'],
  }, async (engine, backend) => {
    await seed(engine);
    await engine.putPage('notes/vis-gone-private', { ...NOTE, frontmatter: { visibility: 'private' } });
    await engine.softDeletePage('notes/vis-gone-private');
    const probe = async (sourceId: string, slug: string) => {
      const row = await engine.readWriteVisibilityProbe(sourceId, slug);
      return row && { any_labelled: row.any_labelled, identity_may_open: row.identity_may_open, owner_only_source: row.owner_only_source, owner_only_any: row.owner_only_any };
    };
    const pages = async () => {
      const out: Record<string, unknown> = {};
      for (const slug of [...SLUGS, 'notes/vis-gone-private', 'notes/vis-missing']) out[slug] = (await probe('default', slug))?.identity_may_open;
      return out;
    };
    const before = { pages: await pages(), unrestricted: await withCallerAccess(UNRESTRICTED, pages), owner: await probe('default', 'notes/vis-open') };
    await createSource(engine, backend, 'vis-chat', { kind: 'imessage' });
    await createSource(engine, backend, 'vis-flagged', { owner_only: true });
    await createSource(engine, backend, 'vis-plain', { owner_only: false });
    const after = {
      default: await probe('default', 'notes/vis-open'),
      chat: await probe('vis-chat', 'notes/vis-open'),
      flagged: await withCallerAccess(UNRESTRICTED, () => probe('vis-flagged', 'notes/vis-open')),
      plain: await probe('vis-plain', 'notes/vis-open'),
    };
    const expectedPages = { 'notes/vis-open': null, 'notes/vis-private': false, 'notes/vis-alice': true, 'notes/vis-gone': null, 'notes/vis-gone-private': false, 'notes/vis-missing': null };
    const row = (ownerOnlySource: boolean, ownerOnlyAny: boolean) =>
      ({ any_labelled: false, identity_may_open: null, owner_only_source: ownerOnlySource, owner_only_any: ownerOnlyAny });
    expect({ before, after }).toEqual({
      before: { pages: expectedPages, unrestricted: expectedPages, owner: row(false, false) },
      // The harness brain records no schema version, so the owner-only test takes its closed form: while any source is
      // owner-only, every page counts as owner-only and the empty identity opens none of them.
      after: { default: { ...row(false, true), identity_may_open: false }, chat: row(true, true), flagged: row(true, true), plain: row(false, true) },
    });
    return { before, after };
  });

  parityTest('readWriterSlugFence reads a local writer\'s stored slug prefixes, and null for no writer or no fence', {
    methods: ['insertLocalWriterRow', 'readWriterSlugFence'],
  }, async (engine) => {
    await engine.insertLocalWriterRow({ id: WRITER, lane: 'stdio', credentialHash: HASH, grant: GRANT });
    await engine.insertLocalWriterRow({ id: FENCED_WRITER, lane: 'cli', credentialHash: 'd'.repeat(64), grant: { ...GRANT, slugPrefixes: ['notes/'] } });
    const answers = {
      unfenced: await engine.readWriterSlugFence({ kind: 'local_stdio', id: WRITER }),
      fenced: await engine.readWriterSlugFence({ kind: 'local_cli', id: FENCED_WRITER }),
      unknown: await engine.readWriterSlugFence({ kind: 'local_cli', id: 'a0000000-0000-4000-8000-0000000000b9' }),
      otherKind: await engine.readWriterSlugFence({ kind: 'member', id: WRITER }),
    };
    expect(answers).toEqual({ unfenced: null, fenced: ['notes/'], unknown: null, otherKind: null });
    return answers;
  });
});
