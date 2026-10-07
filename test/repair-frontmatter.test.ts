/**
 * #5988 Lane 3: `gbrain repair frontmatter`. One previewed, hash-bound repair
 * per file: safe quoting by default, interpretations only with
 * --include-ambiguous, --only/--skip bound into the hash, needs_review never
 * written, and managed publication through `managed_file_repair` (exact
 * bytes, import, hold clear and Git effect in one coordinated write).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError, type OperationContext } from '../src/core/ops/contract.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { readGitSourceHolds, writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { confinedRepairTarget, submitManagedFileRepair } from '../src/core/persistence/file-repair.ts';
import { resolveRepairScope, type RepairResult } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import type { FrontmatterPreviewDetails } from '../src/core/repair/frontmatter.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const backends = testBackends();
const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-frontmatter-'));
const engines: BrainEngine[] = [];
/** A brain whose persistence was never activated: legacy (unmanaged) writes. */
let legacyEngine: PGLiteEngine;
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message = 'content') => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); return git(root, 'rev-parse', 'HEAD'); };
const note = (title: string, body = 'A synthetic observation.') => `---\ntitle: ${title}\n---\n${body}\n`;
/** Imports today only after quoting: the safe class. */
const QUOTABLE = '---\ntitle: Payments roundup\nauthor: alice-example (citing acme-example) (original: https://example.invalid/a)\n---\nA synthetic roundup.\n';
/** Unquoted continuation lines: held as needs_interpretation, folded only under --include-ambiguous. */
const folded = (n: number) => `---\ntitle: alice-example post ${n}\nsecond line of post ${n}\n---\nA synthetic post.\n`;
/** Mis-indented mapping entry: no rule, so needs_review. */
const UNFIXABLE = '---\ntitle: Broken\n  author: nobody\n tags: [a\n---\nBody.\n';
const LONG = Array.from({ length: 40 }, (_, i) => `Line ${i} of a long synthetic observation that keeps Git rename detection certain.`).join('\n');
const long = (title: string) => `---\ntitle: ${title}\n---\n${LONG}\n`;
const longBroken = `---\ntitle: alice-example first line\nalice-example second line\n---\n${LONG}\n`;

beforeAll(async () => {
  if (backends.includes('pglite')) { const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
  legacyEngine = new PGLiteEngine(); await legacyEngine.connect({}); await legacyEngine.initSchema();
}, 120_000);

afterAll(async () => {
  await withEnv(env, async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } });
  await legacyEngine.disconnect();
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});

const quiet = { info() {}, warn() {}, error() {} };

async function managed(engine: BrainEngine, files: Record<string, string>) {
  const id = `fm-${randomUUID().replace(/-/g, '').slice(0, 20)}`, root = join(home, id);
  mkdirSync(root, { recursive: true }); git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
  // Git target effects commit only in a durability-hardened checkout.
  writeFileSync(join(root, '.git', 'hooks', 'post-commit'), '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\n'); chmodSync(join(root, '.git', 'hooks', 'post-commit'), 0o755);
  const write = (path: string, content: string) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); };
  for (const [path, content] of Object.entries(files)) write(path, content);
  commit(root, 'fixture');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return fixture(engine, id, root, write);
}

function fixture(engine: BrainEngine, id: string, root: string, write: (path: string, content: string) => void) {
  const sync = () => performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true });
  const holds = async () => (await readGitSourceHolds(engine, { sourceIds: [id] }))[0]?.holds ?? [];
  const run = async (opts: { apply?: boolean; expect?: string; includeAmbiguous?: boolean; only?: string[]; skip?: string[] } = {}) => {
    const runner = await repairRunner(engine, { apply: opts.apply === true, noEmbed: true, logger: quiet });
    return runner.run('frontmatter', await resolveRepairScope(engine, id), { explicit: true, sourceFlag: id, expect: opts.expect,
      includeAmbiguous: opts.includeAmbiguous, only: opts.only, skip: opts.skip });
  };
  const read = (path: string) => readFileSync(join(root, path), 'utf8');
  return { id, root, sync, holds, run, read, write };
}

