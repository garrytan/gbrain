/**
 * Command-level listings sort their text keys by byte on every engine arm.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: these commands list, page and cut by byte order of their text keys on every engine arm (PGLite always;
 *    Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1), as PGLite sorts: the member-disable pages
 *    check (pagesReadByNobodyNaming: source id, slug), the reconcile-links page walk (runReconcileLinks: slug), the
 *    visibility proposal's unmatched pages (proposeVisibility: source, slug), the integrity scan's page cut
 *    (scanIntegrity with a limit; its sequential walk reads source id, then slug, as the batch scan does), the admin clients list (created_at, then client id), and the git-gap census's counts
 *    by link source, hold code and parked effect (censusGitGap: link_source, code, kind).
 *  - Regression: an en_US Postgres sorted these text keys by its locale, which skips `-` and `/` (`ab` before `a-z`),
 *    so a command named, walked, cut or counted its items in another order than on a PGLite brain: the integrity scan
 *    read the wrong pages under its limit (and its sequential walk, slug first by localeCompare, stopped at other pages
 *    than its source-first batch scan), and the census listed its counts in another key order.
 *  - Why existing coverage misses it: the tests for these commands use keys that sort the same in every locale, and
 *    CI's Postgres runs in C.UTF-8. Every case here uses keys that differ by byte and by en_US; run it against an en_US
 *    Postgres to see it fail.
 *  - Seam: source and member rows come from the createSource fixture and insertAccessMember; pages with their
 *    frontmatter from putPage, OAuth clients (with a stamped created_at) from insertOauthClient and file rows from
 *    upsertCliFileRow; link rows from addLink and hold rows from writeGitHoldRow; parked effects from the typed journal
 *    seed (test/helpers/persistence-typed-seed.ts). `files verify` runs with an empty GBRAIN_HOME
 *    and stubbed process.exit and console.error. The admin clients list is read over HTTP from an express app on an
 *    ephemeral port. A command that still reads raw SQL stops on the Rust arm's raw_sql refusal.
 */
import { describe, expect, spyOn } from 'bun:test';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { pagesReadByNobodyNaming } from '../../src/commands/access-read-by-nobody.ts';
import { runReconcileLinks } from '../../src/commands/reconcile-links.ts';
import { proposeVisibility } from '../../src/commands/repair-propose.ts';
import { scanIntegrity } from '../../src/commands/integrity.ts';
import { mountAdminClients } from '../../src/commands/serve-http-clients.ts';
import { censusGitGap } from '../../src/commands/sources-git-gap.ts';
import { runFiles } from '../../src/commands/files.ts';
import { createMember, createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { seedTypedEffects, seedTypedRequest, settleTypedEffects } from '../helpers/persistence-typed-seed.ts';
import { emptyHome, withEnv } from '../helpers/with-env.ts';
import { byteOrder, BYTE_IDS, BYTE_SLUGS, MIXED_IDS, MIXED_SLUGS } from '../helpers/byte-order.ts';

const { parityTest } = parityArms(testBackends());

/** Source ids (lower case, digits and `-` only): en_US sorts them `a0, ab, a-z`; bytes put `a-z` first. */
const MIXED_SOURCES = ['ab', 'a0', 'a-z'];
const BYTE_SOURCES = byteOrder(MIXED_SOURCES);
/** Every (source, slug) pair, sources first, each part by byte. */
const BYTE_PAIRS = BYTE_SOURCES.flatMap(source => BYTE_SLUGS.map(slug => [source, slug]));

type Backend = Parameters<typeof createSource>[1];

async function sources(engine: BrainEngine, backend: Backend) {
  for (const id of MIXED_SOURCES) await createSource(engine, backend, id);
}

/** A page in `sourceId` with `frontmatter`, written by putPage. */
async function page(engine: BrainEngine, sourceId: string, slug: string, frontmatter: Record<string, unknown> = {}, body = `${slug} body`) {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body, timeline: '', frontmatter }, { sourceId });
}

