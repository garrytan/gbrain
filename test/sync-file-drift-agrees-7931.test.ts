/**
 * #7931 part 2: a `file_drift` hold whose file and page agree (they differ only in how the file spells the page, here YAML
 * quoting, and in a reserved key an older import kept in the stored frontmatter) could never be resolved. Repair and reconcile
 * read the two as the same page (`no_drift`, `formatting_only`), but the managed import judged its import not a no-op, so
 * every sync held the file again, `release_hold` included.
 *
 * Protects:
 * - a record-less page whose file agrees with it (the reading `prepareFileTarget` and `repair file-drift` use) imports a
 *   formatting-only edit of the file instead of holding it;
 * - an existing hold of such a page is released end to end: the `--held` preview lists it `release_hold`, its apply
 *   schedules the re-screen, and the next sync releases it;
 * - a page that really differs from its file (the body) is still held.
 *
 * #7931 part 3: a `repair file-drift --apply` that was admitted and refused before it published (its file changed while it
 * waited) reserved its request id: the same --expect after a fresh preview answered `idempotency_conflict`. Its retry is
 * admitted now and repairs the page.
 * PGLite always; Postgres too when DATABASE_URL is set. Holds exist only where sync imports a Git checkout, so there is no
 * repo-less arm.
 */
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { RECOVERY_VERSION } from '../src/core/markdown.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\nsource_label: plain-value\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const logger = { info() {}, warn() {}, error() {} };
const commitAll = (root: string, message: string) => { git(root, 'add', '-A'); git(root, 'commit', '-qm', message); };
const coordinated = (engine: BrainEngine, sql: string, params: unknown[] = []) =>
  engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(sql, params), TEST_WRITE_ATTRIBUTION));
const holds = async (engine: BrainEngine) => (await engine.executeRaw<{ r: { path: string; code: string; meta: { side?: string } } }>(
  "SELECT completed_keys->0 AS r FROM op_checkpoints WHERE op='sync-hold' ORDER BY fingerprint")).map(({ r }) => `${r.path} ${r.code} ${r.meta.side ?? ''}`.trim());
