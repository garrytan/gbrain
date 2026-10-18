/**
 * #6696 C8: the slug-conflict repair judges a held file with the same screen
 * managed sync froze it with (`frozenImportScreenInput` + `loadSyncScreenRun`),
 * so the repair and the next sync agree on whether the file is still held.
 *
 * Protects: a slug: line in a source that is a subdirectory of its Git
 * repository under `slug_root_mode=git-root` (the page slug carries the
 * directory) is removed and imported instead of being held `still_invalid`;
 * a hold the screen would now admit (the file's own page records it) is
 * cleared through a guarded canonical import instead of being skipped as
 * `already_exempt` forever; a slug: line resolving to the own page only
 * through an alias, which sync still holds, is held `slug_page_mismatch`
 * naming both slugs instead of `already_exempt`; the clear is bound to the
 * hold observation the repair read, so a newer hold is preserved and the
 * hold keeps a durable retry.
 * Fails when: the repair screens a file differently from sync (a hold the
 * repair calls clean or exempt survives every run, or an edit sync would
 * import is refused), or a repair clears a hold a newer sync wrote.
 * Why new: C8 of the #6696 fix wave.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { gitHoldItem, readGitSourceHolds, writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { prepareRepairPublication, repairScreenConfig, submitManagedFileRepair } from '../src/core/persistence/file-repair.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { CONTENT_REPAIR_ACTOR, CONTENT_REPAIR_HOLD_CODE, parseContentRepairReceipt, type ContentRepairReceipt } from '../src/core/content-repair/receipt.ts';
import { resolveRepairScope, type RepairResult } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import type { SlugConflictsPreviewDetails } from '../src/core/repair/slug-conflicts.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-slug-conflicts-sync-screen-'));
let engine: PGLiteEngine;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message = 'content') => { git(root, 'add', '-A'); git(root, 'commit', '-qm', message); };
const quiet = { info() {}, warn() {}, error() {} };
const page = (title: string, type: string, body: string, extra = '') => `---\ntitle: ${title}\ntype: ${type}\n${extra}---\n${body}\n`;

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => {
  await withEnv(env, async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
  rmSync(home, { recursive: true, force: true });
});

/** A managed source; `subdir` makes the source a directory of its Git repository with slugs pinned to the Git root. */
async function managed(files: Record<string, string>, subdir?: string) {
  const id = `c8-${randomUUID().replace(/-/g, '').slice(0, 16)}`, gitRoot = join(home, id), root = subdir ? join(gitRoot, subdir) : gitRoot;
  mkdirSync(root, { recursive: true }); git(gitRoot, 'init', '-q');
  git(gitRoot, 'config', 'user.name', 'Example'); git(gitRoot, 'config', 'user.email', 'example@example.invalid');
  const write = (path: string, content: string) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); };
  for (const [path, content] of Object.entries(files)) write(path, content);
  commit(gitRoot, 'fixture');
  writeFileSync(join(gitRoot, '.git', 'hooks', 'post-commit'), '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\n'); chmodSync(join(gitRoot, '.git', 'hooks', 'post-commit'), 0o755);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)", [id, root, JSON.stringify(subdir ? { slug_root_mode: 'git-root' } : {})]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const sync = () => performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true });
  const holds = async () => (await readGitSourceHolds(engine, { sourceIds: [id] }))[0]?.holds ?? [];
  const run = async (opts: { apply?: boolean; expect?: string } = {}) => {
    const runner = await repairRunner(engine, { apply: opts.apply === true, noEmbed: true, logger: quiet });
    return runner.run('slug-conflicts', await resolveRepairScope(engine, id), { explicit: true, sourceFlag: id, expect: opts.expect, noLlm: true });
  };
  return { id, root, gitRoot, write, sync, holds, run, read: (path: string) => readFileSync(join(root, path), 'utf8') };
}

const details = (result: RepairResult) => result.details as unknown as SlugConflictsPreviewDetails;
const hashOf = (result: RepairResult) => result.apply_command.split('--expect ')[1]!.split(' ')[0]!;
const classes = (result: RepairResult) => result.listing!.map(entry => [entry.item.split(':').slice(1).join(':'), entry.class]);

function each(run: () => Promise<void>) {
  return withEnv(env, async () => { try { await run(); } finally { await disposePersistenceConsumer(engine); } });
}

