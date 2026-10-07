/**
 * #6000 / #6045: `doctor --remediation-plan` and `doctor --remediate` preview
 * every automatic repair kind. One kind's preview throwing (a statement
 * timeout on a large Postgres brain) used to abort the whole plan and run.
 *
 * Protects: per-kind isolation (kinds before and after a failing preview are
 * still planned and run), the reported failure contract (code, redacted and
 * capped message, why, read-only fix + verify), exit 1 for a run that left a
 * kind out, the unchanged strict planRepairSteps contract, and consent
 * staying bound to the steps the user was shown.
 * Fails when: a preview error aborts the plan or the run again, a failed kind
 * vanishes from the output or turns into a step, the error text leaks a
 * credential, or an approval made while a kind failed still matches once it
 * previews cleanly.
 * Seam: each registered handler's `plan` method, spied for one test and
 * restored; no production code path is added for the test.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { RepairHandler, RepairKind } from '../src/core/repair/core.ts';
import { AUTO_REPAIR_REGISTRY, repairSpec } from '../src/core/repair/registry.ts';
import { planRepairSteps } from '../src/core/remediation/repairs.ts';
import { computeRemediationPlan, runRemediation } from '../src/core/remediation/index.ts';
import { remediationExitStatus, renderRemediationPlanLines, runRemediate } from '../src/commands/doctor/remediate.ts';
import { remediationPlanHash } from '../src/commands/doctor/remediate-consent.ts';
import { setCliExitVerdict } from '../src/core/cli-force-exit.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-preview-isolation-'));
const spies: Mock<(...args: never[]) => unknown>[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(gbrainHome, { recursive: true, force: true });
});

afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
});

type Behaviour = { pending: string } | { throws: Error };

/** Overrides the named kinds' previews for one test; afterEach restores them. */
function stubPreviews(behaviours: Partial<Record<RepairKind, Behaviour>>): void {
  for (const [kind, behaviour] of Object.entries(behaviours) as [RepairKind, Behaviour][]) {
    const spy = spyOn(repairSpec(kind).handler, 'plan').mockImplementation(async () => {
      if ('throws' in behaviour) throw behaviour.throws;
      const preview: Awaited<ReturnType<RepairHandler['plan']>> = {
        items: [{ cursor: { phase: 0, id: 7 }, source_id: '(brain)', slug: behaviour.pending, chars: 0, action: 'fixture' }], residuals: {},
      };
      return preview;
    });
    spies.push(spy as unknown as Mock<(...args: never[]) => unknown>);
  }
}

const inHome = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: gbrainHome, GBRAIN_NON_INTERACTIVE: '1' }, fn);

const statementTimeout = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
const SECRET = 'hunter2-not-a-real-password';
const credentialError = () => new Error(`could not connect: postgresql://alice-example:${SECRET}@db.acme-example.internal:5432/brain`);

/** timeline (first) and planner-stats (last) have work; two kinds in between fail differently. */
const MIXED: Partial<Record<RepairKind, Behaviour>> = {
  timeline: { pending: 'notes/alpha' },
  'safe-chunks': { throws: credentialError() },
  'attribution-backfill': { throws: statementTimeout() },
  'planner-stats': { pending: 'pages' },
};

