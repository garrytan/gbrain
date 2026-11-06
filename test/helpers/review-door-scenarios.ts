/**
 * GBRA-215 L2: extraction_review decisions through the page door, as scenarios both engines run on a
 * repository-backed source and on a repo-less one (test/extraction-review-door.serial.test.ts on PGLite,
 * test/e2e/extraction-review-door-postgres.test.ts on Postgres).
 */
import { expect } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { parseMarkdown } from '../../src/core/markdown.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { git } from './git-publication.ts';

export type ReviewStorage = 'git' | 'database';

export interface ReviewDoorFixture { storage: ReviewStorage; repo: string | null; cleanup: () => void }

export function reviewCtx(engine: BrainEngine, over: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: engine.kind } as OperationContext['config'],
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...over,
  } as OperationContext;
}

/** A durability-hardened repo with no remote (Git effects commit for real), or no repository at all. */
export async function reviewDoorFixture(engine: BrainEngine, storage: ReviewStorage): Promise<ReviewDoorFixture> {
  _resetWriteThroughCacheForTest();
  if (storage === 'database') {
    await engine.unsetConfig('sync.repo_path');
    return { storage, repo: null, cleanup: () => {} };
  }
  const repo = mkdtempSync(join(tmpdir(), 'gbrain-review-door-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Example Writer');
  git(repo, 'config', 'user.email', 'writer@example.invalid');
  writeFileSync(join(repo, 'seed.md'), 'seed\n');
  git(repo, 'add', 'seed.md'); git(repo, 'commit', '-q', '-m', 'Initial');
  mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
  writeFileSync(join(repo, '.git', 'hooks', 'post-commit'), '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\nexit 0\n');
  chmodSync(join(repo, '.git', 'hooks', 'post-commit'), 0o755);
  await engine.setConfig('sync.repo_path', repo);
  return { storage, repo, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}

/**
 * Runs persistence effects until no Git effect is queued or running. One pass is not enough when two decisions race:
 * a concurrent pass may hold an effect (or the checkout's commit lock) when this one runs, so the commit lands later.
 */
async function drain(engine: BrainEngine): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    await runPersistenceEffects(engine, { engine: engine.kind, embedding_disabled: true } as never, { hostId: localHostId(), limit: 16 });
    const [pending] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_effects WHERE kind = 'git' AND state IN ('queued','running')");
    if (!pending || Number(pending.n) === 0) return;
    if (Date.now() >= deadline) throw new Error(`${pending.n} Git effect(s) still queued or running after 15 s`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/** The file Git's HEAD holds for a slug, or null when HEAD has none. */
export function committedFile(repo: string, slug: string): string | null {
  try { return git(repo, 'show', `HEAD:${slug}.md`); } catch { return null; }
}

/** An unverified auto-extracted stub, written through the page door like any other page. */
export async function seedStub(engine: BrainEngine, slug: string, title: string): Promise<void> {
  const put = operationsByName.put_page!;
  await put.handler(reviewCtx(engine), { slug,
    content: `---\ntype: ${slug.startsWith('companies/') ? 'company' : 'person'}\ntitle: ${title}\nprovenance: auto-extracted\nstatus: unverified\n---\n\n${title} came up in a call.\n` });
  await drain(engine);
}

async function review(engine: BrainEngine, params: Record<string, unknown>): Promise<{ results: Array<{ slug: string; status: string }>; write_requests?: Array<{ slug: string; request_id: string; state: string }> }> {
  const out = await operationsByName.extraction_review!.handler(reviewCtx(engine), params) as never;
  await drain(engine);
  return out;
}

export async function promoteScenario(engine: BrainEngine, fx: ReviewDoorFixture): Promise<void> {
  const slug = `people/promote-${fx.storage}-example`;
  await seedStub(engine, slug, 'Promote Example');
  const head = fx.repo ? git(fx.repo, 'rev-parse', 'HEAD').trim() : null;
  const out = await review(engine, { action: 'promote', slugs: [slug] });
  expect(out.results).toEqual([{ slug, status: 'promoted' }]);
  expect(out.write_requests?.[0]).toMatchObject({ slug, state: 'committed' });
  const page = await engine.getPage(slug);
  expect(page!.frontmatter.status).toBe('verified');
  expect(page!.frontmatter.provenance).toBe('auto-extracted');
  expect(page!.compiled_truth).toContain('came up in a call');
  if (fx.repo) {
    expect(git(fx.repo, 'rev-parse', 'HEAD').trim()).not.toBe(head);
    const file = committedFile(fx.repo, slug)!;
    const parsed = parseMarkdown(file, `${slug}.md`);
    expect(parsed.frontmatter.status).toBe('verified');
    expect(parsed.frontmatter.provenance).toBe('auto-extracted');
    expect(file).toContain('came up in a call');
    // Rebuild from Git: drop the row and import the committed file; the owner's decision survives.
    await engine.executeRaw('DELETE FROM pages WHERE slug = $1', [slug]);
    await importFromContent(engine, slug, file);
    expect((await engine.getPage(slug))!.frontmatter.status).toBe('verified');
  }
}

export async function rejectScenario(engine: BrainEngine, fx: ReviewDoorFixture): Promise<void> {
  const slug = `people/reject-${fx.storage}-example`;
  await seedStub(engine, slug, 'Reject Example');
  if (fx.repo) expect(committedFile(fx.repo, slug)).not.toBeNull();
  const out = await review(engine, { action: 'reject', slugs: slug });
  expect(out.results).toEqual([{ slug, status: 'rejected' }]);
  expect(out.write_requests?.[0]).toMatchObject({ slug, state: 'committed' });
  expect(await engine.getPage(slug)).toBeNull();
  expect((await engine.getPage(slug, { includeDeleted: true }))?.deleted_at).toBeTruthy();
  if (fx.repo) {
    expect(committedFile(fx.repo, slug)).toBeNull();
    expect(existsSync(join(fx.repo, `${slug}.md`))).toBe(false);
  }
}

export async function distinctScenario(engine: BrainEngine, fx: ReviewDoorFixture): Promise<void> {
  const existing = `companies/acme-${fx.storage}`;
  const fresh = `companies/acmi-${fx.storage}`;
  await operationsByName.put_page!.handler(reviewCtx(engine), { slug: existing, content: `---\ntype: company\ntitle: Acme ${fx.storage}\n---\n\nAn existing company.\n` });
  await operationsByName.put_page!.handler(reviewCtx(engine), { slug: fresh, content: `---\ntype: company\ntitle: Acmi ${fx.storage}\n---\n\nA different company.\n` });
  await drain(engine);
  const pending = operationsByName.extraction_pending!;
  const before = await pending.handler(reviewCtx(engine), { include: ['possible_duplicates'] }) as { possible_duplicates: { rows: Array<{ slug: string; actions: Array<{ kind: string; argv: string[] }> }> } };
  const row = before.possible_duplicates.rows.find(r => r.slug === fresh || r.slug === existing)!;
  const mark = row.actions.find(a => a.kind === 'mark_distinct')!;
  expect(mark.argv.slice(0, 3)).toEqual(['gbrain', 'extraction-review', 'distinct']);
  const [newSlug, ofSlug] = [mark.argv[4]!, mark.argv[6]!];
  const out = await review(engine, { action: 'distinct', slugs: [newSlug], of: ofSlug });
  expect(out.results).toEqual([{ slug: newSlug, status: 'distinct' }]);
  expect((await engine.getPage(newSlug))!.frontmatter.distinct_from).toEqual([ofSlug]);
  const again = await review(engine, { action: 'distinct', slugs: [newSlug], of: ofSlug });
  expect(again.results).toEqual([{ slug: newSlug, status: 'already_distinct' }]);
  expect(again.write_requests).toBeUndefined();
  const after = await pending.handler(reviewCtx(engine), { include: ['possible_duplicates'] }) as { possible_duplicates: { rows: Array<{ slug: string }> } };
  expect(after.possible_duplicates.rows.map(r => r.slug)).not.toContain(newSlug);
  expect(after.possible_duplicates.rows.map(r => r.slug)).not.toContain(ofSlug);
  if (fx.repo) expect(parseMarkdown(committedFile(fx.repo, newSlug)!, `${newSlug}.md`).frontmatter.distinct_from).toEqual([ofSlug]);
}

/** Promote and reject of one stub raced: the guard orders them, so exactly one decision lands. */
export async function racedDecisionsScenario(engine: BrainEngine, fx: ReviewDoorFixture): Promise<void> {
  const slug = `people/race-${fx.storage}-example`;
  await seedStub(engine, slug, 'Race Example');
  const [a, b] = await Promise.all([
    review(engine, { action: 'promote', slugs: [slug] }),
    review(engine, { action: 'reject', slugs: [slug] }),
  ]);
  await drain(engine);
  const statuses = [a.results[0]!.status, b.results[0]!.status].sort();
  expect([['not_found', 'rejected'], ['not_unverified', 'promoted']]).toContainEqual(statuses);
  const page = await engine.getPage(slug);
  if (statuses.includes('promoted')) expect(page!.frontmatter.status).toBe('verified');
  else expect(page).toBeNull();
  if (fx.repo) {
    const file = committedFile(fx.repo, slug);
    if (statuses.includes('promoted')) expect(parseMarkdown(file!, `${slug}.md`).frontmatter.status).toBe('verified');
    else expect(file).toBeNull();
  }
}