/** Runs queued effects here and waits for the consumer's, until no Git effect of the source is open. */
async function gitEffectsSettled(engine: BrainEngine, sourceId: string) {
  for (let i = 0; i < 100; i++) {
    await runPersistenceEffects(engine, { engine: engine.kind }, { hostId: localHostId(), limit: 10 });
    const open = await engine.executeRaw("SELECT 1 FROM persistence_effects WHERE source_id=$1 AND kind='git' AND state<>'committed'", [sourceId]);
    if (!open.length) return engine.executeRaw<{ outcome: Record<string, unknown> }>("SELECT outcome FROM persistence_effects WHERE source_id=$1 AND kind='git' ORDER BY id", [sourceId]);
    await Bun.sleep(100);
  }
  throw new Error('git effects did not settle');
}

const details = (result: RepairResult) => result.details as unknown as FrontmatterPreviewDetails;

async function each(run: (engine: BrainEngine) => Promise<void>) {
  await withEnv(env, async () => {
    for (const engine of engines) {
      try { await run(engine); } finally { await disposePersistenceConsumer(engine); }
    }
  });
}

async function refusal(run: () => Promise<unknown>): Promise<OperationError> {
  try { await run(); } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a refusal');
}

test('safe preview quotes only, hashes its set, and the apply writes exactly the previewed bytes', () => each(async engine => {
  const s = await managed(engine, { 'notes/roundup.md': QUOTABLE, 'notes/ok.md': note('Ok') });
  await s.sync();
  const before = await engine.getPage('notes/roundup', { sourceId: s.id });
  expect(before?.frontmatter.author).toBe('alice-example (citing acme-example) (original: https://example.invalid/a)');
  const preview = await s.run();
  expect(preview).toMatchObject({ mode: 'dry_run', affected: 1 });
  expect(details(preview).counts).toMatchObject({ safe: 1, interpretive: 0, needs_review: 0 });
  expect(details(preview).samples.safe!.diff).toContain('+author: "alice-example (citing acme-example) (original: https://example.invalid/a)"');
  const hash = preview.apply_command.split('--expect ')[1]!.split(' ')[0]!;
  expect(preview.apply_command).toBe(`gbrain repair frontmatter --source ${s.id} --apply --expect ${hash} --yes`);
  expect((await s.run()).apply_command).toBe(preview.apply_command);
  expect(s.read('notes/roundup.md')).toBe(QUOTABLE);
  expect((await refusal(() => s.run({ apply: true, expect: 'f'.repeat(64) }))).code).toBe('preview_changed');
  const applied = await s.run({ apply: true, expect: hash });
  expect(applied).toMatchObject({ applied: 1, outcomes: { repaired: 1 } });
  const expected = QUOTABLE.replace('author: alice-example (citing acme-example) (original: https://example.invalid/a)',
    'author: "alice-example (citing acme-example) (original: https://example.invalid/a)"');
  expect(s.read('notes/roundup.md')).toBe(expected);
  expect(applied.outcome_items![0]!.detail).toMatchObject({ path: 'notes/roundup.md', written: true, committed: 'queued' });
  const page = await engine.getPage('notes/roundup', { sourceId: s.id });
  expect(page?.id).toBe(before!.id);
  expect(page?.frontmatter.author).toBe(before!.frontmatter.author);
  // The Git target effect commits the repaired file like any coordinated page write.
  await gitEffectsSettled(engine, s.id);
  expect(git(s.root, 'status', '--porcelain', '--', 'notes/roundup.md')).toBe('');
  expect(git(s.root, 'show', 'HEAD:notes/roundup.md')).toBe(expected.trimEnd());
}), 180_000);

