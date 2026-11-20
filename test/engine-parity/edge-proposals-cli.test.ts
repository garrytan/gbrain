/**
 * BrainEngine parity: `gbrain edge-proposals` (src/commands/edge-proposals.ts), the command that lists, shows, retries,
 * undoes and dates the proposals of the edge-contradictions dream phase. It ran its own statements through `executeRaw`;
 * they are the typed members of src/core/engine-sql/edge-proposals-cli.ts now, with the same text and binds.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the command prints the same text and the same JSON, and sets the same exit verdict, on every engine:
 *    `list` shows the open proposals (proposed and undated) newest first, `--status` and `--status=all` pick other sets
 *    and `--limit` cuts the list; `show` prints one proposal and refuses an unknown id; `retry <id>` clears one judge
 *    error and refuses an id that is no judge error; `retry --all-held` clears only the errors held after their attempts;
 *    `undo <id>` undoes an applied proposal once; `date` refuses a proposal that is not undated and a date that is not a
 *    calendar date, and records the start line on the subject page and rejects the undated proposal. `undo --all-applied`
 *    stops on the usage error (the command asks for an id first), the same on every engine.
 *  - Regression: an engine that drops a status filter, orders ties another way, clears a judge error that is not held,
 *    or answers a date or a timestamp in another form changes what the user reads.
 *  - Why existing coverage misses it: test/edge-proposals-list-flags.test.ts and test/edge-proposals-json-bigint.test.ts
 *    check the flags and the id form against a recording stub, and no case ran the command on a Rust brain.
 *  - Seam: none. Pages come from putPage, proposals from recordEdgeProposal. On a Rust brain the dated case stops at a
 *    named known stop: the add_timeline_entry write reads the source kind through executeRaw
 *    (persistence/semantic-pages.ts:83), outside this command; the pin comes out when that read is served. Ids differ between arms, so each output
 *    names a proposal by the row it seeded (P1 to P5), and a creation time by its form.
 */
import { describe, expect, spyOn } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runEdgeProposals } from '../../src/commands/edge-proposals.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../../src/core/cli-force-exit.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const ALICE = 'people/alice-example';
const ACME = 'companies/acme-example';
const WIDGET = 'companies/widget-co';

const page = (title: string, type: string) => ({ type: type as never, title, compiled_truth: `About ${title}.`, timeline: '', frontmatter: {} });

async function idOf(engine: BrainEngine, slug: string): Promise<number> {
  const id = await engine.readPageIdInSource(slug, 'default');
  expect(id).not.toBeNull();
  return Number(id);
}

/**
 * Five proposals on one subject, oldest first: P1 proposed, P2 undated, P3 applied (recorded out of order), P4 a judge
 * error held after its attempts, P5 a judge error that is not held. Answers the label of each stored id.
 */
async function seed(engine: BrainEngine): Promise<Map<number, string>> {
  await engine.putPage(ALICE, page('Alice', 'person'));
  await engine.putPage(ACME, page('Acme', 'company'));
  await engine.putPage(WIDGET, page('Widget', 'company'));
  const [alice, acme, widget] = [await idOf(engine, ALICE), await idOf(engine, ACME), await idOf(engine, WIDGET)];
  const base = { sourceId: 'default', fromPageId: alice, aToPageId: acme, bToPageId: widget, linkType: 'works_at', bornClosed: false,
    model: 'judge-m0', confidence: null as number | null, generatedLine: null as string | null, detail: null as string | null,
    endingToPageId: null as number | null, closeDate: null as string | null };
  const rows = [
    { ...base, evidenceHash: 'evidence-1', status: 'proposed', endingToPageId: acme, closeDate: '2024-05-01', model: 'judge-m1', confidence: 0.9,
      generatedLine: `Ended works_at [[${ACME}]]` },
    { ...base, evidenceHash: 'evidence-2', status: 'undated_unresolved', model: 'judge-m1', confidence: 0.5 },
    { ...base, evidenceHash: 'evidence-3', status: 'applied', endingToPageId: widget, closeDate: '2024-06-01', bornClosed: true,
      generatedLine: `Ended works_at [[${WIDGET}]]` },
    { ...base, evidenceHash: 'evidence-4', status: 'error', detail: 'held after 3 attempts' },
    { ...base, evidenceHash: 'evidence-5', status: 'error', detail: 'attempt 1' },
  ];
  const labels = new Map<number, string>();
  for (const [i, row] of rows.entries()) {
    const id = await engine.recordEdgeProposal(row);
    expect(id).not.toBeNull();
    labels.set(Number(id), `P${i + 1}`);
    // created_at orders the list: keep each row's time apart.
    await new Promise((r) => setTimeout(r, 15));
  }
  return labels;
}

