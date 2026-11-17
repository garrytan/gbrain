/**
 * Whole-class settle for held file-drift pages (`gbrain repair file-drift --held --side <side> --prefer file --whole-class`).
 *   - B1: on a read-only mirror the held window preview lists a side unknown or both page whose file is newer prefer_file, not no_drift.
 *   - The whole-class preview walks every window into one manifest (totals equal the per-window sums; no apply command until it
 *     completes); it refuses past the recovery-bytes limit (class_capacity_exceeded) and on a repo-less brain finds no held pages.
 *   - kept_protected_parts: a mirror page whose file-wins result needs protected parts in its file stays held through syncs.
 * PGLite always; Postgres when DATABASE_URL is set. Synthetic content only.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { RECOVERY_VERSION } from '../src/core/markdown.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { FILE_DRIFT_VERSION, writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { resolveRepairScope, type RepairPlanOptions } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { artifactDirectory } from '../src/core/repair/file-drift.ts';
import { classWindow, previewFileDriftClass, type ClassSelection } from '../src/core/repair/file-drift-class.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const logger = { info() {}, warn() {}, error() {} };
const doc = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;
const commitAll = (root: string, message: string) => { git(root, 'add', '-A'); git(root, 'commit', '-qm', message); };
const files = (root: string, entries: Record<string, string>) => {
  for (const [slug, text] of Object.entries(entries)) { mkdirSync(join(root, slug, '..'), { recursive: true }); writeFileSync(join(root, `${slug}.md`), text); }
};
const coordinated = (engine: BrainEngine, sql: string, params: unknown[] = []) =>
  engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(sql, params), TEST_WRITE_ATTRIBUTION));
const sel = (side = 'unknown'): ClassSelection => ({ sourceId: 'default', side, only: [], skip: [] });
const asCli = <T>(engine: BrainEngine, run: () => Promise<T>) => registerLocalWriter(engine, 'cli').then(writer => withVerifiedLocalRegistration(engine, writer, run));
const preview = (engine: BrainEngine, side = 'unknown', opts: Parameters<typeof previewFileDriftClass>[3] = {}) =>
  asCli(engine, async () => previewFileDriftClass(engine, await resolveRepairScope(engine, 'default'), sel(side), { remote: false, ...opts }));
async function windowPreview(engine: BrainEngine, opts: Partial<RepairPlanOptions>) {
  return asCli(engine, async () => (await repairRunner(engine, { apply: false, logger })).run('file-drift', await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default', ...opts } as never));
}
const classes = (plan: { listing?: Array<{ item: string; class: string }> }) => Object.fromEntries((plan.listing ?? []).map(entry => [entry.item.replace('default:', ''), entry.class]));
const holdRows = async (engine: BrainEngine) => (await engine.executeRaw<{ r: { path: string; code: string; observed_at: string; upstream_version: string | null; meta: Record<string, unknown> } }>(
  "SELECT completed_keys->0 AS r FROM op_checkpoints WHERE op='sync-hold' ORDER BY fingerprint")).map(({ r }) => r);
const body = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ b: string }>("SELECT compiled_truth AS b FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0]?.b;
/** Every byte of the checkout (Git's own directory excluded), its HEAD and its status: what "byte-identical" compares. */
function checkout(root: string): string {
  const hash = createHash('sha256');
  const walk = (dir: string) => { for (const name of readdirSync(dir).sort()) { if (name === '.git') continue; const path = join(dir, name);
    try { hash.update(path).update(readFileSync(path)); } catch { walk(path); } } };
  walk(root);
  return `${git(root, 'rev-parse', 'HEAD')} ${git(root, 'status', '--porcelain', '--ignored')} ${hash.digest('hex')}`;
}

async function seedHold(engine: BrainEngine, slug: string, side: string): Promise<void> {
  const [page] = await engine.executeRaw<{ id: string; revision: string; incarnation: string }>(`SELECT p.id::text AS id, p.knowledge_revision::text AS revision,
    s.incarnation::text AS incarnation FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.source_id='default' AND p.slug=$1`, [slug]);
  await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation: page!.incarnation, path: `${slug}.md`, source_path: `${slug}.md`, slug,
    page_id: Number(page!.id), code: 'file_drift', message: `${slug}.md is held: file drift`, upstream_version: null, observed_at: new Date().toISOString(),
    run_id: null, mode: 'managed', meta: { recovery_version: RECOVERY_VERSION, page_revision: page!.revision, sides: side, side, drift_version: FILE_DRIFT_VERSION } as never }));
}

