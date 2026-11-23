/**
 * `gbrain access serves several --yes` (src/commands/access-serves.ts labelSeveral) on a Rust brain.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a run that adds the members, their folder rules and keys completes on PGLite and Postgres. On a Rust
 *    brain adding a folder rule (its preview count) still runs raw SQL, so the run refuses with
 *    engine_capability_missing before it writes anything. A re-run that only widens the keys it keeps runs on Rust and
 *    leaves the same receipt and stored grants as PGLite.
 *  - Regression: on a Rust brain the run added the members and then stopped at the folder rules, leaving a partial
 *    result the user did not ask for.
 *  - Why existing coverage misses it: test/setup-serves-several.test.ts runs on the SQL engines only.
 *  - Seam: none. labelSeveral with GBRAIN_HOME in a temp dir; pages through putPage. A parity case counts a typed
 *    refusal as a pass, so this reads every arm's own engine in one test.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource, parityArms, resetArm } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';
import { labelSeveral, runAccessServes } from '../../src/commands/access-serves.ts';
import { proposeRevision } from '../../src/core/access/policy.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../../src/core/cli-force-exit.ts';
import { listMembers } from '../../src/core/access/members.ts';
import { currentFolderRules } from '../../src/commands/access-rules.ts';

const { arms } = parityArms(testBackends());

const homes: string[] = [];
afterAll(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });
const home = () => { const h = mkdtempSync(join(tmpdir(), 'gbrain-serves-rust-')); homes.push(h); return h; };

const core = (title: string) =>
  ({ type: 'note' as const, title, compiled_truth: `body ${title}`, timeline: '', frontmatter: { always_load: true } });

const serves = (engine: BrainEngine, roster: string[], dir: string, opts: { labelledOnly?: boolean; owner?: string } = {}) =>
  withEnv({ GBRAIN_HOME: dir, GBRAIN_SETUP_ABORT_AFTER: undefined }, () => labelSeveral(engine, roster, 'default', true, true, opts));
const outcomeOf = (run: Promise<{ completed: string[]; error?: { code: string } }>) =>
  run.then(r => `ran: ${r.completed.join(',')}${r.error ? `, stopped: ${r.error.code}` : ''}`, (e: { code?: string }) => String(e.code));
/** The same engine reporting `kind` 'rust', so the guard's decision is read on a brain whose writes would succeed. */
const asRust = (engine: BrainEngine): BrainEngine =>
  new Proxy(engine, { get: (e, k) => k === 'kind' ? 'rust' : (typeof Reflect.get(e, k) === 'function' ? Reflect.get(e, k).bind(e) : Reflect.get(e, k)) });

const stored = async (engine: BrainEngine, dir: string) => JSON.stringify({
  members: await listMembers(engine, { includeRemoved: true }), rules: await currentFolderRules(engine, 'default'),
  tokens: await engine.listAccessTokens(), sources: await engine.listAllSources({ includeArchived: true }),
  serves: await engine.getConfig('access.serves'), files: readdirSync(dir, { recursive: true }).sort(),
});