/** One run of the command: what it printed to stdout and stderr, and the exit verdict it set. */
interface CliRun { args: string; out: string; err: string; exit: number }

/** Runs the command as the CLI does; a refusal the command does not catch ends the case. */
async function cli(engine: BrainEngine, labels: Map<number, string>, args: string[]): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  const error = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.map(String).join(' ')); });
  _resetCliExitVerdictForTests();
  try {
    await runEdgeProposals(engine, args);
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  const exit = currentExitCode();
  _resetCliExitVerdictForTests();
  process.exitCode = 0;
  const name = (text: string) => named(text, labels);
  return { args: name(args.join(' ')), out: name(out.join('\n')), err: name(err.join('\n')), exit };
}

/**
 * The output with each stored id replaced by its label (`#7` becomes `#P1`, `"id": 7` becomes `"id": "P1"`, and so in
 * `date 7` and the `cleared` list) and each ISO creation time by `<iso>`. Any other time form stays as printed.
 */
function named(text: string, labels: Map<number, string>): string {
  const label = (id: string) => labels.get(Number(id)) ?? `unknown-${id}`;
  return text
    .replace(/(#|"id": |date |show |retry |accept |reject |undo )(\d+)\b/g, (_m, head: string, id: string) =>
      Number(id) === 987654 ? `${head}${id}` : `${head}${head === '"id": ' ? `"${label(id)}"` : label(id)}`)
    .replace(/("cleared": \[)([^\]]*)(\])/g, (_m, open: string, ids: string, close: string) =>
      open + ids.replace(/\d+/g, (id) => `"${label(id)}"`) + close)
    .replace(/"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"/g, '"<iso>"');
}

/** The id of the proposal labelled `name`. */
function idNamed(labels: Map<number, string>, name: string): string {
  const found = [...labels].find(([, l]) => l === name);
  expect(found).toBeDefined();
  return String(found![0]);
}

/** The engine the command gets: it keeps the last typed capability refusal and the stack of the call that raised it. */
function watched(engine: BrainEngine) {
  let refusal: unknown = null;
  let refusalSite = '';
  const wrapped = new Proxy(engine, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        // The caller's stack, taken before the call: an async refusal no longer names who made the call.
        const site = new Error().stack ?? '';
        const out = value.apply(target, args);
        if (!(out instanceof Promise)) return out;
        return out.catch((e: unknown) => {
          if ((e as { code?: unknown })?.code === 'engine_capability_missing') { refusal = e; refusalSite = site; }
          throw e;
        });
      };
    },
  });
  return { engine: wrapped, refusal: () => refusal, refusalSite: () => refusalSite };
}

/**
 * Known stops on Rust: `date` writes its line through the add_timeline_entry operation. On a Rust brain that write
 * queues on a refused executeRaw, so the dated case stops there. Two stops are pinned, in the order the case meets them:
 * 1. Today: the preparation reads the source kind through executeRaw (prepareSemanticPageMutation,
 *    src/core/persistence/semantic-pages.ts:83). The getSource hunk on that line serves it: babe38bded
 *    (rust-engine/admin-unowned-rust) and 65b3f8a992 (rust-engine/timeline-add-rust) carry it byte-identical.
 * 2. With that hunk applied, the publish transaction stops in guardFenceRows (src/core/trust/fence-guard.ts:71), which
 *    clears the guarded rows through executeRaw. The tx engine is not watched, so this stop is read from the stack of
 *    the refusal itself; the watched call is the transaction (publicationTransaction).
 * The pin fails as soon as the case runs to the end on Rust: it must then compare equal, and whichever change lands
 * second (this branch, or the branch that carries the getSource hunk) removes this pin.
 */