const names = (n: number, prefix = 'notes/n') => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(2, '0')}`);
/** The committed pages a fixture starts from: notes/n00.., plus notes/newer-page and notes/protected when asked. */
const setup = (n: number, extra: string[] = []) => ({ root }: { root: string }) => {
  git(root, 'init', '-q');
  files(root, Object.fromEntries([...names(n), ...extra].map(slug => [slug, doc(slug, `The committed body of ${slug}.`)])));
  commitAll(root, 'pages');
};
/**
 * A read-only mirror whose pages changed in the database two hours ago and whose files were rewritten upstream since: each held
 * file_drift on `side` (`both` for the slugs in `both`), the file newer. notes/newer-page changed in the database after its file;
 * notes/protected carries a protected key only the database holds.
 */
async function mirrorHolds(engine: BrainEngine, root: string, slugs: string[], extra: { newerPage?: boolean; protectedPage?: boolean; both?: string[]; large?: boolean } = {}): Promise<void> {
  expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
  const all = [...slugs, ...(extra.newerPage ? ['notes/newer-page'] : []), ...(extra.protectedPage ? ['notes/protected'] : [])];
  await coordinated(engine, "UPDATE pages SET compiled_truth='An old database body.', updated_at=now() - interval '2 hours' WHERE source_id='default' AND slug = ANY($1::text[])", [all]);
  if (extra.protectedPage) await coordinated(engine, `UPDATE pages SET frontmatter = frontmatter || '{"captured_at": "2026-01-01T00:00:00Z"}'::jsonb, updated_at=now() - interval '2 hours'
    WHERE source_id='default' AND slug='notes/protected'`);
  files(root, Object.fromEntries(all.map(slug => [slug, doc(slug, `A newer file body of ${slug}.\n\nWith a second paragraph.${extra.large ? Array.from({ length: 800 }, (_, n) => `\n\nLine ${n} of a long upstream page.`).join('') : ''}`)])));
  commitAll(root, 'upstream rewrites');
  if (extra.newerPage) await coordinated(engine, "UPDATE pages SET compiled_truth='A newer database body.', updated_at=now() + interval '1 minute' WHERE source_id='default' AND slug='notes/newer-page'");
  await coordinated(engine, "DELETE FROM op_checkpoints WHERE op='sync-import-provenance'");
  await coordinated(engine, "UPDATE pages SET knowledge_revision=gen_random_uuid(), revision_write_request_id=NULL WHERE source_id='default'");
  await engine.executeRaw(`UPDATE sources SET config = config || '{"mirror_read_only": true}'::jsonb WHERE id='default'`);
  for (const slug of all) await seedHold(engine, slug, extra.both?.includes(slug) ? 'both' : 'unknown');
}

afterEach(() => { classWindow.pages = 200; });

describe.each(testBackends())('whole-class file-drift on a read-only mirror (%s)', backend => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('B1: a held side-unknown or both page whose file is newer is listed prefer_file by the window preview, not no_drift', () => managedBrain(async ({ engine, root }) => {
    await mirrorHolds(engine, root, names(3), { both: ['notes/n02'] });
    expect(classes(await windowPreview(engine, { held: true, side: 'unknown', prefer: 'file' }))).toEqual({ 'notes/n00': 'prefer_file', 'notes/n01': 'prefer_file' });
    expect(classes(await windowPreview(engine, { held: true, side: 'both', prefer: 'file' }))).toEqual({ 'notes/n02': 'prefer_file' });
    expect(git(root, 'status', '--porcelain')).toBe('');
  }, { databaseUrl, setup: setup(3) }), 300_000);

  test('the preview walks every window into one manifest whose totals equal the per-window sums, with no apply command until it completes', () => managedBrain(async ({ engine, root }) => {
    await mirrorHolds(engine, root, names(5), { newerPage: true, protectedPage: true });
    const single = await windowPreview(engine, { held: true, side: 'unknown', prefer: 'file' }) as unknown as { listing: Array<{ class: string }>; details: { lost_lines_total: number } };
    classWindow.pages = 3;
    const stopped = await preview(engine, 'unknown', { deadline: Date.now() });
    expect(stopped.class_manifest!.complete).toBe(false);
    expect(stopped.apply_command).toBeUndefined();
    expect(stopped.card).toBeUndefined();
    expect(stopped.resume_command).toContain('--whole-class --cursor c1.');
    expect(JSON.parse(readFileSync(stopped.class_manifest!.path, 'utf8')).complete).toBe(false);
    const cursor = stopped.resume_command!.split('--cursor ')[1]!.trim();
    const done = await preview(engine, 'unknown', { cursor });
    const m = done.class_manifest!;
    expect(Object.keys(m).sort()).toEqual(['complete', 'hash', 'lost_lines_total', 'pages', 'path', 'residual', 'top']);
    expect(m.complete).toBe(true);
    const manifest = JSON.parse(readFileSync(m.path, 'utf8'));
    expect(manifest.windows).toBe(3);
    expect([manifest.mirror, manifest.file_drift_version, manifest.gbrain_version.length > 0]).toEqual([true, FILE_DRIFT_VERSION, true]);
    expect(m.pages).toBe(single.listing.filter(entry => entry.class === 'prefer_file').length);
    expect(m.pages).toBe(5);
    expect(m.lost_lines_total).toBe(single.details.lost_lines_total);
    expect([m.residual.kept_newer_page.count, m.residual.kept_protected_parts.count]).toEqual([1, 1]);
    expect(m.top[0]!.lost_lines).toBeGreaterThan(0);
    expect(done.apply_command).toContain(`--whole-class --apply --expect ${m.hash} --yes`);
    expect(done.card!.join('\n')).toContain('gbrain revert');
    expect(existsSync(stopped.class_manifest!.path)).toBe(false);
    const fresh = await preview(engine);
    expect(fresh.class_manifest!.hash).toBe(m.hash);
  }, { databaseUrl, setup: setup(5, ['notes/newer-page', 'notes/protected']) }), 300_000);

  test('class_capacity_exceeded names the bytes and the limit and writes nothing', () => managedBrain(async ({ engine, root }) => {
    await mirrorHolds(engine, root, names(3), { large: true });
    const first = (await preview(engine)).class_manifest!;
    const needed = JSON.parse(readFileSync(first.path, 'utf8')).backup_bytes as number;
    unlinkSync(first.path);
    await engine.setConfig('persistence.limits.brain_recovery_bytes', String(needed - 1));
    const error: any = await preview(engine).then(() => null, e => e);
    expect(error?.code).toBe('class_capacity_exceeded');
    expect(error.message).toContain('persistence.limits.brain_recovery_bytes');
    expect(error.fix.argv).toEqual(['gbrain', 'config', 'get', 'persistence.limits.brain_recovery_bytes']);
    const dir = artifactDirectory();
    expect(existsSync(dir) ? readdirSync(dir).filter(name => name.startsWith('class-')) : []).toEqual([]);
  }, { databaseUrl, setup: setup(3) }), 300_000);

  test('kept_protected_parts: the page stays held with its protected parts as stored through two syncs, and the checkout byte-identical', () => managedBrain(async ({ engine, ctx, root }) => {
    await mirrorHolds(engine, root, names(1), { protectedPage: true });
    const before = checkout(root);
    const m = (await preview(engine)).class_manifest!;
    expect([m.pages, m.residual.kept_protected_parts.count]).toEqual([1, 1]);
    const window = await windowPreview(engine, { held: true, side: 'unknown', prefer: 'file' });
    expect(classes(window)['notes/protected']).toBe('kept_protected_parts');
    await performManagedSync(engine, OPTS);
    await performManagedSync(engine, OPTS);
    const held = (await holdRows(engine)).find(h => h.path === 'notes/protected.md')!;
    expect([held.code, held.meta.side]).toEqual(['file_drift', 'unknown']);
    const [page] = await engine.executeRaw<{ fm: Record<string, unknown>; b: string }>("SELECT frontmatter AS fm, compiled_truth AS b FROM pages WHERE slug='notes/protected'");
    expect(page!.fm.captured_at).toBe('2026-01-01T00:00:00Z');
    expect(page!.b).toBe('An old database body.');
    expect(checkout(root)).toBe(before);
  }, { databaseUrl, setup: setup(1, ['notes/protected']) }), 300_000);

  test('a remote caller cannot reach --whole-class: the preview refuses before reading anything', () => managedBrain(async ({ engine, ctx }) => {
    const scope = await resolveRepairScope(engine, 'default');
    expect(((await previewFileDriftClass(engine, scope, sel(), { remote: true }).then(() => null, e => e)) as any)?.code).toBe('permission_denied');
    expect(((await previewFileDriftClass(engine, scope, sel()).then(() => null, e => e)) as any)?.code).toBe('permission_denied');
  }, { databaseUrl }), 120_000);

  test('a repo-less brain has no held pages: the preview says so and refuses nothing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-whole-class-'));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
        try {
          expect((await engine.executeRaw<{ local_path: string | null }>("SELECT local_path FROM sources WHERE id='default'"))[0]?.local_path ?? null).toBeNull();
          expect(await preview(engine)).toEqual({ none: true, other: {} });
        } finally { await close(); }
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 120_000);
});
