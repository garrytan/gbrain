import { afterAll, beforeAll, describe, test, expect } from 'bun:test';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { copySourceRowsForMigration } from '../src/commands/migrate-engine.ts';

let source: PGLiteEngine;
let target: PGLiteEngine;
let spySource: PGLiteEngine;
let spyTargetReal: PGLiteEngine;

beforeAll(async () => {
  source = new PGLiteEngine();
  target = new PGLiteEngine();
  spySource = new PGLiteEngine();
  spyTargetReal = new PGLiteEngine();
  await source.connect({});
  await source.initSchema();
  await target.connect({});
  await target.initSchema();
  await spySource.connect({});
  await spySource.initSchema();
  await spyTargetReal.connect({});
  await spyTargetReal.initSchema();
});

afterAll(async () => {
  await source.disconnect();
  await target.disconnect();
  await spySource.disconnect();
  await spyTargetReal.disconnect();
});

describe('migrate-engine source row copy', () => {
  test('copies non-default sources before page import so FK-backed page writes succeed', async () => {
    await source.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
         VALUES ('wiki', 'Wiki', '/tmp/wiki', '{"federated": true}'::jsonb)`,
    );
    await source.putPage(
      'people/alice',
      { type: 'person', title: 'Alice', compiled_truth: 'Alice source page', timeline: '' },
      { sourceId: 'wiki' },
    );

    await expect(
      target.putPage(
        'people/alice',
        { type: 'person', title: 'Alice', compiled_truth: 'Alice target page', timeline: '' },
        { sourceId: 'wiki' },
      ),
    ).rejects.toThrow();

    const copied = await copySourceRowsForMigration(source, target);
    expect(copied).toBe(2);

    const sourceRows = await target.executeRaw<{ id: string; name: string; local_path: string | null }>(
      `SELECT id, name, local_path FROM sources ORDER BY id`,
    );
    expect(sourceRows.map((r) => r.id).sort()).toEqual(['default', 'wiki']);

    const wiki = sourceRows.find((r) => r.id === 'wiki');
    expect(wiki?.name).toBe('Wiki');
    expect(wiki?.local_path).toBe('/tmp/wiki');

    const page = await target.putPage(
      'people/alice',
      { type: 'person', title: 'Alice', compiled_truth: 'Alice target page', timeline: '' },
      { sourceId: 'wiki' },
    );
    expect(page.source_id).toBe('wiki');
  }, 60_000);

  test('binds source config as a raw object, not a double-encoded JSON string', async () => {
    await spySource.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
         VALUES ('blog', 'Blog', '/tmp/blog', '{"federated": true, "k": "v"}'::jsonb)`,
    );

    const boundConfigsByPos: unknown[] = [];

    const spyTarget = new Proxy(spyTargetReal, {
      get(realTarget, prop, receiver) {
        if (prop === 'executeRaw') {
          return async (sql: string, params?: unknown[], opts?: { signal?: AbortSignal }) => {
            if (/INSERT INTO sources/i.test(sql) && Array.isArray(params)) {
              const jsonbMatch = sql.match(/\$(\d+)::jsonb/);
              if (jsonbMatch) {
                boundConfigsByPos.push(params[Number(jsonbMatch[1]) - 1]);
              }
            }
            return realTarget.executeRaw(sql, params, opts);
          };
        }
        return Reflect.get(realTarget, prop, receiver);
      },
    }) as unknown as BrainEngine;

    await copySourceRowsForMigration(spySource, spyTarget);

    const blogConfig = boundConfigsByPos.find((candidate) => {
      if (candidate && typeof candidate === 'object') {
        return 'k' in (candidate as Record<string, unknown>);
      }
      return typeof candidate === 'string' && candidate.includes('"k"');
    });

    expect(typeof blogConfig).toBe('object');
    expect(typeof blogConfig).not.toBe('string');
    expect((blogConfig as Record<string, unknown>).federated).toBe(true);
    expect((blogConfig as Record<string, unknown>).k).toBe('v');
  }, 60_000);
});