test('interpretations wait for --include-ambiguous (two-pass next_action), which changes the hash; --only approves one file and leaves the other held', () => each(async engine => {
  const s = await managed(engine, { 'notes/a.md': folded(1), 'notes/b.md': folded(2), 'notes/roundup.md': QUOTABLE });
  expect((await s.sync()).held_count).toBe(2);
  const safe = await s.run();
  expect(details(safe).counts).toMatchObject({ safe: 1, interpretive: 0, interpretive_pending: 2 });
  const safeHash = safe.apply_command.split('--expect ')[1]!.split(' ')[0]!;
  expect(details(safe).next_actions.map(action => action.argv)).toEqual([
    ['gbrain', 'repair', 'frontmatter', '--source', s.id, '--apply', '--expect', safeHash, '--yes'],
    ['gbrain', 'repair', 'frontmatter', '--source', s.id, '--include-ambiguous'],
  ]);
  expect(details(safe).next_actions[0]).toMatchObject({ consent: ['destructive'], plan_hash: safeHash });
  const wide = await s.run({ includeAmbiguous: true });
  expect(details(wide).counts).toMatchObject({ safe: 1, interpretive: 2, interpretive_pending: 0 });
  expect(wide.apply_command).not.toContain(safeHash);
  expect(details(wide).diffs.find(diff => diff.path === 'notes/a.md')!.diff).toContain('+title: "alice-example post 1\\nsecond line of post 1"');
  // The safe apply never writes an interpretive change.
  expect(await s.run({ apply: true, expect: safeHash })).toMatchObject({ applied: 1 });
  expect(s.read('notes/a.md')).toBe(folded(1));
  const one = await s.run({ includeAmbiguous: true, only: ['notes/a.md'] });
  expect(details(one).counts).toMatchObject({ interpretive: 1 });
  const oneHash = one.apply_command.split('--expect ')[1]!.split(' ')[0]!;
  expect(one.apply_command).toBe(`gbrain repair frontmatter --source ${s.id} --only notes/a.md --include-ambiguous --apply --expect ${oneHash} --yes`);
  expect((await refusal(() => s.run({ apply: true, expect: oneHash, includeAmbiguous: true }))).code).toBe('preview_changed');
  const applied = await s.run({ apply: true, expect: oneHash, includeAmbiguous: true, only: ['notes/a.md'] });
  expect(applied.outcome_items?.[0]?.detail).toMatchObject({ path: 'notes/a.md', imported: 'created', hold_cleared: true });
  expect((await engine.getPage('notes/a', { sourceId: s.id }))?.title).toBe('alice-example post 1\nsecond line of post 1');
  expect(s.read('notes/b.md')).toBe(folded(2));
  expect((await s.holds()).map(hold => hold.path)).toEqual(['notes/b.md']);
  expect(await engine.getPage('notes/b', { sourceId: s.id })).toBeNull();
}), 180_000);

test('a file edited after the preview is changed_since_preview and keeps its new bytes; needs_review files are listed with the manual fix and never written', () => each(async engine => {
  const s = await managed(engine, { 'notes/roundup.md': QUOTABLE, 'notes/broken.md': UNFIXABLE });
  await s.sync();
  const preview = await s.run({ includeAmbiguous: true });
  expect(details(preview).needs_review).toEqual([expect.objectContaining({ path: 'notes/broken.md', code: 'invalid_frontmatter' })]);
  expect(details(preview).needs_review[0]!.resolution).toContain('notes/broken.md');
  expect(preview.affected).toBe(1);
  const edited = QUOTABLE.replace('A synthetic roundup.', 'An edited roundup.');
  s.write('notes/roundup.md', edited);
  const hash = preview.apply_command.split('--expect ')[1]!.split(' ')[0]!;
  const applied = await s.run({ apply: true, expect: hash, includeAmbiguous: true });
  expect(applied).toMatchObject({ applied: 0, outcomes: { changed_since_preview: 1 } });
  expect(s.read('notes/roundup.md')).toBe(edited);
  expect(s.read('notes/broken.md')).toBe(UNFIXABLE);
}), 180_000);

const localCtx = (engine: BrainEngine, sourceId: string, remote = false) =>
  ({ engine, config: { engine: engine.kind }, logger: quiet, dryRun: false, remote, sourceId }) as unknown as OperationContext;

