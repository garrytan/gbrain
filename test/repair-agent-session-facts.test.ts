/**
 * `gbrain repair agent-session-facts` (#8064) and doctor `agent_session_facts`, on keyless PGLite brains with no
 * git repository (an unmanaged brain, and a managed one whose content root is a plain directory).
 *
 * Protects: capture-lane facts from agent-launched sessions (speaker sidecar, an operator --cwd prefix or --session id)
 * are re-attributed to the agent with a speaker note; a session whose first user turn repeats across 3+ other sessions
 * is listed ambiguous and applied only with --include-ambiguous; a claim the owner also stated is kept; facts of a
 * session with no retained corpus are counted and untouched; fenced rows are rewritten in their page and database-only
 * rows in place; a fact/self take is retired only when every contributing fact is non-user; nothing is deleted; the
 * apply is bound to the preview hash and flags; a fact edited since the preview is kept.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { agentSessionFactsCheck } from '../src/commands/doctor/checks/agent-session-facts.ts';
import { runWaveChecks } from '../src/commands/doctor/wave-checks.ts';
import { writeSpeakerSidecar, speakerContextNote } from '../src/core/context/session-speaker.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { writeSingleFact } from '../src/core/facts/write-single.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { randomUUID } from 'node:crypto';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const ALICE = 'people/alice-example';
const ACME = 'companies/acme-example';
const BRIEF = 'You are worker agent seven for the release crew. Read the brief below, follow the repository rules, keep commits small, '
  + 'and report back to the coordinator with a summary of what changed and what is still open.';

interface RepairJson { results: Array<{ affected: number; residuals: Record<string, number>; apply_command: string; applied: number;
  listing?: Array<{ item: string; class: string; detail?: string }>; outcomes?: Record<string, number> }> }

async function repair(engine: BrainEngine, args: string[]): Promise<RepairJson> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
  try { await runRepairCommand(engine, ['agent-session-facts', ...args, '--json']); } finally { console.log = original; }
  return JSON.parse(lines.join('\n')) as RepairJson;
}
const applyArgs = (json: RepairJson) => json.results[0].apply_command.split(' ').slice(3);
const classes = (json: RepairJson) => Object.fromEntries((json.results[0].listing ?? []).filter(l => l.item.includes('#')).map(l => [Number(l.item.split('#')[1]), l.class]));

async function refusal(run: () => Promise<unknown>): Promise<OperationError> {
  try { await run(); } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a refusal');
}

const attribution = async (engine: BrainEngine, id: number) => (await engine.executeRaw<{ attributed_to: string | null; context: string | null; active: boolean }>(
  'SELECT attributed_to, context, expired_at IS NULL AS active FROM facts WHERE id=$1', [id]))[0]!;
const takeActive = async (engine: BrainEngine, id: number) => (await engine.executeRaw<{ active: boolean }>('SELECT active FROM takes WHERE id=$1', [id]))[0]!.active;
const counts = async (engine: BrainEngine) => (await engine.executeRaw<{ facts: number; takes: number }>(
  'SELECT (SELECT count(*)::int FROM facts) AS facts, (SELECT count(*)::int FROM takes) AS takes'))[0]!;

/** A session corpus with: a sidecar session, a cwd session, a listed session, four sessions opening with one brief, an owner session. */
function corpusFixture(base: string) {
  const corpus = join(base, 'corpus');
  const spool = join(corpus, 'sourced');
  mkdirSync(spool, { recursive: true });
  const agents = join(base, 'agents');
  mkdirSync(join(agents, 'run-1'), { recursive: true });
  mkdirSync(join(base, 'agents-other'), { recursive: true });
  const session = (id: string, firstTurn: string) => writeFileSync(join(corpus, `${id}.txt`), `[user]\n${firstTurn}\n\n[assistant]\nOn it.`);
  const record = (id: string, cwd: string) => writeFileSync(join(spool, `${id}.source.json`), JSON.stringify({ version: 1, session_id: id, source_id: null,
    tier: null, cwd, harness: 'claude', created_at: '2026-10-01T00:00:00Z', resolved_at: null, source_incarnation: null }));
  session('sess-sidecar', 'Please triage the open issues for the docs lane.');
  writeSpeakerSidecar(corpus, 'sess-sidecar', { principal: 'worker-a', source: 'env' }, 'claude');
  session('sess-cwd', 'Run the nightly lint pass and fix what it reports.');
  record('sess-cwd', join(agents, 'run-1'));
  session('sess-sibling', 'Summarize the metrics dashboard for this week.');
  record('sess-sibling', join(base, 'agents-other'));
  session('sess-listed', 'Rebuild the search index for the archive.');
  for (const n of [1, 2, 3, 4]) session(`sess-t${n}`, `${BRIEF}\nTask ${n}: handle ticket ${n * 11}.`);
  session('sess-owner', 'Alice Example and I talked about the launch plan today.');
  return { corpus, agents };
}

