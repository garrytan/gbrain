/**
 * Recovery layer (fix wave 3, Lane D) on PGLite: remote host-action lines,
 * repair steps in the remediation plan and run, consent, the scripted
 * recovery run's finding classes and exit status, the cumulative budget and
 * resume contract, and the PROTECTED boundary. test/e2e/recovery-layer.test.ts
 * runs the same scenarios on Postgres.
 */
import { describe, test } from 'bun:test';
import {
  budgetAndResumeContract, planListsRepairStepsIndependentOfTarget, remediateWithoutConsentSkipsRepairs,
  remoteCallerCannotRunRepairs, remoteLinesForWaveFindings, scriptedRecoveryRun, swallowedExhaustionIsReported, jobsRecheckedAfterRepairReservations, pendingEmbeddingsResume,
} from './helpers/wave-scenarios.ts';

describe('recovery layer (PGLite)', () => {
  test('remote doctor shows one sanitized host-action line per wave finding, none when clean, unknown when a check cannot run', () => remoteLinesForWaveFindings(), 180_000);
  test('--remediation-plan lists repair steps with commands, independent of the score target', () => planListsRepairStepsIndependentOfTarget(), 180_000);
  test('--remediate --yes without --include-repairs skips repairs and exits non-zero', () => remediateWithoutConsentSkipsRepairs(), 180_000);
  test('scripted recovery run classifies every finding and exits 0', async () => {
    const measured = await scriptedRecoveryRun();
    console.error(`[recovery-run] pglite wall_ms=${measured.wall_ms} operator_commands=${measured.operator_commands}`);
  }, 300_000);
  test('zero budget runs free repairs, refuses the paid one, and resume keeps cap and consent', () => budgetAndResumeContract(), 180_000);
  test('a remote caller cannot run PROTECTED repair steps', () => remoteCallerCannotRunRepairs(), 180_000);
  test('a budget exhaustion a callee swallowed still marks the paid step and refuses later paid steps', () => swallowedExhaustionIsReported(), 180_000);
  test('reserved repair estimates reduce what job steps may spend', () => jobsRecheckedAfterRepairReservations(), 180_000);
  test('embeddings cut short after re-sealing resume from the checkpoint', () => pendingEmbeddingsResume(), 180_000);
});
