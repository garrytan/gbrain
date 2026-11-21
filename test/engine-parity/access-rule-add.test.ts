/**
 * BrainEngine parity — `gbrain access rule add`, run through the command (src/commands/access-rules.ts runAccessRules),
 * so the real preview runs: the covered-page counts, the members and credentials that lose pages, and the held-fact
 * move plan (facts/held-fact-move.ts planHeldMoves) over every holding page.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    the preview prints the same JSON, `--yes` applies the rule and prints the same JSON, and a brain that holds facts
 *    on a holding page for an entity under the new prefix previews and moves the same rows.
 *  - Regression: at ac7c6fdf42 the Rust preview stopped on listHeldMoveRows (engine_capability_missing) before any
 *    write, so `gbrain access rule add`, `rule rm`, `rule revert` and `rule import` refused on Rust; the 32b-1 cases
 *    wrote rules through proposeRevision and skipped the preview.
 *  - Why existing coverage misses it: access-rules.test.ts calls proposeRevision, and test/access-folder-rules*.test.ts
 *    run on the SQL engines only.
 *  - Seam: none. Members through addMember, pages through putPage, held facts through insertFacts.
 */
import { describe, expect, test } from 'bun:test';
import { createSource, parityArms, resetArm } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';
import { addMember } from '../../src/core/access/members.ts';
import { runAccessRules } from '../../src/commands/access-rules.ts';

const { parityTest, arms } = parityArms(testBackends());

const note = (title: string) => ({ type: 'note' as const, title, compiled_truth: `body ${title}`, timeline: '', frontmatter: {} });

/** What `gbrain access rule ...` prints to stdout with --json, or the refusal it throws. */
async function cli(engine: BrainEngine, argv: string[]): Promise<{ out: string } | { refused: string | undefined; message: string }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await runAccessRules(engine, argv[0]!, argv.slice(1), true);
    return { out: lines.join('\n') };
  } catch (error) {
    return { refused: (error as { code?: string }).code, message: (error as Error).message };
  } finally {
    console.log = log;
  }
}

/** The JSON a command printed, with the operation id (a fresh UUID per run) blanked. */
const printed = (r: Awaited<ReturnType<typeof cli>>) =>
  'out' in r ? JSON.parse(r.out.replace(/"operation_id": "(acc_)?[0-9a-f-]{36}"/g, '"operation_id": "<id>"')) as Record<string, unknown> : r;

async function seed(engine: BrainEngine): Promise<void> {
  await engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
  await addMember(engine, 'alice-example');
  await addMember(engine, 'bob-example');
  await engine.putPage('partners/alice/deal', note('Deal'), { sourceId: 'default' });
  await engine.putPage('partners/alice/notes', note('Notes'), { sourceId: 'default' });
  await engine.putPage('notes/open', note('Open'), { sourceId: 'default' });
}

const ADD = ['rule', 'add', '--prefix', 'partners/alice/', '--readers', 'alice-example', '--source', 'default'];