describe('gbrain repair agent-session-facts, unmanaged repo-less brain', () => {
  let engine: PGLiteEngine;
  let base: string;
  let corpus: string;
  let agents: string;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    base = mkdtempSync(join(tmpdir(), 'gbrain-agent-session-facts-'));
    ({ corpus, agents } = corpusFixture(base));
    await engine.setConfig('dream.synthesize.session_corpus_dir', corpus);
  });
  afterAll(() => { if (base) rmSync(base, { recursive: true, force: true }); });

  const insert = async (fact: string, session: string | null, opts: { entity?: string; source?: string; attributed?: string | null } = {}) => Number((await engine.executeRaw<{ id: number }>(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, source_session, attributed_to)
      VALUES ('default', $1, $2, 'preference', 'private', $3, $4, $5) RETURNING id`,
    [opts.entity ?? ALICE, fact, opts.source ?? 'hook:writeback', session, opts.attributed === undefined ? 'user' : opts.attributed]))[0]!.id);
  const take = async (claim: string, factIds: number[], createdBefore = '0 seconds') => {
    const [page] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug=$1 AND source_id='default'", [ALICE]);
    const [row] = await engine.executeRaw<{ id: number }>(`INSERT INTO takes (page_id, row_num, claim, kind, holder, weight, since_date, source, active, created_at)
      VALUES ($1, (SELECT COALESCE(MAX(row_num), 0) + 1 FROM takes WHERE page_id=$1), $2, 'fact', 'self', 0.8, '2026-10-01', 'hook:writeback', true, now() - $3::interval) RETURNING id`,
    [page!.id, claim, createdBefore]);
    await engine.executeRaw('UPDATE facts SET consolidated_into=$1, consolidated_at=now() WHERE id=ANY($2::bigint[])', [row!.id, factIds]);
    return Number(row!.id);
  };

  test('classification: sidecar, --cwd on path boundaries, --session, repeated opening, owner twin, unclassifiable', async () => {
    const sidecar = await insert('Prefers terse status updates', 'sess-sidecar');
    const sidecarCorpus = await insert('Wants every ticket closed by Friday', 'sweep:corpus:sess-sidecar.txt', { source: 'sweep:corpus' });
    const cwd = await insert('Believes lint warnings must block merges', 'sess-cwd', { source: 'hook:compact' });
    const sibling = await insert('Likes weekly metric summaries', 'sess-sibling');
    const listed = await insert('Commits to rebuilding the index nightly', 'sess-listed');
    const template = await insert('Prefers small commits', 'sess-t1');
    const ownerTwin = await insert('Prefers dark roast coffee', 'sess-sidecar');
    await insert('Prefers dark roast coffee', null, { source: 'cli:remember' });
    const owner = await insert('Is planning the launch', 'sess-owner');
    const gone = await insert('Likes long walks', 'sess-gone');
    const assistant = await insert('Assistant suggested a rollback', 'sess-sidecar', { attributed: 'assistant' });

    const bare = await repair(engine, []);
    expect(classes(bare)).toEqual({ [sidecar]: 'evidenced', [sidecarCorpus]: 'evidenced', [template]: 'ambiguous', [ownerTwin]: 'excluded:owner_also_said' });
    expect(bare.results[0].residuals).toMatchObject({ evidenced: 2, ambiguous: 1, excluded: 1, unclassifiable: 1, not_suspect: 4 });
    expect(bare.results[0].listing!.find(l => l.item.endsWith(`#${sidecar}`))!.detail).toContain('principal worker-a');

    const flagged = await repair(engine, ['--cwd', agents, '--session', 'sess-listed', '--principal', 'crew-b']);
    expect(classes(flagged)).toMatchObject({ [cwd]: 'evidenced', [listed]: 'evidenced' });
    expect(classes(flagged)[sibling]).toBeUndefined();
    expect(classes(flagged)[owner]).toBeUndefined();
    expect(classes(flagged)[gone]).toBeUndefined();
    expect(classes(flagged)[assistant]).toBeUndefined();
    expect(flagged.results[0].listing!.find(l => l.item.endsWith(`#${cwd}`))!.detail).toContain('principal crew-b');
    expect(flagged.results[0].apply_command).toContain(`--cwd ${agents} --session sess-listed --principal crew-b --apply --expect`);

    const finding = await agentSessionFactsCheck(engine);
    expect(finding.status).toBe('warn');
    expect(finding.details).toMatchObject({ evidenced: 2, ambiguous: 1, excluded: 1, unclassifiable: 1 });
    expect(finding.message).toContain('gbrain repair agent-session-facts');
    expect(finding.message).toContain('agreement');
    const wave = (await runWaveChecks(engine, { only: 'wave' })).find(f => f.spec.id === 'agent_session_facts')!;
    expect(wave.state).toBe('finding');
    expect(wave.spec.count(wave.check.details!)).toBe(3);
  }, 120_000);

  test('apply re-attributes, adds the note, retires only all-agent takes, deletes nothing; ambiguous needs --include-ambiguous', async () => {
    await engine.putPage(ALICE, { type: 'person', title: 'Alice Example', compiled_truth: '# Alice Example' }, { sourceId: 'default' });
    const a = await insert('Prefers terse status updates', 'sess-sidecar');
    const b = await insert('Prefers async standups', 'sess-cwd');
    const c = await insert('Prefers small commits', 'sess-t1');
    const ownerFact = await insert('Prefers async standups too', 'sess-owner');
    const agentOnly = await take('Prefers terse async updates', [a, b]);
    const mixed = await take('Prefers async standups', [b, ownerFact]);
    const ambiguousTake = await take('Prefers small commits', [c]);
    const before = await counts(engine);

    const preview = await repair(engine, ['--cwd', agents]);
    expect(preview.results[0].residuals).toMatchObject({ evidenced: 2, ambiguous: 1, takes_to_retire: 1 });
    expect(preview.results[0].listing!.filter(l => l.class === 'take_to_retire').map(l => l.item)).toEqual([`default:${ALICE}@take:${agentOnly}`]);
    expect((await refusal(() => repair(engine, ['--cwd', agents, '--apply']))).code).toBe('invalid_params');
    expect((await refusal(() => repair(engine, ['--cwd', agents, '--apply', '--expect', 'f'.repeat(16), '--yes']))).code).toBe('preview_changed');
    expect((await refusal(() => repair(engine, [...applyArgs(preview).filter(arg => arg !== agents && arg !== '--cwd')]))).code).toBe('preview_changed');

    const applied = await repair(engine, applyArgs(preview));
    expect(applied.results[0].outcomes).toEqual({ reattributed: 1, retired: 1 });
    for (const id of [a, b]) {
      const row = await attribution(engine, id);
      expect(row.attributed_to).toBe('other');
      expect(row.active).toBe(true);
    }
    expect((await attribution(engine, a)).context).toBe(speakerContextNote('worker-a'));
    expect((await attribution(engine, b)).context).toBe(speakerContextNote('agent-launched'));
    expect((await attribution(engine, c)).attributed_to).toBe('user');
    expect((await attribution(engine, ownerFact)).attributed_to).toBe('user');
    expect(await takeActive(engine, agentOnly)).toBe(false);
    expect(await takeActive(engine, mixed)).toBe(true);
    expect(await takeActive(engine, ambiguousTake)).toBe(true);
    expect(await counts(engine)).toEqual(before);

    const widened = await repair(engine, ['--cwd', agents, '--include-ambiguous']);
    expect(widened.results[0].apply_command).toContain('--include-ambiguous --apply --expect');
    expect(widened.results[0].residuals).toMatchObject({ evidenced: 0, ambiguous: 1, takes_to_retire: 1 });
    expect((await repair(engine, applyArgs(widened))).results[0].outcomes).toEqual({ reattributed: 1, retired: 1 });
    expect((await attribution(engine, c)).attributed_to).toBe('other');
    expect(await takeActive(engine, ambiguousTake)).toBe(false);
    expect(await takeActive(engine, mixed)).toBe(true);
    expect(await counts(engine)).toEqual(before);
    expect((await agentSessionFactsCheck(engine)).status).toBe('ok');
  }, 120_000);

  test('an owner take that consolidate later attached agent facts to is kept', async () => {
    await engine.putPage(ALICE, { type: 'person', title: 'Alice Example', compiled_truth: '# Alice Example' }, { sourceId: 'default' });
    const agentFact = await insert('Prefers written decisions over meetings', 'sess-sidecar');
    const ownerTake = await take('Prefers written decisions', [agentFact], '1 day');
    const preview = await repair(engine, ['--cwd', agents]);
    expect(preview.results[0].listing!.filter(l => l.class === 'take_to_retire').map(l => l.item)).not.toContain(`default:${ALICE}@take:${ownerTake}`);
    await repair(engine, applyArgs(preview));
    expect((await attribution(engine, agentFact)).attributed_to).toBe('other');
    expect(await takeActive(engine, ownerTake)).toBe(true);
  });

  test('one apply run walks the session corpus once, however many pages it re-attributes (#8080)', async () => {
    const ids: number[] = [];
    for (const entity of [ALICE, ACME, 'people/bob-example']) ids.push(await insert(`Prefers terse status updates on ${entity}`, 'sess-sidecar', { entity }));
    const preview = await repair(engine, []);
    expect(preview.results[0].residuals).toMatchObject({ evidenced: 3 });
    const walks = spyOn(fs, 'readdirSync');
    try {
      const applied = await repair(engine, applyArgs(preview));
      expect(applied.results[0].outcomes).toEqual({ reattributed: 3 });
      expect(walks.mock.calls.filter(([dir]) => dir === corpus).length).toBe(1);
    } finally { walks.mockRestore(); }
    for (const id of ids) expect(await attribution(engine, id)).toMatchObject({ attributed_to: 'other', context: speakerContextNote('worker-a'), active: true });
  }, 120_000);

  test('a fact edited after the preview reports changed_since_preview and keeps its attribution', async () => {
    const id = await insert('Prefers tea', 'sess-sidecar');
    const preview = await repair(engine, []);
    await engine.executeRaw("UPDATE facts SET visibility='world' WHERE id=$1", [id]);
    const applied = await repair(engine, applyArgs(preview));
    expect(applied.results[0].outcomes).toEqual({ changed_since_preview: 1 });
    expect((await attribution(engine, id)).attributed_to).toBe('user');
  }, 120_000);
});