describe('command listings sort text keys by byte', () => {
  parityTest('pagesReadByNobodyNaming lists pages by source id, then slug', { methods: ['putPage', 'listPagesNamingReader', 'readWhoCanReadRows'] }, async (engine, backend) => {
    await sources(engine, backend);
    for (const source of MIXED_SOURCES) for (const slug of MIXED_SLUGS) await page(engine, source, slug, { readable_by: ['member:gone-example'] });
    const { pages, truncated } = await pagesReadByNobodyNaming(engine, 'gone-example');
    expect(truncated).toBe(false);
    expect(pages.map(p => [p.source_id, p.slug])).toEqual(BYTE_PAIRS);
  });

  parityTest('runReconcileLinks walks a source\'s markdown pages by byte slug', { methods: ['listMarkdownPageSlugs', 'getPage'] }, async (engine, backend) => {
    await createSource(engine, backend, 'work');
    for (const slug of MIXED_SLUGS) await page(engine, 'work', slug);
    const walked: string[] = [];
    const watched = new Proxy(engine, { get(target, key) {
      if (key === 'getPage') return (slug: string, opts?: Parameters<BrainEngine['getPage']>[1]) => { walked.push(slug); return target.getPage(slug, opts); };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await runReconcileLinks(watched, { sourceId: 'work', dryRun: true });
    expect(walked).toEqual([...BYTE_SLUGS]);
  });

  parityTest('proposeVisibility lists its unmatched pages by source id, then slug', { methods: ['executeRaw', 'putPage'], requires: 'raw_sql' }, async (engine, backend) => {
    await sources(engine, backend);
    for (const id of ['alice-example', 'bob-example']) await createMember(engine, backend, { id, email: `${id}@example.com` });
    for (const source of MIXED_SOURCES) for (const slug of MIXED_SLUGS) await page(engine, source, slug, { participants: ['stranger@example.org'] });
    const out = mkdtempSync(join(tmpdir(), 'collate-propose-'));
    try {
      const proposal = await proposeVisibility(engine, { out });
      expect(proposal.applicable).toBe(true);
      expect(proposal.unmatched.map(u => [u.source, u.slug])).toEqual(BYTE_PAIRS);
    } finally { rmSync(out, { recursive: true, force: true }); }
  });

  // Postgres reads a limited scan in one batch statement (integrity.ts), so only putPage is called on every arm.
  parityTest('scanIntegrity under a limit reads the first pages by byte slug', { methods: ['putPage'] }, async (engine, backend) => {
    for (const slug of MIXED_SLUGS) await page(engine, 'default', slug, {}, 'He tweeted about the launch last week.');
    const scan = await scanIntegrity(engine, { limit: 2 });
    expect(scan.pagesScanned).toBe(2);
    expect(scan.bareHits.map(h => h.slug)).toEqual(BYTE_SLUGS.slice(0, 2));
  });

  parityTest('scanIntegrity under a limit reads pages by source id, then slug, on the batch and sequential paths', { methods: ['putPage', 'listAllPageRefs'] }, async (engine, backend) => {
    await sources(engine, backend);
    // Slug order runs opposite to source order, so a slug-first walk reads `aa` first and the source-first batch `zz`.
    const slugOf: Record<string, string> = { 'a-z': 'zz', a0: 'mm', ab: 'aa' };
    for (const source of MIXED_SOURCES) await page(engine, source, slugOf[source]!, {}, 'He tweeted about the launch last week.');
    const read = async (batchLoad: boolean) => (await scanIntegrity(engine, { limit: 2, batchLoad })).bareHits.map(h => h.slug);
    const expected = BYTE_SOURCES.slice(0, 2).map(source => slugOf[source]);
    expect(await read(false)).toEqual(expected);
    expect(await read(true)).toEqual(expected);
  });

  parityTest('the admin clients list breaks a created_at tie by byte client id', { methods: ['insertOauthClient', 'listAdminClientRows'] }, async (engine, backend) => {
    const tie = new Date('2026-01-02T03:04:05Z');
    for (const id of MIXED_IDS) await engine.insertOauthClient({ client_id: id, client_name: id, created_at: tie });
    const app = express();
    mountAdminClients(app, (_req, _res, next) => next(), engine, 'https://brain.example/mcp');
    const server = app.listen(0, '127.0.0.1');
    try {
      const { port } = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${port}/admin/api/clients`);
      expect(res.status).toBe(200);
      const body = await res.json() as { clients: Array<{ client_id: string }> };
      expect(body.clients.map(c => c.client_id)).toEqual([...BYTE_IDS]);
      // The whole listing (metadata, grant, created_at, status) is compared across engines.
      return body.clients;
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  parityTest('the git-gap census counts links and holds in byte key order', {
    methods: ['putPage', 'readSourceState', 'addLink', 'writeGitHoldRow', 'transaction'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'work');
    await page(engine, 'work', 'notes/a');
    await page(engine, 'work', 'notes/b');
    const { incarnation } = (await engine.readSourceState('work'))!;
    for (const key of MIXED_SOURCES) {
      await engine.addLink('notes/a', 'notes/b', '', `t-${key}`, key, undefined, undefined, { fromSourceId: 'work', toSourceId: 'work' });
      await engine.writeGitHoldRow('work', incarnation, `notes/${key}.md`, { source_id: 'work', incarnation, path: `notes/${key}.md`, code: key, page_id: null, meta: {} });
    }
    const census = await censusGitGap(engine, 'work', { sample: 0 });
    expect({
      links: Object.keys(census.rows_without_git_home.links.by_link_source),
      holds: Object.keys(census.holds),
    }).toEqual({
      links: BYTE_SOURCES,
      holds: BYTE_SOURCES,
    });
    // The counts themselves are compared across engines.
    return { links: census.rows_without_git_home.links, holds: census.holds };
  });

  // The parked targets are seeded the way the effect worker parks them (test/helpers/persistence-typed-seed.ts): one request
  // with an effect of each kind, each claimed and parked with every code.
  parityTest('the git-gap census counts parked effects in byte key order', {
    methods: ['putPage', 'readSourceMembership', 'insertWriteRequest', 'completeWriteRow', 'insertPublicationEffects', 'selectClaimableEffect',
      'stampEffectClaim', 'parkEffectRow', 'transaction'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'work');
    await page(engine, 'work', 'notes/a');
    const request = await seedTypedRequest(engine, { source: 'work', slug: 'notes/a', state: 'committed' });
    await seedTypedEffects(engine, { id: request.id, source: 'work', incarnation: request.incarnation }, MIXED_SOURCES.map(kind => ({ kind })));
    await settleTypedEffects(engine, () => ({ to: 'parked', data: { parked: MIXED_SOURCES.map(code => ({ slug: 'notes/a', error_code: code })) } }));
    const census = await censusGitGap(engine, 'work', { sample: 0 });
    expect({
      parked: census.parked_effects.map(p => [p.kind, p.code]),
    }).toEqual({
      parked: BYTE_SOURCES.flatMap(kind => BYTE_SOURCES.map(code => [kind, code])),
    });
    // The counts themselves are compared across engines.
    return census.parked_effects;
  });

  parityTest('files verify reports its rows by byte storage path', { methods: ['upsertCliFileRow', 'listFileRowsForVerify'] }, async (engine) => {
    for (const path of MIXED_SLUGS) {
      await engine.upsertCliFileRow({ page_slug: null, filename: path, storage_path: `files/${path}`, mime_type: null, size_bytes: 3, content_hash: 'sha256:abc' }, {});
    }
    const lines: string[] = [];
    const errors = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
    const logs = spyOn(console, 'log').mockImplementation(() => {});
    const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try { await withEnv({ GBRAIN_HOME: emptyHome() }, () => runFiles(engine, ['verify'])); }
    finally { errors.mockRestore(); logs.mockRestore(); exit.mockRestore(); }
    expect(lines.filter(l => l.startsWith('  UNVERIFIABLE: ')).map(l => l.split(' ')[3])).toEqual(BYTE_SLUGS.map(slug => `files/${slug}`));
  });
});
