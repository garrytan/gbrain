import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { phaseCGrandfather, phaseDVerify } from '../src/commands/migrations/v0_13_1.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { grandfatherCanonicalPage } from '../src/core/persistence/grandfather.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { localHostId } from '../src/core/persistence/identity.ts';

type FixtureOptions = { databaseUrl?: string; setup?: (f: { engine: BrainEngine; root: string }) => Promise<void> };
async function fixture(run: (f: { engine: BrainEngine; ctx: OperationContext; home: string; root: string; slug: string }) => Promise<void>,
  { databaseUrl, setup }: FixtureOptions = {}) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-grandfather-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        const root = join(home, 'content'); mkdirSync(root);
        await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
        await setup?.({ engine, root });
        await claimWorktree(engine, 'default', root);
        await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
        const ctx: OperationContext = { engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId: 'default',
          remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
        const slug = 'notes/example';
        await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content: '---\ntype: note\ntitle: Example\n---\n\nAmberbadger searchable fixture.\n' } });
        await disposePersistenceConsumer(engine);
        await run({ engine, ctx, home, root, slug });
      } finally { await disposePersistenceConsumer(engine); await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

async function preservesManagedPage(databaseUrl?: string) {
  await fixture(async ({ engine, home, root, slug }) => {
    const before = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    const [column] = await engine.executeRaw<{ width: number }>("SELECT atttypmod::int AS width FROM pg_attribute WHERE attrelid='content_chunks'::regclass AND attname='embedding'");
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
      await tx.executeRaw("UPDATE content_chunks SET embedding=('['||array_to_string(array_fill(0.1::real,ARRAY[$1::int]),',')||']')::vector WHERE page_id=$2", [column.width, before.page.id]);
      await tx.executeRaw('INSERT INTO extract_atoms_page_state(source_incarnation,page_id,content_hash,fail_count,tombstoned) VALUES($1::uuid,$2,$3,2,true)',
        [before.sourceIncarnation, before.page.id, before.page.content_hash]);
    }));
    const chunks = await engine.executeRaw('SELECT id,chunk_text,embedding::text FROM content_chunks WHERE page_id=$1 ORDER BY id', [before.page.id]);
    expect(chunks.length).toBeGreaterThan(0);
    const result = await phaseCGrandfather(engine, { yes: true, dryRun: false, noAutopilotInstall: true });
    expect(result).toMatchObject({ result: { status: 'complete' }, detail: { touched: 1, failed: 0 } });
    const after = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    expect(after.page.frontmatter.validate).toBe(false);
    expect(after.page.compiled_truth).toBe(before.page.compiled_truth);
    expect(after.revision).not.toBe(before.revision);
    expect(after.page.text_projection_revision).toBe(after.revision);
    expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('validate: false');
    expect(await engine.executeRaw('SELECT id,chunk_text,embedding::text FROM content_chunks WHERE page_id=$1 ORDER BY id', [before.page.id])).toEqual(chunks);
    expect(await engine.searchKeyword('Amberbadger', { sourceId: 'default' })).toHaveLength(1);
    expect(await engine.executeRaw('SELECT fail_count,tombstoned FROM extract_atoms_page_state WHERE source_incarnation=$1::uuid AND page_id=$2 AND content_hash=$3',
      [after.sourceIncarnation, after.page.id, after.page.content_hash])).toEqual([{ fail_count: 2, tombstoned: true }]);
    expect(await engine.executeRaw("SELECT e.kind FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE r.intent->>'kind'='managed_grandfather' AND e.kind IN ('embedding','facts-backstop')")).toEqual([]);
    const rollback = join(home, '.gbrain/migrations/v0_13_1-rollback.jsonl');
    const snapshot = JSON.parse(readFileSync(rollback, 'utf8').trim());
    expect(snapshot).toMatchObject({ id: before.page.id, source_id: 'default', source_incarnation: before.sourceIncarnation, knowledge_revision: before.revision });
    expect(snapshot.pre_frontmatter).not.toHaveProperty('validate');
    if (process.platform !== 'win32') expect(statSync(rollback).mode & 0o777).toBe(0o600);
    expect((await phaseCGrandfather(engine, { yes: true, dryRun: false, noAutopilotInstall: true })).detail.touched).toBe(0);
  }, { databaseUrl });
}

test('managed grandfathering publishes metadata without changing vectors or spending on derived effects', () => preservesManagedPage(), 120_000);
test.skipIf(!process.env.DATABASE_URL)('Postgres managed grandfathering preserves canonical bytes, projection and derived state',
  () => preservesManagedPage(process.env.DATABASE_URL), 120_000);

