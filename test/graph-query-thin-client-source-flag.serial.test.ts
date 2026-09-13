/**
 * `gbrain graph-query --source <id>` on a thin-client install.
 *
 * The help text promises "an unknown source is a hard error", and the local
 * branch honors it. The thin-client branch used to call the remote
 * `traverse_graph` op (which has no `source_id` param) and silently drop
 * both `--source` and `--include-foreign`: the grant-wide walk rendered with
 * exit 0 and no warning, so a user relying on the flag to confirm a source's
 * isolation got a misleading answer. Now `--source` is rejected (exit 1, same
 * policy as applyThinClientSourceScope) and `--include-foreign` warns that it
 * is not forwarded.
 *
 * Serial file: mock.module patches live bindings process-wide (config.ts
 * isThinClient → true; mcp-client.ts callRemoteTool → recorded).
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { withEnv } from './helpers/with-env.ts';

type Call = { name: string; params: Record<string, unknown> };
const calls: Call[] = [];

const realConfig = await import('../src/core/config.ts');
mock.module('../src/core/config.ts', () => ({
  ...realConfig,
  loadConfig: () => ({ engine: 'pglite', remote_mcp: { url: 'https://brain.example.test/mcp', token: 'tok' } }),
  isThinClient: () => true,
}));

const realMcpClient = await import('../src/core/mcp-client.ts');
mock.module('../src/core/mcp-client.ts', () => ({
  ...realMcpClient,
  callRemoteTool: async (_cfg: unknown, name: string, params: Record<string, unknown>) => {
    calls.push({ name, params });
    return { content: [{ type: 'text', text: JSON.stringify([]) }] };
  },
}));

const { runGraphQuery } = await import('../src/commands/graph-query.ts');

class ExitSentinel extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
  }
}

async function run(args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const savedLog = console.log;
  const savedError = console.error;
  const savedExit = process.exit;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(' ')); };
  (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
    throw new ExitSentinel(code ?? 0);
  }) as never;
  try {
    // Thin client: the engine is never touched.
    await runGraphQuery({} as never, args);
    return { code: 0, out, err };
  } catch (e) {
    if (e instanceof ExitSentinel) return { code: e.code, out, err };
    throw e;
  } finally {
    console.log = savedLog;
    console.error = savedError;
    (process as unknown as { exit: typeof savedExit }).exit = savedExit;
  }
}

beforeEach(() => { calls.length = 0; });

describe('graph-query --source on a thin-client install', () => {
  test('--source is rejected with exit 1 and never reaches the wire', async () => {
    const r = await run(['people/alice-example', '--depth', '1', '--source', 'nosuch']);
    expect(r.code).toBe(1);
    const stderr = r.err.join('\n');
    expect(stderr).toContain('--source');
    expect(stderr).toContain('thin-client');
    expect(calls).toHaveLength(0);
    expect(r.out).toHaveLength(0);
  });

  test('--source=<id> form is rejected the same way', async () => {
    const r = await run(['people/alice-example', '--source=team']);
    expect(r.code).toBe(1);
    expect(calls).toHaveLength(0);
  });

  test('--include-foreign warns that it is not forwarded (the grant bounds the walk)', async () => {
    const r = await run(['people/alice-example', '--depth', '1', '--include-foreign']);
    expect(r.code).toBe(0);
    expect(r.err.join('\n')).toContain('--include-foreign');
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('traverse_graph');
    // Wire shape unchanged: no source_id / include_foreign leaks onto the op.
    expect(Object.keys(calls[0].params).sort()).toEqual(['depth', 'direction', 'link_type', 'slug']);
  });

  test('no scope flags: silent remote walk with the exact wire params', async () => {
    const r = await run(['people/alice-example', '--depth', '2', '--type', 'attended', '--direction', 'in']);
    expect(r.code).toBe(0);
    expect(r.err).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual({ slug: 'people/alice-example', depth: 2, link_type: 'attended', direction: 'in' });
  });

  // Wave review: a valueless --source used to skip the thin-client refusal
  // (the parser dropped the flag), and an ambient GBRAIN_SOURCE scope was
  // dropped with no word — the user believed the walk was scoped.
  test('a valueless --source is refused before the wire, on the thin client too', async () => {
    const r = await run(['people/alice-example', '--depth', '1', '--source']);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('`--source` requires a value');
    expect(calls).toHaveLength(0);
  });

  test('an ambient GBRAIN_SOURCE scope prints the cannot-forward note (walk still runs)', async () => {
    const r = await withEnv({ GBRAIN_SOURCE: 'team-wiki' }, () => run(['people/alice-example', '--depth', '1']));
    expect(r.code).toBe(0);
    const stderr = r.err.join('\n');
    expect(stderr).toContain("ambient source scope 'team-wiki' is not forwarded");
    expect(stderr).toContain('scopes the walk to your grant');
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].params).sort()).toEqual(['depth', 'direction', 'link_type', 'slug']);
  });
});