describe('gbrain access serves several --yes on a Rust brain', () => {
  test('Rust refuses before any write when the run adds a folder rule, and a SQL brain finishes', async () => {
    for (const arm of arms()) {
      await resetArm(arm);
      await arm.engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
      for (const slug of ['people/alice-example/notes', 'people/bob-example/notes', 'notes/open']) {
        await arm.engine.putPage(slug, core(slug), { sourceId: 'default' });
      }
      await createSource(arm.engine, arm.backend, 'company');
      const dir = home();
      const before = await stored(arm.engine, dir);
      const outcome = await outcomeOf(serves(arm.engine, ['alice-example', 'bob-example'], dir));
      const changed = (await stored(arm.engine, dir)) !== before;
      expect({ backend: arm.backend, outcome, changed }).toEqual(arm.backend === 'rust'
        ? { backend: 'rust', outcome: 'engine_capability_missing', changed: false }
        : { backend: arm.backend, outcome: 'ran: members,rules,keys,config', changed: true });
    }
  }, 120_000);

  test('the guard on a brain that reports Rust: a re-run that adds nothing runs; or only widens kept keys runs; one that only adds the company/ rule is refused', async () => {
    const arm = arms().find(a => a.backend !== 'rust')!; // any SQL arm: a --postgres-only run has no PGLite arm
    const fresh = async (company: boolean) => {
      await resetArm(arm);
      await arm.engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
      for (const slug of ['people/alice-example/notes', 'people/bob-example/notes']) await arm.engine.putPage(slug, core(slug), { sourceId: 'default' });
      if (company) await createSource(arm.engine, arm.backend, 'company');
      const dir = home();
      expect(await outcomeOf(serves(arm.engine, ['alice-example', 'bob-example'], dir))).toBe('ran: members,rules,keys,config');
      return dir;
    };
    const refusedUnchanged = async (dir: string, opts: { labelledOnly?: boolean; owner?: string } = {}) => {
      const before = await stored(arm.engine, dir);
      expect(await outcomeOf(serves(asRust(arm.engine), ['alice-example', 'bob-example'], dir, opts))).toBe('engine_capability_missing');
      expect(await stored(arm.engine, dir)).toBe(before);
    };
    // A first run adds the people folder rules: refused before any write on every lane, not only the Rust arm.
    await resetArm(arm);
    await arm.engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
    for (const slug of ['people/alice-example/notes', 'people/bob-example/notes']) await arm.engine.putPage(slug, core(slug), { sourceId: 'default' });
    await refusedUnchanged(home());
    // A blocked run (the owner listed as a labelled-only member) reports its blockers before the refusal: never refused.
    const blockedRun = await withEnv({ GBRAIN_HOME: home(), GBRAIN_SETUP_ABORT_AFTER: undefined }, () =>
      labelSeveral(asRust(arm.engine), ['alice-example', 'bob-example'], 'default', true, true, { labelledOnly: true, owner: 'alice-example' }));
    expect({ applied: blockedRun.applied, blocked: blockedRun.members.some(m => m.action === 'blocked'), rulesAdd: blockedRun.rules.some(r => r.action === 'add') })
      .toEqual({ applied: false, blocked: true, rulesAdd: true });
    // Keys already read the company source: a re-run adds nothing and runs; --labelled-only adds only the company/ rule.
    let dir = await fresh(true);
    // A preview (no --yes) of a run that would need raw SQL is never refused: the guard sits after the preview return.
    const preview = await withEnv({ GBRAIN_HOME: dir, GBRAIN_SETUP_ABORT_AFTER: undefined }, () =>
      labelSeveral(asRust(arm.engine), ['alice-example', 'bob-example', 'carol-example'], 'default', false, true));
    expect({ applied: preview.applied, rules: preview.rules.some(r => r.action === 'add') }).toEqual({ applied: false, rules: true });
    expect(await outcomeOf(serves(asRust(arm.engine), ['alice-example', 'bob-example'], dir))).not.toContain('engine_capability_missing');
    await refusedUnchanged(dir, { labelledOnly: true, owner: 'owner-example' });
    // The company source arrives after the keys: a re-run that only widens the kept keys is not refused.
    dir = await fresh(false);
    await createSource(arm.engine, arm.backend, 'company');
    expect(await outcomeOf(serves(asRust(arm.engine), ['alice-example', 'bob-example'], dir))).toBe('ran: members,rules,keys,config');
  }, 120_000);

  test('widening the kept keys runs on every arm with the same output, exit code and stored grants', async () => {
    const roster = ['alice-example', 'bob-example'];
    const seen: Array<{ backend: string; value: unknown }> = [];
    for (const arm of arms()) {
      await resetArm(arm);
      await arm.engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
      for (const slug of ['people/alice-example/notes', 'people/bob-example/notes']) await arm.engine.putPage(slug, core(slug), { sourceId: 'default' });
      const dir = home();
      // The people rules go in through the policy store first, so neither run adds a rule (that step still refuses on Rust).
      const plan = await withEnv({ GBRAIN_HOME: dir, GBRAIN_SETUP_ABORT_AFTER: undefined }, () => labelSeveral(arm.engine, roster, 'default', false, true));
      await proposeRevision(arm.engine, 'default', plan.rules.map(r => ({ id: r.id, prefix: r.prefix, readable_by: r.readers })), { origin: 'cli', store: 'database' });
      const cli = async () => {
        _resetCliExitVerdictForTests();
        const lines: string[] = [];
        const log = console.log;
        console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
        try {
          await withEnv({ GBRAIN_HOME: dir, GBRAIN_SETUP_ABORT_AFTER: undefined }, () =>
            runAccessServes(arm.engine, 'several', ['--members', roster.join(','), '--yes', '--json'], true, (args, name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)));
        } finally { console.log = log; }
        return { exit: currentExitCode(), stdout: lines.join('\n').split(dir).join('<home>') };
      };
      const first = await cli();
      await createSource(arm.engine, arm.backend, 'company');
      const widen = await cli();
      const grants = await Promise.all(roster.map(async m => {
        const [t] = await arm.engine.transaction(tx => tx.lockActiveAccessTokens({ name: `member-${m}` })) as Array<Record<string, unknown>>;
        return { name: t?.name, scopes: t?.scopes, source_grant: t?.source_grant, source_id: t?.source_id, federated_read: t?.federated_read };
      }));
      seen.push({ backend: arm.backend, value: { first, widen, grants } });
    }
    expect(seen.length).toBeGreaterThan(0);
    const widened = (seen[0]!.value as { widen: { stdout: string } }).widen.stdout;
    expect(JSON.parse(widened).keys.map((k: { action: string; adds?: string[] }) => [k.action, k.adds])).toEqual([['keep', ['company']], ['keep', ['company']]]);
    for (const s of seen.slice(1)) expect({ backend: s.backend, value: s.value }).toEqual({ backend: s.backend, value: seen[0]!.value });
  }, 120_000);
});
