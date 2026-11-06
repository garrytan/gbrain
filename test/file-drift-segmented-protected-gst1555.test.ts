/**
 * GST-1555: `gbrain repair file-drift --prefer file` on a page stored in segments whose database copy keeps protected parts.
 *
 * 1. Protects: a held `file_drift` page (side unknown: an older gbrain forgot its import record) whose body is stored in
 *    segments (`pages.segmented_storage`), with a protected frontmatter key and a timeline row only the database has. Its
 *    preview listed both exceptions (`protected_metadata`, `protected_takes_or_private_facts`) and an apply command, and that
 *    apply refused every time with `invalid_params` "Unsupported or missing reconciliation fields." and no fix: the preview's
 *    snapshot of a segmented page carries `bodyGeneration` and `body_storage`, which the artifact validation did not accept,
 *    and past it the publication sealed the page with the inline text seal, which refuses a segmented body. The apply now
 *    imports the file with the same protections (the file keeps its bytes plus the appended key and row; the page keeps the
 *    key and the row), the page stays segmented and sealed, and the next sync releases the hold. The preview validates its
 *    own artifact as the apply will, so a preview the apply would refuse is refused in the preview.
 * 2. A page with no revision (the revision backfill has not reached it) refused in the preview as a stale preview with no
 *    fix. It now refuses `revision_backfill_pending` with the backfill resume command in fix, and writes nothing.
 * 3. A page whose apply refuses or finds it changed carries a fix (a read-only preview of that page alone).
 * 4. Repo-less: a plain-directory source (no Git) resolves the same segmented page through `--slug`.
 *
 * Runs on PGLite, and on Postgres when DATABASE_URL is set (test/e2e/file-drift-segmented-protected-gst1555-postgres.test.ts).
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { strictReconcileKeys } from '../src/core/persistence/reconcile-merge.ts';
import { materializedSnapshot } from '../src/core/persistence/segmented-apply.ts';
import { REVISION_BACKFILL_MAX_ATTEMPTS, REVISION_BACKFILL_STATE_KEY } from '../src/core/page-state/revision-backfill-schema.ts';
import { renderRepairResult } from '../src/commands/repair.ts';
import { resolveRepairScope, type RepairResult } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commitAll = (root: string, message: string) => { git(root, 'add', '-A'); git(root, 'commit', '-qm', message); };
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const logger = { info() {}, warn() {}, error() {} };
const SLUG = 'notes/alpha';
/** Over the 1 MiB inline bound, so the page is stored in segments. */
const FILLER = Array.from({ length: 16_000 }, (_, i) => `- ${String(i).padStart(9, '0')} acme-example journal line with enough text to fill a segment\n`).join('');
const FILE = `---\ntitle: Alpha Example\ntype: concept\n---\n\nIntro paragraph.\n\n${FILLER}\n## Timeline\n\n- 2026-01-01: First event.\n`;

const coordinated = (engine: BrainEngine, sql: string, params: unknown[] = []) =>
  engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(sql, params), TEST_WRITE_ATTRIBUTION));
const holds = async (engine: BrainEngine) => (await engine.executeRaw<{ r: { path: string; code: string; meta: { side?: string } } }>(
  "SELECT completed_keys->0 AS r FROM op_checkpoints WHERE op='sync-hold' ORDER BY fingerprint")).map(({ r }) => `${r.path} ${r.code} ${r.meta.side ?? ''}`.trim());
const fileDrift = async (engine: BrainEngine, opts: Record<string, unknown>) => withVerifiedLocalRegistration(engine, await registerLocalWriter(engine, 'cli'), async () =>
  (await repairRunner(engine, { apply: opts.expect !== undefined, logger })).run('file-drift', await resolveRepairScope(engine, 'default'),
    { explicit: true, sourceFlag: 'default', prefer: 'file', ...opts }));
