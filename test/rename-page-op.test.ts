/**
 * rename_page — a coordinated, database-canonical page rename.
 *
 * The op runs through submitPageMutation like delete_page/restore_page, so it
 * inherits the journal's guarantees (revision precondition, request_id replay,
 * source-scoped write authority, slug fences, receipts). The preparer moves
 * the row with engine.updateSlug inside the publication transaction: page_id
 * is stable, so everything keyed by it stays attached, and the old slug is
 * left behind as a slug alias that get_page follows.
 *
 * PGLite always, and Postgres when DATABASE_URL names a test database (each
 * run gets an isolated database). Persistence is activated, so the
 * managed-writer guard is live and a write outside the coordinator would be
 * refused. No embeddings.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { activatePersistence } from '../src/core/persistence/activation.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { withEnv } from './helpers/with-env.ts';

const DB_SOURCE = 'rename-db-example';
const OTHER_SOURCE = 'rename-other-example';
const REPO_SOURCE = 'rename-repo-example';
const CLIENT = 'rename-client-example';
let engine: BrainEngine;
let closeEngine: () => Promise<void>;
let home: string;
let repoRoot: string;

const op = (name: string) => operations.find(o => o.name === name)!;
function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return { engine, sourceId: DB_SOURCE, remote: false, dryRun: false, config: { engine: 'pglite', embedding_disabled: true },
    logger: { info() {}, warn() {}, error() {} }, ...overrides } as OperationContext;
}
const inHome = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home }, fn);
function submit(operation: string, params: Record<string, unknown>, ctx = ctxOf()) {
  return inHome(() => submitPageMutation(ctx, { operation, params: { request_id: randomUUID(), ...params }, waitMs: 30_000 }));
}
function call(name: string, params: Record<string, unknown>, ctx = ctxOf()) {
  return inHome(async () => await op(name).handler(ctx, params) as Record<string, unknown>);
}
async function put(slug: string, content: string, sourceId = DB_SOURCE) {
  const prior = await engine.readPageSnapshot(slug, { sourceId });
  const result = await submit('put_page', { slug, content, source_id: sourceId, ...(prior ? { expected_revision: prior.revision } : {}) });
  expect(result.state).toBe('committed');
  return (await engine.readPageSnapshot(slug, { sourceId }))!;
}
const pageRow = (slug: string, sourceId = DB_SOURCE) => engine.executeRaw<{ id: number; deleted_at: unknown }>(
  'SELECT id,deleted_at FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
const aliasOf = async (slug: string, sourceId = DB_SOURCE) => (await engine.executeRaw<{ canonical_slug: string }>(
  'SELECT canonical_slug FROM slug_aliases WHERE source_id=$1 AND alias_slug=$2', [sourceId, slug]))[0]?.canonical_slug ?? null;
/** Test-only canonical fixture writes go through the same coordinated-write context the publisher uses. */
const coordinated = (sql: string, params: unknown[], sourceId = DB_SOURCE) =>
  engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.executeRaw(sql, params), TEST_WRITE_ATTRIBUTION));

