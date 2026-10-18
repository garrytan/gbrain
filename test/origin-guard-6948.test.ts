/**
 * #6948: duplicate-origin twins can no longer be written. Every write that makes
 * a page a live claimant of an origin another live page of its source records
 * (putPage, restorePage, write-through, put_page, importFile's origin refresh,
 * a rename that binds its destination path, the segmented and repair binders
 * through bindOrigin) refuses `page_identity_changed` / `origin_already_claimed`
 * and writes nothing; a write that keeps its own origin keeps working while an
 * unrelated twin exists; the legacy `<scope>/<origin>` spelling of a source-root
 * source counts as the same origin; readers and repairs pick the canonical page
 * (the slug the file derives) and refuse `origin_conflict` when none is.
 * Postgres adds the races: concurrent assignments serialize on the origin lock
 * (two spellings included), and once `pages_live_origin_key` exists a raced
 * insert's 23505 maps to the same refusal and is never read as a slug collision.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { dropOriginIndex } from './helpers/origin-index.ts';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { writePageThrough, _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { resolveSlugsForRemovedPaths } from '../src/core/sync-git.ts';
import { readFenceTarget, type FenceSource } from '../src/core/fence-repair/repair-io.ts';
import { prepareDriftPage } from '../src/core/repair/file-drift.ts';
import { isUniqueViolation, renamePageOntoSlug } from '../src/commands/sync/rename-collision.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import type { FrontmatterPreviewDetails } from '../src/core/repair/frontmatter.ts';
import * as guard from '../src/core/persistence/origin-guard.ts';

const backends = testBackends();
const home = mkdtempSync(join(tmpdir(), 'gbrain-origin-guard-6948-'));
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const engines: Array<[string, BrainEngine]> = [];
let engine: PGLiteEngine;
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  engines.push(['pglite', engine]);
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(['postgres', pg.engine]);
    closePostgres = pg.close;
  }
  // The guard is what protects a brain whose pages_live_origin_key index is pending (it holds legacy twins); the
  // unique-index cases build the index themselves.
  for (const [, e] of engines) await dropOriginIndex(e);
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
  _resetWriteThroughCacheForTest();
});

const NOTE = 'notes/note-example.md';
const quiet = { info() {}, warn() {}, error() {} };

async function source(e: BrainEngine, localPath: string | null = null, config: Record<string, unknown> = {}): Promise<string> {
  const id = `og-${randomUUID().slice(0, 8)}`;
  await e.executeRaw('INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, $3::text::jsonb)', [id, localPath, JSON.stringify(config)]);
  return id;
}

/** A page row as an older writer left it (raw SQL: the guard is what these tests are about). */
async function row(e: BrainEngine, sourceId: string, slug: string, sourcePath: string | null, deleted = false): Promise<number> {
  const [r] = await e.executeRaw<{ id: number }>(`INSERT INTO pages (source_id, slug, type, title, compiled_truth, source_path, deleted_at)
    VALUES ($1, $2, 'note', $2, $3, $4, CASE WHEN $5::boolean THEN now() END) RETURNING id`, [sourceId, slug, `Body of ${slug}.`, sourcePath, deleted]);
  return Number(r!.id);
}

async function pages(e: BrainEngine, sourceId: string) {
  return e.executeRaw<{ slug: string; source_path: string | null; live: boolean }>(
    'SELECT slug, source_path, deleted_at IS NULL AS live FROM pages WHERE source_id = $1 ORDER BY slug', [sourceId]);
}

async function liveClaimants(e: BrainEngine, sourceId: string, sourcePath: string): Promise<string[]> {
  return (await e.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id = $1 AND source_path = $2 AND deleted_at IS NULL ORDER BY slug',
    [sourceId, sourcePath])).map(r => r.slug);
}

async function refusal(run: () => Promise<unknown>): Promise<Error & { code?: string; detail?: string }> {
  try { await run(); } catch (error) { return error as Error & { code?: string; detail?: string }; }
  throw new Error('expected the write to be refused, but it succeeded');
}

const claimed = { code: 'page_identity_changed', detail: 'origin_already_claimed' };

/** The issue's shape: a legacy page with no origin, and the live canonical page that records the file. */
async function issueShape(e: BrainEngine, localPath: string | null = null) {
  const sourceId = await source(e, localPath);
  await row(e, sourceId, 'notes/note-example', NOTE);
  await row(e, sourceId, 'ideas/note-example', null);
  return sourceId;
}