/** The state an older gbrain left: the page the file's slug: line names records the file as its origin, and a hold from before still stands. */
async function ownPageRecordsTheFile(sourceId: string, slug: string, sourcePath: string) {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.putPage(slug, { type: 'company', title: 'Acme Example', compiled_truth: 'An older import of the company page.' }, { sourceId });
  await engine.executeRaw('UPDATE pages SET source_path=$3 WHERE source_id=$1 AND slug=$2', [sourceId, slug, sourcePath]);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
}

test('a git-root source in a subdirectory: the slug: line is removed and imported (the page slug carries the directory), not held still_invalid', () => each(async () => {
  const s = await managed({ 'companies/acme-example.md': page('Acme Example', 'company', 'A synthetic company.', 'slug: acme-example\n') }, 'brain');
  expect((await s.sync()).held_count).toBe(1);
  const [hold] = await s.holds();
  expect(hold).toMatchObject({ path: 'companies/acme-example.md', source_path: 'brain/companies/acme-example.md', slug: 'brain/companies/acme-example', code: 'frontmatter_slug_conflict' });
  const preview = await s.run();
  expect(classes(preview)).toEqual([['companies/acme-example.md', 'deterministic']]);
  expect(details(preview).diffs.map(d => d.rule)).toEqual(['absent_page']);
  const applied = await s.run({ apply: true, expect: hashOf(preview) });
  expect(applied).toMatchObject({ applied: 1, repaired: 1 });
  expect(s.read('companies/acme-example.md')).not.toContain('slug:');
  expect(await s.holds()).toEqual([]);
  expect((await engine.getPage('brain/companies/acme-example', { sourceId: s.id }))?.compiled_truth).toContain('A synthetic company.');
}), 240_000);

test('a hold the sync screen now admits (the own page records the file) is cleared through a guarded canonical import, not skipped already_exempt', () => each(async () => {
  const s = await managed({ 'companies/acme-example.md': page('Acme Example', 'company', 'The company as the file has it.', 'slug: acme-example\n') });
  expect((await s.sync()).held_count).toBe(1);
  await ownPageRecordsTheFile(s.id, 'acme-example', 'companies/acme-example.md');
  const preview = await s.run();
  expect(classes(preview)).toEqual([['companies/acme-example.md', 'import']]);
  expect(s.read('companies/acme-example.md')).toContain('slug: acme-example');
  const applied = await s.run({ apply: true, expect: hashOf(preview) });
  expect(applied).toMatchObject({ applied: 1, repaired: 1 });
  expect(applied.outcome_items![0]).toMatchObject({ outcome: 'repaired', detail: { action: 'import', hold_cleared: true } });
  // The file is untouched; its page now carries the held bytes.
  expect(s.read('companies/acme-example.md')).toContain('slug: acme-example');
  expect(await s.holds()).toEqual([]);
  expect((await engine.getPage('acme-example', { sourceId: s.id }))?.compiled_truth).toContain('The company as the file has it.');
  expect(git(s.root, 'status', '--porcelain')).toBe('');
}), 240_000);

test('the clear is bound to the hold observation the repair read: a newer hold is preserved and keeps a durable retry', () => each(async () => {
  const s = await managed({ 'companies/acme-example.md': page('Acme Example', 'company', 'The company as the file has it.', 'slug: acme-example\n') });
  expect((await s.sync()).held_count).toBe(1);
  await ownPageRecordsTheFile(s.id, 'acme-example', 'companies/acme-example.md');
  const preview = await s.run();
  expect(classes(preview)).toEqual([['companies/acme-example.md', 'import']]);
  // A sync observes the path again after the preview read it.
  const [held] = await s.holds();
  // Newer than the observation the repair read, older than the publication.
  const newer = new Date(Date.parse(held!.observed_at) + 1).toISOString();
  await engine.transaction(tx => writeGitHold(tx, { ...held!, observed_at: newer }));
  const applied = await s.run({ apply: true, expect: hashOf(preview) });
  expect(applied).toMatchObject({ applied: 0 });
  expect(applied.outcome_items![0]).toMatchObject({ outcome: 'skipped', reason: 'changed_since_preview' });
  const [kept] = await s.holds();
  expect(kept).toMatchObject({ path: 'companies/acme-example.md', observed_at: newer });
  expect(kept!.meta.content_repair).toMatchObject({ action: 'pending', reason: 'changed_since_read' });
  expect(Date.parse(kept!.meta.content_repair!.next_attempt_after!)).toBeGreaterThan(Date.now());
  expect(gitHoldItem(kept!).fix.why).toContain('tries again');
  // The next run reads the newer observation and clears it the same way.
  const again = await s.run({ apply: true });
  expect(again).toMatchObject({ applied: 1, repaired: 1 });
  expect(await s.holds()).toEqual([]);
}), 240_000);