type Listing = Array<{ item: string; class: string; detail?: string; fix?: { argv?: string[] } }>;
type Outcome = Array<{ item: string; outcome: string; reason?: string; detail?: { fix?: { argv?: string[] } } }>;

async function segmentedOn(engine: BrainEngine): Promise<void> {
  await engine.setConfig('pages.segmented_storage', 'on');
  await engine.setConfig('pages.max_bytes', String(64 * 1024 * 1024));
}
/** The database copy keeps a protected key and a timeline row the file lacks; the file then gets its own edit. */
async function protectedParts(engine: BrainEngine, root: string): Promise<void> {
  await coordinated(engine, `UPDATE pages SET frontmatter = frontmatter || '{"embed_skip": true}'::jsonb WHERE source_id='default' AND slug=$1`, [SLUG]);
  await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.addTimelineEntry(SLUG,
    { date: '2026-02-01', summary: 'A database-only event.', source: 'example', detail: '' }, { sourceId: 'default' }), TEST_WRITE_ATTRIBUTION));
  writeFileSync(join(root, `${SLUG}.md`), readFileSync(join(root, `${SLUG}.md`), 'utf8').replace('Intro paragraph.', 'Intro paragraph, edited.'));
}
async function assertImported(engine: BrainEngine, root: string, before: string): Promise<void> {
  const after = readFileSync(join(root, `${SLUG}.md`), 'utf8');
  // The file keeps its own bytes; only the protected key (before the closing ---) and the database-only row (at the end) are added.
  let kept = after.replace(/\nembed_skip: true\n---\n/, '\n---\n').replace(/<!-- gbrain:materialized v1 [0-9a-f]+ -->\n- \*\*2026-02-01\*\* \| example — A database-only event\.\n$/, '');
  if (!before.includes('<!-- timeline -->')) kept = kept.replace('<!-- timeline -->\n\n', '');
  expect(kept).toBe(before);
  expect(after).not.toBe(before);
  const [row] = await engine.executeRaw<{ body_storage: string; embed_skip: boolean; sealed: boolean }>(`SELECT body_storage, (frontmatter->>'embed_skip')::boolean AS embed_skip,
    text_projection_revision = knowledge_revision AS sealed FROM pages WHERE source_id='default' AND slug=$1`, [SLUG]);
  expect(row).toEqual({ body_storage: 'segmented', embed_skip: true, sealed: true });
  const { page } = (await materializedSnapshot(engine, await engine.readPageSnapshot(SLUG, { sourceId: 'default' })))!;
  expect(page.compiled_truth).toContain('Intro paragraph, edited.');
  expect(page.timeline).toContain('A database-only event.');
}

