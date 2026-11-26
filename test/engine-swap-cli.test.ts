/**
 * `gbrain engine swap` (PR S5a): the read-only plan's CLI contract and the `engine_swap_refused` recovery table.
 *
 * Authoring gate (docs/TESTING.md): (1) protects what an agent reads before a swap: one JSON plan document, a stable plan
 * hash, engine-selecting variables and service definitions by name only, and a complete recovery row for every
 * refusal reason. (2) Fails when the plan prints a variable's value, when the hash moves with a volatile reading, when
 * a flag of the later run is accepted, or when a reason has no registry entry, recovery row or guide anchor. (3) The
 * refresh gate has its own test (engine-swap-refresh-drain.test.ts). (4) No seam beyond injected env, home and status.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { renderCliError } from '../src/core/agent-output.ts';
import { runEngineSwap, serviceDefinitions, type EngineSwapCliDeps } from '../src/commands/engine-swap.ts';
import { existsSync } from 'node:fs';
import { withEnv } from './helpers/with-env.ts';
import { CODES } from '../src/core/error-registry.ts';
import { SWAP_RECOVERY, SWAP_REFUSAL_REASONS } from '../src/core/engine-swap/refusals.ts';

let engine: PGLiteEngine;
let home: string;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  home = mkdtempSync(join(tmpdir(), 'gbrain-swap-home-'));
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(join(home, 'Library', 'LaunchAgents', 'com.gbrain.serve.plist'), '<key>GBRAIN_DATABASE_URL</key><string>postgresql://h/db?app=VALUECANARY</string>');
  writeFileSync(join(home, 'Library', 'LaunchAgents', 'com.other.app.plist'), 'DATABASE_URL');
}, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

async function run(args: string[], extra: Partial<EngineSwapCliDeps> = {}) {
  let stdout = '';
  let error = '';
  const code = await runEngineSwap(args, {
    openEngine: async () => Object.assign(Object.create(engine), { disconnect: async () => undefined }) as BrainEngine,
    env: { GBRAIN_DATABASE_URL: 'postgresql://db.example/brain?app=VALUECANARY', HOME: home },
    home, dataDir: home, resolveBrain: () => 'host', cliBrain: null,
    out: t => { stdout += t; },
    writeError: (e, o) => { const r = renderCliError(e, { json: o.json, command: 'engine swap', tty: false }); error = r.stdout ?? r.stderr ?? ''; return r.exitCode; },
    ...extra,
  });
  return { code, stdout, error };
}

describe('engine swap --plan', () => {
  test('a service definition that cannot be read is marked unread, not listed as setting nothing', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'gbrain-swap-svc-'));
    try {
      const dir = join(fakeHome, '.config', 'systemd', 'user');
      mkdirSync(dir, { recursive: true });
      // A directory where a unit file is expected: readFileSync throws EISDIR, the same as an unreadable file.
      mkdirSync(join(dir, 'gbrain-serve.service'));
      writeFileSync(join(dir, 'gbrain-sync.service'), 'Environment=GBRAIN_DATABASE_URL=postgresql://x/y\n');
      expect(serviceDefinitions(fakeHome)).toEqual([
        { name: 'gbrain-serve.service', kind: 'systemd', sets: [], unread: 'read_failed' },
        { name: 'gbrain-sync.service', kind: 'systemd', sets: ['GBRAIN_DATABASE_URL'] },
      ]);
      const human = await run(['--to', 'rust', '--dry-run'], { home: fakeHome, env: { HOME: fakeHome } });
      expect(human.stdout).toContain('gbrain-serve.service (systemd; unreadable, names unknown)');
      expect(human.stdout).toContain('gbrain-sync.service (systemd; sets GBRAIN_DATABASE_URL)');
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test('prints one JSON plan with names only, never values', async () => {
    const r = await run(['--to', 'rust', '--plan', '--json']);
    expect(r.code).toBe(0);
    const plan = JSON.parse(r.stdout);
    expect(plan.schema_version).toBe(1);
    expect(plan.to).toBe('rust');
    expect(plan.from).toBe('pglite');
    expect(plan.verdict).toBe('NOT READY');
    expect(plan.shadow).toBe(false);
    expect(plan.criteria).toHaveLength(11);
    expect(plan.routes.env).toEqual(['GBRAIN_DATABASE_URL']);
    expect(plan.routes.services).toEqual([{ name: 'com.gbrain.serve.plist', kind: 'launchd', sets: ['GBRAIN_DATABASE_URL'] }]);
    expect(typeof plan.disk.free_bytes).toBe('number');
    // The policy in force at the real clock: the opt-in override's 5 days until the end of Dec 8 PST, 14 days after.
    expect(plan.policy.text).toMatch(/minimum shadow duration (5 days until 2026-12-09T08:00:00\.000Z|14 days)/);
    expect(plan.policy.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(Array.isArray(plan.capability_report.served)).toBe(true);
    expect(plan.write_pause.seconds).toBeGreaterThanOrEqual(1);
    expect(plan.blockers).toEqual([]);
    expect(plan.plan_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(r.stdout).not.toContain('VALUECANARY');
  });

  test('the human plan states the way back, its known limits, what failback does not carry and the fingerprint rule', async () => {
    const r = await run(['--to', 'rust', '--plan']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Way back: After a swap, the old engine is not kept current; failback');
    expect(r.stdout).toContain('Known limit: The Rust store\'s shadow digests are written only by the seed and the follower');
    expect(r.stdout).toContain('Failback accepted losses (counted by its plan): page_version_collapse, new_row_ids');
    expect(r.stdout).toMatch(/Failback does not carry \(no Rust read call returns it, or failback does not write it back\), \d+ table\(s\): .*page_versions/);
    expect(r.stdout).toContain('Fingerprint rule (the probe\'s own rule, both directions)');
    const json = JSON.parse((await run(['--to', 'rust', '--plan', '--json'])).stdout);
    expect(json.way_back.losses.not_carried_tables).toContain('page_versions');
    expect(json.way_back.known_limits.length).toBe(3);
    expect(r.stdout).toContain('Named loss for remote callers: A remote read by the brain owner on a Rust brain refuses by name');
    expect(json.way_back.remote_limits.length).toBe(1);
  });

  test('the human plan names the verdict, every criterion, the policy, the capability report and the write pause, and no value', async () => {
    const r = await run(['--to', 'rust', '--dry-run']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('verdict: NOT READY (no_shadow)');
    expect(r.stdout).toContain('8. [reported] speed (reported, not gating: D23)');
    expect(r.stdout).toContain('Capability report: ');
    expect(r.stdout).toContain('Expected write pause: about ');
    expect(r.stdout).toMatch(/Readiness policy: minimum shadow duration (5 days until 2026-12-09T08:00:00\.000Z|14 days)/);
    expect(r.stdout).toContain('Nothing was written.');
    expect(r.stdout).not.toContain('VALUECANARY');
  });

  test('the plan hash ignores volatile readings and moves with the routes', async () => {
    const a = JSON.parse((await run(['--to', 'rust', '--plan', '--json'], { now: new Date('2026-11-21T00:00:00Z') })).stdout);
    const b = JSON.parse((await run(['--to', 'rust', '--plan', '--json'], { now: new Date('2026-11-22T00:00:00Z'), dataDir: tmpdir() })).stdout);
    expect(b.plan_hash).toBe(a.plan_hash);
    const c = JSON.parse((await run(['--to', 'rust', '--plan', '--json'], { env: { HOME: home, DATABASE_URL: 'x' } })).stdout);
    expect(c.plan_hash).not.toBe(a.plan_hash);
  });

  test.each([
    [['--to', 'rust', '--yes'], '--yes needs --expect'],
    [['--to', 'rust', '--plan', '--resume'], 'Use one of'],
    [['--to', 'rust', '--bogus'], 'Not a flag of engine swap: --bogus'],
    [['--to', 'mysql', '--plan'], '--to mysql is not an engine'],
    [['--plan'], '--to (missing) is not an engine'],
  ])('%j is refused as usage, before the brain is opened', async (args, text) => {
    let opened = false;
    const r = await run(args as string[], { openEngine: async () => { opened = true; throw new Error('opened'); } });
    expect(r.code).toBe(2);
    expect(opened).toBe(false);
    expect(r.error).toContain(text);
  });
});

describe('engine swap --plan opens only the host brain, and only if it exists', () => {
  test('a mounted brain is refused before anything is opened', async () => {
    let opened = false;
    const r = await run(['--to', 'rust', '--plan', '--json'], { resolveBrain: () => 'team-x', openEngine: async () => { opened = true; throw new Error('opened'); } });
    expect(opened).toBe(false);
    expect(r.code).toBe(3);
    const env = JSON.parse(r.error);
    expect(env.code).toBe('engine_swap_refused');
    expect(env.reason).toBe('team_brain');
    expect(env.message).toContain('team-x is a mounted brain');
  });

  test('--brain reaches the brain resolver', async () => {
    const asked: Array<string | null> = [];
    await run(['--to', 'rust', '--plan', '--brain', 'mount-a', '--json'], { resolveBrain: e => { asked.push(e); return 'mount-a'; } });
    expect(asked).toEqual(['mount-a']);
  });

  test('the global --brain flag (stripped before dispatch) reaches the resolver', async () => {
    const asked: Array<string | null> = [];
    const r = await run(['--to', 'rust', '--plan', '--json'], { cliBrain: 'team-x', resolveBrain: e => { asked.push(e); return e ?? 'host'; } });
    expect(asked).toEqual(['team-x']);
    expect(JSON.parse(r.error).reason).toBe('team_brain');
  });

  test('an existing empty directory is not a brain: refused, and nothing is created in it', async () => {
    const gh = mkdtempSync(join(tmpdir(), 'gbrain-swap-cfg-'));
    const empty = join(gh, 'empty-brain');
    mkdirSync(empty);
    mkdirSync(join(gh, '.gbrain'), { recursive: true });
    writeFileSync(join(gh, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: empty }));
    try {
      let error = '';
      const code = await withEnv({ GBRAIN_HOME: gh, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_BRAIN_ID: undefined }, () => runEngineSwap(['--to', 'rust', '--plan', '--json'], {
        resolveBrain: () => 'host', env: {}, home: '', out: () => undefined,
        writeError: (e, o) => { const r = renderCliError(e, { json: o.json, command: 'engine swap', tty: false }); error = r.stdout ?? ''; return r.exitCode; },
      }));
      expect(code).not.toBe(0);
      expect(JSON.parse(error).code).toBe('no_brain');
      expect(readdirSync(empty)).toEqual([]);
    } finally { rmSync(gh, { recursive: true, force: true }); }
  }, 60_000);

  test('a configured PGLite path that does not exist is refused and never created', async () => {
    const gh = mkdtempSync(join(tmpdir(), 'gbrain-swap-cfg-'));
    const missing = join(gh, 'no-such-brain');
    mkdirSync(join(gh, '.gbrain'), { recursive: true });
    writeFileSync(join(gh, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: missing }));
    try {
      let error = '';
      const code = await withEnv({ GBRAIN_HOME: gh, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_BRAIN_ID: undefined }, () => runEngineSwap(['--to', 'rust', '--plan', '--json'], {
        resolveBrain: () => 'host', env: {}, home: '', out: () => undefined,
        writeError: (e, o) => { const r = renderCliError(e, { json: o.json, command: 'engine swap', tty: false }); error = r.stdout ?? ''; return r.exitCode; },
      }));
      expect(code).not.toBe(0);
      expect(JSON.parse(error).code).toBe('no_brain');
      expect(existsSync(missing)).toBe(false);
    } finally { rmSync(gh, { recursive: true, force: true }); }
  });
});

describe('engine_swap_refused recovery table', () => {
  const guide = readFileSync(join(import.meta.dir, '..', 'docs', 'guides', 'engine-swap.md'), 'utf8');
  test('the registry entry lists exactly the recovery table reasons', () => {
    const entry = CODES.engine_swap_refused as import('../src/core/error-registry.ts').CodeEntry;
    expect([...entry.reasons!]).toEqual([...SWAP_REFUSAL_REASONS]);
    for (const reason of SWAP_REFUSAL_REASONS) {
      const row = SWAP_RECOVERY[reason];
      const override = entry.reason_overrides?.[reason];
      expect(override?.class ?? entry.class).toBe(row.class);
      expect(override?.exit ?? 1).toBe(row.exit);
    }
  });
  test.each([...SWAP_REFUSAL_REASONS])('%s has a complete row and a guide anchor', reason => {
    const row = SWAP_RECOVERY[reason];
    for (const k of ['blocker', 'authority', 'side_effects', 'retry'] as const) expect(row[k].length).toBeGreaterThan(10);
    expect(row.anchor).toBe(`docs/guides/engine-swap.md#${reason}`);
    expect(guide).toContain(`<a id="${reason}"></a>`);
  });
});
