/**
 * #6619: a coordinated page purge left the page's `page_aliases` rows (and
 * the slug redirects resolving to it), and doctor `dangling_aliases` printed
 * raw DELETE SQL that the managed writer guard refuses (and that would also
 * have dropped the aliases of soft-deleted pages a restore still needs).
 * Purge now removes both, and `gbrain repair aliases` clears leftovers whose
 * target page row is gone, keeping soft-deleted targets and rename redirects.
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { checkDanglingAliases } from '../src/core/onboard/checks.ts';
import { resolveRepairScope, runRepair } from '../src/core/repair/core.ts';
import { aliasesRepair } from '../src/core/repair/aliases.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { durableGitRepo } from './helpers/git-publication.ts';

const gitRoot = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };

test('#6619 a coordinated purge removes the page aliases and redirects that resolve to it; a redirect away from it stays', () => managedBrain(async ({ engine, ctx }) => {
  const slug = 'concepts/probe-widget';
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(),
    content: `---\ntype: concept\ntitle: Probe Widget\naliases: ["Widget Alias One", "widget-alias-two"]\n---\n\n# Probe Widget\n\nNeutral probe page.\n` } });
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'concepts/other-widget', request_id: randomUUID(),
    content: '---\ntype: concept\ntitle: Other Widget\n---\n\n# Other Widget\n\nAnother page.\n' } });
  const before = await engine.executeRaw('SELECT alias_norm FROM page_aliases WHERE slug=$1', [slug]);
  expect(before.length).toBe(2);
  const snap = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
  const purged = await submitPageMutation(ctx, { operation: 'delete_page', params: { slug, purge: true, expected_revision: snap.revision, request_id: randomUUID() } }) as Record<string, any>;
  expect(await engine.executeRaw('SELECT alias_norm FROM page_aliases WHERE slug=$1', [slug])).toEqual([]);
  expect(await engine.executeRaw('SELECT alias_slug FROM slug_aliases WHERE canonical_slug=$1', [slug])).toEqual([]);
  expect(JSON.stringify(purged)).toContain('"page_aliases"');
  expect(await engine.executeRaw('SELECT canonical_slug FROM slug_aliases WHERE alias_slug=$1', [slug])).toEqual([{ canonical_slug: 'concepts/other-widget' }]);
  expect((await checkDanglingAliases(engine)).check.status).toBe('ok');
}, { setup: async ({ engine, root }) => {
  gitRoot({ root });
  await engine.executeRaw(`INSERT INTO slug_aliases(source_id,alias_slug,canonical_slug) VALUES
    ('default','concepts/old-probe-widget','concepts/probe-widget'),('default','concepts/probe-widget','concepts/other-widget')`);
} }), 120_000);

test('#6619 repair aliases removes orphaned aliases only; doctor names the per-source preview, never raw SQL', () => managedBrain(async ({ engine, ctx }) => {
  const scope = await resolveRepairScope(engine, 'default');
  const doctor = await checkDanglingAliases(engine);
  expect(doctor.check.status).toBe('warn');
  expect(doctor.check.message).toContain('4 alias rows');
  expect(doctor.check.message).toContain('gbrain repair aliases --source default');
  expect(doctor.check.message).toContain('soft-deleted');
  expect(doctor.check.message).not.toContain('DELETE FROM');
  expect(doctor.check.fix?.argv).toEqual(['gbrain', 'repair', 'aliases', '--source', 'default']);

  const preview = await runRepair(ctx, aliasesRepair, scope, { apply: false, explicit: true });
  expect(preview.sample).toEqual(['default:concepts/purged-example']);
  expect(preview.residuals).toEqual({ soft_deleted_target: 1 });
  const applied = await runRepair(ctx, aliasesRepair, scope, { apply: true, explicit: true });
  expect(applied.applied).toBe(1);
  const pageAliases = await engine.executeRaw<{ slug: string }>('SELECT slug FROM page_aliases ORDER BY slug');
  expect(pageAliases.map(r => r.slug)).toEqual(['concepts/kept-example', 'concepts/soft-deleted-example']);
  const redirects = await engine.executeRaw<{ alias_slug: string }>('SELECT alias_slug FROM slug_aliases ORDER BY alias_slug');
  expect(redirects.map(r => r.alias_slug)).toEqual(['concepts/purged-example']);
  const after = await checkDanglingAliases(engine);
  expect(after.check.message).toContain('1 alias rows');
  expect(after.check.message).not.toContain('gbrain repair aliases');
}, { setup: async ({ engine, root }) => {
  gitRoot({ root });
  for (const slug of ['concepts/kept-example', 'concepts/soft-deleted-example']) {
    await engine.putPage(slug, { type: 'concept', title: slug, compiled_truth: `# ${slug}`, timeline: '' }, { sourceId: 'default' });
  }
  await engine.softDeletePage('concepts/soft-deleted-example', { sourceId: 'default' });
  await engine.executeRaw(`INSERT INTO page_aliases(source_id,alias_norm,slug) VALUES ('default','kept','concepts/kept-example'),
    ('default','gone one','concepts/purged-example'),('default','gone two','concepts/purged-example'),('default','soft','concepts/soft-deleted-example')`);
  await engine.executeRaw(`INSERT INTO slug_aliases(source_id,alias_slug,canonical_slug) VALUES ('default','concepts/old-purged','concepts/purged-example'),
    ('default','concepts/purged-example','concepts/kept-example')`);
} }), 120_000);
