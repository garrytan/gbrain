/**
 * Postgres arms of the recovery-layer scenarios (fix wave 3, Lane D). Each run
 * gets a fresh isolated database from the managed-brain helper.
 */
import { describe, test } from 'bun:test';
import {
  budgetAndResumeContract, planListsRepairStepsIndependentOfTarget, remediateWithoutConsentSkipsRepairs,
  remoteCallerCannotRunRepairs, remoteLinesForWaveFindings, scriptedRecoveryRun, swallowedExhaustionIsReported, jobsRecheckedAfterRepairReservations, pendingEmbeddingsResume,
} from '../helpers/wave-scenarios.ts';

const url = process.env.DATABASE_URL;
describe.skipIf(!url)('recovery layer (Postgres)', () => {
  test('remote doctor host-action lines', () => remoteLinesForWaveFindings(url), 240_000);
  test('remediation plan lists repair steps independent of the target', () => planListsRepairStepsIndependentOfTarget(url), 240_000);
  test('--remediate without --include-repairs skips repairs', () => remediateWithoutConsentSkipsRepairs(url), 240_000);
  test('scripted recovery run', async () => {
    const measured = await scriptedRecoveryRun(url);
    console.error(`[recovery-run] postgres wall_ms=${measured.wall_ms} operator_commands=${measured.operator_commands}`);
  }, 300_000);
  test('zero budget, paid refusal and resume contract', () => budgetAndResumeContract(url), 240_000);
  test('remote caller cannot run repairs', () => remoteCallerCannotRunRepairs(url), 240_000);
  test('a swallowed budget exhaustion is still reported', () => swallowedExhaustionIsReported(url), 240_000);
  test('job steps are rechecked after repair reservations', () => jobsRecheckedAfterRepairReservations(url), 240_000);
  test('pending embeddings resume from the checkpoint', () => pendingEmbeddingsResume(url), 240_000);
});