describe('repair preview isolation (#6000)', () => {
  test('fixture order: a planned kind on each side of the failing ones', () => {
    const order = AUTO_REPAIR_REGISTRY.map(spec => spec.kind);
    const at = (k: RepairKind) => order.indexOf(k);
    expect(at('timeline')).toBeLessThan(at('safe-chunks'));
    expect(at('safe-chunks')).toBeLessThan(at('attribution-backfill'));
    expect(at('attribution-backfill')).toBeLessThan(at('planner-stats'));
  });

  test('the plan keeps every kind that previewed and reports each failure through the contract', async () => {
    stubPreviews(MIXED);
    const plan = await inHome(() => computeRemediationPlan(engine, { repairs: { noEmbed: true } }));
    expect(plan.repair_steps!.map(s => [s.step, s.kind])).toEqual([[1, 'timeline'], [2, 'planner-stats']]);
    const failures = plan.repair_preview_failures!;
    expect(failures.map(f => [f.kind, f.code])).toEqual([['safe-chunks', 'preview_failed'], ['attribution-backfill', 'timeout']]);
    const [generic, timeout] = failures;
    expect(timeout.message).toBe('canceling statement due to statement timeout');
    expect(timeout.why).toContain('GBRAIN_STATEMENT_TIMEOUT');
    expect(generic.why).not.toContain('GBRAIN_STATEMENT_TIMEOUT');
    expect(timeout.fix.argv).toEqual(['gbrain', 'repair', 'attribution-backfill']);
    expect(timeout.fix.consent).toEqual([]);
    expect(timeout.fix.verify?.argv).toEqual(['gbrain', 'doctor', '--remediation-plan', '--json']);
    expect(JSON.stringify(plan)).not.toContain(SECRET);
  });

  test('the message is redacted first and capped second: never over 300 characters, never a credential', async () => {
    const manySecrets = new Error(Array.from({ length: 80 }, (_, i) => `pwd=k${i}`).join(' '));
    stubPreviews({ 'attribution-backfill': { throws: manySecrets } });
    const plan = await inHome(() => computeRemediationPlan(engine, { repairs: { noEmbed: true } }));
    const [failure] = plan.repair_preview_failures ?? [];
    expect(failure.code).toBe('preview_failed');
    expect(failure.message.length).toBeLessThanOrEqual(300);
    expect(failure.message).toContain('<REDACTED:password>');
    expect(failure.message).not.toMatch(/pwd=k\d/);
  });

  test('negative control: with every preview clean the plan carries no failure field', async () => {
    stubPreviews({ timeline: { pending: 'notes/alpha' } });
    const plan = await inHome(() => computeRemediationPlan(engine, { repairs: { noEmbed: true } }));
    expect(plan.repair_steps!.map(s => s.kind)).toEqual(['timeline']);
    expect(Object.keys(plan)).not.toContain('repair_preview_failures');
    const jobsOnly = await inHome(() => computeRemediationPlan(engine, {}));
    expect(Object.keys(jobsOnly)).not.toContain('repair_preview_failures');
  });

  test('planRepairSteps keeps its strict contract: the original error propagates', async () => {
    const original = statementTimeout();
    stubPreviews({ timeline: { pending: 'notes/alpha' }, 'attribution-backfill': { throws: original } });
    await expect(inHome(() => planRepairSteps(engine, { noEmbed: true }))).rejects.toBe(original);
  });

  test('the human plan lists the failed kinds and never claims the brain is at target', async () => {
    stubPreviews({ 'attribution-backfill': { throws: statementTimeout() } });
    const plan = await inHome(() => computeRemediationPlan(engine, { targetScore: 0, repairs: { noEmbed: true } }));
    expect(plan.repair_steps).toEqual([]);
    const text = renderRemediationPlanLines(plan, 0).join('\n');
    expect(text).toContain('Repair kinds whose preview failed');
    expect(text).toContain('attribution-backfill [timeout]: canceling statement due to statement timeout; to see it again run: gbrain repair attribution-backfill');
    expect(text).not.toContain('Brain is at target');
  });

  test('a run plans and dry-runs the healthy kinds, reports the failed ones and exits 1', async () => {
    stubPreviews(MIXED);
    const result = await inHome(() => runRemediation(engine, { dryRun: true, repairs: { include: true, remote: false, noEmbed: true } }));
    const ids = result.submitted.map(s => s.id);
    expect(ids).toContain('repair:timeline');
    expect(ids).toContain('repair:planner-stats');
    expect(ids.filter(id => id === 'repair:safe-chunks' || id === 'repair:attribution-backfill')).toEqual([]);
    expect(result.repair_preview_failures!.map(f => f.kind)).toEqual(['safe-chunks', 'attribution-backfill']);
    expect(remediationExitStatus(result, [])).toBe(1);
    expect(remediationExitStatus({ ...result, repair_preview_failures: undefined }, [])).toBe(0);
  });

  test('a run where the only repair kind failed takes the nothing-to-do return and still reports it', async () => {
    stubPreviews({ 'attribution-backfill': { throws: statementTimeout() } });
    const result = await inHome(() => runRemediation(engine, { targetScore: 0, dryRun: true, repairs: { include: true, remote: false, noEmbed: true } }));
    expect(result.submitted).toEqual([]);
    expect(result.repair_preview_failures!.map(f => [f.kind, f.code])).toEqual([['attribution-backfill', 'timeout']]);
    expect(remediationExitStatus(result, [])).toBe(1);
  });

  test('an approval given while a kind failed no longer matches once it previews: preview_changed', async () => {
    const args = ['--remediate', '--include-repairs', '--no-embed'];
    stubPreviews({ 'planner-stats': { pending: 'pages' }, 'attribution-backfill': { throws: statementTimeout() } });
    const approvedHash = await inHome(() => remediationPlanHash(engine, args));
    while (spies.length) spies.pop()!.mockRestore();
    stubPreviews({ 'planner-stats': { pending: 'pages' }, 'attribution-backfill': { pending: 'pages#1-1' } });
    expect(await inHome(() => remediationPlanHash(engine, args))).not.toBe(approvedHash);
    const muted = [spyOn(console, 'log').mockImplementation(() => {}), spyOn(console, 'error').mockImplementation(() => {}),
      spyOn(process.stdout, 'write').mockImplementation((() => true) as never)];
    setCliExitVerdict(0);
    try {
      await expect(inHome(() => runRemediate(engine, [...args, '--yes', '--expect', approvedHash, '--json'])))
        .rejects.toMatchObject({ code: 'preview_changed' });
    } finally {
      for (const m of muted) m.mockRestore();
      setCliExitVerdict(0);
    }
  });
});
