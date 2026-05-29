// v0.40.6.0 — stats.ts contract tests.
//
// Multi-source aware, soft-delete exclusion, dead-prefix detection,
// PGLite parity. Phase 3 of the schema cathedral v3 plan.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runStatsCore } from '../src/core/schema-pack/stats.ts';
import {
  __setPackLocatorForTests,
  _resetPackLocatorForTests,
} from '../src/core/schema-pack/load-active.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let tmpDir: string;

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
  _resetPackLocatorForTests();
  tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-stats-test-'));
});

function ctxOf(remote = false): OperationContext {
  return {
    engine,
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote,
  } as unknown as OperationContext;
}

async function ensureSource(id: string): Promise<void> {
  if (id === 'default') return;  // seeded by schema bootstrap
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`,
    [id],
  );
}

async function seedPage(slug: string, opts: { type?: string; sourceId?: string; sourcePath?: string; deleted?: boolean } = {}): Promise<void> {
  // pages.type is NOT NULL; use empty string for "untyped".
  // pages.title is NOT NULL.
  // pages.source_id FKs sources(id) — seed source first.
  const sourceId = opts.sourceId ?? 'default';
  await ensureSource(sourceId);
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, source_path, type, title, compiled_truth, timeline, content_hash, deleted_at)
     VALUES ($1, $2, $3, $4, $5, '', '', '', $6)`,
    [slug, sourceId, opts.sourcePath ?? `${slug}.md`, opts.type ?? '', slug, opts.deleted ? new Date() : null],
  );
}

function seedTinyPack(packName: string, types: Array<{ name: string; prefix: string }>): void {
  const dir = join(tmpDir, packName);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'pack.yaml');
  let body = `api_version: gbrain-schema-pack-v1\nname: ${packName}\nversion: 1.0.0\ndescription: ""\ngbrain_min_version: 0.38.0\nextends: null\nborrow_from: []\npage_types:\n`;
  for (const t of types) {
    body += `  - name: ${t.name}\n    primitive: entity\n    path_prefixes:\n      - ${t.prefix}\n    aliases: []\n    extractable: false\n    expert_routing: false\n`;
  }
  body += `link_types: []\nfrontmatter_links: []\ntakes_kinds:\n  - fact\n  - take\n  - bet\n  - hunch\nenrichable_types: []\nfiling_rules: []\n`;
  writeFileSync(path, body, 'utf-8');
  __setPackLocatorForTests((name) => (name === packName ? path : null));
}

describe('runStatsCore — empty brain', () => {
  it('reports coverage:1.0 (vacuous truth)', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const result = await runStatsCore(ctxOf());
      expect(result.aggregate.total_pages).toBe(0);
      expect(result.aggregate.coverage).toBe(1.0);
      expect(result.per_source).toEqual([]);
    });
  });
});

describe('runStatsCore — single source', () => {
  it('counts typed + untyped pages and computes coverage', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      await seedPage('a', { type: 'person' });
      await seedPage('b', { type: 'person' });
      await seedPage('c', { type: 'company' });
      await seedPage('d');  // untyped
      const result = await runStatsCore(ctxOf());
      expect(result.aggregate.total_pages).toBe(4);
      expect(result.aggregate.typed_pages).toBe(3);
      expect(result.aggregate.untyped_pages).toBe(1);
      expect(result.aggregate.coverage).toBe(0.75);
      expect(result.aggregate.by_type).toEqual([
        { type: 'person', count: 2 },
        { type: 'company', count: 1 },
      ]);
    });
  });

  it('excludes soft-deleted pages', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      await seedPage('a', { type: 'person' });
      await seedPage('b', { type: 'person', deleted: true });
      const result = await runStatsCore(ctxOf());
      expect(result.aggregate.total_pages).toBe(1);
    });
  });

  it('respects sourceId scoping', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      await seedPage('a', { type: 'person', sourceId: 'src-a' });
      await seedPage('b', { type: 'person', sourceId: 'src-b' });
      const result = await runStatsCore(ctxOf(), { sourceId: 'src-a' });
      expect(result.aggregate.total_pages).toBe(1);
      expect(result.per_source.length).toBe(1);
      expect(result.per_source[0]!.source_id).toBe('src-a');
    });
  });
});

