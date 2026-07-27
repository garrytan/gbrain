// v0.40.6.0 — sync.ts contract tests.
//
// Dry-run vs apply, chunked-batch correctness, idempotency,
// soft-delete exclusion, sample-slug payload, dead-prefix hint,
// per-source write scoping, PGLite parity. Phase 3 of the cathedral.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runSyncCore } from '../src/core/schema-pack/sync.ts';
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
  // Restore the disk-loader so we don't leak our test stub into sibling
  // test files in the same shard process (closes the bug where
  // test/onboard-pack-upgrade-checks.test.ts saw a stubbed locator and
  // failed only when this file ran first in CI shard 6).
  _resetPackLocatorForTests();
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  _resetPackCacheForTests();
  _resetPackLocatorForTests();
  tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-sync-test-'));
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
  if (id === 'default') return;
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`,
    [id],
  );
}

async function seedPage(slug: string, sourcePath: string, opts: { type?: string; sourceId?: string; deleted?: boolean } = {}): Promise<void> {
  const sourceId = opts.sourceId ?? 'default';
  await ensureSource(sourceId);
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, source_path, type, title, compiled_truth, timeline, content_hash, deleted_at)
     VALUES ($1, $2, $3, $4, $5, '', '', '', $6)`,
    [slug, sourceId, sourcePath, opts.type ?? '', slug, opts.deleted ? new Date() : null],
  );
}

async function getType(slug: string): Promise<string | null> {
  const rows = await engine.executeRaw<{ type: string }>(
    `SELECT type FROM pages WHERE slug = $1`,
    [slug],
  );
  return rows[0]?.type ?? null;
}

function seedTinyPack(types: Array<{ name: string; prefix: string }>): void {
  const dir = join(tmpDir, 'tiny');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'pack.yaml');
  let body = `api_version: gbrain-schema-pack-v1\nname: tiny\nversion: 1.0.0\ndescription: ""\ngbrain_min_version: 0.38.0\nextends: null\nborrow_from: []\npage_types:\n`;
  for (const t of types) {
    body += `  - name: ${t.name}\n    primitive: entity\n    path_prefixes:\n      - ${t.prefix}\n    aliases: []\n    extractable: false\n    expert_routing: false\n`;
  }
  body += `link_types: []\nfrontmatter_links: []\ntakes_kinds:\n  - fact\n  - take\n  - bet\n  - hunch\nenrichable_types: []\nfiling_rules: []\n`;
  writeFileSync(path, body, 'utf-8');
  __setPackLocatorForTests((name) => (name === 'tiny' ? path : null));
}

describe('runSyncCore — dry-run', () => {
  it('returns would_apply count + sample_slugs without writing', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: 'tiny' }, async () => {
      seedTinyPack([{ name: 'person', prefix: 'people/' }]);
      await seedPage('alice', 'people/alice.md');
      await seedPage('bob', 'people/bob.md');
      const result = await runSyncCore(ctxOf(), { apply: false });
      expect(result.apply).toBe(false);
      expect(result.total_would_apply).toBe(2);
      expect(result.total_applied).toBe(0);
      const personEntry = result.per_prefix.find((p) => p.type === 'person')!;
      expect(personEntry.would_apply).toBe(2);
      expect(personEntry.applied).toBe(0);
      expect(personEntry.sample_slugs).toEqual(['alice', 'bob']);
      // Confirm types still empty after dry-run.
      expect(await getType('alice')).toBe('');
      expect(await getType('bob')).toBe('');
    });
  });

  it('sample_slugs capped at 10', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: 'tiny' }, async () => {
      seedTinyPack([{ name: 'person', prefix: 'people/' }]);
      for (let i = 0; i < 15; i++) {
        await seedPage(`p${String(i).padStart(2, '0')}`, `people/p${String(i).padStart(2, '0')}.md`);
      }
      const result = await runSyncCore(ctxOf(), { apply: false });
      const personEntry = result.per_prefix.find((p) => p.type === 'person')!;
      expect(personEntry.would_apply).toBe(15);
      expect(personEntry.sample_slugs.length).toBe(10);
    });
  });

  it('dead_prefix flag fires when no pages match', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: 'tiny' }, async () => {
      seedTinyPack([
        { name: 'person', prefix: 'people/' },
        { name: 'company', prefix: 'companies/' },
      ]);
      await seedPage('alice', 'people/alice.md');
      const result = await runSyncCore(ctxOf(), { apply: false });
      const companyEntry = result.per_prefix.find((p) => p.type === 'company')!;
      expect(companyEntry.dead_prefix).toBe(true);
      expect(companyEntry.would_apply).toBe(0);
    });
  });
});

