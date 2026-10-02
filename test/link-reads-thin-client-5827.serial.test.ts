/**
 * #5827 — link reads on a thin-client install, driven through the real CLI
 * dispatcher (`__testing.main`) with a recorded `callRemoteTool`.
 *
 * Contracts protected:
 *   - the link commands forward an ambient GBRAIN_SOURCE / .gbrain-source
 *     binding as `source_id` (they declare it now), and an empty result says
 *     which binding narrowed it plus the exact `--all-sources` rerun command;
 *   - mixed versions: when the brain host answers with an unknown-parameter
 *     warning for a scope param the client sent (flag, env or dotfile), the
 *     command fails instead of printing the host's unscoped result;
 *   - `gbrain links` is the CLI name with `get_links` kept as an alias.
 * Regression that fails it: the CLI printing the unscoped result (exit 0) or
 * dropping the ambient scope, as on the wave-5 base. The stub response is
 * built with the server's own warning builder (`buildUnknownParamWarnBlock`).
 *
 * Serial file: mock.module patches config.ts and mcp-client.ts process-wide.
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { withEnv } from './helpers/with-env.ts';
import { buildUnknownParamWarnBlock } from '../src/mcp/validate-params.ts';

type Call = { name: string; params: Record<string, unknown> };
const calls: Call[] = [];
let respond: (call: Call) => unknown = () => ({ content: [{ type: 'text', text: '[]' }] });

const realConfig = await import('../src/core/config.ts');
mock.module('../src/core/config.ts', () => ({
  ...realConfig,
  loadConfig: () => ({
    engine: 'postgres',
    remote_mcp: { issuer_url: 'https://brain.example.test', mcp_url: 'https://brain.example.test/mcp', oauth_client_id: 'cid' },
  }),
  isThinClient: () => true,
}));

const realMcpClient = await import('../src/core/mcp-client.ts');
mock.module('../src/core/mcp-client.ts', () => ({
  ...realMcpClient,
  callRemoteTool: async (_cfg: unknown, name: string, params: Record<string, unknown>) => {
    const c = { name, params: { ...params } };
    calls.push(c);
    return respond(c);
  },
}));

const { __testing } = await import('../src/cli.ts');

class ExitSignal extends Error {
  constructor(readonly code: number) { super(`process.exit(${code})`); }
}

let cwd: string;
let dotfileDir: string;
const savedCwd = process.cwd();

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), 'gbrain-5827-thin-'));
  dotfileDir = mkdtempSync(join(tmpdir(), 'gbrain-5827-dot-'));
  writeFileSync(join(dotfileDir, '.gbrain-source'), 'wiki\n');
});

afterAll(() => {
  process.chdir(savedCwd);
  rmSync(cwd, { recursive: true, force: true });
  rmSync(dotfileDir, { recursive: true, force: true });
});

beforeEach(() => {
  calls.length = 0;
  respond = () => ({ content: [{ type: 'text', text: '[]' }] });
});

async function run(argv: string[], opts: { env?: Record<string, string | undefined>; dir?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const saved = { log: console.log, error: console.error, exit: process.exit, argv: process.argv,
    stderr: process.stderr.write };
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(' ')); };
  process.stderr.write = ((chunk: unknown) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
  (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as never;
  process.argv = [saved.argv[0]!, 'gbrain', ...argv];
  process.chdir(opts.dir ?? cwd);
  let code = 0;
  try {
    await withEnv({ GBRAIN_SOURCE: undefined, GBRAIN_NO_BANNER: '1', ...opts.env }, () => __testing.main());
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e;
    code = e.code;
  } finally {
    console.log = saved.log;
    console.error = saved.error;
    process.stderr.write = saved.stderr;
    (process as unknown as { exit: typeof saved.exit }).exit = saved.exit;
    process.argv = saved.argv;
    process.chdir(savedCwd);
  }
  return { code, log: out.join('\n'), stderr: err.join('\n') };
}

/** What a pre-#5827 host sends back: the unscoped result plus a WP3 warning per ignored key. */
function oldHost(ignoredKeys: string[], body: unknown = [{ from_slug: 'x', to_slug: 'y' }]) {
  return (c: Call) => {
    const warnings = ignoredKeys.filter((k) => k in c.params).map((param) => ({ code: 'unknown_param', param }));
    return {
      content: [
        { type: 'text', text: JSON.stringify(body) },
        ...(warnings.length ? [{ type: 'text', text: buildUnknownParamWarnBlock(warnings as never) }] : []),
      ],
      ...(warnings.length ? { _meta: { warnings } } : {}),
    };
  };
}

