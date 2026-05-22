import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { StorageBackend } from '../src/core/storage.ts';
import {
  BRAIN_QUANT_PILOT_SOURCE_KEYS,
  buildBrainIngestionPlan,
  createBrainIngestionIdempotencyKey,
  parseBrainArchiveObject,
  runBrainIngestion,
} from '../src/core/brain-ingestion.ts';

function makeStorage(objects: Record<string, unknown>): StorageBackend {
  return {
    upload: async () => {},
    download: async (path: string) => {
      const object = objects[path];
      return Buffer.from(typeof object === 'string' ? object : JSON.stringify(object));
    },
    delete: async () => {},
    exists: async (path: string) => Object.prototype.hasOwnProperty.call(objects, path),
    list: async (prefix: string) => Object.keys(objects).filter(path => path.startsWith(prefix)),
    getUrl: async (path: string) => `local://${path}`,
  };
}

function makeEngine(): { engine: BrainEngine; calls: Array<{ sql: string; params?: unknown[] }> } {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const engine = {
    kind: 'postgres' as const,
    connect: async () => {},
    disconnect: async () => {},
    initSchema: async () => {},
    transaction: async <T>(fn: (engine: BrainEngine) => Promise<T>) => fn(engine),
    withReservedConnection: async <T>(fn: (conn: never) => Promise<T>) => fn({} as never),
    executeRaw: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
      calls.push({ sql, params });
      if (sql.includes('FROM brain_sources')) {
        return [{ id: 'source-row-1', enabled: true }] as T[];
      }
      if (sql.includes('INSERT INTO brain_ingestion_runs')) {
        return [{ id: 'run-row-1' }] as T[];
      }
      if (sql.includes('INSERT INTO brain_source_items')) {
        return [{ id: 'item-row-1' }] as T[];
      }
      return [];
    },
  } as unknown as BrainEngine;
  return { engine, calls };
}

describe('brain ingestion pilot allowlist', () => {
  test('accepts only the three Quant pilot sources', () => {
    expect(BRAIN_QUANT_PILOT_SOURCE_KEYS).toEqual([
      'quant_x:afirebrand',
      'quant_x:MoneyPrinter0x',
      'quant_x:TaikiMadea',
    ]);

    const plan = buildBrainIngestionPlan({
      bucket: 'brain-archive',
      mode: 'pilot',
      sources: ['afirebrand', 'MoneyPrinter0x', 'Taiki Madea'],
      dryRun: true,
    });

    expect(plan.sources.map(s => s.sourceKey)).toEqual([...BRAIN_QUANT_PILOT_SOURCE_KEYS]);
    expect(() => buildBrainIngestionPlan({
      bucket: 'brain-archive',
      mode: 'pilot',
      sources: ['afirebrand', 'not-allowed'],
      dryRun: true,
    })).toThrow('not in the Quant pilot allowlist');
  });
});

describe('brain archive parser routing', () => {
  test('routes Quant archive objects to x_post source items', () => {
    const item = parseBrainArchiveObject('quant_x:afirebrand', 'pilot/quant_x/afirebrand/post-1.json', {
      id: 'post-1',
      text: '$NVDA setup still intact',
      author: 'afirebrand',
      url: 'https://x.example/post-1',
      created_at: '2026-05-21T00:00:00Z',
    });

    expect(item.itemType).toBe('x_post');
    expect(item.externalId).toBe('post-1');
    expect(item.bodyText).toBe('$NVDA setup still intact');
    expect(item.authorHandle).toBe('afirebrand');
    expect(item.storageBucket).toBe('brain-archive');
  });

  test('rejects unsupported source adapter paths instead of guessing', () => {
    expect(() => parseBrainArchiveObject('youtube:channel', 'pilot/youtube/video.json', { id: 'v1' }))
      .toThrow('No Brain ingestion adapter registered');
  });
});

