/**
 * #6297: every maintenance pass writes new reflections, so the #4879 evidence
 * watermark never skipped and each pass paid for a patterns child. An
 * in-cycle run now waits `dream.patterns.min_interval_hours` (default 6, 0
 * off) after the partition's last COMPLETED run; a direct
 * `gbrain dream --phase patterns` and `--once` are not held to it, and the
 * external-reflections partition keeps its own stamp.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withTrustBackfill } from '../src/core/persistence/context.ts';

let childStatus = 'completed';

mock.module('../src/core/ai/gateway.ts', () => ({
  probeChatModel: () => ({ ok: true }),
}));

mock.module('../src/core/cycle/synthesize.ts', () => ({
  loadAllowedSlugPrefixes: async () => ['wiki/personal/patterns/*'],
  loadOutputRoot: async () => 'wiki',
  runSubagentsInline: async () => undefined,
}));

mock.module('../src/core/minions/wait-for-completion.ts', () => ({
  TimeoutError: class TimeoutError extends Error {},
  waitForCompletion: async (_queue: unknown, jobId: number) => ({ id: jobId, status: childStatus }),
  waitForCompletionRenewing: async (_queue: unknown, jobId: number, opts?: { renew?: () => Promise<void> }) => {
    if (opts?.renew) await opts.renew();
    return { id: jobId, status: childStatus };
  },
}));

const { runPhasePatterns } = await import('../src/core/cycle/patterns.ts');
const { parsePhaseConfigValue } = await import('../src/core/cycle/phase-config-values.ts');

let engine: PGLiteEngine;
let schemaVersion: string;
let brainDir: string;
let seq = 0;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version')) ?? '7';
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-patterns-cadence-'));
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(brainDir, { recursive: true, force: true });
});

beforeEach(async () => {
  childStatus = 'completed';
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
  await engine.setConfig('models.dream.patterns', 'anthropic:claude-sonnet-4-6');
  for (let i = 0; i < 3; i++) await addReflection();
});

/** A reflection newer than every earlier one, as each maintenance pass writes. */
async function addReflection(tier: string | null = null): Promise<void> {
  seq++;
  const slug = `wiki/personal/reflections/r${seq}`;
  await engine.executeRaw(
    `INSERT INTO pages (slug, type, title, compiled_truth, updated_at) VALUES ($1, 'note', $2, $3, now() + ($4 || ' seconds')::interval)`,
    [slug, `Reflection ${seq}`, `Recurring theme fixture ${seq}.`, String(seq)],
  );
  if (tier) await engine.transaction(tx => withTrustBackfill(tx, () => tx.executeRaw('UPDATE pages SET trust_tier = $2 WHERE slug = $1', [slug, tier])));
}

describe('patterns in-cycle cadence (#6297)', () => {
  test('two in-cycle runs with a new reflection between them: the second is skipped and names the next eligible time', async () => {
    const first = await runPhasePatterns(engine, { brainDir, dryRun: false });
    expect(first.status).toBe('ok');
    await addReflection();
    const second = await runPhasePatterns(engine, { brainDir, dryRun: false });
    expect(second.status).toBe('skipped');
    expect(second.details.reason).toBe('patterns_min_interval');
    expect(second.details.code).toBe('patterns_min_interval');
    expect(second.details.min_interval_hours).toBe(6);
    const last = Date.parse(String(second.details.last_completed_at));
    expect(Date.parse(String(second.details.next_eligible_at))).toBe(last + 6 * 3_600_000);
    expect(second.summary).toContain(String(second.details.next_eligible_at));
    expect((second.details.fix as { argv: string[] }).argv).toEqual(['gbrain', 'dream', '--phase', 'patterns']);
  });

  test('a direct --phase run and --once are not held to the cadence', async () => {
    expect((await runPhasePatterns(engine, { brainDir, dryRun: false })).status).toBe('ok');
    await addReflection();
    expect((await runPhasePatterns(engine, { brainDir, dryRun: false, direct: true })).status).toBe('ok');
    await addReflection();
    expect((await runPhasePatterns(engine, { brainDir, dryRun: false, once: true })).status).toBe('ok');
  });

  test('the cadence counts from the last completed run, not a failed one', async () => {
    childStatus = 'timeout';
    expect((await runPhasePatterns(engine, { brainDir, dryRun: false })).status).toBe('fail');
    childStatus = 'completed';
    expect((await runPhasePatterns(engine, { brainDir, dryRun: false })).status).toBe('ok');
  });

  test('0 turns the cadence off; an elapsed interval runs again', async () => {
    await engine.setConfig('dream.patterns.min_interval_hours', '0');
    expect((await runPhasePatterns(engine, { brainDir, dryRun: false })).status).toBe('ok');
    await addReflection();
    expect((await runPhasePatterns(engine, { brainDir, dryRun: false })).status).toBe('ok');
    await engine.setConfig('dream.patterns.min_interval_hours', '6');
    const [stamp] = await engine.executeRaw<{ key: string }>(`SELECT key FROM config WHERE key LIKE 'dream.patterns.last_completed_at.default.%'`);
    await engine.setConfig(stamp!.key, new Date(Date.now() - 7 * 3_600_000).toISOString());
    await addReflection();
    expect((await runPhasePatterns(engine, { brainDir, dryRun: false })).status).toBe('ok');
  });

  test('the owner pass never throttles the external partition', async () => {
    for (let i = 0; i < 3; i++) await addReflection('external_untrusted');
    const first = await runPhasePatterns(engine, { brainDir, dryRun: false });
    expect(first.status).toBe('ok');
    expect((first.details.external_pass as { status: string }).status).toBe('ok');
    const keys = (await engine.executeRaw<{ key: string }>(`SELECT key FROM config WHERE key LIKE 'dream.patterns.last_completed_at.%' ORDER BY key`)).map(r => r.key);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(`${keys[0]}.external`);
    await engine.executeRaw('DELETE FROM config WHERE key = $1', [keys[1]]);
    await addReflection();
    await addReflection('external_untrusted');
    const second = await runPhasePatterns(engine, { brainDir, dryRun: false });
    expect((second.details.external_pass as { status: string }).status).toBe('ok');
    expect(second.summary).toContain('in-cycle runs wait 6h');
  });

  test('config set accepts the documented ranges only', () => {
    expect(parsePhaseConfigValue('dream.patterns.min_interval_hours', '0')).toBe(0);
    expect(parsePhaseConfigValue('dream.patterns.min_interval_hours', '1.5')).toBe(1.5);
    expect(() => parsePhaseConfigValue('dream.patterns.min_interval_hours', '-1')).toThrow(/min_interval_hours/);
    expect(parsePhaseConfigValue('dream.patterns.child_read_budget_kb', '0')).toBe(0);
    expect(parsePhaseConfigValue('dream.patterns.child_read_budget_kb', '200')).toBe(200);
    expect(() => parsePhaseConfigValue('dream.patterns.child_read_budget_kb', '2.5')).toThrow(/child_read_budget_kb/);
  });
});
