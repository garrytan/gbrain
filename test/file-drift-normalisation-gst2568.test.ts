/**
 * GST-2568: `file_drift` holds raised by gbrain's own frontmatter normalisation, and a repair preview that needs no winner.
 *
 * A schema-pack retype (schema-pack/retype.ts) rewrites `pages.type` and stamps `legacy_type` (and optionally `subtype`)
 * in the database only, never in the file. A page with no import record whose file still names the old type then read as
 * drift on every sync, though nothing but that stamp differed.
 *
 * Protects:
 * - item 1: a page that differs from its file only by a retype's stamp (`legacy_type`, `legacy_type` plus `subtype`) is no
 *   drift: a commit to the file imports as a no-op, writes no page revision and no file; a database-only label still holds;
 *   a file that names a new type imports it;
 * - item 2: such holds an older screen wrote release on the next sync with no content write and no commit, counted in
 *   `holds_released`; a real difference is screened again and stays held;
 * - a later deliberate commit over a page that changed only by derived keys (a retype's stamp, a stored reserved key, the
 *   grandfather `validate: false`) imports; a page whose body also changed in the database stays held;
 * - the retired grandfather's database-only `validate: false` and a stored `type` key (stated or path-inferred) are derived: an
 *   older hold over them releases and a later commit imports, while a database label still holds;
 * - a live page whose file is gone under a gbrain.yml `db_only` folder or a `sync.exclude` path is no drift: no hold, an
 *   existing hold releases, and the page stays;
 * - item 3: `repair file-drift --held` without `--prefer` compares each hold (what differs, which side is newer, what a
 *   repair would do) and writes nothing; an apply without `--prefer` refuses with a `fix` naming that comparison;
 * - item 4: `--prefer file` never drops a page edited after its file's last commit in bulk (`kept_newer_page`, the hold
 *   stays), names the drop in a warning when one `--slug` asks for it, and the comparison never proposes deleting a page
 *   whose file is gone;
 * - a `--prefer` preview counts, per page and in total, the lines of the side it overwrites that the result does not carry, in
 *   its listing, a warning and `details.lost_lines`;
 * - a caller's write (put_page, import) that names the type a retype replaced still takes that type: only a file reading keeps
 *   the retype's stamp.
 * PGLite always; Postgres too when DATABASE_URL is set. Holds exist only where sync imports a Git checkout, so there is no
 * repo-less arm.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { importFromContent } from '../src/core/import-file.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { RECOVERY_VERSION } from '../src/core/markdown.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { FILE_DRIFT_VERSION, writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { resolveRepairScope, type RepairPlanOptions } from '../src/core/repair/core.ts';
import { fileDriftConsentText } from '../src/core/repair/file-drift.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const logger = { info() {}, warn() {}, error() {} };
const commitAll = (root: string, message: string) => { git(root, 'add', '-A'); git(root, 'commit', '-qm', message); };
const doc = (type: string, title: string, body: string, extra = '') => `---\ntype: ${type}\ntitle: ${title}\n${extra}---\n\n${body}\n`;
const untyped = (title: string, body: string) => `---\ntitle: ${title}\n---\n\n${body}\n`;
const coordinated = (engine: BrainEngine, sql: string, params: unknown[] = []) =>
  engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(sql, params), TEST_WRITE_ATTRIBUTION));
const holds = async (engine: BrainEngine) => (await engine.executeRaw<{ r: { path: string; code: string; meta: { side?: string; drift_version?: number } } }>(
  "SELECT completed_keys->0 AS r FROM op_checkpoints WHERE op='sync-hold' ORDER BY fingerprint")).map(({ r }) => `${r.path} ${r.code} ${r.meta.side ?? ''}`.trim());
const row = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ type: string; frontmatter: Record<string, unknown>; body: string; revision: string; deleted: boolean }>(
  "SELECT type, frontmatter, compiled_truth AS body, knowledge_revision::text AS revision, deleted_at IS NOT NULL AS deleted FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0]!;

/** Pages as an older gbrain left them: no import record, and a revision no import or write request produced. */
async function legacy(engine: BrainEngine, slugs?: string[]): Promise<void> {
  await coordinated(engine, "DELETE FROM op_checkpoints WHERE op='sync-import-provenance'");
  await coordinated(engine, `UPDATE pages SET knowledge_revision=gen_random_uuid(), revision_write_request_id=NULL WHERE source_id='default'${slugs ? ' AND slug=ANY($1::text[])' : ''}`, slugs ? [slugs] : []);
}
/** What retype.ts's apply writes for a rule from `from` to `to`: the type column and the stamp, in the database only. */
const retype = (engine: BrainEngine, slug: string, from: string, to: string, subtype?: string) => coordinated(engine,
  `UPDATE pages SET type=$2, frontmatter = frontmatter || jsonb_build_object('legacy_type', $3::text) || $4::text::jsonb WHERE source_id='default' AND slug=$1`,
  [slug, to, from, JSON.stringify(subtype ? { subtype } : {})]);