async function seedEntity(engine: BrainEngine, root: string, slug: string, title: string, type: string) {
  const page = await engine.putPage(slug, { type: type as 'person', title, compiled_truth: `# ${title}` }, { sourceId: 'default' });
  await engine.executeRaw('UPDATE pages SET source_path=$1 WHERE id=$2', [`${slug}.md`, page.id]);
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
  mkdirSync(join(root, slug.split('/')[0]!), { recursive: true });
  writeFileSync(join(root, `${slug}.md`), serializePageToMarkdown(snapshot.page, snapshot.tags));
}

describe('gbrain repair agent-session-facts, managed repo-less brain', () => {
  test('fenced rows are rewritten in their page, database-only rows by one maintenance request; a fenced take struck in its page, a database-only one retired by the request', async () => {
    const base = mkdtempSync(join(tmpdir(), 'gbrain-agent-session-managed-'));
    try {
      const { corpus } = corpusFixture(base);
      await managedBrain(async ({ engine, ctx }) => {
        await engine.setConfig('dream.synthesize.session_corpus_dir', corpus);
        const write = (fact: string, entity: string | null) => writeSingleFact(engine, 'default', { fact, entity, provenance: 'hook:writeback', sessionId: 'sess-sidecar' }).then(r => r.id);
        const fenced = await write('Alice Example prefers terse status updates', ALICE);
        const fencedAcme = await write('Acme Example ships on Fridays', ACME);
        const dbOnly = await write('Carol Absent dislikes long meetings', 'Carol Absent');
        expect((await engine.executeRaw<{ row_num: number | null }>('SELECT row_num FROM facts WHERE id=$1', [fenced]))[0]!.row_num).not.toBeNull();
        expect((await engine.executeRaw<{ row_num: number | null }>('SELECT row_num FROM facts WHERE id=$1', [dbOnly]))[0]!.row_num).toBeNull();
        const [page] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug=$1 AND source_id='default'", [ACME]);
        const takeId = await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
          const [row] = await tx.executeRaw<{ id: number }>(`INSERT INTO takes (page_id, row_num, claim, kind, holder, weight, since_date, source, active)
            VALUES ($1, 90, 'Acme Example ships on Fridays', 'fact', 'self', 0.8, '2026-10-01', 'hook:writeback', true) RETURNING id`, [page!.id]);
          await tx.executeRaw('UPDATE facts SET consolidated_into=$1, consolidated_at=now() WHERE id=$2', [row!.id, fencedAcme]);
          return Number(row!.id);
        }, TEST_WRITE_ATTRIBUTION));
        await submitPageMutation(ctx, { operation: 'takes_add', params: { request_id: randomUUID(), slug: ALICE, claim: 'Alice Example prefers terse updates',
          kind: 'fact', holder: 'self', weight: 0.8 } });
        const [fencedTake] = await engine.executeRaw<{ id: number }>("SELECT t.id FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.slug=$1 AND t.claim='Alice Example prefers terse updates'", [ALICE]);
        await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () =>
          tx.executeRaw('UPDATE facts SET consolidated_into=$1, consolidated_at=now() WHERE id=$2', [fencedTake!.id, fenced]), TEST_WRITE_ATTRIBUTION));
        const before = await counts(engine);

        const preview = await repair(engine, []);
        expect(classes(preview)).toEqual({ [fenced]: 'evidenced', [fencedAcme]: 'evidenced', [dbOnly]: 'evidenced' });
        expect(preview.results[0].residuals).toMatchObject({ takes_to_retire: 2 });
        const applied = await repair(engine, applyArgs(preview));
        expect(applied.results[0].outcomes).toEqual({ reattributed: 3, retired: 2 });
        for (const id of [fenced, fencedAcme, dbOnly]) {
          const row = await attribution(engine, id);
          expect(row).toMatchObject({ attributed_to: 'other', active: true });
          expect(row.context).toContain(speakerContextNote('worker-a'));
        }
        const alice = (await engine.readPageSnapshot(ALICE, { sourceId: 'default' }))!;
        expect(alice.page.compiled_truth).toContain('attributed_to');
        expect(alice.page.compiled_truth).toContain(speakerContextNote('worker-a'));
        expect(await takeActive(engine, takeId)).toBe(false);
        expect(await takeActive(engine, Number(fencedTake!.id))).toBe(false);
        expect((await engine.readPageSnapshot(ALICE, { sourceId: 'default' }))!.page.compiled_truth).toContain('~~Alice Example prefers terse updates~~');
        expect((await engine.executeRaw<{ n: number }>(
          "SELECT count(*)::int AS n FROM persistence_requests WHERE state='committed' AND intent->>'kind'='managed_maintenance_agent_session_facts'"))[0]!.n).toBe(2);
        expect(await counts(engine)).toEqual(before);
        expect((await agentSessionFactsCheck(engine)).status).toBe('ok');
      }, { setup: async ({ engine, root }) => {
        await seedEntity(engine, root, ALICE, 'Alice Example', 'person');
        await seedEntity(engine, root, ACME, 'Acme Example', 'company');
      } });
    } finally { rmSync(base, { recursive: true, force: true }); }
  }, 180_000);
});
