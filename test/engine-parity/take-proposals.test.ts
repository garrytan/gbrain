/**
 * BrainEngine parity — the take proposal queue: the propose_takes cycle step fills `take_proposals`, and
 * `gbrain takes propose` lists, accepts, rejects, shows held pages (`--failed`) and releases them (`--retry-failed`).
 * Each statement ran its own SQL through `executeRaw`; they are typed engine members now.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the cycle step and each command answer byte for byte the same on every engine arm (PGLite always;
 *    Postgres with DATABASE_URL; the Rust arm through test/engine-parity/harness.ts), including error text and exit
 *    code; a nudge at a proposal needs the proposal and goes with it.
 *  - Regression: an arm that reads the cache wrong extracts a page again (a second LLM bill) or never; one that drops
 *    the rejected-claim memory proposes a claim the user rejected; one whose accept or reject CAS is not exclusive acts
 *    twice; one that loses the failure ledger never holds a failing page, or never releases it.
 *  - Why existing coverage misses it: test/takes-propose-cli-7271.test.ts, test/takes-propose-drain.test.ts,
 *    test/propose-takes*.test.ts and test/pathological/a25-propose-takes-poison-pages.test.ts run on PGLite and
 *    Postgres only, and every statement ran through `executeRaw`, which the Rust engine refuses (D18).
 *  - Seam: the commands are called in process with `process.exit` and output captured; the extractor is the cycle
 *    step's own injection point. Proposal ids and times never compare across arms.
 */
import { describe, expect } from 'bun:test';
import { runTakes } from '../../src/commands/takes.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';
import { loadFailureLedger } from '../../src/core/cycle/propose-takes-failures.ts';
import { runPhaseProposeTakes, type ProposeTakesExtractor } from '../../src/core/cycle/propose-takes.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { capabilityMissing } from '../../src/core/rust-engine/errors.ts';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

