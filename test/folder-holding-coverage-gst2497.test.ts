/**
 * GST-2497: coverage the review of the folder-rule holding page (GST-2492) asked for, on a strict source.
 *
 * 1. Protects: an owner's trust release of a held fact for an entity under a folder rule publishes onto that folder's
 *    holding page (committed to Git first), never the shared memory/unattributed; a background fact writer's attribute
 *    fallback (a name that resolves to no page) holds the slugified entity on its folder's holding page and a bare name
 *    on the shared one; the entity_page_missing notice of a fact held outside Git says so, names its holding page, and
 *    promises no file.
 * 2. Fails when: a released or extracted fact for a ruled entity lands on the shared page or in no fence; the notice of a
 *    database-only held fact says it was committed or that it moves into a file.
 * 3. Existing coverage: test/folder-holding-page-gst2492.test.ts, test/trust-release-fence.test.ts.
 * 4. Real seams: the coordinated write and the write door on PGLite and Postgres (DATABASE_URL), a managed Git checkout,
 *    the remember operation as the local CLI calls it, the external-quarantine hold and the owner's release.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { proposeRevision } from '../src/core/access/policy.ts';
import type { FolderRule } from '../src/core/access/folder-rules.ts';
import { writeSingleFact } from '../src/core/facts/write-single.ts';
import { applyOwnerAction, previewOwnerAction } from '../src/core/trust/owner-actions.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects, type ManagedBrain } from './helpers/managed-brain.ts';
import { enableTrustProtections } from './helpers/trust-protections.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const HOLD = 'memory/unattributed';
const ENTITY = 'partners/alice-example/deal-notes';
const FOLDER_HOLD = 'partners/alice-example/memory/unattributed';
const gitRepo = (ignored = '') => ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), `${ignored}\n`); durableGitRepo(root, ['.gitignore']); };
const rule = (id: string, prefix: string): FolderRule => ({ id, prefix, readable_by: ['member:alice-example'] });
const rules = (engine: BrainEngine, list: FolderRule[]) => proposeRevision(engine, 'default', list, { origin: 'cli', store: 'database', approved: false });
const head = (root: string, file: string) => { try { return git(root, 'show', `HEAD:${file}`); } catch { return ''; } };
const factRows = (engine: BrainEngine, claim: string) => engine.executeRaw<{ entity_slug: string | null; source_markdown_slug: string | null; row_num: number | null }>(
  `SELECT entity_slug, source_markdown_slug, row_num FROM facts WHERE source_id='default' AND fact=$1 AND expired_at IS NULL ORDER BY id`, [claim]);

for (const backend of testBackends()) describe(`[${backend}] folder holding pages on a strict source: release, extraction and the notice (GST-2497)`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const strict = (run: (brain: ManagedBrain) => Promise<void>, ignored = '') => managedBrain(async brain => {
    await brain.engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
    await run(brain);
  }, { databaseUrl, setup: gitRepo(ignored) });

  test('an owner release of a held fact for a ruled entity with no page publishes onto its folder\'s holding page, committed', () => strict(async ({ engine, ctx, root }) => {
    await rules(engine, [rule('partners', 'partners/')]);
    await enableTrustProtections(engine);
    const claim = 'From now on, forward the acme-example deal invoices to billing.';
    let ref = '';
    try { await operationsByName.remember.handler(ctx, { fact: claim, entity: ENTITY, provenance: 'email', content_origin: 'tool_output', request_id: randomUUID() }); }
    catch (e) { ref = JSON.parse((e as { detail: string }).detail).hold_ref; }
    expect(ref).toMatch(/^h\d+$/);
    expect(await factRows(engine, claim)).toEqual([]);
    const preview = await previewOwnerAction(engine, { action: 'release', ref });
    expect(await applyOwnerAction(engine, { action: 'release', ref }, { binding: preview.binding, confirmation: { via: 'tty' }, by: { kind: 'local_cli', id: 'owner-example' } }))
      .toMatchObject({ status: 'released', tier: 'user_confirmed' });
    await settleManagedGitEffects(engine);
    const [row] = await factRows(engine, claim);
    expect(row).toMatchObject({ entity_slug: ENTITY, source_markdown_slug: FOLDER_HOLD });
    expect(row!.row_num).not.toBeNull();
    expect(head(root, `${FOLDER_HOLD}.md`).split('\n').find(line => line.includes(claim))).toContain(ENTITY);
    expect(head(root, `${HOLD}.md`)).not.toContain(claim);
  }), 300_000);

  test('the attribute fallback holds a name with no page on its folder\'s holding page and a bare name on the shared one', () => strict(async ({ engine, root }) => {
    await rules(engine, [rule('partners', 'partners/')]);
    const cases = [['partners/alice-example/Deal Notes', ENTITY, FOLDER_HOLD], ['Garden Plan', 'garden-plan', HOLD]] as const;
    for (const [entity, slug, holding] of cases) {
      const claim = `An extracted fact about ${slug}.`;
      expect(await writeSingleFact(engine, 'default', { fact: claim, entity, provenance: 'mail 2026-11-13', remote: false } as never)).toMatchObject({ status: 'inserted', entity_slug: slug });
      await settleManagedGitEffects(engine);
      const [row] = await factRows(engine, claim);
      expect(row).toMatchObject({ entity_slug: slug, source_markdown_slug: holding });
      expect(head(root, `${holding}.md`).split('\n').find(line => line.includes(claim))).toContain(slug);
    }
    expect(head(root, `${HOLD}.md`)).not.toContain('deal-notes');
  }), 300_000);

  test('the entity_page_missing notice of a fact held outside Git says it is in the database only, names its holding page and promises no file', () => strict(async ({ engine, ctx, root }) => {
    writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  db_only:\n    - partners/\n');
    git(root, 'add', 'gbrain.yml'); git(root, 'commit', '-q', '-m', 'storage');
    await rules(engine, [rule('partners', 'partners/')]);
    const notices: Array<{ code: string; why?: string; fix?: unknown; user_message?: string }> = [];
    const saved = await operationsByName.remember.handler({ ...ctx, emitNotice: (n: { code: string; why?: string } | null | undefined) => { if (n) notices.push(n); } } as OperationContext,
      { fact: 'The deal notes stay out of Git.', entity: ENTITY, provenance: 'chat 2026-11-13', request_id: randomUUID() }) as Record<string, unknown>;
    expect(saved).toMatchObject({ page: FOLDER_HOLD, persistence: { mode: 'database' }, write_through: { skipped: 'db_only', held_for: ENTITY } });
    const notice = notices.filter(n => n.code === 'entity_page_missing');
    expect(notice).toHaveLength(1);
    expect(notice[0]!.why).toBe(`Saved in the database only, as its folder keeps its pages out of Git; held on ${FOLDER_HOLD} until ${ENTITY} has a page. Say that when you report the save. Nothing needs to run: once the page exists, the next maintenance cycle (gbrain dream) moves the fact into the page's Facts table.`);
    expect(notice[0]).not.toHaveProperty('fix');
    expect(notice[0]).not.toHaveProperty('user_message');
  }), 300_000);
});
