/**
 * #6803 plan B7: the printed-command guard for held embedding budgets.
 *
 * Protects: every command `sizeStateLines`, `budget_limited` (`gbrain embed
 * --stale`), doctor `partial_embedding` (message, fix, preview, verify and
 * `details.by_source`), the `meterPageBatch` hold line, `gbrain embed --held`
 * and the edited docs print is rendered through `renderAction` with routing set
 * (brain `host`, source `alpha`) and runs in dry form through the real CLI on
 * a two-source brain with exit 0; no literal `<N>`; every approve names
 * `--source`; the every-source listing is not narrowed by the source pin.
 * Fails when: a surface prints `gbrain reindex --held` (which does not exist),
 * an approve without `--source` (refused on a multi-source brain), or a
 * placeholder.
 * Also guards the projection drain's printed commands (#6803 A9): `PROJECTIONS_HELP`,
 * `projectionFailureNextAction`, the resident drain steps and Action, doctor's
 * resident readiness, `formatDrainResult` and the repair and embedding-migration
 * docs, run on a multimodal brain because they name `embed --stale --images`.
 * Extension point: test/helpers/printed-command-guard.ts (`PRINTED_COMMAND_PRODUCERS`).
 * Serial: it installs the process-wide CLI fix routing (installCliRouting), which
 * every renderAction in the process reads.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { __resetCliRoutingForTests, installCliRouting } from '../src/core/fix-routing.ts';
import { addSizeState, readPageSizeStates, sizeStateLines, type SyncSizeStates } from '../src/core/page-embedding-budget.ts';
import { budgetLimitedReport } from '../src/core/held-embedding.ts';
import { heldPreviewCommand } from '../src/core/held-embedding-action.ts';
import { argvOf, gbrain, makeHeldBrain, seedHeldPage, startFakeEmbeddings, withBrain, type FakeEmbeddings, type HeldBrain } from './helpers/held-embedding-fixture.ts';
import { PROJECTIONS_HELP, formatDrainResult, projectionFailureNextAction, residentDrainAction, residentDrainSteps } from '../src/commands/projections.ts';
import { residentProjectionReadiness } from '../src/commands/doctor/checks/projection-readiness.ts';
import { PRINTED_COMMAND_PRODUCERS, docSection, dryForm, extractCommands, registerPrintedCommandProducer, type GuardFixture } from './helpers/printed-command-guard.ts';

const ROUTING = { brain: 'host', source: 'alpha' };
/** The held-embedding commands of a doc section (the embed approvals and previews, doctor's check); the rest of the section is other lanes' surface. */
const heldCommand = (argv: string[]) => (argv[0] === 'embed' && (argv.includes('--held') || argv.includes('--slugs'))) || (argv[0] === 'doctor' && argv.includes('partial_embedding'));

