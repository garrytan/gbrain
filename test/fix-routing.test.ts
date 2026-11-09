/**
 * A1 / DX-7: every CLI fix carries explicit --brain/--source routing, pinned
 * once at render time (src/core/fix-routing.ts via renderAction). The journey
 * proof (a pinned fix run from another directory under conflicting ambient
 * settings acts on the intended brain) lives in
 * test/agent-journey-recovery.serial.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import '../src/core/operations.ts';
import { CLI_COMMANDS } from '../src/cli/command-table.ts';
import { CLI_FLAG_REGISTRY, CLI_ROUTING_FLAGS, CLI_ROUTING_SUBCOMMANDS } from '../src/core/cli-flag-registry.generated.ts';
import {
  __resetCliRoutingForTests, cliRouting, installCliRouting, noteResolvedSource, pinRouting, recordedSource, routingFlagsFor,
} from '../src/core/fix-routing.ts';
import { cliRenderContext, renderAction, toAgentError, type Action, type RenderContext } from '../src/core/agent-output.ts';
import { opError } from '../src/core/ops/contract.ts';
import { buildRoutingTables } from '../scripts/generate-flag-registry.ts';

const routing = { brain: 'teambrain', source: 'wiki' };
const read = (argv: string[], extra: Partial<Action> = {}): Action => ({ argv, consent: [], actor: 'agent', why: 'x', requires_exclusive: false, ...extra });

afterEach(() => __resetCliRoutingForTests());

describe('pinRouting', () => {
  test('shared ops get --brain and --source, before a bare --', () => {
    expect(pinRouting(['gbrain', 'get', 'notes/a', '--include-deleted'], routing))
      .toEqual(['gbrain', 'get', 'notes/a', '--include-deleted', '--brain', 'teambrain', '--source', 'wiki']);
    expect(pinRouting(['gbrain', 'write-request', '--', '--yes'], routing))
      .toEqual(['gbrain', 'write-request', '--brain', 'teambrain', '--source', 'wiki', '--', '--yes']);
  });

  test('flags already present are kept; any source selector suppresses the source pin', () => {
    expect(pinRouting(['gbrain', 'get', 'a', '--brain=host'], routing)).toEqual(['gbrain', 'get', 'a', '--brain=host', '--source', 'wiki']);
    expect(pinRouting(['gbrain', 'sync', '--source', 'other'], routing)).toEqual(['gbrain', 'sync', '--source', 'other', '--brain', 'teambrain']);
    for (const sel of ['--source-id', '--all-sources', '--sources']) {
      expect(pinRouting(['gbrain', 'search', 'q', sel], routing)).toEqual(['gbrain', 'search', 'q', sel, '--brain', 'teambrain']);
    }
    // A routing flag that only appears after `--` is a positional, not a selector.
    expect(pinRouting(['gbrain', 'get', '--', '--source'], routing)).toEqual(['gbrain', 'get', '--brain', 'teambrain', '--source', 'wiki', '--', '--source']);
  });

  test('brain-wide and engine-free commands: doctor gets --brain only; init, errors and non-gbrain argv are untouched', () => {
    expect(pinRouting(['gbrain', 'doctor', '--json'], routing)).toEqual(['gbrain', 'doctor', '--json', '--brain', 'teambrain']);
    expect(pinRouting(['gbrain', 'init', '--pglite', '--no-embedding'], routing)).toEqual(['gbrain', 'init', '--pglite', '--no-embedding']);
    expect(pinRouting(['gbrain', 'errors', 'no_brain'], routing)).toEqual(['gbrain', 'errors', 'no_brain']);
    expect(pinRouting(['kill', '1234'], routing)).toEqual(['kill', '1234']);
    expect(pinRouting(['gbrain', 'get', 'a'], undefined)).toEqual(['gbrain', 'get', 'a']);
  });

  test('an op whose --source is its own param (provenance) gets --brain only', () => {
    expect(routingFlagsFor('timeline-add')).toEqual({ brain: true, source: false });
    expect(pinRouting(['gbrain', 'timeline-add', 'a', '2026-01-01', 'x'], routing)).toEqual(['gbrain', 'timeline-add', 'a', '2026-01-01', 'x', '--brain', 'teambrain']);
  });

  test('dx-r3-outside-3: git maintenance fixes are pinned; git commit-push and git guard fixes stay unpinned', () => {
    expect(pinRouting(['gbrain', 'git', 'maintenance', '--source', 'wiki', '--apply'], routing))
      .toEqual(['gbrain', 'git', 'maintenance', '--source', 'wiki', '--apply', '--brain', 'teambrain']);
    expect(pinRouting(['gbrain', 'git', 'maintenance', '--dry-run'], routing))
      .toEqual(['gbrain', 'git', 'maintenance', '--dry-run', '--brain', 'teambrain', '--source', 'wiki']);
    expect(pinRouting(['gbrain', 'git', 'maintenance', '--path', '/srv/brain', '--dry-run'], routing))
      .toEqual(['gbrain', 'git', 'maintenance', '--path', '/srv/brain', '--dry-run', '--brain', 'teambrain']);
    expect(pinRouting(['gbrain', 'git', 'commit-push', '-m', 'msg', '--', 'notes/a.md'], routing)).toEqual(['gbrain', 'git', 'commit-push', '-m', 'msg', '--', 'notes/a.md']);
    expect(pinRouting(['gbrain', 'git', 'commit-push', '--push-only', '--keep-checkout', '--path', '/srv/brain'], routing))
      .toEqual(['gbrain', 'git', 'commit-push', '--push-only', '--keep-checkout', '--path', '/srv/brain']);
    expect(pinRouting(['gbrain', 'git', 'guard', '--install'], routing)).toEqual(['gbrain', 'git', 'guard', '--install']);
    expect(pinRouting(['gbrain', 'git', '--', 'maintenance'], routing)).toEqual(['gbrain', 'git', '--', 'maintenance']);
  });

  test('malformed ids are never interpolated', () => {
    expect(pinRouting(['gbrain', 'get', 'a'], { brain: '--yes', source: 'a b' })).toEqual(['gbrain', 'get', 'a']);
  });
});

describe('routing table agrees with the command table and the generated registry', () => {
  test('every routes_source record pins its source flag and accepts it; nothing else does', () => {
    const declared = CLI_COMMANDS.filter(r => r.routes_source).map(r => r.name).sort();
    expect(declared.length).toBeGreaterThan(10);
    // #6803 (D2): a record declares '--source-id' when its --source is a mode selector (extract: fs|db).
    const flagOf = (name: string) => CLI_COMMANDS.find(r => r.name === name)!.routes_source === '--source-id' ? '--source-id' : '--source';
    for (const name of declared) expect(CLI_FLAG_REGISTRY[name], `${name} accepts ${flagOf(name)}`).toContain(flagOf(name));
    expect(Object.keys(CLI_ROUTING_FLAGS).filter(k => CLI_ROUTING_FLAGS[k]!.includes('--source') || CLI_ROUTING_FLAGS[k]!.includes('--source-id')).sort()).toEqual(declared);
    for (const name of declared) expect(CLI_ROUTING_FLAGS[name], name).toContain(flagOf(name));
  });

  test('every engine-opening command pins --brain; pre-connect ones only when their code reads the brain option', () => {
    for (const r of CLI_COMMANDS.filter(c => c.phase !== 'pre-connect')) expect(routingFlagsFor(r.name, {}, r.routes_subcommands?.[0]).brain, r.name).toBe(true);
    expect(routingFlagsFor('git', {}, 'commit-push')).toEqual({ brain: false, source: false });
    expect(routingFlagsFor('db-repair').brain).toBe(true);
    expect(routingFlagsFor('embeddings').brain).toBe(true);
    expect(routingFlagsFor('apply-migrations').brain).toBe(false);
    expect(routingFlagsFor('init').brain).toBe(false);
  });

  test('committed routing table matches a fresh generator run (bun run build:flag-registry)', () => {
    const fresh = buildRoutingTables();
    expect(Object.fromEntries(Object.entries(CLI_ROUTING_FLAGS).map(([k, v]) => [k, [...v]]))).toEqual(fresh.routing);
    expect(Object.fromEntries(Object.entries(CLI_ROUTING_SUBCOMMANDS).map(([k, v]) => [k, [...v]]))).toEqual(fresh.subcommands);
    for (const r of CLI_COMMANDS.filter(c => c.routes_subcommands)) expect(CLI_ROUTING_SUBCOMMANDS[r.name], r.name).toEqual([...r.routes_subcommands!].sort());
  });
});

describe('render-time pin', () => {
  const cli: RenderContext = { transport: 'cli', isCallable: () => false, preapproved: () => false, routing };

  test('argv, command, preview_argv, verify.argv and then are pinned; suggestion quotes the pinned command', () => {
    const r = renderAction(read(['gbrain', 'sync', '--no-pull'], {
      preview_argv: ['gbrain', 'sync', '--dry-run'],
      verify: { argv: ['gbrain', 'doctor', '--only', 'sync_freshness', '--json'] },
      then: read(['gbrain', 'embed', '--stale']),
    }), cli);
    expect(r.argv).toEqual(['gbrain', 'sync', '--no-pull', '--brain', 'teambrain', '--source', 'wiki']);
    expect(r.command).toBe('gbrain sync --no-pull --brain teambrain --source wiki');
    expect(r.preview_argv).toEqual(['gbrain', 'sync', '--dry-run', '--brain', 'teambrain', '--source', 'wiki']);
    expect(r.verify?.argv).toEqual(['gbrain', 'doctor', '--only', 'sync_freshness', '--json', '--brain', 'teambrain']);
    expect(r.then?.argv).toEqual(['gbrain', 'embed', '--stale', '--brain', 'teambrain', '--source', 'wiki']);
    const env = toAgentError(opError('invalid_params', 'bad', 'Try again.', { fix: read(['gbrain', 'get', 'a']) }), { transport: 'cli', render: cli });
    expect(env.suggestion).toContain('gbrain get a --brain teambrain --source wiki');
  });

  test('HTTP keeps only the source id (no mount topology), where a thin client can send it, and still strips paths', () => {
    const http: RenderContext = { ...cli, transport: 'http' };
    const env = toAgentError(opError('invalid_params', 'bad', 'Fix it.', { fix: read(['gbrain', 'import', '/home/alice-example/notes']) }), { transport: 'http', render: http });
    expect(env.fix?.argv).toEqual(['gbrain', 'import', '<path>', '--source', 'wiki']);
    expect(JSON.stringify(env)).not.toContain('/home/alice-example');
    expect(JSON.stringify(env)).not.toContain('teambrain');
    expect(renderAction(read(['gbrain', 'get', 'a']), http).argv).toEqual(['gbrain', 'get', 'a', '--source', 'wiki']);
    // write-request has no source_id scope: a thin client would refuse an explicit --source there.
    expect(renderAction(read(['gbrain', 'write-request', '--', 'x']), http).argv).toEqual(['gbrain', 'write-request', '--', 'x']);
    expect(renderAction(read(['gbrain', 'doctor', '--json']), http).argv).toEqual(['gbrain', 'doctor', '--json']);
  });

  test('cliRenderContext reads the installed CLI routing; the first resolved source wins', () => {
    expect(cliRenderContext().routing).toBeUndefined();
    installCliRouting(() => ({ brain: 'host', ...(recordedSource() ? { source: recordedSource() } : {}) }));
    noteResolvedSource('wiki');
    noteResolvedSource('other');
    expect(cliRouting()).toEqual({ brain: 'host', source: 'wiki' });
    expect(renderAction(read(['gbrain', 'get', 'a']), cliRenderContext()).argv).toEqual(['gbrain', 'get', 'a', '--brain', 'host', '--source', 'wiki']);
  });

  test('without an installed CLI routing the resolver records nothing (MCP servers, library callers)', () => {
    noteResolvedSource('wiki');
    expect(recordedSource()).toBeUndefined();
  });
});
