/**
 * GST-2579: a database-wins drift repair silently discarded a newer file commit sync had not imported. Another writer
 * commits an edit to a page's file; before the next sync imports it, `repair file-drift --prefer database` (by --held,
 * --all-drifted or --slug) or a `sources reconcile` apply that takes the database copy wrote the page over the file, and
 * nothing said a commit was being thrown away.
 *   - bulk selections (--held, --all-drifted) list such a page kept_newer_file and write nothing for it;
 *   - an exact --slug selection names the commit (sha, author, date) in the preview and in the consent, and its apply
 *     needs the user's consent (--yes);
 *   - `sources reconcile`'s preview and apply refuse a resolution that takes the database copy over such a file;
 *   - gbrain's own writer commit counts the same as anyone's: a file holding gbrain's write of a revision the database
 *     never took (the Git commit landed, the row fell back) is kept_newer_file in bulk and named with --slug;
 *   - a database copy that is provably newer still wins: the file holds the bytes sync imported, or gbrain's write of a
 *     revision the page has since moved past (a later, shorter database edit included, --all-drifted --only), or a blob
 *     sync adopted into the page's import record (with the version history pruned), and the repair is listed and applied
 *     as before.
 * Real PGLite (and Postgres when DATABASE_URL is set), a managed worktree with real Git commits; no seams.
 */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { RECOVERY_VERSION } from '../src/core/markdown.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { runReconcileApply, runReconcilePreview } from '../src/core/persistence/reconcile.ts';
import { writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { prepareDriftPage } from '../src/core/repair/file-drift.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { testBackends } from './helpers/test-backends.ts';

const SYNC = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const logger = { info() {}, warn() {}, error() {} };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Other Writer', '-c', 'user.email=other@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const FIRST = '---\ntype: concept\ntitle: A\n---\n\nThe first body.\n';
const EDIT = '---\ntype: concept\ntitle: A\n---\n\nAn edit by another writer.\n';
const WRITER_LINE = 'A line only gbrain\'s own writer committed.';
const WRITER = `---\ntype: concept\ntitle: A\n---\n\nThe first body.\n\n${WRITER_LINE}\n`;
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid'); git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'notes/a.md'), FIRST); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'first');
};
const backendOpts = (backend: string) => ({ ...(backend === 'postgres' ? { databaseUrl: process.env.DATABASE_URL } : {}), setup });

interface Brain { engine: BrainEngine; ctx: OperationContext; root: string; commit: string }
/** A synced managed brain whose notes/a.md then gets another writer's commit that no sync imported. */
const brain = (backend: string, run: (b: Brain) => Promise<void>) => managedBrain(async ({ engine, ctx, root }) => {
  await registerLocalWriter(engine, 'cli');
  expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
  writeFileSync(join(root, 'notes/a.md'), EDIT);
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'other writer edit');
  await run({ engine, ctx, root, commit: git(root, 'rev-parse', 'HEAD') });
}, backendOpts(backend));

const cli = async <T>(engine: BrainEngine, run: () => Promise<T>) => withVerifiedLocalRegistration(engine, await registerLocalWriter(engine, 'cli'), run);
const runner = async (engine: BrainEngine, opts: Record<string, unknown>) => cli(engine, async () =>
  (await repairRunner(engine, { apply: opts.expect !== undefined, logger })).run('file-drift', await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default', ...opts }));
const fileHasEdit = (root: string) => readFileSync(join(root, 'notes/a.md'), 'utf8').includes('another writer');
const settle = () => Bun.sleep(1500);
/** A file_drift hold on notes/a.md, as sync writes it for a page whose page and file both moved. */
async function holdBoth(engine: BrainEngine): Promise<void> {
  const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
  const page = (await engine.readPageSnapshot('notes/a', { sourceId: 'default' }))!;
  await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation: source!.incarnation, path: 'notes/a.md', source_path: 'notes/a.md', slug: 'notes/a',
    page_id: Number(page.page.id), code: 'file_drift', message: 'notes/a.md is held: file drift (both)', upstream_version: null, observed_at: new Date().toISOString(),
    run_id: null, mode: 'managed', meta: { recovery_version: RECOVERY_VERSION, side: 'both', page_revision: page.revision } }));
}