test('a concurrent explicit validation choice is not overwritten by grandfathering', () => fixture(async ({ engine, ctx, slug, root }) => {
  const before = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
  await expect(grandfatherCanonicalPage(engine, { id: before.page.id, source_id: 'default', slug, source_incarnation: before.sourceIncarnation }, async () => {
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), expected_revision: before.revision,
      content: serializePageToMarkdown({ ...before.page, frontmatter: { ...before.page.frontmatter, validate: true } }, before.tags) } });
  })).rejects.toMatchObject({ code: 'revision_conflict' });
  expect((await engine.getPage(slug, { sourceId: 'default' }))?.frontmatter.validate).toBe(true);
  expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('validate: true');
}), 120_000);

test('human file edits abort managed grandfathering without replacing either version', () => fixture(async ({ engine, slug, root }) => {
  const before = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
  const path = join(root, `${slug}.md`); const changed = readFileSync(path, 'utf8') + '\nUnpublished human edit.\n';
  await expect(grandfatherCanonicalPage(engine, { id: before.page.id, source_id: 'default', slug, source_incarnation: before.sourceIncarnation }, () => {
    writeFileSync(path, changed);
  })).rejects.toMatchObject({ code: 'source_changed' });
  expect(readFileSync(path, 'utf8')).toBe(changed);
  expect((await engine.readPageSnapshot(slug, { sourceId: 'default' }))?.revision).toBe(before.revision);
}), 120_000);

test('pending grandfathering reuses its admitted request and its original rollback snapshot', () => fixture(async ({ engine, slug }) => {
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
  const selected = { id: snapshot.page.id, source_id: 'default', slug, source_incarnation: snapshot.sourceIncarnation };
  const host = localHostId(); let backups = 0;
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
    await tx.executeRaw('UPDATE persistence_worktrees SET owner_host_id=$1::uuid', [randomUUID()]);
  });
  let requestId: string | undefined;
  try { await grandfatherCanonicalPage(engine, selected, () => { backups++; }); }
  catch (error: any) { expect(error.code).toBe('write_pending'); requestId = error.writeRequest.request_id; }
  expect(requestId).toBeDefined(); expect(backups).toBe(1);
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
    await tx.executeRaw('UPDATE persistence_worktrees SET owner_host_id=$1::uuid', [host]);
  });
  expect(await grandfatherCanonicalPage(engine, selected, () => { backups++; }))
    .toEqual({ status: 'touched', revision: (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision });
  expect(backups).toBe(1);
  expect(await engine.executeRaw("SELECT request_id,state FROM persistence_requests WHERE intent->>'kind'='managed_grandfather'"))
    .toEqual([{ request_id: requestId, state: 'committed' }]);
}), 120_000);

test('archived sources and non-Markdown artifacts are not rewritten by managed grandfathering', () => fixture(async ({ engine, slug, root }) => {
  const path = join(root, `${slug}.md`), bytes = readFileSync(path, 'utf8');
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
    await tx.executeRaw("UPDATE sources SET archived=true WHERE id='default'");
  });
  expect((await phaseCGrandfather(engine, { yes: true, dryRun: false, noAutopilotInstall: true })).detail).toMatchObject({ touched: 0, skipped: 1, failed: 0 });
  expect(readFileSync(path, 'utf8')).toBe(bytes);
  mkdirSync(join(root, 'source'));
  writeFileSync(join(root, 'source/example.ts'), 'export const fixture = 1;\n');
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
    await tx.executeRaw("UPDATE sources SET archived=false WHERE id='default'");
    await withCoordinatedWrite(tx, ['default'], () => tx.executeRaw("UPDATE pages SET source_path='source/example.ts' WHERE slug=$1", [slug]));
  });
  expect((await phaseCGrandfather(engine, { yes: true, dryRun: false, noAutopilotInstall: true })).detail).toMatchObject({ touched: 0, skipped: 1, failed: 0 });
  expect(readFileSync(path, 'utf8')).toBe(bytes);
  expect(readFileSync(join(root, 'source/example.ts'), 'utf8')).toBe('export const fixture = 1;\n');
  expect((await engine.getPage(slug, { sourceId: 'default' }))?.frontmatter).not.toHaveProperty('validate');
}), 120_000);

