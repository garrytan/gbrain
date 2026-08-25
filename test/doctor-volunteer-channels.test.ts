/**
 * volunteer_channels doctor check — per-channel push-context visibility.
 *
 * Engine-aware sibling of retrieval_reflex_health: groups
 * context_volunteer_events by channel (7 days) so operators can see which
 * push channels (reflex/op/watch/claude-code/codex) actually fire. Info-only
 * (status never worse than ok); pre-v117 brains (no table) degrade to a note
 * instead of throwing; transient failures are NOT misreported as pre-v117.
 *
 * Hermetic: stub engine + temp GBRAIN_HOME per test (the check reads the real
 * config for engine-aware guidance and the hook heartbeat for delivery
 * reconciliation — both must come from the temp home, never this machine's).
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkVolunteerChannels } from '../src/commands/doctor.ts';
import { doctorSource } from './helpers/doctor-source.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

function stubEngine(
  rows: Array<{ channel: string; n: number | string; last_fired: string | Date | null }> | Error,
  captured?: Array<{ sql: string; params: unknown[] }>,
): BrainEngine {
  return {
    executeRaw: async (sql: string, params: unknown[]) => {
      captured?.push({ sql, params });
      if (rows instanceof Error) throw rows;
      return rows;
    },
  } as unknown as BrainEngine;
}

/** Temp gbrain home with a config; returns the parent for GBRAIN_HOME. */
function tmpHome(engine: 'pglite' | 'postgres'): string {
  const parent = mkdtempSync(join(tmpdir(), 'dvc-home-'));
  const dir = join(parent, '.gbrain');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify(
      engine === 'pglite'
        ? { engine: 'pglite', database_path: join(dir, 'brain.pglite') }
        : { engine: 'postgres', database_url: 'postgres://u:p@host:5432/db' },
    ),
  );
  return parent;
}

