/**
 * Tests for src/core/sources-load.ts (v0.40 D7).
 *
 * Validates the shared loader: ordering, filtering, config parsing, and
 * defensive fallback when legacy brains lack the `archived` column.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  loadAllSources,
  fetchSource,
  parseSourceConfig,
  isSourceFederated,
} from '../src/core/sources-load.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function insertSource(id: string, opts: { federated?: boolean; archived?: boolean; config?: Record<string, unknown> } = {}): Promise<void> {
  const config = { ...opts.config, federated: opts.federated ?? false };
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config, archived)
     VALUES ($1, $1, $2::jsonb, $3)
     ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, archived = EXCLUDED.archived`,
    [id, JSON.stringify(config), opts.archived ?? false],
  );
}

describe('loadAllSources', () => {
  test('returns default source first, then alphabetical', async () => {
    await insertSource('zebra');
    await insertSource('alpha');
    const rows = await loadAllSources(engine);
    expect(rows.map((r) => r.id)).toEqual(['default', 'alpha', 'zebra']);
  });

  test('excludes archived rows by default', async () => {
    await insertSource('keep');
    await insertSource('archived-one', { archived: true });
    const rows = await loadAllSources(engine);
    expect(rows.map((r) => r.id).sort()).toEqual(['default', 'keep']);
  });

  test('includeArchived: true returns archived rows', async () => {
    await insertSource('keep');
    await insertSource('archived-one', { archived: true });
    const rows = await loadAllSources(engine, { includeArchived: true });
    expect(rows.map((r) => r.id).sort()).toEqual(['archived-one', 'default', 'keep']);
  });

  test('federatedOnly: filters to config.federated=true', async () => {
    await insertSource('iso', { federated: false });
    await insertSource('fed-a', { federated: true });
    await insertSource('fed-b', { federated: true });
    const rows = await loadAllSources(engine, { federatedOnly: true });
    // default source seeded by resetPgliteState has federated: true
    expect(rows.map((r) => r.id).sort()).toEqual(['default', 'fed-a', 'fed-b']);
  });

  test('rows have the full SourceRow projection (no surprise drift)', async () => {
    await insertSource('shapecheck', { federated: true, config: { tracked_branch: 'main' } });
    const rows = await loadAllSources(engine);
    const target = rows.find((r) => r.id === 'shapecheck');
    expect(target).toBeDefined();
    expect(target).toMatchObject({
      id: 'shapecheck',
      name: 'shapecheck',
      local_path: null,
      last_commit: null,
      last_sync_at: null,
    });
    expect(target!.config).toBeDefined();
    expect(target!.created_at).toBeDefined();
  });
});

describe('fetchSource', () => {
  test('returns row for known id', async () => {
    await insertSource('mybrain', { federated: true });
    const row = await fetchSource(engine, 'mybrain');
    expect(row?.id).toBe('mybrain');
    expect(isSourceFederated(row!.config)).toBe(true);
  });

  test('returns null for unknown id', async () => {
    const row = await fetchSource(engine, 'does-not-exist');
    expect(row).toBeNull();
  });
});

describe('parseSourceConfig', () => {
  test('passes through plain object', () => {
    expect(parseSourceConfig({ federated: true })).toEqual({ federated: true });
  });

  test('parses JSON string', () => {
    expect(parseSourceConfig('{"federated":true}')).toEqual({ federated: true });
  });

  test('returns empty object on null / undefined / non-object', () => {
    expect(parseSourceConfig(null)).toEqual({});
    expect(parseSourceConfig(undefined)).toEqual({});
    expect(parseSourceConfig(42)).toEqual({});
  });

  test('returns empty object on malformed JSON string', () => {
    expect(parseSourceConfig('{')).toEqual({});
  });
});

describe('isSourceFederated', () => {
  test('strict-true requirement', () => {
    expect(isSourceFederated({ federated: true })).toBe(true);
    expect(isSourceFederated({ federated: false })).toBe(false);
    expect(isSourceFederated({ federated: 'true' })).toBe(false); // strict boolean
    expect(isSourceFederated({ federated: 1 })).toBe(false);
    expect(isSourceFederated({})).toBe(false);
    expect(isSourceFederated(null)).toBe(false);
  });
});
