/**
 * CLI→MCP gap-closure wave — core/migration-ledger.ts (the get_health
 * migrations block, TODOS:4063). Pins:
 *   - MIGRATION_VERSIONS stays in sync with the real registry (EV4: the core
 *     module carries version strings only, so drift must fail the suite).
 *   - statusForVersion semantics (complete-wins, trailing-retry override,
 *     consecutive-partial wedge cap) — shared with apply-migrations.
 *   - migrationLedgerSummary fixtures incl. skipped_future;
 *   - the get_health OP layer over dispatchToolCall (real PGLiteEngine): the
 *     migrations block carries the four keys, and an unreadable ledger
 *     degrades to {error: 'ledger_unreadable'} without dropping the health
 *     payload itself.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MIGRATION_VERSIONS,
  MAX_CONSECUTIVE_PARTIALS,
  compareVersions,
  statusForVersion,
  indexCompletedEntries,
  migrationLedgerSummary,
} from '../src/core/migration-ledger.ts';
import { migrations } from '../src/commands/migrations/index.ts';
import type { CompletedMigrationEntry } from '../src/core/preferences.ts';
import { withEnv } from './helpers/with-env.ts';

function entry(version: string, status: CompletedMigrationEntry['status']): CompletedMigrationEntry {
  return { ts: '2026-08-16T00:00:00Z', version, status } as CompletedMigrationEntry;
}

describe('MIGRATION_VERSIONS registry sync (EV4)', () => {
  test('matches the real migration registry exactly, in order', () => {
    expect([...MIGRATION_VERSIONS]).toEqual(migrations.map(m => m.version));
  });
});

describe('statusForVersion (shared with apply-migrations)', () => {
  test('no entries → pending; complete wins; trailing retry overrides complete', () => {
    expect(statusForVersion('0.21.0', indexCompletedEntries([]))).toBe('pending');
    expect(statusForVersion('0.21.0', indexCompletedEntries([entry('0.21.0', 'complete')]))).toBe('complete');
    expect(statusForVersion('0.21.0', indexCompletedEntries([
      entry('0.21.0', 'partial'), entry('0.21.0', 'complete'),
    ]))).toBe('complete');
    expect(statusForVersion('0.21.0', indexCompletedEntries([
      entry('0.21.0', 'complete'), entry('0.21.0', 'retry'),
    ]))).toBe('pending');
  });

  test('consecutive-partial cap wedges; a lone partial stays partial', () => {
    expect(statusForVersion('0.28.0', indexCompletedEntries([entry('0.28.0', 'partial')]))).toBe('partial');
    const wedgedEntries = Array.from({ length: MAX_CONSECUTIVE_PARTIALS }, () => entry('0.28.0', 'partial'));
    expect(statusForVersion('0.28.0', indexCompletedEntries(wedgedEntries))).toBe('wedged');
  });
});

describe('compareVersions (canonical home)', () => {
  test('orders MAJOR.MINOR.PATCH', () => {
    expect(compareVersions('0.21.0', '0.28.0')).toBe(-1);
    expect(compareVersions('0.46.3', '0.46.3')).toBe(0);
    expect(compareVersions('1.0.0', '0.99.9')).toBe(1);
  });
});

describe('migrationLedgerSummary', () => {
  test('fixture ledger → pending/partial/wedged buckets + skipped_future count', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-ledger-'));
    // GBRAIN_HOME is a PARENT dir — configDir() appends '.gbrain' itself.
    mkdirSync(join(home, '.gbrain', 'migrations'), { recursive: true });
    const special = new Set(['0.21.0', '0.28.0', '0.29.1']);
    const lines = [
      // Everything complete except: 0.21.0 pending (complete + trailing
      // retry — the only marker that overrides a completion), 0.28.0 partial
      // (a lone partial, never completed), 0.29.1 wedged (cap consecutive
      // partials, never completed).
      ...MIGRATION_VERSIONS.filter(v => !special.has(v)).map(v => JSON.stringify(entry(v, 'complete'))),
      JSON.stringify(entry('0.21.0', 'complete')),
      JSON.stringify(entry('0.21.0', 'retry')),
      JSON.stringify(entry('0.28.0', 'partial')),
      ...Array.from({ length: MAX_CONSECUTIVE_PARTIALS }, () => JSON.stringify(entry('0.29.1', 'partial'))),
    ];
    writeFileSync(join(home, '.gbrain', 'migrations', 'completed.jsonl'), lines.join('\n') + '\n');

    await withEnv({ GBRAIN_HOME: home }, async () => {
      // Installed version below the newest registry entries → they count as
      // skipped_future, not pending.
      const summary = migrationLedgerSummary('0.30.0');
      expect(summary.pending).toContain('0.21.0');
      expect(summary.partial).toEqual(['0.28.0']);
      expect(summary.wedged).toEqual(['0.29.1']);
      const future = MIGRATION_VERSIONS.filter(v => compareVersions(v, '0.30.0') > 0).length;
      expect(summary.skipped_future).toBe(future);
    });
  });

  test('empty ledger at current VERSION → everything registered is pending', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-ledger-empty-'));
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const summary = migrationLedgerSummary('99.0.0');
      expect(summary.pending.length).toBe(MIGRATION_VERSIONS.length);
      expect(summary.skipped_future).toBe(0);
    });
  });
});

describe('get_health op layer (dispatchToolCall, real PGLiteEngine)', () => {
  let engine: import('../src/core/pglite-engine.ts').PGLiteEngine;
  const tmpHomes: string[] = [];

  beforeAll(async () => {
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
    for (const home of tmpHomes.splice(0)) {
      rmSync(home, { recursive: true, force: true });
    }
  });

  const STDIO = { remote: true, transport: 'stdio' as const, sourceId: 'default' };

  test('migrations block carries the four ledger keys', async () => {
    const { dispatchToolCall } = await import('../src/mcp/dispatch.ts');
    // GBRAIN_HOME is a PARENT dir — configDir() appends '.gbrain' itself.
    const home = mkdtempSync(join(tmpdir(), 'gbrain-ledger-op-'));
    tmpHomes.push(home);
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const res = await dispatchToolCall(engine, 'get_health', {}, { ...STDIO });
      expect(res.isError ?? false).toBe(false);
      const body = JSON.parse(res.content[0].text) as {
        page_count: number;
        migrations: { pending: string[]; partial: string[]; wedged: string[]; skipped_future: number };
      };
      expect(Object.keys(body.migrations).sort()).toEqual(['partial', 'pending', 'skipped_future', 'wedged'].sort());
      expect(Array.isArray(body.migrations.pending)).toBe(true);
      expect(Array.isArray(body.migrations.partial)).toBe(true);
      expect(Array.isArray(body.migrations.wedged)).toBe(true);
      expect(typeof body.migrations.skipped_future).toBe('number');
      expect(typeof body.page_count).toBe('number');
    });
  });

  test('unreadable ledger degrades migrations to {error: ledger_unreadable}; health payload survives', async () => {
    const { dispatchToolCall } = await import('../src/mcp/dispatch.ts');
    const home = mkdtempSync(join(tmpdir(), 'gbrain-ledger-op-bad-'));
    tmpHomes.push(home);
    // completed.jsonl as a DIRECTORY: existsSync passes, readFileSync throws
    // EISDIR — the op's best-effort catch must degrade the field only.
    mkdirSync(join(home, '.gbrain', 'migrations', 'completed.jsonl'), { recursive: true });
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const res = await dispatchToolCall(engine, 'get_health', {}, { ...STDIO });
      expect(res.isError ?? false).toBe(false);
      const body = JSON.parse(res.content[0].text) as {
        page_count: number;
        linkable_page_count: number;
        migrations: unknown;
      };
      expect(body.migrations).toEqual({ error: 'ledger_unreadable' });
      // Page-count fields still exist — the degradation never eats the dashboard.
      expect(typeof body.page_count).toBe('number');
      expect(typeof body.linkable_page_count).toBe('number');
    });
  });
});