function each(name: string, run: (e: BrainEngine) => Promise<void>, timeout = 60_000) {
  for (const [backend] of [['pglite'], ...(backends.includes('postgres') ? [['postgres']] : [])]) {
    test(`${name} (${backend})`, async () => {
      const e = engines.find(([b]) => b === backend)![1];
      await withEnv(env, () => run(e));
    }, timeout);
  }
}

describe('writers refuse a second live claimant of an origin', () => {
  each('putPage giving the legacy page the held origin refuses and leaves it without one', async e => {
    const sourceId = await issueShape(e);
    const error = await refusal(() => e.putPage('ideas/note-example', { type: 'note', title: 'Idea', compiled_truth: 'Moved.', source_path: NOTE }, { sourceId }));
    expect(error).toMatchObject(claimed);
    expect(error.message).toContain(NOTE);
    expect(await liveClaimants(e, sourceId, NOTE)).toEqual(['notes/note-example']);
    expect((await e.getPage('ideas/note-example', { sourceId }))?.compiled_truth).toBe('Body of ideas/note-example.');
  });

  each('putPage inserting a new page with the held origin refuses and inserts nothing', async e => {
    const sourceId = await issueShape(e);
    expect(await refusal(() => e.putPage('fresh/note-example', { type: 'note', title: 'Fresh', compiled_truth: 'New.', source_path: NOTE }, { sourceId }))).toMatchObject(claimed);
    expect(await e.getPage('fresh/note-example', { sourceId })).toBeNull();
  });

  each('a write that keeps its own origin works while an unrelated twin exists', async e => {
    const sourceId = await issueShape(e);
    await row(e, sourceId, 'other/twin-a', 'other/twin.md');
    await row(e, sourceId, 'other/twin-b', 'other/twin.md');
    await e.putPage('notes/note-example', { type: 'note', title: 'Kept', compiled_truth: 'Rewritten.', source_path: NOTE }, { sourceId });
    await e.putPage('other/twin-a', { type: 'note', title: 'Twin', compiled_truth: 'Still its own origin.' }, { sourceId });
    expect((await e.getPage('notes/note-example', { sourceId }))?.compiled_truth).toBe('Rewritten.');
    expect(await liveClaimants(e, sourceId, 'other/twin.md')).toEqual(['other/twin-a', 'other/twin-b']);
  });

  each('putPage reviving a tombstone whose origin another live page now holds refuses and keeps it deleted', async e => {
    const sourceId = await issueShape(e);
    await row(e, sourceId, 'old/note-example', NOTE, true);
    expect(await refusal(() => e.putPage('old/note-example', { type: 'note', title: 'Back', compiled_truth: 'Revived.' }, { sourceId }))).toMatchObject(claimed);
    expect((await pages(e, sourceId)).find(p => p.slug === 'old/note-example')).toMatchObject({ live: false });
  });

  each('restorePage of a tombstone whose origin another live page now holds refuses', async e => {
    const sourceId = await issueShape(e);
    await row(e, sourceId, 'old/note-example', NOTE, true);
    expect(await refusal(() => e.restorePage('old/note-example', { sourceId }))).toMatchObject(claimed);
    expect(await liveClaimants(e, sourceId, NOTE)).toEqual(['notes/note-example']);
  });

  each('write-through (write-through.ts) binding a held slug path refuses before the file is written', async e => {
    const root = mkdtempSync(join(home, 'wt-'));
    const sourceId = await source(e, root);
    await row(e, sourceId, 'ideas/note-example', null);
    await row(e, sourceId, 'ideas/note-example-old', 'ideas/note-example.md');
    const result = await writePageThrough(e, 'ideas/note-example', { sourceId });
    expect(result.written).toBe(false);
    expect(result.error).toContain('ideas/note-example.md');
    expect(existsSync(join(root, 'ideas', 'note-example.md'))).toBe(false);
    expect(await liveClaimants(e, sourceId, 'ideas/note-example.md')).toEqual(['ideas/note-example-old']);
  });

  test('put_page (page-prepare.ts write-through binding, classic PGLite brain) refuses a page whose file another page records', () => withEnv(env, async () => {
    const e = engine;
    const root = mkdtempSync(join(home, 'put-'));
    const sourceId = await source(e, root);
    await row(e, sourceId, 'notes/note-example-old', NOTE);
    const ctx: OperationContext = { engine: e, config: { engine: e.kind } as never, logger: quiet, dryRun: false, remote: false, sourceId };
    const put = operations.find(o => o.name === 'put_page')!;
    const error = await refusal(() => put.handler(ctx, { slug: 'notes/note-example', content: '---\ntitle: Note\ntype: note\n---\n\nA synthetic note.\n' }));
    expect(error).toMatchObject({ code: 'page_identity_changed', message: expect.stringContaining(`already records "${NOTE}"`) });
    expect(await e.getPage('notes/note-example', { sourceId })).toBeNull();
    expect(existsSync(join(root, NOTE))).toBe(false);
    expect(await liveClaimants(e, sourceId, NOTE)).toEqual(['notes/note-example-old']);
  }), 60_000);

  each('importFile\'s origin refresh (import-file.ts) logs the refusal and records no origin', async e => {
    const sourceId = await source(e);
    const content = '---\ntitle: Idea\ntype: note\n---\n\nA synthetic idea.\n';
    await importFromContent(e, 'ideas/note-example', content, { sourceId, noEmbed: true });
    await row(e, sourceId, 'notes/note-example', NOTE);
    const logged: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => { logged.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try { await importFromContent(e, 'ideas/note-example', content, { sourceId, noEmbed: true, sourcePath: NOTE }); } finally { process.stderr.write = write; }
    expect((await e.getPage('ideas/note-example', { sourceId }))?.source_path ?? null).toBeNull();
    expect(await liveClaimants(e, sourceId, NOTE)).toEqual(['notes/note-example']);
    expect(logged.join('')).toContain(`origin ${NOTE} not recorded`);
  });

  each('a sync rename (rename-collision.ts) whose destination path another page records refuses the bind and the move', async e => {
    const sourceId = await issueShape(e);
    await row(e, sourceId, 'drafts/note-example', 'drafts/note-example.md');
    const error = await refusal(() => renamePageOntoSlug(e, { sourceId, oldSlug: 'drafts/note-example', newSlug: 'ideas/renamed', to: NOTE }));
    expect(error).toMatchObject(claimed);
    expect(isUniqueViolation(error)).toBe(false);
    expect(await liveClaimants(e, sourceId, NOTE)).toEqual(['notes/note-example']);
    expect(await e.getPage('drafts/note-example', { sourceId })).not.toBeNull();
  });

  each('updateSlug keeps the page\'s own origin, so it never adds a claimant', async e => {
    const sourceId = await issueShape(e);
    expect(await e.updateSlug('notes/note-example', 'notes/renamed-example', { sourceId })).toBe(1);
    expect(await liveClaimants(e, sourceId, NOTE)).toEqual(['notes/renamed-example']);
  });

  each('bindOrigin, the binder of the repair and sync publications, refuses and needs a transaction', async e => {
    const sourceId = await issueShape(e);
    expect(await refusal(() => e.transaction(tx => guard.bindOrigin(tx, { sourceId, slug: 'ideas/note-example', sourcePath: NOTE })))).toMatchObject(claimed);
    expect(await refusal(() => guard.bindOrigin(e, { sourceId, slug: 'ideas/note-example', sourcePath: NOTE }))).toMatchObject({ message: expect.stringContaining('engine.transaction()') });
    expect(await liveClaimants(e, sourceId, NOTE)).toEqual(['notes/note-example']);
  });

  each('bindOrigin clears an origin_twin database-only marker when the page records an origin again', async e => {
    const sourceId = await issueShape(e);
    await e.executeRaw("UPDATE pages SET database_only_reason='origin_twin' WHERE source_id=$1 AND slug='ideas/note-example'", [sourceId]);
    expect(await e.transaction(tx => guard.bindOrigin(tx, { sourceId, slug: 'ideas/note-example', sourcePath: 'ideas/note-example.md' }))).toBe(1);
    const [page] = await e.executeRaw<{ reason: string | null; source_path: string }>("SELECT database_only_reason AS reason, source_path FROM pages WHERE source_id=$1 AND slug='ideas/note-example'", [sourceId]);
    expect(page).toEqual({ reason: null, source_path: 'ideas/note-example.md' });
  });

  each('the legacy <scope>/<origin> spelling of a scoped source-root source is the same origin', async e => {
    const repo = mkdtempSync(join(home, 'repo-'));
    mkdirSync(join(repo, '.git'));
    mkdirSync(join(repo, 'sub'));
    const sourceId = await source(e, join(repo, 'sub'), { slug_root_mode: 'source-root' });
    await row(e, sourceId, 'note-example', 'sub/note-example.md');
    const error = await refusal(() => e.putPage('ideas/note-example', { type: 'note', title: 'Idea', compiled_truth: 'x', source_path: 'note-example.md' }, { sourceId }));
    expect(error).toMatchObject(claimed);
    expect(error.message).toContain('note-example.md');
    expect(await liveClaimants(e, sourceId, 'note-example.md')).toEqual([]);
  });
});

describe('the unique index, when it exists', () => {
  each('a 23505 on pages_live_origin_key maps to origin_already_claimed and is no slug collision', async e => {
    const sourceId = await source(e);
    await e.executeRaw('UPDATE pages SET deleted_at = now() WHERE deleted_at IS NULL AND source_path IS NOT NULL');
    await e.executeRaw(`CREATE UNIQUE INDEX ${guard.ORIGIN_INDEX_NAME} ON pages (source_id, source_path) WHERE deleted_at IS NULL AND source_path IS NOT NULL`);
    try {
      await row(e, sourceId, 'notes/note-example', NOTE);
      const raced = await refusal(() => row(e, sourceId, 'ideas/note-example', NOTE));
      expect(String((raced as { code?: unknown }).code)).toBe('23505');
      expect(guard.classifyOriginUniqueViolation(raced)).toMatchObject(claimed);
      expect(isUniqueViolation(raced)).toBe(false);
      const slugTaken = await refusal(() => row(e, sourceId, 'notes/note-example', null));
      expect(isUniqueViolation(slugTaken)).toBe(true);
      expect(guard.classifyOriginUniqueViolation(slugTaken)).toBeNull();
    } finally {
      await e.executeRaw(`DROP INDEX IF EXISTS ${guard.ORIGIN_INDEX_NAME}`);
    }
  });
});

describe('readers and repairs target the canonical page', () => {
  each('canonicalOriginPage picks the slug the file derives, else reports the twins', async e => {
    const sourceId = await source(e);
    await row(e, sourceId, 'ideas/note-example', NOTE);
    await row(e, sourceId, 'notes/note-example', NOTE);
    await row(e, sourceId, 'a/twin', 'other/twin.md');
    await row(e, sourceId, 'b/twin', 'other/twin.md');
    expect(await guard.canonicalOriginPage(e, sourceId, NOTE)).toMatchObject({ slug: 'notes/note-example' });
    expect(await guard.canonicalOriginPage(e, sourceId, 'other/twin.md')).toEqual({ ambiguous: ['a/twin', 'b/twin'] });
  });

  each('classic sync delete resolves a removed file to its canonical page and refuses ambiguous twins', async e => {
    const sourceId = await source(e);
    await row(e, sourceId, 'notes/note-example', NOTE);
    await row(e, sourceId, 'ideas/note-example', NOTE);
    await row(e, sourceId, 'a/twin', 'other/twin.md');
    await row(e, sourceId, 'b/twin', 'other/twin.md');
    const resolved = await resolveSlugsForRemovedPaths(e, [NOTE, 'other/twin.md'], sourceId);
    expect(resolved.slugs.get(NOTE)).toBe('notes/note-example');
    expect(resolved.slugs.has('other/twin.md')).toBe(false);
    expect(resolved.refused).toEqual([expect.objectContaining({ path: 'other/twin.md', claimants: ['a/twin', 'b/twin'] })]);
  });

  each('fence repair reads the canonical page of a file twins record', async e => {
    const root = mkdtempSync(join(home, 'fence-'));
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, NOTE), '---\ntitle: Note\n---\nA synthetic note.\n');
    writeFileSync(join(root, 'twin.md'), '---\ntitle: Twin\n---\nA synthetic twin.\n');
    const sourceId = await source(e, root);
    await row(e, sourceId, 'ideas/note-example', NOTE);
    await row(e, sourceId, 'notes/note-example', NOTE);
    await row(e, sourceId, 'a/twin', 'twin.md');
    await row(e, sourceId, 'b/twin', 'twin.md');
    const [{ incarnation }] = await e.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
    const src: FenceSource = { id: sourceId, incarnation, managed: false, mirror: false, root, owner: null, busy: { paths: new Set(), slugs: new Set(), unknown: null } };
    const read = await readFenceTarget(e, src, { key: `path:${NOTE}`, path: NOTE });
    expect(read).toMatchObject({ ok: true, target: { slug: 'notes/note-example' } });
    const twin = await readFenceTarget(e, src, { key: 'path:twin.md', path: 'twin.md' });
    expect(twin).toMatchObject({ ok: false, reason: 'origin_conflict' });
  });

  each('frontmatter repair holds a file twins record with no canonical page as origin_conflict', async e => {
    const root = mkdtempSync(join(home, 'fm-'));
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, NOTE), '---\ntitle: Roundup\nauthor: alice-example (citing acme-example) (original: https://example.invalid/a)\n---\nA synthetic roundup.\n');
    const sourceId = await source(e, root);
    await row(e, sourceId, 'a/note-example', NOTE);
    await row(e, sourceId, 'b/note-example', NOTE);
    const runner = await repairRunner(e, { apply: false, noEmbed: true, logger: quiet });
    const preview = await runner.run('frontmatter', await resolveRepairScope(e, sourceId), { explicit: true, sourceFlag: sourceId });
    const details = preview.details as unknown as FrontmatterPreviewDetails;
    expect(details.counts.safe).toBe(0);
    expect(details.needs_review).toEqual([expect.objectContaining({ path: NOTE, code: 'origin_conflict' })]);
  });

  each('file-drift refuses to repair a twin that is not the canonical page of its file', async e => {
    const sourceId = await source(e);
    await row(e, sourceId, 'notes/note-example', NOTE);
    await row(e, sourceId, 'ideas/note-example', NOTE);
    expect(await refusal(() => prepareDriftPage(e, sourceId, 'ideas/note-example', 'file', new Date().toISOString())))
      .toMatchObject({ code: 'page_identity_changed', detail: 'origin_conflict' });
  });
});

