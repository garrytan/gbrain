/**
 * C1 (agent operator wave): `gbrain doctor --remediate` asks before any work.
 *
 * Protects: a non-interactive run without authorization changes nothing and
 * exits 3 with the consent payload (`--json` never implies consent); with
 * `--include-repairs` the approval binds the plan (`--yes --expect
 * <plan_hash>`, the same hash `--remediation-plan` prints); a stale
 * `--expect` refuses with `preview_changed`; `--yes` without `--max-usd`
 * runs under a derived cap, never uncapped.
 *
 * Fails on the base: `--remediate --json` with no `--yes` ran the job steps
 * for non-TTY callers, and `--yes --include-repairs` applied repairs with no
 * plan binding. Seam: the real CLI handler (`runRemediate`) on a PGLite brain
 * seeded with three repairable wave findings.
 */
import { expect, spyOn, test } from 'bun:test';
import { runRemediate, runRemediationPlan } from '../src/commands/doctor/remediate.ts';
import { remediationPlanHash } from '../src/commands/doctor/remediate-consent.ts';
import { listRemediationCheckpoints } from '../src/core/remediation-checkpoint.ts';
import { currentExitCode, setCliExitVerdict } from '../src/core/cli-force-exit.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { waveBrain } from './helpers/wave-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

const KINDS = ['timeline', 'visibility', 'safe_index'] as const;

async function run(engine: BrainEngine, args: string[], fn = runRemediate) {
  let stdout = '';
  let stderr = '';
  const out = spyOn(process.stdout, 'write').mockImplementation(((c: string | Uint8Array) => { stdout += String(c); return true; }) as never);
  const err = spyOn(process.stderr, 'write').mockImplementation(((c: string | Uint8Array) => { stderr += String(c); return true; }) as never);
  const log = spyOn(console, 'log').mockImplementation((...p: unknown[]) => { stdout += `${p.join(' ')}\n`; });
  const error = spyOn(console, 'error').mockImplementation((...p: unknown[]) => { stderr += `${p.join(' ')}\n`; });
  setCliExitVerdict(0);
  try {
    await withEnv({ GBRAIN_NON_INTERACTIVE: '1' }, () => fn(engine, args));
  } finally {
    out.mockRestore(); err.mockRestore(); log.mockRestore(); error.mockRestore();
  }
  const exit = currentExitCode();
  setCliExitVerdict(0);
  return { stdout, stderr, exit };
}

const timeline = (engine: BrainEngine) => engine.executeRaw("SELECT timeline FROM pages WHERE slug='notes/history'");

test('unauthorized and --json-only runs change nothing and exit 3 with the consent payload', async () => {
  await waveBrain(async ({ engine }) => {
    const before = await timeline(engine);
    const hash = await remediationPlanHash(engine, ['--remediate', '--include-repairs']);
    const r = await run(engine, ['--remediate', '--include-repairs', '--json']);
    expect(r.exit).toBe(3);
    const payload = JSON.parse(r.stdout);
    expect(payload).toMatchObject({ status: 'confirmation_required', code: 'confirmation_required', effects: ['paid', 'destructive'], actor: 'agent', contract_version: 1 });
    // A1 explicit routing: the approved command names the brain it was previewed on.
    expect(payload.fix.argv).toEqual(['gbrain', 'doctor', '--remediate', '--include-repairs', '--json', '--brain', 'host', '--yes', '--expect', hash]);
    expect(payload.fix.next).toBe('ask_user');
    expect(payload.preview.argv).toEqual(['gbrain', 'doctor', '--remediation-plan', '--target-score', '90', '--json', '--brain', 'host']);
    expect(payload.user_message).toContain('Run the brain remediation now');
    expect(payload.user_message).toContain('timeline: 1');
    expect(await timeline(engine)).toEqual(before);
    expect(listRemediationCheckpoints()).toEqual([]);

    const human = await run(engine, ['--remediate', '--include-repairs']);
    expect(human.exit).toBe(3);
    expect(human.stdout).toContain('[AGENT]');
    expect(human.stdout).toContain('[SHOW USER]');
    expect(human.stdout).toContain(`--expect ${hash}`);
    expect(await timeline(engine)).toEqual(before);

    // Nothing runnable without the repairs (no job step on this brain): the run only reports, no consent needed.
    const report = await run(engine, ['--remediate', '--json']);
    expect(report.stdout).not.toContain('confirmation_required');
    expect(JSON.parse(report.stdout.slice(report.stdout.indexOf('{'))).repairs_skipped).toHaveLength(3);
    expect(await timeline(engine)).toEqual(before);
  }, { kinds: [...KINDS] });
}, 120_000);

test('--include-repairs binds the plan: --yes alone refuses, the fix and --remediation-plan carry the same --expect hash, a stale hash is preview_changed', async () => {
  await waveBrain(async ({ engine }) => {
    const before = await timeline(engine);
    const hash = await remediationPlanHash(engine, ['--remediate', '--include-repairs', '--no-embed']);
    const refused = await run(engine, ['--remediate', '--yes', '--include-repairs', '--no-embed', '--json']);
    expect(refused.exit).toBe(3);
    const payload = JSON.parse(refused.stdout);
    expect(payload.effects).toEqual(['paid', 'destructive']);
    expect(payload.plan_hash).toBe(hash);
    expect(payload.fix.argv.slice(-2)).toEqual(['--expect', hash]);
    expect(payload.preapprove_argv).toBeUndefined();
    expect(payload.risk).toContain('no automatic undo');
    expect(await timeline(engine)).toEqual(before);

    const plan = await run(engine, ['--remediation-plan', '--no-embed', '--json'], runRemediationPlan);
    const body = JSON.parse(plan.stdout);
    expect(body.plan_hash).toBe(hash);
    expect(body.combined_command).toEndWith(`--no-embed --expect ${hash}`);

    await expect(run(engine, ['--remediate', '--yes', '--include-repairs', '--no-embed', '--expect', 'ph_stale', '--json']))
      .rejects.toMatchObject({ code: 'preview_changed' });
    expect(await timeline(engine)).toEqual(before);

    const agreed = await run(engine, ['--remediate', '--yes', '--include-repairs', '--no-embed', '--max-usd', '1', '--expect', hash, '--json']);
    const result = JSON.parse(agreed.stdout);
    expect(result.repairs.map((r: { kind: string; status: string }) => [r.kind, r.status]))
      .toEqual([['timeline', 'completed'], ['visibility', 'completed'], ['safe-chunks', 'completed']]);
    expect(await timeline(engine)).not.toEqual(before);
  }, { kinds: [...KINDS] });
}, 120_000);

test('--yes without --max-usd runs under a printed derived cap, never uncapped', async () => {
  await waveBrain(async ({ engine }) => {
    const hash = await remediationPlanHash(engine, ['--remediate', '--include-repairs', '--no-embed']);
    const r = await run(engine, ['--remediate', '--yes', '--include-repairs', '--no-embed', '--expect', hash, '--json']);
    expect(r.stderr).toMatch(/\[consent\] doctor --remediate: cost cap \$0\.25/);
    const body = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    expect(body.budget).toMatchObject({ max_usd: 0.25 });
    expect(body.repairs_completed).toBe(3);
  }, { kinds: [...KINDS] });
}, 120_000);