test('a held modified file: put_page stays refused for drift, the repair writes the exact bytes under its hash and updates the page', () => each(async engine => {
  const s = await managed(engine, { 'notes/post.md': note('Original') });
  await s.sync();
  const page = (await engine.getPage('notes/post', { sourceId: s.id }))!;
  s.write('notes/post.md', folded(7)); commit(s.root, 'broken edit');
  expect((await s.sync()).held?.[0]).toMatchObject({ path: 'notes/post.md', stale: true });
  const revision = (await engine.readPageSnapshot('notes/post', { sourceId: s.id }))!.revision;
  const drift = await refusal(() => submitPageMutation(localCtx(engine, s.id), { operation: 'put_page',
    params: { slug: 'notes/post', content: note('Agent write'), source_id: s.id, expected_revision: revision } }));
  expect(drift.detail).toBe('file_database_drift');
  const preview = await s.run({ includeAmbiguous: true });
  const hash = preview.apply_command.split('--expect ')[1]!.split(' ')[0]!;
  const proposed = details(preview).diffs[0]!;
  expect(proposed).toMatchObject({ path: 'notes/post.md', class: 'interpretive', selected: true });
  const applied = await s.run({ apply: true, expect: hash, includeAmbiguous: true });
  expect(applied.outcome_items?.[0]?.detail).toMatchObject({ imported: 'updated', hold_cleared: true, written: true });
  expect(s.read('notes/post.md')).toBe('---\ntitle: "alice-example post 7\\nsecond line of post 7"\n---\nA synthetic post.\n');
  const after = (await engine.getPage('notes/post', { sourceId: s.id }))!;
  expect(after.id).toBe(page.id);
  expect(after.title).toBe('alice-example post 7\nsecond line of post 7');
  expect(await s.holds()).toEqual([]);
  // A later sync of the committed repair imports nothing new and holds nothing.
  await gitEffectsSettled(engine, s.id);
  expect((await s.sync()).held_count ?? 0).toBe(0);
}), 180_000);

test('#6188: a held fence file is never rewritten by frontmatter repair; its resolution defers to that file\'s gbrain repair fences preview', () => each(async engine => {
  const takes = '<!--- gbrain:takes:begin -->\n| # | claim | kind | who | weight | since | source |\n|---|---|---|---|---|---|---|\n'
    + '| 1 | Sentinelclaimq93 renews | take | Sentinelholderq93 Example | 0.7 | 2026-01 | chat |\n<!--- gbrain:takes:end -->';
  const s = await managed(engine, { 'notes/a.md': note('A'), 'people/fenced.md': note('Fenced', `A synthetic page.\n\n${takes}`) });
  await s.sync();
  expect((await s.holds()).map(hold => [hold.path, hold.code])).toEqual([['people/fenced.md', 'invalid_fence']]);
  const before = s.read('people/fenced.md');
  const review = details(await s.run()).needs_review.find(entry => entry.path === 'people/fenced.md');
  expect(review).toMatchObject({ code: 'invalid_fence' });
  expect(review!.resolution).toContain(`gbrain repair fences --source ${s.id} --only people/fenced.md`);
  expect(review!.resolution).toContain('frontmatter repair does not change fences');
  for (const secret of ['Sentinelclaimq93', 'Sentinelholderq93']) expect(JSON.stringify(review)).not.toContain(secret);
  expect(s.read('people/fenced.md')).toBe(before);
}), 180_000);

test('a repaired file whose import would keep a database-only tag is needs_review (canonical overlay), never written', () => each(async engine => {
  const s = await managed(engine, { 'notes/post.md': note('Original') });
  await s.sync();
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.addTag('notes/post', 'kept-in-db', { sourceId: s.id });
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  s.write('notes/post.md', folded(3)); commit(s.root, 'broken edit');
  await s.sync();
  const preview = await s.run({ includeAmbiguous: true });
  expect(preview.affected).toBe(0);
  expect(details(preview).needs_review).toEqual([expect.objectContaining({ path: 'notes/post.md', code: 'canonical_overlay' })]);
  expect(s.read('notes/post.md')).toBe(folded(3));
}), 180_000);

test('apply refuses while an unfinished managed sync cursor still names a selected file, and names the sync to finish', () => each(async engine => {
  const s = await managed(engine, { 'notes/roundup.md': QUOTABLE });
  await s.sync();
  const preview = await s.run();
  const hash = preview.apply_command.split('--expect ')[1]!.split(' ')[0]!;
  const runId = randomUUID();
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync',$1,$2::text::jsonb)`,
    [`fixture-${runId}`, JSON.stringify([{ sourceId: s.id, runId, index: 0, total: 1 }])]);
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync-manifest',$1,$2::text::jsonb)`,
    [runId, JSON.stringify([{ path: 'notes/roundup.md', sourcePath: 'notes/roundup.md', action: 'import', working: false }])]);
  try {
    const error = await refusal(() => s.run({ apply: true, expect: hash }));
    expect(error.code).toBe('sync_in_progress');
    expect(error.suggestion).toContain(`gbrain sync --source ${s.id} --no-pull`);
    expect(s.read('notes/roundup.md')).toBe(QUOTABLE);
  } finally {
    await engine.executeRaw("DELETE FROM op_checkpoints WHERE (op='managed-sync' AND fingerprint=$1) OR (op='managed-sync-manifest' AND fingerprint=$2)", [`fixture-${runId}`, runId]);
  }
}), 180_000);