describe('brain ingestion idempotency and dry-run safety', () => {
  test('builds stable idempotency keys from source and content hash', () => {
    const a = createBrainIngestionIdempotencyKey('quant_x:afirebrand', 'post-1', 'abc');
    const b = createBrainIngestionIdempotencyKey('quant_x:afirebrand', 'post-1', 'abc');
    const c = createBrainIngestionIdempotencyKey('quant_x:afirebrand', 'post-2', 'abc');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  test('dry-run reads storage and emits quality gates without database writes', async () => {
    const { engine, calls } = makeEngine();
    const storage = makeStorage({
      'pilot/quant_x/afirebrand/post-1.json': { id: 'post-1', text: 'one', author: 'afirebrand' },
    });

    const result = await runBrainIngestion(engine, storage, {
      bucket: 'brain-archive',
      mode: 'pilot',
      sources: ['afirebrand'],
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.counters.parsed).toBe(1);
    expect(result.counters.written).toBe(0);
    expect(result.qualityGates.parseSuccess.passed).toBe(true);
    expect(result.qualityGates.idempotency.passed).toBe(true);
    expect(calls.length).toBe(0);
  });

  test('dry-run routes approved Quant pilot objects from the existing archive layout', async () => {
    const { engine, calls } = makeEngine();
    const storage = makeStorage({
      '13f/SALP_13F_2026Q1_period-2026-03-31.xml': '<informationTable><infoTable><nameOfIssuer>NVIDIA CORP</nameOfIssuer><cusip>67066G104</cusip><value>1234</value><sshPrnamt>100</sshPrnamt></infoTable></informationTable>',
      'poi/all-in-podcast/All-In_2026-01-23_Coinbase-CEO-s-Top-3-Crypto-Trends-for.md': '# Coinbase CEO\n\nBrian Armstrong discussed stablecoins, Bitcoin, and crypto market structure.',
    });

    const result = await runBrainIngestion(engine, storage, {
      bucket: 'brain-archive',
      mode: 'pilot',
      sources: ['afirebrand', 'MoneyPrinter0x'],
      dryRun: true,
    });

    expect(result.counters.listed).toBe(2);
    expect(result.counters.parsed).toBe(2);
    expect(result.counters.written).toBe(0);
    expect(result.samples).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceKey: 'quant_x:afirebrand',
        storagePath: '13f/SALP_13F_2026Q1_period-2026-03-31.xml',
        qualityStatus: 'new',
      }),
      expect.objectContaining({
        sourceKey: 'quant_x:MoneyPrinter0x',
        storagePath: 'poi/all-in-podcast/All-In_2026-01-23_Coinbase-CEO-s-Top-3-Crypto-Trends-for.md',
        title: 'Coinbase CEO',
        qualityStatus: 'new',
      }),
    ]));
    expect(result.qualityGates.parseSuccess.passed).toBe(true);
    expect(result.qualityGates.storageDatabaseConsistency.detail).toBe('dry-run: database consistency check deferred');
    expect(calls.length).toBe(0);
  });

  test('write mode requires explicit opt-in and records idempotent rows', async () => {
    const { engine, calls } = makeEngine();
    const storage = makeStorage({
      'pilot/quant_x/afirebrand/post-1.json': { id: 'post-1', text: 'one', author: 'afirebrand' },
    });

    await expect(runBrainIngestion(engine, storage, {
      bucket: 'brain-archive',
      mode: 'pilot',
      sources: ['afirebrand'],
      dryRun: false,
      allowWrites: false,
    })).rejects.toThrow('Brain ingestion write mode requires');

    const result = await runBrainIngestion(engine, storage, {
      bucket: 'brain-archive',
      mode: 'pilot',
      sources: ['afirebrand'],
      dryRun: false,
      allowWrites: true,
    });

    expect(result.counters.written).toBe(1);
    const ingestionRunSql = calls
      .filter(c => c.sql.includes('brain_ingestion_runs'))
      .map(c => c.sql)
      .join('\n');
    expect(ingestionRunSql).toContain('items_inserted');
    expect(ingestionRunSql).toContain('items_updated');
    expect(ingestionRunSql).toContain('items_skipped');
    expect(ingestionRunSql).toContain('error_count');
    expect(ingestionRunSql).not.toContain('items_succeeded');
    expect(ingestionRunSql).not.toContain('items_failed');
    expect(calls.some(c => c.sql.includes('ON CONFLICT'))).toBe(true);
  });
});
