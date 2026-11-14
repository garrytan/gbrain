/**
 * GBRA-133 lane C: reads a run issues back to back are dependent round trips at a remote database's RTT. Each case
 * counts the waves a read issues (its dependent round trips: a call that needs an earlier result opens a wave) and
 * keeps the result the read returned before. Both backends; test/e2e/read-waves-gbra133-postgres.test.ts runs the Postgres arm in the E2E lane.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { readCapacityForecast } from '../src/core/persistence/capacity-forecast.ts';
import { readExtractionLag } from '../src/core/extraction-lag.ts';
import { getDefaultSourcePath } from '../src/core/source-resolver.ts';
import { mergeDbPlaneConfig } from '../src/cli/db-plane-config.ts';
import { cleanupRetiredManagedMarkers } from '../src/core/persistence/deactivation.ts';
import { freshBrainFactory, requestFixture } from './helpers/persistence-request-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { requestConfigRows, requestConfigValue } from '../src/core/config-snapshot.ts';

/** How long a wave stays open after its statements settle, for statements \`fn\` issues without waiting on a result. */
const WAVE_QUIET_MS = 25;

/**
 * Counts the statements \`fn\` sends and the waves they form: the dependent round trips. Each statement runs at once, but
 * its result is held until its wave closes (every statement in it has settled and none was sent for WAVE_QUIET_MS), and
 * the wave's results are released together, so a statement that needs an earlier result always opens the next wave and
 * statements sent together always share one, however fast the database answers. A config read a request snapshot
 * answers sends nothing and is not counted. The engine's own methods are restored after.
 */
async function recordWaves<T>(engine: BrainEngine, fn: () => Promise<T>): Promise<{ result: T; waves: number; statements: string[] }> {
  let waves = 0;
  const statements: string[] = [];
  let wave: { sent: Promise<unknown>[]; released: Promise<void> } | null = null;
  const settle = async (sent: Promise<unknown>[]) => {
    for (let seen = -1; seen !== sent.length;) {
      seen = sent.length;
      await Promise.all(sent);
      await Bun.sleep(WAVE_QUIET_MS);
    }
    wave = null;
  };
  const target = engine as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const send = (text: string, run: () => Promise<unknown>) => {
    statements.push(text);
    const result = run();
    if (!wave) {
      waves++;
      const sent: Promise<unknown>[] = [];
      wave = { sent, released: Promise.resolve().then(() => settle(sent)) };
    }
    wave.sent.push(result.catch(() => undefined));
    return wave.released.then(() => result);
  };
  const originals = { executeRaw: target.executeRaw!, getConfig: target.getConfig!, getAllConfig: target.getAllConfig! };
  target.executeRaw = function (this: unknown, ...args: unknown[]) {
    return send(String(args[0]).replace(/\s+/g, ' ').trim(), () => originals.executeRaw.apply(this, args));
  };
  target.getConfig = async function (this: unknown, ...args: unknown[]) {
    if (await requestConfigValue(engine, String(args[0])) !== undefined) return originals.getConfig.apply(this, args);
    return send('getConfig(' + String(args[0]) + ')', () => originals.getConfig.apply(this, args));
  };
  target.getAllConfig = async function (this: unknown, ...args: unknown[]) {
    if (await requestConfigRows(engine) !== undefined) return originals.getAllConfig.apply(this, args);
    return send('getAllConfig()', () => originals.getAllConfig.apply(this, args));
  };
  try {
    return { result: await fn(), waves, statements };
  } finally {
    for (const name of Object.keys(originals)) delete target[name];
  }
}

const databaseUrl = process.env.DATABASE_URL;

for (const kind of testBackends()) {
  describe('GBRA-133 read round trips (' + kind + ')', () => {
    let factory: Awaited<ReturnType<typeof freshBrainFactory>>;
    let scratch: string;
    beforeAll(async () => {
      scratch = mkdtempSync(join(tmpdir(), 'gbrain-read-waves-'));
      factory = await freshBrainFactory(kind, databaseUrl);
    }, 120_000);
    afterAll(async () => {
      await factory?.dispose();
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    });
    const check = (name: string, fn: (engine: BrainEngine) => Promise<void>) => test(name, async () => {
      const engine = await factory.fresh();
      await withEnv({ GBRAIN_HOME: scratch, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, () => fn(engine));
    }, 120_000);

    check('the capacity forecast issues its reads together: two waves with a principal counter, not one per read', async engine => {
      const requests = await requestFixture(engine);
      await requests.admit('gbra133-forecast');
      // GBRA-108: a principal row exists for a cap the operator set.
      await engine.setConfig('persistence.limits.principal_lifetime_ids', '2000000');
      const baseline = await readCapacityForecast(engine);
      const { result, waves } = await recordWaves(engine, () => readCapacityForecast(engine));
      expect(waves).toBeLessThanOrEqual(2);
      expect(result).toEqual(baseline);
      expect(result.rows.some(row => row.scope.startsWith('principal:'))).toBe(true);
    });

    check('the extraction lag reads config once and issues the lag count and the mention preview together: two waves', async engine => {
      const { result, waves, statements } = await recordWaves(engine, () => readExtractionLag(engine, { sourceId: 'default' }));
      expect(waves).toBeLessThanOrEqual(2);
      expect(statements.filter(s => /^get(All)?Config\(|FROM config/.test(s)).length).toBe(1);
      expect(result).toMatchObject({ total: 0, actionable: 0, attendance_blocked: 0, held: 0, mention_due: 0 });
    });

    check('the connect-time config merge reads the config table once for the merge and the gateway re-stamp', async engine => {
      const { statements } = await recordWaves(engine, () => mergeDbPlaneConfig(engine, { engine: engine.kind } as never, new WeakMap()));
      expect(statements.filter(s => s === 'getAllConfig()').length).toBe(1);
    });

    check('the default source path comes from the listing the resolution chain already read', async engine => {
      const root = join(scratch, 'gbra133-src');
      await engine.executeRaw("INSERT INTO sources(id,name,local_path) VALUES('gbra133-src','gbra133-src',$1) ON CONFLICT(id) DO UPDATE SET local_path=EXCLUDED.local_path", [root]);
      const { result, statements } = await recordWaves(engine, () => getDefaultSourcePath(engine, tmpdir()));
      expect(result).toBe(root);
      expect(statements.filter(s => s.startsWith('SELECT local_path FROM sources WHERE id'))).toEqual([]);
    });

    check('the default source resolution sends tier 5 with tier 4 and the emptiness guard with the sole-source listing: two waves', async engine => {
      await engine.executeRaw("INSERT INTO sources(id,name,local_path) VALUES('gbra133-sole','gbra133-sole','/nonexistent/gbra133-sole') ON CONFLICT(id) DO NOTHING");
      const { result, waves } = await recordWaves(engine, () => getDefaultSourcePath(engine, tmpdir()));
      expect(waves).toBeLessThanOrEqual(2);
      expect(result).toBe('/nonexistent/gbra133-sole');
    });

    check('the retired-marker cleanup reads the persistence row and the deactivations together', async engine => {
      const { result, waves } = await recordWaves(engine, () => cleanupRetiredManagedMarkers(engine));
      expect(waves).toBeLessThanOrEqual(2);
      expect(result).toEqual({ state: 'cleared', removed: [], pending: [] });
    });
  });
}