test('managed_file_repair is trusted-local only: MCP put_page cannot name it and a remote caller is refused before admission', () => each(async engine => {
  const s = await managed(engine, { 'notes/roundup.md': QUOTABLE });
  await s.sync();
  const params = { slug: 'notes/roundup', source_id: s.id, kind: 'managed_file_repair', content: note('Injected'), path: 'notes/roundup.md', sourcePath: 'notes/roundup.md' };
  const viaMcp = await refusal(() => submitPageMutation(localCtx(engine, s.id, true), { operation: 'put_page', params }));
  expect(viaMcp.code).toBe('invalid_params');
  const viaLocalPut = await refusal(() => submitPageMutation(localCtx(engine, s.id), { operation: 'put_page', params }));
  expect(viaLocalPut.code).toBe('invalid_params');
  const remote = await refusal(() => submitManagedFileRepair(localCtx(engine, s.id, true), { sourceId: s.id, requestId: randomUUID(), slug: 'notes/roundup',
    path: 'notes/roundup.md', sourcePath: 'notes/roundup.md', content: note('Injected'), beforeHash: sha256(QUOTABLE), resultDigest: 'x', noEmbed: true }));
  expect(remote).toMatchObject({ code: 'permission_denied', reason: 'trusted_cli_required' });
  expect(s.read('notes/roundup.md')).toBe(QUOTABLE);
}), 180_000);

