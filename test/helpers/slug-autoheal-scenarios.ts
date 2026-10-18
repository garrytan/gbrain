/**
 * #6865: stray frontmatter `slug:` lines on a managed source. PGLite runs these from test/slug-autoheal-6865.test.ts;
 * the Postgres arm is test/e2e/slug-autoheal-6865-postgres.test.ts.
 *
 * Protects: a held file whose `slug:` line names no page and no file is healed by the next plain sync (line removed,
 * aliases line left as written, indexed under its path slug, hold cleared, gbrain commit, declared slug kept as an
 * alias); a line naming an existing page (a file-backed one, and a database-only one) is left held with nothing
 * recorded, and the lane's later verdict names both pages; the heal never edits a file while its source has an
 * unfinished sync, its path is busy, it changed since sync held it, or the sync runs under remote authority; a verdict an
 * older lane recorded is rechecked by the next sync; the kill switch leaves the file held and says so.
 */
import { expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SyncResult } from '../../src/commands/sync.ts';
import { performSync } from '../../src/commands/sync/perform.ts';
import { resolveSlugForPath } from '../../src/core/sync.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { gitHoldItem, readGitSourceHolds, recordContentHoldRepair, syncHoldJsonFields } from '../../src/core/persistence/sync-holds.ts';
import { holdVerdict } from '../../src/core/persistence/sync-status.ts';
import { contentHoldDisposition } from '../../src/core/repair/content-lane.ts';
import { resolveRepairScope } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { absentSlugHealRun, healAbsentSlugLine } from '../../src/core/repair/slug-conflicts.ts';
import { healAfterManagedSync, SLUG_AUTO_REMOVE_KEY } from '../../src/core/repair/slug-autoheal.ts';
import { withSubmissionAuthority } from '../../src/core/minions/submission-authority.ts';
import { CONTENT_REPAIR_LANE_VERSION } from '../../src/core/persistence/sync-fault-class.ts';
import { managedBrain, type ManagedBrain } from './managed-brain.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const quiet = { info() {}, warn() {}, error() {} };

export const STRAY = 'investors/fund-a.md';
const ALIASES = 'aliases: ["Fund A", "Fund A Capital"]';
const STRAY_BYTES = `---\ntitle: "Fund A"\ntype: company\nslug: fund-a\n${ALIASES}\n---\nFund A invests in example companies.\n`;
const DB_ONLY_HELD = 'companies/fund-b-partners.md';
const FILE_HELD = 'people/alice-example.md';
const OTHER_TYPE = 'media/quarterly-talk.md';

/** A git checkout with the fixture committed, before the managed brain claims it; `dbOnly` adds a database-only page `fund-b`. */
function plant(files: Record<string, string>, dbOnly = false) {
  return async ({ engine, root }: { engine: BrainEngine; root: string }) => {
    git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
    for (const [path, content] of Object.entries(files)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); }
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'fixture');
    writeFileSync(join(root, '.git', 'hooks', 'post-commit'), '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\n'); chmodSync(join(root, '.git', 'hooks', 'post-commit'), 0o755);
    if (dbOnly) await engine.putPage('fund-b', { type: 'company', title: 'Fund B', compiled_truth: 'Fund B, kept only in the database.', timeline: '' });
  };
}

const sync = (engine: BrainEngine) => performSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true } as never);
const holds = async (engine: BrainEngine) => (await readGitSourceHolds(engine, { sourceIds: ['default'] }))[0]?.holds ?? [];
const read = (root: string, path: string) => readFileSync(join(root, path), 'utf8');

async function gitEffectsSettled(engine: BrainEngine) {
  for (let i = 0; i < 100; i++) {
    await runPersistenceEffects(engine, { engine: engine.kind }, { hostId: localHostId(), limit: 10 });
    const open = await engine.executeRaw("SELECT 1 FROM persistence_effects WHERE source_id='default' AND kind='git' AND state<>'committed'");
    if (!open.length) return;
    await Bun.sleep(100);
  }
  throw new Error('git effects did not settle');
}

/** Holds the stray file with the heal off, so a test controls when the heal runs. */
async function heldWithHealOff(brain: ManagedBrain) {
  await brain.engine.setConfig(SLUG_AUTO_REMOVE_KEY, 'false');
  const first = await sync(brain.engine);
  expect(first.slug_lines_removed).toMatchObject({ skipped: 'disabled', removed: 0, pending: 1 });
  expect((await holds(brain.engine)).map(hold => [hold.path, hold.code])).toEqual([[STRAY, 'frontmatter_slug_conflict']]);
  expect(read(brain.root, STRAY)).toBe(STRAY_BYTES);
  await brain.engine.setConfig(SLUG_AUTO_REMOVE_KEY, 'true');
}

