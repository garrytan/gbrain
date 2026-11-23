/**
 * `gbrain access serves several --yes` (src/commands/access-serves.ts labelSeveral) on a Rust brain.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a run that adds the members, their folder rules and keys completes on PGLite and Postgres. On a Rust
 *    brain adding a folder rule (its preview count) and widening a kept key (row 32k) still run raw SQL, so the run
 *    refuses with engine_capability_missing before it writes anything.
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
import { labelSeveral } from '../../src/commands/access-serves.ts';
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

  test('the guard on a brain that reports Rust: a re-run that adds nothing runs; one that only widens a kept key or only adds the company/ rule is refused', async () => {
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
    // Keys already read the company source: a re-run adds nothing and runs; --labelled-only adds only the company/ rule.
    let dir = await fresh(true);
    // A preview (no --yes) of a run that would need raw SQL is never refused: the guard sits after the preview return.
    const preview = await withEnv({ GBRAIN_HOME: dir, GBRAIN_SETUP_ABORT_AFTER: undefined }, () =>
      labelSeveral(asRust(arm.engine), ['alice-example', 'bob-example', 'carol-example'], 'default', false, true));
    expect({ applied: preview.applied, rules: preview.rules.some(r => r.action === 'add') }).toEqual({ applied: false, rules: true });
    expect(await outcomeOf(serves(asRust(arm.engine), ['alice-example', 'bob-example'], dir))).not.toContain('engine_capability_missing');
    await refusedUnchanged(dir, { labelledOnly: true, owner: 'owner-example' });
    // The company source arrives after the keys: the re-run's only write that needs raw SQL is widening the kept keys.
    dir = await fresh(false);
    await createSource(arm.engine, arm.backend, 'company');
    await refusedUnchanged(dir);
  }, 120_000);
});