test('repair paths are confined: climbing, absolute and symlinked paths are refused before anything is written', () => {
  const root = mkdtempSync(join(home, 'confine-'));
  const outside = mkdtempSync(join(home, 'outside-'));
  writeFileSync(join(outside, 'secret.md'), note('Outside'));
  mkdirSync(join(root, 'notes'));
  writeFileSync(join(root, 'notes', 'ok.md'), note('Ok'));
  symlinkSync(outside, join(root, 'linked'));
  symlinkSync(join(outside, 'secret.md'), join(root, 'notes', 'link.md'));
  expect(confinedRepairTarget(root, 'notes/ok.md', 'src')).toBe(join(root, 'notes', 'ok.md'));
  for (const path of ['../outside/secret.md', join(outside, 'secret.md'), 'linked/secret.md', 'notes/link.md', 'notes/missing.md']) {
    let error: unknown;
    try { confinedRepairTarget(root, path, 'src'); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(OperationError);
    expect((error as OperationError).code).toBe('source_changed');
  }
});

test('a held renamed file: the repair moves the old page with its id instead of creating a second page', () => each(async engine => {
  const s = await managed(engine, { 'notes/old.md': long('Old') });
  await s.sync();
  const page = (await engine.getPage('notes/old', { sourceId: s.id }))!;
  git(s.root, 'mv', 'notes/old.md', 'notes/new.md'); s.write('notes/new.md', longBroken); commit(s.root, 'rename to broken');
  await s.sync();
  expect((await s.holds())[0]).toMatchObject({ path: 'notes/new.md', meta: { rename_from: { slug: 'notes/old', pageId: page.id } } });
  const preview = await s.run({ includeAmbiguous: true });
  const hash = preview.apply_command.split('--expect ')[1]!.split(' ')[0]!;
  const applied = await s.run({ apply: true, expect: hash, includeAmbiguous: true });
  expect(applied.outcome_items?.[0]?.detail).toMatchObject({ imported: 'renamed', hold_cleared: true });
  expect((await engine.getPage('notes/new', { sourceId: s.id }))?.id).toBe(page.id);
  expect(await engine.getPage('notes/old', { sourceId: s.id })).toBeNull();
  const [{ count }] = await engine.executeRaw<{ count: number }>('SELECT count(*)::int AS count FROM pages WHERE source_id=$1 AND deleted_at IS NULL', [s.id]);
  expect(Number(count)).toBe(1);
}), 180_000);

test('a rename held because the old page changed is re-bound to its current revision only under --include-ambiguous', () => each(async engine => {
  const s = await managed(engine, { 'notes/x.md': long('X') });
  await s.sync();
  const x = (await engine.getPage('notes/x', { sourceId: s.id }))!;
  git(s.root, 'mv', 'notes/x.md', 'notes/y.md'); s.write('notes/y.md', longBroken); commit(s.root, 'x to y broken');
  await s.sync();
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('UPDATE pages SET knowledge_revision=gen_random_uuid() WHERE id=$1', [x.id]);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  s.write('notes/y.md', long('Y')); commit(s.root, 'fix y');
  await s.sync();
  expect((await s.holds())[0]).toMatchObject({ path: 'notes/y.md', code: 'rename_held' });
  const safe = await s.run();
  expect(details(safe).counts).toMatchObject({ safe: 0, interpretive_pending: 1 });
  const preview = await s.run({ includeAmbiguous: true });
  expect(details(preview).diffs[0]!.fixes.join(' ')).toContain('Re-bind the rename of notes/y.md to page notes/x');
  const hash = preview.apply_command.split('--expect ')[1]!.split(' ')[0]!;
  const applied = await s.run({ apply: true, expect: hash, includeAmbiguous: true });
  expect(applied.outcome_items?.[0]?.detail).toMatchObject({ imported: 'renamed', hold_cleared: true, written: false });
  expect((await engine.getPage('notes/y', { sourceId: s.id }))).toMatchObject({ id: x.id, title: 'Y' });
  expect(await s.holds()).toEqual([]);
}), 180_000);

test('database side: a page whose body begins with its own frontmatter block is re-imported from its clean file under --include-ambiguous', () => each(async engine => {
  const s = await managed(engine, { 'notes/fact.md': note('Real title', 'The real body.'), 'notes/twice.md': `---\ntitle: Outer\n---\n---\ntitle: Inner\n---\nBody.\n` });
  await s.sync();
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("UPDATE pages SET compiled_truth=$2, title='Fact' WHERE source_id=$1 AND slug='notes/fact'", [s.id, '---\ntitle: Real title\n---\nThe real body.']);
  await engine.executeRaw("UPDATE pages SET title='Twice' WHERE source_id=$1 AND slug='notes/twice'", [s.id]);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const safe = await s.run();
  expect(details(safe).counts.interpretive_pending).toBe(1);
  const preview = await s.run({ includeAmbiguous: true });
  expect(details(preview).diffs).toEqual([expect.objectContaining({ path: 'notes/fact.md', class: 'interpretive' })]);
  expect(details(preview).needs_review).toEqual([expect.objectContaining({ path: 'notes/twice.md', code: 'embedded_frontmatter' })]);
  const hash = preview.apply_command.split('--expect ')[1]!.split(' ')[0]!;
  const applied = await s.run({ apply: true, expect: hash, includeAmbiguous: true });
  expect(applied.outcome_items?.[0]?.detail).toMatchObject({ imported: 'updated', written: false });
  const fixed = (await engine.getPage('notes/fact', { sourceId: s.id }))!;
  expect(fixed.title).toBe('Real title');
  expect(fixed.compiled_truth.trim()).toBe('The real body.');
  expect(s.read('notes/fact.md')).toBe(note('Real title', 'The real body.'));
}), 180_000);

test('legacy brain: the apply backs the file up, writes it, imports it, clears its hold and prints the commit step', async () => {
  const engine = legacyEngine;
  await withEnv(env, async () => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const id = 'legacy-fm', root = join(home, id);
    mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(join(root, 'notes', 'roundup.md'), QUOTABLE);
    writeFileSync(join(root, 'notes', 'post.md'), folded(4));
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
    const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [id]);
    // The hold legacy sync records for the folded file.
    await writeGitHold(engine, { source_id: id, incarnation, path: 'notes/post.md', source_path: 'notes/post.md', slug: 'notes/post', page_id: null,
      code: 'invalid_frontmatter', message: 'Invalid YAML frontmatter: key "title" at line 2 continues on unquoted lines.', upstream_version: sha256(folded(4)),
      observed_at: new Date().toISOString(), run_id: 'legacy-fixture', mode: 'legacy', meta: { reason: 'needs_interpretation', key: 'title', line: 2, recovery_version: 1 } });
    const s = fixture(engine, id, root, (path, content) => writeFileSync(join(root, path), content));
    const preview = await s.run({ includeAmbiguous: true });
    expect(details(preview).counts).toMatchObject({ safe: 1, interpretive: 1 });
    const hash = preview.apply_command.split('--expect ')[1]!.split(' ')[0]!;
    const applied = await s.run({ apply: true, expect: hash, includeAmbiguous: true });
    expect(applied.outcome_items!.find(o => o.detail?.path === 'notes/post.md')!.detail).toMatchObject({ written: true, hold_cleared: true });
    expect(await s.holds()).toEqual([]);
    expect((await engine.getPage('notes/post', { sourceId: id }))?.title).toBe('alice-example post 4\nsecond line of post 4');
    const detail = applied.outcome_items!.find(o => o.detail?.path === 'notes/roundup.md')!.detail!;
    expect(detail).toMatchObject({ path: 'notes/roundup.md', written: true, imported: 'imported', committed: 'commit_step' });
    expect(String(detail.commit_step)).toContain(`git -C ${root} add -- notes/roundup.md`);
    expect(readFileSync(String(detail.backup), 'utf8')).toBe(QUOTABLE);
    expect(s.read('notes/roundup.md')).toContain('author: "alice-example');
    expect((await engine.getPage('notes/roundup', { sourceId: id }))?.frontmatter.author).toBe('alice-example (citing acme-example) (original: https://example.invalid/a)');
  });
}, 120_000);

