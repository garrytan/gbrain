/**
 * #9737 `gbrain pages prune-history`: the owner removes chosen saved versions from pages' history, preview first.
 *
 * 1. Protects: text taken out of a page stops being readable in get_versions once the owner prunes the versions that
 *    hold it; --keep / --older-than bound history that jobs rewrite; the live page never changes; the preview changes
 *    nothing and names the exact versions with a plan_hash; an apply needs --yes and that hash, and a plan that moved
 *    since the preview refuses preview_changed with nothing deleted; agent_policy pages, soft-deleted pages and other
 *    pages keep every version; the prune records the history gap; no operation (MCP or HTTP) reaches it.
 * 2. Fails when: a removed sentence survives in get_versions after an approved prune, the preview deletes anything,
 *    an apply runs without the hash or with a stale one, or a version outside the plan is deleted.
 * 3. Repo-less brains (in-memory PGLite; Postgres too when DATABASE_URL is set). The command reads and writes the
 *    database only, so a repo-backed brain runs the same path.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, operationsByName, type OperationContext } from '../src/core/operations.ts';
import { createPageVersion } from '../src/core/page-state/versions.ts';
import { applyHistoryPrune, planHistoryPrune } from '../src/core/page-state/history-prune.ts';
import { runPages } from '../src/commands/pages.ts';
import { CLI_COMMANDS } from '../src/cli/command-table.ts';
import { _resetCliExitVerdictForTests, currentExitCode, setStdoutCapture } from '../src/core/cli-force-exit.ts';
import { AGENT_POLICY_TYPE } from '../src/core/policy/slugs.ts';
import { asOwner } from './helpers/owner-tier.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const SECRET = 'The launch date is the ninth.';

for (const kind of testBackends()) {
  describe(`pages prune-history (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
    }, 120_000);
    afterAll(async () => { await close(); });

    const put = (slug: string, body: string, type = 'note') => asOwner(engine, tx => tx.putPage(slug, { type, title: slug, compiled_truth: body }));
    /** One saved version per rewrite, the way a write versions its preimage. */
    async function history(slug: string, bodies: string[], type = 'note'): Promise<number> {
      const page = await put(slug, bodies[0]!, type);
      for (const body of bodies.slice(1)) { await createPageVersion(engine, slug, 'default'); await put(slug, body, type); }
      return page.id;
    }
    const ctx = { config: { engine: 'pglite' }, sourceId: 'default', remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
    const versions = (slug: string) => operationsByName.get_versions!.handler({ ...ctx, engine } as unknown as OperationContext,
      { slug, include_body: true, limit: 100 }) as Promise<Array<{ id: number; compiled_truth: string }>>;
    const count = async (slug: string) => (await versions(slug)).length;
    async function cli(args: string[]): Promise<{ doc: Record<string, unknown>; exit: number }> {
      const out: string[] = [];
      _resetCliExitVerdictForTests();
      const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; }) as never);
      const err = spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
      setStdoutCapture(text => { out.push(text); });
      try { await runPages(engine, ['prune-history', ...args, '--json']); } finally { setStdoutCapture(null); write.mockRestore(); err.mockRestore(); }
      const exit = currentExitCode();
      _resetCliExitVerdictForTests();
      process.exitCode = 0;
      return { doc: JSON.parse(out.join('')) as Record<string, unknown>, exit };
    }

    test('#9737 repro: removed text stays in get_versions until the owner prunes it; the prune removes it and leaves the page alone', async () => {
      const slug = `notes/example-page-${kind}`;
      const pageId = await history(slug, [`Intro. ${SECRET}`, 'Intro, rewritten once.', 'Intro, rewritten twice.']);
      expect((await versions(slug)).some(v => v.compiled_truth.includes(SECRET))).toBe(true);

      const preview = await cli([slug, '--keep', '1']);
      expect(preview.exit).toBe(0);
      expect(preview.doc).toMatchObject({ dry_run: true, totals: { pages: 1, versions: 1 } });
      const pages = preview.doc.pages as Array<{ slug: string; versions_pruned: number; versions_kept: number; version_ids: number[] }>;
      expect(pages).toEqual([expect.objectContaining({ slug, versions_pruned: 1, versions_kept: 1 })]);
      const hash = String(preview.doc.plan_hash);
      expect(hash).toMatch(/^ph_[0-9a-f]{24}$/);
      expect(preview.doc.apply).toEqual(['gbrain', 'pages', 'prune-history', slug, '--keep', '1', '--yes', '--expect', hash]);
      expect(await count(slug)).toBe(2);

      expect((await cli([slug, '--keep', '1', '--yes'])).exit).toBe(2);
      expect((await cli([slug, '--keep', '1', '--expect', hash])).exit).toBe(2);
      expect((await cli([slug, '--keep', '1', '--yes', '--expect', hash, '--dry-run'])).doc.dry_run).toBe(true);
      const stale = await cli([slug, '--keep', '1', '--yes', '--expect', 'ph_000000000000000000000000']);
      expect(stale.exit).toBe(1);
      expect(stale.doc).toMatchObject({ error: 'preview_changed', fix: { argv: ['gbrain', 'pages', 'prune-history', slug, '--keep', '1', '--json'] } });
      expect(await count(slug)).toBe(2);

      const applied = await cli([slug, '--keep', '1', '--yes', '--expect', hash]);
      expect(applied.exit).toBe(0);
      expect(applied.doc).toMatchObject({ dry_run: false, plan_hash: hash, pruned: { pages: 1, versions: 1 } });
      const left = await versions(slug);
      expect(left).toHaveLength(1);
      expect(left.some(v => v.compiled_truth.includes(SECRET))).toBe(false);
      expect(left[0]!.id).toBe(Math.max(...pages[0]!.version_ids) + 1);
      const [page] = await engine.executeRaw<{ compiled_truth: string; gap: unknown }>('SELECT compiled_truth, version_history_gap_at AS gap FROM pages WHERE id = $1', [pageId]);
      expect(page!.compiled_truth).toBe('Intro, rewritten twice.');
      expect(page!.gap).not.toBeNull();
      expect((await cli([slug, '--keep', '1'])).doc).toMatchObject({ totals: { versions: 0 } });
    });

    test('--version names exact versions of one page; a write after the preview changes the plan and the stale apply deletes nothing', async () => {
      const slug = `notes/exact-${kind}`;
      await history(slug, ['a', 'b', 'c', 'd']);
      const ids = (await versions(slug)).map(v => v.id).sort((x, y) => x - y);
      const one = await cli([slug, '--version', String(ids[1])]);
      expect((one.doc.pages as Array<{ version_ids: number[] }>)[0]!.version_ids).toEqual([ids[1]]);
      const preview = await cli([slug, '--keep', '1']);
      await createPageVersion(engine, slug, 'default');
      await put(slug, 'e');
      const stale = await cli([slug, '--keep', '1', '--yes', '--expect', String(preview.doc.plan_hash)]);
      expect(stale.doc.error).toBe('preview_changed');
      expect(await count(slug)).toBe(4);
      const before = (await versions(slug)).map(v => v.id).sort((x, y) => x - y);
      const exact = await cli([slug, '--version', String(ids[1]), '--yes', '--expect', String(one.doc.plan_hash)]);
      expect(exact.doc).toMatchObject({ pruned: { versions: 1 } });
      expect((await versions(slug)).map(v => v.id).sort((x, y) => x - y)).toEqual(before.filter(id => id !== ids[1]));
    });

    test('--older-than combines with --keep; a prefix touches only its pages; agent_policy and deleted pages keep every version', async () => {
      const prefix = `jobs-${kind}/`;
      const jobId = await history(`${prefix}report`, ['r1', 'r2', 'r3', 'r4']);
      await history(`other-${kind}/report`, ['o1', 'o2', 'o3']);
      await engine.executeRaw("UPDATE page_versions SET snapshot_at = now() - interval '40 days' WHERE page_id = $1 AND id = (SELECT min(id) FROM page_versions WHERE page_id = $1)", [jobId]);
      const old = await planHistoryPrune(engine, { prefix, keep: 1, olderThanHours: 30 * 24 });
      expect(old.pages.map(p => [p.slug, p.versions_pruned])).toEqual([[`${prefix}report`, 1]]);
      const recent = await planHistoryPrune(engine, { prefix, keep: 1 });
      expect(recent.totals.versions).toBe(2);
      expect(recent.plan_hash).not.toBe(old.plan_hash);

      await history(`policy-${kind}/rules`, ['p1', 'p2', 'p3'], AGENT_POLICY_TYPE);
      await history(`gone-${kind}/page`, ['g1', 'g2', 'g3']);
      await engine.executeRaw('UPDATE pages SET deleted_at = now() WHERE slug = $1', [`gone-${kind}/page`]);
      const all = await planHistoryPrune(engine, { all: true, keep: 0 });
      const slugs = all.pages.map(p => p.slug);
      expect(slugs).not.toContain(`policy-${kind}/rules`);
      expect(slugs).not.toContain(`gone-${kind}/page`);
      expect(all.kept_by_rule.agent_policy_pages).toBeGreaterThanOrEqual(1);

      const applied = await cli(['--prefix', prefix, '--keep', '1', '--older-than', '30d', '--yes', '--expect', old.plan_hash]);
      expect(applied.doc).toMatchObject({ pruned: { pages: 1, versions: 1 } });
      expect(await count(`${prefix}report`)).toBe(2);
      expect(await count(`other-${kind}/report`)).toBe(2);
    });

    test('a slug in two sources needs --source; a page renamed after the preview keeps its history', async () => {
      const slug = `notes/shared-${kind}`;
      const other = `source-b-${kind}`;
      await engine.executeRaw('INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, NULL, $2::jsonb)', [other, '{}']);
      await history(slug, ['s1', 's2', 's3']);
      await asOwner(engine, tx => tx.putPage(slug, { type: 'note', title: slug, compiled_truth: 'b1' }, { sourceId: other }));
      for (const body of ['b2', 'b3']) {
        await createPageVersion(engine, slug, other);
        await asOwner(engine, tx => tx.putPage(slug, { type: 'note', title: slug, compiled_truth: body }, { sourceId: other }));
      }
      const both = await cli([slug, '--keep', '0']);
      expect(both.exit).toBe(2);
      expect(both.doc.plan_hash).toBeUndefined();
      const one = await cli([slug, '--keep', '0', '--source', other]);
      expect(one.exit).toBe(0);
      expect((one.doc.pages as Array<{ source_id: string }>).map(p => p.source_id)).toEqual([other]);

      const plan = await planHistoryPrune(engine, { slug, sourceId: other, keep: 0 });
      expect(plan.totals.versions).toBe(2);
      await engine.executeRaw('UPDATE pages SET slug = $1 WHERE source_id = $2 AND slug = $3', [`archive/shared-${kind}`, other, slug]);
      expect(await applyHistoryPrune(engine, plan)).toEqual({ pages: 0, versions: 0, unchanged_pages: 1 });
      const [left] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_versions pv JOIN pages p ON p.id = pv.page_id WHERE p.source_id = $1', [other]);
      expect(left!.n).toBe(2);

      const lone = `notes/lone-${kind}`;
      await history(lone, ['l1', 'l2']);
      await asOwner(engine, tx => tx.putPage(lone, { type: 'note', title: lone, compiled_truth: 'no history' }, { sourceId: other }));
      expect((await cli([lone, '--keep', '0'])).exit).toBe(2);
      expect(await count(lone)).toBe(1);
    });

    test('an approval binds where each page is and what type it has: a rename in the prefix or a type change keeps the history', async () => {
      const prefix = `moved-${kind}/`;
      await history(`${prefix}a`, ['a1', 'a2', 'a3']);
      const preview = await cli(['--prefix', prefix, '--keep', '0']);
      await engine.executeRaw('UPDATE pages SET slug = $1 WHERE slug = $2', [`${prefix}b`, `${prefix}a`]);
      const stale = await cli(['--prefix', prefix, '--keep', '0', '--yes', '--expect', String(preview.doc.plan_hash)]);
      expect(stale.doc.error).toBe('preview_changed');
      expect(await count(`${prefix}b`)).toBe(2);

      const typed = await planHistoryPrune(engine, { prefix, type: 'note', keep: 0 });
      expect(typed.totals.versions).toBe(2);
      await engine.executeRaw("UPDATE pages SET type = 'concept' WHERE slug = $1", [`${prefix}b`]);
      expect(await applyHistoryPrune(engine, typed)).toMatchObject({ versions: 0, unchanged_pages: 1 });
      expect(await count(`${prefix}b`)).toBe(2);
    });

    test('the selection and bounds are required, and no operation or remote caller reaches the prune', async () => {
      expect((await cli(['--keep', '1'])).exit).toBe(2);
      expect((await cli(['notes/x'])).exit).toBe(2);
      expect((await cli(['notes/x', '--all', '--keep', '1'])).exit).toBe(2);
      expect((await cli(['--all', '--version', '3'])).exit).toBe(2);
      expect((await cli(['notes/x', '--keep', 'two'])).exit).toBe(2);
      expect((await cli(['notes/x', '--keep', '1', '--force'])).exit).toBe(2);
      expect((await cli(['--prefix', '', '--keep', '0'])).exit).toBe(2);
      expect((await cli(['--prefix', '  ', '--keep', '0'])).exit).toBe(2);
      expect((await cli(['--type', '', '--keep', '0'])).exit).toBe(2);
      expect((await cli(['', '--keep', '0'])).exit).toBe(2);
      expect(operations.filter(op => op.mutating && /version|history/.test(op.name)).map(op => op.name).sort()).toEqual(['revert_version']);
      expect(CLI_COMMANDS.find(c => c.name === 'pages')?.thinClient).toBe('refuse');
    });
    test('the preview prints an apply command that pastes into a shell as the same arguments', async () => {
      await history(`notes/quoted-${kind}`, ['First.', 'Second.', 'Third.'], 'meeting notes');
      const out: string[] = [];
      _resetCliExitVerdictForTests();
      const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; }) as never);
      setStdoutCapture(text => { out.push(text); });
      try { await runPages(engine, ['prune-history', '--type', 'meeting notes', '--keep', '1']); } finally { setStdoutCapture(null); write.mockRestore(); }
      _resetCliExitVerdictForTests();
      process.exitCode = 0;
      const hash = /plan_hash: (ph_[0-9a-f]+)/.exec(out.join(''))?.[1];
      expect(out.join('')).toContain(`Apply, only after the user agrees: gbrain pages prune-history --type 'meeting notes' --keep 1 --yes --expect ${hash}`);
    });

    test('GST-4026: --keep counts segmented versions among the newest it keeps, never deletes them, and the preview reports what stays', async () => {
      const slug = `notes/segmented-${kind}`;
      const segmented = async (pageId: number) => Number((await engine.executeRaw<{ id: number | string }>(
        "INSERT INTO page_versions (page_id, compiled_truth, body_storage, body_generation) VALUES ($1, NULL, 'segmented', 1) RETURNING id", [pageId]))[0]!.id);
      const pageId = (await put(slug, 's1')).id;
      const older = await segmented(pageId);
      for (const body of ['s2', 's3', 's4']) { await createPageVersion(engine, slug, 'default'); await put(slug, body); }
      const newest = await segmented(pageId);
      const inline = (await engine.executeRaw<{ id: number | string }>("SELECT id FROM page_versions WHERE page_id = $1 AND body_storage = 'inline' ORDER BY id", [pageId])).map(r => Number(r.id));
      expect(inline).toHaveLength(3);
      const plan = await planHistoryPrune(engine, { slug, sourceId: 'default', keep: 2 });
      // The newest two are the segmented version and the newest inline one: the two older inline versions go, the older segmented one stays.
      expect(plan.pages.map(p => p.version_ids)).toEqual([inline.slice(0, 2)]);
      expect(plan.pages[0]).toMatchObject({ versions_total: 5, versions_pruned: 2, versions_kept: 3 });
      await applyHistoryPrune(engine, plan);
      const left = (await engine.executeRaw<{ id: number | string }>('SELECT id FROM page_versions WHERE page_id = $1 ORDER BY id', [pageId])).map(r => Number(r.id));
      expect(left).toEqual([older, inline[2]!, newest]);
    });

    test('GST-4026: an apply after segmented retention removed newer versions keeps what is now among the newest --keep', async () => {
      const slug = `notes/segmented-race-${kind}`;
      const segmented = async (pageId: number) => Number((await engine.executeRaw<{ id: number | string }>(
        "INSERT INTO page_versions (page_id, compiled_truth, body_storage, body_generation) VALUES ($1, NULL, 'segmented', 1) RETURNING id", [pageId]))[0]!.id);
      const pageId = (await put(slug, 'r1')).id;
      await createPageVersion(engine, slug, 'default');
      await put(slug, 'r2');
      const [inline] = (await engine.executeRaw<{ id: number | string }>("SELECT id FROM page_versions WHERE page_id = $1 AND body_storage = 'inline'", [pageId])).map(r => Number(r.id));
      const newer = [await segmented(pageId), await segmented(pageId)];
      const plan = await planHistoryPrune(engine, { slug, sourceId: 'default', keep: 2 });
      expect(plan.pages.map(p => p.version_ids)).toEqual([[inline!]]);
      // Segmented retention keeps only its newest version between the preview and the apply.
      await engine.executeRaw('DELETE FROM page_versions WHERE id = $1', [newer[0]]);
      expect(await applyHistoryPrune(engine, plan)).toEqual({ pages: 0, versions: 0, unchanged_pages: 1 });
      const left = (await engine.executeRaw<{ id: number | string }>('SELECT id FROM page_versions WHERE page_id = $1 ORDER BY id', [pageId])).map(r => Number(r.id));
      expect(left).toEqual([inline!, newer[1]!]);
    });
  });
}
