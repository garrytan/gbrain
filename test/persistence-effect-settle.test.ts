/**
 * #7423 / #7378 on PGLite: settling Git effects whose retry can never succeed, and retrying a failed push of the
 * current binding. Scenario bodies: test/helpers/effect-settle-scenarios.ts. Postgres arm:
 * test/e2e/w5-persistence-postgres.test.ts.
 */
import { expect, test } from 'bun:test';
import { parsePersistenceAdminArgs } from '../src/commands/persistence-admin.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { dbOnlyTargetSettles, failedCurrentPushRetries, formerWorktreeEffectsSettle, settledEffectIsNotRearmed, withdrawalEffectRefuses } from './helpers/effect-settle-scenarios.ts';

test('#7423 a parked target declared db_only afterwards settles on proof, stays in history, and unsettles', () => dbOnlyTargetSettles(), 180_000);
test('#7378 former-worktree Git effects settle only when the fetched remote holds the current bytes', () => formerWorktreeEffectsSettle(), 240_000);
test('#7423 a settled effect is not re-armed when its request\'s withdrawal mirror commits', () => settledEffectIsNotRearmed(), 180_000);
test('#7378 a withdrawal effect never settles', () => withdrawalEffectRefuses(), 120_000);
test('#7378 a failed push of the current binding without parked targets is retried by --parked-pushes', () => failedCurrentPushRetries(), 120_000);

test('settle-effects parses to the writer_settle_effects extension and refuses conflicting or malformed flags before reading', async () => {
  const hash = 'ph_0123456789abcdef01234567';
  expect(parsePersistenceAdminArgs('writer', ['settle-effects', 'source-a', '--parked-code', 'git_target_unsafe', '--unsettle', '--apply', '--expect', hash, '--json'])).toEqual({
    operation: 'writer_settle_effects', json: true, brain: undefined,
    params: { source_id: 'source-a', parked_code: 'git_target_unsafe', unsettle: true, apply: true, expect: hash } });
  const engine = {} as Parameters<typeof runPersistenceAdministration>[0];
  for (const params of [{ source_id: 'source-a', parked_code: 'x', apply: true, dry_run: true }, { source_id: 'source-a', parked_code: 'Bad Code' },
    { source_id: 'source-a', parked_code: 'x', apply: true, expect: 'not-a-hash' }, { source_id: 'source-a', request_id: 'nope' }, { source_id: 'source-a', force: true }]) {
    await expect(runPersistenceAdministration(engine, 'writer_settle_effects', params)).rejects.toMatchObject({ code: 'invalid_params' });
  }
});