/** The `file_drift` hold an older screen wrote for a page, at its current revision. */
async function seedHold(engine: BrainEngine, slug: string, meta: Record<string, unknown>): Promise<void> {
  const [page] = await engine.executeRaw<{ id: string; revision: string; incarnation: string }>(`SELECT p.id::text AS id, p.knowledge_revision::text AS revision,
    s.incarnation::text AS incarnation FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.source_id='default' AND p.slug=$1`, [slug]);
  await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation: page!.incarnation, path: `${slug}.md`, source_path: `${slug}.md`, slug,
    page_id: Number(page!.id), code: 'file_drift', message: `${slug}.md is held: file drift`, upstream_version: null, observed_at: new Date().toISOString(),
    run_id: null, mode: 'managed', meta: { recovery_version: RECOVERY_VERSION, page_revision: page!.revision, ...meta } as never }));
}
async function repair(engine: BrainEngine, opts: Partial<RepairPlanOptions> & { expect?: string }) {
  return withVerifiedLocalRegistration(engine, await registerLocalWriter(engine, 'cli'), async () =>
    (await repairRunner(engine, { apply: opts.expect !== undefined, logger })).run('file-drift', await resolveRepairScope(engine, 'default'),
      { explicit: true, sourceFlag: 'default', ...opts } as never));
}
type Plan = { listing?: Array<{ item: string; class: string; detail?: string }>; preview_hash?: string; warnings?: string[]; outcomes?: Record<string, number>; details?: Record<string, any> };
const classes = (plan: unknown) => Object.fromEntries(((plan as Plan).listing ?? []).map(entry => [entry.item.replace('default:', ''), entry.class]));

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const files = (root: string, entries: Record<string, string>) => {
    for (const [slug, content] of Object.entries(entries)) { mkdirSync(join(root, slug, '..'), { recursive: true }); writeFileSync(join(root, `${slug}.md`), content); }
  };
  const setupWith = (entries: Record<string, string>) => ({ root }: { root: string }) => { git(root, 'init', '-q'); files(root, entries); commitAll(root, 'pages'); };

  test(`GST-2568 item 1 [${backend}]: a page that differs from its file only by a retype's stamp is no drift; a database label still holds`, () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await retype(engine, 'notes/alpha', 'civic', 'note');
    await retype(engine, 'notes/beta', 'civic', 'note', 'ward');
    await retype(engine, 'notes/delta', 'civic', 'note');
    await coordinated(engine, "UPDATE pages SET frontmatter = frontmatter || '{\"label\": \"x\"}'::jsonb WHERE source_id='default' AND slug='notes/gamma'");
    await legacy(engine);
    const before = { alpha: (await row(engine, 'notes/alpha')).revision, beta: (await row(engine, 'notes/beta')).revision };
    // A commit that only quotes the title touches every file; delta's also names a new type.
    for (const slug of ['notes/alpha', 'notes/beta', 'notes/gamma']) files(root, { [slug]: doc('civic', `'${slug}'`, `Body of ${slug}.`) });
    files(root, { 'notes/delta': doc('event', `'notes/delta'`, 'Body of notes/delta.') });
    commitAll(root, 'quote titles');
    const head = git(root, 'rev-parse', 'HEAD');
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual(['notes/gamma.md file_drift unknown']);
    const alpha = await row(engine, 'notes/alpha'), beta = await row(engine, 'notes/beta'), delta = await row(engine, 'notes/delta');
    expect([alpha.type, alpha.frontmatter, alpha.revision]).toEqual(['note', { legacy_type: 'civic' }, before.alpha]);
    expect([beta.type, beta.frontmatter, beta.revision]).toEqual(['note', { legacy_type: 'civic', subtype: 'ward' }, before.beta]);
    expect([delta.type, delta.frontmatter.legacy_type]).toEqual(['event', undefined]);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(root, 'status', '--porcelain')).toBe('');
  }, { databaseUrl, setup: setupWith(Object.fromEntries(['alpha', 'beta', 'gamma', 'delta'].map(name => [`notes/${name}`, doc('civic', `notes/${name}`, `Body of notes/${name}.`)]))) }), 180_000);

  test(`GST-2568 item 2 [${backend}]: existing normalisation-only holds release on the next sync, counted, with no write and no commit`, () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await retype(engine, 'notes/alpha', 'civic', 'note');
    await retype(engine, 'notes/beta', 'civic', 'note', 'ward');
    await coordinated(engine, "UPDATE pages SET frontmatter = frontmatter || '{\"label\": \"x\"}'::jsonb WHERE source_id='default' AND slug='notes/gamma'");
    await legacy(engine);
    for (const slug of ['notes/alpha', 'notes/beta', 'notes/gamma']) await seedHold(engine, slug, { sides: 'unknown', side: 'unknown', drift_version: 2 });
    const revisions = async () => (await engine.executeRaw<{ r: string }>("SELECT string_agg(knowledge_revision::text, ',' ORDER BY slug) AS r FROM pages WHERE source_id='default'"))[0]!.r;
    const [before, head] = [await revisions(), git(root, 'rev-parse', 'HEAD')];
    const result = await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual(['notes/gamma.md file_drift unknown']);
    expect(result.holds_released).toBe(2);
    const [gamma] = await engine.executeRaw<{ v: number }>("SELECT (completed_keys->0->'meta'->>'drift_version')::int AS v FROM op_checkpoints WHERE op='sync-hold'");
    expect(gamma!.v).toBe(FILE_DRIFT_VERSION);
    expect(await revisions()).toBe(before);
    expect([git(root, 'rev-parse', 'HEAD'), git(root, 'status', '--porcelain')]).toEqual([head, '']);
    expect((await performManagedSync(engine, OPTS)).holds_released).toBeUndefined();
  }, { databaseUrl, setup: setupWith(Object.fromEntries(['alpha', 'beta', 'gamma'].map(name => [`notes/${name}`, doc('civic', `notes/${name}`, `Body of notes/${name}.`)]))) }), 180_000);

  test(`GST-2568 [${backend}]: a later commit over a page that changed only by derived keys imports; a page edited in the database too stays held`, () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await retype(engine, 'notes/retyped', 'civic', 'note');
    // Older imports kept a copy of the reserved `type` key, and the v0.13.1 grandfather stamped `validate: false` in the database only.
    await coordinated(engine, "UPDATE pages SET frontmatter = frontmatter || '{\"type\": \"concept\", \"validate\": false}'::jsonb WHERE source_id='default' AND slug IN ('notes/job','notes/both')");
    await coordinated(engine, "UPDATE pages SET compiled_truth='A database edit of notes/both.' WHERE source_id='default' AND slug='notes/both'");
    await legacy(engine);
    files(root, { 'notes/retyped': doc('civic', 'notes/retyped', 'See [the new link](notes/target).'),
      'notes/job': doc('concept', 'notes/job', 'A body an external job rewrote.', 'source_kind: external-job\nsynced_at: run-1\n'),
      'notes/both': doc('concept', 'notes/both', 'A body an external job rewrote.', 'source_kind: external-job\n') });
    commitAll(root, 'rewrite links and sync the job');
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual(['notes/both.md file_drift unknown']);
    const retyped = await row(engine, 'notes/retyped'), job = await row(engine, 'notes/job');
    expect([retyped.type, retyped.frontmatter, retyped.body]).toEqual(['note', { legacy_type: 'civic' }, 'See [the new link](notes/target).']);
    expect([job.body, job.frontmatter.source_kind, job.frontmatter.validate]).toEqual(['A body an external job rewrote.', 'external-job', false]);
    expect((await row(engine, 'notes/both')).body).toBe('A database edit of notes/both.');
  }, { databaseUrl, setup: setupWith({ 'notes/retyped': doc('civic', 'notes/retyped', 'See [the old link](notes/old).'),
    'notes/job': doc('concept', 'notes/job', 'The first body.'), 'notes/both': doc('concept', 'notes/both', 'The first body.') }) }), 180_000);

  test(`GST-2568 [${backend}]: a live page whose file is gone under a db_only folder or a sync.exclude path is no drift`, () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await engine.setConfig('sync.exclude', 'excluded/');
    await legacy(engine);
    rmSync(join(root, 'private/kept.md')); rmSync(join(root, 'excluded/kept.md'));
    writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  db_only:\n    - private/\n');
    commitAll(root, 'move private pages to the database');
    // The holds an older gbrain wrote for these pages before the folders were declared.
    for (const slug of ['private/kept', 'excluded/kept']) await seedHold(engine, slug, { side: 'deleted', state: 'file_gone' });
    const result = await performManagedSync(engine, OPTS);
    expect([await holds(engine), result.holds_released]).toEqual([[], 2]);
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual([]);
    for (const slug of ['private/kept', 'excluded/kept']) expect((await row(engine, slug)).deleted).toBe(false);
  }, { databaseUrl, setup: setupWith({ 'private/kept': doc('concept', 'private/kept', 'A private body.'), 'excluded/kept': doc('concept', 'excluded/kept', 'An excluded body.') }) }), 180_000);

  test(`GST-2568 [${backend}]: a retired grandfather stamp and a stored type key are derived, not drift: an old hold releases, a later commit imports, a label still holds`, () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    // The retired v0.13.1 grandfather wrote `validate: false` to the database only, with no version row; older imports also kept
    // the page's type (stated, or inferred from the path for a file with no `type:`) as a frontmatter key the file never had.
    await coordinated(engine, "UPDATE pages SET frontmatter = frontmatter || jsonb_build_object('validate', false, 'type', type) WHERE source_id='default'");
    await coordinated(engine, "UPDATE pages SET frontmatter = frontmatter || '{\"label\": \"x\"}'::jsonb WHERE source_id='default' AND slug='notes/labelled'");
    await legacy(engine);
    await seedHold(engine, 'notes/stamped', { sides: 'unknown', side: 'unknown', drift_version: 2 });
    files(root, { 'notes/inferred': untyped('notes/inferred', 'An edited body.'), 'notes/labelled': untyped('notes/labelled', 'An edited body.') });
    commitAll(root, 'edit two bodies');
    const head = git(root, 'rev-parse', 'HEAD');
    const result = await performManagedSync(engine, OPTS);
    expect([await holds(engine), result.holds_released]).toEqual([['notes/labelled.md file_drift unknown'], 1]);
    // The release may normalise the stored copy of the reserved key away; the body, type and stamp stay.
    const stamped = await row(engine, 'notes/stamped');
    expect([stamped.type, stamped.body, stamped.frontmatter.validate]).toEqual(['concept', 'The first body.', false]);
    const inferred = await row(engine, 'notes/inferred');
    expect([inferred.body, inferred.frontmatter.validate]).toEqual(['An edited body.', false]);
    expect((await row(engine, 'notes/labelled')).body).toBe('The first body.');
    expect([git(root, 'rev-parse', 'HEAD'), git(root, 'status', '--porcelain')]).toEqual([head, '']);
  }, { databaseUrl, setup: setupWith({ 'notes/stamped': doc('concept', 'notes/stamped', 'The first body.'),
    'notes/inferred': untyped('notes/inferred', 'The first body.'), 'notes/labelled': untyped('notes/labelled', 'The first body.') }) }), 180_000);

  /** Four held pages: same (a retype's stamp only), newer-file, newer-page (each differs in body), gone (its file left Git). */
  async function heldPages(engine: BrainEngine, root: string): Promise<void> {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await retype(engine, 'notes/same', 'civic', 'note');
    // newer-file: the database body changed two hours ago, then a commit changed the file; newer-page: the database changed after the last commit.
    await coordinated(engine, "UPDATE pages SET compiled_truth='An old database body.', updated_at=now() - interval '2 hours' WHERE source_id='default' AND slug='notes/newer-file'");
    files(root, { 'notes/newer-file': doc('civic', 'notes/newer-file', 'A newer file body.') });
    git(root, 'rm', '-q', '--', 'notes/gone.md');
    commitAll(root, 'edit and remove');
    await coordinated(engine, "UPDATE pages SET compiled_truth='A newer database body.', updated_at=now() + interval '1 minute' WHERE source_id='default' AND slug='notes/newer-page'");
    await legacy(engine);
    for (const slug of ['notes/same', 'notes/newer-file', 'notes/newer-page']) await seedHold(engine, slug, { sides: 'unknown', side: 'unknown', drift_version: FILE_DRIFT_VERSION });
    await seedHold(engine, 'notes/gone', { side: 'deleted', state: 'file_gone' });
  }
  const heldSetup = setupWith(Object.fromEntries(['same', 'newer-file', 'newer-page', 'gone'].map(name => [`notes/${name}`, doc('civic', `notes/${name}`, `The committed body of notes/${name}.`)])));

  test(`GST-2568 item 3 [${backend}]: the held comparison needs no winner, names each page's newer side and writes nothing`, () => managedBrain(async ({ engine, root }) => {
    await heldPages(engine, root);
    const state = async () => JSON.stringify(await engine.executeRaw("SELECT op, fingerprint, completed_keys FROM op_checkpoints WHERE op NOT LIKE '%writer%' ORDER BY op, fingerprint"))
      + JSON.stringify(await engine.executeRaw("SELECT slug, knowledge_revision FROM pages ORDER BY slug"));
    const before = await state();
    const compared = await repair(engine, { held: true }) as Plan;
    expect(classes(compared)).toEqual({ 'notes/gone': 'needs_human', 'notes/newer-file': 'prefer_file', 'notes/newer-page': 'needs_human', 'notes/same': 'release_hold' });
    const pages = Object.fromEntries((compared.details!.pages as Array<{ slug: string; evidence?: { differs: string; newer: string } }>).map(page => [page.slug, page.evidence]));
    expect([pages['notes/newer-file'], pages['notes/newer-page']].map(found => [found!.differs, found!.newer])).toEqual([['body', 'file'], ['body', 'database']]);
    expect(compared.preview_hash).toBeUndefined();
    expect(compared.listing!.find(entry => entry.item === 'default:notes/gone')!.detail).toContain('would delete the page');
    expect(await state()).toBe(before);
    // An apply still names a winner; its refusal carries the comparison as its fix.
    const refusal = await repair(engine, { held: true, expect: 'abc' }).then(() => null, error => error as OperationError);
    expect(refusal?.code).toBe('invalid_params');
    expect(refusal?.fix?.argv).toEqual(['gbrain', 'repair', 'file-drift', '--source', 'default', '--held', '--json']);
  }, { databaseUrl, setup: heldSetup }), 240_000);

  test(`GST-2568 item 4 [${backend}]: --prefer file never drops a page edited after its file's last commit in bulk, and says so for one --slug`, () => managedBrain(async ({ engine, root }) => {
    await heldPages(engine, root);
    // --prefer file in bulk keeps the newer page held; the file-newer page imports its file.
    const bulk = await repair(engine, { held: true, side: 'unknown', prefer: 'file' }) as Plan;
    expect(classes(bulk)['notes/newer-page']).toBe('kept_newer_page');
    expect(classes(bulk)['notes/newer-file']).toBe('prefer_file');
    expect((await repair(engine, { held: true, side: 'unknown', prefer: 'file', expect: bulk.preview_hash! }) as Plan).outcomes?.repaired).toBeGreaterThanOrEqual(1);
    expect((await row(engine, 'notes/newer-file')).body).toBe('A newer file body.');
    expect((await row(engine, 'notes/newer-page')).body).toBe('A newer database body.');
    expect(await holds(engine)).toContain('notes/newer-page.md file_drift unknown');
    // One --slug may still ask for it, and the preview says what it drops.
    const single = await repair(engine, { slugs: ['notes/newer-page'], prefer: 'file' }) as Plan;
    expect(classes(single)['notes/newer-page']).toBe('prefer_file');
    expect(single.warnings?.join(' ')).toContain('drops a database edit newer than its file');
  }, { databaseUrl, setup: heldSetup }), 240_000);

  test(`GST-2568 [${backend}]: a --prefer preview counts the lines of the overwritten side the result drops, per page and in total`, () => managedBrain(async ({ engine, root }) => {
    await heldPages(engine, root);
    const lost = (plan: Plan) => Object.fromEntries((plan.details!.pages as Array<{ slug: string; lost_lines?: number }>).flatMap(page => page.lost_lines === undefined ? [] : [[page.slug, page.lost_lines]]));
    const detail = (plan: Plan, slug: string) => plan.listing!.find(entry => entry.item === `default:${slug}`)!.detail;
    const byFile = await repair(engine, { slugs: ['notes/newer-file', 'notes/newer-page'], prefer: 'file' }) as Plan;
    expect(lost(byFile)).toEqual({ 'notes/newer-file': 1, 'notes/newer-page': 1 });
    expect(byFile.details!.lost_lines_total).toBe(2);
    expect(detail(byFile, 'notes/newer-file')).toContain('drops 1 line(s) the page holds');
    expect(byFile.warnings?.join(' ')).toContain('The apply drops 2 line(s) the pages it overwrites hold and the result does not carry, across 2 page(s)');
    // The consent the apply asks for says the same.
    expect(fileDriftConsentText(byFile.preview_hash!, 'default').user_message).toContain('It drops 2 line(s) that the copies it overwrites hold and the result does not carry, across 2 page(s).');
    const byDatabase = await repair(engine, { slugs: ['notes/newer-page'], prefer: 'database' }) as Plan;
    expect([lost(byDatabase), byDatabase.details!.lost_lines_total]).toEqual([{ 'notes/newer-page': 1 }, 1]);
    expect(detail(byDatabase, 'notes/newer-page')).toContain('drops 1 line(s) the file holds');
    const released = await repair(engine, { held: true, side: 'unknown', prefer: 'file' }) as Plan;
    expect(released.details!.pages.find((page: { slug: string }) => page.slug === 'notes/same').lost_lines).toBeUndefined();
  }, { databaseUrl, setup: heldSetup }), 240_000);
}

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });

test('GST-2568: a caller that writes the type a retype replaced takes it; the retype stamp is kept only for a file reading', async () => {
  await importFromContent(engine, 'notes/caller', doc('civic', 'notes/caller', 'A body.'), { noEmbed: true });
  await engine.executeRaw("UPDATE pages SET type='note', frontmatter = frontmatter || '{\"legacy_type\": \"civic\"}'::jsonb WHERE slug='notes/caller'");
  await importFromContent(engine, 'notes/caller', doc('civic', 'notes/caller', 'A body, edited.'), { noEmbed: true });
  expect((await row(engine, 'notes/caller')).type).toBe('civic');
}, 60_000);