home = mkdtempSync(join(tmpdir(), 'gbrain-rename-page-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const ENGINES = ['pglite', ...(process.env.DATABASE_URL ? ['postgres'] : [])] as const;
for (const kind of ENGINES) describe(`rename_page on ${kind}`, () => {
  beforeAll(async () => {
    // Ownership reservations are per physical root, so each brain gets its own checkout.
    repoRoot = join(home, `repo-${kind}`); mkdirSync(repoRoot);
    if (kind === 'pglite') {
      const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema();
      engine = lite; closeEngine = () => lite.disconnect();
    } else {
      const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      engine = pg.engine; closeEngine = pg.close;
    }
    await inHome(async () => {
      for (const id of [DB_SOURCE, OTHER_SOURCE]) await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [id]);
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [REPO_SOURCE, repoRoot]);
      await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,scope,source_id) VALUES($1,'Rename fixture','read write',$2)`, [CLIENT, DB_SOURCE]);
      await claimWorktree(engine, REPO_SOURCE, repoRoot);
      expect((await activatePersistence(engine, { confirmQuiesced: true })).enabled).toBe(true);
    });
  }, 120_000);
  afterAll(async () => {
    await inHome(async () => { await disposePersistenceConsumer(engine); await closeEngine(); });
  }, 60_000);

  const PROJECT = `---
title: Old Name Project
type: project
tags: [alpha, beta]
aliases: [Old Name Co]
---

The project formerly known as old-name.

<!-- timeline -->

- **2026-09-01** | Kickoff with the team
`;

  describe('rename_page happy path (database-canonical source)', () => {
    test('content, tags, timeline, versions, links, facts and aliases follow; the old slug redirects', async () => {
      const oldSlug = 'projects/old-name', newSlug = 'projects/new-name';
      await put(oldSlug, PROJECT);
      // A second write gives the page a version history to carry over.
      const before = await put(oldSlug, PROJECT.replace('formerly known', 'previously known'));
      const referrer = await put('notes/referrer', `---\ntitle: Referrer\ntype: note\n---\n\nSee [[${oldSlug}]] for context.\n`);
      await coordinated(`INSERT INTO facts (source_id, entity_slug, fact, source, row_num, source_markdown_slug)
        VALUES ($1, $2, 'Old Name ships in October.', 'test', 1, $2)`, [DB_SOURCE, oldSlug]);
      const count = async (table: string) => Number((await engine.executeRaw<{ n: number }>(
        `SELECT COUNT(*)::integer AS n FROM ${table} WHERE page_id=$1`, [before.page.id]))[0].n);
      const versions = await count('page_versions'), timeline = await count('timeline_entries'), chunks = await count('content_chunks');
      expect(versions).toBeGreaterThan(0);
      expect(timeline).toBeGreaterThan(0);
      expect(chunks).toBeGreaterThan(0);
      const inbound = await engine.executeRaw('SELECT 1 FROM links WHERE from_page_id=$1 AND to_page_id=$2', [referrer.page.id, before.page.id]);
      expect(inbound.length).toBe(1);

      const result = await call('rename_page', { slug: oldSlug, new_slug: newSlug, expected_revision: before.revision });
      expect(result).toMatchObject({ state: 'committed', status: 'renamed', slug: newSlug, renamed_from: oldSlug, source_id: DB_SOURCE,
        page_id: before.page.id, persistence: { mode: 'database' }, write_through: { written: false, skipped: 'no_repo_configured' } });

      const after = (await engine.readPageSnapshot(newSlug, { sourceId: DB_SOURCE }))!;
      expect(result.revision).toBe(after.revision);
      expect(after.revision).not.toBe(before.revision); // a slug change is a new revision
      expect(after.page.id).toBe(before.page.id);
      expect(after.page.compiled_truth).toBe(before.page.compiled_truth);
      expect(after.page.timeline).toBe(before.page.timeline);
      expect(after.page.frontmatter).toEqual(before.page.frontmatter);
      expect(after.tags).toEqual(before.tags);
      expect(after.page.text_projection_revision).toBe(after.revision);
      // Write attribution: the renamed revision is stamped with the rename request, not the prior put_page.
      const [stamp] = await engine.executeRaw<{ request_id: string; principal_kind: string }>(
        `SELECT r.request_id::text AS request_id, p.revision_principal_kind AS principal_kind FROM pages p
           JOIN persistence_requests r ON r.id = p.revision_write_request_id WHERE p.id=$1`, [before.page.id]);
      expect(stamp).toEqual({ request_id: result.request_id as string, principal_kind: 'local_cli' });
      expect(await pageRow(oldSlug)).toEqual([]);
      expect([await count('page_versions'), await count('timeline_entries'), await count('content_chunks')]).toEqual([versions, timeline, chunks]);
      expect((await engine.executeRaw('SELECT 1 FROM links WHERE from_page_id=$1 AND to_page_id=$2', [referrer.page.id, before.page.id])).length).toBe(1);
      // The referrer's body is not rewritten; its [[old]] link resolves through the alias.
      expect((await engine.readPageSnapshot('notes/referrer', { sourceId: DB_SOURCE }))!.page.compiled_truth).toContain(`[[${oldSlug}]]`);

      expect(await aliasOf(oldSlug)).toBe(newSlug);
      const redirected = await call('get_page', { slug: oldSlug });
      expect(redirected).toMatchObject({ slug: newSlug, resolved_slug: newSlug, id: before.page.id });

      const facts = await engine.executeRaw<{ entity_slug: string; source_markdown_slug: string }>(
        `SELECT entity_slug, source_markdown_slug FROM facts WHERE source_id=$1 AND fact='Old Name ships in October.'`, [DB_SOURCE]);
      expect(facts).toEqual([{ entity_slug: newSlug, source_markdown_slug: newSlug }]);
      const pageAliases = await engine.executeRaw<{ slug: string }>(
        `SELECT DISTINCT slug FROM page_aliases WHERE source_id=$1 AND alias_norm LIKE 'old name co%'`, [DB_SOURCE]);
      expect(pageAliases).toEqual([{ slug: newSlug }]);

      // Control: the redirect assertion above is load-bearing. Without the alias
      // row, the old slug no longer resolves at all.
      await coordinated('DELETE FROM slug_aliases WHERE source_id=$1 AND alias_slug=$2', [DB_SOURCE, oldSlug]);
      await expect(call('get_page', { slug: oldSlug })).rejects.toMatchObject({ code: 'page_not_found' });
      await coordinated(`INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug, notes) VALUES ($1,$2,$3,'rename')`, [DB_SOURCE, oldSlug, newSlug]);
    }, 60_000);
  });

  describe('rename_page refusals leave everything unchanged', () => {
    test('new slug held by a live page, a tombstone, or an alias to another page → slug_conflict', async () => {
      const a = await put('projects/conflict-a', '---\ntitle: A\ntype: project\n---\n\nA body.\n');
      const b = await put('projects/conflict-b', '---\ntitle: B\ntype: project\n---\n\nB body.\n');
      const failed = await submit('rename_page', { slug: a.page.slug, new_slug: b.page.slug, expected_revision: a.revision }).catch(e => e);
      expect(failed).toMatchObject({ code: 'slug_conflict', writeError: 'slug_conflict' });
      expect(failed.writeRequest.state).toBe('failed');

      const t = await put('projects/conflict-tomb', '---\ntitle: T\ntype: project\n---\n\nT body.\n');
      expect((await submit('delete_page', { slug: t.page.slug, expected_revision: t.revision })).state).toBe('committed');
      await expect(submit('rename_page', { slug: a.page.slug, new_slug: t.page.slug, expected_revision: a.revision }))
        .rejects.toMatchObject({ code: 'slug_conflict' });

      await coordinated(`INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug, notes) VALUES ($1,'projects/conflict-alias',$2,'test')`, [DB_SOURCE, b.page.slug]);
      await expect(submit('rename_page', { slug: a.page.slug, new_slug: 'projects/conflict-alias', expected_revision: a.revision }))
        .rejects.toMatchObject({ code: 'slug_conflict' });

      expect(await engine.readPageSnapshot(a.page.slug, { sourceId: DB_SOURCE })).toEqual(a);
      expect(await engine.readPageSnapshot(b.page.slug, { sourceId: DB_SOURCE })).toEqual(b);
      expect(await aliasOf(a.page.slug)).toBeNull();
      expect(await aliasOf('projects/conflict-alias')).toBe(b.page.slug);
    }, 60_000);

    test('stale expected_revision → revision_conflict; missing revision is refused like delete_page', async () => {
      const first = await put('projects/stale', '---\ntitle: Stale\ntype: project\n---\n\nFirst body.\n');
      const current = await put('projects/stale', '---\ntitle: Stale\ntype: project\n---\n\nSecond body.\n');
      await expect(submit('rename_page', { slug: 'projects/stale', new_slug: 'projects/stale-renamed', expected_revision: first.revision }))
        .rejects.toMatchObject({ code: 'revision_conflict' });
      const deleteWithout = await submit('delete_page', { slug: 'projects/stale' }).catch(e => e);
      const renameWithout = await submit('rename_page', { slug: 'projects/stale', new_slug: 'projects/stale-renamed' }).catch(e => e);
      expect(renameWithout.code).toBe(deleteWithout.code);
      expect(await engine.readPageSnapshot('projects/stale', { sourceId: DB_SOURCE })).toEqual(current);
      expect(await pageRow('projects/stale-renamed')).toEqual([]);
      expect(await aliasOf('projects/stale')).toBeNull();
    }, 60_000);

    test('missing and soft-deleted pages → page_not_found', async () => {
      await expect(submit('rename_page', { slug: 'projects/never-existed', new_slug: 'projects/anything' }))
        .rejects.toMatchObject({ code: 'page_not_found' });
      const gone = await put('projects/gone', '---\ntitle: Gone\ntype: project\n---\n\nGone body.\n');
      await submit('delete_page', { slug: 'projects/gone', expected_revision: gone.revision });
      const tombstone = (await engine.readPageSnapshot('projects/gone', { sourceId: DB_SOURCE, includeDeleted: true }))!;
      await expect(submit('rename_page', { slug: 'projects/gone', new_slug: 'projects/gone-renamed', expected_revision: tombstone.revision }))
        .rejects.toMatchObject({ code: 'page_not_found' });
      expect(await pageRow('projects/gone-renamed')).toEqual([]);
    }, 60_000);

    test('invalid or unchanged new_slug → invalid_params before admission', async () => {
      const page = await put('projects/invalid-target', '---\ntitle: I\ntype: project\n---\n\nBody.\n');
      for (const new_slug of ['../escape', 'has space/x', '', 'Projects/Invalid-Target', undefined]) {
        await expect(submit('rename_page', { slug: page.page.slug, new_slug, expected_revision: page.revision }))
          .rejects.toMatchObject({ code: 'invalid_params' });
      }
      const admitted = await engine.executeRaw(`SELECT 1 FROM persistence_requests WHERE operation='rename_page' AND slug=$1`, [page.page.slug]);
      expect(admitted).toEqual([]);
    }, 60_000);

    test('a source with a working tree is refused (source_writeback_required), file and row untouched', async () => {
      const result = await submit('put_page', { slug: 'projects/in-repo', source_id: REPO_SOURCE, content: '---\ntitle: R\ntype: project\n---\n\nRepo body.\n' });
      expect(result.state).toBe('committed');
      const page = (await engine.readPageSnapshot('projects/in-repo', { sourceId: REPO_SOURCE }))!;
      expect(existsSync(join(repoRoot, 'projects/in-repo.md'))).toBe(true);
      const refused = await submit('rename_page', { slug: 'projects/in-repo', new_slug: 'projects/in-repo-2', source_id: REPO_SOURCE, expected_revision: page.revision }).catch(e => e);
      expect(refused).toMatchObject({ code: 'source_writeback_required', detail: 'rename_requires_file_move' });
      expect(existsSync(join(repoRoot, 'projects/in-repo.md'))).toBe(true);
      expect(existsSync(join(repoRoot, 'projects/in-repo-2.md'))).toBe(false);
      expect(await engine.readPageSnapshot('projects/in-repo', { sourceId: REPO_SOURCE })).toEqual(page);
    }, 60_000);
  });

  describe('rename_page journal guarantees', () => {
    test('request_id replay returns the same receipt; a different intent under it is idempotency_conflict', async () => {
      const page = await put('projects/replay', '---\ntitle: Replay\ntype: project\n---\n\nReplay body.\n');
      const params = { slug: 'projects/replay', new_slug: 'projects/replay-renamed', expected_revision: page.revision, request_id: randomUUID() };
      const first = await submit('rename_page', params);
      expect(first).toMatchObject({ state: 'committed', status: 'renamed' });
      const replay = await submit('rename_page', params);
      expect(replay).toEqual(first);
      expect((await pageRow('projects/replay-renamed')).length).toBe(1);
      await expect(submit('rename_page', { ...params, new_slug: 'projects/replay-elsewhere' }))
        .rejects.toMatchObject({ code: 'idempotency_conflict' });
      expect(await pageRow('projects/replay-elsewhere')).toEqual([]);
    }, 60_000);

    test('remote callers rename only in their write source, under their fences', async () => {
      const page = await put('projects/remote', '---\ntitle: Remote\ntype: project\n---\n\nRemote body.\n');
      const auth = { token: 't', clientId: CLIENT, principal: { kind: 'oauth_client' as const, id: CLIENT }, scopes: ['read', 'write'], sourceId: DB_SOURCE };
      // Explicit foreign source: denied before anything is admitted.
      await expect(call('rename_page', { slug: 'projects/remote', new_slug: 'projects/remote-2', source_id: OTHER_SOURCE, expected_revision: page.revision },
        ctxOf({ remote: true, auth }))).rejects.toMatchObject({ code: 'permission_denied' });
      // A read-federated grant over the page's source does not confer rename access.
      await expect(call('rename_page', { slug: 'projects/remote', new_slug: 'projects/remote-2', source_id: DB_SOURCE, expected_revision: page.revision },
        ctxOf({ remote: true, sourceId: OTHER_SOURCE, auth: { ...auth, sourceId: OTHER_SOURCE, allowedSources: [OTHER_SOURCE, DB_SOURCE] } }))).rejects.toMatchObject({ code: 'permission_denied' });
      // A slug-bound client is fenced on the NEW slug as well as the old one.
      await expect(call('rename_page', { slug: 'projects/remote', new_slug: 'elsewhere/remote', expected_revision: page.revision },
        ctxOf({ remote: true, auth: { ...auth, boundSlugPrefixes: ['projects/'] } }))).rejects.toMatchObject({ code: 'permission_denied' });
      expect(await engine.readPageSnapshot('projects/remote', { sourceId: DB_SOURCE })).toEqual(page);

      const renamed = await call('rename_page', { slug: 'projects/remote', new_slug: 'projects/remote-2', expected_revision: page.revision }, ctxOf({ remote: true, auth }));
      expect(renamed).toMatchObject({ state: 'committed', status: 'renamed', slug: 'projects/remote-2', source_id: DB_SOURCE });
    }, 60_000);

    test('dry run validates and fences both slugs and changes nothing', async () => {
      const page = await put('projects/dry', '---\ntitle: Dry\ntype: project\n---\n\nDry body.\n');
      const result = await call('rename_page', { slug: 'projects/dry', new_slug: 'projects/dry-2', expected_revision: page.revision }, ctxOf({ dryRun: true }));
      expect(result).toEqual({ dry_run: true, action: 'rename_page', slug: 'projects/dry', new_slug: 'projects/dry-2' });
      await expect(call('rename_page', { slug: 'projects/dry', new_slug: '../escape' }, ctxOf({ dryRun: true })))
        .rejects.toMatchObject({ code: 'invalid_params' });
      expect(await engine.readPageSnapshot('projects/dry', { sourceId: DB_SOURCE })).toEqual(page);
      expect(await pageRow('projects/dry-2')).toEqual([]);
      expect(await aliasOf('projects/dry')).toBeNull();
      expect(await engine.executeRaw(`SELECT 1 FROM persistence_requests WHERE operation='rename_page' AND slug='projects/dry'`)).toEqual([]);
    }, 60_000);

    test('negative control: if the slug alias is not recorded, the rename does not commit', async () => {
      const page = await put('projects/no-alias', '---\ntitle: No alias\ntype: project\n---\n\nBody.\n');
      // Make every slug_aliases insert a silent no-op, as on a schema whose alias
      // write was skipped. The preparer reads the alias back and must refuse.
      await engine.executeRaw(`CREATE OR REPLACE FUNCTION test_drop_alias() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`);
      await engine.executeRaw('CREATE TRIGGER test_drop_alias BEFORE INSERT ON slug_aliases FOR EACH ROW EXECUTE FUNCTION test_drop_alias()');
      try {
        await expect(submit('rename_page', { slug: 'projects/no-alias', new_slug: 'projects/no-alias-2', expected_revision: page.revision }))
          .rejects.toMatchObject({ code: 'storage_error', message: expect.stringContaining('did not record a redirect') });
      } finally {
        await engine.executeRaw('DROP TRIGGER test_drop_alias ON slug_aliases');
      }
      expect(await engine.readPageSnapshot('projects/no-alias', { sourceId: DB_SOURCE })).toEqual(page);
      expect(await pageRow('projects/no-alias-2')).toEqual([]);
    }, 60_000);
  });
});
