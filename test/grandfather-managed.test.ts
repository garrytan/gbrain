// #7814: a managed grandfather write an older binary queued ends without writing.
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { requestPrincipalForContext, submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite } from '../src/core/persistence/journal.ts';
import { disposePersistenceConsumer, waitForWrite } from '../src/core/persistence/service.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { resolveRepairScope, runRepair } from '../src/core/repair/core.ts';
import { visibilityRepair } from '../src/core/repair/visibility.ts';

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

async function queuedGrandfatherEndsWithoutWriting(databaseUrl?: string) {
  await fixture(async ({ engine, ctx, root, slug }) => {
    const file = join(root, slug + '.md');
    const before = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    durableGitRepo(root, [slug + '.md']);
    const bytes = readFileSync(file, 'utf8'), head = git(root, 'rev-parse', 'HEAD').trim();
    const principal = await requestPrincipalForContext(ctx);
    const authority = await submissionAuthority(ctx, 'put_page', 'default', before.sourceIncarnation, slug);
    const binding = await getWorktreeBinding(engine, 'default');
    const request = await admitWrite(engine, { principal, operation: 'put_page', sourceId: 'default', sourceIncarnation: before.sourceIncarnation,
      pageId: before.page.id, slug, requestId: randomUUID(), authority, callerIntent: { migration: '0.13.1', expected_revision: before.revision },
      intent: { kind: 'managed_grandfather', expected_revision: before.revision }, worktreeId: binding?.worktree_id, topologyGeneration: binding?.topology_generation });
    await waitForWrite(engine, request, ctx.config, 30_000).catch(() => undefined);
    expect(await engine.executeRaw('SELECT state,error_code FROM persistence_requests WHERE request_id=$1::uuid', [request.request_id]))
      .toEqual([{ state: 'conflict', error_code: 'revision_conflict' }]);
    const after = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    expect(after.page.frontmatter).toEqual(before.page.frontmatter);
    expect(after.page.frontmatter).not.toHaveProperty('validate');
    expect(after.page.content_hash).toBe(before.page.content_hash);
    expect(after.revision).toBe(before.revision);
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(head);
  }, { databaseUrl });
}

test('a queued managed_grandfather request ends in conflict without writing', () => queuedGrandfatherEndsWithoutWriting(), 120_000);
test.skipIf(!process.env.DATABASE_URL)('Postgres: a queued managed_grandfather request ends in conflict without writing',
  () => queuedGrandfatherEndsWithoutWriting(process.env.DATABASE_URL), 120_000);

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

// Derive-phase output (atoms/, concepts/, ...) is database-only by design and never
// declared in gbrain.yml; extraction writes it before persistence activation.
const ATOM_SLUG = 'atoms/2026-09-02/probe-atom';
const derivedSource = async ({ engine, root }: { engine: BrainEngine; root: string }) => {
  writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  db_tracked:\n    - notes/\n');
  durableGitRepo(root, ['gbrain.yml']);
  await importFromContent(engine, ATOM_SLUG, '---\ntype: atom\ntitle: Probe atom\nsource_slug: notes/example\n---\n\nAn atom derived from a public note.\n', { sourceId: 'default', noEmbed: true });
};

test('managed writes publish a never-filed derive-phase page database-only without declaring its dir', () => fixture(async ({ engine, ctx, root }) => {
  expect((await engine.readPageSnapshot(ATOM_SLUG, { sourceId: 'default' }))?.page.source_path).toBeNull();
  expect(await replacePage(ctx, ATOM_SLUG, 'A revised atom.')).toMatchObject({ write_through: { written: false, skipped: 'db_only' } });
  expect((await engine.getPage(ATOM_SLUG, { sourceId: 'default' }))?.compiled_truth).toContain('A revised atom.');
  expect(existsSync(join(root, 'atoms'))).toBe(false);
  expect((await settledGitEffects(engine, ctx)).filter(effect => effect.slug === ATOM_SLUG)).toEqual([]);
}, { setup: derivedSource }), 120_000);

test('the visibility repair stamps an undeclared database-only atom on a managed brain', () => fixture(async ({ engine, ctx }) => {
  expect((await engine.getPage(ATOM_SLUG, { sourceId: 'default' }))?.frontmatter.visibility).toBeUndefined();
  await runRepair(ctx, visibilityRepair, await resolveRepairScope(engine), { apply: true });
  expect((await engine.getPage(ATOM_SLUG, { sourceId: 'default' }))?.frontmatter.visibility).toBe('world');
}, { setup: derivedSource }), 120_000);

test('a derive-phase page whose recorded file went missing still refuses', () => fixture(async ({ ctx, root }) => {
  const slug = 'atoms/filed-atom';
  expect(await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(),
    content: '---\ntype: atom\ntitle: Filed atom\n---\n\nFiled body.\n' } })).toMatchObject({ state: 'committed', write_through: { written: true } });
  rmSync(join(root, `${slug}.md`));
  await expect(replacePage(ctx, slug, 'Replacement body.')).rejects.toMatchObject({ code: 'source_changed' });
}, { setup: derivedSource }), 120_000);

const invalidStorage: Array<[string, string]> = [
  ['overlapping tiers', 'storage:\n  db_tracked:\n    - conversations/\n  db_only:\n    - conversations/\n'],
  ['a multi-line flow-style db_only', 'storage:\n  db_only: [conversations/,\n    archive/]\n'],
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
