/**
 * #5879 — every pack-conformance surface agrees with `schema lint --with-db`:
 * a page whose stored type the active pack neither declares nor aliases is
 * NOT a type match. Pre-fix, `schema_review_orphans` (MCP), `schema
 * review-orphans` (CLI core), `schema_stats` coverage and doctor
 * `schema_pack_consistency` only counted empty types, so a brain full of
 * undeclared types read as fully conforming.
 *
 * Pack pinned to the bundled gbrain-base-v2 through the DB-plane
 * `schema_pack` key (tier 4), with an empty GBRAIN_HOME.
 */
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { loadPackFromFile } from '../src/core/schema-pack/loader.ts';
import { bundledPackPath } from '../src/core/schema-pack/bundled-assets.ts';
import { runReviewOrphans } from '../src/core/schema-pack/review.ts';
import { runStatsCore } from '../src/core/schema-pack/stats.ts';
import { checkSchemaPackConsistency } from '../src/commands/doctor/schema-pack-checks.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { withEnv } from './helpers/with-env.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let engine: PGLiteEngine;
let tmpHome: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  _resetPackCacheForTests();
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-5879-'));
  await engine.setConfig('schema_pack', 'gbrain-base-v2');
});

afterEach(() => {
  _resetPackCacheForTests();
  rmSync(tmpHome, { recursive: true, force: true });
});

const env = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: tmpHome, GBRAIN_SCHEMA_PACK: undefined }, fn);

async function seed(slug: string, type: string, sourceId = 'default'): Promise<void> {
  if (sourceId !== 'default') {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [sourceId]);
  }
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, source_path, type, title, compiled_truth, timeline, content_hash)
     VALUES ($1, $2, $3, $4, $1, '', '', '')`,
    [slug, sourceId, `${slug}.md`, type],
  );
}

/** note (declared), memo (alias of note), 3x meeting-transcript (undeclared), 1 untyped. */
async function seedMixed(): Promise<void> {
  await seed('notes/a', 'note');
  await seed('notes/b', 'memo');
  for (const n of [1, 2, 3]) await seed(`meetings/2026-01-0${n}-sync-transcript`, 'meeting-transcript');
  await seed('misc/untyped', '');
}

function ctxOf(sourceId?: string): OperationContext {
  return {
    engine,
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId,
  } as unknown as OperationContext;
}

describe('original and idea filing under the default pack', () => {
  test.each([
    ['originals', 'original', '../skills/archive-crawler/SKILL.md'],
    ['ideas', 'idea', '../docs/guides/idea-capture.md'],
  ])('the %s template writes a concept with the %s subtype without a Git checkout', async (directory, subtype, file) => {
    const template = await Bun.file(new URL(file, import.meta.url)).text();
    const frontmatter = template.match(/^```(?:markdown|yaml)\n(---\n[\s\S]*?^---)\n/m)?.[1];
    expect(frontmatter).toBeDefined();
    const slug = `${directory}/example`;
    await env(() => operationsByName.put_page!.handler(ctxOf(), {
      slug,
      content: `${frontmatter}\n\n# Example\n\nAn example page.\n`,
    }));
    const page = await engine.getPage(slug, { sourceId: 'default' });
    expect(page).toMatchObject({ type: 'concept', frontmatter: { subtype } });
  });

  test('untyped originals and ideas keep existing folder precedence', () => {
    const activePack = loadPackFromFile(bundledPackPath('gbrain-base-v2')!);
    const inferred = (file: string) => parseMarkdown('# Example', file, { activePack });
    for (const file of ['originals/example.md', 'ideas/example.md']) {
      const page = inferred(file);
      expect(page.type).toBe('concept');
      expect(page.inferredSubtype).toBeUndefined();
    }
    expect(inferred('originals/projects/example.md').type).toBe('project');
    expect(inferred('ideas/notes/example.md').type).toBe('note');
  });
});