const DB_ONLY_SLUG = 'conversations/sessions/probe-session';
const DB_ONLY_CACHE = `${DB_ONLY_SLUG}.md`;
// A durability-hardened Git worktree makes Git effects publish for real, so an
// ignored db_only cache file reaches the path that refuses unsafe targets.
// Transcript ingestion publishes db_only pages before persistence activation;
// a direct import is refused once the source is managed.
const dbOnlySource = (gbrainYml: string, { cache = false } = {}) => async ({ engine, root }: { engine: BrainEngine; root: string }) => {
  writeFileSync(join(root, 'gbrain.yml'), gbrainYml);
  writeFileSync(join(root, '.gitignore'), 'conversations/\n');
  durableGitRepo(root, ['.gitignore', 'gbrain.yml']);
  await importFromContent(engine, DB_ONLY_SLUG, '---\ntype: conversation\ntitle: Probe session\n---\n\nTranscript body.\n', { sourceId: 'default', noEmbed: true });
  if (cache) {
    const snapshot = (await engine.readPageSnapshot(DB_ONLY_SLUG, { sourceId: 'default' }))!;
    mkdirSync(dirname(join(root, DB_ONLY_CACHE)), { recursive: true });
    writeFileSync(join(root, DB_ONLY_CACHE), serializePageToMarkdown(snapshot.page, snapshot.tags));
  }
};
const declaring = (dir: string) => `storage:\n  db_only:\n    - ${dir}\n`;
const replacePage = async (ctx: OperationContext, slug: string, body: string) => {
  const current = (await ctx.engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
  return submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), expected_revision: current.revision,
    content: serializePageToMarkdown({ ...current.page, compiled_truth: body }, current.tags) } });
};
const deletePage = async (ctx: OperationContext, slug: string, purge: boolean) => submitPageMutation(ctx, { operation: 'delete_page',
  params: { slug, request_id: randomUUID(), expected_revision: (await ctx.engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision, purge } });
// Runs every queued Git effect and returns their final rows.
async function settledGitEffects(engine: BrainEngine, ctx: OperationContext) {
  await disposePersistenceConsumer(engine);
  await runPersistenceEffects(engine, ctx.config, { hostId: localHostId(), limit: 20 });
  return engine.executeRaw<{ slug: string; state: string; error_code: string | null; outcome: Record<string, unknown> | null }>(
    "SELECT r.slug,e.state,e.error_code,e.outcome FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE e.kind='git' ORDER BY e.id");
}

for (const declared of ['conversations/', 'Conversations/']) {
  test(`managed writes publish a page under declared db_only ${declared} without a cache file database-only`, () => fixture(async ({ engine, ctx, root }) => {
    expect((await engine.readPageSnapshot(DB_ONLY_SLUG, { sourceId: 'default' }))?.page.source_path).toBeNull();
    expect(await phaseCGrandfather(engine, { yes: true, dryRun: false, noAutopilotInstall: true }))
      .toMatchObject({ result: { status: 'complete' }, detail: { touched: 2, failed: 0 } });
    expect((await engine.getPage(DB_ONLY_SLUG, { sourceId: 'default' }))?.frontmatter.validate).toBe(false);
    expect(await engine.executeRaw("SELECT slug,state FROM persistence_requests WHERE intent->>'kind'='managed_grandfather' ORDER BY slug"))
      .toEqual([{ slug: DB_ONLY_SLUG, state: 'committed' }, { slug: 'notes/example', state: 'committed' }]);
    expect(await replacePage(ctx, DB_ONLY_SLUG, 'Revised transcript body.')).toMatchObject({ write_through: { written: false, skipped: 'db_only' } });
    expect((await engine.getPage(DB_ONLY_SLUG, { sourceId: 'default' }))?.compiled_truth).toContain('Revised transcript body.');
    expect(existsSync(join(root, 'conversations'))).toBe(false);
    expect((await settledGitEffects(engine, ctx)).filter(effect => effect.slug === DB_ONLY_SLUG)).toEqual([]);
  }, { setup: dbOnlySource(declaring(declared)) }), 120_000);
}

const cacheCases: Array<[string, (ctx: OperationContext) => Promise<unknown>, string | null]> = [
  ['an edit rewrites', ctx => replacePage(ctx, DB_ONLY_SLUG, 'Revised transcript body.'), 'Revised transcript body.'],
  ['a soft delete removes', ctx => deletePage(ctx, DB_ONLY_SLUG, false), null],
  ['a purge removes', ctx => deletePage(ctx, DB_ONLY_SLUG, true), null],
];
for (const [name, act, expected] of cacheCases) {
  test(`${name} a present db_only cache file and completes its Git effect as skipped`, () => fixture(async ({ engine, ctx, root }) => {
    expect(await act(ctx)).toMatchObject({ state: 'committed', write_through: { written: true } });
    const cache = join(root, DB_ONLY_CACHE);
    if (expected === null) expect(existsSync(cache)).toBe(false);
    else expect(readFileSync(cache, 'utf8')).toContain(expected);
    const effects = await settledGitEffects(engine, ctx);
    expect(effects.filter(effect => effect.slug === DB_ONLY_SLUG)).toEqual([
      { slug: DB_ONLY_SLUG, state: 'committed', error_code: null, outcome: { git: 'skipped', reason: 'db_only' } }]);
    expect(effects.filter(effect => effect.error_code === 'git_target_unsafe')).toEqual([]);
    expect(git(root, 'log', '--name-only', '--pretty=format:')).not.toContain('conversations');
  }, { setup: dbOnlySource(declaring('conversations/'), { cache: true }) }), 120_000);
}

test('an uncoordinated edit of a db_only cache file still refuses a managed write', () => fixture(async ({ engine, ctx, root }) => {
  const cache = join(root, DB_ONLY_CACHE);
  const edited = readFileSync(cache, 'utf8').replace('Transcript body.', 'Local unpublished edit.');
  writeFileSync(cache, edited);
  const before = (await engine.readPageSnapshot(DB_ONLY_SLUG, { sourceId: 'default' }))!;
  await expect(replacePage(ctx, DB_ONLY_SLUG, 'Revised transcript body.')).rejects.toMatchObject({ code: 'source_changed' });
  expect(readFileSync(cache, 'utf8')).toBe(edited);
  expect((await engine.readPageSnapshot(DB_ONLY_SLUG, { sourceId: 'default' }))?.revision).toBe(before.revision);
}, { setup: dbOnlySource(declaring('conversations/'), { cache: true }) }), 120_000);

test('the missing-file guard still refuses outside declared db_only dirs', () => fixture(async ({ ctx, root, slug }) => {
  rmSync(join(root, `${slug}.md`));
  await expect(replacePage(ctx, slug, 'Replacement body.')).rejects.toMatchObject({ code: 'source_changed' });
}, { setup: dbOnlySource(declaring('conversations/')) }), 120_000);

const invalidStorage: Array<[string, string]> = [
  ['overlapping tiers', 'storage:\n  db_tracked:\n    - conversations/\n  db_only:\n    - conversations/\n'],
  ['flow-style db_only', 'storage:\n  db_only: [conversations/]\n'],
];
for (const [name, gbrainYml] of invalidStorage) {
  test(`${name} in gbrain.yml only turn the missing-file refusal into storage_error`, () => fixture(async ({ engine, ctx, root }) => {
    writeFileSync(join(root, 'gbrain.yml'), gbrainYml);
    const before = (await engine.readPageSnapshot(DB_ONLY_SLUG, { sourceId: 'default' }))!;
    await expect(replacePage(ctx, DB_ONLY_SLUG, 'Replacement transcript.')).rejects.toMatchObject({ code: 'storage_error' });
    expect((await engine.readPageSnapshot(DB_ONLY_SLUG, { sourceId: 'default' }))?.revision).toBe(before.revision);
    expect(existsSync(join(root, 'conversations'))).toBe(false);
    // New pages never read gbrain.yml: both publish their file as on baseline.
    for (const slug of ['notes/created', 'conversations/sessions/created']) {
      expect(await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(),
        content: '---\ntype: note\ntitle: Created\n---\n\nCreated body.\n' } })).toMatchObject({ state: 'committed', write_through: { written: true } });
      expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('Created body.');
    }
  }, { setup: dbOnlySource(declaring('conversations/')) }), 120_000);
}