const body = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ compiled_truth: string }>(
  "SELECT compiled_truth FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0]!.compiled_truth;

async function filePreview(engine: BrainEngine, opts: { held?: true; slug?: string; expect?: string }) {
  return withVerifiedLocalRegistration(engine, await registerLocalWriter(engine, 'cli'), async () =>
    (await repairRunner(engine, { apply: opts.expect !== undefined, logger })).run('file-drift', await resolveRepairScope(engine, 'default'),
      { explicit: true, sourceFlag: 'default', prefer: 'file', ...(opts.held ? { held: true, side: 'unknown' } : {}), ...(opts.slug ? { slugs: [opts.slug] } : {}),
        ...(opts.expect ? { expect: opts.expect } : {}) }));
}
const listing = (plan: Awaited<ReturnType<typeof filePreview>>) => (plan as { listing?: Array<{ item: string; class: string; detail?: string }> }).listing?.map(row => `${row.item} ${row.class} ${row.detail ?? ''}`.trim());

/**
 * The pages as an older gbrain left them: no import record, and the stored frontmatter keeps a copy of the title (older imports
 * kept reserved keys), so the stored row and a fresh import of the same file differ only in a key the parser never carries.
 */
async function legacyRows(engine: BrainEngine, slugs: string[]): Promise<void> {
  await coordinated(engine, `DELETE FROM op_checkpoints WHERE op='sync-import-provenance'
    AND completed_keys->0->>'page_id' IN (SELECT id::text FROM pages WHERE source_id='default' AND slug=ANY($1::text[]))`, [slugs]);
  for (const slug of slugs) await coordinated(engine, `UPDATE pages SET frontmatter = frontmatter || jsonb_build_object('title', title), knowledge_revision=$2::uuid,
    revision_write_request_id=NULL WHERE source_id='default' AND slug=$1`, [slug, randomUUID()]);
}

afterEach(() => installFaultHook(undefined));

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const setup = ({ root }: { root: string }) => {
    mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
    for (const slug of ['notes/n0', 'notes/n1']) writeFileSync(join(root, `${slug}.md`), note(slug, `The committed body of ${slug}.`));
    commitAll(root, 'notes');
  };

  test(`#7931 part 2 [${backend}]: a formatting-only edit of a record-less page whose file agrees imports; a real body edit is still held`, () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await legacyRows(engine, ['notes/n0', 'notes/n1']);
    await coordinated(engine, "UPDATE pages SET compiled_truth='A database-only body of notes/n1.' WHERE source_id='default' AND slug='notes/n1'");
    // n0: only the YAML quoting changes; n1: the same quoting change on a page whose body moved in the database.
    for (const slug of ['notes/n0', 'notes/n1']) writeFileSync(join(root, `${slug}.md`),
      note(`'${slug}'`, `The committed body of ${slug}.`).replace('source_label: plain-value', "source_label: 'plain-value'"));
    commitAll(root, 'quote values');
    expect(listing(await filePreview(engine, { slug: 'notes/n0' }))).toEqual(['default:notes/n0 no_drift agrees']);
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual(['notes/n1.md file_drift unknown']);
    expect(await body(engine, 'notes/n0')).toBe('The committed body of notes/n0.');
    expect(await body(engine, 'notes/n1')).toBe('A database-only body of notes/n1.');
    expect((await performManagedSync(engine, OPTS)).status).toBe('up_to_date');
  }, { databaseUrl, setup }), 180_000);

  test(`#7931 part 2 [${backend}]: an existing hold whose page and file agree is listed release_hold, and after its apply the next sync releases it`, () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await legacyRows(engine, ['notes/n0']);
    writeFileSync(join(root, 'notes/n0.md'), note("'notes/n0'", 'The committed body of notes/n0.')); commitAll(root, 'quote the title');
    // The hold an older screen wrote for this edit, at the page's current revision.
    const [row] = await engine.executeRaw<{ id: string; revision: string; incarnation: string }>(`SELECT p.id::text AS id, p.knowledge_revision::text AS revision,
      s.incarnation::text AS incarnation FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.source_id='default' AND p.slug='notes/n0'`);
    await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation: row!.incarnation, path: 'notes/n0.md', source_path: 'notes/n0.md', slug: 'notes/n0',
      page_id: Number(row!.id), code: 'file_drift', message: 'notes/n0.md is held: file drift (unknown)', upstream_version: null, observed_at: new Date().toISOString(),
      run_id: null, mode: 'managed', meta: { recovery_version: RECOVERY_VERSION, sides: 'unknown', side: 'unknown', drift_version: 1, page_revision: row!.revision } }));
    await performManagedSync(engine, OPTS);
    const preview = await filePreview(engine, { held: true });
    expect(listing(preview)?.map(line => line.split(' ').slice(0, 2).join(' '))).toEqual(['default:notes/n0 release_hold']);
    expect((await filePreview(engine, { held: true, expect: preview.preview_hash! })).outcomes).toEqual({ repaired: 1 });
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual([]);
    expect(await body(engine, 'notes/n0')).toBe('The committed body of notes/n0.');
  }, { databaseUrl, setup }), 180_000);

  test(`#7931 part 3 [${backend}]: an apply refused before it published does not reserve its request id; the retry with the same --expect repairs the page`, () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await coordinated(engine, "UPDATE pages SET compiled_truth='A database-only body of notes/n0.' WHERE source_id='default' AND slug='notes/n0'");
    const path = join(root, 'notes/n0.md'), committed = readFileSync(path, 'utf8');
    const first = await filePreview(engine, { slug: 'notes/n0' });
    expect(listing(first)?.map(line => line.split(' ').slice(0, 2).join(' '))).toEqual(['default:notes/n0 prefer_file']);
    // The file changes after the apply is admitted and before the consumer prepares it, so the write is refused unpublished.
    let changed = false;
    installFaultHook(point => { if (point === 'consumer:preparing' && !changed) { changed = true; writeFileSync(path, committed.replace('The committed body', 'A racing edit of the body')); } });
    const refused = await filePreview(engine, { slug: 'notes/n0', expect: first.preview_hash! });
    installFaultHook(undefined);
    expect(changed).toBe(true);
    expect((refused as { outcomes?: Record<string, number> }).outcomes?.repaired ?? 0).toBe(0);
    expect(await body(engine, 'notes/n0')).toBe('A database-only body of notes/n0.');
    // The racing edit is undone, so a fresh preview sees the same file and page and prints the same hash.
    writeFileSync(path, committed);
    const retry = await filePreview(engine, { slug: 'notes/n0' });
    expect(retry.preview_hash).toBe(first.preview_hash);
    expect((await filePreview(engine, { slug: 'notes/n0', expect: retry.preview_hash! })).outcomes).toEqual({ repaired: 1 });
    expect(await body(engine, 'notes/n0')).toBe('The committed body of notes/n0.');
  }, { databaseUrl, setup }), 180_000);
}
