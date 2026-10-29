/**
 * `gbrain repair file-drift` on a held `file_drift` page whose body is stored in segments (Wave B).
 *
 * 1. Protects: a ~4 MiB segmented page with a timeline region, held `file_drift` (side both), resolves with `--held --side both --only <path>`:
 *    --prefer file imports the file (the page stays segmented, holds the file's body and keeps its timeline region, which
 *    the apply reads back from the database; the file keeps its bytes), and
 *    --prefer database rewrites the file from the database render (the page is unchanged). The preview hash is stable,
 *    `--expect` with another hash refuses `preview_changed`, and a file edited after the preview applies as
 *    `changed_since_preview` with nothing written. A refused or stale apply admits no request: it takes no lifetime id,
 *    stores no receipt and leaves no request behind; a repaired page takes exactly one committed request. On a repo brain (a strict git-canonical source) the rewritten file is
 *    committed through the door, and the checkout is clean; on a repo-less brain (a plain directory, the database is
 *    the record) the same apply works and never refuses for lack of a repo. A segmented page over 24 MiB still refuses
 *    `page_body_segmented` (the preview, and an apply whose page grew past 24 MiB after its preview, before admission),
 *    and the refusal names `gbrain repair file-drift`, the 24 MiB limit and a fix.
 * 2. Fails when: the reconcile artifact refuses the segmented snapshot's fields (invalid_params, "Unsupported or missing
 *    reconciliation fields."), the reconcile publication reads the page back through its throwing body getters
 *    (`page_body_segmented`, "Nothing was read or changed."), or the over-ceiling refusal names no file-drift fix.
 * Real PGLite, and Postgres when DATABASE_URL is set (test/e2e/repair-file-drift-segmented-postgres.test.ts); no seams.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { RECOVERY_VERSION } from '../../src/core/markdown.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { materializeSegmentedBody } from '../../src/core/page-body/ingest.ts';
import { liveFileDrift } from '../../src/core/persistence/drift-conflicts.ts';
import { readLocalWriter, withVerifiedLocalRegistration } from '../../src/core/persistence/identity.ts';
import { importManagedFile } from '../../src/core/persistence/import-mutations.ts';
import { writeGitHold } from '../../src/core/persistence/sync-holds.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { prepareDriftPage } from '../../src/core/repair/file-drift.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { resolveRepairScope } from '../../src/core/repair/core.ts';
import { conversationBody, conversationPage } from '../helpers/conversation-page.ts';
import { durableGitRepo, git } from '../helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from '../helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from '../helpers/test-backends.ts';

const putPage = operations.find(op => op.name === 'put_page')!;
const logger = { info() {}, warn() {}, error() {} };
const SLUG = 'people/alice-example';
const PATH = `${SLUG}.md`;
const TIMELINE = '- **2026-01-05** | alice-example joined acme-example\n- **2026-02-10** | acme-example shipped the launch';
const content = `---\ntype: person\ntitle: Alice Example\n---\n\n${conversationBody(4 * 1024 * 1024, { seed: 7, needles: [{ at: 0.5, word: 'midpointmarker' }] })}\n\n<!-- timeline -->\n\n${TIMELINE}\n`;

type Kind = 'repo' | 'repo-less';
const repoSetup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };

for (const backend of testBackends()) for (const kind of ['repo', 'repo-less'] as Kind[]) describe(`repair file-drift on a segmented page [${backend}, ${kind} brain]`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const brain = (run: (b: { engine: BrainEngine; ctx: OperationContext; root: string }) => Promise<void>) =>
    managedBrain(async b => {
      if (kind === 'repo') await b.engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
      await b.engine.setConfig('pages.segmented_storage', 'on');
      await run(b);
    }, { databaseUrl, ...(kind === 'repo' ? { setup: repoSetup } : {}) });

  const storage = async (engine: BrainEngine) => (await engine.executeRaw<{ id: number; body_storage: string; body_bytes: string }>(
    "SELECT id::int AS id, body_storage, body_bytes::text AS body_bytes FROM pages WHERE source_id='default' AND slug=$1", [SLUG]))[0]!;
  const stored = async (engine: BrainEngine) => materializeSegmentedBody(engine, (await storage(engine)).id, 'default');
  /** What a write took from the journal: the brain's lifetime ids and terminal bytes, and the reconcile requests of the page. */
  const usage = async (engine: BrainEngine) => ({
    counters: await engine.executeRaw("SELECT lifetime_ids::text AS ids, terminal_bytes::text AS bytes FROM persistence_counters WHERE key='brain'"),
    requests: await engine.executeRaw("SELECT state, error_code FROM persistence_requests WHERE source_id='default' AND slug=$1 AND intent->>'kind'='canonical_reconcile' ORDER BY created_at", [SLUG]) });
  const revision = async (engine: BrainEngine) => (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!.revision;
  /** The file edited and (on a repo brain) committed by another writer, then held by sync as two-sided drift. */
  async function drift(engine: BrainEngine, root: string, from: string, to: string): Promise<string> {
    const file = join(root, PATH);
    const edited = readFileSync(file, 'utf8').replace(from, to);
    writeFileSync(file, edited);
    if (kind === 'repo') { git(root, 'add', PATH); git(root, 'commit', '-q', '-m', 'edit outside gbrain'); }
    const [src] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
    await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation: src!.incarnation, path: PATH, source_path: PATH, slug: SLUG,
      page_id: null, code: 'file_drift', message: `${PATH} is held: file drift (both)`, upstream_version: null, observed_at: new Date().toISOString(), run_id: null,
      mode: 'managed', meta: { recovery_version: RECOVERY_VERSION, side: 'both' } }));
    return edited;
  }
  async function seed(b: { engine: BrainEngine; ctx: OperationContext; root: string }): Promise<void> {
    expect(await putPage.handler(b.ctx, { slug: SLUG, content, request_id: randomUUID(), wait_ms: 30_000 })).toMatchObject({ state: 'committed' });
    await settleManagedGitEffects(b.engine);
    const row = await storage(b.engine);
    expect(row.body_storage).toBe('segmented');
    expect(Number(row.body_bytes)).toBeGreaterThan(4 * 1024 * 1024);
    expect(Number(row.body_bytes)).toBeLessThan(PAGE_MAX_BYTES);
    expect((await stored(b.engine)).timeline).toContain('acme-example shipped the launch');
    if (kind === 'repo') expect(git(b.root, 'status', '--porcelain', '--', PATH)).toBe('');
  }
  const run = async (engine: BrainEngine, prefer: 'file' | 'database', expectHash?: string) =>
    (await repairRunner(engine, { apply: expectHash !== undefined, logger })).run('file-drift', await resolveRepairScope(engine, 'default'),
      { explicit: true, sourceFlag: 'default', held: true, side: 'both', prefer, only: [PATH], ...(expectHash ? { expect: expectHash } : {}) });
  const refusal = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return error as OperationError; } throw new Error('expected a refusal'); };
  const clean = (root: string) => { if (kind === 'repo') expect(git(root, 'status', '--porcelain', '--', PATH)).toBe(''); };

  test('--prefer file imports the file into the segmented page; the preview hash binds the apply', () => brain(async b => {
    await seed(b);
    const edited = await drift(b.engine, b.root, 'midpointmarker', 'midpointfromfile');
    const preview = await run(b.engine, 'file');
    expect(preview).toMatchObject({ mode: 'dry_run', affected: 1 });
    expect(preview.listing).toEqual([expect.objectContaining({ item: `default:${SLUG}`, class: 'prefer_file' })]);
    expect((await run(b.engine, 'file')).preview_hash).toBe(preview.preview_hash);
    expect((await refusal(run(b.engine, 'file', 'f'.repeat(64)))).code).toBe('preview_changed');
    const before = await usage(b.engine);
    expect(before.requests).toEqual([]);
    const applied = await run(b.engine, 'file', preview.preview_hash!);
    expect(applied.outcome_items).toEqual([expect.objectContaining({ outcome: 'repaired' })]);
    expect(applied.outcomes).toEqual({ repaired: 1 });
    expect((await usage(b.engine)).requests).toEqual([{ state: 'committed', error_code: null }]);
    expect((await storage(b.engine)).body_storage).toBe('segmented');
    const body = await stored(b.engine);
    expect(body.compiled_truth).toContain('midpointfromfile');
    expect(body.compiled_truth).not.toContain('midpointmarker');
    expect(body.timeline).toContain('acme-example shipped the launch');
    expect(readFileSync(join(b.root, PATH), 'utf8') === edited).toBe(true);
    expect(await liveFileDrift(b.engine, 'default', SLUG)).toMatchObject({ still_present: false, reason: 'agrees' });
    clean(b.root);
  }), 600_000);

  test('--prefer database rewrites the file from the database render; a file edited after the preview is changed_since_preview', () => brain(async b => {
    await seed(b);
    const before = await revision(b.engine);
    const edited = await drift(b.engine, b.root, 'midpointmarker', 'midpointfromfile');
    const stale = await run(b.engine, 'database');
    const untouched = await usage(b.engine);
    writeFileSync(join(b.root, PATH), edited.replace('midpointfromfile', 'midpointeditedagain'));
    const raced = await run(b.engine, 'database', stale.preview_hash!);
    expect(raced.outcome_items).toEqual([expect.objectContaining({ outcome: 'changed_since_preview' })]);
    expect(await usage(b.engine)).toEqual(untouched);
    expect(untouched.requests).toEqual([]);
    expect(readFileSync(join(b.root, PATH), 'utf8')).toContain('midpointeditedagain');
    writeFileSync(join(b.root, PATH), edited);
    const preview = await run(b.engine, 'database');
    expect(preview).toMatchObject({ mode: 'dry_run', affected: 1 });
    const applied = await run(b.engine, 'database', preview.preview_hash!);
    expect(applied.outcome_items).toEqual([expect.objectContaining({ outcome: 'repaired' })]);
    expect(await revision(b.engine)).toBe(before);
    const file = readFileSync(join(b.root, PATH), 'utf8');
    expect(file).toContain('midpointmarker');
    expect(file).not.toContain('midpointfromfile');
    expect(await liveFileDrift(b.engine, 'default', SLUG)).toMatchObject({ still_present: false, reason: 'agrees' });
    if (kind === 'repo') expect(git(b.root, 'rev-parse', `HEAD:${PATH}`)).toBe(git(b.root, 'hash-object', '--', PATH));
    clean(b.root);
  }), 600_000);

  test('over 24 MiB the preview and an apply whose page grew past 24 MiB refuse before admission, naming file-drift, the limit and a fix', () => brain(async b => {
    await seed(b);
    const edited = await drift(b.engine, b.root, 'midpointmarker', 'midpointfromfile');
    const preview = await run(b.engine, 'file');
    expect(preview.affected).toBe(1);
    // The page grows past 24 MiB from its file after the preview (a managed import of the file; a strict source is flagged again after it).
    const file = join(b.root, PATH);
    writeFileSync(file, conversationPage(PAGE_MAX_BYTES + 512 * 1024, { seed: 11, needles: [{ at: 0.5, word: 'midpointmarker' }] }));
    if (kind === 'repo') { git(b.root, 'add', PATH); git(b.root, 'commit', '-q', '-m', 'large page'); }
    if (kind === 'repo') await b.engine.executeRaw("UPDATE sources SET config = config - 'canonical' WHERE id='default'");
    expect(await importManagedFile(b.engine, file, PATH, { sourceId: 'default', noEmbed: true })).toMatchObject({ status: 'imported' });
    if (kind === 'repo') await b.engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
    expect(Number((await storage(b.engine)).body_bytes)).toBeGreaterThan(PAGE_MAX_BYTES);
    const before = await usage(b.engine);
    const grown = await run(b.engine, 'file', preview.preview_hash!);
    expect(grown.outcome_items).toEqual([expect.objectContaining({ outcome: 'refused', reason: 'page_body_segmented',
      detail: expect.objectContaining({ message: expect.stringContaining('gbrain repair file-drift: page people/alice-example (source default) stores its') }) })]);
    expect(await usage(b.engine)).toEqual(before);
    expect(before.requests).toEqual([]);
    expect(edited).not.toBe(readFileSync(file, 'utf8'));
    await drift(b.engine, b.root, 'midpointmarker', 'midpointfromfile');
    for (const prefer of ['file', 'database'] as const) {
      const refused = await run(b.engine, prefer);
      expect(refused.affected).toBe(0);
      expect(refused.residuals).toEqual({ refused_page_body_segmented: 1 });
      const detail = refused.listing!.find(entry => entry.class === 'refused')!.detail;
      expect(detail).toStartWith('page_body_segmented: gbrain repair file-drift: page people/alice-example (source default) stores its');
      expect(detail).toContain(`over the 24 MiB (${PAGE_MAX_BYTES}-byte) limit`);
      expect(detail).toContain(`make the canonical file ${PATH} the copy to keep`);
      expect(detail).toContain('then sync source default.');
    }
    expect(await usage(b.engine)).toEqual(before);
    const refused = await refusal(withVerifiedLocalRegistration(b.engine, await readLocalWriter(b.engine, 'cli'),
      () => prepareDriftPage(b.engine, 'default', SLUG, 'file', new Date().toISOString())));
    expect(refused.code).toBe('page_body_segmented');
    expect(refused.fix?.argv).toEqual(['gbrain', 'get', '--source', 'default', '--body', 'auto', '--', SLUG]);
  }), 900_000);
});