// cache=false is a regression guard (passes on baseline); cache=true fails there with an unsafe Git target.
for (const cache of [false, true]) {
  test(`a Git source scan passes a db_only page ${cache ? 'with' : 'without'} a cache file`, () => fixture(async ({ engine, ctx }) => {
    // Source scans walk every page in slug order, so the db_only page is visited first.
    const [effect] = await engine.executeRaw<{ id: number }>(
      "SELECT e.id FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE e.kind='git' AND r.slug='notes/example'");
    await engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      await tx.executeRaw(`UPDATE persistence_effects SET data='{"source_scan":true}'::jsonb,state='queued',execution_token=NULL,
        claim_expires_at=NULL,next_attempt_at=now(),error_code=NULL WHERE id=$1`, [effect.id]);
    });
    await runPersistenceEffects(engine, ctx.config, { hostId: localHostId(), limit: 5 });
    expect(await engine.executeRaw('SELECT state,error_code FROM persistence_effects WHERE id=$1', [effect.id]))
      .toEqual([{ state: 'committed', error_code: null }]);
  }, { setup: dbOnlySource(declaring('conversations/'), { cache }) }), 120_000);
}

test('verify reports a managed page rewritten after grandfathering without failing the phase', () => fixture(async ({ engine, slug }) => {
  const { detail } = await phaseCGrandfather(engine, { yes: true, dryRun: false, noAutopilotInstall: true });
  expect(await phaseDVerify(engine, detail.grandfathered)).toMatchObject({ status: 'complete', detail: 'verified=1 rewritten_concurrently=0' });
  await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () =>
    tx.executeRaw("UPDATE pages SET frontmatter=frontmatter-'validate' WHERE source_id='default' AND slug=$1", [slug])));
  expect(await phaseDVerify(engine, detail.grandfathered)).toMatchObject({ status: 'complete', detail: 'verified=0 rewritten_concurrently=1' });
}), 120_000);