/** The next plain sync removes a stray slug: line naming no page and indexes the file under its path slug. */
export async function strayLineHealedBySync(databaseUrl?: string) {
  await managedBrain(async ({ engine, root }) => {
    const slug = resolveSlugForPath(STRAY);
    const result = await sync(engine);
    expect(result.slug_lines_removed).toMatchObject({ removed: 1, pending: 0, failed: 0, removed_paths: [STRAY] });
    expect(syncHoldJsonFields(result).slug_lines_removed).toBeDefined();
    expect(result.held?.some(item => item.path === STRAY) ?? false).toBe(false);
    expect(await holds(engine)).toEqual([]);
    const after = read(root, STRAY);
    expect(after).not.toContain('slug: fund-a');
    expect(after).toContain(ALIASES);
    expect(after).toBe(STRAY_BYTES.replace('slug: fund-a\n', ''));
    expect((await engine.readPageSnapshot(slug, { sourceId: 'default' }))?.page.source_path).toBe(STRAY);
    expect(await engine.readPageSnapshot('fund-a', { sourceId: 'default' })).toBeNull();
    const [alias] = await engine.executeRaw<{ canonical_slug: string }>("SELECT canonical_slug FROM slug_aliases WHERE source_id='default' AND alias_slug='fund-a'");
    expect(alias?.canonical_slug).toBe(slug);
    await gitEffectsSettled(engine);
    expect(git(root, 'log', '-1', '--format=%s')).toBe(`gbrain: repair frontmatter slug in ${STRAY}`);
    expect(git(root, 'status', '--porcelain')).toBe('');
    const again = await sync(engine);
    expect(again.slug_lines_removed).toBeUndefined();
    expect(await holds(engine)).toEqual([]);
  }, { databaseUrl, setup: plant({ [STRAY]: STRAY_BYTES, 'notes/clean.md': '---\ntitle: Clean\ntype: note\n---\nSee [[fund-a]].\n' }) });
}

/** The kill switch keeps today's behavior: held, untouched, and the result says which setting skipped the heal. */
export async function killSwitchKeepsHold(databaseUrl?: string) {
  await managedBrain(async brain => {
    await heldWithHealOff(brain);
    await brain.engine.setConfig(SLUG_AUTO_REMOVE_KEY, 'off');
    const result = await sync(brain.engine);
    expect(result.slug_lines_removed?.notice).toContain(`${SLUG_AUTO_REMOVE_KEY} is false`);
    expect(read(brain.root, STRAY)).toBe(STRAY_BYTES);
  }, { databaseUrl, setup: plant({ [STRAY]: STRAY_BYTES }) });
}