/** Fixture: run a command, with its stdout lines, stderr text and exit code captured. */
async function runCommand(fn: () => Promise<void>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const origExit = process.exit;
  const origLog = console.log;
  const origError = console.error;
  const origErr = process.stderr.write.bind(process.stderr);
  const out: string[] = [];
  let stderr = '';
  console.log = (...args: unknown[]) => { out.push(args.join(' ')); };
  console.error = (...args: unknown[]) => { stderr += `${args.join(' ')}\n`; };
  process.stderr.write = ((chunk: unknown) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  process.exit = ((code?: number) => { throw Object.assign(new Error('EXIT'), { exitCode: code }); }) as typeof process.exit;
  try {
    await fn();
    return { code: null, stdout: out.join('\n'), stderr };
  } catch (e) {
    if ((e as Error).message !== 'EXIT') throw e;
    return { code: (e as { exitCode?: number }).exitCode ?? null, stdout: out.join('\n'), stderr };
  } finally {
    process.exit = origExit;
    console.log = origLog;
    console.error = origError;
    process.stderr.write = origErr;
  }
}

const ctx = (engine: BrainEngine, sourceId = 'default'): OperationContext => ({
  engine, config: {} as never, logger: { info() {}, warn() {}, error() {} } as never, dryRun: false, remote: false, sourceId,
});

/** Fixture: pages put oldest first, so the newest-first candidate order is the reverse of `slugs`. */
async function putPages(engine: BrainEngine, pages: Array<{ slug: string; body: string; sourceId?: string; frontmatter?: Record<string, unknown>; type?: string }>) {
  for (const p of pages) {
    await engine.putPage(p.slug, { type: (p.type ?? 'note') as never, title: p.slug, compiled_truth: p.body, timeline: '', frontmatter: p.frontmatter ?? {} },
      { sourceId: p.sourceId ?? 'default' });
  }
}

/** The extractor: the claims listed for a page, nothing for any other. */
function extractorOf(claims: Record<string, string[]>, calls: string[] = []): ProposeTakesExtractor {
  return async ({ pagePath }) => {
    calls.push(pagePath);
    return (claims[pagePath] ?? []).map((claim_text, i) => ({ claim_text, kind: i % 2 ? 'bet' : 'take', holder: 'brain', weight: 0.6 }));
  };
}

const phase = async (engine: BrainEngine, extractor: ProposeTakesExtractor, sourceId = 'default') => {
  const r = await runPhaseProposeTakes(ctx(engine, sourceId), { extractor, deadlineMs: 600_000, promptVersion: 'parity-v1', model: 'parity-model' });
  const d = r.details as Record<string, unknown>;
  return {
    status: r.status,
    counts: ['pages_scanned', 'cache_hits', 'cache_misses', 'proposals_inserted', 'tombstones_written', 'rejected_claims_skipped', 'failure_tombstones_written']
      .map(key => [key, d[key]]),
    failed: (d.failed_pages as Array<Record<string, unknown>> | undefined ?? []).map(f => [f.slug, f.code, f.attempts, f.held]),
  };
};

const takes = (engine: BrainEngine, args: string[]) => runCommand(() => runTakes(engine, args));

/** The pending queue as `--json` prints it, without the ids and times that differ across arms. */
async function queue(engine: BrainEngine, extra: string[] = []) {
  const r = await takes(engine, ['propose', '--json', ...extra]);
  const rows = JSON.parse(r.stdout) as Array<Record<string, unknown>>;
  return rows.map(({ id: _id, proposed_at, ...rest }) => ({ ...rest, proposedAtIsTime: !Number.isNaN(Date.parse(String(proposed_at))) }) as Record<string, unknown>);
}

/** The pending proposal id of a claim, read off the `--json` list. */
async function idOf(engine: BrainEngine, claim: string): Promise<number> {
  const rows = JSON.parse((await takes(engine, ['propose', '--json', '--limit', '500'])).stdout) as Array<{ id: number; claim_text: string }>;
  const row = rows.find(r => r.claim_text === claim);
  if (!row) throw new Error(`no pending proposal for ${claim}`);
  return row.id;
}

/** Command output with every proposal id written as `#N`. */
const noIds = (r: { code: number | null; stdout: string; stderr: string }, ids: number[]) => {
  const swap = (text: string) => text.replace(/([Pp]roposal #|--accept |--reject )(\d+)\b/g,
    (whole, lead: string, id: string) => ids.includes(Number(id)) ? `${lead}P${ids.indexOf(Number(id))}` : whole);
  return { code: r.code, stdout: swap(r.stdout), stderr: swap(r.stderr) };
};

/**
 * Rust arm only: run the case on an engine that keeps every typed refusal a member raised, and end the case on the
 * first one, even when the code under test caught it and carried on. The cycle cases reach page-state/projections.ts
 * through the extract receipt write (resealSafeChunks, planProjectionKeep), whose raw SQL the Rust engine refuses
 * until lane 3 cut 1 (7f1ee5198e + resealSafeChunks :467, Nov 23); this pins them to that refusal. The other arms run
 * the case as written.
 */
async function stopAtCaughtRefusal<T>(engine: BrainEngine, backend: ParityBackend, run: (engine: BrainEngine) => Promise<T>): Promise<T> {
  if (backend !== 'rust') return run(engine);
  const caught: unknown[] = [];
  const watch = (e: BrainEngine): BrainEngine => new Proxy(e, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return (...args: unknown[]) => {
        if ((prop === 'transaction' || prop === 'transactionDirect') && typeof args[0] === 'function') {
          const fn = args[0] as (tx: BrainEngine) => unknown;
          args = [(tx: BrainEngine) => fn(watch(tx)), ...args.slice(1)];
        }
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (!(result instanceof Promise)) return result;
        return result.catch((error: unknown) => {
          if ((error as { code?: unknown } | null)?.code === 'engine_capability_missing') caught.push(error);
          throw error;
        });
      };
    },
  });
  const result = await run(watch(engine));
  if (caught.length > 0) throw caught[0];
  return result;
}

/**
 * Rust arm only: an accept's takes_add goes through the persistence coordinator, whose raw SQL
 * (persistence/takes-prepare.ts and page-state/projections.ts) the Rust engine refuses, so the coordinator parks the
 * write as `write_pending` blocked on `engine_capability_missing`. End the case on that capability refusal.
 */
