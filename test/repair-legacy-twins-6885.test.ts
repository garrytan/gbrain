/**
 * #6885: page pairs older syncs forked before #6857. A legacy page (live, no recorded origin, a slug the current fold
 * spells differently) holds the id, links and history; its twin (the folded slug) records the file. `gbrain repair
 * legacy-twins` previews every pair and, after consent, merges each onto the legacy page in one coordinated write:
 * the legacy page records the file, the twin's links, timeline rows and aliases move to it, its slug becomes an alias,
 * its sync import record follows, and the twin is soft-deleted as a shared origin (the file stays). Protects: the
 * merge, the following sync (no new page, no hold, no file write, the classifier's `matched`), the twin tombstone's
 * 72 h purge (database-only, never refused as a shared origin), a pair whose content differs (a decision, never
 * merged), a pair that moved after the preview (`changed_since_preview`), the owner-host refusal, the mass valve and
 * the unmanaged brain's one-transaction merge. PGLite always; Postgres through the E2E wrapper.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { OperationError, type OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readGitSourceHolds, readSyncImportProvenance } from '../src/core/persistence/sync-holds.ts';
import { readShadowLevel } from '../src/core/persistence/sync-pass.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { resolveRepairScope, type RepairKind } from '../src/core/repair/core.ts';
import { EXPLICIT_REPAIR_REGISTRY, repairRunner } from '../src/core/repair/registry.ts';
import { LEGACY_TWINS_INTENT, prepareLegacyTwinMerge, scanLegacyTwins } from '../src/core/repair/legacy-twins.ts';
import { maintenancePreflight } from '../src/core/persistence/prepared-maintenance.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { withEnv } from './helpers/with-env.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const logger = { info() {}, warn() {}, error() {} };
const KIND = 'legacy-twins' as RepairKind;
const FILE = 'notes/Foo Bar.md', LEGACY = 'notes/foo bar', TWIN = 'notes/foo-bar';
const note = (title: string) => `---\ntitle: ${title}\n---\nA synthetic observation about ${title}.\n`;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message);
let engine: BrainEngine;

interface Fixture { root: string; home: string; sourceId: string; ids: { legacy: number; twin: number; other: number; second: number } }

/** Raw rows written as an older gbrain left them: managed persistence off around the write, as the #6727 fixture does. */
async function raw<T>(fn: () => Promise<T>): Promise<T> {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try { return await fn(); } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
}

/**
 * A managed source whose file FILE an older gbrain forked: sync imported it as the twin TWIN (recording the file, with
 * its import record), and a legacy page LEGACY with the same content and no recorded origin holds the inbound link,
 * a timeline row and an old alias. Two more files back notes/other and notes/second, which link to the pair.
 */
async function fixture(run: (f: Fixture) => Promise<void>, opts: { managed?: boolean; extra?: Record<string, string>; legacyBody?: string } = {}): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-6885-'));
  const root = join(dir, 'brain'), home = join(dir, 'home');
  mkdirSync(join(root, 'notes'), { recursive: true });
  const sourceId = `twins-${randomUUID().slice(0, 8)}`;
  try {
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SOURCE: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
      git(root, 'init', '-q');
      for (const [path, content] of Object.entries({ [FILE]: note('Foo Bar'), 'notes/other.md': note('other'), 'notes/second.md': note('second'), ...opts.extra })) {
        mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content);
      }
      git(root, 'add', '.'); commit(root, 'content');
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
      await engine.setConfig('sync.write_through', 'true');
      await claimWorktree(engine, sourceId, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      expect((await performManagedSync(engine, { sourceId, noPull: true, noEmbed: true, noExtract: true })).status).toBe('first_sync');
      const id = async (slug: string) => Number((await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]))[0]!.id);
      const twin = await id(TWIN), other = await id('notes/other'), second = await id('notes/second');
      const legacy = await raw(async () => {
        const [row] = await engine.executeRaw<{ id: number }>(`INSERT INTO pages(source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash)
          SELECT source_id, $2, type, title, COALESCE($3, compiled_truth), timeline, frontmatter, CASE WHEN $3::text IS NULL THEN content_hash ELSE md5($3::text) END
          FROM pages WHERE id=$1 RETURNING id`, [twin, LEGACY, opts.legacyBody ?? null]);
        const legacyId = Number(row!.id);
        await engine.executeRaw("INSERT INTO links(from_page_id, to_page_id, link_type) VALUES ($1,$2,'mentions'), ($3,$4,'mentions'), ($4,$1,'mentions'), ($2,$1,'mentions'), ($4,$2,'mentions')",
          [other, legacyId, second, twin]);
        await engine.executeRaw("INSERT INTO timeline_entries(page_id, date, summary) VALUES ($1,'2020-01-02','legacy history row'), ($2,'2021-03-04','twin timeline row')", [legacyId, twin]);
        await engine.executeRaw("INSERT INTO slug_aliases(source_id, alias_slug, canonical_slug, notes) VALUES ($1,'notes/old-name',$2,'rename')", [sourceId, LEGACY]);
        if (opts.managed === false) await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        return legacyId;
      });
      if (opts.managed === false) await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await run({ root, home, sourceId, ids: { legacy, twin, other, second } });
    });
  } finally {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [sourceId]);
    rmSync(dir, { recursive: true, force: true });
  }
}

