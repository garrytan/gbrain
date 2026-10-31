/**
 * GBRA-133 sync-holds wave: three `file_drift` hold shapes no command could resolve.
 *
 * 1. A page with no file origin (no source path; its source URI is a URL, not a `file:` URI) whose file appeared at its
 *    slug path: both previews refused (no recorded origin), because a source URI of any kind blocked adopting the slug path.
 *    File wins now adopts the file and records its path, and the next sync releases the hold.
 * 2. A page with no recorded origin whose slug-path file is spelled differently (`README.md` for slug `projects/readme`): the
 *    previews looked for `projects/readme.md`, called the file gone, and a write would have created that second spelling.
 *    The slug path now resolves to the file discovery imports as the slug.
 * 3. A hold whose page and file agree now stayed held: a sync with no new commit did not re-screen a hold whose page moved,
 *    and nothing re-screened one whose page did not move. Such a sync re-screens it now, and the `--held` preview lists an
 *    agreeing hold as `release_hold`, whose apply schedules its re-screen. A hold that still differs stays held.
 *
 * 4. File wins (`--prefer file`) on a page whose database copy keeps protected parts (a database-only timeline row, a
 *    protected frontmatter key) rewrote the whole file through the serializer: keys reordered, lists re-emitted, the body
 *    re-rendered. It now keeps the file's bytes and appends only the protected parts; a result that would need any other
 *    change (here a database-only tag) refuses `file_wins_rewrite` in the preview and writes nothing.
 * 5. A page a read-only mirror stamped `mirror_read_only` (no recorded file) kept that stamp after its source became
 *    writable, and its `file_drift` hold had no exit: both previews called it database-only. Once the source is writable it
 *    reconciles against the file at its slug path (as an unbound-source page does); the apply records that path and clears
 *    the stamp. While the source is still read-only the page stays database-only.
 *
 * Holds exist only where sync imports a Git checkout, so there is no repo-less arm.
 */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (slug: string, body: string) => `---\ntype: concept\ntitle: ${slug}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const logger = { info() {}, warn() {}, error() {} };

const coordinated = (engine: BrainEngine, sql: string, params: unknown[] = []) =>
  engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(sql, params), TEST_WRITE_ATTRIBUTION));
const holds = async (engine: BrainEngine) => (await engine.executeRaw<{ r: { path: string; code: string; meta: { side?: string } } }>(
  "SELECT completed_keys->0 AS r FROM op_checkpoints WHERE op='sync-hold' ORDER BY fingerprint")).map(({ r }) => `${r.path} ${r.code} ${r.meta.side ?? ''}`.trim());
const origin = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ source_path: string | null; source_uri: string | null }>(
  "SELECT source_path, source_uri FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0];
const commitAll = (root: string, message: string) => { git(root, 'add', '-A'); git(root, 'commit', '-qm', message); };

async function heldPreview(engine: BrainEngine, prefer: 'file' | 'database', expectHash?: string) {
  return withVerifiedLocalRegistration(engine, await registerLocalWriter(engine, 'cli'), async () =>
    (await repairRunner(engine, { apply: expectHash !== undefined, logger })).run('file-drift', await resolveRepairScope(engine, 'default'),
      { explicit: true, sourceFlag: 'default', held: true, side: 'unknown', prefer, ...(expectHash ? { expect: expectHash } : {}) }));
}
const listing = (plan: Awaited<ReturnType<typeof heldPreview>>) => (plan as { listing?: Array<{ item: string; class: string }> }).listing?.map(row => `${row.item} ${row.class}`);

/** A page written straight to the database at a slug no file holds yet: no source path, an optional non-file source URI. */
async function stubPage(engine: BrainEngine, slug: string, sourceUri: string | null): Promise<void> {
  await coordinated(engine, `INSERT INTO pages(source_id, slug, type, title, compiled_truth, timeline, frontmatter, source_uri)
    VALUES('default', $1, 'concept', $1, 'A stub.', '', '{}'::jsonb, $2)`, [slug, sourceUri]);
}

/** notes/n0 as an older gbrain left it (imported, then its origin and write request forgotten), with a stub body, then a commit edits its file. */
async function heldUnknownPage(engine: BrainEngine, root: string): Promise<void> {
  expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
  await coordinated(engine, `DELETE FROM op_checkpoints WHERE op='sync-import-provenance'
    AND completed_keys->0->>'page_id' IN (SELECT id::text FROM pages WHERE source_id='default' AND slug='notes/n0')`);
  await coordinated(engine, `UPDATE pages SET source_path=NULL, compiled_truth='A stub.', knowledge_revision=$1::uuid, revision_write_request_id=NULL
    WHERE source_id='default' AND slug='notes/n0'`, [randomUUID()]);
  writeFileSync(join(root, 'notes/n0.md'), note('notes/n0', 'The edited body of notes/n0.')); commitAll(root, 'edit n0');
  await performManagedSync(engine, OPTS);
  expect(await holds(engine)).toEqual(['notes/n0.md file_drift unknown']);
}

/** A hand-written file: keys in the author's order, a block list, a rule under a text line, a bare timeline heading. */
const HAND_WRITTEN = '---\ntitle: Alpha Example\ntype: concept\naliases:\n  - alpha-one\n  - alpha-two\nstatus: active\n---\n\n'
  + 'Intro paragraph.\n\nSection text above a rule\n---\n\nAfter the rule.\n\n## Timeline\n\n- 2026-01-01: First event.\n';

/** Quoted values, an unsorted inline tag list, stacked rules with the last one the timeline separator, the timeline at the end. */
const STACKED_RULES = '---\ntitle: "Beta Example"\ntype: concept\ncreated: 2026-01-01\ntags: [zeta-tag, alpha-tag, mid-tag]\nsource_label: \'quoted value\'\n---\n\n'
  + 'Intro paragraph.\n\n---\n\n---\n\n---\n\n## Timeline\n\n- 2026-01-01: First event.\n';

/** notes/alpha as an older gbrain left it, with a database-only timeline row and protected key, then a commit edits its file: held unknown. */
async function heldProtectedPage(engine: BrainEngine, root: string, file = HAND_WRITTEN, dbKeys: Record<string, unknown> = { embed_skip: true },
  events = ['A database-only event.'], dbTruthEdit = false): Promise<void> {
  writeFileSync(join(root, 'notes/alpha.md'), file); commitAll(root, 'alpha');
  expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
  await coordinated(engine, `DELETE FROM op_checkpoints WHERE op='sync-import-provenance'
    AND completed_keys->0->>'page_id' IN (SELECT id::text FROM pages WHERE source_id='default' AND slug='notes/alpha')`);
  await coordinated(engine, `UPDATE pages SET frontmatter = frontmatter || $2::text::jsonb, knowledge_revision=$1::uuid, revision_write_request_id=NULL
    WHERE source_id='default' AND slug='notes/alpha'`, [randomUUID(), JSON.stringify(dbKeys)]);
  if (dbTruthEdit) await coordinated(engine, "UPDATE pages SET compiled_truth = 'An older database body.' WHERE source_id='default' AND slug='notes/alpha'");
  for (const [i, summary] of events.entries()) await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.addTimelineEntry('notes/alpha',
    { date: `2026-02-0${i + 1}`, summary, source: 'example', detail: '' }, { sourceId: 'default' }), TEST_WRITE_ATTRIBUTION));
  writeFileSync(join(root, 'notes/alpha.md'), file.replace('Intro paragraph.', 'Intro paragraph, edited.')); commitAll(root, 'edit alpha');
  await performManagedSync(engine, OPTS);
  expect(await holds(engine)).toEqual(['notes/alpha.md file_drift unknown']);
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const setup = ({ root }: { root: string }) => {
    mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
    for (const slug of ['notes/n0', 'notes/n1']) writeFileSync(join(root, `${slug}.md`), note(slug, `The committed body of ${slug}.`));
    commitAll(root, 'notes');
  };

  test(`GBRA-133 [${backend}]: file wins adopts the slug-path file of a page whose source URI names no file, records its path, and the next sync releases the hold`, () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await stubPage(engine, 'people/alice-example', 'https://example.invalid/post/1');
    mkdirSync(join(root, 'people'), { recursive: true });
    writeFileSync(join(root, 'people/alice-example.md'), note('people/alice-example', 'The full page of people/alice-example.')); commitAll(root, 'add alice');
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual(['people/alice-example.md file_drift unknown']);
    expect(listing(await heldPreview(engine, 'database'))).toEqual(['default:people/alice-example prefer_database']);
    const preview = await heldPreview(engine, 'file');
    expect(listing(preview)).toEqual(['default:people/alice-example prefer_file']);
    expect(preview.details!.pages).toEqual([expect.objectContaining({ slug: 'people/alice-example', adopt_slug_path: true })]);
    expect((await heldPreview(engine, 'file', preview.preview_hash!)).outcomes).toEqual({ repaired: 1 });
    expect(await origin(engine, 'people/alice-example')).toEqual({ source_path: 'people/alice-example.md', source_uri: 'https://example.invalid/post/1' });
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual([]);
  }, { databaseUrl, setup }), 180_000);

  test(`GBRA-133 [${backend}]: a no-origin page's slug path resolves to the file spelled README.md, so file wins adopts it and writes no second spelling`, () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await stubPage(engine, 'projects/readme', null);
    mkdirSync(join(root, 'projects'), { recursive: true });
    writeFileSync(join(root, 'projects/README.md'), note('Projects', 'The projects index.')); commitAll(root, 'add readme');
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual(['projects/README.md file_drift unknown']);
    expect(listing(await heldPreview(engine, 'database'))).toEqual(['default:projects/readme prefer_database']);
    const preview = await heldPreview(engine, 'file');
    expect(listing(preview)).toEqual(['default:projects/readme prefer_file']);
    expect((await heldPreview(engine, 'file', preview.preview_hash!)).outcomes).toEqual({ repaired: 1 });
    expect((await origin(engine, 'projects/readme'))?.source_path).toBe('projects/README.md');
    expect(readdirSync(join(root, 'projects'))).toEqual(['README.md']);
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual([]);
  }, { databaseUrl, setup }), 180_000);

  test(`GBRA-133 [${backend}]: a sync with no new commit re-screens a held page that moved: one that agrees now is released, one that still differs stays held`, () => managedBrain(async ({ engine, root }) => {
    await heldUnknownPage(engine, root);
    await coordinated(engine, "UPDATE pages SET compiled_truth='Another database edit.' WHERE source_id='default' AND slug='notes/n0'");
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual(['notes/n0.md file_drift unknown']);
    expect(listing(await heldPreview(engine, 'file'))).toEqual(['default:notes/n0 prefer_file']);
    await coordinated(engine, "UPDATE pages SET compiled_truth='The edited body of notes/n0.' WHERE source_id='default' AND slug='notes/n0'");
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual([]);
    expect((await origin(engine, 'notes/n0'))?.source_path).toBe('notes/n0.md');
  }, { databaseUrl, setup }), 180_000);

  test(`GBRA-133 [${backend}]: the --held preview lists a hold whose page and file agree as release_hold, and its apply makes the next sync release it`, () => managedBrain(async ({ engine, root }) => {
    await heldUnknownPage(engine, root);
    await coordinated(engine, "UPDATE pages SET compiled_truth='The edited body of notes/n0.' WHERE source_id='default' AND slug='notes/n0'");
    // The hold as a screen that recorded the page at its current revision left it: nothing moved since, so no sync re-screens it.
    const [{ revision }] = await engine.executeRaw<{ revision: string }>("SELECT knowledge_revision::text AS revision FROM pages WHERE source_id='default' AND slug='notes/n0'");
    await engine.executeRaw("UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys, '{0,meta,page_revision}', to_jsonb($1::text)) WHERE op='sync-hold'", [revision]);
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual(['notes/n0.md file_drift unknown']);
    const preview = await heldPreview(engine, 'file');
    expect(listing(preview)).toEqual(['default:notes/n0 release_hold']);
    expect(preview.details!.pages).toEqual([expect.objectContaining({ slug: 'notes/n0', action: 'release_hold', path: 'notes/n0.md' })]);
    expect((await heldPreview(engine, 'file', preview.preview_hash!)).outcomes).toEqual({ repaired: 1 });
    expect(await holds(engine)).toEqual(['notes/n0.md file_drift unknown']);
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual([]);
    expect((await origin(engine, 'notes/n0'))?.source_path).toBe('notes/n0.md');
  }, { databaseUrl, setup }), 180_000);

  test(`GBRA-133 [${backend}]: file wins keeps the file's bytes and appends only the protected key and the database-only timeline row`, () => managedBrain(async ({ engine, root }) => {
    await heldProtectedPage(engine, root);
    const before = readFileSync(join(root, 'notes/alpha.md'), 'utf8');
    const preview = await heldPreview(engine, 'file');
    expect(listing(preview)).toEqual(['default:notes/alpha prefer_file']);
    expect((await heldPreview(engine, 'file', preview.preview_hash!)).outcomes).toEqual({ repaired: 1 });
    const after = readFileSync(join(root, 'notes/alpha.md'), 'utf8');
    const [head, body] = [before.slice(0, before.indexOf('\n---\n', 3) + 1), before.slice(before.indexOf('\n---\n', 3) + 1)];
    const timelineAt = body.indexOf('## Timeline');
    expect(after.startsWith(`${head}embed_skip: true\n${body.slice(0, timelineAt)}<!-- timeline -->\n\n${body.slice(timelineAt)}`)).toBe(true);
    expect(after.slice(before.length + 'embed_skip: true\n<!-- timeline -->\n\n'.length)).toMatch(/^<!-- gbrain:materialized v1 [0-9a-f]+ -->\n- \*\*2026-02-01\*\* \| example — A database-only event\.\n$/);
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual([]);
  }, { databaseUrl, setup }), 180_000);

  test(`GBRA-133 [${backend}]: file wins refuses file_wins_rewrite in the preview when keeping the file would need a re-render, and writes nothing`, () => managedBrain(async ({ engine, root }) => {
    await heldProtectedPage(engine, root);
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.addTag('notes/alpha', 'database-only-tag', { sourceId: 'default' }), TEST_WRITE_ATTRIBUTION));
    const before = readFileSync(join(root, 'notes/alpha.md'), 'utf8');
    const preview = await heldPreview(engine, 'file');
    expect((preview as { listing?: Array<{ class: string; detail: string }> }).listing?.map(row => `${row.class} ${row.detail.split(':')[0]}`)).toEqual(['refused file_wins_rewrite']);
    expect(preview.details?.pages ?? []).toEqual([]);
    expect(readFileSync(join(root, 'notes/alpha.md'), 'utf8')).toBe(before);
    expect(await holds(engine)).toEqual(['notes/alpha.md file_drift unknown']);
  }, { databaseUrl, setup }), 180_000);

  test(`GBRA-133 [${backend}]: file wins on a file with quoted values, an unsorted inline tag list, stacked rules and a grandfather stamp only in the database appends only the two database-only timeline rows`, () => managedBrain(async ({ engine, root }) => {
    await heldProtectedPage(engine, root, STACKED_RULES, { validate: false }, ['A database-only event.', 'A second database-only event.'], true);
    const before = readFileSync(join(root, 'notes/alpha.md'), 'utf8');
    const preview = await heldPreview(engine, 'file');
    expect(listing(preview)).toEqual(['default:notes/alpha prefer_file']);
    expect(preview.warnings?.some(warning => warning.startsWith('Commit the appended files right after the apply') && warning.includes('notes/alpha.md'))).toBe(true);
    expect((await heldPreview(engine, 'file', preview.preview_hash!)).outcomes).toEqual({ repaired: 1 });
    const after = readFileSync(join(root, 'notes/alpha.md'), 'utf8');
    expect(after.slice(0, before.length)).toBe(before);
    expect(after.slice(before.length)).toMatch(/^<!-- gbrain:materialized v1 [0-9a-f]+ -->\n- \*\*2026-02-01\*\* \| example — A database-only event\.\n(<!-- gbrain:materialized v1 [0-9a-f]+ -->\n)?- \*\*2026-02-02\*\* \| example — A second database-only event\.\n$/);
    // Git durability is off in this checkout, so the preview says to commit the appended file; committed, the next sync imports it as is.
    commitAll(root, 'repair');
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual([]);
    expect(readFileSync(join(root, 'notes/alpha.md'), 'utf8')).toBe(after);
  }, { databaseUrl, setup }), 180_000);

  test(`GBRA-133 [${backend}]: a stale mirror_read_only page's hold resolves with --prefer database, which records its path and clears the stamp`, () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await coordinated(engine, `INSERT INTO pages(source_id, slug, type, title, compiled_truth, timeline, frontmatter, database_only_reason)
      VALUES('default', 'notes/mirror-page', 'concept', 'notes/mirror-page', 'The database copy, written while the source was a mirror.', '', '{}'::jsonb, 'mirror_read_only')`);
    writeFileSync(join(root, 'notes/mirror-page.md'), note('notes/mirror-page', 'The upstream file.')); commitAll(root, 'upstream');
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual(['notes/mirror-page.md file_drift unknown']);
    await engine.executeRaw(`UPDATE sources SET config = config || '{"mirror_read_only": true}'::jsonb WHERE id='default'`);
    expect(listing(await heldPreview(engine, 'database'))).toEqual(['default:notes/mirror-page no_drift']);
    await engine.executeRaw(`UPDATE sources SET config = config - 'mirror_read_only' WHERE id='default'`);
    const preview = await heldPreview(engine, 'database');
    expect(listing(preview)).toEqual(['default:notes/mirror-page prefer_database']);
    expect((await heldPreview(engine, 'database', preview.preview_hash!)).outcomes).toEqual({ repaired: 1 });
    expect(readFileSync(join(root, 'notes/mirror-page.md'), 'utf8')).toContain('The database copy, written while the source was a mirror.');
    expect(await engine.executeRaw("SELECT source_path, database_only_reason FROM pages WHERE source_id='default' AND slug='notes/mirror-page'"))
      .toEqual([{ source_path: 'notes/mirror-page.md', database_only_reason: null }]);
    commitAll(root, 'repair');
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual([]);
  }, { databaseUrl, setup }), 180_000);
}