registerPrintedCommandProducer({
  name: 'sizeStateLines (sync, put_page and remember receipts)',
  text: async ({ brain }) => withBrain(brain, async engine => {
    let tally: SyncSizeStates | undefined;
    for (const source of ['default', 'alpha']) for (const state of await readPageSizeStates(engine, source, null)) tally = addSizeState(tally, state);
    return sizeStateLines(tally).join('\n');
  }),
});
registerPrintedCommandProducer({
  name: 'budget_limited, rendered in-process',
  text: async ({ brain }) => withBrain(brain, async engine => {
    const found = (await budgetLimitedReport(engine, { signature: null }))!;
    return [found.line, found.report.preview_command, ...found.report.by_source.map(s => s.fix.command!)].join('\n');
  }),
});
registerPrintedCommandProducer({
  name: 'gbrain embed --stale (budget_limited line and JSON)',
  text: async ({ run }) => {
    const out = await run(['embed', '--stale', '--json']);
    const doc = JSON.parse(out.stdout);
    return [out.stderr, doc.budget_limited.preview_command, doc.budget_limited.fix.command, ...doc.budget_limited.by_source.map((s: { fix: { command: string } }) => s.fix.command)].join('\n');
  },
});
registerPrintedCommandProducer({
  name: 'doctor partial_embedding',
  text: async ({ run }) => {
    const out = await run(['doctor', '--only', 'partial_embedding', '--json'], { GBRAIN_SOURCE: 'alpha' });
    const check = JSON.parse(out.stdout).checks.find((c: { name: string }) => c.name === 'partial_embedding');
    expect(check.status).toBe('warn');
    const fix = check.fix as { command: string; preview_argv: string[]; verify: { argv: string[] } };
    return [check.message, fix.command, fix.preview_argv.join(' '), fix.verify.argv.join(' '), check.details.preview_command,
      ...check.details.by_source.map((s: { fix: { command: string } }) => s.fix.command)].join('\n');
  },
});
registerPrintedCommandProducer({
  name: 'meterPageBatch hold line',
  text: async ({ run }) => (await run(['embed', '--slugs', 'archive/day-b', '--source', 'alpha'])).stderr,
});
registerPrintedCommandProducer({
  name: 'gbrain embed --held (listing and multi-source refusal)',
  text: async ({ run }) => {
    const listing = await run(['embed', '--held', '--dry-run']);
    expect(listing.exitCode, listing.stderr).toBe(0);
    const refused = await run(['embed', '--held', '--max-usd', '1']);
    expect(refused.exitCode).toBe(2);
    return `${listing.stdout}\n${listing.stderr}\n${refused.stderr}`;
  },
});
registerPrintedCommandProducer({
  name: 'docs/guides/memory-boundaries.md (large pages)',
  text: async () => [docSection('docs/guides/memory-boundaries.md', '## Large pages', '| Page body |'),
    docSection('docs/guides/memory-boundaries.md', 'id="large-pages-upgrade"', '## Where text goes')].join('\n'),
  fill: { '<id>': 'alpha', '<N>': '1', '<slug>': 'archive/day-b' },
  owns: heldCommand,
});
registerPrintedCommandProducer({
  name: 'docs/guides/troubleshooting.md (held embedding row)',
  text: async () => docSection('docs/guides/troubleshooting.md', 'chunks waiting for embedding approval'),
  fill: { '<id>': 'alpha', '<N>': '1' },
  owns: heldCommand,
});

/** Lane A (#6803 part 2, plan A9): the projection drain's printed commands join the guard. */
const MULTIMODAL = { GBRAIN_EMBEDDING_MULTIMODAL: 'true' };
const projectionCommand = (argv: string[]) => argv[0] === 'projections'
  || (argv[0] === 'embed' && argv.includes('--images')) || (argv[0] === 'doctor' && argv.includes('text_projection_readiness'));
registerPrintedCommandProducer({
  name: 'PROJECTIONS_HELP',
  text: async () => PROJECTIONS_HELP.split('\n').filter(l => !l.startsWith('Usage:')).join('\n'),
  fill: { '<n>': '10' },
  owns: projectionCommand,
  env: MULTIMODAL,
});
registerPrintedCommandProducer({
  name: 'projectionFailureNextAction',
  text: async () => ['Code projection requires a recorded source path', 'This page kind requires its source importer', 'revision_conflict: moved', 'other']
    .map(reason => projectionFailureNextAction({ source_id: 'alpha', slug: 'archive/day-b', reason })).join('\n'),
  owns: projectionCommand,
  env: MULTIMODAL,
});
registerPrintedCommandProducer({
  name: 'resident drain steps, Action and doctor readiness',
  text: async () => {
    const status = { pending: 2, failed: 0, oldest_age_seconds: 60, sealable: 3, sealable_with_visual: 1, reimport: 1, ocr_required: 1, protected: 1, archived: 0 };
    const action = residentDrainAction({ pid: 4242, subcommand: 'serve' } as never, 'host', status);
    const readiness = residentProjectionReadiness(4242, status, residentDrainSteps(4242, 'host', 10), action.then);
    return [residentDrainSteps(4242, 'host', 10), action.user_message ?? '', action.then?.argv?.join(' ') ?? '', action.then?.verify?.argv?.join(' ') ?? '',
      readiness.message, readiness.fix?.argv?.join(' ') ?? ''].join('\n');
  },
  owns: projectionCommand,
  env: MULTIMODAL,
});
registerPrintedCommandProducer({
  name: 'formatDrainResult (limited drain with image remainders)',
  text: async () => formatDrainResult({ rebuilt: 2, superseded: 0, failed: [], remaining: 4, limited: true, sealed: 3, sealed_with_visual: 1, sealed_text_only: 2,
    statistics_refreshed: false, remaining_by_class: { pending: 0, failed: 0, oldest_age_seconds: 60, sealable: 2, sealable_with_visual: 0, reimport: 1, ocr_required: 1, protected: 1, archived: 0 } } as never, 10),
  owns: projectionCommand,
  env: MULTIMODAL,
});
registerPrintedCommandProducer({
  name: 'docs/guides/repair.md (projection drain)',
  text: async () => docSection('docs/guides/repair.md', 'id="projection-drain"', 'id="embedding-key-source"'),
  fill: { '<n>': '10', '<id>': 'alpha' },
  owns: projectionCommand,
  env: MULTIMODAL,
});
registerPrintedCommandProducer({
  name: 'docs/guides/embedding-migration.md (recovery)',
  text: async () => docSection('docs/guides/embedding-migration.md', '## Recovery', '## '),
  fill: { '<n>': '10', '<id>': 'alpha' },
  owns: projectionCommand,
  env: MULTIMODAL,
});