async function capture(fn: () => Promise<void>): Promise<string> {
  let printed = '';
  const original = console.log, write = process.stdout.write;
  console.log = (...parts: unknown[]) => { printed += `${parts.map(String).join(' ')}\n`; };
  process.stdout.write = ((chunk: string | Uint8Array) => { printed += String(chunk); return true; }) as typeof process.stdout.write;
  try { await fn(); } finally { console.log = original; process.stdout.write = write; }
  return printed;
}

async function refusal(fn: () => Promise<unknown>): Promise<OperationError> {
  try { await fn(); } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a refusal');
}

const repair = async (sourceId: string, opts: { apply?: boolean; expect?: string } = {}) => (await repairRunner(engine, { apply: opts.apply === true, logger }))
  .run(KIND, await resolveRepairScope(engine, sourceId), { explicit: true, sourceFlag: sourceId, expect: opts.expect });
const pageRow = async (sourceId: string, id: number) => (await engine.executeRaw<{ slug: string; source_path: string | null; source_uri: string | null; deleted: boolean; revision: string }>(
  'SELECT slug, source_path, source_uri, deleted_at IS NOT NULL AS deleted, knowledge_revision::text AS revision FROM pages WHERE source_id=$1 AND id=$2', [sourceId, id]))[0];
const livePages = async (sourceId: string) => (await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY slug', [sourceId])).map(row => row.slug);
const links = async (pageId: number) => (await engine.executeRaw<{ from_page_id: number; to_page_id: number }>(
  'SELECT from_page_id, to_page_id FROM links WHERE from_page_id=$1 OR to_page_id=$1 ORDER BY from_page_id, to_page_id', [pageId])).map(row => [Number(row.from_page_id), Number(row.to_page_id)]);
const timeline = async (pageId: number) => (await engine.executeRaw<{ summary: string }>('SELECT summary FROM timeline_entries WHERE page_id=$1 ORDER BY summary', [pageId])).map(row => row.summary);
const holds = async (sourceId: string) => ((await readGitSourceHolds(engine, { sourceIds: [sourceId] }))[0]?.holds ?? []).map(hold => ({ path: hold.path, code: hold.code }));
const incarnation = async (sourceId: string) => (await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]))[0]!.incarnation;