test('the CLI apply asks for destructive consent: without --yes a non-interactive run exits 3 and writes nothing', () => each(async engine => {
  const s = await managed(engine, { 'notes/roundup.md': QUOTABLE });
  await s.sync();
  const hash = (await s.run()).apply_command.split('--expect ')[1]!.split(' ')[0]!;
  _resetCliExitVerdictForTests();
  let printed = '';
  const original = console.log, write = process.stdout.write;
  console.log = (...parts: unknown[]) => { printed += parts.map(String).join(' '); };
  process.stdout.write = ((chunk: string | Uint8Array) => { printed += String(chunk); return true; }) as typeof process.stdout.write;
  try { await withEnv({ GBRAIN_INTERACTIVE: '0', CI: '1' }, () => runRepairCommand(engine, ['frontmatter', '--source', s.id, '--apply', '--expect', hash, '--json'])); }
  finally { console.log = original; process.stdout.write = write; }
  expect(currentExitCode()).toBe(3);
  expect(JSON.parse(printed)).toMatchObject({ code: 'confirmation_required', effects: ['destructive'] });
  expect(s.read('notes/roundup.md')).toBe(QUOTABLE);
  _resetCliExitVerdictForTests();
  console.log = () => {};
  try { await runRepairCommand(engine, ['frontmatter', '--source', s.id, '--apply', '--expect', hash, '--yes', '--json']); } finally { console.log = original; }
  expect(currentExitCode()).toBe(0);
  expect(s.read('notes/roundup.md')).toContain('author: "alice-example');
}), 180_000);

test('database side: a slug-derived title under a file that names one is re-imported; a page whose file now holds a protected key is flagged', () => each(async engine => {
  const s = await managed(engine, { 'notes/launch-plan.md': note('The real launch plan'), 'notes/private.md': note('Private') });
  await s.sync();
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("UPDATE pages SET title='Launch Plan' WHERE source_id=$1 AND slug='notes/launch-plan'", [s.id]);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  s.write('notes/private.md', '---\ntitle: Private\nvisibility: private # note: x\n---\nBody.\n'); commit(s.root, 'protected key');
  expect((await s.sync()).held?.[0]).toMatchObject({ path: 'notes/private.md', reason: 'ambiguous_protected_key', stale: true });
  const preview = await s.run({ includeAmbiguous: true });
  expect(details(preview).diffs).toEqual([expect.objectContaining({ path: 'notes/launch-plan.md', class: 'interpretive' })]);
  expect(details(preview).diffs[0]!.fixes[0]).toContain('title was derived from the slug');
  expect(details(preview).needs_review).toEqual([expect.objectContaining({ path: 'notes/private.md', reason: 'ambiguous_protected_key', key: 'visibility', flag: 'imported_before_hold' })]);
  const hash = preview.apply_command.split('--expect ')[1]!.split(' ')[0]!;
  await s.run({ apply: true, expect: hash, includeAmbiguous: true });
  expect((await engine.getPage('notes/launch-plan', { sourceId: s.id }))?.title).toBe('The real launch plan');
}), 180_000);