const RUST_KNOWN_STOP = new RegExp([
  /at prepareSemanticPageMutation \([^)]*src\/core\/persistence\/semantic-pages\.ts:83:/.source,
  /at (?:async )?guardFenceRows \([^)]*src\/core\/trust\/fence-guard\.ts:71:/.source,
].join('|'));

/** Where the queued write stopped: the watched call's stack, then the stack of the refusal it raised. */
function stopSite(w: ReturnType<typeof watched>): string {
  return `${w.refusalSite()}\n${(w.refusal() as Error | null)?.stack ?? ''}`;
}

/** Runs a command whose write a missing capability queues: it then stops on the typed refusal the write waits for. */
async function orTheQueuedRefusal<T>(w: ReturnType<typeof watched>, backend: string, run: () => Promise<T>): Promise<T> {
  let out: T;
  try {
    out = await run();
  } catch (error) {
    const blocked = (error as { writeRequest?: { blocked_reason?: unknown } })?.writeRequest?.blocked_reason;
    if (blocked === 'engine_capability_missing' && w.refusal() !== null) {
      if (backend === 'rust') expect(stopSite(w)).toMatch(RUST_KNOWN_STOP);
      throw w.refusal();
    }
    throw error;
  }
  // The known stop above: reaching here on Rust means the read is served, so this pin has to go.
  if (backend === 'rust') expect('the dated case ran to the end on Rust').toBe('the case stops at prepareSemanticPageMutation or guardFenceRows (RUST_KNOWN_STOP)');
  return out;
}