function acceptRefusal(backend: ParityBackend, e: unknown): never {
  const err = e as { code?: string; blocked_reason?: string; writeRequest?: { blocked_reason?: string | null } };
  if (backend === 'rust' && err.code === 'write_pending'
    && (err.writeRequest?.blocked_reason ?? err.blocked_reason) === 'engine_capability_missing') {
    throw capabilityMissing('raw_sql', 'takes_add (the persistence coordinator: takes-prepare.ts and projections.ts)');
  }
  throw e;
}

describe('engine parity: the propose_takes cycle step fills the take proposal queue', () => {
  parityTest('propose_takes proposes each claim once, records an empty page, skips other sources, generated pages and receipts, and hits its cache on a rerun', {
    methods: ['putPage', 'listProposeTakesCandidatePages', 'takeProposalCached', 'listRejectedTakeProposalClaims', 'insertTakeProposal',
      'readOpCheckpointDoc', 'listPendingTakeProposals'],
    timeout: 120_000,
  }, async (engine, backend) => stopAtCaughtRefusal(engine, backend, async engine => {
    await createSource(engine, backend, 'other');
    await putPages(engine, [
      { slug: 'notes/p-a', body: 'Two claims live in this note.' },
      { slug: 'notes/p-empty', body: 'Nothing to claim here.' },
      { slug: 'notes/p-blank', body: '   ' },
      { slug: 'notes/p-dream', body: 'Dream output.', frontmatter: { dream_generated: true } },
      { slug: 'notes/p-other', body: 'Another source.', sourceId: 'other' },
      { slug: 'notes/p-b', body: 'One claim, said twice.' },
    ]);
    const claims = {
      'notes/p-a': ['Acme-example ships the widget by Q3', 'Widget-co doubles revenue'],
      'notes/p-b': ['Fund-a leads the seed', 'Fund-a leads the seed'],
      'notes/p-dream': ['A dreamed claim'], 'notes/p-other': ['A claim in another source'],
    };
    const calls: string[] = [];
    const first = await phase(engine, extractorOf(claims, calls));
    const listed = await queue(engine);
    const rerunCalls: string[] = [];
    const rerun = await phase(engine, extractorOf(claims, rerunCalls));
    const got = { first, calls, listed, rerun, rerunCalls, otherQueue: await queue(engine, ['--limit', '1']),
      text: (await takes(engine, ['propose', '--limit', '2'])).stdout.replace(/#\d+ /g, '#N ') };
    expect(got.calls).toEqual(['notes/p-b', 'notes/p-empty', 'notes/p-a']);
    expect(got.rerunCalls).toEqual([]);
    expect(got.listed.map(r => r.claim_text)).toEqual(['Widget-co doubles revenue', 'Acme-example ships the widget by Q3', 'Fund-a leads the seed']);
    return got;
  }));

  parityTest('a rejected claim is not proposed again on the same page; reject and accept refuse a proposal acted on, missing or in another source', {
    methods: ['putPage', 'insertTakeProposal', 'listRejectedTakeProposalClaims', 'listPendingTakeProposals', 'readTakeProposal', 'rejectTakeProposal'],
    timeout: 120_000,
  }, async (engine, backend) => stopAtCaughtRefusal(engine, backend, async engine => {
    await createSource(engine, backend, 'other');
    await putPages(engine, [{ slug: 'notes/r-a', body: 'Version one.' }, { slug: 'notes/r-other', body: 'Elsewhere.', sourceId: 'other' }]);
    await phase(engine, extractorOf({ 'notes/r-a': ['Keep this claim', 'Reject this claim'] }));
    await phase(engine, extractorOf({ 'notes/r-other': ['Other source claim'] }), 'other');
    const keep = await idOf(engine, 'Keep this claim');
    const reject = await idOf(engine, 'Reject this claim');
    const [elsewhere] = await engine.listPendingTakeProposals({ sourceId: 'other', limit: 5 });
    const ids = [keep, reject, keep + reject + 1000, elsewhere!.id];
    const got = {
      rejected: noIds(await takes(engine, ['propose', '--reject', String(reject)]), ids),
      again: noIds(await takes(engine, ['propose', '--reject', String(reject)]), ids),
      acceptRejected: noIds(await takes(engine, ['propose', '--accept', String(reject)]), ids),
      missing: noIds(await takes(engine, ['propose', '--reject', String(ids[2])]), ids),
      both: await takes(engine, ['propose', '--accept', '1', '--reject', '2']),
      badId: await takes(engine, ['propose', '--reject', '1x']),
      // The command resolves source 'default': a proposal of another source reads as missing and stays pending.
      otherSource: noIds(await takes(engine, ['propose', '--reject', String(elsewhere!.id)]), ids),
      otherPending: (await engine.listPendingTakeProposals({ sourceId: 'other', limit: 5 })).map(p => p.claim_text),
      // The page changes, the extractor proposes the rejected claim again: it is skipped and counted.
      rerun: await (async () => {
        await putPages(engine, [{ slug: 'notes/r-a', body: 'Version two.' }]);
        return phase(engine, extractorOf({ 'notes/r-a': ['Reject this claim', 'A new claim'] }));
      })(),
      queue: await queue(engine),
    };
    expect(got.rejected).toEqual({ code: null, stdout: 'Rejected proposal #P1 (notes/r-a).', stderr: '' });
    expect(got.again.code).toBe(1);
    expect(got.missing).toEqual({ code: 1, stdout: '', stderr: "No take proposal #P2 in source 'default'.\n" });
    return got;
  }));

  parityTest('takes propose --accept promotes the proposal into a take on its page; a second accept refuses', {
    methods: ['putPage', 'insertTakeProposal', 'readTakeProposal', 'claimTakeProposal', 'listWriteRequestsByRequestId', 'setTakeProposalPromotedRow',
      'listPendingTakeProposals', 'listTakes'],
    timeout: 120_000,
  }, async (engine, backend) => {
    await putPages(engine, [{ slug: 'companies/acme-example', body: 'About acme-example.', type: 'company' }]);
    await phase(engine, extractorOf({ 'companies/acme-example': ['Acme-example hires a CFO this year', 'Acme-example opens a second office'] }));
    const first = await idOf(engine, 'Acme-example hires a CFO this year');
    const second = await idOf(engine, 'Acme-example opens a second office');
    const ids = [first, second];
    const page = await engine.getPage('companies/acme-example');
    const got = {
      // Rust: takes_add parks as write_pending until the coordinator's raw SQL is typed (acceptRefusal).
      accepted: noIds(await takes(engine, ['propose', '--accept', String(first)]).catch(e => acceptRefusal(backend, e)), ids),
      edited: noIds(await takes(engine, ['propose', '--accept', String(second), '--claim', 'Acme-example opens two offices', '--weight', '0.9']), ids),
      again: noIds(await takes(engine, ['propose', '--accept', String(first)]), ids),
      rejectAccepted: noIds(await takes(engine, ['propose', '--reject', String(first)]), ids),
      takes: (await engine.listTakes({ page_id: Number(page!.id) } as never)).map(t => [t.row_num, t.claim, t.kind, t.holder, Number(t.weight),
        String(t.source).replace(/take_proposals#(\d+)/, (whole, id: string) => ids.includes(Number(id)) ? `take_proposals#P${ids.indexOf(Number(id))}` : whole)]),
      queue: await queue(engine),
    };
    expect(got.accepted.code).toBeNull();
    expect(got.accepted.stdout).toBe('Accepted proposal #P0 → take #1 on companies/acme-example: Acme-example hires a CFO this year');
    expect(got.queue).toEqual([]);
    return got;
  });

  parityTest('an accept whose take cannot be written releases its claim; a fresh claim with no take yet is not taken over', {
    methods: ['insertTakeProposal', 'claimTakeProposal', 'readStrandedTakeProposalClaim', 'listWriteRequestsByRequestId',
      'releaseTakeProposalClaim', 'readTakeProposal', 'listPendingTakeProposals'],
    timeout: 120_000,
  }, async (engine) => {
    const proposal = (pageSlug: string, claimText: string) => engine.insertTakeProposal({
      sourceId: 'default', pageSlug, contentHash: 'hash-1', promptVersion: 'parity-v1', proposalRunId: 'run-1', claimText,
      kind: 'bet', holder: 'brain', weight: 0.6, domain: null, dedupAgainst: [], modelId: 'parity-model',
    });
    // No page holds notes/ghost, so takes_add refuses before any durable request.
    const ghost = (await proposal('notes/ghost', 'Ghost-co never ships'))!;
    const fresh = (await proposal('notes/fresh', 'Fresh-co ships soon'))!;
    const ids = [ghost, fresh];
    const claimed = await engine.claimTakeProposal(fresh, 'other-cli');
    const got = {
      // The refused write surfaces as the command's thrown error (the CLI's top-level handler prints it).
      ghost: noIds(await takes(engine, ['propose', '--accept', String(ghost)]).catch((e: Error & { code?: string }) => {
        if (e.code === 'engine_capability_missing') throw e;
        return { code: -1, stdout: '', stderr: `${e.code ?? e.name}: ${e.message}` };
      }), ids),
      // A claim held by another accept seconds ago, with no take written yet: refused, not resumed.
      fresh: noIds(await takes(engine, ['propose', '--accept', String(fresh)]), ids),
      claimed: claimed !== null && !Number.isNaN(Date.parse(String(claimed.acted_at))),
      stranded: (await engine.readStrandedTakeProposalClaim(fresh)) !== null,
      // The released claim is pending again; the held one stays out of the queue.
      queue: await queue(engine),
    };
    expect(got.ghost).toEqual({ code: -1, stdout: '', stderr: 'page_identity_changed: The accepted page no longer exists.' });
    expect(got.fresh.code).toBe(1);
    expect(got.queue.map(r => r.claim_text)).toEqual(['Ghost-co never ships']);
    return got;
  });
});

describe('engine parity: the take proposal members called directly', () => {
  parityTest('each member reads and writes the same rows: cache key, claim and release, promoted row, reject, rejected claims, tombstones, candidates, checkpoint document', {
    methods: ['putPage', 'insertTakeProposal', 'takeProposalCached', 'readTakeProposal', 'claimTakeProposal', 'readStrandedTakeProposalClaim',
      'releaseTakeProposalClaim', 'setTakeProposalPromotedRow', 'rejectTakeProposal', 'listRejectedTakeProposalClaims',
      'listTakeProposalTombstones', 'deleteTakeProposalTombstones', 'listProposeTakesCandidatePages', 'writeOpCheckpointDoc',
      'readOpCheckpointDoc', 'listWriteRequestsByRequestId', 'listPendingTakeProposals'],
    timeout: 120_000,
  }, async (engine) => {
    await putPages(engine, [{ slug: 'notes/m-old', body: 'Old.' }, { slug: 'notes/m-new', body: 'New.' }, { slug: 'people/m-person', body: 'P.', type: 'person' }]);
    const key = { sourceId: 'default', pageSlug: 'notes/m-new', contentHash: 'h1', promptVersion: 'parity-v1' };
    const insert = (claimText: string, status?: 'pending' | 'rejected', pageSlug = key.pageSlug) => engine.insertTakeProposal({
      ...key, pageSlug, proposalRunId: 'run-m', claimText, kind: 'take', holder: 'brain', weight: 0.35, domain: 'markets',
      dedupAgainst: [{ row_num: 1, claim: 'prior' }], modelId: 'parity-model', ...(status ? { status } : {}),
    });
    const shape = (row: Awaited<ReturnType<BrainEngine['readTakeProposal']>>) => row && {
      ...row, id: typeof row.id, proposed_at: row.proposed_at instanceof Date || !Number.isNaN(Date.parse(String(row.proposed_at))),
      weight: Number(row.weight),
    };
    const cachedBefore = await engine.takeProposalCached(key);
    const a = (await insert('Claim A'))!;
    const dup = await insert('Claim A');
    const b = (await insert('Claim B'))!;
    const tomb = (await insert('(extraction failed: request_too_large)', 'rejected', 'notes/m-old'))!;
    const claim = await engine.claimTakeProposal(a, 'parity');
    const got = {
      cachedBefore, cachedAfter: await engine.takeProposalCached(key), dup,
      otherHash: await engine.takeProposalCached({ ...key, contentHash: 'h2' }),
      claimedRow: shape(await engine.readTakeProposal(a)),
      wrongSource: await engine.readTakeProposal(a, 'other'),
      claimed: claim !== null, claimAgain: await engine.claimTakeProposal(a, 'parity'),
      stranded: (await engine.readStrandedTakeProposalClaim(a)) !== null,
      strandedPending: await engine.readStrandedTakeProposalClaim(b),
      released: await (async () => {
        await engine.releaseTakeProposalClaim(a, claim!.acted_at == null ? null : new Date(claim!.acted_at).toISOString());
        return (await engine.readTakeProposal(a))?.status;
      })(),
      promoted: await (async () => {
        await engine.claimTakeProposal(a, 'parity');
        await engine.setTakeProposalPromotedRow(a, 7);
        return shape(await engine.readTakeProposal(a));
      })(),
      rejectAccepted: await engine.rejectTakeProposal(a, 'parity'),
      rejectPending: await engine.rejectTakeProposal(b, 'parity'),
      rejectedClaims: (await engine.listRejectedTakeProposalClaims('default', 'notes/m-new')).sort(),
      pending: (await engine.listPendingTakeProposals({ limit: 10 })).map(p => p.claim_text),
      tombstones: (await engine.listTakeProposalTombstones('default', '(extraction failed: ')).map(t => [t.slug, t.claim_text, t.prompt_version, typeof t.id === 'number' && t.id === tomb]),
      candidates: (await engine.listProposeTakesCandidatePages({ sourceId: 'default', types: ['note'], limit: 5 })).map(p => [p.slug, p.source_id, p.compiled_truth]),
      candidatesAll: (await engine.listProposeTakesCandidatePages({ sourceIds: ['default'], types: [], limit: 2 })).map(p => p.slug),
      docMissing: await engine.readOpCheckpointDoc('propose_takes_failures', 'fp-m'),
      doc: await (async () => {
        await engine.writeOpCheckpointDoc('propose_takes_failures', 'fp-m', { pages: { 'notes/m-old': { attempts: 2 } } });
        await engine.writeOpCheckpointDoc('propose_takes_failures', 'fp-m', { pages: { 'notes/m-old': { attempts: 3 } } });
        return engine.readOpCheckpointDoc('propose_takes_failures', 'fp-m');
      })(),
      requests: await engine.listWriteRequestsByRequestId('00000000-0000-0000-0000-000000000000'),
      deleted: await engine.deleteTakeProposalTombstones('default', '(extraction failed: '),
      tombstonesAfter: await engine.listTakeProposalTombstones('default', '(extraction failed: '),
    };
    expect(got.cachedBefore).toBe(false);
    expect(got.cachedAfter).toBe(true);
    expect(got.dup).toBeNull();
    expect(got.claimedRow).toEqual({ id: 'number', source_id: 'default', page_slug: 'notes/m-new', claim_text: 'Claim A', kind: 'take', holder: 'brain',
      weight: 0.35, domain: 'markets', status: 'accepted', proposed_at: true, model_id: 'parity-model', promoted_row_num: null });
    expect(got.promoted).toMatchObject({ status: 'accepted', promoted_row_num: 7 });
    expect(got.candidates.map(c => c[0])).toEqual(['notes/m-new', 'notes/m-old']);
    expect(got.doc).toEqual({ pages: { 'notes/m-old': { attempts: 3 } } });
    expect(got.released).toBe('pending');
    expect(got.rejectAccepted).toBe(false);
    expect(got.rejectPending).toBe(true);
    expect(got.deleted).toEqual(['notes/m-old']);
    return got;
  });

  parityTest('listPendingTakeProposals clamps an infinite or fractional limit like the SQL and fails a NaN one with the bigint error', {
    methods: ['putPage', 'insertTakeProposal', 'listPendingTakeProposals'],
  }, async (engine) => {
    await putPages(engine, [{ slug: 'notes/l-a', body: 'A.' }]);
    for (const claimText of ['Claim one', 'Claim two', 'Claim three']) {
      await engine.insertTakeProposal({
        sourceId: 'default', pageSlug: 'notes/l-a', contentHash: 'h1', promptVersion: 'parity-v1', proposalRunId: 'run-l', claimText,
        kind: 'take', holder: 'brain', weight: 0.5, domain: null, dedupAgainst: [], modelId: 'parity-model',
      });
    }
    const count = async (limit: number) => (await engine.listPendingTakeProposals({ limit })).length;
    const got = {
      infinite: await count(Infinity), negative: await count(-Infinity), fraction: await count(2.9), zero: await count(0),
      nan: await engine.listPendingTakeProposals({ limit: NaN }).then(() => 'answered', (e: unknown) => (e instanceof Error ? e.message : String(e))),
    };
    expect(got).toEqual({ infinite: 3, negative: 1, fraction: 2, zero: 1, nan: 'invalid input syntax for type bigint: "NaN"' });
    return got;
  });
});

const tooLong = () => Object.assign(new AIConfigError('[chat(anthropic:claude-example)] prompt is too long: 250000 tokens > 200000 maximum'), { status: 400 });

describe('engine parity: a page propose_takes keeps failing is held, listed and released', () => {
  parityTest('three counted failed runs hold the page; takes propose --failed lists it and --retry-failed releases it', {
    methods: ['putPage', 'readOpCheckpointDoc', 'writeOpCheckpointDoc', 'insertTakeProposal', 'listTakeProposalTombstones', 'deleteTakeProposalTombstones'],
    timeout: 120_000,
  }, async (engine, backend) => stopAtCaughtRefusal(engine, backend, async engine => {
    await putPages(engine, [{ slug: 'notes/f-bad', body: 'A page the model cannot read.' }, { slug: 'notes/f-good', body: 'A healthy page.' }]);
    let healthy = 0;
    const extractor: ProposeTakesExtractor = async ({ pagePath }) => {
      if (pagePath === 'notes/f-bad') throw tooLong();
      return [{ claim_text: `Claim ${++healthy} from ${pagePath}`, kind: 'take', holder: 'brain', weight: 0.5 }];
    };
    const runs = [];
    for (let i = 0; i < 4; i++) {
      // A fresh good page each run keeps an extractor success in every run, so each failure counts.
      if (i > 0) await putPages(engine, [{ slug: 'notes/f-good', body: `A healthy page, edit ${i}.` }]);
      runs.push(await phase(engine, extractor));
    }
    const ledger = await loadFailureLedger(engine, 'default');
    const failedJson = JSON.parse((await takes(engine, ['propose', '--failed', '--json'])).stdout) as Array<Record<string, unknown>>;
    const got = {
      runs,
      ledgerPages: Object.keys(ledger.pages), ledgerSuccess: ledger.success?.prompt_version ?? null,
      failedJson: failedJson.map(({ proposed_at, ...rest }) => ({ ...rest, proposedAtIsTime: !Number.isNaN(Date.parse(String(proposed_at).replace(' ', 'T').replace(/\+00$/, 'Z'))) })),
      failedText: (await takes(engine, ['propose', '--failed'])).stdout.replace(/held [^)]+\)/, 'held T)'),
      retryNone: await takes(engine, ['propose', '--retry-failed', '--slug', 'notes/f-none']),
      retry: await takes(engine, ['propose', '--retry-failed', '--slug', 'notes/f-bad', '--json']),
      after: await takes(engine, ['propose', '--failed']),
      // Released, the page is extracted again on the next run.
      next: await phase(engine, extractor),
    };
    expect(got.failedJson as unknown[]).toEqual([{ slug: 'notes/f-bad', code: 'request_too_large', prompt_version: 'parity-v1', proposedAtIsTime: true }]);
    expect(got.after.stdout).toBe('No pages held by propose_takes in default.');
    return got;
  }));

  parityTest('a ledger record dropped by --retry-failed without --slug releases every held page and keeps the ledger', {
    methods: ['putPage', 'readOpCheckpointDoc', 'writeOpCheckpointDoc', 'deleteTakeProposalTombstones'],
    timeout: 120_000,
  }, async (engine) => {
    await putPages(engine, [{ slug: 'notes/g-bad', body: 'Unreadable.' }, { slug: 'notes/g-good', body: 'Readable.' }]);
    const extractor: ProposeTakesExtractor = async ({ pagePath }) => {
      if (pagePath === 'notes/g-bad') throw tooLong();
      return [];
    };
    const first = await phase(engine, extractor);
    const ledger = await loadFailureLedger(engine, 'default');
    const got = {
      first,
      record: Object.fromEntries(Object.entries(ledger.pages).map(([slug, r]) => [slug, [r.code, r.class, r.attempts, r.prompt_version]])),
      retryAll: await takes(engine, ['propose', '--retry-failed']),
      kept: Object.keys((await loadFailureLedger(engine, 'default')).pages),
    };
    expect(got.record).toEqual({ 'notes/g-bad': ['request_too_large', 'content', 1, 'parity-v1'] });
    return got;
  });
});

describe('engine parity: a nudge at a take proposal', () => {
  parityTest('a nudge at a stored proposal is logged; one at a missing proposal fails its foreign key; releasing the proposal deletes its nudges', {
    methods: ['putPage', 'insertTakeProposal', 'listPendingTakeProposals', 'insertTakeNudge', 'deleteTakeProposalTombstones', 'purgeTakeNudgesByWave'],
    timeout: 120_000,
  }, async (engine, backend) => stopAtCaughtRefusal(engine, backend, async engine => {
    await putPages(engine, [{ slug: 'notes/n-a', body: 'A nudged claim.' }]);
    await phase(engine, extractorOf({ 'notes/n-a': ['A nudged claim'] }));
    const [pending] = await engine.listPendingTakeProposals({ sourceId: 'default', limit: 5 });
    const nudge = (proposalId: number, waveVersion: string) =>
      engine.insertTakeNudge({ sourceId: 'default', proposalId, nudgePattern: 'stale-proposal', waveVersion }).then(id => typeof id, (e: Error) => e.message);
    // A failure tombstone is a proposal row too: hold a page, nudge at its tombstone, release it.
    const extractor: ProposeTakesExtractor = async ({ pagePath }) => {
      if (pagePath === 'notes/n-bad') throw tooLong();
      return [{ claim_text: `Fresh claim from ${pagePath}`, kind: 'take', holder: 'brain', weight: 0.5 }];
    };
    await putPages(engine, [{ slug: 'notes/n-bad', body: 'Unreadable.' }]);
    for (let i = 0; i < 3; i++) {
      await putPages(engine, [{ slug: 'notes/n-good', body: `Readable, edit ${i}.` }]);
      await phase(engine, extractor);
    }
    const tombstones = await engine.listTakeProposalTombstones('default', '(extraction failed: ');
    const got = {
      atProposal: await nudge(pending!.id, 'wave-p'),
      atMissing: await nudge(pending!.id + 100_000, 'wave-p'),
      tombstones: tombstones.map(t => t.slug),
      atTombstone: await engine.insertTakeNudge({ sourceId: 'default', proposalId: tombstones[0]!.id, nudgePattern: 'held', waveVersion: 'wave-t' })
        .then(id => typeof id, (e: Error) => e.message),
      before: [await engine.purgeTakeNudgesByWave({ waveVersion: 'wave-p', dryRun: true }), await engine.purgeTakeNudgesByWave({ waveVersion: 'wave-t', dryRun: true })],
      released: await engine.deleteTakeProposalTombstones('default', '(extraction failed: ', 'notes/n-bad'),
      after: [await engine.purgeTakeNudgesByWave({ waveVersion: 'wave-p', dryRun: true }), await engine.purgeTakeNudgesByWave({ waveVersion: 'wave-t', dryRun: true })],
    };
    expect(got).toEqual({
      atProposal: 'number',
      atMissing: 'insert or update on table "take_nudge_log" violates foreign key constraint "take_nudge_log_proposal_id_fkey"',
      tombstones: ['notes/n-bad'], atTombstone: 'number', before: [1, 1], released: ['notes/n-bad'], after: [1, 0],
    });
    return got;
  }));
});
