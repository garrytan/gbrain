/**
 * BrainEngine parity — the page visibility guards (engine-sql/page-visibility.ts): whether the caller sees one page,
 * which of a list of pages the caller reads, the opening probe of a remote write's visibility check, and the slug fence
 * a stored writer carries.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: readPageHiddenFromCaller, readPageWorldVisible, readCallerPageAccess, readWriteVisibilityProbe and readWriterSlugFence return the same observable result
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
import { withEngineScope } from '../../src/core/engine-scope.ts';
import { noteSchemaVersion } from '../../src/core/migrate-pending.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';

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

  parityTest('readPageWorldVisible judges the page row by the anonymous read policy, whatever reader identity or grant the caller holds', {
    methods: ['putPage', 'softDeletePage', 'readPageWorldVisible'],
  }, async (engine) => {
    await seed(engine);
    const world = async () => {
      const out: Record<string, boolean> = {};
      for (const slug of [...SLUGS, 'notes/vis-missing']) out[slug] = await engine.readPageWorldVisible('default', slug);
      return out;
    };
    const answers = {
      none: await world(),
      member: await withCallerAccess(MEMBER, world),
      granted: await withCallerAccess(GRANTED, world),
      unrestricted: await withCallerAccess(UNRESTRICTED, world),
      otherSource: await engine.readPageWorldVisible('parity-missing', 'notes/vis-open'),
    };
    // Only the open page is world-visible: a private page, a page with named readers, a soft-deleted page and a missing
    // page are not, and no caller identity or private-readable grant widens the answer.
    const row = { 'notes/vis-open': true, 'notes/vis-private': false, 'notes/vis-alice': false, 'notes/vis-gone': false, 'notes/vis-missing': false };
    expect(answers).toEqual({ none: row, member: row, granted: row, unrestricted: row, otherSource: false });
    return answers;
  });

  parityTest('readPageWorldVisible keeps the caller record\'s folder coverage and owner flag, as the SQL fragment does', {
    methods: ['putPage', 'readPageWorldVisible'],
  }, async (engine, backend) => {
    await engine.putPage('notes/vis-open', NOTE);
    await engine.putPage('wiki/vis-open', NOTE);
    await createSource(engine, backend, 'vis-flagged', { owner_only: true });
    await engine.putPage('notes/vis-open', NOTE, { sourceId: 'vis-flagged' });
    const world = async () => ({
      notes: await engine.readPageWorldVisible('default', 'notes/vis-open'),
      wiki: await engine.readPageWorldVisible('default', 'wiki/vis-open'),
      flagged: await engine.readPageWorldVisible('vis-flagged', 'notes/vis-open'),
    });
    // A schema version gives the owner-only test its per-page form, so only the owner-only source's page is owner-only.
    noteSchemaVersion(engine, LATEST_SCHEMA_VERSION);
    const answers = await withEngineScope(engine, async () => {
      return {
        none: await world(),
        prefix: await withCallerAccess({ ...MEMBER, folderCoverage: [{ source_id: 'default', prefix: 'notes/' }] }, world),
        wholeSource: await withCallerAccess({ identity: [], hidePrivate: true, folderCoverage: [{ source_id: 'default', prefix: '' }] }, world),
        owner: await withCallerAccess({ identity: [], hidePrivate: true, owner: true }, world),
      };
    });
    expect(answers).toEqual({
      none: { notes: true, wiki: true, flagged: false },
      // A page under a covered prefix reads as nobody, so it is not world-visible; the empty identity does not lift it.
      prefix: { notes: false, wiki: true, flagged: false },
      wholeSource: { notes: false, wiki: false, flagged: false },
      // An owner read renders no owner-only test, so the owner-only source's open page counts as world-visible.
      owner: { notes: true, wiki: true, flagged: true },
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

  parityTest('the owner-only test of the visibility guards is closed with no schema version and per page with one', {
    methods: ['putPage', 'addLink', 'readPageHiddenFromCaller', 'readCallerPageAccess', 'readWriteVisibilityProbe'],
  }, async (engine, backend) => {
    const concept = { ...NOTE, type: 'concept' as const, title: 'Visibility concept' };
    await engine.putPage('notes/vis-open', NOTE);
    await engine.putPage('notes/vis-private', { ...NOTE, frontmatter: { visibility: 'private' } });
    await engine.putPage('concepts/vis-lineage', concept);
    await engine.putPage('concepts/vis-plain', concept);
    const DEFAULT_REFS = ['notes/vis-open', 'notes/vis-private', 'concepts/vis-lineage', 'concepts/vis-plain'].map(slug => ({ source_id: 'default', slug }));
    const read = async (refs: Array<{ source_id: string; slug: string }>) => {
      const hidden: Record<string, boolean> = {};
      const rows: Record<string, string[]> = {};
      const probe: Record<string, boolean | null> = {};
      for (const policy of ['read', 'access'] as const) {
        for (const r of refs) hidden[`${policy}:${r.source_id}:${r.slug}`] = await engine.readPageHiddenFromCaller(r.source_id, r.slug, { policy });
        rows[policy] = (await engine.readCallerPageAccess(refs, { policy })).map(a => `${a.source_id}:${a.slug}:${a.readable}`).sort();
      }
      for (const r of refs) probe[`${r.source_id}:${r.slug}`] = (await engine.readWriteVisibilityProbe(r.source_id, r.slug))?.identity_may_open ?? null;
      return { hidden, rows, probe };
    };
    const before = await read(DEFAULT_REFS);
    await createSource(engine, backend, 'vis-chat', { kind: 'imessage' });
    await engine.putPage('notes/vis-chat', NOTE, { sourceId: 'vis-chat' });
    await engine.putPage('notes/vis-chat-readers', { ...NOTE, frontmatter: { readable_by: ['member:alice-example'] } }, { sourceId: 'vis-chat' });
    // A concept in `default` synthesized from a page of the owner-only source: its lineage makes it owner-only.
    await engine.addLink('concepts/vis-lineage', 'notes/vis-chat', '', 'synthesized_from', 'concept-provenance', undefined, undefined, { toSourceId: 'vis-chat' });
    const refs = [...DEFAULT_REFS, { source_id: 'vis-chat', slug: 'notes/vis-chat' }, { source_id: 'vis-chat', slug: 'notes/vis-chat-readers' }];
    // The harness brain records no schema version: the closed form hides every page while any source is owner-only.
    const closed = await read(refs);
    const closedMember = await withCallerAccess(MEMBER, () => read(refs));
    noteSchemaVersion(engine, LATEST_SCHEMA_VERSION);
    // Schema version 320 or later: only a page of an owner-only source, or a concept built from one, is owner-only.
    const fn = await withEngineScope(engine, () => read(refs));
    const fnMember = await withEngineScope(engine, () => withCallerAccess(MEMBER, () => read(refs)));
    const answers = { before, closed, closedMember, fn, fnMember };
    // Before any owner-only source exists the guards answer by the page policy alone, so the case is not vacuous.
    expect(before.hidden).toMatchObject({ 'read:default:notes/vis-open': false, 'read:default:notes/vis-private': true, 'access:default:notes/vis-private': false });
    expect(before.rows.read).toContain('default:notes/vis-open:true');
    // Closed form: every page is hidden from a non-owner, the open page and the unlinked concept included.
    for (const answer of [closed, closedMember]) {
      expect(Object.values(answer.hidden).every(h => h)).toBe(true);
      expect(answer.rows.read.every(r => r.endsWith(':false'))).toBe(true);
      expect(answer.rows.access.every(r => r.endsWith(':false'))).toBe(true);
      expect(answer.probe).toEqual({
        'default:notes/vis-open': false, 'default:notes/vis-private': false, 'default:concepts/vis-lineage': false, 'default:concepts/vis-plain': false,
        'vis-chat:notes/vis-chat': false, 'vis-chat:notes/vis-chat-readers': true,
      });
    }
    // Function form: a default-source page stays readable; the owner-only source's pages and the concept built from one are hidden.
    for (const answer of [fn, fnMember]) {
      expect(answer.hidden).toEqual({
        'read:default:notes/vis-open': false, 'read:default:notes/vis-private': true, 'read:default:concepts/vis-lineage': true, 'read:default:concepts/vis-plain': false,
        'read:vis-chat:notes/vis-chat': true, 'read:vis-chat:notes/vis-chat-readers': true,
        'access:default:notes/vis-open': false, 'access:default:notes/vis-private': false, 'access:default:concepts/vis-lineage': true, 'access:default:concepts/vis-plain': false,
        'access:vis-chat:notes/vis-chat': true, 'access:vis-chat:notes/vis-chat-readers': true,
      });
      expect(answer.rows).toEqual({
        read: ['default:concepts/vis-lineage:false', 'default:concepts/vis-plain:true', 'default:notes/vis-open:true', 'default:notes/vis-private:false', 'vis-chat:notes/vis-chat-readers:false', 'vis-chat:notes/vis-chat:false'],
        access: ['default:concepts/vis-lineage:false', 'default:concepts/vis-plain:true', 'default:notes/vis-open:true', 'default:notes/vis-private:true', 'vis-chat:notes/vis-chat-readers:false', 'vis-chat:notes/vis-chat:false'],
      });
      expect(answer.probe).toEqual({
        'default:notes/vis-open': null, 'default:notes/vis-private': false, 'default:concepts/vis-lineage': false, 'default:concepts/vis-plain': null,
        'vis-chat:notes/vis-chat': false, 'vis-chat:notes/vis-chat-readers': true,
      });
    }
    return answers;
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