describe('checkVolunteerChannels', () => {
  test('groups active channels with counts + last_fired; status ok', async () => {
    const home = tmpHome('pglite');
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const check = await checkVolunteerChannels(
        stubEngine([
          { channel: 'claude-code', n: 12, last_fired: '2026-08-10T10:00:00Z' },
          { channel: 'reflex', n: 40, last_fired: '2026-08-11T09:00:00Z' },
        ]),
      );
      expect(check.name).toBe('volunteer_channels');
      expect(check.status).toBe('ok');
      expect(check.message).toContain('claude-code=12');
      expect(check.message).toContain('reflex=40');
      const channels = (check.details as { channels: Record<string, { count: number; last_fired: string | null }> }).channels;
      expect(channels['claude-code'].count).toBe(12);
      expect(channels['claude-code'].last_fired).toContain('2026-08-10');
    });
    rmSync(home, { recursive: true, force: true });
  });

  test('quiet week on PGLite: registration/restart diagnosis; status ok (info-only)', async () => {
    const home = tmpHome('pglite');
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const check = await checkVolunteerChannels(stubEngine([]));
      expect(check.status).toBe('ok');
      expect(check.message).toContain('no push-context activity');
      expect(check.message).toContain('RESTARTED'); // hooks snapshot at session start
    });
    rmSync(home, { recursive: true, force: true });
  });

  test('quiet week on Postgres: engine-aware message — never sends the operator chasing hook registration (red-team)', async () => {
    const home = tmpHome('postgres');
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const check = await checkVolunteerChannels(stubEngine([]));
      expect(check.status).toBe('ok');
      expect(check.message).toContain('PGLite serve socket');
      expect(check.message).not.toContain('RESTARTED');
    });
    rmSync(home, { recursive: true, force: true });
  });

  test('heartbeat reconciliation: mostly-degraded hook deliveries surface a CAUTION next to healthy-looking counts (red-team phantom-delivery guard)', async () => {
    const home = tmpHome('pglite');
    const hooksDir = join(home, '.gbrain', 'integrations', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const lines = [
      ...Array.from({ length: 8 }, () => ({ ts: new Date().toISOString(), event: 'user-prompt', outcome: 'degraded', reason: 'deadline' })),
      ...Array.from({ length: 2 }, () => ({ ts: new Date().toISOString(), event: 'user-prompt', outcome: 'ok' })),
    ];
    writeFileSync(join(hooksDir, 'heartbeat.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const check = await checkVolunteerChannels(
        stubEngine([{ channel: 'claude-code', n: 10, last_fired: '2026-08-11T09:00:00Z' }]),
      );
      expect(check.message).toContain('CAUTION');
      expect(check.message).toContain('overstate');
      const hb = (check.details as { hook_heartbeat?: { user_prompt_degraded: number } }).hook_heartbeat;
      expect(hb?.user_prompt_degraded).toBe(8);
    });
    rmSync(home, { recursive: true, force: true });
  });

  test('pre-v117 brain (table absent) → ok with a note, never a throw', async () => {
    const home = tmpHome('pglite');
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const check = await checkVolunteerChannels(stubEngine(new Error('relation "context_volunteer_events" does not exist')));
      expect(check.status).toBe('ok');
      expect(check.message).toContain('pre-v117');
      expect((check.details as { channels: object }).channels).toEqual({});
    });
    rmSync(home, { recursive: true, force: true });
  });

  test('transient failure is NOT misreported as pre-v117 (multi-specialist finding)', async () => {
    const home = tmpHome('pglite');
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const check = await checkVolunteerChannels(stubEngine(new Error('connection reset by peer')));
      expect(check.status).toBe('ok');
      expect(check.message).not.toContain('pre-v117');
      expect(check.message).toContain('transient');
    });
    rmSync(home, { recursive: true, force: true });
  });

  test('engine-parity row shapes: string counts and Date/null last_fired coerce correctly', async () => {
    const home = tmpHome('pglite');
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const check = await checkVolunteerChannels(
        stubEngine([
          { channel: 'op', n: '7', last_fired: null },
          { channel: 'reflex', n: 3, last_fired: new Date('2026-08-10T10:00:00Z') },
        ]),
      );
      const channels = (check.details as { channels: Record<string, { count: number; last_fired: string | null }> }).channels;
      expect(channels['op'].count).toBe(7); // postgres.js bigint-as-string
      expect(channels['op'].last_fired).toBeNull();
      expect(channels['reflex'].last_fired).toContain('2026-08-10'); // Date → ISO
    });
    rmSync(home, { recursive: true, force: true });
  });

  test('source isolation (cross-model P1): a scoped caller\'s query filters on its authorized sources', async () => {
    const home = tmpHome('pglite');
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const captured: Array<{ sql: string; params: unknown[] }> = [];
      await checkVolunteerChannels(stubEngine([], captured), { sourceIds: ['team-a'] });
      expect(captured[0].sql).toContain('source_id = ANY');
      expect(captured[0].params[0]).toEqual(['team-a']);
      // Unscoped (trusted local) stays brain-wide.
      captured.length = 0;
      await checkVolunteerChannels(stubEngine([], captured));
      expect(captured[0].sql).not.toContain('source_id = ANY');
    });
    rmSync(home, { recursive: true, force: true });
  });

  test('wiring pins: the check runs on BOTH doctor paths and serve registers the delivery callback (source greps)', () => {
    const doctorSrc = doctorSource();
    // Local path (buildChecks) AND remote path both push the check — the docs
    // point local operators at `gbrain doctor`, so remote-only is a doc lie.
    const pushes = doctorSrc.match(/checks\.push\(await checkVolunteerChannels\(engine/g) ?? [];
    expect(pushes.length).toBeGreaterThanOrEqual(2);
    // Serve wires the feedback-loop callback — deleting the registration
    // would silently disconnect the hook-lane feedback loop while every unit
    // test stays green (the body lives in volunteer-events.ts; the seam is
    // tested with stub callbacks). #4474 moved the registration into the
    // shared bindResolveIpcForServe helper (src/mcp/resolve-ipc-binding.ts)
    // so stdio serve and `serve --http` wire it identically — pin the
    // callback in the helper AND both serve surfaces routing through it.
    const bindingSrc = readFileSync(join(import.meta.dir, '..', 'src', 'mcp', 'resolve-ipc-binding.ts'), 'utf8');
    expect(bindingSrc).toContain('onTurnContextDelivered');
    expect(bindingSrc).toContain('logTurnContextDeliveryFireAndForget(engine, result, req)');
    const serverSrc = readFileSync(join(import.meta.dir, '..', 'src', 'mcp', 'server.ts'), 'utf8');
    expect(serverSrc).toContain('bindResolveIpcForServe');
    const serveHttpSrc = readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'serve-http.ts'), 'utf8');
    expect(serveHttpSrc).toContain('bindResolveIpcForServe');
  });
});
