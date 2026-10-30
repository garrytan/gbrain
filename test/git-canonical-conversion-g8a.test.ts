/**
 * G8a of git-canonical memory (docs/designs/GIT_CANONICAL_MEMORY.md#conversion): `gbrain sources canonical <id> --to git|mixed`.
 * A mixed source with every category present converts with the right action for each: database_ahead and undeclared
 * pages are written from the database and committed through the door (one commit per group), declared pages stay
 * database-only, a page Git moved is indexed, a held deletion and an unknown-side drift take Git's side, a parked effect
 * on an ignored path is reclassified as declared. Afterwards the tree is clean, the census shows no gap, the adopted rows
 * kept their revisions and a G3 pass changes nothing. A stale hash refuses; database content that would be discarded
 * refuses and writes nothing; a crash after a group's commit leaves the source non-strict and a rerun completes once;
 * --to mixed round-trips; remote callers and unmanaged brains cannot reach it.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { operations } from '../src/core/operations.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { acquireWorktree } from '../src/core/persistence/ownership.ts';
import { writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { resolveManagedSyncContext } from '../src/core/persistence/sync-discovery.ts';
import { ADOPTION_BATCH, applyGitConversion, applyMixedConversion, CONVERSION_GROUP_MAX, planGitConversion, planMixedConversion } from '../src/core/persistence/git-conversion.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { inlineExportMarkdown, readExportPage, readExportWithdrawals } from '../src/core/export-snapshot.ts';
import { withSubmissionAuthority } from '../src/core/minions/submission-authority.ts';
import { censusGitGap } from '../src/commands/sources-git-gap.ts';
import { describeGitPreview, runSourcesCanonical } from '../src/commands/sources-canonical.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { managedBrain, type ManagedBrain } from './helpers/managed-brain.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (slug: string, body: string, extra = '') => '---\ntype: concept\ntitle: ' + slug + '\n' + extra + '---\n\n' + body + '\n';
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const PROCESSING = { noEmbed: true, noExtract: true };
const putPage = operations.find(op => op.name === 'put_page')!;

const strict = async (engine: BrainEngine) => (await engine.executeRaw<{ s: boolean }>("SELECT COALESCE(config->>'canonical','')='git' AS s FROM sources WHERE id='default'"))[0]!.s;
const page = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ body: string; deleted: boolean; revision: string }>(
  "SELECT compiled_truth AS body, deleted_at IS NOT NULL AS deleted, knowledge_revision::text AS revision FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0];
const revisions = async (engine: BrainEngine) => Object.fromEntries((await engine.executeRaw<{ slug: string; revision: string }>(
  "SELECT slug, knowledge_revision::text AS revision FROM pages WHERE source_id='default' AND deleted_at IS NULL ORDER BY slug")).map(row => [row.slug, row.revision]));
const holds = async (engine: BrainEngine) => (await engine.executeRaw<{ r: { path: string; code: string } }>(
  "SELECT completed_keys->0 AS r FROM op_checkpoints WHERE op='sync-hold' ORDER BY fingerprint")).map(({ r }) => `${r.path} ${r.code}`);
/** A database-only edit: the page moves to a revision no request and no import wrote. */
const databaseOnlyEdit = (engine: BrainEngine, slug: string, body: string) => engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
  "UPDATE pages SET compiled_truth=$1, knowledge_revision=$2::uuid, revision_write_request_id=NULL WHERE source_id='default' AND slug=$3", [body, randomUUID(), slug]), TEST_WRITE_ATTRIBUTION));
/** A page written while write-through is off: a row with no file. */
async function databaseOnlyPage(brain: ManagedBrain, slug: string, content: string): Promise<void> {
  await brain.engine.setConfig('sync.write_through', 'false');
  try { await putPage.handler(brain.ctx, { slug, content, wait_ms: 30_000 }); } finally { await brain.engine.setConfig('sync.write_through', 'true'); }
}
const conversionCommits = (root: string, since: string) => git(root, 'log', '--reverse', '--format=@%s', '--name-only', `${since}..HEAD`).split('@').filter(Boolean)
  .map(entry => { const [subject, ...paths] = entry.trim().split('\n').filter(Boolean); return { subject, paths: paths.sort() }; });

async function cli(engine: BrainEngine, args: string[]): Promise<Record<string, any>> {
  const lines: string[] = [];
  const log = console.log, priorExitCode = process.exitCode;
  console.log = (line: unknown) => { lines.push(String(line)); };
  try { await runSourcesCanonical(engine, [...args, '--json']); } finally { console.log = log; _resetCliExitVerdictForTests(); process.exitCode = priorExitCode ?? 0; }
  return JSON.parse(lines.at(-1)!);
}