let fake: FakeEmbeddings;
let brain: HeldBrain;
let fixture: GuardFixture;

beforeAll(async () => {
  fake = startFakeEmbeddings();
  brain = await makeHeldBrain('ollama:nomic-embed-text', { OLLAMA_BASE_URL: fake.url });
  await withBrain(brain, async engine => {
    await seedHeldPage(engine, 'archive/day-a', 'default', 3);
    await seedHeldPage(engine, 'archive/day-b', 'alpha', 2);
    await seedHeldPage(engine, 'archive/day-c', 'alpha', 2);
    await engine.executeRaw(`UPDATE page_embedding_budget SET state = 'capped', reason = 'cap_reached', cap_usd = 2, spent_usd = 2
      WHERE page_id = (SELECT id FROM pages WHERE slug = 'archive/day-c')`);
  });
  installCliRouting(() => ROUTING);
  fixture = { brain, run: (args, env) => gbrain(brain, args, env), routing: ROUTING };
}, 120_000);

afterAll(() => {
  __resetCliRoutingForTests();
  fake.stop();
  brain.cleanup();
});

test('the every-source listing opts out of the source pin; a source-scoped preview keeps it', () => {
  expect(heldPreviewCommand()).toBe('gbrain embed --held --dry-run --brain host');
  expect(heldPreviewCommand('default')).toBe('gbrain embed --held --dry-run --source default --brain host');
});

test('every printed command runs in dry form through the real CLI with exit 0', async () => {
  const failures: string[] = [];
  let guarded = 0;
  for (const producer of PRINTED_COMMAND_PRODUCERS) {
    const text = await producer.text(fixture);
    const commands = extractCommands(text).map(c => Object.entries(producer.fill ?? {}).reduce((s, [k, v]) => s.split(k).join(v), c))
      .filter(c => !producer.owns || producer.owns(argvOf(c)));
    if (commands.length === 0) failures.push(`${producer.name}: printed no gbrain command`);
    for (const command of commands) {
      guarded++;
      const argv = argvOf(command);
      if (command.includes('<') || command.includes('>')) { failures.push(`${producer.name}: placeholder left in ${command}`); continue; }
      if (argv[0] === 'reindex' && argv.includes('--held')) { failures.push(`${producer.name}: ${command} does not exist`); continue; }
      if (argv[0] === 'embed' && argv.includes('--max-usd') && !argv.includes('--source')) { failures.push(`${producer.name}: approve without --source: ${command}`); continue; }
      const out = await fixture.run(dryForm(argv), producer.env);
      if (out.exitCode !== 0) failures.push(`${producer.name}: gbrain ${dryForm(argv).join(' ')} exited ${out.exitCode}: ${(out.stderr || out.stdout).slice(0, 400)}`);
    }
  }
  expect(failures).toEqual([]);
  expect(guarded).toBeGreaterThan(10);
}, 280_000);