/** A file_drift hold for a live page whose file is gone (the file_gone Decision), as sync writes it. */
async function holdDeleted(engine: BrainEngine, slug: string, path: string): Promise<void> {
  const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
  const page = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
  await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation: source!.incarnation, path, source_path: path, slug,
    page_id: Number(page.page.id), code: 'file_drift', message: `${path} is held: file drift (deleted file_gone)`, upstream_version: null, observed_at: new Date().toISOString(),
    run_id: null, mode: 'managed', meta: { recovery_version: RECOVERY_VERSION, side: 'deleted', state: 'file_gone', page_revision: page.revision } }));
}

/** The CLI's JSON output and exit code for one file-drift invocation. */
async function repairCli(engine: BrainEngine, args: string[]): Promise<{ out: string; exitCode: number | string | undefined }> {
  const lines: string[] = [];
  const { log, error } = console;
  const stdout = process.stdout.write.bind(process.stdout);
  const previous = process.exitCode;
  process.exitCode = 0;
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
  console.error = () => {};
  process.stdout.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try { await runRepairCommand(engine, ['file-drift', ...args, '--json']); return { out: lines.join('\n'), exitCode: process.exitCode }; }
  finally { console.log = log; console.error = error; process.stdout.write = stdout; process.exitCode = previous ?? 0; _resetCliExitVerdictForTests(); }
}

async function refusal(run: () => Promise<unknown>): Promise<OperationError> {
  try { await run(); } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a refusal');
}