test('the publishing transaction clears only the bound observation: an import bound to an older hold keeps the newer one; an import receipt must name unchanged bytes', () => each(async () => {
  const path = 'companies/acme-example.md', content = page('Acme Example', 'company', 'The company as the file has it.', 'slug: acme-example\n');
  const s = await managed({ [path]: content });
  expect((await s.sync()).held_count).toBe(1);
  await ownPageRecordsTheFile(s.id, 'acme-example', path);
  const [held] = await s.holds();
  // Newer than the observation the repair read, older than the publication.
  const newer = new Date(Date.parse(held!.observed_at) + 1).toISOString();
  await engine.transaction(tx => writeGitHold(tx, { ...held!, observed_at: newer }));
  const snapshot = await engine.readPageSnapshot('acme-example', { sourceId: s.id, includeDeleted: true });
  const publication = await prepareRepairPublication(engine, { sourceId: s.id, slug: 'acme-example', sourcePath: path, path, root: s.root, content, snapshot, base: snapshot, ...await repairScreenConfig(engine, s.id) });
  expect(publication.status).toBe('ready');
  const before = sha256(Buffer.from(content, 'utf8'));
  const receipt: ContentRepairReceipt = { actor: CONTENT_REPAIR_ACTOR, hold_code: CONTENT_REPAIR_HOLD_CODE, action: 'import', tier: 'deterministic', confidence: 'high', model: null, cost_usd: 0, before_sha256: before, after_sha256: before };
  const ctx = { engine, config: { engine: engine.kind }, logger: quiet, dryRun: false, remote: false, sourceId: s.id } as unknown as OperationContext;
  const outcome = await submitManagedFileRepair(ctx, { sourceId: s.id, requestId: randomUUID(), slug: 'acme-example', path, sourcePath: path, content, beforeHash: before,
    resultDigest: publication.status === 'ready' ? publication.digest : '', expected_revision: snapshot!.revision, noEmbed: true, contentRepair: receipt, holdObservedAt: held!.observed_at });
  expect(outcome).toMatchObject({ state: 'committed', file_repaired: false, hold_cleared: false, content_repair: receipt });
  expect((await s.holds())[0]).toMatchObject({ path, observed_at: newer });
  expect(parseContentRepairReceipt({ ...receipt, after_sha256: 'c'.repeat(64) })).toBeNull();
}), 240_000);

test('a slug: line resolving to the own page only through an alias, which sync holds, is slug_page_mismatch naming both slugs, not already_exempt', () => each(async () => {
  const s = await managed({ 'people/carol-example.md': page('Carol Example', 'person', 'A synthetic person.') });
  await s.sync();
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.write_sources', $1, true)", [JSON.stringify([s.id])]);
    await tx.executeRaw('INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ($1, $2, $3)', [s.id, 'people/carol', 'people/carol-example']);
  });
  s.write('people/carol-example.md', page('Carol Example', 'person', 'A synthetic person.', 'slug: people/carol\n')); commit(s.root, 'alias slug');
  expect((await s.sync()).held_count).toBe(1);
  const preview = await s.run();
  expect(classes(preview)).toEqual([['people/carol-example.md', 'slug_page_mismatch']]);
  const resolution = details(preview).held[0]!.resolution;
  expect(resolution).toContain('people/carol');
  expect(resolution).toContain('people/carol-example');
  const applied = await s.run({ apply: true });
  expect(applied).toMatchObject({ applied: 0, remaining: { slug_page_mismatch: 1 } });
  const [kept] = await s.holds();
  expect(kept!.meta.content_repair).toMatchObject({ action: 'remove_slug', reason: 'slug_page_mismatch', named: 'people/carol-example' });
  expect(gitHoldItem(kept!).fix.why).toContain('people/carol-example');
}), 240_000);