for (const backend of testBackends()) describe(`GST-1555 file wins on a segmented page with protected parts (${backend})`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const repo = async ({ engine, root }: { engine: BrainEngine; root: string }) => {
    await segmentedOn(engine);
    mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
    writeFileSync(join(root, `${SLUG}.md`), FILE); commitAll(root, 'alpha');
  };

  test('the held page imports file-wins with its protections, stays segmented and sealed, and the next sync releases the hold', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    expect((await engine.executeRaw<{ body_storage: string }>("SELECT body_storage FROM pages WHERE slug=$1", [SLUG]))[0]!.body_storage).toBe('segmented');
    await coordinated(engine, `DELETE FROM op_checkpoints WHERE op='sync-import-provenance'
      AND completed_keys->0->>'page_id' IN (SELECT id::text FROM pages WHERE source_id='default' AND slug=$1)`, [SLUG]);
    await coordinated(engine, "UPDATE pages SET knowledge_revision=$2::uuid, revision_write_request_id=NULL WHERE source_id='default' AND slug=$1", [SLUG, randomUUID()]);
    await protectedParts(engine, root); commitAll(root, 'edit alpha');
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual(['notes/alpha.md file_drift unknown']);
    const before = readFileSync(join(root, `${SLUG}.md`), 'utf8');

    const preview = await fileDrift(engine, { held: true, side: 'unknown' });
    expect((preview.listing as Listing).map(row => `${row.item} ${row.class}`)).toEqual(['default:notes/alpha prefer_file']);
    expect((preview.details!.pages as Array<{ exceptions: Array<{ path: string; reason: string }> }>)[0]!.exceptions)
      .toEqual([{ path: '/timeline', reason: 'protected_takes_or_private_facts' }, { path: '/frontmatter/embed_skip', reason: 'protected_metadata' }]);
    const applied = await fileDrift(engine, { held: true, side: 'unknown', expect: preview.preview_hash });
    expect(applied.outcomes).toEqual({ repaired: 1 });
    await assertImported(engine, root, before);
    commitAll(root, 'repair');
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual([]);
  }, { databaseUrl, setup: repo }), 240_000);

  test('a page with no revision refuses revision_backfill_pending in the preview, with the backfill resume command in fix', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await protectedParts(engine, root); commitAll(root, 'edit alpha');
    await engine.executeRaw('ALTER TABLE pages ALTER COLUMN knowledge_revision DROP NOT NULL');
    await engine.executeRaw('ALTER TABLE pages DISABLE TRIGGER USER');
    await engine.executeRaw("UPDATE pages SET knowledge_revision=NULL WHERE source_id='default' AND slug=$1", [SLUG]);
    await engine.executeRaw('ALTER TABLE pages ENABLE TRIGGER USER');
    const before = readFileSync(join(root, `${SLUG}.md`), 'utf8');
    const preview = await fileDrift(engine, { slugs: [SLUG] });
    const [row] = preview.listing as Listing;
    expect(row).toMatchObject({ item: 'default:notes/alpha', class: 'refused' });
    expect(row!.detail).toStartWith('revision_backfill_pending: ');
    expect(row!.fix?.argv).toEqual(['gbrain', 'apply-migrations', '--force-schema']);
    expect(preview.details!.pages).toEqual([]);
    // A row the backfill gave up on (every attempt used) is not resumed by that command: the fix previews the torn-body repair.
    const [{ id }] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug=$1", [SLUG]);
    await engine.setConfig(REVISION_BACKFILL_STATE_KEY, JSON.stringify({ cursor: Number(id), backfilled: 0, failed: [{ id: Number(id), attempts: REVISION_BACKFILL_MAX_ATTEMPTS, error: 'example' }] }));
    const exhausted = ((await fileDrift(engine, { slugs: [SLUG] })).listing as Listing)[0]!;
    expect(exhausted.detail).toStartWith('revision_backfill_pending: ');
    expect(exhausted.fix?.argv).toEqual(['gbrain', 'repair', 'orphan-children']);
    expect(readFileSync(join(root, `${SLUG}.md`), 'utf8')).toBe(before);
  }, { databaseUrl, setup: repo }), 240_000);

  test('repo-less: a plain-directory source imports the segmented page file-wins with its protections, and a changed page carries a fix', () => managedBrain(async ({ engine, ctx, root }) => {
    await segmentedOn(engine);
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: SLUG, content: FILE, request_id: randomUUID() } });
    await settleManagedGitEffects(engine);
    expect((await engine.executeRaw<{ body_storage: string }>("SELECT body_storage FROM pages WHERE slug=$1", [SLUG]))[0]!.body_storage).toBe('segmented');
    await protectedParts(engine, root);
    const before = readFileSync(join(root, `${SLUG}.md`), 'utf8');
    const preview = await fileDrift(engine, { slugs: [SLUG] });
    expect((preview.listing as Listing).map(row => row.class)).toEqual(['prefer_file']);

    // An edit after the preview: the apply finds the page changed, writes nothing and names the next step.
    writeFileSync(join(root, `${SLUG}.md`), before.replace('Intro paragraph, edited.', 'Intro paragraph, edited twice.'));
    const changed = await fileDrift(engine, { slugs: [SLUG], expect: preview.preview_hash });
    const [item] = changed.outcome_items as Outcome;
    expect(item).toMatchObject({ item: 'default:notes/alpha', outcome: 'changed_since_preview' });
    expect(item!.detail?.fix?.argv).toEqual(['gbrain', 'repair', 'file-drift', '--source', 'default', '--slug', SLUG, '--prefer', 'file']);

    writeFileSync(join(root, `${SLUG}.md`), before);
    const again = await fileDrift(engine, { slugs: [SLUG] });
    expect((await fileDrift(engine, { slugs: [SLUG], expect: again.preview_hash })).outcomes).toEqual({ repaired: 1 });
    await assertImported(engine, root, before);
  }, { databaseUrl }), 240_000);

  test('a preview whose artifact its own apply would refuse is listed refused in the preview, with a fix, and approves nothing', () => managedBrain(async ({ engine, ctx, root }) => {
    // 40,000 frontmatter values pass the page's own reconcile check once, but the artifact carries them three times
    // (the stored row, the snapshot and the result), past the 100,000-value bound the apply's validation enforces.
    const refs = Array.from({ length: 40_000 }, (_, i) => i);
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'notes/wide', request_id: randomUUID(),
      content: `---\ntype: note\ntitle: Wide\nrefs: [${refs.join(', ')}]\n---\n\nStored body.\n` } });
    await settleManagedGitEffects(engine);
    const file = join(root, 'notes/wide.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace('Stored body.', 'File body.'));
    const preview = await fileDrift(engine, { slugs: ['notes/wide'] });
    const [row] = preview.listing as Listing;
    expect(row).toMatchObject({ item: 'default:notes/wide', class: 'refused' });
    expect(row!.detail).toStartWith('request_too_large: ');
    expect(row!.fix).toBeDefined();
    expect(row!.fix!.argv).toEqual(['gbrain', 'doctor', '--json']);
    expect(preview.details!.pages).toEqual([]);
    expect(preview.affected).toBe(0);
  }, { databaseUrl }), 240_000);
});

