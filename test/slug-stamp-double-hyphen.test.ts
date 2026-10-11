/**
 * #5966 (W14 P1.7): a slug that is not a `slugifyPath` fixed point (`x/a--b`:
 * the path `x/a--b.md` derives `x/a-b`) must carry a `slug:` stamp in every
 * rendered file, or no path-derived reader (sync, reconcile, repair) can find
 * the page again. The stamp is digest-neutral: `parseMarkdown` drops
 * `frontmatter.slug`, so canonical fields compare equal with or without it.
 * `repair frontmatter` proposes the stamp as a SAFE candidate only when the
 * file sits at the page's recorded `source_path` and no other page claims it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseMarkdown, serializePageToMarkdown } from '../src/core/markdown.ts';
import type { Page } from '../src/core/types.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resolveRepairScope, type RepairResult } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import type { FrontmatterPreviewDetails } from '../src/core/repair/frontmatter.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const page = (slug: string, frontmatter: Record<string, unknown> = {}): Page => ({
  id: 1, slug, type: 'note', title: 'Double', frontmatter, compiled_truth: 'Body.', timeline: '',
  created_at: new Date(), updated_at: new Date(), source_id: 'default',
} as unknown as Page);

describe('serializePageToMarkdown stamps a slug the path cannot derive', () => {
  test('x/a--b renders slug: x/a--b and reads back as itself; a fixed-point slug gets no stamp', () => {
    const md = serializePageToMarkdown(page('x/a--b'), []);
    expect(md).toContain('slug: x/a--b');
    expect(parseMarkdown(md, 'x/a--b.md').slug).toBe('x/a--b');
    expect(parseMarkdown(md, 'x/a--b.md', { validate: true, expectedSlug: 'x/a--b' }).errors ?? []).toEqual([]);
    expect(serializePageToMarkdown(page('x/a-b'), [])).not.toContain('slug:');
  });
  test('the stamp is digest-neutral: canonical fields parse the same with and without it', () => {
    const stamped = parseMarkdown(serializePageToMarkdown(page('x/a--b'), ['t']), 'x/a--b.md');
    const plain = parseMarkdown(serializePageToMarkdown(page('x/a-b'), ['t']), 'x/a-b.md');
    expect(stamped.frontmatter).toEqual(plain.frontmatter);
    expect(stamped.frontmatter.slug).toBeUndefined();
    expect([stamped.title, stamped.type, stamped.tags, stamped.compiled_truth]).toEqual([plain.title, plain.type, plain.tags, plain.compiled_truth]);
  });
  test('a legacy frontmatter slug that names another identity is replaced by the page slug (export rule)', () => {
    const md = serializePageToMarkdown(page('people/jane-doe', { slug: 'people/Jane Doe' }), []);
    expect(md).toContain('slug: people/jane-doe');
    expect(md).not.toContain('Jane Doe');
  });
  test('a render without a slug (a managed import of a new file builds its page from the parsed file) is left alone, never stamped undefined', () => {
    const md = serializePageToMarkdown({ ...page('x/a--b'), slug: undefined as unknown as string }, []);
    expect(md).not.toContain('slug');
    expect(parseMarkdown(md, 'x/a--b.md').title).toBe('Double');
  });
});

const backends = testBackends();
const home = mkdtempSync(join(tmpdir(), 'gbrain-slug-stamp-'));
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env }).trim();
const quiet = { info() {}, warn() {}, error() {} };
const localCtx = (engine: BrainEngine, sourceId: string): OperationContext => ({ engine, remote: false, sourceId } as OperationContext);
const details = (result: RepairResult) => result.details as unknown as FrontmatterPreviewDetails;

for (const kind of backends) describe(`repair frontmatter stamps a legacy unstamped -- file (${kind})`, () => {
  let engine: BrainEngine, close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
  }, 120_000);
  afterAll(async () => { await withEnv(env, async () => { await disposePersistenceConsumer(engine); }); if (close) await close(); else await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

  test('a safe candidate inserts the stamp at the recorded source_path; apply re-imports the same page', () => withEnv(env, async () => {
    const id = `ss-${randomUUID().replace(/-/g, '').slice(0, 20)}`, root = join(home, id);
    mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
    git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
    writeFileSync(join(root, '.git', 'hooks', 'post-commit'), '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\n'); chmodSync(join(root, '.git', 'hooks', 'post-commit'), 0o755);
    writeFileSync(join(root, 'notes', 'ok.md'), '---\ntitle: Ok\n---\nFine.\n');
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'fixture');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
    await claimWorktree(engine, id, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    try {
      await submitPageMutation(localCtx(engine, id), { operation: 'put_page', params: { slug: 'notes/a--b', source_id: id, content: '---\ntitle: Double\n---\nTwo hyphens.\n' } });
      const written = readFileSync(join(root, 'notes', 'a--b.md'), 'utf8');
      expect(written).toContain('slug: notes/a--b');
      // A file an earlier gbrain rendered without the stamp.
      const legacy = written.split('\n').filter(line => line !== 'slug: notes/a--b').join('\n');
      writeFileSync(join(root, 'notes', 'a--b.md'), legacy);
      git(root, 'add', '-A'); git(root, 'commit', '-qm', 'legacy unstamped render');

      const runner = await repairRunner(engine, { apply: false, noEmbed: true, logger: quiet });
      const preview = await runner.run('frontmatter', await resolveRepairScope(engine, id), { explicit: true, sourceFlag: id });
      expect(preview).toMatchObject({ mode: 'dry_run', affected: 1 });
      expect(details(preview).counts).toMatchObject({ safe: 1, interpretive: 0, needs_review: 0 });
      expect(details(preview).samples.safe!.diff).toContain('+slug: notes/a--b');
      expect(details(preview).diffs[0]!.fixes.join(' ')).toContain('notes/a-b');
      const hash = preview.apply_command.split('--expect ')[1]!.split(' ')[0]!;
      const applier = await repairRunner(engine, { apply: true, noEmbed: true, logger: quiet });
      const applied = await applier.run('frontmatter', await resolveRepairScope(engine, id), { explicit: true, sourceFlag: id, expect: hash });
      expect(applied).toMatchObject({ applied: 1, outcomes: { repaired: 1 } });
      const repaired = readFileSync(join(root, 'notes', 'a--b.md'), 'utf8');
      expect(repaired).toContain('slug: notes/a--b');
      expect(parseMarkdown(repaired, 'notes/a--b.md').slug).toBe('notes/a--b');
      const rows = await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY slug', [id]);
      expect(rows.map(r => r.slug)).toEqual(['notes/a--b']);
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [id]);
    }
  }), 180_000);

  test.todo('P1.7 (#5966) stack hunk: sources reconcile --preview of a legacy unstamped -- file refuses with detail slug_rule_mismatch naming the repair command (reconcile-state.ts is wave-13 owned; see ~/.capy/work/w14/pr1/stack-hunks)', () => {});
});