describe('#5827 thin-client link reads follow ambient scope', () => {
  test('GBRAIN_SOURCE is sent as source_id; an empty result names the binding and the --all-sources rerun', async () => {
    const r = await run(['backlinks', 'companies/acme-example'], { env: { GBRAIN_SOURCE: 'business' } });
    expect(r.code).toBe(0);
    expect(calls).toEqual([{ name: 'get_backlinks', params: { slug: 'companies/acme-example', source_id: 'business' } }]);
    expect(r.stderr).toContain(
      '[gbrain] backlinks: no results within source business (set by GBRAIN_SOURCE). ' +
      'To read every source you can see: gbrain backlinks companies/acme-example --all-sources',
    );
  });

  test('a .gbrain-source pin is sent as source_id and named in the hint', async () => {
    const r = await run(['links', 'people/alice-example'], { dir: dotfileDir });
    expect(calls[0]).toEqual({ name: 'get_links', params: { slug: 'people/alice-example', source_id: 'wiki' } });
    expect(r.stderr).toContain('no results within source wiki (set by .gbrain-source)');
    expect(r.stderr).toContain('gbrain links people/alice-example --all-sources');
  });

  test('a non-empty narrowed result prints no hint, and --all-sources goes on the wire', async () => {
    respond = () => ({ content: [{ type: 'text', text: JSON.stringify([{ from_slug: 'a', to_slug: 'b' }]) }] });
    const r = await run(['backlinks', 'companies/acme-example'], { env: { GBRAIN_SOURCE: 'business' } });
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain('no results within source');
    calls.length = 0;
    await run(['graph', 'people/alice-example', '--all-sources'], { env: { GBRAIN_SOURCE: 'business' } });
    expect(calls[0]).toEqual({ name: 'traverse_graph', params: { slug: 'people/alice-example', all_sources: true } });
  });

  test('the get_links alias still dispatches', async () => {
    await run(['get_links', 'people/alice-example', '--source-id', 'wiki']);
    expect(calls[0]).toEqual({ name: 'get_links', params: { slug: 'people/alice-example', source_id: 'wiki' } });
  });

  test('--source with --source-id is refused before the wire', async () => {
    const r = await run(['backlinks', 'companies/acme-example', '--source', 'business', '--source-id', 'wiki']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Pass either --source or --source-id/--all-sources, not both.');
    expect(calls).toHaveLength(0);
  });
});

describe('#5827 mixed versions: a host that ignores a scope param fails loudly', () => {
  const origins: Array<[string, string[], () => { env?: Record<string, string | undefined>; dir?: string }]> = [
    ['--source-id flag', ['backlinks', 'companies/acme-example', '--source-id', 'business'], () => ({})],
    ['--source flag', ['backlinks', 'companies/acme-example', '--source', 'business'], () => ({})],
    ['GBRAIN_SOURCE', ['backlinks', 'companies/acme-example'], () => ({ env: { GBRAIN_SOURCE: 'business' } })],
    ['.gbrain-source', ['backlinks', 'companies/acme-example'], () => ({ dir: dotfileDir })],
  ];
  for (const [origin, argv, opts] of origins) {
    test(`source_id from ${origin}`, async () => {
      respond = oldHost(['source_id', 'all_sources']);
      const r = await run(argv, opts());
      expect(calls[0]?.params.source_id).toBeDefined();
      // Exit 1 is raised before the result is formatted, so nothing reaches stdout.
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(
        'the brain host does not support source_id on get_backlinks; upgrade the host (gbrain upgrade on the brain host)',
      );
    });
  }

  test('all_sources is checked the same way', async () => {
    respond = oldHost(['source_id', 'all_sources']);
    const r = await run(['links', 'people/alice-example', '--all-sources']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('the brain host does not support all_sources on get_links');
  });

  test('a host that honors the scope prints the result', async () => {
    respond = oldHost([]);
    const r = await run(['backlinks', 'companies/acme-example', '--source-id', 'business']);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain('does not support');
  });

  test('an ignored non-scope param this op declares is a stderr warning, not a failure', async () => {
    respond = oldHost(['direction']);
    const r = await run(['graph', 'people/alice-example', '--direction', 'in']);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('the brain host ignored parameter "direction" on traverse_graph');
  });
});