for (const backend of testBackends()) describe(`#6885 repair legacy-twins (${backend})`, () => {
  let closePostgres: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (backend === 'pglite') {
      const pglite = new PGLiteEngine();
      await pglite.connect({}); await pglite.initSchema(); engine = pglite;
    } else {
      const pg = await isolatedPersistencePostgres(requirePostgresTestDatabase());
      engine = pg.engine; closePostgres = pg.close;
    }
  }, 120_000);
  afterAll(async () => {
    await disposePersistenceConsumer(engine);
    if (closePostgres) await closePostgres(); else await engine.disconnect();
  });
  beforeEach(() => _resetCliExitVerdictForTests());
  afterEach(() => _resetCliExitVerdictForTests());

  test('preview lists the pair; consent refusal changes nothing; apply merges it onto the legacy page and keeps the file', () => fixture(async f => {
    const bytes = readFileSync(join(f.root, FILE), 'utf8');
    expect(EXPLICIT_REPAIR_REGISTRY.map(spec => spec.kind)).toContain(KIND);
    const preview = JSON.parse(await capture(() => runRepairCommand(engine, ['legacy-twins', '--source', f.sourceId, '--json']))).results[0];
    expect(preview.listing).toEqual([{ item: `${f.sourceId}:${LEGACY}`, class: 'merge', detail: expect.stringContaining(`takes over ${FILE} from twin ${TWIN}`) }]);
    expect(preview.apply_command).toBe(`gbrain repair legacy-twins --source ${f.sourceId} --apply --expect ${preview.preview_hash} --yes`);

    const priorExitCode = process.exitCode;
    await withEnv({ GBRAIN_INTERACTIVE: '0', CI: '1' }, () => capture(() =>
      runRepairCommand(engine, ['legacy-twins', '--source', f.sourceId, '--apply', '--expect', preview.preview_hash, '--json'])));
    expect(currentExitCode()).toBe(3);
    process.exitCode = priorExitCode ?? 0;
    _resetCliExitVerdictForTests();
    expect((await pageRow(f.sourceId, f.ids.twin))!.deleted).toBe(false);
    expect((await pageRow(f.sourceId, f.ids.legacy))!.source_path).toBeNull();

    const legacyBefore = (await pageRow(f.sourceId, f.ids.legacy))!;
    const applied = JSON.parse(await withEnv({ GBRAIN_INTERACTIVE: '0', CI: '1' }, () => capture(() =>
      runRepairCommand(engine, ['legacy-twins', '--source', f.sourceId, '--apply', '--expect', preview.preview_hash, '--yes', '--json'])))).results[0];
    expect(applied).toMatchObject({ mode: 'apply', applied: 1, skipped: 0, failed: [], complete: true, outcomes: { merged: 1 } });

    expect(readFileSync(join(f.root, FILE), 'utf8')).toBe(bytes);
    expect(await pageRow(f.sourceId, f.ids.legacy)).toMatchObject({ slug: LEGACY, source_path: FILE, deleted: false });
    expect((await pageRow(f.sourceId, f.ids.legacy))!.revision).toBe(legacyBefore.revision);
    expect(await pageRow(f.sourceId, f.ids.twin)).toMatchObject({ slug: TWIN, source_path: null, source_uri: null, deleted: true });
    // Links: the inbound link to the twin moved; the twin's outbound duplicate of the legacy page's own link collapsed; the pair's own link stayed.
    expect(await links(f.ids.legacy)).toEqual([[f.ids.legacy, f.ids.other], [f.ids.other, f.ids.legacy], [f.ids.second, f.ids.legacy], [f.ids.twin, f.ids.legacy]].sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!));
    expect(await timeline(f.ids.legacy)).toEqual(['legacy history row', 'twin timeline row']);
    const alias = await engine.readPageSnapshot(TWIN, { sourceId: f.sourceId, resolveAlias: true });
    expect(Number(alias!.page.id)).toBe(f.ids.legacy);
    expect(Number((await engine.readPageSnapshot('notes/old-name', { sourceId: f.sourceId, resolveAlias: true }))!.page.id)).toBe(f.ids.legacy);
    const inc = await incarnation(f.sourceId);
    expect(await readSyncImportProvenance(engine, f.sourceId, inc, f.ids.twin)).toBeNull();
    expect(await readSyncImportProvenance(engine, f.sourceId, inc, f.ids.legacy)).toMatchObject({ page_id: f.ids.legacy, origin: FILE, revision: legacyBefore.revision });

    // The next managed sync is a no-op: no new page, no hold, no file write, and a full walk agrees.
    const pagesBefore = await livePages(f.sourceId);
    expect(['up_to_date', 'synced']).toContain((await performManagedSync(engine, { sourceId: f.sourceId, noPull: true, noEmbed: true, noExtract: true })).status);
    await performManagedSync(engine, { sourceId: f.sourceId, noPull: true, noEmbed: true, noExtract: true, full: true });
    expect(await livePages(f.sourceId)).toEqual(pagesBefore);
    expect(await holds(f.sourceId)).toEqual([]);
    expect(readFileSync(join(f.root, FILE), 'utf8')).toBe(bytes);
    expect(git(f.root, 'status', '--porcelain')).toBe('');
    expect(await pageRow(f.sourceId, f.ids.legacy)).toMatchObject({ slug: LEGACY, source_path: FILE, deleted: false });
    // The 4a classifier (a full round reparses every live page by obligation, so the shadow level is read without one): the file settles as `matched` on the legacy page, like an untouched file.
    const level = await readShadowLevel(engine, { sourceId: f.sourceId });
    const classified = (path: string) => { const p = level!.paths.find(entry => entry.path === path)!; return { cls: p.result.cls, pageId: p.pageId, slug: p.slug }; };
    expect(classified(FILE)).toEqual({ cls: 'matched', pageId: f.ids.legacy, slug: LEGACY });
    expect(classified('notes/other.md')).toEqual({ cls: 'matched', pageId: f.ids.other, slug: 'notes/other' });

    // The twin's tombstone is purged by the 72 h retention purge, database-only: never refused as a shared origin, and the file stays.
    await raw(() => engine.executeRaw("UPDATE pages SET deleted_at=now() - interval '73 hours' WHERE id=$1", [f.ids.twin]));
    const purged = await purgeDeletedPagesCoordinated(engine, 72);
    expect({ count: purged.count, blocked: purged.blocked }).toEqual({ count: 1, blocked: [] });
    expect(await pageRow(f.sourceId, f.ids.twin)).toBeUndefined();
    expect(readFileSync(join(f.root, FILE), 'utf8')).toBe(bytes);
    expect(Number((await engine.readPageSnapshot(TWIN, { sourceId: f.sourceId, resolveAlias: true }))!.page.id)).toBe(f.ids.legacy);
    await performManagedSync(engine, { sourceId: f.sourceId, noPull: true, noEmbed: true, noExtract: true, full: true });
    expect(await livePages(f.sourceId)).toEqual(pagesBefore);
    expect(await holds(f.sourceId)).toEqual([]);
  }), 180_000);

  test('a pair whose content differs is listed as a decision and never merged', () => fixture(async f => {
    const preview = await repair(f.sourceId);
    expect(preview.affected).toBe(0);
    expect(preview.listing).toEqual([{ item: `${f.sourceId}:${TWIN}`, class: 'decision:content_differs', detail: expect.stringContaining(`legacy ${LEGACY}`) }]);
    const decision = (preview.details!.decisions as Array<{ commands: string[] }>)[0]!;
    expect(decision.commands.join('\n')).toContain(`gbrain get --source ${f.sourceId} -- '${LEGACY}'`);
    const applied = await repair(f.sourceId, { apply: true, expect: preview.preview_hash });
    expect(applied).toMatchObject({ applied: 0, failed: [] });
    expect(await pageRow(f.sourceId, f.ids.twin)).toMatchObject({ deleted: false, source_path: FILE });
    expect((await pageRow(f.sourceId, f.ids.legacy))!.source_path).toBeNull();
  }, { legacyBody: 'An edited legacy body that the file never had.\n' }), 180_000);

  test('#6948 merge: a twin link the legacy page holds with other words is a decision twin_evidence_conflicts, never merged or dropped', () => fixture(async f => {
    await raw(() => engine.executeRaw("INSERT INTO links(from_page_id, to_page_id, link_type, link_source, context) VALUES ($1,$3,'cites','manual','the twin says this'), ($2,$3,'cites','manual','the legacy page says that')",
      [f.ids.twin, f.ids.legacy, f.ids.second]));
    const preview = await repair(f.sourceId);
    expect(preview.affected).toBe(0);
    expect(preview.listing).toEqual([{ item: `${f.sourceId}:${TWIN}`, class: 'decision:twin_evidence_conflicts', detail: expect.stringContaining(`legacy ${LEGACY}`) }]);
    const applied = await repair(f.sourceId, { apply: true, expect: preview.preview_hash });
    expect(applied).toMatchObject({ applied: 0, failed: [] });
    expect(await pageRow(f.sourceId, f.ids.twin)).toMatchObject({ deleted: false, source_path: FILE });
    expect((await engine.executeRaw<{ context: string }>("SELECT context FROM links WHERE link_type='cites' AND to_page_id=$1 ORDER BY context", [f.ids.second])).map(row => row.context))
      .toEqual(['the legacy page says that', 'the twin says this']);
  }), 180_000);

  test('a page that moved after the preview is skipped changed_since_preview; nothing changes', () => fixture(async f => {
    const preview = await repair(f.sourceId);
    expect(preview.affected).toBe(1);
    await raw(() => engine.executeRaw("UPDATE pages SET title='Renamed after the preview' WHERE id=$1", [f.ids.legacy]));
    const applied = await repair(f.sourceId, { apply: true, expect: preview.preview_hash });
    expect(applied).toMatchObject({ applied: 0, skipped: 1, outcomes: { changed_since_preview: 1 } });
    expect(await pageRow(f.sourceId, f.ids.twin)).toMatchObject({ deleted: false, source_path: FILE });
    expect((await pageRow(f.sourceId, f.ids.legacy))!.source_path).toBeNull();
    expect(await links(f.ids.twin)).toContainEqual([f.ids.second, f.ids.twin]);
  }), 180_000);

  test('off the owner host the preview and the apply refuse not_owner_host', () => fixture(async f => {
    const hash = (await repair(f.sourceId)).preview_hash!;
    await withEnv({ GBRAIN_HOME: join(f.home, '..', 'other-host') }, async () => {
      expect((await refusal(() => repair(f.sourceId))).code).toBe('not_owner_host');
      expect((await refusal(() => repair(f.sourceId, { apply: true, expect: hash }))).code).toBe('not_owner_host');
    });
    expect((await pageRow(f.sourceId, f.ids.twin))!.deleted).toBe(false);
  }), 180_000);

  test('the mass valve refuses when the pairs are over half of the file-backed pages', () => fixture(async f => {
    const extra = Array.from({ length: 24 }, (_, i) => `notes/Extra ${String(i).padStart(2, '0')}.md`);
    await raw(async () => {
      for (const path of extra) {
        const twinSlug = `notes/extra-${path.slice(12, 14)}`;
        await engine.executeRaw(`INSERT INTO pages(source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash)
          SELECT source_id, $2, type, title, compiled_truth, timeline, frontmatter, content_hash FROM pages WHERE source_id=$1 AND slug=$3`,
        [f.sourceId, path.replace(/\.md$/, '').toLowerCase(), twinSlug]);
      }
    });
    const preview = await repair(f.sourceId);
    expect(preview.affected).toBeGreaterThan(13);
    expect(preview.warnings?.[0]).toContain('legacy_twin_mass_merge_refused');
    expect((await refusal(() => repair(f.sourceId, { apply: true, expect: preview.preview_hash }))).code).toBe('legacy_twin_mass_merge_refused');
    expect((await pageRow(f.sourceId, f.ids.twin))!.deleted).toBe(false);
  }, { extra: Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`notes/Extra ${String(i).padStart(2, '0')}.md`, note(`Extra ${i}`)])) }), 180_000);

  test('a pair moved while its request waits for preparation or publication is refused and nothing changes', async () => {
    for (const point of ['consumer:preparing', 'consumer:prepared'] as const) await fixture(async f => {
      const preview = await repair(f.sourceId);
      installFaultHook(async (at, detail) => {
        if (at === point && detail.operation === 'submit_job') await raw(() => engine.executeRaw("UPDATE pages SET title='Edited mid-flight' WHERE id=$1", [f.ids.legacy]));
      });
      try {
        const applied = await repair(f.sourceId, { apply: true, expect: preview.preview_hash });
        expect({ point, applied: applied.applied, skipped: applied.skipped, outcomes: applied.outcomes }).toEqual({ point, applied: 0, skipped: 1, outcomes: { changed_since_preview: 1 } });
      } finally { installFaultHook(undefined); }
      expect(await pageRow(f.sourceId, f.ids.twin)).toMatchObject({ deleted: false, source_path: FILE });
      expect((await pageRow(f.sourceId, f.ids.legacy))!.source_path).toBeNull();
      expect(await links(f.ids.twin)).toContainEqual([f.ids.second, f.ids.twin]);
    });
  }, 180_000);

  test('a core twin: a remote merge request is refused core_delete_owner_only and nothing changes; the owner merge proceeds', () => fixture(async f => {
    const scan = await scanLegacyTwins(engine, f.sourceId);
    expect(scan.pairs.map(pair => pair.twin.slug)).toEqual([TWIN]);
    const authority = (await maintenancePreflight(engine, f.sourceId))!;
    const stdio = await registerLocalWriter(engine, 'stdio', { sourceIds: ['*'], operations: null, scopes: ['read', 'write'], slugPrefixes: null });
    const row = { request_id: randomUUID(), source_id: f.sourceId, slug: TWIN, page_id: String(f.ids.twin), source_incarnation: authority.writer.sourceIncarnation,
      authority: { ...authority.writer, remote: true, principal: { kind: 'local_stdio', id: stdio.id } }, intent: { kind: LEGACY_TWINS_INTENT, expected_revision: scan.pairs[0]!.twin.revision, pair: scan.pairs[0], owner: scan.owner } } as never;
    expect((await refusal(() => prepareLegacyTwinMerge(engine, row, {} as never))).code).toBe('core_delete_owner_only');
    expect(await pageRow(f.sourceId, f.ids.twin)).toMatchObject({ deleted: false, source_path: FILE });
    expect((await pageRow(f.sourceId, f.ids.legacy))!.source_path).toBeNull();
    const preview = await repair(f.sourceId);
    expect(await repair(f.sourceId, { apply: true, expect: preview.preview_hash })).toMatchObject({ applied: 1, outcomes: { merged: 1 } });
    expect(await pageRow(f.sourceId, f.ids.twin)).toMatchObject({ deleted: true, source_path: null });
    expect(await pageRow(f.sourceId, f.ids.legacy)).toMatchObject({ deleted: false, source_path: FILE });
  }, { extra: { [FILE]: '---\ntitle: Foo Bar\nalways_load: true\n---\nA synthetic observation about Foo Bar.\n' } }), 180_000);

  test('several legacy pages folding to one twin are one decision; nothing is merged', () => fixture(async f => {
    await raw(() => engine.executeRaw(`INSERT INTO pages(source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash)
      SELECT source_id, 'notes/foo  bar', type, title, compiled_truth, timeline, frontmatter, content_hash FROM pages WHERE id=$1`, [f.ids.legacy]));
    const preview = await repair(f.sourceId);
    expect(preview.affected).toBe(0);
    expect(preview.listing).toEqual([{ item: `${f.sourceId}:${TWIN}`, class: 'decision:several_legacy', detail: expect.stringContaining('notes/foo  bar') }]);
    expect((await pageRow(f.sourceId, f.ids.twin))!.deleted).toBe(false);
  }), 180_000);

  test('why the repair exists: a hand delete of the twin withdraws the file, and a tombstone that keeps its origin is purged database-only (#7311)', () => fixture(async f => {
    const bytes = readFileSync(join(f.root, FILE), 'utf8');
    const ctx = { engine, sourceId: f.sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger } as OperationContext;
    // The legacy page records nothing, so the twin's file has no other claimant: delete_page removes it (#6885).
    await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: TWIN, expected_revision: (await pageRow(f.sourceId, f.ids.twin))!.revision, request_id: randomUUID() } });
    expect(existsSync(join(f.root, FILE))).toBe(false);
    // Put the file back and let the legacy page record it, but leave the twin's tombstone recording it too. Master refused
    // its retention purge as a shared origin, every run (#7311); it is removed database-only: the file and the legacy page stay.
    writeFileSync(join(f.root, FILE), bytes);
    await raw(async () => {
      await engine.executeRaw('UPDATE pages SET source_path=$2 WHERE id=$1', [f.ids.legacy, FILE]);
      await engine.executeRaw('UPDATE pages SET source_path=$2 WHERE id=$1', [f.ids.twin, FILE]);
      await engine.executeRaw("UPDATE pages SET deleted_at=now() - interval '73 hours' WHERE id=$1", [f.ids.twin]);
    });
    const legacyBefore = await pageRow(f.sourceId, f.ids.legacy);
    const purges = Number((await engine.executeRaw<{ n: string }>('SELECT count(*)::text AS n FROM page_purges WHERE source_id=$1', [f.sourceId]))[0]!.n);
    const purged = await purgeDeletedPagesCoordinated(engine, 72);
    expect({ count: purged.count, blocked: purged.blocked, error: purged.error }).toEqual({ count: 1, blocked: [], error: undefined });
    expect(await pageRow(f.sourceId, f.ids.twin)).toBeUndefined();
    expect(await pageRow(f.sourceId, f.ids.legacy)).toEqual(legacyBefore);
    expect(Number((await engine.executeRaw<{ n: string }>('SELECT count(*)::text AS n FROM page_purges WHERE source_id=$1', [f.sourceId]))[0]!.n)).toBe(purges);
    expect(readFileSync(join(f.root, FILE), 'utf8')).toBe(bytes);
  }), 180_000);

  test('an unmanaged brain merges the pair in one maintenance transaction', () => fixture(async f => {
    const bytes = readFileSync(join(f.root, FILE), 'utf8');
    const preview = await repair(f.sourceId);
    expect(preview.affected).toBe(1);
    const applied = await repair(f.sourceId, { apply: true, expect: preview.preview_hash });
    expect(applied).toMatchObject({ applied: 1, outcomes: { merged: 1 } });
    expect(await pageRow(f.sourceId, f.ids.legacy)).toMatchObject({ source_path: FILE, deleted: false });
    expect(await pageRow(f.sourceId, f.ids.twin)).toMatchObject({ source_path: null, deleted: true });
    expect(await timeline(f.ids.legacy)).toEqual(['legacy history row', 'twin timeline row']);
    expect(existsSync(join(f.root, FILE)) && readFileSync(join(f.root, FILE), 'utf8')).toBe(bytes);
  }, { managed: false }), 180_000);
});
