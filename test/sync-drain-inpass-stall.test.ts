/**
 * #6405 (P2.1): every drain stop rule used to run between passes, so a pass that never returned (a publish that neither
 * resolves nor rejects inside a delegated serve) was never stopped and the CLI waited forever. The in-pass governor races
 * the pass: a live head claim in `publishing` past the publication ceiling ends the drain `blocked / drain_stalled /
 * publication_overdue`, with or without the stall line (R6), and the abandoned pass is aborted and its late result ignored.
 * Synthetic results only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { engineStallProbe } from '../src/core/persistence/sync-drain.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { drainNext, formatDrainSummary, runDrain, type DrainClaim, type StallProbe } from '../src/core/persistence/sync-drain.ts';
import { enterClaimPhase, startClaimPhase } from '../src/core/persistence/claim-phase.ts';
import type { SyncResult } from '../src/commands/sync.ts';

const RESUME = 'gbrain sync --source s --no-pull';
const done: SyncResult = { status: 'synced', fromCommit: 'a', toCommit: 'b', added: 0, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [] };
const publishing = (ageMs: number): DrainClaim => ({ phase: 'publishing', step: 'group_commit', waiting_on: 'publication', step_age_ms: ageMs, claim_age_ms: ageMs, lapsed: false,
  owner_pid: 4242, owner_kind: 'serve', owner_nonce: 'n1', last_sql: { label: 'UPDATE persistence_requests', age_ms: ageMs }, allowance_ms: 150_000, ceiling_ms: 600_000 });
const probeWith = (head: () => Promise<{ head_state: string; claim: DrainClaim | null; request_id?: string | null } | null>): StallProbe =>
  ({ blockedHead: async () => null, fingerprint: async () => null, head });

describe('in-pass governor: a publish that never returns', () => {
  for (const announce of [true, false]) {
    test(`a live claim in publishing past the ceiling stops the drain blocked/drain_stalled/publication_overdue (announce: ${announce})`, async () => {
      let passSignal: AbortSignal | undefined;
      const started = Date.now();
      const result = await runDrain({ announce, progressMs: 20, governMs: 10, noProgressMs: 60_000, publicationCeilingMs: 50,
        probe: probeWith(async () => ({ head_state: 'running', request_id: 'req-head', claim: publishing(Date.now() - started) })),
        pass: signal => { passSignal = signal; return new Promise<SyncResult>(() => undefined); } });
      expect(result.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'drain_stalled',
        stall: { cause: 'publication_overdue', in_pass: true, phase: 'publishing', step: 'group_commit', waiting_on: 'publication', head_request_id: 'req-head', owner_pid: 4242, ceiling_ms: 50 } });
      expect(result.drain!.stall!.last_sql?.label).toBe('UPDATE persistence_requests');
      expect(passSignal?.aborted).toBe(true);
      const next = drainNext(result, RESUME, 's')!;
      expect(next).toMatchObject({ command: 'gbrain sources writer status --source s --json', safe_to_loop: false, code: 'drain_stalled', cause: 'publication_overdue' });
      expect(next.why).toContain('restart the gbrain serve process (pid 4242)');
      expect(next.why).toContain('not reclaimed for you');
      expect(formatDrainSummary(result, RESUME, 's').join('\n')).toContain('cause=publication_overdue');
    });
  }

  test('a publish within the ceiling is left alone and the pass result is used', async () => {
    const result = await runDrain({ governMs: 5, noProgressMs: 60_000, publicationCeilingMs: 10_000,
      probe: probeWith(async () => ({ head_state: 'running', claim: publishing(10) })),
      pass: () => new Promise<SyncResult>(resolve => setTimeout(() => resolve({ ...done, managedCursor: { index: 2, total: 2 } }), 80)) });
    expect(result.drain).toMatchObject({ outcome: 'synced', passes: 1 });
  });

  test('a head read that never answers does not park the governor: past the window the stop is no_progress', async () => {
    const result = await runDrain({ governMs: 10, noProgressMs: 60, publicationCeilingMs: 60_000,
      probe: probeWith(() => new Promise(() => undefined)), pass: () => new Promise<SyncResult>(() => undefined) });
    expect(result.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'drain_stalled', stall: { cause: 'no_progress', in_pass: true } });
  }, 15_000);

  test('a late result or rejection of the abandoned pass is dropped', async () => {
    let settle!: (value: SyncResult) => void, fail!: (error: Error) => void;
    const started = Date.now();
    const result = await runDrain({ governMs: 10, noProgressMs: 60_000, publicationCeilingMs: 30,
      probe: probeWith(async () => ({ head_state: 'running', claim: publishing(Date.now() - started) })),
      pass: () => new Promise<SyncResult>((resolve, reject) => { settle = resolve; fail = reject; }) });
    expect(result.drain?.stop_reason).toBe('drain_stalled');
    fail(new Error('late')); settle({ ...done });
    await new Promise(r => setTimeout(r, 20));
    expect(result.drain?.outcome).toBe('blocked');
  });

  test('the publish phase stamps waiting_on publication instead of unknown', () => {
    const clock = startClaimPhase(0);
    expect(clock.waitingOn).toBe('unknown');
    enterClaimPhase(clock, 'publishing', 1);
    expect(clock.waitingOn).toBe('publication');
  });
});

describe('in-pass governor over the real head read (engineStallProbe)', () => {
  const engines: Array<[string, BrainEngine]> = [];
  let closePostgres: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (testBackends().includes('pglite')) { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(['pglite', lite]); }
    if (testBackends().includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(['postgres', pg.engine]); closePostgres = pg.close; }
  }, 120_000);
  afterAll(async () => { for (const [kind, engine] of engines) if (kind === 'pglite') await engine.disconnect(); await closePostgres?.(); });

  test('a running request stamped publishing for 10 minutes stops publication_overdue naming it; with no request left the stop is no_admission', async () => {
    for (const [, engine] of engines) {
      const id = `gov-${randomUUID().slice(0, 8)}`;
      await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, `/tmp/${id}`]);
      const [wt] = await engine.executeRaw<{ id: string }>('INSERT INTO persistence_worktrees(owner_host_id) VALUES(gen_random_uuid()) RETURNING id::text AS id');
      const [src] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [id]);
      await engine.executeRaw('INSERT INTO persistence_source_bindings(source_id,source_incarnation,worktree_id) VALUES($1,$2::uuid,$3::uuid)', [id, src!.incarnation, wt!.id]);
      const token = randomUUID(), at = new Date(Date.now() - 600_000).toISOString();
      const stamp = JSON.stringify({ phase: 'publishing', claimed_at: at, since: at, token, step: null, step_since: at, waiting_on: 'publication', owner: { kind: 'serve', pid: 4343, version: 'test', nonce: 'n2' },
        last_sql: { label: 'UPDATE persistence_requests', at } });
      const [row] = await engine.executeRaw<{ id: string }>(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,worktree_id,digest,authority,intent,intent_bytes,terminal_reservation,
          state,execution_token,claim_expires_at,claim_phase)
        VALUES('local_cli','cli:example',$1::uuid,'submit_job',$2,$3::uuid,'notes/p',$4::uuid,'d','{}'::jsonb,'{"kind":"managed_sync_import","path":"notes/p.md"}'::jsonb,1,16384,'running',$5::uuid,now()+interval '30 seconds',$6::text::jsonb)
        RETURNING id::text AS id`, [randomUUID(), id, src!.incarnation, wt!.id, token, stamp]);
      const probe = engineStallProbe(engine, id);
      const hung = await runDrain({ governMs: 10, noProgressMs: 60_000, publicationCeilingMs: 100, probe, pass: () => new Promise<SyncResult>(() => undefined) });
      expect(hung.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'drain_stalled',
        stall: { cause: 'publication_overdue', in_pass: true, head_request_id: row!.id, head_state: 'running', waiting_on: 'publication', owner_pid: 4343, owner_kind: 'serve' } });
      expect(hung.drain!.stall!.stalled_seconds).toBeGreaterThanOrEqual(599);
      await engine.executeRaw('DELETE FROM persistence_requests WHERE id=$1::uuid', [row!.id]);
      const idle = await runDrain({ governMs: 10, noProgressMs: 80, publicationCeilingMs: 100, probe, pass: () => new Promise<SyncResult>(() => undefined) });
      expect(idle.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'drain_stalled', stall: { cause: 'no_admission', head_request_id: null } });
    }
  }, 60_000);
});
