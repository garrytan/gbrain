/**
 * #9711: a held file_drift page of a read-only mirror whose source root is a folder inside its repository (slugs carry
 * that folder as a prefix, `slug_root_mode: git-root`). The page publishes database-only, so:
 *   - `repair file-drift --slug <slug> --prefer file`, the command the hold's own fix names, read it as no_drift
 *     (database_only) and planned nothing, while `--held` compared it through the hold's file;
 *   - the comparison (`--slug` with no --prefer) also read no_drift, and rendering it crashed on `page.exceptions`.
 * Protects: a page named by --slug on a mirror is compared through its hold, exactly as --held compares it, and the
 * comparison renders. Real PGLite, real managed syncs and real Git.
 */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { fileDriftRepair } from '../src/core/repair/file-drift.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const logger = { info() {}, warn() {}, error() {} };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const SLUG = 'brain/product/x-example';
const preview = async (engine: BrainEngine, opts: Record<string, unknown>) => (await repairRunner(engine, { apply: false, logger }))
  .run('file-drift', await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default', ...opts });
const classes = (plan: Awaited<ReturnType<typeof preview>>) => (plan.listing ?? []).map(entry => [entry.item, entry.class]);

test('a comparison renders its pages, which carry no exceptions', () => {
  const details = { compare: true, writes: 'none', pages: [{ slug: SLUG, would: 'needs_human', why: 'a person decides' }], next_actions: ['Decide with the user which side wins.'] };
  expect(fileDriftRepair.render!(details as never, { diff: false })).toContain('  Decide with the user which side wins.');
});

test('a held page of a prefixed read-only mirror previews the same by --slug as by --held, and its comparison renders', () => managedBrain(async ({ engine, ctx, root }) => {
  expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
  expect((await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id='default'")).map(row => row.slug)).toEqual([SLUG]);
  await engine.executeRaw(`UPDATE sources SET config = config || '{"mirror_read_only": true}'::jsonb WHERE id='default'`);
  const snapshot = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!;
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug: SLUG, request_id: randomUUID(), expected_revision: snapshot.revision,
    content: '---\ntype: concept\ntitle: X\n---\n\nThe committed body.\n\nA line written to the database.\n' } });
  appendFileSync(join(root, 'brain/product/x-example.md'), '\nA line committed upstream.\n');
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'upstream edit');
  const synced = await performManagedSync(engine, OPTS);
  const hold = (synced.held ?? []).find(entry => entry.slug === SLUG)!;
  expect(hold).toMatchObject({ path: 'product/x-example.md', code: 'file_drift', side: 'both' });
  expect(hold.fix?.argv).toEqual(['gbrain', 'repair', 'file-drift', '--source', 'default', '--slug', SLUG, '--prefer', 'file']);

  const held = await preview(engine, { held: true, prefer: 'file' });
  const bySlug = await preview(engine, { slugs: [SLUG], prefer: 'file' });
  expect(classes(held)).not.toContainEqual([`default:${SLUG}`, 'no_drift']);
  expect(classes(bySlug)).toEqual(classes(held));

  const compared = await preview(engine, { slugs: [SLUG] });
  expect(classes(compared)).not.toContainEqual([`default:${SLUG}`, 'no_drift']);
  expect(() => fileDriftRepair.render!(compared.details as never, { diff: false })).not.toThrow();
}, { sourceDir: 'brain', setup: async ({ engine, root }) => {
  mkdirSync(join(root, 'brain/product'), { recursive: true }); git(root, 'init', '-q');
  writeFileSync(join(root, 'README.md'), '# repository\n');
  writeFileSync(join(root, 'brain/product/x-example.md'), '---\ntype: concept\ntitle: X\n---\n\nThe committed body.\n');
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'pages');
  await engine.executeRaw(`UPDATE sources SET config = config || '{"slug_root_mode": "git-root"}'::jsonb WHERE id='default'`);
} }), 300_000);
