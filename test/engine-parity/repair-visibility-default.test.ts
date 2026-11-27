/**
 * Engine parity for the default preview of `gbrain repair visibility` (every class: facts, events, aliases, lineage),
 * which `gbrain repair --all` and `doctor --remediate` run on every brain.
 *
 * - An empty brain previews nothing, the same on every arm.
 * - An atom and a Life Chronicle event of a private origin, and a page private by a privacy alias alone, are listed the
 *   same on every arm, with the open twin in another source.
 * - The apply of those page items writes them the same on every arm, through the repair runner, the
 *   `gbrain repair visibility --apply --json` command and `gbrain repair --all --apply --json`; the printed JSON answers
 *   are byte-equal once ids, hashes and times are replaced by their shape.
 */
import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { resolveRepairScope, type RepairResult } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { runRepairCommand } from '../../src/commands/repair.ts';
import { runRemediate, runRemediationPlan } from '../../src/commands/doctor/remediate.ts';

const { parityTest } = parityArms(testBackends());
const quiet = { info() {}, warn() {}, error() {} } as never;

function shape(result: RepairResult) {
  const { scope, ...rest } = result;
  return JSON.parse(JSON.stringify({ ...rest, scope: { brain_id: typeof scope.brain_id, source_ids: scope.source_ids } })
    .replace(/\b[0-9a-f]{64}\b/g, '<sha256>').replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>'));
}
async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-visibility-default-'));
  try { return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, fn); }
  finally { rmSync(home, { recursive: true, force: true }); }
}
const preview = async (engine: BrainEngine) =>
  shape(await (await repairRunner(engine, { apply: false, noEmbed: true, logger: quiet })).run('visibility', await resolveRepairScope(engine), { explicit: true }));
/** The page items the apply writes: an alias-only private page and its private origin. */
async function seedPageItems(engine: BrainEngine): Promise<void> {
  await engine.putPage('notes/origin', note('Origin', { visibility: 'private' }), { sourceId: 'default' });
  await engine.putPage('notes/aliased', note('Aliased', { access: 'private' }), { sourceId: 'default' });
}
/** The stored frontmatter of the seeded pages after a run. */
async function pageLabels(engine: BrainEngine) {
  const out: Record<string, unknown> = {};
  for (const slug of ['notes/origin', 'notes/aliased']) out[slug] = (await engine.getPage(slug, { sourceId: 'default' }))?.frontmatter ?? null;
  return out;
}
/** What `run` prints with console.log, joined; the command's own output, not a re-rendering. */
async function printed(run: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try { await run(); } finally { console.log = log; }
  return lines.join('\n');
}
/** A printed JSON answer with the brain id, hashes, uuids, run ids and times replaced by their shape. */
function normalized(text: string): string {
  return text.replace(/\b[0-9a-f]{64}\b/g, '<sha256>').replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/g, '<time>').replace(/"(elapsed_ms|duration_ms|ms)":\s*\d+/g, '"$1":<n>');
}
const fence = (rows: string[]) => `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${rows.join('\n')}
<!--- gbrain:facts:end -->`;
/** A private page whose facts fence holds a world row, and that row's fact (a world fact from a private source). */
async function seedFencedFact(engine: BrainEngine): Promise<number> {
  await engine.putPage('notes/diary', { type: 'note', title: 'Diary', timeline: '', frontmatter: { visibility: 'private' },
    compiled_truth: `Diary.\n\n## Facts\n\n${fence(['| 1 | Alice-example likes tea | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |'])}\n` });
  await engine.insertFacts([{ fact: 'Alice-example likes tea', entity_slug: null, kind: 'fact', visibility: 'world', source: 'fence',
    row_num: 1, source_markdown_slug: 'notes/diary', embedding: null } as never], { source_id: 'default' });
  return Number((await engine.listWorldFactsFromPrivateSources(['default'], null))[0]!.id);
}
const note = (title: string, frontmatter: Record<string, unknown> = {}, type = 'note') => ({ type: type as 'note', title, compiled_truth: `${title} body.`, timeline: '', frontmatter });