describe('runStatsCore — federated', () => {
  it('aggregates across sourceIds array', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      await seedPage('a', { type: 'person', sourceId: 'src-a' });
      await seedPage('b', { type: 'person', sourceId: 'src-b' });
      await seedPage('c', { type: 'person', sourceId: 'src-c' });
      const result = await runStatsCore(ctxOf(), { sourceIds: ['src-a', 'src-b'] });
      expect(result.aggregate.total_pages).toBe(2);
      expect(result.per_source.length).toBe(2);
      const sources = result.per_source.map((s) => s.source_id).sort();
      expect(sources).toEqual(['src-a', 'src-b']);
    });
  });

  it('per-source breakdown sorted alphabetically', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      await seedPage('a', { type: 'person', sourceId: 'src-zzz' });
      await seedPage('b', { type: 'person', sourceId: 'src-aaa' });
      const result = await runStatsCore(ctxOf());
      expect(result.per_source.map((s) => s.source_id)).toEqual(['src-aaa', 'src-zzz']);
    });
  });
});

describe('runStatsCore — dead-prefix detection', () => {
  it('flags pack-declared prefixes with zero matching pages', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: 'tiny' }, async () => {
      seedTinyPack('tiny', [
        { name: 'person', prefix: 'people/' },
        { name: 'company', prefix: 'companies/' },
      ]);
      await seedPage('people/alice', { type: 'person', sourcePath: 'people/alice.md' });
      // No companies/* pages → dead prefix.
      const result = await runStatsCore(ctxOf());
      expect(result.pack_identity).not.toBeNull();
      expect(result.dead_prefixes).toEqual([{ type: 'company', prefix: 'companies/' }]);
    });
  });

  it('no dead-prefix hints when every declared prefix has pages', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: 'tiny' }, async () => {
      seedTinyPack('tiny', [{ name: 'person', prefix: 'people/' }]);
      await seedPage('people/alice', { type: 'person', sourcePath: 'people/alice.md' });
      const result = await runStatsCore(ctxOf());
      expect(result.dead_prefixes).toEqual([]);
    });
  });

  it('returns empty dead_prefixes when pack load fails', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: 'never-installed' }, async () => {
      __setPackLocatorForTests(() => null);
      const result = await runStatsCore(ctxOf());
      expect(result.pack_identity).toBeNull();
      expect(result.dead_prefixes).toEqual([]);
    });
  });
});

describe('runStatsCore — JSON envelope shape', () => {
  it('schema_version stays 1 (stable contract)', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const result = await runStatsCore(ctxOf());
      expect(result.schema_version).toBe(1);
    });
  });

  it('aggregate fields match the per-source merge', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      await seedPage('a', { type: 'person', sourceId: 'src-a' });
      await seedPage('b', { sourceId: 'src-b' });  // untyped
      const result = await runStatsCore(ctxOf());
      const totalFromPer = result.per_source.reduce((acc, s) => acc + s.total_pages, 0);
      expect(result.aggregate.total_pages).toBe(totalFromPer);
    });
  });

  it('by_type sorted by count desc, ties by name asc', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      await seedPage('a', { type: 'company' });
      await seedPage('b', { type: 'person' });
      await seedPage('c', { type: 'person' });
      await seedPage('d', { type: 'person' });
      const result = await runStatsCore(ctxOf());
      expect(result.aggregate.by_type[0]!.type).toBe('person');
      expect(result.aggregate.by_type[1]!.type).toBe('company');
    });
  });
});

describe('runStatsCore — type/untyped split', () => {
  it('treats empty-string type as untyped (not its own bucket)', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      // Some legacy rows might have type='' rather than NULL.
      await engine.executeRaw(
        `INSERT INTO pages (slug, source_id, source_path, type, title, compiled_truth, timeline, content_hash)
         VALUES ('a', 'default', 'a.md', '', 'a', '', '', '')`,
      );
      await seedPage('b', { type: 'person' });
      const result = await runStatsCore(ctxOf());
      expect(result.aggregate.untyped_pages).toBe(1);
      expect(result.aggregate.typed_pages).toBe(1);
      // empty-string type does NOT appear as its own type bucket.
      expect(result.aggregate.by_type.find((t) => t.type === '')).toBeUndefined();
    });
  });
});