describe('races (Postgres)', () => {
  const pg = () => engines.find(([b]) => b === 'postgres')?.[1];
  const run = backends.includes('postgres') ? test : test.skip;

  /** Holds a putPage's transaction open until `release`; the second write starts while it is open. */
  async function race(e: BrainEngine, sourceId: string, first: [string, string], second: [string, string]) {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const inside = new Promise<void>(resolve => { entered = resolve; });
    const a = e.transaction(async tx => {
      await tx.putPage(first[0], { type: 'note', title: 'A', compiled_truth: 'First.', source_path: first[1] }, { sourceId });
      entered();
      await gate;
    });
    await inside;
    let settled = false;
    const b = e.putPage(second[0], { type: 'note', title: 'B', compiled_truth: 'Second.', source_path: second[1] }, { sourceId }).finally(() => { settled = true; });
    await Bun.sleep(300);
    const blocked = !settled;
    release();
    return { blocked, results: await Promise.allSettled([a, b]) };
  }

  run('two concurrent assignments of one origin to different pages: exactly one commits', async () => {
    const e = pg()!;
    const sourceId = await source(e);
    const { blocked, results } = await race(e, sourceId, ['ideas/note-example', NOTE], ['notes/note-example', NOTE]);
    expect(blocked).toBe(true);
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected']);
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject(claimed);
    expect(await liveClaimants(e, sourceId, NOTE)).toEqual(['ideas/note-example']);
  }, 60_000);

  run('two spellings of one origin (legacy <scope>/<origin>) race onto one lock: exactly one commits', async () => {
    const e = pg()!;
    const repo = mkdtempSync(join(home, 'race-'));
    mkdirSync(join(repo, '.git'));
    mkdirSync(join(repo, 'sub'));
    const sourceId = await source(e, join(repo, 'sub'), { slug_root_mode: 'source-root' });
    const { blocked, results } = await race(e, sourceId, ['ideas/note-example', 'note-example.md'], ['note-example', 'sub/note-example.md']);
    expect(blocked).toBe(true);
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected']);
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject(claimed);
  }, 60_000);

  run('with the unique index, an insert raced by an unguarded writer maps its 23505 to origin_already_claimed', async () => {
    const e = pg()!;
    const sourceId = await source(e);
    await e.executeRaw('UPDATE pages SET deleted_at = now() WHERE deleted_at IS NULL AND source_path IS NOT NULL');
    await e.executeRaw(`CREATE UNIQUE INDEX ${guard.ORIGIN_INDEX_NAME} ON pages (source_id, source_path) WHERE deleted_at IS NULL AND source_path IS NOT NULL`);
    try {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let entered!: () => void;
      const inside = new Promise<void>(resolve => { entered = resolve; });
      const unguarded = e.transaction(async tx => { await row(tx, sourceId, 'raw/note-example', NOTE); entered(); await gate; });
      await inside;
      const guarded = e.putPage('notes/note-example', { type: 'note', title: 'N', compiled_truth: 'Guarded.', source_path: NOTE }, { sourceId });
      await Bun.sleep(300);
      release();
      const [first, second] = await Promise.allSettled([unguarded, guarded]);
      expect(first.status).toBe('fulfilled');
      expect(second.status).toBe('rejected');
      expect((second as PromiseRejectedResult).reason).toMatchObject(claimed);
    } finally {
      await e.executeRaw(`DROP INDEX IF EXISTS ${guard.ORIGIN_INDEX_NAME}`);
    }
  }, 60_000);
});
