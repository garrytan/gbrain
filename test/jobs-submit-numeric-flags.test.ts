import { describe, expect, spyOn, test } from 'bun:test';
import { runJobsSubmit } from '../src/commands/jobs/submit.ts';

const EXIT = '__jobs_submit_exit__';

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
  const errors: string[] = [];
  const errorSpy = spyOn(console, 'error').mockImplementation((message?: unknown) => {
    errors.push(String(message));
  });
  const logSpy = spyOn(console, 'log').mockImplementation(() => {});
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw Object.assign(new Error(EXIT), { code });
  }) as never);
  try {
    let thrown: unknown;
    try { await runJobsSubmit(context); } catch (error) { thrown = error; }
    return { thrown, errors, added };
  } finally {
    errorSpy.mockRestore();
    logSpy.mockRestore();
    exitSpy.mockRestore();
  }
}

describe('jobs submit numeric flag validation', () => {
  test.each([
    ['--delay', 'nope', 'non-negative integer'],
    ['--priority', '1.5', 'integer'],
    ['--max-attempts', '2oops', 'positive integer'],
    ['--max-stalled', '-1', 'non-negative integer'],
    ['--backoff-delay', 'Infinity', 'non-negative integer'],
    ['--backoff-jitter', '1.1', 'between 0 and 1'],
    ['--timeout-ms', '3ms', 'positive integer'],
    ['--lock-duration-ms', '9007199254740992', 'positive integer'],
  ])('%s %s is rejected before enqueue', async (flag, value, message) => {
    const { thrown, errors, added } = await invoke([flag, value]);
    expect((thrown as Error | undefined)?.message, `${flag} assertion: exits with usage error`).toBe(EXIT);
    expect(errors.join('\n'), `${flag} assertion: reports validation`).toContain(message);
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