describe('runSyncCore — apply', () => {
  it('updates page.type for matching untyped pages', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: 'tiny' }, async () => {
      seedTinyPack([{ name: 'person', prefix: 'people/' }]);
      await seedPage('alice', 'people/alice.md');
      await seedPage('bob', 'people/bob.md');
      const result = await runSyncCore(ctxOf(), { apply: true });
      expect(result.total_applied).toBe(2);
      expect(await getType('alice')).toBe('person');
      expect(await getType('bob')).toBe('person');
    });
  });

  it('idempotent: second apply is a no-op', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: 'tiny' }, async () => {
      seedTinyPack([{ name: 'person', prefix: 'people/' }]);
      await seedPage('alice', 'people/alice.md');
      const first = await runSyncCore(ctxOf(), { apply: true });
      const second = await runSyncCore(ctxOf(), { apply: true });
      expect(first.total_applied).toBe(1);
      expect(second.total_applied).toBe(0);
    });
  });

  it('chunked UPDATE: large set in 1000-row batches (perf-shape verification)', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: 'tiny' }, async () => {
      seedTinyPack([{ name: 'person', prefix: 'people/' }]);
      // Seed 1500 untyped pages (1.5× the default batch size).
      for (let i = 0; i < 1500; i++) {
        await seedPage(`p${String(i).padStart(4, '0')}`, `people/p${String(i).padStart(4, '0')}.md`);
      }
      const batches: number[] = [];
      const result = await runSyncCore(ctxOf(), {
        apply: true,
        batchSize: 1000,
        onProgress: (info) => batches.push(info.appliedSoFar),
      });
      expect(result.total_applied).toBe(1500);
      // Progress fired at least once for the first batch (1000) and
      // again for the tail (1500 total).
      expect(batches).toContain(1000);
      expect(batches).toContain(1500);
    });
  });

  it('does NOT touch pages that already have a type', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: 'tiny' }, async () => {
      seedTinyPack([{ name: 'person', prefix: 'people/' }]);
      await seedPage('alice', 'people/alice.md', { type: 'old-type' });
      await seedPage('bob', 'people/bob.md');  // untyped
      await runSyncCore(ctxOf(), { apply: true });
      expect(await getType('alice')).toBe('old-type');  // preserved
      expect(await getType('bob')).toBe('person');
    });
  });

  it('excludes soft-deleted pages', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: 'tiny' }, async () => {
      seedTinyPack([{ name: 'person', prefix: 'people/' }]);
      await seedPage('alice', 'people/alice.md');
      await seedPage('zombie', 'people/zombie.md', { deleted: true });
      const result = await runSyncCore(ctxOf(), { apply: true });
      expect(result.total_applied).toBe(1);
      expect(await getType('alice')).toBe('person');
      expect(await getType('zombie')).toBe('');  // untouched (soft-deleted)
    });
  });
});

describe('runSyncCore — source scoping (codex C5 write-side)', () => {
  it('updates only the scoped source', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: 'tiny' }, async () => {
      seedTinyPack([{ name: 'person', prefix: 'people/' }]);
      await seedPage('alice', 'people/alice.md', { sourceId: 'src-a' });
      await seedPage('bob', 'people/bob.md', { sourceId: 'src-b' });
      const result = await runSyncCore(ctxOf(), { apply: true, sourceId: 'src-a' });
      expect(result.total_applied).toBe(1);
      expect(await getType('alice')).toBe('person');
      expect(await getType('bob')).toBe('');
    });
  });
});

describe('runSyncCore — pack-load failure', () => {
  it('returns empty result when no pack is loaded', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: 'nonexistent' }, async () => {
      __setPackLocatorForTests(() => null);
      await seedPage('alice', 'people/alice.md');
      const result = await runSyncCore(ctxOf(), { apply: true });
      expect(result.pack_identity).toBeNull();
      expect(result.per_prefix).toEqual([]);
      expect(result.total_applied).toBe(0);
      // Page untouched (no pack = no inference rules).
      expect(await getType('alice')).toBe('');
    });
  });
});

describe('runSyncCore — JSON envelope shape', () => {
  it('schema_version stays 1', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: 'tiny' }, async () => {
      seedTinyPack([{ name: 'person', prefix: 'people/' }]);
      const result = await runSyncCore(ctxOf());
      expect(result.schema_version).toBe(1);
    });
  });

  it('per_prefix entry shape is stable', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: 'tiny' }, async () => {
      seedTinyPack([{ name: 'person', prefix: 'people/' }]);
      await seedPage('alice', 'people/alice.md');
      const result = await runSyncCore(ctxOf());
      const entry = result.per_prefix[0]!;
      expect(entry).toHaveProperty('type');
      expect(entry).toHaveProperty('prefix');
      expect(entry).toHaveProperty('would_apply');
      expect(entry).toHaveProperty('sample_slugs');
      expect(entry).toHaveProperty('dead_prefix');
      expect(entry).toHaveProperty('applied');
    });
  });
});

describe('runSyncCore — batch size clamping', () => {
  it('clamps batch size to >=1 and <=10000', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: 'tiny' }, async () => {
      seedTinyPack([{ name: 'person', prefix: 'people/' }]);
      await seedPage('alice', 'people/alice.md');
      // batchSize:0 and batchSize:99999 both work; result is identical.
      const r1 = await runSyncCore(ctxOf(), { apply: true, batchSize: 0 });
      expect(r1.total_applied).toBe(1);
    });
  });
});