describe('GST-1555 reconcile field refusals name the fields', () => {
  test('an unsupported or missing field is named in why', () => {
    const refusal = (() => { try { strictReconcileKeys({ path: '/title', extra: 1 }, ['path', 'action'], ['path', 'action']); } catch (error) { return error; } })() as { code: string; why: string };
    expect(refusal).toMatchObject({ code: 'invalid_params', why: 'unsupported: extra; missing: action' });
  });

  test('the text output prints each row\'s fix with its consent, and never the fix as a detail value', () => {
    const text = renderRepairResult({ kind: 'file-drift', mode: 'apply', affected: 1, sample: [], residuals: {}, scope: { kind: 'all' },
      cost: { lifetime_ids: 0, receipt_bytes: 0, embedding_pages: 0, embedding_usd: null }, capacity: [], resumed_from: null, applied: 0, skipped: 0, failed: [],
      complete: true, apply_command: 'gbrain repair file-drift --source default --slug notes/alpha --apply',
      listing: [{ item: 'default:notes/alpha', class: 'refused', detail: 'invalid_params: example', fix: { argv: ['gbrain', 'doctor', '--json'], consent: [], actor: 'agent', why: 'example', requires_exclusive: false } }],
      outcomes: { changed_since_preview: 1 },
      outcome_items: [{ item: 'default:notes/alpha', outcome: 'changed_since_preview', detail: { request_id: 'example',
        fix: { argv: ['gbrain', 'repair', 'file-drift', '--source', 'default', '--slug', 'notes/alpha', '--prefer', 'file'], consent: ['destructive'], actor: 'agent', why: 'example', requires_exclusive: false } } }],
    } as unknown as RepairResult);
    expect(text).toContain('    fix: gbrain doctor --json\n');
    expect(text).toContain('    fix: gbrain repair file-drift --source default --slug notes/alpha --prefer file (asks the user first: destructive)');
    expect(text).not.toContain('fix=');
  });
});