describe('engine parity: gbrain repair visibility default preview', () => {

  parityTest('visibility default preview (all classes) on an empty brain answers the same on every arm', {
    methods: ['listWorldFactsFromPrivateSources', 'listConceptLineageRows'], timeout: 60_000,
  }, async (engine) => withHome(async () => {
    const out = await preview(engine);
    expect(out.affected).toBe(0);
    return out;
  }));

  parityTest('visibility default preview lists an atom, a chronicle event and an alias-only page of a private origin, and the open twin, the same on every arm', {
    methods: ['putPage', 'insertSource', 'listWorldFactsFromPrivateSources', 'listConceptLineageRows'], timeout: 60_000,
  }, async (engine) => withHome(async () => {
    await engine.putPage('notes/origin', note('Origin', { visibility: 'private' }), { sourceId: 'default' });
    await engine.putPage('notes/aliased', note('Aliased', { access: 'private' }), { sourceId: 'default' });
    await engine.putPage('atoms/one', note('Atom', { source_slug: 'notes/origin', visibility: 'world' }, 'atom'), { sourceId: 'default' });
    await engine.putPage('events/one', note('Event', { captured_via: 'life-chronicle:example', event: { depth: 'notes/origin' } }, 'event'), { sourceId: 'default' });
    await engine.insertSource({ id: 'other-example', name: 'other-example', local_path: null, config: {} });
    await engine.putPage('notes/aliased', note('Twin', { visibility: 'world' }), { sourceId: 'other-example' });
    const out = await preview(engine);
    const listed = (out.listing as Array<{ item: string }>).map(entry => entry.item).sort();
    expect(listed).toEqual(['default:atoms/one', 'default:events/one', 'default:notes/aliased'].sort());
    expect((out.residuals as Record<string, number>).open_twins).toBe(1);
    return out;
  }));
  parityTest('visibility apply of the page items writes them on every arm', {
    methods: ['putPage', 'listWorldFactsFromPrivateSources', 'listConceptLineageRows', 'listPageRefsByIds'], timeout: 90_000,
  }, async (engine) => withHome(async () => {
    await seedPageItems(engine);
    const previewed = await (await repairRunner(engine, { apply: false, noEmbed: true, logger: quiet })).run('visibility', await resolveRepairScope(engine), { explicit: true });
    const applied = await (await repairRunner(engine, { apply: true, noEmbed: true, logger: quiet })).run('visibility', await resolveRepairScope(engine), { explicit: true, expect: previewed.preview_hash! });
    return { applied: shape(applied), pages: await pageLabels(engine) };
  }));

  parityTest('CLI: gbrain repair visibility --apply --json prints the same answer on every arm', {
    methods: ['putPage', 'listWorldFactsFromPrivateSources', 'listPageRefsByIds'], timeout: 90_000,
  }, async (engine) => withHome(async () => {
    await seedPageItems(engine);
    const preview = JSON.parse(await printed(() => runRepairCommand(engine, ['visibility', '--json']))) as { results: Array<{ preview_hash?: string }> };
    const hash = preview.results[0]!.preview_hash!;
    const applied = await printed(() => runRepairCommand(engine, ['visibility', '--apply', '--expect', hash, '--json']));
    const answer = { preview: normalized(JSON.stringify(preview)), applied: normalized(applied), pages: await pageLabels(engine) };
    expect((JSON.parse(applied) as { mode: string }).mode).toBe('apply');
    return answer;
  }));

  parityTest('CLI: gbrain repair --all --apply --json reaches the visibility apply and prints the same answer on every arm', {
    methods: ['putPage', 'listWorldFactsFromPrivateSources', 'listPageRefsByIds'], timeout: 120_000,
  }, async (engine) => withHome(async () => {
    await seedPageItems(engine);
    const applied = await printed(() => runRepairCommand(engine, ['--all', '--apply', '--json']));
    const results = (JSON.parse(applied) as { results: Array<{ kind: string }> }).results;
    expect(results.map(r => r.kind)).toContain('visibility');
    return { applied: normalized(applied), pages: await pageLabels(engine) };
  }));

  parityTest('visibility apply rewrites a fenced world fact of a private page as private, the same on every arm', {
    methods: ['putPage', 'insertFacts', 'listWorldFactsFromPrivateSources', 'readFactLiveVisibility'], timeout: 90_000,
  }, async (engine) => withHome(async () => {
    const factId = await seedFencedFact(engine);
    const preview = JSON.parse(await printed(() => runRepairCommand(engine, ['visibility', '--json']))) as { results: Array<{ preview_hash?: string }> };
    const applied = await printed(() => runRepairCommand(engine, ['visibility', '--apply', '--expect', preview.results[0]!.preview_hash!, '--json']));
    const page = await engine.getPage('notes/diary', { sourceId: 'default' });
    const stored = await engine.readFactLiveVisibility(factId);
    const answer = { applied: normalized(applied), fenceRowPrivate: /\| 1 \| Alice-example likes tea \| fact \| 1\.0 \| private \|/.test(page?.compiled_truth ?? ''),
      worldLeft: (await engine.listWorldFactsFromPrivateSources(['default'], null)).length, storedPrivate: stored?.visibility === 'private' || stored?.live === false };
    expect({ fenceRowPrivate: answer.fenceRowPrivate, worldLeft: answer.worldLeft, storedPrivate: answer.storedPrivate })
      .toEqual({ fenceRowPrivate: true, worldLeft: 0, storedPrivate: true });
    return answer;
  }));

  parityTest('doctor --remediate --include-repairs runs the visibility apply and writes the page items the same on every arm', {
    methods: ['putPage', 'listWorldFactsFromPrivateSources', 'listPageRefsByIds'], timeout: 180_000,
  }, async (engine) => withHome(async () => {
    await seedPageItems(engine);
    const plan = JSON.parse(await printed(() => runRemediationPlan(engine, ['--no-embed', '--json']))) as { plan_hash?: string; repair_steps?: Array<{ kind: string }> };
    expect((plan.repair_steps ?? []).map(step => step.kind)).toContain('visibility');
    const ran = await printed(() => runRemediate(engine, ['--include-repairs', '--no-embed', '--yes', '--expect', plan.plan_hash!, '--json']));
    const repairs = ((JSON.parse(ran) as { repairs?: Array<{ kind: string; status: string; applied?: number }> }).repairs ?? [])
      .map(step => ({ kind: step.kind, status: step.status, applied: step.applied ?? null }));
    const visibility = repairs.filter(step => step.kind === 'visibility');
    expect(visibility.map(step => step.status)).toEqual(['completed']);
    return { repairs, pages: await pageLabels(engine) };
  }));
});