describe('engine parity: gbrain access rule add runs its real preview', () => {
  parityTest('the preview and the --yes write print the same JSON, and the rule applies', {
    methods: ['countRuleCoveredPages', 'listRuleCoveredSlugs', 'listHeldMoveRows', 'listStruckHeldRows', 'isFolderRestricted'],
  }, async (engine) => {
    await seed(engine);
    const preview = printed(await cli(engine, ADD));
    const write = printed(await cli(engine, [...ADD, '--yes']));
    const restricted = await engine.isFolderRestricted('default', 'partners/alice/deal');
    expect(preview).toMatchObject({ applied: false, matched_pages: { 'partners/alice/': 2 } });
    expect(write).toMatchObject({ state: 'applied' });
    expect(restricted).toBe(true);
    return { preview, write, restricted };
  });

  // GST-2603: same-slug pages in other sources the narrowed rule leaves readable are listed as open twins; a twin only
  // the rule's readers read, or one private by its own labels, is not.
  parityTest('the preview lists the open twins in other sources that an outside reader still reads', {
    methods: ['listOpenTwinRows'],
  }, async (engine, backend) => {
    await seed(engine);
    for (const id of ['team', 'zeta', 'kept']) await createSource(engine, backend, id);
    await engine.putPage('partners/alice/deal', note('Team deal'), { sourceId: 'team' });
    await engine.putPage('partners/alice/notes', note('Zeta notes'), { sourceId: 'zeta' });
    await engine.putPage('partners/alice/deal', { ...note('Kept deal'), frontmatter: { readable_by: ['alice-example'] } }, { sourceId: 'kept' });
    await engine.putPage('partners/alice/notes', { ...note('Private notes'), frontmatter: { visibility: 'private' } }, { sourceId: 'kept' });
    const preview = printed(await cli(engine, ADD));
    expect(preview).toMatchObject({ open_twins: { count: 2 } });
    return preview;
  });

  // A brain that holds facts on memory/unattributed, one for an entity the new rule covers. Held rows move only on a
  // strict git-canonical source (holdingHome reads getWorktreeBinding), which no Rust brain can be, so on a repo-less
  // brain the preview plans no move on any arm and the rows stay; the plan still reads every holding page.
  parityTest('on a brain with held facts the preview and the write print the same JSON, and the held rows stay', {
    methods: ['putPage', 'insertFacts', 'listHeldMoveRows', 'listStruckHeldRows'],
  }, async (engine) => {
    await seed(engine);
    await engine.putPage('memory/unattributed', note('Held'), { sourceId: 'default' });
    await engine.insertFacts([
      { fact: 'Alice prefers mornings', entity_slug: 'partners/alice/profile', kind: 'fact', visibility: 'world', source: 'fence', row_num: 1, source_markdown_slug: 'memory/unattributed' },
      { fact: 'Bob is in Turin', entity_slug: 'people/bob-example', kind: 'fact', visibility: 'world', source: 'fence', row_num: 2, source_markdown_slug: 'memory/unattributed' },
    ] as never, { source_id: 'default' });
    const preview = printed(await cli(engine, ADD));
    const write = printed(await cli(engine, [...ADD, '--yes']));
    const held = (await engine.listHeldMoveRows('default')).map(r => `${r.from_slug}|${r.entity_slug}|${r.fact}`);
    expect(preview).toMatchObject({ applied: false, held_facts_moving: [], held_struck_rows_leaving: 0 });
    expect(held).toEqual(['memory/unattributed|partners/alice/profile|Alice prefers mornings', 'memory/unattributed|people/bob-example|Bob is in Turin']);
    return { preview, write, held };
  });

  // The two held-move reads that judge folder rules: the access state of an entity and whether a move is due.
  parityTest('readHeldAccessState and heldMoveDue judge the folder rules and the pending prefixes', {
    methods: ['readHeldAccessState', 'heldMoveDue'],
  }, async (engine) => {
    await seed(engine);
    await engine.putPage('memory/unattributed', note('Held'), { sourceId: 'default' });
    await engine.insertFacts([
      { fact: 'Alice prefers mornings', entity_slug: 'partners/alice/profile', kind: 'fact', visibility: 'world', source: 'fence', row_num: 1, source_markdown_slug: 'memory/unattributed' },
    ] as never, { source_id: 'default' });
    const before = { state: await engine.readHeldAccessState('default', 'partners/alice/profile'), due: await engine.heldMoveDue('default') };
    await cli(engine, [...ADD, '--yes']);
    const after = {
      covered: await engine.readHeldAccessState('default', 'partners/alice/profile'),
      exact: await engine.readHeldAccessState('default', 'partners/alice/'),
      open: await engine.readHeldAccessState('default', 'notes/open'),
      due: await engine.heldMoveDue('default'),
    };
    expect(before).toEqual({ state: [{ unreadable: false, page_rule: false, restricted: false }], due: false });
    expect(after.covered).toEqual([{ unreadable: false, page_rule: false, restricted: true }]);
    expect(after.exact).toEqual([{ unreadable: false, page_rule: true, restricted: true }]);
    expect(after.due).toBe(true);
    return { before, after };
  });
});

describe('the Rust arm runs gbrain access rule add', () => {
  // A parity case counts a typed refusal as a pass, so this reads the Rust arm's own engine: it is red while the preview
  // stops on Rust, and the rule must hide the folder from a member it does not name.
  test('the preview and the write run on Rust and the folder is restricted', async () => {
    const rust = arms().find((arm) => arm.backend === 'rust');
    if (!rust) return;
    await resetArm(rust);
    await seed(rust.engine);
    expect(printed(await cli(rust.engine, ADD))).toMatchObject({ applied: false, matched_pages: { 'partners/alice/': 2 } });
    expect(printed(await cli(rust.engine, [...ADD, '--yes']))).toMatchObject({ state: 'applied' });
    expect(await rust.engine.isFolderRestricted('default', 'partners/alice/deal')).toBe(true);
  });
});
