/**
 * #6277: a classic Postgres brain refuses page writes to a filesystem source
 * with `owner_unavailable` / `detail: unbound_source`.
 *
 * Protects the agent contract of that refusal: classic sync imports commits,
 * so the hint must name the commit (an agent following "edit and sync" imports
 * nothing); a remote caller is told to hand the steps to the user; and the
 * envelope is not retryable and asks the user, because the refusal is a
 * configuration state and every way out is a brain-wide decision.
 */
import { describe, expect, test } from 'bun:test';
import { cliRenderContext, toAgentError } from '../src/core/agent-output.ts';
import { unboundSourceError } from '../src/core/persistence/unbound-source.ts';

const cli = (e: unknown) => toAgentError(e, { transport: 'cli', command: 'put', render: cliRenderContext({ routing: undefined }) });
const mcp = (e: unknown) => toAgentError(e, { transport: 'stdio', op: 'put_page', render: { transport: 'stdio', isCallable: () => true, preapproved: () => false } });

describe('unbound_source on a classic Postgres brain (#6277)', () => {
  test('trusted local: write the file, commit it, then classic sync; not retryable; ask the user', () => {
    const env = cli(unboundSourceError('notes', '/abs/notes', 'database_only_eligible', true));
    expect(env.code).toBe('owner_unavailable');
    expect(env.detail).toBe('unbound_source');
    expect(env.suggestion).toContain('/abs/notes/<slug>.md');
    expect(env.suggestion).toContain('commit it in that checkout, then run gbrain sync --source notes');
    expect(env.retryable).toBe(false);
    expect(env.fix?.next).toBe('ask_user');
    expect(env.fix?.user_message).toContain('commit it and run gbrain sync --source notes');
  });

  test('remote: the steps go to the user, with no host path', () => {
    const env = mcp(unboundSourceError('notes', null, 'file_backed', true));
    expect(env.suggestion).toContain('ask the user to write the page as <slug>.md');
    expect(env.suggestion).toContain('commit it, and run gbrain sync --source notes');
    expect(env.suggestion).not.toContain('/abs');
    expect(env.retryable).toBe(false);
    expect(env.fix?.next).toBe('ask_user');
    expect(env.fix?.user_message).toContain("Your brain is in classic mode, so I can't save pages directly.");
  });

  test('managed mode keeps its bind / database_only guidance and is not retryable either', () => {
    const env = cli(unboundSourceError('notes', '/abs/notes', 'database_only_eligible'));
    expect(env.suggestion).toContain('gbrain sources writer claim notes --path /abs/notes');
    expect(env.suggestion).not.toContain('commit it');
    expect(env.retryable).toBe(false);
    expect(env.fix?.next).toBe('ask_user');
  });
});