/** A Git effect parked on an ignored target, as an older gbrain left one (the census test's fixture, test/git-gap-census.test.ts). */
async function parkIgnoredEffect(engine: BrainEngine, slug: string, code = 'git_target_ignored'): Promise<void> {
  const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.persistence_protocol','2',true)");
    // Already terminal (state failed), as a parked receipt is: no owner pass claims it.
    const [request] = await tx.executeRaw<{ id: string }>(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,
        intent_bytes,terminal_reservation,state,completed_at) VALUES ('local_cli','test',$1::uuid,'put_page','default',$2::uuid,$3,'x','{}'::jsonb,0,16384,'failed',now()) RETURNING id::text`, [randomUUID(), incarnation, slug]);
    await tx.executeRaw(`INSERT INTO persistence_effects(request_id,kind,data,state,error_code,source_id,source_incarnation) VALUES ($1::uuid,'git',$2::text::jsonb,'failed','targets_parked','default',$3::uuid)`,
      [request!.id, JSON.stringify({ parked: [{ slug, error_code: code, rule: '.gitignore:1: scratch/' }] }), incarnation]);
  });
}

const SLUGS = ['notes/same', 'notes/ahead', 'notes/gitmoved', 'notes/drift', 'notes/removed', 'notes/legacy'];
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  // The door commits with the repository's own identity: CI runners have no global one.
  git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
  writeFileSync(join(root, '.gitignore'), 'scratch/\n');
  for (const slug of SLUGS) writeFileSync(join(root, `${slug}.md`), note(slug, `The committed body of ${slug}.`));
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'notes');
};

const BULK = CONVERSION_GROUP_MAX + 1;
const bulkSetup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'bulk'), { recursive: true }); git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
  for (let i = 0; i < BULK; i++) writeFileSync(join(root, `bulk/p${String(i).padStart(3, '0')}.md`), note(`bulk/p${i}`, `Committed body ${i}.`));
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'bulk');
};

const WIDE = 300, FENCED_EVERY = 5;
const factsFence = (claim: string) => renderFactsTable([{ rowNum: 1, claim, kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium', active: true, context: '' }]);
const wideSetup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'wide'), { recursive: true }); git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
  for (let i = 0; i < WIDE; i++) {
    writeFileSync(join(root, `wide/p${String(i).padStart(3, '0')}.md`), note(`wide/p${String(i).padStart(3, '0')}`, i % FENCED_EVERY ? `Committed body ${i}.` : `Committed body ${i}.\n\n${factsFence(`Wide claim ${i}`)}`));
  }
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'wide');
};
/**
 * Statements that read a page's export view: the per-page read (readExportPage), the batch read (readExportPages) and the
 * fence normalization of either (overlayCanonicalBodies, or readExportPages' batch normalization). Page snapshot reads by background
 * projection work normalize stored columns, never a parameter, so they do not match.
 */
const EXPORT_READ = /export_page AS MATERIALIZED|AS k\(id, source_id, slug\)|string_to_array\(\$1::text|AS t\(body, timeline, i\)/;

/** The page loses its sync import record, as a page imported before records were written has none. */
async function dropImportRecord(engine: BrainEngine, slug: string): Promise<void> {
  const [row] = await engine.executeRaw<{ id: string }>("SELECT id::text FROM pages WHERE source_id='default' AND slug=$1", [slug]);
  await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='sync-import-provenance' AND fingerprint LIKE $1", [`default:%:${row!.id}`]);
}

/**
 * notes/same moved on both sides with no import record, so sync holds it (file_drift, side unknown), and then was declared
 * database-only (not a privacy class) in the database: a declared page whose committed file differs from its row, at a held path.
 */
async function heldDeclaredDrift(brain: ManagedBrain): Promise<void> {
  const { engine, root } = brain;
  expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
  await databaseOnlyEdit(engine, 'notes/same', 'Written to the database alone: notes/same.');
  writeFileSync(join(root, 'notes/same.md'), note('notes/same', 'The committed edit of notes/same.'));
  git(root, 'commit', '-qam', 'edit same');
  await dropImportRecord(engine, 'notes/same');
  await performManagedSync(engine, OPTS);
  expect(await holds(engine)).toEqual(['notes/same.md file_drift']);
  await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
    "UPDATE pages SET database_only_reason='db_only' WHERE source_id='default' AND slug='notes/same'"), TEST_WRITE_ATTRIBUTION));
}

const PRIVATE = (slug: string, body: string) => note(slug, body, 'visibility: private\n');
const pageRow = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ body: string; deleted: boolean; source_path: string | null; withheld: string | null; reason: string | null }>(
  "SELECT compiled_truth AS body, deleted_at IS NOT NULL AS deleted, source_path, withheld_source_path AS withheld, database_only_reason AS reason FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0]!;
const atHead = (root: string, path: string) => git(root, 'ls-tree', '--name-only', 'HEAD', '--', path);

/** A private page imported from a committed file (notes/private), as a source that predates G7a holds one. */
async function committedPrivatePage(brain: ManagedBrain): Promise<void> {
  const { engine, root } = brain;
  writeFileSync(join(root, 'notes/private.md'), PRIVATE('notes/private', 'A private note.'));
  git(root, 'add', 'notes/private.md'); git(root, 'commit', '-qm', 'a private note');
  expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
  expect(atHead(root, 'notes/private.md')).toBe('notes/private.md');
  expect((await pageRow(engine, 'notes/private')).source_path).toBe('notes/private.md');
}

/** setup, with a bare tracking remote beside the checkout whose pre-receive hook rejects every push. */
const remoteOf = (root: string) => join(dirname(root), 'remote.git');
const closedRemoteSetup = (brain: { root: string }) => {
  setup(brain);
  execFileSync('git', ['init', '-q', '--bare', remoteOf(brain.root)]);
  git(brain.root, 'remote', 'add', 'origin', remoteOf(brain.root));
  git(brain.root, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  git(brain.root, 'branch', '--set-upstream-to=origin/main');
  writeFileSync(join(remoteOf(brain.root), 'hooks', 'pre-receive'), '#!/bin/sh\necho "pushes are closed" >&2\nexit 1\n', { mode: 0o755 });
};

/** That private page, edited in the database, whose file is then removed by hand: sync holds it (file_drift, deleted). */
async function privateRemovedByHand(brain: ManagedBrain): Promise<void> {
  const { engine, root } = brain;
  await committedPrivatePage(brain);
  await databaseOnlyEdit(engine, 'notes/private', 'A private note, edited in the database.');
  git(root, 'rm', '-q', 'notes/private.md'); git(root, 'commit', '-qm', 'remove by hand');
  await performManagedSync(engine, OPTS);
  expect(await holds(engine)).toEqual(['notes/private.md file_drift']);
}

const DRIFT_COMMITTED = 'The committed edit of notes/drift.';
/**
 * Every category on one non-strict source: notes/ahead and notes/dbonly hold content Git lacks, and notes/legacy has no
 * import record and a database edit (adopt); notes/secret is private and scratch/ignored is under an ignored path whose
 * Git effect parked (declared, reclassified); notes/gitmoved got a commit sync has not read (git wins); notes/removed was
 * deleted in Git after a database edit (held deletion, Git wins); notes/drift moved on both sides without an import record
 * (held, side unknown); a later database write that matches the commit (`driftMatches`) leaves the hold with nothing to
 * lose, so Git wins; otherwise the database edit would be discarded.
 */
async function mixedSource(brain: ManagedBrain, driftMatches = true): Promise<void> {
  const { engine, root } = brain;
  expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
  for (const slug of ['notes/ahead', 'notes/drift', 'notes/removed', 'notes/legacy']) await databaseOnlyEdit(engine, slug, `Written to the database alone: ${slug}.`);
  writeFileSync(join(root, 'notes/drift.md'), note('notes/drift', DRIFT_COMMITTED));
  git(root, 'rm', '-q', 'notes/removed.md'); git(root, 'commit', '-qam', 'edit drift, remove removed');
  await dropImportRecord(engine, 'notes/drift');
  await dropImportRecord(engine, 'notes/legacy');
  await databaseOnlyPage(brain, 'notes/dbonly', note('notes/dbonly', 'Only in the database.'));
  await databaseOnlyPage(brain, 'notes/secret', note('notes/secret', 'A private note.', 'visibility: private\n'));
  await putPage.handler(brain.ctx, { slug: 'scratch/ignored', content: note('scratch/ignored', 'Under an ignored path.'), wait_ms: 30_000 });
  await parkIgnoredEffect(engine, 'scratch/ignored');
  await performManagedSync(engine, OPTS);
  expect(await holds(engine)).toEqual(['notes/drift.md file_drift', 'notes/removed.md file_drift']);
  if (driftMatches) await databaseOnlyEdit(engine, 'notes/drift', DRIFT_COMMITTED);
  writeFileSync(join(root, 'notes/gitmoved.md'), note('notes/gitmoved', 'The committed edit of notes/gitmoved.'));
  git(root, 'commit', '-qam', 'edit gitmoved');
}

for (const backend of testBackends()) describe(`[${backend}] G8a: sources canonical converts a source to git-canonical and back`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('a mixed source with every category converts with the right action for each', () => managedBrain(async brain => {
    const { engine, root } = brain;
    await mixedSource(brain);
    const base = git(root, 'rev-parse', 'HEAD');
    const before = await revisions(engine);
    const { preview } = await planGitConversion(engine, 'default');
    expect(preview).toMatchObject({ strict: false, adopt: { count: 3, groups: 1, by: { database_ahead: 2, undeclared_database_only: 1, worktree_only: 0 } },
      declared: { count: 2, by: { private: 1, git_ignored: 1 } }, git_wins: { count: 3, by: { git_ahead: 1, held_deletion: 1, held_drift_unknown: 1, deleted_by_commit: 0 } },
      holds: { count: 2, by: { 'file_drift:unknown': 1, 'file_drift:deleted': 1 } }, parked_effects: { count: 1, retry: 0, reclassify: 1 }, discard: { count: 0 } });
    expect(preview.adopt.sample.sort()).toEqual(['notes/ahead.md', 'notes/dbonly.md', 'notes/legacy.md']);
    expect(preview.git_wins.sample.sort()).toEqual(['notes/drift.md', 'notes/gitmoved.md', 'notes/removed.md']);
    expect(await strict(engine)).toBe(false);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(base);

    const result = await applyGitConversion(engine, 'default', preview.preview_hash, PROCESSING);
    expect(result).toMatchObject({ status: 'converted', committed: { groups: 1, pages: 3 }, holds_cleared: 2, parked: { reclassified: 1 },
      after: { remaining: 0, strict: true, parked_effects: { count: 0 } } });
    expect(await strict(engine)).toBe(true);
    expect(conversionCommits(root, base)).toEqual([{ subject: 'gbrain: persist 3 canonical memory updates', paths: ['notes/ahead.md', 'notes/dbonly.md', 'notes/legacy.md'] }]);
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(root, 'notes/ahead.md'), 'utf8')).toContain('Written to the database alone: notes/ahead.');
    const after = await revisions(engine);
    expect(after['notes/ahead']).toBe(before['notes/ahead']);
    expect(after['notes/dbonly']).toBe(before['notes/dbonly']);
    // A page with no import record is adopted into Git before the strict import runs, so its database body is committed, never overwritten.
    expect(readFileSync(join(root, 'notes/legacy.md'), 'utf8')).toContain('Written to the database alone: notes/legacy.');
    expect(after['notes/legacy']).toBe(before['notes/legacy']);
    expect((await page(engine, 'notes/legacy'))!.body).toContain('Written to the database alone: notes/legacy.');
    expect(after['notes/same']).toBe(before['notes/same']);
    expect((await page(engine, 'notes/gitmoved'))!.body).toContain('The committed edit of notes/gitmoved.');
    expect((await page(engine, 'notes/drift'))!.body).toContain(DRIFT_COMMITTED);
    expect((await page(engine, 'notes/removed'))!.deleted).toBe(true);
    expect((await page(engine, 'notes/secret'))!.deleted).toBe(false);
    // The page under an ignored path stays database-only (declared git_ignored): no file is written, no git_target_ignored round trip.
    expect((await page(engine, 'scratch/ignored'))!.deleted).toBe(false);
    expect(existsSync(join(root, 'scratch/ignored.md'))).toBe(false);
    expect(await holds(engine)).toEqual([]);
    const census = await censusGitGap(engine, 'default', { sample: 20 });
    expect(census.states).toMatchObject({ database_ahead: 0, git_ahead: 0, undeclared_database_only: 0, worktree_only: 0, unparseable: 0, unsafe_path: 0 });
    expect(census.declared).toMatchObject({ private: 1, git_ignored: 1 });
    const [record] = await engine.executeRaw<{ r: Record<string, unknown> }>("SELECT completed_keys->0 AS r FROM op_checkpoints WHERE op='git-canonical-conversion'");
    expect(record!.r).toMatchObject({ source_id: 'default', to: 'git', preview_hash: preview.preview_hash });

    // A G3 pass afterwards changes nothing.
    const settled = await revisions(engine);
    expect((await performManagedSync(engine, OPTS)).status).toBe('up_to_date');
    expect(await revisions(engine)).toEqual(settled);
    expect(git(root, 'log', '--format=%H', '-1')).toBe(git(root, 'rev-parse', 'HEAD'));
    expect((await planGitConversion(engine, 'default')).preview).toMatchObject({ strict: true, remaining: 0 });
  }, { databaseUrl, setup }), 240_000);

  test('an unknown-side drift whose database body differs from the committed file is a discard, refused by path', () => managedBrain(async brain => {
    const { engine, root } = brain;
    await mixedSource(brain, false);
    const base = git(root, 'rev-parse', 'HEAD');
    const { preview } = await planGitConversion(engine, 'default');
    expect(preview).toMatchObject({ git_wins: { by: { held_drift_unknown: 0 } }, discard: { count: 1, by: { held_drift_unknown_differs: 1 }, sample: ['notes/drift.md'] } });
    const before = await revisions(engine), status = git(root, 'status', '--porcelain');
    await expect(applyGitConversion(engine, 'default', preview.preview_hash, PROCESSING)).rejects.toMatchObject({ code: 'git_conversion_blocked', detail: 'held_drift_unknown_differs' });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(base);
    expect(git(root, 'status', '--porcelain')).toBe(status);
    // Nothing the plan placed moved: the declared pages stay live with no file, and Git's verdicts are not applied.
    expect(await revisions(engine)).toEqual(before);
    expect((await page(engine, 'notes/secret'))!.deleted).toBe(false);
    expect(existsSync(join(root, 'notes/secret.md'))).toBe(false);
    expect(existsSync(join(root, 'scratch/ignored.md'))).toBe(false);
    expect((await page(engine, 'notes/removed'))!.deleted).toBe(false);
    expect((await page(engine, 'notes/gitmoved'))!.body).not.toContain('The committed edit of notes/gitmoved.');
    expect(await strict(engine)).toBe(false);
    expect(await holds(engine)).toEqual(['notes/drift.md file_drift', 'notes/removed.md file_drift']);
    expect((await page(engine, 'notes/drift'))!.body).toContain('Written to the database alone: notes/drift.');
  }, { databaseUrl, setup }), 240_000);

  test('a stale hash refuses preview_changed and writes nothing', () => managedBrain(async brain => {
    const { engine, root } = brain;
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await databaseOnlyEdit(engine, 'notes/ahead', 'Written to the database alone.');
    const base = git(root, 'rev-parse', 'HEAD');
    const preview = await cli(engine, ['default', '--to', 'git']);
    expect(preview).toMatchObject({ status: 'preview', adopt: { count: 1 } });
    const refused = await cli(engine, ['default', '--to', 'git', '--apply', '--expect', 'stale']);
    expect(refused).toMatchObject({ status: 'refused', code: 'preview_changed' });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(base);
    expect(await strict(engine)).toBe(false);
    expect(readFileSync(join(root, 'notes/ahead.md'), 'utf8')).toContain('The committed body of notes/ahead.');
  }, { databaseUrl, setup }), 180_000);

  test('database content that would be discarded refuses by category and writes nothing', () => managedBrain(async brain => {
    const { engine, root } = brain;
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await databaseOnlyEdit(engine, 'notes/ahead', 'Written to the database alone.');
    const edit = note('notes/ahead', 'An uncommitted edit of notes/ahead.');
    writeFileSync(join(root, 'notes/ahead.md'), edit);
    const base = git(root, 'rev-parse', 'HEAD');
    const { preview } = await planGitConversion(engine, 'default');
    expect(preview).toMatchObject({ adopt: { count: 0 }, discard: { count: 1, by: { uncommitted_edit: 1 }, sample: ['notes/ahead.md'] } });
    await expect(applyGitConversion(engine, 'default', preview.preview_hash, PROCESSING)).rejects.toMatchObject({ code: 'git_conversion_blocked', detail: 'uncommitted_edit' });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(base);
    expect(readFileSync(join(root, 'notes/ahead.md'), 'utf8')).toBe(edit);
    expect(await strict(engine)).toBe(false);
    expect((await page(engine, 'notes/ahead'))!.body).toContain('Written to the database alone.');
  }, { databaseUrl, setup }), 180_000);

  test('a crash after a group commit leaves the source non-strict, and a rerun completes once', () => managedBrain(async brain => {
    const { engine, root } = brain;
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await databaseOnlyEdit(engine, 'notes/ahead', 'Written to the database alone.');
    await databaseOnlyPage(brain, 'notes/dbonly', note('notes/dbonly', 'Only in the database.'));
    const base = git(root, 'rev-parse', 'HEAD');
    const first = (await planGitConversion(engine, 'default')).preview;
    installFaultHook(point => { if (point === 'conversion:group_committed') throw new Error('crash after the group commit'); });
    try { await expect(applyGitConversion(engine, 'default', first.preview_hash, PROCESSING)).rejects.toThrow('crash after the group commit'); }
    finally { installFaultHook(undefined); }
    expect(await strict(engine)).toBe(false);
    expect(conversionCommits(root, base)).toHaveLength(1);
    const rerun = (await planGitConversion(engine, 'default')).preview;
    expect(rerun.preview_hash).not.toBe(first.preview_hash);
    expect(rerun).toMatchObject({ adopt: { count: 0 }, discard: { count: 0 } });
    expect(await applyGitConversion(engine, 'default', rerun.preview_hash, PROCESSING)).toMatchObject({ status: 'converted', committed: { pages: 0 } });
    expect(await strict(engine)).toBe(true);
    expect(conversionCommits(root, base)).toEqual([{ subject: 'gbrain: persist 2 canonical memory updates', paths: ['notes/ahead.md', 'notes/dbonly.md'] }]);
    expect(git(root, 'status', '--porcelain')).toBe('');
  }, { databaseUrl, setup }), 180_000);

  test('more pages than one group commit one door commit per group, and the writer lock is free between groups', () => managedBrain(async brain => {
    const { engine, root } = brain;
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
      "UPDATE pages SET compiled_truth=compiled_truth || ' Edited in the database.', knowledge_revision=gen_random_uuid(), revision_write_request_id=NULL WHERE source_id='default' AND slug LIKE 'bulk/%'"), TEST_WRITE_ATTRIBUTION));
    const base = git(root, 'rev-parse', 'HEAD');
    const { preview } = await planGitConversion(engine, 'default');
    expect(preview).toMatchObject({ adopt: { count: BULK, groups: 2 }, discard: { count: 0 } });
    const { binding } = await resolveManagedSyncContext(engine, { ...OPTS, dryRun: true });
    const free: boolean[] = [];
    installFaultHook(async point => {
      if (point !== 'conversion:group_committed') return;
      const lock = await acquireWorktree(binding, 1_000, undefined, engine, { yieldLanes: true });
      free.push(lock !== null);
      await lock?.release();
    });
    try { expect(await applyGitConversion(engine, 'default', preview.preview_hash, PROCESSING)).toMatchObject({ status: 'converted', committed: { groups: 2, pages: BULK } }); }
    finally { installFaultHook(undefined); }
    expect(free).toEqual([true, true]);
    const commits = conversionCommits(root, base);
    expect(commits.map(commit => [commit.subject, commit.paths.length])).toEqual([
      [`gbrain: persist ${CONVERSION_GROUP_MAX} canonical memory updates`, CONVERSION_GROUP_MAX], ['gbrain: persist canonical memory update', 1]]);
    expect(git(root, 'status', '--porcelain')).toBe('');
  }, { databaseUrl, setup: bulkSetup }), 300_000);

  test('#7617: the plan reads export views a batch at a time, never one page per round trip', () => managedBrain(async brain => {
    const { engine } = brain;
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
      await tx.executeRaw(`UPDATE pages SET compiled_truth=compiled_truth || ' Edited in the database.', knowledge_revision=gen_random_uuid(), revision_write_request_id=NULL
        WHERE source_id='default' AND slug LIKE 'wide/%' AND right(slug,1)::int % 2 = 1`);
      await tx.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth,timeline,frontmatter)
        SELECT 'default','dbonly/p'||lpad(n::text,3,'0'),'concept','dbonly/p'||lpad(n::text,3,'0'),CASE WHEN n%$2::int=0 THEN 'Only in the database '||n||'.'||chr(10)||chr(10)||$3 ELSE 'Only in the database '||n||'.' END,'',
          jsonb_build_object('type','concept','title','dbonly/p'||lpad(n::text,3,'0'))
        FROM generate_series(0,$1::int - 1) n`, [WIDE, FENCED_EVERY, factsFence('A database-only claim')]);
      // An unrelated withdrawal: every fenced page's export view runs the overlay, and none changes.
      await tx.executeRaw("INSERT INTO fact_withdrawals(source_id,visibility,fact_hash) VALUES ('default','world',gbrain_fact_fingerprint('An unrelated withdrawn claim'))");
    }, TEST_WRITE_ATTRIBUTION));
    const real = engine.executeRaw;
    let reads = 0;
    engine.executeRaw = async function (query, params, options) { if (EXPORT_READ.test(query)) reads++; return real.call(this, query, params, options) as never; };
    let preview;
    try { ({ preview } = await planGitConversion(engine, 'default')); } finally { engine.executeRaw = real; }
    expect(preview).toMatchObject({ pages: 2 * WIDE, equal: WIDE / 2, adopt: { count: WIDE / 2 + WIDE, by: { database_ahead: WIDE / 2, undeclared_database_only: WIDE } }, discard: { count: 0 } });
    // The census reads each batch of compared pages in one statement plus one fence normalization; adoption reuses the
    // census's view of a database_ahead page and reads the database-only pages ADOPTION_BATCH at a time the same way.
    expect(reads).toBeLessThanOrEqual(2 * (Math.ceil(2 * WIDE / 256) + Math.ceil(WIDE / ADOPTION_BATCH)));
  }, { databaseUrl, setup: wideSetup }), 300_000);

  test('#7618: a target whose ignore status Git cannot read is discarded on its own, and every other candidate adopts', () => managedBrain(async brain => {
    const { engine, root } = brain;
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    mkdirSync(join(root, 'real'));
    symlinkSync('real', join(root, 'link'));
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth,timeline,frontmatter)
      SELECT 'default',s,'concept',s,'Only in the database.','',jsonb_build_object('type','concept','title',s)
      FROM (SELECT CASE WHEN n=150 THEN 'link/beyond' ELSE 'dbonly/p'||lpad(n::text,3,'0') END AS s FROM generate_series(0,$1::int - 1) n) pages`, [WIDE]), TEST_WRITE_ATTRIBUTION));
    const { preview } = await planGitConversion(engine, 'default');
    expect(preview.adopt).toMatchObject({ count: WIDE - 1, by: { undeclared_database_only: WIDE - 1 } });
    expect(preview.discard).toMatchObject({ count: 1, by: { ignore_status_unknown: 1, ignored_target: 0 }, sample: ['link/beyond.md'], detail: { ignore_status_unknown: { symlink: 1 } } });
    expect(describeGitPreview(preview)).toContain('ignore_status_unknown symlink 1');
    const base = git(root, 'rev-parse', 'HEAD'), before = await revisions(engine);
    await expect(applyGitConversion(engine, 'default', preview.preview_hash, PROCESSING)).rejects.toMatchObject({ code: 'git_conversion_blocked', detail: 'ignore_status_unknown' });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(base);
    expect(existsSync(join(root, 'real/beyond.md'))).toBe(false);
    expect(existsSync(join(root, 'dbonly'))).toBe(false);
    expect(await revisions(engine)).toEqual(before);
    expect(await strict(engine)).toBe(false);
  }, { databaseUrl, setup }), 300_000);

  test('#7618: a hold at a declared page\'s path is judged by the strict verdict, so a page Git would overwrite is a discard', () => managedBrain(async brain => {
    const { engine, root } = brain;
    await heldDeclaredDrift(brain);
    const base = git(root, 'rev-parse', 'HEAD');
    const { preview } = await planGitConversion(engine, 'default');
    expect(preview).toMatchObject({ declared: { by: { database_only: 1 } }, withhold: { count: 0 }, holds: { count: 1, unplaced: { count: 1, by: { 'file_drift:unknown': 1 } } },
      discard: { count: 1, by: { git_overwrites_database: 1 }, sample: ['notes/same.md'] } });
    expect(Object.values(preview.discard.detail.git_overwrites_database)).toEqual([{ 'declared:database_only': 1 }]);
    await expect(applyGitConversion(engine, 'default', preview.preview_hash, PROCESSING)).rejects.toMatchObject({ code: 'git_conversion_blocked', detail: 'git_overwrites_database' });
    expect(await holds(engine)).toEqual(['notes/same.md file_drift']);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(base);
    expect((await page(engine, 'notes/same'))!.body).toContain('Written to the database alone: notes/same.');
  }, { databaseUrl, setup }), 180_000);

  test('#7618: the preview counts each discard by its cause', () => managedBrain(async brain => {
    const { engine, root } = brain;
    await heldDeclaredDrift(brain);
    for (const slug of ['notes/ahead', 'notes/legacy']) await databaseOnlyEdit(engine, slug, `Written to the database alone: ${slug}.`);
    writeFileSync(join(root, 'notes/ahead.md'), note('notes/ahead', 'An uncommitted edit of notes/ahead.'));
    rmSync(join(root, 'notes/legacy.md'));
    await databaseOnlyPage(brain, 'notes/dbonly', note('notes/dbonly', 'Only in the database.'));
    writeFileSync(join(root, 'notes/dbonly.md'), note('notes/dbonly', 'An untracked file that differs.'));
    // Committed without a sync: a broken frontmatter, bytes that are not UTF-8, and a symlink where a page's file was.
    writeFileSync(join(root, 'notes/gitmoved.md'), '---\ntitle: [unclosed\n---\nBody\n');
    writeFileSync(join(root, 'notes/removed.md'), Buffer.from([0xff, 0xfe, 0x00]));
    rmSync(join(root, 'notes/drift.md')); symlinkSync('same.md', join(root, 'notes/drift.md'));
    git(root, 'add', 'notes/gitmoved.md', 'notes/removed.md', 'notes/drift.md'); git(root, 'commit', '-qm', 'unreadable files');
    // Database-only rows whose export reads back different: a padded title, and frontmatter tags with no tag rows.
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth,timeline,frontmatter)
      VALUES ('default','notes/padded','concept','  Padded title  ','Body.','','{}'::jsonb), ('default','notes/tagged','concept','Tagged','Body.','',$1::text::jsonb)`,
      [JSON.stringify({ tags: ['alpha-example'] })]), TEST_WRITE_ATTRIBUTION));
    const { preview } = await planGitConversion(engine, 'default');
    expect(preview.discard.by).toMatchObject({ git_overwrites_database: 1, uncommitted_edit: 3, unparseable: 3, export_mismatch: 2 });
    expect(preview.discard.detail).toMatchObject({ uncommitted_edit: { modified: 1, deleted: 1, untracked: 1 }, unparseable: { frontmatter: 1, not_utf8: 1, symlink: 1 },
      export_mismatch: { '/title': 1, '/tags': 1 } });
    expect(Object.values(preview.discard.detail.git_overwrites_database)).toEqual([{ 'declared:database_only': 1 }]);
    const lines = describeGitPreview(preview);
    expect(lines).toContain('uncommitted_edit deleted 1');
    expect(lines).toContain('1 at a path nothing else placed (file_drift:unknown 1)');
    // The hash binds the counts (discard.by), not the causes, and reading the plan again gives the same one.
    const again = (await planGitConversion(engine, 'default')).preview;
    expect(again.preview_hash).toBe(preview.preview_hash);
  }, { databaseUrl, setup }), 180_000);

  test('#7618: a private page that differs from its committed file withholds it: the removal is committed and the page stays live and unchanged', () => managedBrain(async brain => {
    const { engine, root } = brain;
    await committedPrivatePage(brain);
    await databaseOnlyEdit(engine, 'notes/private', 'A private note, edited in the database.');
    const before = await pageRow(engine, 'notes/private'), base = git(root, 'rev-parse', 'HEAD');
    const { preview } = await planGitConversion(engine, 'default');
    expect(preview).toMatchObject({ declared: { by: { private: 1 } }, withhold: { count: 1, groups: 1, by: { file_committed: 1, file_absent: 0 }, sample: ['notes/private.md'] },
      discard: { count: 0 }, index: { deletes: 0 } });
    const result = await applyGitConversion(engine, 'default', preview.preview_hash, PROCESSING);
    expect(result).toMatchObject({ status: 'converted', withheld: { pages: 1 }, after: { remaining: 0, withhold: { count: 0 } } });
    expect(result.withheld.commits).toHaveLength(1);
    expect(conversionCommits(root, base)).toEqual([{ subject: expect.any(String), paths: ['notes/private.md'] }]);
    expect(atHead(root, 'notes/private.md')).toBe('');
    expect(existsSync(join(root, 'notes/private.md'))).toBe(false);
    expect(await pageRow(engine, 'notes/private')).toEqual({ body: before.body, deleted: false, source_path: null, withheld: 'notes/private.md', reason: 'private' });
    const settled = await revisions(engine);
    expect((await performManagedSync(engine, OPTS)).status).toBe('up_to_date');
    expect(await revisions(engine)).toEqual(settled);
    expect((await pageRow(engine, 'notes/private')).deleted).toBe(false);
  }, { databaseUrl, setup }), 180_000);

  test('#7618: a private page equal to its committed file is settled: no withhold, no discard, and the file stays in HEAD', () => managedBrain(async brain => {
    const { engine, root } = brain;
    await committedPrivatePage(brain);
    // No import record, as a page imported before records were written has none: the strict level reads it unverified.
    await dropImportRecord(engine, 'notes/private');
    const before = await pageRow(engine, 'notes/private'), revision = (await page(engine, 'notes/private'))!.revision, base = git(root, 'rev-parse', 'HEAD');
    const { preview } = await planGitConversion(engine, 'default');
    expect(preview).toMatchObject({ declared: { by: { private: 1 }, committed_equal: 1 }, withhold: { count: 0 }, discard: { count: 0 }, remaining: 0 });
    const result = await applyGitConversion(engine, 'default', preview.preview_hash, PROCESSING);
    expect(result).toMatchObject({ status: 'converted', withheld: { pages: 0 }, after: { remaining: 0 } });
    expect(await strict(engine)).toBe(true);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(base);
    expect(atHead(root, 'notes/private.md')).toBe('notes/private.md');
    expect(await pageRow(engine, 'notes/private')).toEqual(before);
    expect((await page(engine, 'notes/private'))!.revision).toBe(revision);
  }, { databaseUrl, setup }), 180_000);

  test('#7618 regression: converting never deletes a private page whose file was removed by hand', () => managedBrain(async brain => {
    const { engine, root } = brain;
    // Removed and committed with no sync since: the strict pass would read a live page whose file a commit removed.
    await committedPrivatePage(brain);
    git(root, 'rm', '-q', 'notes/private.md'); git(root, 'commit', '-qm', 'remove by hand');
    const before = await pageRow(engine, 'notes/private');
    const { preview } = await planGitConversion(engine, 'default');
    await applyGitConversion(engine, 'default', preview.preview_hash, PROCESSING);
    expect(await pageRow(engine, 'notes/private')).toMatchObject({ body: before.body, deleted: false });
  }, { databaseUrl, setup }), 180_000);

  test('#7618: a private page whose file was removed by hand only withholds its origin, and the strict pass leaves it unchanged', () => managedBrain(async brain => {
    const { engine, root } = brain;
    await privateRemovedByHand(brain);
    const before = await pageRow(engine, 'notes/private'), base = git(root, 'rev-parse', 'HEAD');
    const { preview } = await planGitConversion(engine, 'default');
    expect(preview).toMatchObject({ declared: { by: { private: 1 } }, withhold: { count: 1, groups: 0, by: { file_committed: 0, file_absent: 1 }, sample: ['notes/private.md'] },
      holds: { count: 1, unplaced: { count: 0 } }, discard: { count: 0 }, index: { deletes: 0 } });
    const result = await applyGitConversion(engine, 'default', preview.preview_hash, PROCESSING);
    expect(result).toMatchObject({ status: 'converted', withheld: { pages: 1, commits: [] }, holds_cleared: 1, after: { remaining: 0 } });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(base);
    expect(await pageRow(engine, 'notes/private')).toEqual({ body: before.body, deleted: false, source_path: null, withheld: 'notes/private.md', reason: 'private' });
    expect(await holds(engine)).toEqual([]);
    const settled = await revisions(engine);
    expect((await performManagedSync(engine, OPTS)).status).toBe('up_to_date');
    expect(await revisions(engine)).toEqual(settled);
  }, { databaseUrl, setup }), 180_000);

  test('#7618: a refusal only the apply\'s recheck catches keeps the holds the plan would have cleared', () => managedBrain(async brain => {
    const { engine, root } = brain;
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await databaseOnlyEdit(engine, 'notes/ahead', 'Written to the database alone.');
    // notes/same: declared database-only, its row equal to its committed file, and held. The plan settles it as equal.
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
      "UPDATE pages SET database_only_reason='db_only' WHERE source_id='default' AND slug='notes/same'"), TEST_WRITE_ATTRIBUTION));
    const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
    await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation, path: 'notes/same.md', source_path: 'notes/same.md', slug: 'notes/same',
      page_id: null, code: 'concurrent_write', message: 'Held while another writer moved the page.', upstream_version: null, observed_at: new Date().toISOString(),
      run_id: 'run-1', mode: 'managed', meta: { recovery_version: 1 } }));
    const base = git(root, 'rev-parse', 'HEAD');
    const { preview } = await planGitConversion(engine, 'default');
    expect(preview).toMatchObject({ adopt: { count: 1 }, declared: { committed_equal: 1 }, holds: { count: 1, unplaced: { count: 0 } }, discard: { count: 0 } });
    // After the first group commits, a database edit lands on the held page: it no longer equals its file, and Git's import would overwrite it.
    installFaultHook(async point => { if (point === 'conversion:group_committed') await databaseOnlyEdit(engine, 'notes/same', 'A late database edit.'); });
    try {
      await expect(applyGitConversion(engine, 'default', preview.preview_hash, PROCESSING)).rejects.toMatchObject({ code: 'git_conversion_blocked', detail: 'git_overwrites_database' });
    } finally { installFaultHook(undefined); }
    expect(await holds(engine)).toEqual(['notes/same.md concurrent_write']);
    expect(await strict(engine)).toBe(false);
    expect(conversionCommits(root, base)).toHaveLength(1);
    expect((await page(engine, 'notes/same'))!.body).toContain('A late database edit.');
  }, { databaseUrl, setup }), 180_000);

  /**
   * Value: protects=a private page's uncommitted edit to its committed file is never removed by the withhold; fails_when=the
   * worktree==='modified' guard in planGitConversion's declared case is dropped (the withhold's disk check would match the
   * edited bytes and remove them); why_new=the withhold tests use clean or absent files only; seam=none; no_claim=none beyond protects
   */
  test('#7618: a private page whose committed file holds an uncommitted edit is an uncommitted_edit discard, and the edit stays', () => managedBrain(async brain => {
    const { engine, root } = brain;
    await committedPrivatePage(brain);
    await databaseOnlyEdit(engine, 'notes/private', 'A private note, edited in the database.');
    const edit = PRIVATE('notes/private', 'An uncommitted edit of the private note.');
    writeFileSync(join(root, 'notes/private.md'), edit);
    const before = await pageRow(engine, 'notes/private'), base = git(root, 'rev-parse', 'HEAD');
    const { preview } = await planGitConversion(engine, 'default');
    expect(preview).toMatchObject({ declared: { by: { private: 1 } }, withhold: { count: 0 },
      discard: { count: 1, by: { uncommitted_edit: 1 }, sample: ['notes/private.md'], detail: { uncommitted_edit: { modified: 1 } } } });
    await expect(applyGitConversion(engine, 'default', preview.preview_hash, PROCESSING)).rejects.toMatchObject({ code: 'git_conversion_blocked', detail: 'uncommitted_edit' });
    expect(readFileSync(join(root, 'notes/private.md'), 'utf8')).toBe(edit);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(base);
    expect(atHead(root, 'notes/private.md')).toBe('notes/private.md');
    expect(await pageRow(engine, 'notes/private')).toEqual(before);
    expect(await strict(engine)).toBe(false);
  }, { databaseUrl, setup }), 180_000);

  /**
   * Value: protects=the withhold never removes a file or stamps a row that moved after the preview; fails_when=the stamp's revision compare-and-set
   * or the disk-hash check in withholdGroups is removed; why_new=preview_changed is otherwise tested only for a stale hash
   * before any write; seam=none; no_claim=the writer_busy and git_target_unsafe branches of withholdGroups
   */
  test('#7618: the withhold refuses preview_changed when the private page or its file moved after the preview, and removes nothing', async () => {
    for (const moved of ['page', 'file'] as const) await managedBrain(async brain => {
      const { engine, root } = brain;
      await committedPrivatePage(brain);
      await databaseOnlyEdit(engine, 'notes/private', 'A private note, edited in the database.');
      await databaseOnlyEdit(engine, 'notes/ahead', 'Written to the database alone.');
      const { body: _body, ...before } = await pageRow(engine, 'notes/private');
      const base = git(root, 'rev-parse', 'HEAD');
      const { preview } = await planGitConversion(engine, 'default');
      expect(preview).toMatchObject({ adopt: { count: 1 }, withhold: { count: 1, by: { file_committed: 1 } }, discard: { count: 0 } });
      const late = PRIVATE('notes/private', 'A late edit on disk.');
      // The adoption group commits first; the private page or its file moves before the withhold reaches it.
      installFaultHook(async point => {
        if (point !== 'conversion:group_committed') return;
        if (moved === 'page') await databaseOnlyEdit(engine, 'notes/private', 'A late database edit.');
        else writeFileSync(join(root, 'notes/private.md'), late);
      });
      try {
        await expect(applyGitConversion(engine, 'default', preview.preview_hash, PROCESSING)).rejects.toMatchObject({ code: 'preview_changed' });
      } finally { installFaultHook(undefined); }
      expect(conversionCommits(root, base)).toEqual([{ subject: expect.any(String), paths: ['notes/ahead.md'] }]);
      expect(atHead(root, 'notes/private.md')).toBe('notes/private.md');
      if (moved === 'file') expect(readFileSync(join(root, 'notes/private.md'), 'utf8')).toBe(late);
      else expect(existsSync(join(root, 'notes/private.md'))).toBe(true);
      const { body, ...after } = await pageRow(engine, 'notes/private');
      expect(after).toEqual(before);
      expect(body).toContain(moved === 'page' ? 'A late database edit.' : 'A private note, edited in the database.');
      expect(await strict(engine)).toBe(false);
    }, { databaseUrl, setup });
  }, 360_000);

  test('#7617: a database-only page whose untracked file equals its export adopts as worktree_only; a refused apply leaves the file uncommitted', () => managedBrain(async brain => {
    const { engine, root } = brain;
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await databaseOnlyPage(brain, 'notes/untracked', note('notes/untracked', 'Only in the database, and untracked on disk.'));
    const [key] = await engine.executeRaw<{ id: string }>("SELECT id::text FROM pages WHERE source_id='default' AND slug='notes/untracked'");
    const bytes = inlineExportMarkdown(await readExportPage(engine, { id: key!.id, source_id: 'default', slug: 'notes/untracked' }, await readExportWithdrawals(engine, 'default')));
    writeFileSync(join(root, 'notes/untracked.md'), bytes);
    const base = git(root, 'rev-parse', 'HEAD'), before = await revisions(engine);
    const { preview } = await planGitConversion(engine, 'default');
    expect(preview).toMatchObject({ adopt: { count: 1, by: { worktree_only: 1, database_ahead: 0, undeclared_database_only: 0 }, sample: ['notes/untracked.md'] }, discard: { count: 0 } });
    await expect(applyGitConversion(engine, 'default', 'stale', PROCESSING)).rejects.toMatchObject({ code: 'preview_changed' });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(base);
    expect(git(root, 'status', '--porcelain')).toBe('?? notes/untracked.md');
    expect(readFileSync(join(root, 'notes/untracked.md'), 'utf8')).toBe(bytes);
    expect(await revisions(engine)).toEqual(before);
    expect(await strict(engine)).toBe(false);
    expect(await applyGitConversion(engine, 'default', preview.preview_hash, PROCESSING)).toMatchObject({ status: 'converted', committed: { groups: 1, pages: 1 } });
    expect(conversionCommits(root, base)).toEqual([{ subject: expect.any(String), paths: ['notes/untracked.md'] }]);
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(root, 'notes/untracked.md'), 'utf8')).toBe(bytes);
    expect((await revisions(engine))['notes/untracked']).toBe(before['notes/untracked']);
  }, { databaseUrl, setup }), 180_000);

  test('#7618: a private page whose committed file was deleted from the working tree only withholds it: the removal is committed', () => managedBrain(async brain => {
    const { engine, root } = brain;
    await committedPrivatePage(brain);
    await databaseOnlyEdit(engine, 'notes/private', 'A private note, edited in the database.');
    rmSync(join(root, 'notes/private.md'));
    const before = await pageRow(engine, 'notes/private'), base = git(root, 'rev-parse', 'HEAD');
    const { preview } = await planGitConversion(engine, 'default');
    expect(preview).toMatchObject({ withhold: { count: 1, by: { file_committed: 1, file_absent: 0 } }, discard: { count: 0 } });
    expect(await applyGitConversion(engine, 'default', preview.preview_hash, PROCESSING)).toMatchObject({ status: 'converted', withheld: { pages: 1 }, after: { remaining: 0 } });
    expect(conversionCommits(root, base)).toEqual([{ subject: expect.any(String), paths: ['notes/private.md'] }]);
    expect(atHead(root, 'notes/private.md')).toBe('');
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(await pageRow(engine, 'notes/private')).toEqual({ body: before.body, deleted: false, source_path: null, withheld: 'notes/private.md', reason: 'private' });
  }, { databaseUrl, setup }), 180_000);

  test('#7618: a file_absent withhold refuses preview_changed when the private page moved after the preview, and stamps nothing', () => managedBrain(async brain => {
    const { engine, root } = brain;
    await privateRemovedByHand(brain);
    await databaseOnlyEdit(engine, 'notes/ahead', 'Written to the database alone.');
    const { body: _body, ...before } = await pageRow(engine, 'notes/private');
    expect(before).toMatchObject({ source_path: 'notes/private.md', withheld: null });
    const base = git(root, 'rev-parse', 'HEAD');
    const { preview } = await planGitConversion(engine, 'default');
    expect(preview).toMatchObject({ adopt: { count: 1 }, withhold: { count: 1, by: { file_absent: 1 } }, discard: { count: 0 } });
    // The adoption group commits first; the private page moves before the withhold reaches it.
    installFaultHook(async point => { if (point === 'conversion:group_committed') await databaseOnlyEdit(engine, 'notes/private', 'A late database edit.'); });
    try {
      await expect(applyGitConversion(engine, 'default', preview.preview_hash, PROCESSING)).rejects.toMatchObject({ code: 'preview_changed' });
    } finally { installFaultHook(undefined); }
    expect(conversionCommits(root, base)).toEqual([{ subject: expect.any(String), paths: ['notes/ahead.md'] }]);
    const { body, ...after } = await pageRow(engine, 'notes/private');
    expect(after).toEqual(before);
    expect(body).toContain('A late database edit.');
    expect(await holds(engine)).toEqual(['notes/private.md file_drift']);
    expect(await strict(engine)).toBe(false);
  }, { databaseUrl, setup }), 180_000);

  test('#7618: a hold no category places, whose strict verdict loses nothing, is cleared by a converting apply', () => managedBrain(async brain => {
    const { engine, root } = brain;
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    writeFileSync(join(root, 'notes/fresh.md'), note('notes/fresh', 'The committed body of notes/fresh.'));
    git(root, 'add', 'notes/fresh.md'); git(root, 'commit', '-qm', 'a fresh note');
    const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
    await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation, path: 'notes/fresh.md', source_path: 'notes/fresh.md', slug: 'notes/fresh',
      page_id: null, code: 'concurrent_write', message: 'Held while another writer moved the page.', upstream_version: null, observed_at: new Date().toISOString(),
      run_id: 'run-1', mode: 'managed', meta: { recovery_version: 1 } }));
    const { preview } = await planGitConversion(engine, 'default');
    expect(preview).toMatchObject({ holds: { count: 1, unplaced: { count: 1, by: { concurrent_write: 1 } } }, discard: { count: 0 }, index: { imports: 1, deletes: 0 } });
    expect(await applyGitConversion(engine, 'default', preview.preview_hash, PROCESSING)).toMatchObject({ status: 'converted', holds_cleared: 1, after: { remaining: 0 } });
    expect(await holds(engine)).toEqual([]);
    expect(await strict(engine)).toBe(true);
    expect((await page(engine, 'notes/fresh'))!.body).toContain('The committed body of notes/fresh.');
  }, { databaseUrl, setup }), 180_000);

  /**
   * Value: protects=a private page whose removal commit landed is never deleted by the mixed sync that runs before the rerun;
   * fails_when=withholdGroups stamps the row after the door commit instead of before it (a crash in between leaves a live
   * row recording a file a commit removed, which a mixed sync deletes); why_new=the crash tests cover adoption groups only;
   * seam=the conversion:withhold_committed fault point; no_claim=a crash inside commitThroughDoor itself
   */
  test('#7618: a crash after a withhold commit leaves the private page live through a mixed sync, and the rerun completes', () => managedBrain(async brain => {
    const { engine, root } = brain;
    await committedPrivatePage(brain);
    // A commit sync has not read: the row still matches its import, so a mixed sync would delete a live row whose file a commit removed.
    writeFileSync(join(root, 'notes/private.md'), PRIVATE('notes/private', 'A committed edit of the private note.'));
    git(root, 'commit', '-qam', 'edit the private note');
    const before = await pageRow(engine, 'notes/private'), base = git(root, 'rev-parse', 'HEAD');
    const { preview } = await planGitConversion(engine, 'default');
    expect(preview).toMatchObject({ withhold: { count: 1, by: { file_committed: 1 } }, discard: { count: 0 } });
    installFaultHook(point => { if (point === 'conversion:withhold_committed') throw new Error('crash after the withhold commit'); });
    try { await expect(applyGitConversion(engine, 'default', preview.preview_hash, PROCESSING)).rejects.toThrow('crash after the withhold commit'); }
    finally { installFaultHook(undefined); }
    expect(conversionCommits(root, base)).toEqual([{ subject: expect.any(String), paths: ['notes/private.md'] }]);
    expect(await strict(engine)).toBe(false);
    await performManagedSync(engine, OPTS);
    expect(await pageRow(engine, 'notes/private')).toEqual({ body: before.body, deleted: false, source_path: null, withheld: 'notes/private.md', reason: 'private' });
    const rerun = (await planGitConversion(engine, 'default')).preview;
    expect(rerun).toMatchObject({ withhold: { count: 0 }, discard: { count: 0 } });
    expect(await applyGitConversion(engine, 'default', rerun.preview_hash, PROCESSING)).toMatchObject({ status: 'converted', after: { remaining: 0 } });
    expect(await strict(engine)).toBe(true);
    expect(await pageRow(engine, 'notes/private')).toMatchObject({ body: before.body, deleted: false, withheld: 'notes/private.md' });
  }, { databaseUrl, setup }), 180_000);

  /**
   * Value: protects=a crash after the withhold stamp and before its removal commit loses nothing: a mixed sync keeps the
   * page live and unchanged, and the rerun finds the file at the path the stamp withheld and removes it; fails_when=the
   * census resolves a withheld page's file from its slug alone (a file at another path is then left in HEAD unplanned);
   * why_new=the crash test crashes after the commit, at a slug path; seam=the conversion:withhold_stamped fault point;
   * no_claim=a crash inside commitThroughDoor itself
   */
  test('#7618: a crash between the withhold stamp and its commit keeps the page through a mixed sync, and the rerun withholds the file at its recorded path', () => managedBrain(async brain => {
    const { engine, root } = brain;
    writeFileSync(join(root, 'notes/Private Note.md'), PRIVATE('notes/private-note', 'A private note.'));
    git(root, 'add', 'notes/Private Note.md'); git(root, 'commit', '-qm', 'a private note');
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const [{ slug }] = await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id='default' AND source_path='notes/Private Note.md'");
    await databaseOnlyEdit(engine, slug, 'A private note, edited in the database.');
    const before = await pageRow(engine, slug), base = git(root, 'rev-parse', 'HEAD');
    const { preview } = await planGitConversion(engine, 'default');
    expect(preview).toMatchObject({ withhold: { count: 1, by: { file_committed: 1 }, sample: ['notes/Private Note.md'] }, discard: { count: 0 } });
    installFaultHook(point => { if (point === 'conversion:withhold_stamped') throw new Error('crash before the withhold commit'); });
    try { await expect(applyGitConversion(engine, 'default', preview.preview_hash, PROCESSING)).rejects.toThrow('crash before the withhold commit'); }
    finally { installFaultHook(undefined); }
    expect(git(root, 'rev-parse', 'HEAD')).toBe(base);
    expect(atHead(root, 'notes/Private Note.md')).toBe('notes/Private Note.md');
    const stamped = { body: before.body, deleted: false, source_path: null, withheld: 'notes/Private Note.md', reason: 'private' };
    expect(await pageRow(engine, slug)).toEqual(stamped);
    await performManagedSync(engine, OPTS);
    expect(await pageRow(engine, slug)).toEqual(stamped);
    const rerun = (await planGitConversion(engine, 'default')).preview;
    expect(rerun).toMatchObject({ withhold: { count: 1, by: { file_committed: 1 }, sample: ['notes/Private Note.md'] }, discard: { count: 0 } });
    expect(await applyGitConversion(engine, 'default', rerun.preview_hash, PROCESSING)).toMatchObject({ status: 'converted', withheld: { pages: 1 }, after: { remaining: 0 } });
    expect(conversionCommits(root, base)).toEqual([{ subject: expect.any(String), paths: ['notes/Private Note.md'] }]);
    expect(atHead(root, 'notes/Private Note.md')).toBe('');
    expect(await pageRow(engine, slug)).toEqual(stamped);
    expect(await strict(engine)).toBe(true);
  }, { databaseUrl, setup }), 180_000);

  test('#7618: a withheld file whose directory resolves outside the checkout refuses before anything is stamped', () => managedBrain(async brain => {
    const { engine, root } = brain;
    mkdirSync(join(root, 'private'));
    writeFileSync(join(root, 'private/note.md'), PRIVATE('private/note', 'A private note.'));
    git(root, 'add', 'private/note.md'); git(root, 'commit', '-qm', 'a private note');
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await databaseOnlyEdit(engine, 'private/note', 'A private note, edited in the database.');
    // The directory is moved out of the checkout and replaced by a symlink to it: the file's bytes still read the same.
    const outside = join(dirname(root), 'outside-private');
    execFileSync('mv', [join(root, 'private'), outside]);
    symlinkSync(outside, join(root, 'private'));
    const before = await pageRow(engine, 'private/note'), base = git(root, 'rev-parse', 'HEAD');
    const { preview } = await planGitConversion(engine, 'default');
    expect(preview).toMatchObject({ withhold: { count: 1, by: { file_committed: 1 } }, discard: { count: 0 } });
    await expect(applyGitConversion(engine, 'default', preview.preview_hash, PROCESSING)).rejects.toMatchObject({ code: 'git_target_unsafe' });
    expect(await pageRow(engine, 'private/note')).toEqual(before);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(base);
    expect(existsSync(join(outside, 'note.md'))).toBe(true);
    expect(await strict(engine)).toBe(false);
  }, { databaseUrl, setup }), 180_000);

  /**
   * Value: protects=an editor save that lands between the withhold stamp and the removal is kept; fails_when=withholdGroups
   * removes the file without rechecking its bytes after the stamp; why_new=the other withhold_stamped hook crashes and never
   * changes the file; seam=the conversion:withhold_stamped fault point; no_claim=a save after the removal itself
   */
  test('#7618: a file edited between the withhold stamp and its removal refuses preview_changed and keeps the edit', () => managedBrain(async brain => {
    const { engine, root } = brain;
    await committedPrivatePage(brain);
    await databaseOnlyEdit(engine, 'notes/private', 'A private note, edited in the database.');
    const before = await pageRow(engine, 'notes/private'), base = git(root, 'rev-parse', 'HEAD');
    const { preview } = await planGitConversion(engine, 'default');
    expect(preview).toMatchObject({ withhold: { count: 1, by: { file_committed: 1 } }, discard: { count: 0 } });
    const saved = PRIVATE('notes/private', 'Saved by an editor after the stamp.');
    installFaultHook(point => { if (point === 'conversion:withhold_stamped') writeFileSync(join(root, 'notes/private.md'), saved); });
    try { await expect(applyGitConversion(engine, 'default', preview.preview_hash, PROCESSING)).rejects.toMatchObject({ code: 'preview_changed' }); }
    finally { installFaultHook(undefined); }
    expect(readFileSync(join(root, 'notes/private.md'), 'utf8')).toBe(saved);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(base);
    expect(atHead(root, 'notes/private.md')).toBe('notes/private.md');
    expect(await pageRow(engine, 'notes/private')).toEqual({ body: before.body, deleted: false, source_path: null, withheld: 'notes/private.md', reason: 'private' });
    expect(await strict(engine)).toBe(false);
  }, { databaseUrl, setup }), 180_000);

  /**
   * Value: protects=the text preview and receipt name the withheld page and a push that did not land, with the command that
   * pushes it; fails_when=describeGitPreview or describeResult drops the Withhold line, the withheld count or the push-pending
   * line; why_new=only JSON fields and the By-cause line were asserted; seam=none; no_claim=wording beyond the asserted fragments
   */
  test('#7618/#7644: the text preview and receipt name the withheld page and a pending push', () => managedBrain(async brain => {
    const { engine } = brain;
    await engine.executeRaw("UPDATE persistence_host_bindings SET git_durability='enabled'");
    await committedPrivatePage(brain);
    await databaseOnlyEdit(engine, 'notes/private', 'A private note, edited in the database.');
    const text = async (args: string[]) => {
      const lines: string[] = [];
      const log = console.log, write = process.stderr.write, priorExitCode = process.exitCode;
      console.log = (line: unknown) => { lines.push(String(line)); };
      process.stderr.write = (() => true) as typeof process.stderr.write;
      try { await runSourcesCanonical(engine, args); } finally { console.log = log; process.stderr.write = write; _resetCliExitVerdictForTests(); process.exitCode = priorExitCode ?? 0; }
      return lines.join('\n');
    };
    const dry = await text(['default', '--to', 'git', '--dry-run']);
    expect(dry).toContain("Withhold (a private page's committed file is removed through the door, 1 commit(s), and its row withholds its origin): 1 (file_committed 1).\n    notes/private.md");
    const { preview } = await planGitConversion(engine, 'default');
    const applied = await text(['default', '--to', 'git', '--apply', '--expect', preview.preview_hash, '--no-embed', '--no-extract']);
    expect(applied).toContain('Source default is git-canonical: 0 page(s) committed in 0 door commit(s), 1 private page(s) withheld (1 removal commit(s))');
    expect(applied).toContain("Push pending (git_push_unavailable): The conversion's door commits are committed locally");
    expect(applied).toContain(`gbrain git commit-push --push-only --path ${brain.root}`);
  }, { databaseUrl, setup: closedRemoteSetup }), 180_000);

  test('work that lands after the strict-equivalent pass leaves the source strict and reports incomplete', () => managedBrain(async brain => {
    const { engine, root } = brain;
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await databaseOnlyEdit(engine, 'notes/ahead', 'Written to the database alone.');
    const base = git(root, 'rev-parse', 'HEAD');
    const preview = await cli(engine, ['default', '--to', 'git']);
    installFaultHook(async point => { if (point === 'conversion:before_flip') await parkIgnoredEffect(engine, 'notes/same', 'git_target_unsafe'); });
    let result: Record<string, any>;
    try { result = await cli(engine, ['default', '--to', 'git', '--apply', '--expect', preview.preview_hash, '--no-embed', '--no-extract']); }
    finally { installFaultHook(undefined); }
    expect(result).toMatchObject({ status: 'incomplete', code: 'git_conversion_incomplete', result: { status: 'incomplete', committed: { pages: 1 }, closing_passes: 0,
      after: { strict: true, remaining: 1, parked_effects: { retry: 1 } } } });
    expect(await strict(engine)).toBe(true);
    expect(conversionCommits(root, base)).toHaveLength(1);
  }, { databaseUrl, setup }), 180_000);

  test('--to mixed removes the flag and nothing else, and converting back commits nothing', () => managedBrain(async brain => {
    const { engine, root } = brain;
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await databaseOnlyEdit(engine, 'notes/ahead', 'Written to the database alone.');
    await applyGitConversion(engine, 'default', (await planGitConversion(engine, 'default')).preview.preview_hash, PROCESSING);
    const head = git(root, 'rev-parse', 'HEAD'), settled = await revisions(engine);
    const mixed = await planMixedConversion(engine, 'default');
    expect(mixed).toMatchObject({ to: 'mixed', strict: true });
    await expect(applyMixedConversion(engine, 'default', 'stale')).rejects.toMatchObject({ code: 'preview_changed' });
    expect(await applyMixedConversion(engine, 'default', mixed.preview_hash)).toEqual({ status: 'mixed', source_id: 'default' });
    expect(await strict(engine)).toBe(false);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(await revisions(engine)).toEqual(settled);
    const back = (await planGitConversion(engine, 'default')).preview;
    expect(back).toMatchObject({ strict: false, adopt: { count: 0 }, git_wins: { count: 0 }, discard: { count: 0 } });
    expect(await applyGitConversion(engine, 'default', back.preview_hash, PROCESSING)).toMatchObject({ status: 'converted', committed: { pages: 0, groups: 0 } });
    expect(await strict(engine)).toBe(true);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
  }, { databaseUrl, setup }), 180_000);

  test('a remote caller cannot convert or run the strict-equivalent pass, and no MCP operation exposes it', () => managedBrain(async ({ engine }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    expect(operations.filter(op => /canonical|conversion/.test(op.name)).map(op => op.name)).toEqual([]);
    const remote = <T>(fn: () => Promise<T>) => withSubmissionAuthority({ version: 1, kind: 'remote_generic' } as never, fn);
    expect(await remote(() => cli(engine, ['default', '--to', 'git']))).toMatchObject({ status: 'refused', code: 'permission_denied', reason: 'trusted_cli_required' });
    await expect(remote(() => resolveManagedSyncContext(engine, { ...OPTS, full: true, canonicalOverride: 'git' }))).rejects.toMatchObject({ code: 'permission_denied' });
    expect(await strict(engine)).toBe(false);
  }, { databaseUrl, setup }), 180_000);

  test('an unmanaged brain refuses strict_requires_managed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-g8a-unmanaged-'));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
        try {
          expect(await cli(engine, ['default', '--to', 'git'])).toMatchObject({ status: 'refused', code: 'strict_requires_managed' });
          expect(await strict(engine)).toBe(false);
        } finally { await close(); }
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 120_000);
});
