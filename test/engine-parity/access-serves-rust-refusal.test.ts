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

const serves = (engine: BrainEngine, roster: string[], dir: string) =>
  withEnv({ GBRAIN_HOME: dir, GBRAIN_SETUP_ABORT_AFTER: undefined }, () => labelSeveral(engine, roster, 'default', true, true));

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
      const outcome = await serves(arm.engine, ['alice-example', 'bob-example'], dir)
        .then(r => `ran: ${r.completed.join(',')}${r.error ? `, stopped: ${r.error.code}` : ''}`, (e: { code?: string }) => e.code);
      const changed = (await stored(arm.engine, dir)) !== before;
      expect({ backend: arm.backend, outcome, changed }).toEqual(arm.backend === 'rust'
        ? { backend: 'rust', outcome: 'engine_capability_missing', changed: false }
        : { backend: arm.backend, outcome: 'ran: members,rules,keys,config', changed: true });
    }
  }, 120_000);
});
