/**
 * Postgres vector search: where the stale-flag privilege probe (postgres-engine/timeline-stale-probe.ts) runs.
 * Two properties, the same ones the keyword sites hold (keyword-statement-timeout-knob-6495.test.ts):
 * an engine that never connected sends no probe to the pool, and the probe runs inside the bounded read transaction,
 * after its settings statement. A recording handle stands in for the pool and the transaction.
 */
import { describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { searchSettingsStatement, type SearchSettings } from '../src/core/postgres-engine/search-settings.ts';

const PROBE = /has_table_privilege\('timeline_entries'/;
interface Recorded { lane: 'pool' | 'tx'; sql: string }

function recordingEngine(connected: boolean): { engine: PostgresEngine; recorded: Recorded[] } {
  const engine = new PostgresEngine();
  const recorded: Recorded[] = [];
  const tx = Object.assign(
    async (strings: TemplateStringsArray) => { recorded.push({ lane: 'tx', sql: strings.join('$') }); return Object.assign([], { count: 0 }); },
    { unsafe: async (sql: string) => { recorded.push({ lane: 'tx', sql }); return Object.assign([], { count: 0 }); } },
  );
  const priv = engine as unknown as {
    withScopedReadTransaction: (ids: unknown, id: unknown, cb: (tx: unknown) => Promise<unknown>, opts?: { settings?: SearchSettings | (() => SearchSettings) }) => Promise<unknown>;
    executeRaw: (sql: string, params?: unknown[]) => Promise<unknown[]>;
    _pageTransaction: boolean;
  };
  priv.withScopedReadTransaction = async (_ids, _id, cb, txOpts) => {
    const settings = typeof txOpts?.settings === 'function' ? txOpts.settings() : txOpts?.settings;
    if (settings) { const set = searchSettingsStatement(settings); recorded.push({ lane: 'tx', sql: set.sql }); }
    return cb(tx);
  };
  priv.executeRaw = async sql => {
    recorded.push({ lane: 'pool', sql });
    if (!connected) throw new Error('No database connection');
    return [];
  };
  priv._pageTransaction = true;
  return { engine, recorded };
}

const SITES: Record<string, (engine: PostgresEngine) => Promise<unknown>> = {
  searchVector: engine => engine.searchVector(new Float32Array(4).fill(0.5)),
  explainVectorSearch: engine => engine.explainVectorSearch(new Float32Array(4).fill(0.5)),
};

describe('Postgres vector search: the stale-flag probe', () => {
  for (const site of Object.keys(SITES)) {
    test(`${site}: an engine that never connected sends no probe to the pool`, async () => {
      const { engine, recorded } = recordingEngine(false);
      await SITES[site](engine).catch(() => undefined);
      expect(recorded.filter(r => r.lane === 'pool' && PROBE.test(r.sql)).map(r => r.sql)).toEqual([]);
    });

    test(`${site}: the probe runs inside the read transaction, after its settings`, async () => {
      const { engine, recorded } = recordingEngine(true);
      await SITES[site](engine).catch(() => undefined);
      const probes = recorded.map((r, i) => ({ ...r, i })).filter(r => PROBE.test(r.sql));
      expect(probes.length).toBeGreaterThan(0);
      for (const p of probes) {
        expect(p.lane).toBe('tx');
        expect(recorded.slice(0, p.i).some(r => r.lane === 'tx' && /set_config\('statement_timeout'/.test(r.sql))).toBe(true);
      }
    });
  }
});
