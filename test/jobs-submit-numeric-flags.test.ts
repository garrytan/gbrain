/**
 * #5936 (absorbed in agent contract v1 D4): jobs submit rejects malformed
 * numeric flags with an invalid_params usage error (exit 2 via the CLI's
 * renderCliError seam) before anything is enqueued.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { runJobsSubmit } from '../src/commands/jobs/submit.ts';
import { OperationError } from '../src/core/ops/contract.ts';

function makeContext(args: string[]) {
  const added: unknown[][] = [];
  const queue = {
    ensureSchema: async () => {},
    add: async (...input: unknown[]) => {
      added.push(input);
      return { id: 1 };
    },
  };
  return {
    context: { args, engine: { kind: 'postgres' }, queue } as never,
    added,
  };
}

async function invoke(args: string[]) {
  const { context, added } = makeContext(['submit', 'fixture-job', ...args]);
  const logSpy = spyOn(console, 'log').mockImplementation(() => {});
  try {
    let thrown: unknown;
    try { await runJobsSubmit(context); } catch (error) { thrown = error; }
    return { thrown, added };
  } finally {
    logSpy.mockRestore();
  }
}

describe('jobs submit numeric flag validation', () => {
  test.each([
    ['--delay', 'nope', 'non-negative integer'],
    ['--priority', '1.5', 'integer'],
    ['--max-attempts', '2oops', 'positive integer'],
    ['--max-stalled', '-1', 'non-negative integer'],
    ['--backoff-delay', 'Infinity', 'non-negative integer'],
    ['--backoff-jitter', '1.1', 'from 0 to 1'],
    ['--timeout-ms', '3ms', 'positive integer'],
    ['--lock-duration-ms', '9007199254740992', 'positive integer'],
  ])('%s %s is rejected before enqueue', async (flag, value, message) => {
    const { thrown, added } = await invoke([flag, value]);
    expect(thrown, `${flag} assertion: usage error`).toBeInstanceOf(OperationError);
    expect((thrown as OperationError).code).toBe('invalid_params');
    expect((thrown as OperationError).message, `${flag} assertion: reports validation`).toContain(message);
    expect((thrown as OperationError).message).toContain(flag);
    expect((thrown as OperationError).suggestion).toContain(`e.g. ${flag}`);
    expect(added, `${flag} assertion: does not enqueue`).toHaveLength(0);
  });

  test('valid zero delay and zero-valued optional budgets retain their meaning', async () => {
    const { added, thrown } = await invoke([
      '--delay', '0', '--priority', '-2', '--max-stalled', '0', '--backoff-delay', '0', '--backoff-jitter', '0',
    ]);
    expect(thrown).toBeUndefined();
    expect(added).toHaveLength(1);
    expect(added[0]?.[2]).toMatchObject({
      delay: undefined, priority: -2, max_stalled: 0, backoff_delay: 0, backoff_jitter: 0,
    });
  });
});
