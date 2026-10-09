/**
 * The crash robot's history fixture (`scripts/persistence/history-fixture.ts`).
 *
 * Protects: `buildHistoryFixture(engine, { pages, seed, sources, worktrees })`,
 * the frozen contract engine graduation and the attribution-backfill check
 * build on: every required table holds rows written through real operations
 * (terminal and one queued request, a delayed effect, withdrawals, worktrees,
 * local writers, a unified-grant access token, an OAuth client and token,
 * superseded takes, page versions, chronicle ledger rows), and one seed always
 * yields one logical history.
 * Fails when: an op the fixture drives stops committing, a required table
 * stays empty, the queued request is claimed or the delayed effect runs before
 * the caller starts an owner, or the plan stops being a function of the seed.
 * Seams: none; PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHistoryFixture, HISTORY_FIXTURE_TABLES, historyPlan, type HistoryFixture } from '../scripts/persistence/history-fixture.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

async function build(databaseUrl: string | undefined, seed: number, writeWaitMs?: number): Promise<{ fixture: HistoryFixture; rows: Record<string, unknown> }> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-history-fixture-test-'));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        const fixture = await buildHistoryFixture(engine, { pages: 30, seed, sources: 3, worktrees: 2, root: join(home, 'checkouts'), writeWaitMs });
        const [queued] = await engine.executeRaw('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [fixture.queuedRequestId]);
        const [delayed] = await engine.executeRaw<{ state: string; future: boolean }>(
          'SELECT state,next_attempt_at>now() AS future FROM persistence_effects WHERE id=$1', [fixture.delayedEffectId]);
        const [token] = await engine.executeRaw<{ revision: number; source: unknown }>(
          'SELECT grant_revision AS revision,source_grant AS source FROM access_tokens WHERE id=$1::uuid', [fixture.accessTokenId]);
        const superseded = await engine.executeRaw('SELECT 1 FROM takes WHERE superseded_by IS NOT NULL');
        const terminal = await engine.executeRaw("SELECT 1 FROM persistence_requests WHERE state='committed'");
        const remoteWriters = await engine.executeRaw<{ kind: string }>("SELECT DISTINCT principal_kind AS kind FROM persistence_requests ORDER BY 1");
        return { fixture, rows: { queued, delayed, token, superseded: superseded.length, terminal: terminal.length,
          principals: remoteWriters.map(r => r.kind) } };
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`${backend}: buildHistoryFixture`, () => {
    test('populates every required table through real operations', async () => {
      const { fixture, rows } = await build(databaseUrl, 11);
      for (const table of HISTORY_FIXTURE_TABLES) expect({ table, rows: fixture.counts[table] > 0 }).toEqual({ table, rows: true });
      expect(fixture.observations.every(o => o.status === 'committed')).toBe(true);
      expect(rows.queued).toEqual({ state: 'queued' });
      expect(rows.delayed).toEqual({ state: 'queued', future: true });
      expect(rows.token).toMatchObject({ revision: 1 });
      expect(rows.superseded).toBeGreaterThan(0);
      expect(rows.terminal).toBeGreaterThan(30);
      expect(rows.principals).toEqual(expect.arrayContaining(['legacy_token', 'local_cli', 'oauth_client']));
    }, 240_000);

    // A loaded host can take longer than a write's reply wait (graduation-cli-history
    // saw 2 of 1,000 put_page writes answer write_pending under the CI gate). A 0 ms
    // reply wait forces that on every write: the fixture replays the same request_id
    // until each write commits, and still requires every op to commit.
    test('writes that outlive their reply wait (write_pending) still all commit', async () => {
      const { fixture } = await build(databaseUrl, 11, 0);
      expect(fixture.observations.filter(o => o.status !== 'committed').map(o => `${o.id} ${o.kind} ${o.code}`)).toEqual([]);
    }, 240_000);
  });
}

test('one seed is one logical history; another seed differs', () => {
  const sources = ['history-0', 'history-1', 'history-2'];
  const remotes = [{ name: 'agent-oauth', sourceId: 'history-0' }, { name: 'agent-token', sourceId: 'history-1' }];
  const shape = (seed: number) => historyPlan({ pages: 200, seed, sources: 3, worktrees: 2 }, sources, remotes)
    .map(d => [d.kind, d.actor, d.source, d.requestId, JSON.stringify(d.args).replace(/\d{4}-\d{2}-\d{2}/g, 'DATE')]);
  expect(shape(42)).toEqual(shape(42));
  expect(shape(43)).not.toEqual(shape(42));
  const kinds = new Set(shape(42).map(([kind]) => kind));
  expect([...kinds].sort()).toEqual(['add_timeline_entry', 'delete_page', 'edit_page', 'forget', 'put_page', 'remember',
    'restore_page', 'takes_add', 'takes_supersede']);
});
