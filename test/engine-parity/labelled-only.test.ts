/**
 * BrainEngine parity — the labelled-only page policy (GBRA-108 design 1: CallerAccess.labelledOnly, labelledOnlySql and
 * labelledOnlyFactSql in src/core/search/private-visibility.ts): a member that carries the labelled-only grant reads only
 * the pages that name it, by readable_by or a folder rule that lists it, and no fact except its own member page's.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    a labelled-only member reads the page that names it and the pages under a folder rule that lists it, never an
 *    unlabelled page or a page kept to someone else, and a member without the grant still reads the open page. Facts:
 *    the labelled-only member reads the facts of its own member page only.
 *  - Regression: the Rust store's page policy did not serve a labelled-only caller, so every read such a caller made
 *    refused with engine_capability_missing (docs/designs/RUST_ENGINE.md row 32e).
 *  - Why existing coverage misses it: access-members.test.ts reads one core-page list and pins the Rust refusal;
 *    test/access-labelled-only.test.ts runs on the SQL engines only.
 *  - Seam: none. Members through addMember and setMemberLabelledOnly, rules through proposeRevision, pages through
 *    putPage, facts through insertFacts; each caller is the stdio server bound to the member (mcp.stdio_member).
 */
import { describe, expect, test } from 'bun:test';
import { parityArms, resetArm } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';
import { addMember } from '../../src/core/access/members.ts';
import { setMemberLabelledOnly } from '../../src/core/access/labelled-only.ts';
import { proposeRevision } from '../../src/core/access/policy.ts';
import { remoteCallerAccess } from '../../src/core/access/caller.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';

const { parityTest, arms } = parityArms(testBackends());

const core = (title: string, frontmatter: Record<string, unknown> = {}) =>
  ({ type: 'note' as const, title, compiled_truth: `body ${title}`, timeline: '', frontmatter: { always_load: true, ...frontmatter } });

/** alice (labelled-only, group team-a), bob; an open page, pages kept to each, a team page, and a folder rule. */
async function seed(engine: BrainEngine): Promise<void> {
  await engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
  await addMember(engine, 'alice-example', { groups: ['team-a'] });
  await addMember(engine, 'bob-example');
  await setMemberLabelledOnly(engine, 'alice-example', true, { remote: false });
  await engine.putPage('core/open', core('Open'), { sourceId: 'default' });
  await engine.putPage('core/for-alice', core('For alice', { readable_by: ['alice-example'] }), { sourceId: 'default' });
  await engine.putPage('core/for-bob', core('For bob', { readable_by: ['bob-example'] }), { sourceId: 'default' });
  await engine.putPage('core/for-team', core('For team', { readable_by: ['group:team-a'] }), { sourceId: 'default' });
  await engine.putPage('deals/q4', core('Q4'), { sourceId: 'default' });
  await proposeRevision(engine, 'default', [{ id: 'deals', prefix: 'deals/', readable_by: ['member:alice-example', 'member:bob-example'] }], { origin: 'cli', store: 'database' });
}

/** Runs `read` as the stdio server bound to `member`. */
async function as<T>(engine: BrainEngine, member: string, read: () => Promise<T>): Promise<T> {
  await engine.setConfig('mcp.stdio_member', member);
  return withCallerAccess(await remoteCallerAccess(engine, undefined, [], 'stdio'), read);
}

const corePages = async (engine: BrainEngine) =>
  (await engine.listCorePageRows({ excludePrivate: true, forCaller: true, limit: 50 })).map(r => r.slug).sort();

describe('engine parity: the labelled-only page policy', () => {
  // The read-side leak, first: a labelled-only member never reads an unlabelled page or a page kept to someone else.
  parityTest('a labelled-only member reads only the pages that name it, by readers or by a folder rule', {
    methods: ['listCorePageRows'],
  }, async (engine) => {
    await seed(engine);
    const alice = await as(engine, 'alice-example', () => corePages(engine));
    const bob = await as(engine, 'bob-example', () => corePages(engine));
    expect(alice).toEqual(['core/for-alice', 'core/for-team', 'deals/q4']);
    expect(bob).toEqual(['core/for-bob', 'core/open', 'deals/q4']);
    return { alice, bob };
  });

  parityTest('a labelled-only member reads the facts of its own member page only', {
    methods: ['insertFacts', 'listFactsByEntity'],
  }, async (engine) => {
    await seed(engine);
    await engine.putPage('memory/members/alice-example', core('Alice memory', { readable_by: ['member:alice-example'] }), { sourceId: 'default' });
    const fact = (text: string, page: string, row: number) =>
      ({ fact: text, entity_slug: 'people/carol-example', kind: 'fact', visibility: 'world', source: 'fence', row_num: row, source_markdown_slug: page });
    await engine.insertFacts([
      fact('Carol likes tea', 'core/open', 1),
      fact('Carol joined in May', 'core/for-alice', 2),
      fact('Carol is a mentor', 'memory/members/alice-example', 3),
    ] as never, { source_id: 'default' });
    const read = async () => (await engine.listFactsByEntity('default', 'people/carol-example', { excludePrivate: true } as never)).map(f => f.fact).sort();
    const alice = await as(engine, 'alice-example', read);
    const bob = await as(engine, 'bob-example', read);
    // alice: only her own member page's fact; bob: the open page's (core/for-alice and the member page name others).
    expect({ alice, bob }).toEqual({ alice: ['Carol is a mentor'], bob: ['Carol likes tea'] });
    return { alice, bob };
  });
});

describe('the Rust arm serves the labelled-only page policy', () => {
  // A parity case counts a typed refusal as a pass, so this reads the Rust arm's own engine: it is red while the store
  // page policy refuses a labelled-only caller.
  test('a labelled-only member reads only its labelled pages on Rust', async () => {
    const rust = arms().find((arm) => arm.backend === 'rust');
    if (!rust) return;
    await resetArm(rust);
    await seed(rust.engine);
    expect(await as(rust.engine, 'alice-example', () => corePages(rust.engine))).toEqual(['core/for-alice', 'core/for-team', 'deals/q4']);
  });
});
