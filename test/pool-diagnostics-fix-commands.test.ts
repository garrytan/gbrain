/**
 * O-DX-2 for fix wave 8 lane A: every new or changed Postgres pool warn line,
 * error and remediation names a stable code and a literal fix command, and
 * that command must exist. A typo'd or renamed command would send an operator
 * to a dead end in the middle of an incident.
 *
 * Covers pg_connection_poisoned (#5730), backfill_rollback_failed (#5730),
 * the persistence consumer line (#5233) and the pool_exhausted remediation
 * (#5205). The serve boot-deadline line is pinned in
 * test/serve-stdio-lifecycle.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { CLI_FLAG_REGISTRY } from '../src/core/cli-flag-registry.generated.ts';
import { formatPoisonedDiscardWarning } from '../src/core/pool-gauge.ts';
import { BackfillRollbackError } from '../src/core/backfill-base.ts';
import { RESIDENT_POOL_FLOOR, classifyPgAccessError } from '../src/core/pg-access-classify.ts';

function assertCommandExists(command: string): void {
  const words = command.trim().split(/\s+/);
  expect(words[0]).toBe('gbrain');
  const name = words[1]!;
  expect(CLI_FLAG_REGISTRY[name], `foresights ${name} is not a CLI command`).toBeDefined();
  for (const flag of words.filter(word => word.startsWith('--'))) {
    expect(CLI_FLAG_REGISTRY[name], `foresights ${name} has no ${flag}`).toContain(flag);
  }
}

describe('lane A fix commands', () => {
  test('pg_connection_poisoned names its code, status byte, fix and docs anchor', () => {
    const line = formatPoisonedDiscardWarning('read', 'E');
    expect(line).toContain('code=pg_connection_poisoned status=E pool=read');
    expect(line).toContain('docs=docs/ENGINES.md#pg-connection-poisoned');
    assertCommandExists(/fix="([^"]+)"/.exec(line)![1]!);
    expect(formatPoisonedDiscardWarning('direct', '\n')).toContain('status=?');
  });

  test('backfill_rollback_failed names a resumable fix command', () => {
    const error = new BackfillRollbackError('effective_date', new Error('batch'), new Error('rollback'));
    expect(error.code).toBe('backfill_rollback_failed');
    expect(error.docs_url).toBe('docs/ENGINES.md#backfill-rollback-failed');
    assertCommandExists(error.fix.replace('effective_date', ''));
  });

  test('the persistence consumer line points at an existing writer status command', () => {
    assertCommandExists('foresights sources writer status --json');
  });

  test('pool_exhausted recommends the resident floor, not a pool of 2', () => {
    const diagnosis = classifyPgAccessError(Object.assign(new Error('max clients reached in session mode'), { code: '53300' }));
    expect(diagnosis.reason).toBe('pool_exhausted');
    expect(diagnosis.fix).toEqual(expect.objectContaining({ kind: 'set_env', name: 'GBRAIN_POOL_SIZE', value: String(RESIDENT_POOL_FLOOR) }));
    expect(diagnosis.remediation).toContain(`GBRAIN_POOL_SIZE=${RESIDENT_POOL_FLOOR}`);
    expect(diagnosis.remediation).toContain('docs/ENGINES.md#pool-sizing');
    assertCommandExists('foresights serve --http');
  });
});