describe('#5879 orphan review counts undeclared stored types', () => {
  test('schema_review_orphans op: undeclared + untyped are orphans; declared and alias types are not', async () => {
    await seedMixed();
    const result = await env(() => operationsByName.schema_review_orphans!.handler(ctxOf(), {})) as Record<string, any>;
    expect(result.orphan_count).toBe(4);
    expect(result.pack).toBe('gbrain-base-v2');
    expect(result.undeclared_types).toEqual([{ type: 'meeting-transcript', count: 3 }]);
    const bySlug = Object.fromEntries((result.orphans as Array<{ slug: string; reason: string }>).map((o) => [o.slug, o.reason]));
    expect(bySlug['misc/untyped']).toBe('untyped');
    expect(bySlug['meetings/2026-01-01-sync-transcript']).toBe('undeclared');
    expect(bySlug['notes/a']).toBeUndefined();
    expect(bySlug['notes/b']).toBeUndefined();
  });

  test('schema_review_orphans op surfaces a query failure instead of returning orphan_count 0', async () => {
    const broken = {
      ...ctxOf(),
      engine: {
        getConfig: async () => 'gbrain-base-v2',
        executeRaw: async () => { throw new Error('permission denied for table pages'); },
      } as unknown as BrainEngine,
    } as OperationContext;
    await expect(env(() => operationsByName.schema_review_orphans!.handler(broken, {}))).rejects.toThrow('permission denied');
  });

  test('schema review-orphans CLI core reports the same set for its source', async () => {
    await seedMixed();
    await seed('other/x', 'banana', 'side-src');
    const result = await env(() => runReviewOrphans(engine, { sourceId: 'default' }));
    expect(result.orphan_count).toBe(4);
    expect(result.undeclared_types.map((u) => u.type)).toEqual(['meeting-transcript']);
    expect(result.orphans.some((o) => o.slug === 'other/x')).toBe(false);
  });
});

describe('#5879 schema_stats coverage', () => {
  test('undeclared types count against coverage', async () => {
    await seedMixed();
    const result = await env(() => runStatsCore(ctxOf()));
    expect(result.aggregate.total_pages).toBe(6);
    expect(result.aggregate.typed_pages).toBe(5);
    expect(result.aggregate.undeclared_pages).toBe(3);
    // 2 of 6 pages (note + memo) match the pack.
    expect(result.aggregate.coverage).toBe(0.3333);
  });
});

describe('#5879 doctor schema_pack_consistency', () => {
  test('undeclared stored types warn with a stable code and the review command', async () => {
    await seed('notes/a', 'note');
    for (const n of [1, 2]) await seed(`reports/drift-2026-01-0${n}`, 'report');
    const check = await env(() => checkSchemaPackConsistency(engine));
    expect(check.status).toBe('warn');
    expect(check.details?.code).toBe('page_type_undeclared');
    expect(check.message).toContain("'report' (2)");
    expect(check.message).toContain('gbrain schema review-orphans --source default');
    expect(check.message).not.toContain('All pages match');
  });

  test('an alias-typed page is a pack match', async () => {
    await seed('notes/a', 'note');
    await seed('notes/b', 'memo');
    const check = await env(() => checkSchemaPackConsistency(engine));
    expect(check.status).toBe('ok');
    expect(check.message).toBe('All pages match the active schema pack across every source.');
  });

  test('remote doctor scope: sources outside the grant are not read', async () => {
    await seed('notes/a', 'note');
    await seed('other/x', 'banana', 'side-src');
    const scoped = await env(() => checkSchemaPackConsistency(engine, { sourceIds: ['default'] }));
    expect(scoped.status).toBe('ok');
    expect(JSON.stringify(scoped)).not.toContain('side-src');
    const all = await env(() => checkSchemaPackConsistency(engine));
    expect(all.status).toBe('warn');
    expect(all.message).toContain('side-src');
  });
});