/** A slug: line naming an existing page stays held with nothing recorded; the lane's verdict then names both pages. */
export async function existingPageStopsAndAsks(databaseUrl?: string) {
  const files: Record<string, string> = {
    [DB_ONLY_HELD]: '---\ntitle: Fund B Partners\ntype: company\nslug: fund-b\n---\nFund B Partners notes.\n',
    'concepts/fund-c.md': '---\ntitle: Fund C\ntype: concept\n---\nThe Fund C idea.\n',
    [FILE_HELD]: '---\ntitle: Fund C notes\ntype: concept\nslug: concepts/fund-c\n---\nMore on Fund C.\n',
    [OTHER_TYPE]: '---\ntitle: Quarterly talk\ntype: media\nslug: fund-b\n---\nA recorded talk.\n',
  };
  await managedBrain(async ({ engine, root }) => {
    const result = await sync(engine);
    expect(result.slug_lines_removed).toMatchObject({ removed: 0, failed: 0 });
    expect(Object.values(result.slug_lines_removed!.left_by_reason).reduce((a, b) => a + b, 0)).toBe(3);
    expect(result.slug_lines_removed!.left_by_reason.different_type).toBe(1);
    for (const [path, content] of Object.entries(files)) expect(read(root, path)).toBe(content);
    const held = await holds(engine);
    expect(held.map(hold => hold.path).sort()).toEqual([DB_ONLY_HELD, OTHER_TYPE, FILE_HELD].sort());
    for (const hold of held) expect(hold.meta.content_repair).toBeUndefined();
    const runner = await repairRunner(engine, { apply: true, noEmbed: true, logger: quiet });
    await runner.run('slug-conflicts', await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default', noLlm: true });
    const judged = new Map((await holds(engine)).map(hold => [hold.path, hold]));
    expect([...judged.keys()].sort()).toEqual([DB_ONLY_HELD, FILE_HELD]);
    expect(read(root, OTHER_TYPE)).not.toContain('slug: fund-b');
    expect(judged.get(DB_ONLY_HELD)!.meta.content_repair).toMatchObject({ action: 'pending', reason: 'llm_disabled', named: 'fund-b', named_db_only: true, lane_version: CONTENT_REPAIR_LANE_VERSION });
    expect(judged.get(FILE_HELD)!.meta.content_repair).toMatchObject({ action: 'pending', reason: 'llm_disabled', named: 'concepts/fund-c', lane_version: CONTENT_REPAIR_LANE_VERSION });
    expect(judged.get(FILE_HELD)!.meta.content_repair!.named_db_only).toBeUndefined();
    const dbOnlyFix = gitHoldItem(judged.get(DB_ONLY_HELD)!).fix;
    expect(dbOnlyFix.user_message).toContain(DB_ONLY_HELD);
    expect(dbOnlyFix.user_message).toContain('page fund-b (a database-only page with no file)');
    expect(dbOnlyFix.argv).toEqual(['gbrain', 'config', 'set', 'fences.repair.llm', 'true']);
    expect(dbOnlyFix.consent).toEqual(['paid']);
    const stale = { ...judged.get(FILE_HELD)!, held_at: new Date(Date.now() - 48 * 3_600_000).toISOString(), meta: { ...judged.get(FILE_HELD)!.meta, attempts: 5, first_held_at: new Date(Date.now() - 48 * 3_600_000).toISOString() } };
    const verdict = holdVerdict(stale, undefined);
    expect(verdict.needs_human).toBe(true);
    expect(verdict.human_reason).toContain(FILE_HELD);
    expect(verdict.human_reason).toContain('page `concepts/fund-c`');
    expect(verdict.human_reason).toContain('decide which page keeps the slug');
    for (const path of [DB_ONLY_HELD, FILE_HELD]) expect(read(root, path)).toBe(files[path]!);
    const next = await sync(engine);
    expect(next.slug_lines_removed).toMatchObject({ removed: 0, pending: 0, left_by_reason: { lane_verdict: 2 } });
  }, { databaseUrl, setup: plant(files, true) });
}

/** No edit while the source has an unfinished sync, the path is busy, the file changed since the hold, or under remote authority. */
export async function healNeverEditsInFlight(databaseUrl?: string) {
  await managedBrain(async brain => {
    const { engine, root } = brain;
    await heldWithHealOff(brain);
    const synced = { status: 'synced', fromCommit: null, toCommit: '', added: 0, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [] } as SyncResult;
    const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
    await engine.executeRaw("INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at) VALUES ('managed-sync', 'test-6865-unfinished', $1::text::jsonb, now())",
      [JSON.stringify([{ sourceId: 'default', incarnation, done: false, runId: 'test-6865', index: 0 }])]);
    expect((await healAfterManagedSync(engine, { sourceId: 'default' } as never, synced)).slug_lines_removed).toMatchObject({ skipped: 'sync_unfinished', removed: 0 });
    await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='managed-sync' AND fingerprint='test-6865-unfinished'");
    expect(read(root, STRAY)).toBe(STRAY_BYTES);
    const remote = { version: 1, kind: 'remote_generic' } as never;
    expect((await withSubmissionAuthority(remote, () => healAfterManagedSync(engine, { sourceId: 'default' } as never, synced))).slug_lines_removed)
      .toMatchObject({ skipped: 'remote_authority', removed: 0 });
    expect(read(root, STRAY)).toBe(STRAY_BYTES);
    const ctx = { engine, config: { engine: engine.kind }, logger: quiet, remote: false, dryRun: false, sourceId: 'default' } as never;
    const busy = (await absentSlugHealRun(engine, 'default', { embed: false }))!;
    busy.src.busy.paths.add(STRAY);
    expect(await healAbsentSlugLine(ctx, busy, STRAY)).toMatchObject({ applied: false, reason: 'sync_in_progress' });
    expect(read(root, STRAY)).toBe(STRAY_BYTES);
    const draft = STRAY_BYTES.replace('Fund A invests', 'Fund A (draft) invests');
    writeFileSync(join(root, STRAY), draft);
    expect(await healAbsentSlugLine(ctx, (await absentSlugHealRun(engine, 'default', { embed: false }))!, STRAY)).toMatchObject({ applied: false, reason: 'changed_since_hold' });
    expect(read(root, STRAY)).toBe(draft);
    expect((await holds(engine)).map(hold => hold.path)).toEqual([STRAY]);
  }, { databaseUrl, setup: plant({ [STRAY]: STRAY_BYTES }) });
}

/** A verdict an older gbrain recorded is rechecked: listed or escalated no longer, and the next sync heals the file. */
export async function olderVerdictRecheckedAfterUpgrade(databaseUrl?: string) {
  await managedBrain(async brain => {
    const { engine, root } = brain;
    await heldWithHealOff(brain);
    const [hold] = await holds(engine);
    const at = new Date(Date.now() - 72 * 3_600_000).toISOString();
    for (const state of [{ action: 'needs_human' as const, reason: 'content_repair_needs_human' }, { action: 'remove_slug' as const, reason: 'still_invalid' }]) {
      expect(await recordContentHoldRepair(engine, { sourceId: 'default', incarnation: hold!.incarnation, path: STRAY, upstreamVersion: hold!.upstream_version,
        state: { ...state, at, next_attempt_after: null } })).toBe(true);
      const [old] = await holds(engine);
      expect(contentHoldDisposition(old!)).toEqual({ action: 'repair', kind: 'slug-conflicts' });
      expect(holdVerdict({ ...old!, held_at: at, meta: { ...old!.meta, attempts: 37, first_held_at: at } }, undefined).needs_human).toBe(false);
      expect(gitHoldItem(old!).fix.why).toContain('rechecks it once on the next sync or maintenance run');
    }
    const result = await sync(engine);
    expect(result.slug_lines_removed).toMatchObject({ removed: 1, removed_paths: [STRAY] });
    expect(await holds(engine)).toEqual([]);
    expect(read(root, STRAY)).not.toContain('slug: fund-a');
  }, { databaseUrl, setup: plant({ [STRAY]: STRAY_BYTES }) });
}

/** The declared slug is the YAML scalar: a trailing comment does not hide an existing page, so the line stays held. */
export async function commentedLineNamingPageStays(databaseUrl?: string) {
  const bytes = '---\ntitle: Fund B notes\ntype: company\nslug: fund-b # the existing page\n---\nMore on Fund B.\n';
  await managedBrain(async ({ engine, root }) => {
    const result = await sync(engine);
    expect(result.slug_lines_removed).toMatchObject({ removed: 0, failed: 0 });
    expect(read(root, DB_ONLY_HELD)).toBe(bytes);
    expect((await holds(engine)).map(hold => hold.path)).toEqual([DB_ONLY_HELD]);
    expect(await engine.readPageSnapshot('fund-b-the-existing-page', { sourceId: 'default' })).toBeNull();
  }, { databaseUrl, setup: plant({ [DB_ONLY_HELD]: bytes }, true) });
}

/** A file created at the declared slug's path after the heal read the checkout refuses the publication: nothing is edited. */
export async function declaredSlugRecheckedAtPublication(databaseUrl?: string) {
  await managedBrain(async brain => {
    const { engine, root, ctx } = brain;
    await heldWithHealOff(brain);
    const run = (await absentSlugHealRun(engine, 'default', { embed: false }))!;
    expect(run.slugs().has('fund-a')).toBe(false);
    writeFileSync(join(root, 'fund-a.md'), '---\ntitle: Fund A\ntype: company\n---\nWritten while the heal ran.\n');
    const outcome = await healAbsentSlugLine(ctx, run, STRAY);
    expect(outcome).toMatchObject({ applied: false, reason: 'changed_since_read' });
    expect(read(root, STRAY)).toBe(STRAY_BYTES);
    expect((await holds(engine)).map(hold => hold.path)).toEqual([STRAY]);
    expect(await engine.executeRaw("SELECT 1 FROM slug_aliases WHERE source_id='default' AND alias_slug='fund-a'")).toEqual([]);
  }, { databaseUrl, setup: plant({ [STRAY]: STRAY_BYTES }) });
}