for (const backend of testBackends()) {
  test(`${backend}: --held --prefer database keeps a newer unimported file (kept_newer_file) and writes nothing`, () => brain(backend, async ({ engine, root }) => {
    await holdBoth(engine);
    const preview = await runner(engine, { held: true, side: 'both', prefer: 'database' });
    expect(preview.affected).toBe(0);
    expect(preview.residuals).toMatchObject({ kept_newer_file: 1 });
    const listed = preview.listing!.find(entry => entry.item === 'default:notes/a')!;
    expect(listed.class).toBe('kept_newer_file');
    expect(listed.detail).toContain('has not imported');
    expect(listed.detail).toContain('--slug notes/a --prefer database');
    await runner(engine, { held: true, side: 'both', prefer: 'database', expect: preview.preview_hash });
    await settle();
    expect(fileHasEdit(root)).toBe(true);
  }), 240_000);

  test(`${backend}: --all-drifted --prefer database keeps a newer unimported file a refused write recorded`, () => brain(backend, async ({ engine, ctx, root }) => {
    const revision = (await engine.readPageSnapshot('notes/a', { sourceId: 'default' }))!.revision;
    expect((await refusal(() => submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'notes/a', content: '---\ntype: concept\ntitle: A\n---\n\nA database edit.\n',
      request_id: randomUUID(), expected_revision: revision } }))).code).toBe('source_changed');
    const preview = await runner(engine, { allDrifted: true, prefer: 'database' });
    expect(preview.affected).toBe(0);
    expect(preview.listing!.find(entry => entry.item === 'default:notes/a')?.class).toBe('kept_newer_file');
    await runner(engine, { allDrifted: true, prefer: 'database', expect: preview.preview_hash });
    await settle();
    expect(fileHasEdit(root)).toBe(true);
  }), 240_000);

  test(`${backend}: --slug --prefer database names the commit it discards and applies only with the user's consent`, () => brain(backend, async ({ engine, root, commit }) => {
    const preview = JSON.parse((await repairCli(engine, ['--source', 'default', '--slug', 'notes/a', '--prefer', 'database'])).out).results[0];
    expect(preview.affected).toBe(1);
    const listed = preview.listing.find((entry: { item: string }) => entry.item === 'default:notes/a');
    expect(listed.detail).toContain(`discards commit ${commit.slice(0, 12)} by Other Writer`);
    expect(preview.details.pages[0].discards).toMatchObject({ reason: 'unimported_commit', path: 'notes/a.md', commit: { sha: commit, author: 'Other Writer' } });
    expect(preview.warnings.join(' ')).toContain(commit.slice(0, 12));
    expect(preview.apply_command).toEndWith(' --yes');
    const apply = ['--source', 'default', '--slug', 'notes/a', '--prefer', 'database', '--apply', '--expect', preview.preview_hash];
    const unconsented = await repairCli(engine, apply);
    expect(unconsented.exitCode).toBe(3);
    expect(unconsented.out).toContain(commit.slice(0, 12));
    await settle();
    expect(fileHasEdit(root)).toBe(true);
    const consented = JSON.parse((await repairCli(engine, [...apply, '--yes'])).out).results[0];
    expect(consented.outcomes).toEqual({ repaired: 1 });
    await settle();
    expect(fileHasEdit(root)).toBe(false);
    // The overwritten bytes stay in reconcile's private backup (mode 0600), which nothing prunes on its own.
    const backups = join(process.env.GBRAIN_HOME!, '.gbrain', 'reconciliation-previews');
    const [backup] = readdirSync(backups).filter(name => name.endsWith('.json'));
    expect(statSync(join(backups, backup!)).mode & 0o777).toBe(0o600);
    const kept = JSON.parse(readFileSync(join(backups, backup!), 'utf8'));
    expect(kept).toMatchObject({ format_version: 1, retention: 'pre_admission_or_terminal' });
    expect(Buffer.from(kept.preview.preimages.file_base64, 'base64').toString('utf8')).toBe(EDIT);
    expect(kept.preview.decisions).toContainEqual({ path: '/compiled_truth', action: 'take_database' });
    // The guide's read-only lookup (docs/guides/repair.md#file-drift-past-losses) finds the overwritten commit from the backup.
    expect([typeof kept.request_id, kept.preview.preconditions.slug, kept.preview.preconditions.relative_path]).toEqual(['string', 'notes/a', 'notes/a.md']);
    const blob = execFileSync('git', ['-C', root, 'hash-object', '--no-filters', '--stdin'], { input: Buffer.from(kept.preview.preimages.file_base64, 'base64') }).toString().trim();
    expect(git(root, 'log', '--all', `--find-object=${blob}`, '--format=%H %an')).toContain(`${commit} Other Writer`);
  }), 240_000);

  test(`${backend}: sources reconcile refuses to take the database copy over the unimported commit, in its preview and its apply`, () => brain(backend, async ({ engine, root, commit }) => {
    await cli(engine, async () => {
      const fresh = await runReconcilePreview(engine, { source_id: 'default', slug: 'notes/a' });
      const decided = await refusal(() => runReconcilePreview(engine, { source_id: 'default', slug: 'notes/a', from: fresh.preview,
        decisions: [{ path: '/compiled_truth', action: 'take_database' }] }));
      expect(decided.code).toBe('source_changed');
      expect(decided.message).toContain(`commit ${commit.slice(0, 12)} by Other Writer`);
      const kept = await runReconcilePreview(engine, { source_id: 'default', slug: 'notes/a', from: fresh.preview, decisions: [{ path: '/compiled_truth', action: 'take_file' }] });
      expect(kept.status).toBe('ready');
      const ready = await prepareDriftPage(engine, 'default', 'notes/a', 'database', new Date().toISOString());
      const applied = await refusal(() => runReconcileApply(engine, { source_id: 'default', slug: 'notes/a', preview: ready.preview, request_id: randomUUID() }));
      expect(applied.code).toBe('source_changed');
      expect(applied.message).toContain(commit.slice(0, 12));
    });
    await settle();
    expect(fileHasEdit(root)).toBe(true);
  }), 240_000);

  test(`${backend}: an ordinary database-wins repair (the file still holds the imported bytes) is listed and applied in bulk as before`, () => managedBrain(async ({ engine, ctx, root }) => {
    await registerLocalWriter(engine, 'cli');
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    // The page takes a database edit (written through to the file), then the file goes back to the bytes sync imported: nothing in it is new.
    const revision = (await engine.readPageSnapshot('notes/a', { sourceId: 'default' }))!.revision;
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'notes/a', content: '---\ntype: concept\ntitle: A\n---\n\nA database-only edit.\n',
      request_id: randomUUID(), expected_revision: revision } });
    await settleManagedGitEffects(engine);
    writeFileSync(join(root, 'notes/a.md'), FIRST);
    git(root, 'add', '-A'); git(root, 'commit', '-q', '--allow-empty', '-m', 'back to the imported bytes');
    await holdBoth(engine);
    const preview = await runner(engine, { held: true, side: 'both', prefer: 'database' });
    expect(preview.affected).toBe(1);
    expect(preview.residuals.kept_newer_file).toBeUndefined();
    expect(preview.listing!.find(entry => entry.item === 'default:notes/a')).toMatchObject({ class: 'prefer_database', detail: 'exactly the preferred side' });
    expect((await runner(engine, { held: true, side: 'both', prefer: 'database', expect: preview.preview_hash })).outcomes).toEqual({ repaired: 1 });
    await settle();
    expect(readFileSync(join(root, 'notes/a.md'), 'utf8')).toContain('A database-only edit.');
  }, backendOpts(backend)), 240_000);
  test(`${backend}: a file whose newest commit is gbrain's own write, over a database copy that fell behind it, is kept_newer_file in bulk and named with --slug`, () => managedBrain(async ({ engine, ctx, root }) => {
    await registerLocalWriter(engine, 'cli');
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    const older = (await engine.readPageSnapshot('notes/a', { sourceId: 'default' }))!;
    // gbrain's own writer commits a longer page (Git durability on); then the database row falls back to the older copy,
    // as when the Git commit lands and the row does not.
    await engine.executeRaw("UPDATE persistence_host_bindings SET git_durability='enabled'");
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'notes/a', content: WRITER, request_id: randomUUID(), expected_revision: older.revision } });
    await settleManagedGitEffects(engine);
    expect(readFileSync(join(root, 'notes/a.md'), 'utf8')).toContain(WRITER_LINE);
    expect(git(root, 'log', '-1', '--format=%an', '--', 'notes/a.md')).not.toBe('Other Writer');
    expect(git(root, 'status', '--porcelain')).toBe('');
    const commit = git(root, 'log', '-1', '--format=%H', '--', 'notes/a.md');
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
      "UPDATE pages SET compiled_truth=$1, knowledge_revision=$2::uuid WHERE source_id='default' AND slug='notes/a'", [older.page.compiled_truth, randomUUID()]), TEST_WRITE_ATTRIBUTION));
    const behind = (await engine.readPageSnapshot('notes/a', { sourceId: 'default' }))!;
    expect(behind.page.compiled_truth).not.toContain(WRITER_LINE);
    // A refused write records the drift conflict --all-drifted selects.
    expect((await refusal(() => submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'notes/a', content: '---\ntype: concept\ntitle: A\n---\n\nA database edit.\n',
      request_id: randomUUID(), expected_revision: behind.revision } }))).code).toBe('source_changed');

    const bulk = await runner(engine, { allDrifted: true, only: ['notes/**'], prefer: 'database' });
    expect(bulk.affected).toBe(0);
    expect(bulk.listing!.find(entry => entry.item === 'default:notes/a')).toMatchObject({ class: 'kept_newer_file', detail: expect.stringContaining(commit.slice(0, 12)) });
    await runner(engine, { allDrifted: true, only: ['notes/**'], prefer: 'database', expect: bulk.preview_hash });
    await settle();
    expect(readFileSync(join(root, 'notes/a.md'), 'utf8')).toContain(WRITER_LINE);

    const named = JSON.parse((await repairCli(engine, ['--source', 'default', '--slug', 'notes/a', '--prefer', 'database'])).out).results[0];
    expect(named.listing.find((entry: { item: string }) => entry.item === 'default:notes/a').detail).toStartWith(`discards commit ${commit.slice(0, 12)}`);
    const unconsented = await repairCli(engine, ['--source', 'default', '--slug', 'notes/a', '--prefer', 'database', '--apply', '--expect', named.preview_hash]);
    expect(unconsented.exitCode).toBe(3);
    await settle();
    expect(readFileSync(join(root, 'notes/a.md'), 'utf8')).toContain(WRITER_LINE);
  }, backendOpts(backend)), 240_000);
  test(`${backend}: a file holding gbrain's own committed write of a revision the database has since moved past repairs in bulk as before`, () => managedBrain(async ({ engine, ctx, root }) => {
    await registerLocalWriter(engine, 'cli');
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    await engine.executeRaw("UPDATE persistence_host_bindings SET git_durability='enabled'");
    const first = (await engine.readPageSnapshot('notes/a', { sourceId: 'default' }))!;
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'notes/a', content: WRITER, request_id: randomUUID(), expected_revision: first.revision } });
    await settleManagedGitEffects(engine);
    const written = readFileSync(join(root, 'notes/a.md'));
    const second = (await engine.readPageSnapshot('notes/a', { sourceId: 'default' }))!;
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'notes/a', content: '---\ntype: concept\ntitle: A\n---\n\nA later database edit.\n',
      request_id: randomUUID(), expected_revision: second.revision } });
    await settleManagedGitEffects(engine);
    // The file goes back to gbrain's earlier write, a revision the page's version history keeps: the database copy is newer.
    writeFileSync(join(root, 'notes/a.md'), written);
    git(root, 'commit', '-qam', "back to gbrain's earlier write");
    await holdBoth(engine);
    const preview = await runner(engine, { held: true, side: 'both', prefer: 'database' });
    expect(preview.affected).toBe(1);
    expect(preview.residuals.kept_newer_file).toBeUndefined();
    expect((await runner(engine, { held: true, side: 'both', prefer: 'database', expect: preview.preview_hash })).outcomes).toEqual({ repaired: 1 });
    await settle();
    expect(readFileSync(join(root, 'notes/a.md'), 'utf8')).toContain('A later database edit.');
  }, backendOpts(backend)), 240_000);
  test(`${backend}: a database edit made after gbrain's own last commit of the file, shorter than the file, still wins an --all-drifted --only repair`, () => managedBrain(async ({ engine, ctx, root }) => {
    await registerLocalWriter(engine, 'cli');
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    await engine.executeRaw("UPDATE persistence_host_bindings SET git_durability='enabled'");
    const first = (await engine.readPageSnapshot('notes/a', { sourceId: 'default' }))!;
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'notes/a', content: WRITER, request_id: randomUUID(), expected_revision: first.revision } });
    await settleManagedGitEffects(engine);
    const commit = git(root, 'log', '-1', '--format=%H', '--', 'notes/a.md');
    expect(git(root, 'status', '--porcelain')).toBe('');
    // The database then takes a shorter edit that never reaches the file (write-through off): the database copy is newer.
    await engine.setConfig('sync.write_through', 'false');
    const written = (await engine.readPageSnapshot('notes/a', { sourceId: 'default' }))!;
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'notes/a', content: FIRST, request_id: randomUUID(), expected_revision: written.revision } });
    await engine.setConfig('sync.write_through', 'true');
    expect(readFileSync(join(root, 'notes/a.md'), 'utf8')).toContain(WRITER_LINE);
    expect(git(root, 'log', '-1', '--format=%H', '--', 'notes/a.md')).toBe(commit);
    const newer = (await engine.readPageSnapshot('notes/a', { sourceId: 'default' }))!;
    expect(newer.page.compiled_truth).not.toContain(WRITER_LINE);
    expect((await refusal(() => submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'notes/a', content: '---\ntype: concept\ntitle: A\n---\n\nA refused edit.\n',
      request_id: randomUUID(), expected_revision: newer.revision } }))).code).toBe('source_changed');

    const preview = await runner(engine, { allDrifted: true, only: ['notes/**'], prefer: 'database' });
    expect(preview.affected).toBe(1);
    expect(preview.residuals.kept_newer_file).toBeUndefined();
    expect(preview.listing!.find(entry => entry.item === 'default:notes/a')!.class).toBe('prefer_database');
    expect((await runner(engine, { allDrifted: true, only: ['notes/**'], prefer: 'database', expect: preview.preview_hash })).outcomes).toEqual({ repaired: 1 });
    await settleManagedGitEffects(engine);
    expect(readFileSync(join(root, 'notes/a.md'), 'utf8')).not.toContain(WRITER_LINE);
  }, backendOpts(backend)), 240_000);
  test(`${backend}: a file holding the blob sync adopted for gbrain's own write still loses to a later database edit when the version history no longer keeps that revision`, () => managedBrain(async ({ engine, ctx, root }) => {
    await registerLocalWriter(engine, 'cli');
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    await engine.executeRaw("UPDATE persistence_host_bindings SET git_durability='enabled'");
    const first = (await engine.readPageSnapshot('notes/a', { sourceId: 'default' }))!;
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'notes/a', content: WRITER, request_id: randomUUID(), expected_revision: first.revision } });
    await settleManagedGitEffects(engine);
    // Sync adopts gbrain's committed write into the page's import record.
    await performManagedSync(engine, SYNC);
    await engine.setConfig('sync.write_through', 'false');
    const written = (await engine.readPageSnapshot('notes/a', { sourceId: 'default' }))!;
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'notes/a', content: FIRST, request_id: randomUUID(), expected_revision: written.revision } });
    await engine.setConfig('sync.write_through', 'true');
    expect(readFileSync(join(root, 'notes/a.md'), 'utf8')).toContain(WRITER_LINE);
    const newer = (await engine.readPageSnapshot('notes/a', { sourceId: 'default' }))!;
    expect((await refusal(() => submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'notes/a', content: '---\ntype: concept\ntitle: A\n---\n\nA refused edit.\n',
      request_id: randomUUID(), expected_revision: newer.revision } }))).code).toBe('source_changed');
    // Retention pruned the version history, so no page_versions row keeps the revision gbrain's write carried.
    await engine.executeRaw("DELETE FROM page_versions WHERE page_id=(SELECT id FROM pages WHERE source_id='default' AND slug='notes/a')");
    const preview = await runner(engine, { allDrifted: true, only: ['notes/**'], prefer: 'database' });
    expect(preview.residuals.kept_newer_file).toBeUndefined();
    expect(preview.listing!.find(entry => entry.item === 'default:notes/a')!.class).toBe('prefer_database');
    expect((await runner(engine, { allDrifted: true, only: ['notes/**'], prefer: 'database', expect: preview.preview_hash })).outcomes).toEqual({ repaired: 1 });
    await settleManagedGitEffects(engine);
    expect(readFileSync(join(root, 'notes/a.md'), 'utf8')).not.toContain(WRITER_LINE);
  }, backendOpts(backend)), 240_000);
  test(`${backend}: --held --side deleted --state file_gone --prefer database keeps another writer's unimported delete (kept_newer_delete)`, () => brain(backend, async ({ engine, root }) => {
    git(root, 'rm', '-q', '--', 'notes/a.md'); git(root, 'commit', '-qm', 'other writer delete');
    const deleteCommit = git(root, 'rev-parse', 'HEAD');
    await holdDeleted(engine, 'notes/a', 'notes/a.md');
    const preview = await runner(engine, { held: true, side: 'deleted', state: 'file_gone', prefer: 'database' });
    expect(preview.affected).toBe(0);
    expect(preview.residuals).toMatchObject({ kept_newer_delete: 1 });
    const listed = preview.listing!.find(entry => entry.item === 'default:notes/a')!;
    expect(listed.class).toBe('kept_newer_delete');
    expect(listed.detail).toContain(`commit ${deleteCommit.slice(0, 12)} by Other Writer`);
    await runner(engine, { held: true, side: 'deleted', state: 'file_gone', prefer: 'database', expect: preview.preview_hash });
    await settle();
    expect(existsSync(join(root, 'notes/a.md'))).toBe(false);
    const named = JSON.parse((await repairCli(engine, ['--source', 'default', '--slug', 'notes/a', '--prefer', 'database'])).out).results[0];
    expect(named.details.pages[0]).toMatchObject({ action: 'recreate_file', discards: { reason: 'unimported_delete', commit: { sha: deleteCommit } } });
    const unconsented = await repairCli(engine, ['--source', 'default', '--slug', 'notes/a', '--prefer', 'database', '--apply', '--expect', named.preview_hash]);
    expect(unconsented.exitCode).toBe(3);
    expect(unconsented.out).toContain(deleteCommit.slice(0, 12));
    await settle();
    expect(existsSync(join(root, 'notes/a.md'))).toBe(false);
  }), 240_000);

  test(`${backend}: --held --state file_gone --provenance never_committed --prefer database keeps the page database-only and writes no file`, () => brain(backend, async ({ engine, ctx, root }) => {
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'notes/b', content: '---\ntype: concept\ntitle: B\n---\n\nOnly ever in the working tree.\n', request_id: randomUUID() } });
    await settleManagedGitEffects(engine);
    expect(git(root, 'log', '--oneline', '--', 'notes/b.md')).toBe('');
    const imported = await engine.readPageSnapshot('notes/b', { sourceId: 'default' });
    expect(imported?.page.compiled_truth).toContain('Only ever in the working tree.');
    rmSync(join(root, 'notes/b.md'));
    await holdDeleted(engine, 'notes/b', 'notes/b.md');
    const preview = await runner(engine, { held: true, side: 'deleted', state: 'file_gone', provenance: 'never_committed', prefer: 'database' });
    expect(preview.details!.pages).toEqual([expect.objectContaining({ slug: 'notes/b', action: 'detach_page' })]);
    expect((await runner(engine, { held: true, side: 'deleted', state: 'file_gone', provenance: 'never_committed', prefer: 'database', expect: preview.preview_hash })).outcomes).toEqual({ repaired: 1 });
    await settle();
    expect(existsSync(join(root, 'notes/b.md'))).toBe(false);
    expect((await engine.readPageSnapshot('notes/b', { sourceId: 'default' }))?.page.compiled_truth).toContain('Only ever in the working tree.');
    expect(fileHasEdit(root)).toBe(true);
  }), 240_000);
}
