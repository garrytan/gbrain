/**
 * #5157 DX-O3(a): doctor `legacy_job_authority` counts exactly the claim
 * gate's population (live rows with SQL NULL or unsupported authority, keyed
 * or not), splits authorizable from unsupported, reports terminal keyed SQL
 * NULL rows separately, and the post-upgrade banner names the read-only
 * recovery preview when live rows exist.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { assertNoUnreviewedJobs } from '../src/core/minions/submission-authority.ts';
import { legacyJobAuthorityBannerNote, legacyJobAuthorityCheck, legacyJobAuthorityEntry } from '../src/commands/doctor/checks/legacy-job-authority.ts';
import { postUpgradeRecoveryBanner } from '../src/commands/doctor/upgrade-banner.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  queue = new MinionQueue(engine);
}, 60_000);
afterAll(async () => { await engine?.disconnect(); }, 60_000);
beforeEach(async () => { await engine.executeRaw('DELETE FROM minion_jobs'); });

async function row(status: string, authority: string | null, key?: string): Promise<number> {
  const job = await queue.add('fixture', { n: Math.random() }, key ? { idempotency_key: key } : {});
  if (status === 'active') {
    await engine.executeRaw(`UPDATE minion_jobs SET status = 'active', lock_token = 't', lock_until = now() + interval '1 hour', claim_generation = claim_generation + 1 WHERE id = $1`, [job.id]);
  } else if (status !== 'waiting') {
    await engine.executeRaw('UPDATE minion_jobs SET status = $2 WHERE id = $1', [job.id, status]);
  }
  await engine.executeRaw('UPDATE minion_jobs SET submission_authority = $2::text::jsonb WHERE id = $1', [job.id, authority]);
  return job.id;
}
async function gateCount(): Promise<number> {
  try { await assertNoUnreviewedJobs(engine); return 0; }
  catch (error) { return Number(/(\d+) legacy jobs/.exec((error as Error).message)![1]); }
}

describe('legacy_job_authority doctor check', () => {
  test('a brain without legacy rows is ok', async () => {
    await queue.add('fixture', {});
    const check = await legacyJobAuthorityCheck(engine);
    expect(check).toMatchObject({ name: 'legacy_job_authority', status: 'ok', message: 'No queued job predates submission authority.' });
    expect(await legacyJobAuthorityBannerNote(engine)).toBeNull();
  });

  test('terminal keyed SQL NULL rows are reported separately and need no operator step', async () => {
    await row('completed', null, 'k1');
    await row('dead', null, 'k2');
    await row('failed', null);
    const check = await legacyJobAuthorityCheck(engine);
    expect(check.status).toBe('ok');
    expect(check.details).toMatchObject({ live: 0, terminal_keyed: { completed: 1, dead: 1 }, terminal_keyed_total: 2 });
    expect(check.message).toContain('2 finished job row(s) from before the upgrade');
    expect(await gateCount()).toBe(0);
    expect(await legacyJobAuthorityBannerNote(engine)).toBeNull();
  });

  test('live rows fail with the gate count, the authorizable/unsupported split and the filled recovery', async () => {
    await row('waiting', null, 'keyed');
    await row('waiting', null);
    await row('paused', null);
    const active = await row('active', null);
    const jsonbNull = await row('delayed', 'null');
    const future = await row('waiting', '{"version":2,"kind":"application"}');
    await row('completed', null, 'old');
    await queue.add('fixture', { healthy: true });
    const check = await legacyJobAuthorityCheck(engine);
    expect(check.status).toBe('fail');
    expect(check.details).toMatchObject({
      live: 6, authorizable_total: 4, unsupported: 2, authorizable: { waiting: 2, paused: 1, active: 1 },
      unsupported_ids: [jsonbNull, future], active_ids: [active], terminal_keyed_total: 1,
    });
    expect(check.details!.live).toBe(await gateCount());
    expect(check.message).toContain('6 queued job(s) predate submission authority and block every worker (4 authorizable with SQL NULL authority, 2 unsupported)');
    expect(check.message).toContain('Stop producers (gbrain serve, gbrain autopilot) and workers');
    expect(check.message).toContain(`cancel active jobs (gbrain jobs cancel ${active})`);
    expect(check.message).toContain('preview with gbrain jobs authorize-legacy --select "status=waiting|delayed|waiting-children|paused"');
    expect(check.message).toContain('apply with the printed --expect <hash> --yes, then restart them');
    expect(check.message).toContain(`gbrain jobs cancel ${jsonbNull}; gbrain jobs cancel ${future}`);
    expect(check.message).toContain('docs/guides/repair.md#legacy-job-authority');
    const [fromEntry] = await legacyJobAuthorityEntry.run({ engine } as never) as Array<{ name: string }>;
    expect(fromEntry!.name).toBe('legacy_job_authority');
  });

  test('the post-upgrade banner names the read-only preview, never an applying command', async () => {
    await row('waiting', null, 'keyed');
    await row('paused', 'null');
    const lines = await postUpgradeRecoveryBanner(engine, 'host (pglite, id test-brain)');
    const text = lines.join('\n');
    expect(text).toContain('[AGENT]   legacy_job_authority: 2 queued job(s) from before v0.50 block every worker.');
    expect(text).toContain('preview with: gbrain jobs authorize-legacy --select "status=waiting|delayed|waiting-children|paused"');
    expect(text).toContain('1 unsupported row(s) need matching versions or gbrain jobs cancel <id>');
    expect(text).not.toContain('--yes');
    expect(text).not.toContain('--apply');
    for (const line of lines.filter(Boolean)) expect(line).toStartWith('[AGENT]');
  }, 120_000);
});
