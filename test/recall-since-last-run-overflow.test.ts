/**
 * `gbrain recall --since-last-run` must not skip facts when more than one
 * --limit window of new facts arrives between runs.
 *
 * Before this fix the cursor arm reads the NEWEST `limit` rows created
 * since the cursor, then writes the cursor as the run's wall-clock start. The
 * older rows past the window are behind the new cursor and never surface.
 *
 * Every case drives the real `runRecall` entrypoint against a real engine
 * (PGLite here, Postgres through the e2e twin); created_at is pinned with SQL
 * so ordering and ties are exact.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { readCursor, writeCursor, _cursorPathForTests } from '../src/core/recall-cursor-state.ts';
import { runRecall } from '../src/commands/recall.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

for (const backend of testBackends()) describe(`recall --since-last-run paging (${backend})`, () => {
  let engine: BrainEngine;

  beforeAll(async () => {
    if (backend === 'postgres') {
      const { setupDB, getEngine } = await import('./e2e/helpers.ts');
      await setupDB();
      engine = getEngine();
    } else {
      engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
    }
  }, 120_000);
  afterAll(async () => {
    if (backend === 'postgres') {
      const { teardownDB } = await import('./e2e/helpers.ts');
      await teardownDB();
    } else await engine?.disconnect();
  });
  beforeEach(async () => {
    if (backend === 'postgres') await engine.executeRaw('DELETE FROM facts');
    else await resetPgliteState(engine as PGLiteEngine);
  });

  const origWrite = process.stdout.write.bind(process.stdout);
  afterEach(() => { process.stdout.write = origWrite; });

  function tmpHome(): string {
    const dir = join(tmpdir(), `gbrain-recall-overflow-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** One `gbrain recall` call; returns the delivered fact texts. */
  async function recall(args: string[]): Promise<string[]> {
    let out = '';
    process.stdout.write = ((chunk: string | Uint8Array) => { out += chunk.toString(); return true; }) as typeof process.stdout.write;
    try {
      await runRecall(engine, args);
    } finally {
      process.stdout.write = origWrite;
    }
    return (JSON.parse(out).facts as Array<{ fact: string }>).map(f => f.fact);
  }

  /** Insert facts with an exact created_at each (ISO, microsecond precision allowed). */
  async function seed(
    rows: Array<{ fact: string; createdAt: string; validFrom?: Date; source?: string; entity?: string }>,
  ): Promise<void> {
    for (const r of rows) {
      const { id } = await engine.insertFact(
        { fact: r.fact, kind: 'fact', entity_slug: r.entity ?? 'e/overflow', source: 'unit', ...(r.validFrom ? { valid_from: r.validFrom } : {}) },
        { source_id: r.source ?? 'default' },
      );
      await engine.executeRaw('UPDATE facts SET created_at = $1::timestamptz WHERE id = $2', [r.createdAt, id]);
    }
  }

  const base = Date.now() - 60 * 60 * 1000; // an hour ago
  const at = (sec: number) => new Date(base + sec * 1000).toISOString();

  async function drain(args: string[], maxRuns: number): Promise<string[][]> {
    const runs: string[][] = [];
    for (let i = 0; i < maxRuns; i++) runs.push(await recall(args));
    return runs;
  }

  describe('--since-last-run never skips facts past one --limit window', () => {
    test('7 facts, --limit 3: successive runs deliver every fact exactly once', async () => {
      await withEnv({ GBRAIN_HOME: tmpHome() }, async () => {
        writeCursor('default', new Date(base - 1000), 'briefing');
        await seed(Array.from({ length: 7 }, (_, i) => ({ fact: `f${i}`, createdAt: at(i + 1) })));

        const runs = await drain(['--since-last-run', '--json', '--limit', '3'], 4);
        const delivered = runs.flat();
        expect(delivered.sort()).toEqual(['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6']);
        expect(runs.every(r => r.length <= 3)).toBe(true);   // output stays bounded
        expect(runs[3]).toEqual([]);                          // caught up
      });
    });

    test('timestamp ties across the window boundary are neither skipped nor repeated', async () => {
      await withEnv({ GBRAIN_HOME: tmpHome() }, async () => {
        writeCursor('default', new Date(base - 1000), 'briefing');
        // Five rows share one microsecond-precision created_at.
        const tie = new Date(base + 5000).toISOString().replace('Z', '').padEnd(23, '0') + '123Z';
        await seed(Array.from({ length: 5 }, (_, i) => ({ fact: `tie${i}`, createdAt: tie })));

        const delivered = (await drain(['--since-last-run', '--json', '--limit', '2'], 4)).flat();
        expect(delivered.sort()).toEqual(['tie0', 'tie1', 'tie2', 'tie3', 'tie4']);
      });
    });

    test('a backdated (old valid_from) fact in the overflow still surfaces', async () => {
      await withEnv({ GBRAIN_HOME: tmpHome() }, async () => {
        writeCursor('default', new Date(base - 1000), 'briefing');
        const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
        await seed([
          { fact: 'backdated', createdAt: at(1), validFrom: twoDaysAgo },
          ...Array.from({ length: 4 }, (_, i) => ({ fact: `new${i}`, createdAt: at(i + 2) })),
        ]);
        const delivered = (await drain(['--since-last-run', '--json', '--limit', '2'], 3)).flat();
        expect(delivered).toContain('backdated');
        expect(delivered.length).toBe(5);
      });
    });

    test('facts arriving between runs while a backlog drains are not starved or skipped', async () => {
      await withEnv({ GBRAIN_HOME: tmpHome() }, async () => {
        writeCursor('default', new Date(base - 1000), 'briefing');
        await seed(Array.from({ length: 4 }, (_, i) => ({ fact: `old${i}`, createdAt: at(i + 1) })));
        const first = await recall(['--since-last-run', '--json', '--limit', '2']);
        await seed([{ fact: 'arrived', createdAt: new Date().toISOString() }]);
        const rest = (await drain(['--since-last-run', '--json', '--limit', '2'], 3)).flat();
        expect([...first, ...rest].sort()).toEqual(['arrived', 'old0', 'old1', 'old2', 'old3']);
      });
    });

    test('a failed render does not advance the cursor', async () => {
      await withEnv({ GBRAIN_HOME: tmpHome() }, async () => {
        writeCursor('default', new Date(base - 1000), 'briefing');
        await seed(Array.from({ length: 3 }, (_, i) => ({ fact: `r${i}`, createdAt: at(i + 1) })));
        const before = readFileSync(_cursorPathForTests('default', 'briefing'), 'utf8');
        process.stdout.write = (() => { throw new Error('EPIPE'); }) as typeof process.stdout.write;
        await expect(runRecall(engine, ['--since-last-run', '--json', '--limit', '2'])).rejects.toThrow('EPIPE');
        process.stdout.write = origWrite;
        expect(readFileSync(_cursorPathForTests('default', 'briefing'), 'utf8')).toBe(before);
        const delivered = (await drain(['--since-last-run', '--json', '--limit', '2'], 3)).flat();
        expect(delivered.sort()).toEqual(['r0', 'r1', 'r2']);
      });
    });

    test('source isolation and briefing/watch custody hold while paging', async () => {
      await withEnv({ GBRAIN_HOME: tmpHome() }, async () => {
        await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('other', 'other') ON CONFLICT DO NOTHING`);
        writeCursor('default', new Date(base - 1000), 'briefing');
        await seed([
          ...Array.from({ length: 3 }, (_, i) => ({ fact: `d${i}`, createdAt: at(i + 1) })),
          { fact: 'other-source', createdAt: at(2), source: 'other' },
        ]);
        const delivered = (await drain(['--since-last-run', '--json', '--limit', '2', '--source', 'default'], 3)).flat();
        expect(delivered.sort()).toEqual(['d0', 'd1', 'd2']);
        expect(existsSync(_cursorPathForTests('default', 'watch'))).toBe(false);
        expect(existsSync(_cursorPathForTests('other', 'briefing'))).toBe(false);
      });
    });

    test('entity and --grep filters apply before the window while paging', async () => {
      await withEnv({ GBRAIN_HOME: tmpHome() }, async () => {
        writeCursor('default', new Date(base - 1000), 'briefing');
        // Other-entity rows interleave and outnumber the target entity's rows.
        await seed(Array.from({ length: 9 }, (_, i) => ({
          fact: i % 3 === 0 ? `target needle ${i}` : `noise ${i}`,
          createdAt: at(i + 1),
          entity: i % 3 === 0 ? 'e/target' : 'e/noise',
        })));
        const byEntity = (await drain(['e/target', '--since-last-run', '--json', '--limit', '2'], 3)).flat();
        expect(byEntity.sort()).toEqual(['target needle 0', 'target needle 3', 'target needle 6']);

        writeCursor('default', new Date(base - 1000), 'briefing');
        const byGrep = (await drain(['--grep', 'needle', '--since-last-run', '--json', '--limit', '2'], 3)).flat();
        expect(byGrep.sort()).toEqual(['target needle 0', 'target needle 3', 'target needle 6']);
      });
    });

    test('a future or inconsistent keyset cannot skip the backlog (falls back to the legacy cursor)', async () => {
      await withEnv({ GBRAIN_HOME: tmpHome() }, async () => {
        await seed([{ fact: 'unseen', createdAt: at(1) }]);
        const path = _cursorPathForTests('default', 'briefing');
        const legacy = new Date(base - 1000).toISOString();
        writeCursor('default', new Date(legacy), 'briefing'); // creates the cursor dir
        const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().replace('Z', '000Z');
        writeFileSync(path, JSON.stringify({ schema_version: 1, last_run_iso: legacy, after_created_at: tomorrow, after_id: 1 }) + '\n');
        const delivered = (await drain(['--since-last-run', '--json', '--limit', '2'], 2)).flat();
        expect(delivered).toEqual(['unseen']);
      });
    });

    test('caught-up run keeps the legacy wall-clock cursor and newest-first order', async () => {
      await withEnv({ GBRAIN_HOME: tmpHome() }, async () => {
        writeCursor('default', new Date(base - 1000), 'briefing');
        await seed(Array.from({ length: 3 }, (_, i) => ({ fact: `c${i}`, createdAt: at(i + 1) })));
        const t0 = Date.now();
        const delivered = await recall(['--since-last-run', '--json', '--limit', '5']);
        expect(delivered).toEqual(['c2', 'c1', 'c0']);
        const rec = JSON.parse(readFileSync(_cursorPathForTests('default', 'briefing'), 'utf8'));
        expect(Object.keys(rec).sort()).toEqual(['last_run_iso', 'schema_version']);
        expect(readCursor('default', 'briefing')!.getTime()).toBeGreaterThanOrEqual(t0 - 5);
      });
    });
    test('a cursor file written before the keyset existed keeps working, and a paged file stays readable by it', async () => {
      await withEnv({ GBRAIN_HOME: tmpHome() }, async () => {
        writeCursor('default', new Date(base - 1000), 'briefing'); // creates the cursor dir
        const path = _cursorPathForTests('default', 'briefing');
        // The exact bytes an older gbrain wrote: schema_version 1, wall clock only.
        writeFileSync(path, JSON.stringify({ schema_version: 1, last_run_iso: new Date(base - 1000).toISOString() }) + '\n');
        await seed(Array.from({ length: 3 }, (_, i) => ({ fact: `v1-${i}`, createdAt: at(i + 1) })));
        expect(await recall(['--since-last-run', '--json', '--limit', '2'])).toEqual(['v1-1', 'v1-0']);
        // The paged record is still schema_version 1; its last_run_iso is the newest
        // delivered row, so an older reader only re-delivers from there, never skips.
        const rec = JSON.parse(readFileSync(path, 'utf8'));
        expect(rec.schema_version).toBe(1);
        expect(readCursor('default', 'briefing')!.toISOString()).toBe(at(2));
        expect(await recall(['--since-last-run', '--json', '--limit', '2'])).toEqual(['v1-2']);
      });
    });
  });
});
