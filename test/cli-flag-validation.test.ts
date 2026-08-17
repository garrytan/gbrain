/**
 * #2185 — strict unknown-flag validation.
 *
 * The repro that filed the issue: `gbrain init --migrate-only --dry-run`
 * applied REAL migrations — no handler consults --dry-run, and the ad-hoc
 * `args.includes()` flag style silently ignores anything it doesn't look for.
 * The pre-dispatch validator in src/cli.ts fails loud instead.
 *
 * Four guard classes:
 *   1. sweep — every CLI_ONLY command (minus documented exemptions) and every
 *      op command rejects a nonsense flag via the pure validator.
 *   2. acceptance — real flags and passthrough forms stay accepted.
 *   3. drift — every CLI_ONLY member has a registry entry.
 *   4. freshness — the committed generated registry matches a fresh
 *      generator run (same doctrine as the llms-bundle freshness test).
 * Plus subprocess smokes for the end-to-end error surface.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import {
  validateCommandFlags,
  findUnknownFlag,
  findUnknownOpFlag,
  CLI_ONLY,
} from '../src/cli.ts';
import { CLI_FLAG_REGISTRY } from '../src/core/cli-flag-registry.generated.ts';
import { operations, operationsByName } from '../src/core/operations.ts';
import { buildFlagRegistry } from '../scripts/generate-flag-registry.ts';

const BOGUS = '--definitely-not-a-real-flag-xyz';
const EXEMPT = new Set(['call', 'config']); // jobs is exempt only for `submit`

describe('#2185 sweep — every command rejects a nonsense flag', () => {
  test('every CLI_ONLY command rejects the bogus flag (validator lane)', () => {
    const accepted: string[] = [];
    for (const command of CLI_ONLY) {
      if (EXEMPT.has(command)) continue;
      const verdict = validateCommandFlags(command, [BOGUS]);
      if (verdict !== BOGUS) accepted.push(command);
    }
    expect(accepted).toEqual([]);
  });

  test('every op command rejects the bogus flag (op lane)', () => {
    const accepted: string[] = [];
    for (const op of operations) {
      if (!op.cliHints) continue;
      const verdict = findUnknownOpFlag(op, [BOGUS]);
      if (verdict !== BOGUS) accepted.push(op.name);
    }
    expect(accepted).toEqual([]);
  });

  test('the literal #2185 repro is rejected: init --migrate-only --dry-run', () => {
    expect(validateCommandFlags('init', ['--migrate-only', '--dry-run'])).toBe('--dry-run');
    // And --migrate-only alone stays legal.
    expect(validateCommandFlags('init', ['--migrate-only'])).toBeNull();
  });

  test('whoknows stays a CLI_ONLY member (reachability pin)', () => {
    // The #2035 class: `case 'whoknows'` has a live handler (runWhoknows) that
    // is shadowed by find_experts' hidden op hint — dropping this CLI_ONLY
    // entry makes whoknows unreachable because its op hint is hidden.
    expect(CLI_ONLY.has('whoknows')).toBe(true);
  });
});

describe('#2185 acceptance — real usage stays legal', () => {
  test('op flags from the contract are accepted, including values starting with --', () => {
    const search = operationsByName.search;
    expect(findUnknownOpFlag(search, ['needle', '--limit', '5'])).toBeNull();
    // A VALUE that begins with -- is consumed as the value, not validated.
    expect(findUnknownOpFlag(search, ['--query', '--weird-looking-value'])).toBeNull();
    // Inline = form.
    expect(findUnknownOpFlag(search, ['needle', '--limit=5'])).toBeNull();
    // CLI-local formatter flags.
    expect(findUnknownOpFlag(search, ['needle', '--json', '--explain'])).toBeNull();
  });

  test('--no-<flag> negation of a known boolean op param is legal', () => {
    const withBool = operations.find(o =>
      o.cliHints && Object.values(o.params).some(p => p.type === 'boolean'));
    expect(withBool).toBeDefined();
    const boolKey = Object.entries(withBool!.params).find(([, p]) => p.type === 'boolean')![0];
    const flag = `--no-${boolKey.replace(/_/g, '-')}`;
    expect(findUnknownOpFlag(withBool!, [flag])).toBeNull();
  });

  test('everything after a literal -- is passthrough, never validated', () => {
    expect(findUnknownFlag(['--', BOGUS], new Set(['--help']))).toBeNull();
    expect(validateCommandFlags('agent', ['run', '--', BOGUS])).toBeNull();
    expect(findUnknownOpFlag(operationsByName.search, ['--', BOGUS])).toBeNull();
  });

  test('exempt commands accept arbitrary flags by contract', () => {
    expect(validateCommandFlags('call', ['some_op', BOGUS])).toBeNull();
    expect(validateCommandFlags('config', ['set', 'k', BOGUS])).toBeNull();
    expect(validateCommandFlags('jobs', ['submit', 'shell', BOGUS])).toBeNull();
    // ...but non-submit jobs subcommands are validated.
    expect(validateCommandFlags('jobs', ['list', BOGUS])).toBe(BOGUS);
  });

  test('registry-listed CLI_ONLY flags are accepted', () => {
    expect(validateCommandFlags('serve', ['--http', '--port', '4444'])).toBeNull();
    expect(validateCommandFlags('serve', ['--print-admin-token'])).toBeNull();
    expect(validateCommandFlags('embed', ['--stale', '--pace'])).toBeNull();
    expect(validateCommandFlags('sync', ['--full'])).toBeNull();
  });

  test('sources push accepts --message/--allow-unverified-remote (registry-regen regression)', () => {
    // A stale committed registry rejected these post-merge flags until
    // `bun run build:flag-registry` was re-run — pin the accepted form.
    expect(validateCommandFlags('sources', ['push', '--message', 'x', '--allow-unverified-remote'])).toBeNull();
    expect(validateCommandFlags('sources', ['push', BOGUS])).toBe(BOGUS);
  });

  // Pre-landing review regression: the validator rejected the CLI-local
  // flags makeContext consumes OUTSIDE the op contract — `gbrain search
  // "x" --source y` and `--dry-run` invocations exited 1 as unknown flags.
  test('op commands accept --source/--dry-run (makeContext CLI-locals, not wire params)', () => {
    const search = operationsByName.search;
    expect(findUnknownOpFlag(search, ['needle', '--source', 'yc-media'])).toBeNull();
    expect(findUnknownOpFlag(search, ['needle', '--source=yc-media'])).toBeNull();
    // --source's VALUE is consumed, never validated as a flag itself.
    expect(findUnknownOpFlag(search, ['--source', '--weird-value', 'needle'])).toBeNull();
    expect(findUnknownOpFlag(search, ['needle', '--dry-run'])).toBeNull();
    // Still strict right next to them.
    expect(findUnknownOpFlag(search, ['needle', '--source', 'y', BOGUS])).toBe(BOGUS);
  });

  test('--json=<v> is coherent between validator and parser (no positional corruption)', async () => {
    const { parseOpArgs } = await import('../src/cli.ts');
    const search = operationsByName.search;
    // Validator accepts any --json form.
    expect(findUnknownOpFlag(search, ['--json=true', 'needle'])).toBeNull();
    // Parser sets the boolean and PRESERVES the positional (pre-fix the
    // junk-key path consumed 'needle' as the value of key 'json=true').
    const p = parseOpArgs(search, ['--json=true', 'needle']);
    expect(p.json).toBe(true);
    expect(p.query).toBe('needle');
    expect((p as Record<string, unknown>)['json=true']).toBeUndefined();
    expect(parseOpArgs(search, ['needle', '--json=false']).json).toBe(false);
    // = forms of bare-only CLI-locals reject loud instead of silently eating tokens.
    expect(findUnknownOpFlag(search, ['--explain=verbose'])).toBe('--explain');
  });
});

describe('#2185 parseOpArgs inline = form (regression rule: changed token consumption)', () => {
  test('string and number params via =, positional untouched', async () => {
    const { parseOpArgs } = await import('../src/cli.ts');
    const search = operationsByName.search;
    const p = parseOpArgs(search, ['needle', '--limit=5']);
    expect(p.query).toBe('needle');
    expect(p.limit).toBe(5);
  });

  test('boolean =false negates; =0 keeps the raw!==false rule (pinned semantics)', async () => {
    const { parseOpArgs } = await import('../src/cli.ts');
    const withBool = operations.find(o =>
      o.cliHints && Object.values(o.params).some(pp => pp.type === 'boolean'))!;
    const key = Object.entries(withBool.params).find(([, pp]) => pp.type === 'boolean')![0];
    const flag = `--${key.replace(/_/g, '-')}`;
    expect(parseOpArgs(withBool, [`${flag}=false`])[key]).toBe(false);
    expect(parseOpArgs(withBool, [`${flag}=0`])[key]).toBe(true);
  });

  test('undeclared =-form key keeps the historical junk-fallthrough (validator rejects it first)', async () => {
    const { parseOpArgs } = await import('../src/cli.ts');
    const search = operationsByName.search;
    // The validator is the strict gate; the parser's legacy behavior for
    // undeclared keys is unchanged — pinned so a refactor can't silently
    // change what unvalidated callers (tests, internal) see.
    expect(findUnknownOpFlag(search, ['--not-a-param=x', 'needle'])).toBe('--not-a-param');
    const p = parseOpArgs(search, ['--not-a-param=x', 'needle']);
    expect(p.query).toBeUndefined(); // consumed by the junk key — validator prevents reaching here
  });
});

describe('#2185 red-team regressions', () => {
  test('dual-lane commands (op AND CLI_ONLY) validate against the DISPATCHED lane', () => {
    // think/salience/anomalies are both ops and CLI_ONLY members; dispatch
    // runs handleCliOnly, whose handlers parse flags the op contract never
    // declares. Pre-fix the validator checked the op lane first and rejected
    // documented invocations.
    expect(validateCommandFlags('salience', ['--kind', 'entity'])).toBeNull();
    expect(validateCommandFlags('think', ['what changed?', '--with-calibration'])).toBeNull();
    expect(validateCommandFlags('salience', [BOGUS])).toBe(BOGUS);
  });

  test('--dry-run is a real CLI-local boolean on op commands (trailing position sets it)', async () => {
    const { parseOpArgs } = await import('../src/cli.ts');
    // An op WITHOUT a declared dry_run param — pre-fix, trailing --dry-run
    // set NOTHING (ctx.dryRun stayed false → the REAL destructive action
    // ran despite the rehearsal request), and leading --dry-run consumed
    // the next token as its value.
    const search = operationsByName.search;
    expect(parseOpArgs(search, ['needle', '--dry-run']).dry_run).toBe(true);
    const leading = parseOpArgs(search, ['--dry-run', 'needle']);
    expect(leading.dry_run).toBe(true);
    expect(leading.query).toBe('needle');
    expect(parseOpArgs(search, ['needle', '--dry-run=false']).dry_run).toBe(false);
  });

  test('uppercase flag typos reject loudly in both lanes (handlers are case-sensitive)', () => {
    expect(findUnknownFlag(['--MIGRATE-ONLY'], new Set(['--migrate-only']))).toBe('--MIGRATE-ONLY');
    expect(findUnknownOpFlag(operationsByName.search, ['--LIMIT', '5'])).toBe('--LIMIT');
  });

  test('safety flags need consumption evidence, not prose bleed (codex P1-A)', () => {
    // upgrade.ts prints a help HINT naming another command's --dry-run; that
    // literal sits at depth 0 for post-upgrade. Pre-fix the generator
    // allowlisted it, recreating the exact #2185 repro the wave exists to
    // kill: `post-upgrade --dry-run` accepted, ignored, migrations run for
    // real. The generator now requires a tight-quoted standalone literal
    // (an args read like has('--dry-run')) before granting a safety flag.
    expect(CLI_FLAG_REGISTRY['post-upgrade']).not.toContain('--dry-run');
    // backfill genuinely consumes it (has('--dry-run') in backfill.ts) —
    // the gate must not strip real consumers.
    expect(CLI_FLAG_REGISTRY['backfill']).toContain('--dry-run');
  });
});

describe('#2185 drift + freshness guards', () => {
  test('every CLI_ONLY member has a registry entry (drift guard)', () => {
    const missing = [...CLI_ONLY].filter(c => !CLI_FLAG_REGISTRY[c]);
    expect(missing).toEqual([]);
  });

  test('every op whose cliHints.name is in CLI_ONLY is hidden (shadow guard)', () => {
    // CLI_ONLY wins over op-generated dispatch (src/cli.ts handleCliOnly
    // check precedes cliOps lookup), so a NON-hidden cliHints name that
    // collides with CLI_ONLY is dead code that lies to the catalog — the
    // think/salience/anomalies/whoknows class this wave swept. New collisions
    // must mark the hint hidden (the advisor pattern) or drop the CLI_ONLY
    // entry.
    const shadowed = operations
      .filter(op => op.cliHints?.name && CLI_ONLY.has(op.cliHints.name) && op.cliHints.hidden !== true)
      .map(op => `${op.name} (cliHints.name='${op.cliHints?.name}')`);
    expect(shadowed).toEqual([]);
  });

  test('committed registry matches a fresh generator run (freshness guard)', () => {
    const fresh = buildFlagRegistry();
    const freshKeys = Object.keys(fresh).sort();
    const committedKeys = Object.keys(CLI_FLAG_REGISTRY).sort();
    expect(committedKeys).toEqual(freshKeys);
    const stale = freshKeys.filter(
      key => JSON.stringify([...CLI_FLAG_REGISTRY[key]]) !== JSON.stringify(fresh[key]),
    );
    // Any listed command means: run `bun run build:flag-registry` and commit.
    expect(stale).toEqual([]);
  });
});

describe('#2185 subprocess smokes — end-to-end error surface', () => {
  const run = (args: string[]) =>
    spawnSync('bun', ['src/cli.ts', ...args], {
      encoding: 'utf-8',
      timeout: 30_000,
      env: { ...process.env, GBRAIN_SKIP_STARTUP_HOOKS: '1' },
    });

  test('init --migrate-only --dry-run fails loud BEFORE any engine work', () => {
    const r = run(['init', '--migrate-only', '--dry-run']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown flag --dry-run for 'gbrain init'");
    // Pre-engine: no migration output may appear.
    expect(r.stderr).not.toContain('migration');
  });

  test('typo on an op command fails loud with the command named', () => {
    const r = run(['search', 'needle', '--jsno']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown flag --jsno for 'gbrain search'");
  });

  test('--help still short-circuits before validation', () => {
    const r = run(['init', '--help']);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('unknown flag');
  });

  test('global flags are accepted on every command (stripped pre-dispatch)', () => {
    // --quiet is a parseGlobalFlags global: it never reaches the validator.
    // The bogus flag proves validation still ran on what remained.
    const r = run(['init', '--migrate-only', '--quiet', '--definitely-bogus-xyz']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown flag --definitely-bogus-xyz for 'gbrain init'");
    expect(r.stderr).not.toContain('--quiet');
  });

  test('op command accepts --source end-to-end (the makeContext CLI-local regression)', () => {
    // Fast path: --help short-circuits AFTER global parse, so a bogus flag
    // alongside --source proves ordering: --source accepted, bogus rejected.
    const r = run(['search', 'needle', '--source', 'nope-source', '--definitely-bogus-xyz']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown flag --definitely-bogus-xyz for 'gbrain search'");
    expect(r.stderr).not.toContain('unknown flag --source');
  });
});