describe('engine parity: gbrain edge-proposals', () => {
  parityTest('list, show and retry print the same text and JSON and set the same exit verdict', {
    methods: ['putPage', 'readPageIdInSource', 'recordEdgeProposal', 'listEdgeProposalCliRows', 'deleteEdgeProposalError',
      'deleteHeldEdgeProposalErrors'],
  }, async (engine) => {
    const labels = await seed(engine);
    const id = (name: string) => idNamed(labels, name);
    const runs: CliRun[] = [];
    for (const args of [
      ['list'], ['list', '--json'], ['list', '--status=all', '--limit', '2', '--json'], ['list', '--status', 'applied'],
      ['list', '--status', 'error', '--json'], ['list', '--status', 'compatible'],
      ['show', id('P1')], ['show', id('P3'), '--json'], ['show', '987654'],
      ['retry', id('P5'), '--json'], ['retry', id('P5')], ['retry', id('P1')],
      ['retry', '--all-held'], ['retry', '--all-held', '--json'], ['list', '--status=all', '--json'],
    ]) runs.push(await cli(engine, labels, args));
    const byArgs = Object.fromEntries(runs.map((r) => [r.args, r]));
    expect(byArgs['list']!.out).toStartWith('#P2 [undated] people/alice-example: works_at');
    expect(byArgs['list']!.out).toContain('#P1 [proposed] people/alice-example: works_at companies/acme-example vs companies/widget-co → companies/acme-example ended 2024-05-01');
    expect(byArgs['show 987654']).toMatchObject({ err: 'No proposal #987654.', exit: 1 });
    expect(byArgs[`retry P5 --json`]).toMatchObject({ exit: 0 });
    expect(byArgs['retry P5']).toMatchObject({ err: 'No judge error #P5.', exit: 1 });
    expect(byArgs['retry P1']).toMatchObject({ err: 'No judge error #P1.', exit: 1 });
    expect(byArgs['retry --all-held']!.out).toBe('1 held judge error(s) cleared; the next dream cycle judges those pairs again.');
    expect(byArgs['retry --all-held --json']!.out).toBe('{\n  "cleared": []\n}');
    expect(JSON.parse(byArgs['list --status=all --json']!.out).map((r: { id: string }) => r.id)).toEqual(['P3', 'P2', 'P1']);
    return runs;
  });

  parityTest('undo undoes an applied proposal once, and date refuses a proposal that is not undated or a date that is not one', {
    methods: ['putPage', 'readPageIdInSource', 'recordEdgeProposal', 'listEdgeProposalCliRows', 'readEdgeProposal',
      'markEdgeProposalUndone', 'listAppliedEdgeProposalIds'],
  }, async (engine) => {
    const labels = await seed(engine);
    const id = (name: string) => idNamed(labels, name);
    // `undo --all-applied` never reaches its read (below), so the case reads the applied ids through the member itself.
    const applied = (await engine.listAppliedEdgeProposalIds()).map((r) => labels.get(Number(r.id)));
    const runs: CliRun[] = [];
    for (const args of [
      ['undo', '--all-applied', '--json'], ['undo', id('P3'), '--json'], ['undo', id('P3')], ['show', id('P3'), '--json'],
      ['date', id('P1'), '2024-03-01'], ['date', id('P2'), '2024-13-01'], ['date', '987654', '2024-03-01'],
    ]) runs.push(await cli(engine, labels, args));
    const byArgs = Object.fromEntries(runs.map((r) => [r.args, r]));
    // The command checks for a proposal id before it reads --all-applied, so `undo --all-applied` stops on the usage
    // error on every engine; the case pins that as it is.
    expect(byArgs['undo --all-applied --json']).toMatchObject({ out: '', exit: 2 });
    expect(byArgs['undo P3 --json']).toMatchObject({ exit: 0 });
    expect(JSON.parse(byArgs['undo P3 --json']!.out)).toEqual({ id: 'P3', status: 'undone', reason: 'the closure line was already gone' });
    expect(byArgs['undo P3']).toMatchObject({ out: '#P3: refused — proposal is undone', exit: 1 });
    expect(JSON.parse(byArgs['show P3 --json']!.out).status).toBe('undone');
    expect(byArgs['date P1 2024-03-01']).toMatchObject({ err: 'No undated proposal #P1.', exit: 1 });
    expect(byArgs['date P2 2024-13-01']!.exit).toBe(2);
    expect(byArgs['date 987654 2024-03-01']).toMatchObject({ err: 'No undated proposal #987654.', exit: 1 });
    expect(applied).toEqual(['P3']);
    return { runs, applied };
  });

  parityTest('date records the start line on the subject page and rejects the undated proposal, once', {
    methods: ['putPage', 'readPageIdInSource', 'recordEdgeProposal', 'setConfig', 'listEdgeProposalCliRows', 'readEdgeProposalSourceId',
      'markEdgeProposalDated'],
  }, async (base, backend) => {
    const w = watched(base);
    const engine = w.engine;
    const labels = await seed(engine);
    const id = (name: string) => idNamed(labels, name);
    // The derived links are not what this command writes; auto-link stays off so the case reads only its own statements.
    await engine.setConfig('auto_link', 'false');
    const runs: CliRun[] = [];
    for (const args of [['date', id('P2'), '2024-03-01', '--json']]) runs.push(await orTheQueuedRefusal(w, backend, () => cli(engine, labels, args)));
    for (const args of [['date', id('P2'), '2024-03-01'], ['show', id('P2'), '--json'], ['list']]) runs.push(await cli(engine, labels, args));
    const snapshot = await engine.readPageSnapshot(ALICE, { sourceId: 'default' });
    const byArgs = Object.fromEntries(runs.map((r) => [r.args, r]));
    expect(JSON.parse(byArgs['date P2 2024-03-01 --json']!.out)).toEqual({ id: 'P2', status: 'dated', target: WIDGET, date: '2024-03-01' });
    expect(byArgs['date P2 2024-03-01']).toMatchObject({ err: 'No undated proposal #P2.', exit: 1 });
    expect(JSON.parse(byArgs['show P2 --json']!.out).status).toBe('rejected');
    expect(snapshot?.page.timeline).toContain(`Started works_at [[${WIDGET}]]`);
    return { runs, timeline: snapshot?.page.timeline ?? null, body: snapshot?.page.compiled_truth ?? null };
  });
});
