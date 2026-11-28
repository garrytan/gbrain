/**
 * Failback (`gbrain engine swap --to pglite|postgres`, docs/guides/engine-swap.md#failback): moves a swapped brain back
 * from the Rust engine to its old primary, keeping every write the Rust engine acknowledged.
 *
 * The old primary is not kept current after a swap; it stays fenced at cutover. Failback copies the Rust engine's
 * answers back into it under the same write fence, then proves the copy with the same read calls on both engines:
 *
 *   planned  -> copied     every page part, fact, open loop, config key and source that differs is written, inside
 *                          the swap run's graduation transaction (failback-copy.ts);
 *   copied   -> verified   the two engines are read again and must agree on every read call; the reverse fingerprint
 *                          probe must find no fact whose fingerprint differs on the primary;
 *   verified -> switched   no other writer, then the config names the old engine again (and its saved database_url);
 *                          a last read of both engines must still agree, or the config goes back to the Rust engine;
 *   switched -> succeeded  the fence is dropped and the graduation row closed in one transaction, and a fresh process
 *                          resolves the route to the old engine.
 *
 * Every refusal before `planned` writes nothing. The Rust store is never written and stays as the recovery point. The
 * Rust store's shadow digests are not used: writes made after the swap never update them.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { loadConfigFileOnly } from '../config.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import { dropGraduationFence, readGraduationRow, setSourceState, withGraduationRun } from '../persistence/graduation-schema.ts';
import { hasFingerprintFunctions, probeOnPrimary } from '../../shadow/fingerprints.ts';
import { readSwapRecord, REAL_FS, writeSwapRecord, type FailbackState, type SwapFs, type SwapRecord } from './record.ts';
import { swapRefusal, type SwapRefusalReason } from './refusals.ts';
import { restoreAuthority, switchAuthority, type RouteProber, type RouteProbe } from './route.ts';
import { copyBack, diffBrains, mismatchesOf, type FailbackDiff, type Mismatch } from './failback-copy.ts';
import { FACT_COLUMNS_WITHOUT_READ, failbackLosses, hashOf, isSegmented, refKey, UnboundedReadError, type FailbackLosses } from './failback-read.ts';

/** The losses failback accepts and shows with counts before it writes; every other loss is named in `losses`. */
export const FAILBACK_ACCEPTED_LOSSES = ['page_version_collapse', 'new_row_ids'] as const;

/** Stated in every plan and report: what failback cannot use. */
export const FAILBACK_KNOWN_LIMITS = [
  'The Rust store\'s shadow digests are written only by the seed and the follower; writes made after the swap do not update them, so failback never reads them.',
  'Files with no page are not listed by any Rust read call (listFiles is not served); their rows keep the state they had at the swap.',
  'No read call returns a fact\'s fence row, event type, dimension or attribution (facts.row_num, source_markdown_slug, event_type, dimension, value, value_hash, dim_status, attributed_to), so a fact added on Rust after the swap makes failback refuse by name.',
] as const;

/**
 * Stated in the swap plan: what a remote caller loses on the Rust engine. A brain with remote callers does not swap yet
 * (remote_access_unserved); once it can, the owner's remote read is the named loss (RUST_ENGINE.md row RA-1), and an
 * OAuth app signs in again each time its access token expires (row OA-1: the Rust token endpoint issues no refresh token).
 */
export const RUST_REMOTE_LIMITS = [
  'A remote read by the brain owner on a Rust brain refuses by name (engine_capability_missing, "the owner lineage read") until the store models the owner\'s lineage read; other remote callers and the local CLI read as on the old engine.',
  'On Rust, OAuth apps must sign in again each time their access token expires, until refresh-token family revoke ships on Rust.',
] as const;

/** The fingerprint guard's rule, in plain words, for the swap and failback plans and the guide. */
export const FINGERPRINT_RULE_TEXT = 'Fingerprint rule (the probe\'s own rule, both directions): where the Postgres or PGLite engine\'s lower() or whitespace class differs from the Rust engine on some characters, the run stops only if a stored fact holds one; with no such character, any probe mismatch stops it. Stock Postgres differs on dozens of rare characters (for example U+0085, next line), so its probe always reports mismatches; a brain whose facts hold none of them is not affected.';

/** Stated in the swap plan: after a swap the old engine falls behind, and failback is the way back. */
export const WAY_BACK_TEXT = 'After a swap, the old engine is not kept current; failback (gbrain engine swap --to <old engine>) copies the Rust store back under a write fence.';

export interface FailbackDeps {
  /** The old primary, connected as the swap run (its connect gate exempts the run). */
  primary: BrainEngine;
  /** The Rust engine at the swap's store (any engine that serves the same read calls, in tests). */
  rust: BrainEngine;
  recordPath: string;
  brainKey: string;
  /** The swap run directory: the saved database_url of a Postgres brain lives here. */
  runDir: string;
  /** Names another active writer of the brain (either engine), or null. Checked before the copy and before the switch. */
  writers: () => Promise<string | null>;
  prober: RouteProber;
  /** A refusal when an environment variable or service still selects the Rust engine's route. */
  routeCheck?: () => OperationError | null;
  fs?: SwapFs;
  now?: () => Date;
  progress?: (line: string) => void;
  /** Test-only: runs after the copy, before the verification. */
  beforeVerify?: () => Promise<void>;
  /** Runs before the route probe: the CLI closes both engines here, so a fresh process can open the old one. */
  beforeProbe?: () => Promise<void>;
}

export interface FailbackPlan {
  run_id: string;
  target: string;
  plan_hash: string;
  pages: FailbackDiff['counts'];
  facts: { add: number; change: number; remove: number };
  open_loops: { add: number; change: number; remove: number };
  config: { add: number; change: number; remove: number };
  sources: { add: number; change: number; remove: number };
  losses: { accepted: Array<{ name: typeof FAILBACK_ACCEPTED_LOSSES[number]; count: number; detail: string }> } & FailbackLosses;
  known_limits: readonly string[];
}

const DIAG = (): string => randomUUID().slice(0, 8);
const counts = (d: { add: unknown[]; change: unknown[]; remove: unknown[] }) => ({ add: d.add.length, change: d.change.length, remove: d.remove.length });

function unavailable(message: string): OperationError {
  return swapRefusal('failback_unavailable', message, 'Failback undoes a finished swap only; read `gbrain engine swap --status`. Nothing was written.');
}

/** The swap record, checked: a succeeded swap with a recorded switch whose old primary still records the run. */
async function checkedRecord(deps: FailbackDeps): Promise<SwapRecord> {
  const record = readSwapRecord(deps.recordPath);
  if (!record || record.state !== 'succeeded' || !record.switch) {
    throw unavailable(record ? `the swap run ${record.run_id} is at ${record.state}, not succeeded.` : 'no swap run of this brain is recorded.');
  }
  const switched = record.failback?.state === 'switched';
  const engine = String(loadConfigFileOnly()?.engine ?? '');
  if (!switched && engine !== 'rust') throw unavailable(`the config names the ${engine || 'unknown'} engine, not rust.`);
  const row = await readGraduationRow(deps.primary);
  // After the switch a stop can land after the fence was dropped: the row then already records rolled_back.
  if (!row || row.role !== 'source' || row.run_id !== record.run_id || !(row.state === 'cutover' || (switched && row.state === 'rolled_back'))) {
    throw unavailable(`the old primary does not record swap run ${record.run_id} at cutover (it records ${row ? `${row.role} ${row.run_id} at ${row.state}` : 'no graduation row'}).`);
  }
  return record;
}

async function readDiff(deps: FailbackDeps): Promise<FailbackDiff> {
  try {
    return await diffBrains(deps.rust, deps.primary);
  } catch (error) {
    if (error instanceof UnboundedReadError) throw unavailable(`${error.table}: ${error.message}.`);
    throw error;
  }
}

function planOf(record: SwapRecord, diff: FailbackDiff, losses: FailbackLosses): FailbackPlan {
  const segmented = diff.pages.filter(d => d.parts.includes('page') && (isSegmented(d.primary) || isSegmented(d.rust))).map(d => refKey(d.ref));
  if (segmented.length) throw unavailable(`page(s) ${segmented.slice(0, 5).join(', ')}${segmented.length > 5 ? ', ...' : ''} keep their body in segments and changed on Rust; failback cannot rewrite a segmented body yet.`);
  const imaged = diff.pages.filter(d => d.parts.includes('chunks') && (d.rust?.parts.chunks as Array<{ modality?: unknown }> | undefined)
    ?.some(c => c.modality != null && c.modality !== 'text')).map(d => refKey(d.ref));
  if (imaged.length) {
    throw unavailable(`page(s) ${imaged.slice(0, 5).join(', ')}${imaged.length > 5 ? ', ...' : ''} changed on Rust and hold image chunks; no Rust read call returns content_chunks.embedding_image or embedding_multimodal, so failback refuses rather than drop them.`);
  }
  if (diff.facts.add.length) {
    throw unavailable(`${diff.facts.add.length} fact(s) were added on the Rust engine after the swap, and no Rust read call returns ${FACT_COLUMNS_WITHOUT_READ.map(c => `facts.${c}`).join(', ')}; failback would lose those values, so it refuses until the Rust fact read returns them.`);
  }
  if (diff.sources.remove.length) throw unavailable(`source(s) ${diff.sources.remove.join(', ')} exist on the old primary but not on the Rust engine; failback never deletes a source.`);
  return {
    run_id: record.run_id,
    target: record.switch!.previous.engine,
    plan_hash: hashOf([record.run_id, record.switch!.previous.engine, diff.hash]).slice(0, 16),
    pages: diff.counts, facts: counts(diff.facts), open_loops: counts(diff.open_loops), config: counts(diff.config), sources: counts(diff.sources),
    losses: {
      accepted: [
        { name: 'page_version_collapse', count: diff.counts.changed,
          detail: 'A page changed on Rust gets one new version on the old primary for all its Rust-side edits; the versions the Rust engine recorded are not copied.' },
        { name: 'new_row_ids', count: diff.counts.added, detail: 'A page created on Rust after the swap gets a new row id on the old primary (facts, takes and files keep theirs).' },
      ],
      ...losses,
    },
    known_limits: FAILBACK_KNOWN_LIMITS,
  };
}

/** Read only: the preconditions, what differs, the closed loss list and the plan hash. */
export async function planFailback(deps: FailbackDeps): Promise<FailbackPlan> {
  const record = await checkedRecord(deps);
  return planOf(record, await readDiff(deps), await failbackLosses(deps.primary));
}

function save(record: SwapRecord, deps: FailbackDeps, to: FailbackState): void {
  const at = (deps.now?.() ?? new Date()).toISOString();
  record.failback = { ...record.failback!, state: to, updated_at: at, error: null };
  record.updated_at = at;
  writeSwapRecord(deps.recordPath, record, deps.fs ?? REAL_FS);
  deps.progress?.(`engine failback: ${to}`);
}

function fail(record: SwapRecord, deps: FailbackDeps, code: string, reason: SwapRefusalReason): void {
  const at = (deps.now?.() ?? new Date()).toISOString();
  record.failback = { ...record.failback!, updated_at: at, error: { state: record.failback!.state, code, reason, diagnostic_id: DIAG(), at } };
  writeSwapRecord(deps.recordPath, record, deps.fs ?? REAL_FS);
}

function describe(mismatches: readonly Mismatch[]): string {
  const shown = mismatches.slice(0, 5).map(m => `${m.part} ${m.key}`).join('; ');
  return `${mismatches.length} read(s) differ between the engines (${shown}${mismatches.length > 5 ? '; ...' : ''})`;
}

async function writerRefusal(deps: FailbackDeps): Promise<OperationError | null> {
  const writer = await deps.writers();
  return writer ? swapRefusal('brain_in_use', `another writer is active: ${writer}.`,
    'Failback holds both engines while it copies and switches, so every other writer must stop first. Stop it, then run failback again.') : null;
}

/** The reverse fingerprint guard: the old primary's fingerprint function must agree with the Rust engine's on every stored fact. */
async function reverseFingerprints(primary: BrainEngine): Promise<'pass'> {
  if (!(await hasFingerprintFunctions(primary))) {
    throw swapRefusal('verification_incomplete', 'the old primary has no fingerprint functions, so the reverse fingerprint check cannot run.',
      'Run gbrain apply-migrations on the old primary, then run failback again. The Rust engine keeps authority.');
  }
  const probe = await probeOnPrimary(primary);
  // The probe's own rule (src/shadow/fingerprints.ts probeState): where the server's lower()/[[:space:]] differ on some
  // code points, only a stored fact holding one fingerprints differently; with no differing code point, any corpus
  // mismatch is unexplained and refuses.
  const affected = probe.differing_code_points_total > 0 ? probe.facts_with_differing_code_points > 0 : probe.corpus_mismatches > 0;
  if (affected) {
    throw swapRefusal('fingerprint_semantics_differ',
      `${probe.facts_with_differing_code_points} stored fact(s) hold a code point whose fingerprint differs on the old primary (${probe.corpus_mismatches} probe mismatch(es)).`,
      'Fact deduplication would treat those facts differently after failback. The Rust engine keeps authority.');
  }
  return 'pass';
}

function probeOk(p: RouteProbe, previous: { engine: string; database_path: string }): boolean {
  if (!p.ok || p.effective_engine !== previous.engine) return false;
  return !previous.database_path || (p.database_path !== null && resolve(p.database_path) === resolve(previous.database_path));
}

/** Runs failback for the plan whose hash is `expect`; returns the record at `succeeded`. Resumes a run stopped after the switch. */
export async function runFailback(deps: FailbackDeps, expect: string): Promise<SwapRecord> {
  const record = await checkedRecord(deps);
  const previous = record.switch!.previous;
  const saved = { runDir: deps.runDir, runId: record.run_id };
  if (record.failback?.state !== 'switched') {
    const writer = await writerRefusal(deps);
    if (writer) throw writer;
    const route = deps.routeCheck?.();
    if (route) throw route;
    const plan = planOf(record, await readDiff(deps), await failbackLosses(deps.primary));
    if (plan.plan_hash !== expect) {
      throw opError('preview_changed', `The failback plan changed: its hash is ${plan.plan_hash}, not ${expect}. Nothing was written.`,
        'Read the failback plan again and confirm the new hash.', { docs: 'docs/guides/engine-swap.md#failback',
          fix: { argv: ['gbrain', 'engine', 'swap', '--to', previous.engine, '--plan', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Reads the current failback plan and its hash.' } });
    }
    const at = (deps.now?.() ?? new Date()).toISOString();
    record.failback = { state: 'planned', plan_hash: plan.plan_hash, target: previous.engine, started_at: at, updated_at: at, error: null };
    save(record, deps, 'planned');
    const copy = await copyBack(deps.primary, record.run_id, await readDiff(deps), deps.progress);
    record.failback.copy = { ...copy, at: (deps.now?.() ?? new Date()).toISOString() };
    save(record, deps, 'copied');
    await deps.beforeVerify?.();
    const left = mismatchesOf(await readDiff(deps));
    record.failback.verify = { ok: left.length === 0, mismatches: left.length, fingerprint: 'not_run', at: (deps.now?.() ?? new Date()).toISOString() };
    if (left.length) {
      fail(record, deps, 'failback_mismatch', 'failback_mismatch');
      throw swapRefusal('failback_mismatch', `${describe(left)} after the copy.`,
        'The Rust engine keeps authority and the old primary stays fenced. A write on Rust during the copy is the usual cause: stop it and run failback again.');
    }
    try {
      record.failback.verify.fingerprint = await reverseFingerprints(deps.primary);
    } catch (error) {
      fail(record, deps, (error as OperationError).reason ?? 'fingerprint_failed', ((error as OperationError).reason ?? 'verification_incomplete') as SwapRefusalReason);
      throw error;
    }
    save(record, deps, 'verified');
    const late = await writerRefusal(deps);
    if (late) { fail(record, deps, 'brain_in_use', 'brain_in_use'); throw late; }
    restoreAuthority(previous, saved);
    // Nothing new routes to the Rust engine now; a write that reached it in between shows here, and the switch is undone.
    const last = mismatchesOf(await readDiff(deps));
    if (last.length) {
      switchAuthority(record.rust_store, saved);
      record.failback.state = 'copied';
      fail(record, deps, 'failback_mismatch', 'failback_mismatch');
      throw swapRefusal('failback_mismatch', `${describe(last)} after the switch; the switch was undone.`,
        'A writer reached the Rust engine during failback. The Rust engine keeps authority; stop that writer and run failback again.');
    }
    save(record, deps, 'switched');
  }
  await withGraduationRun(deps.primary, record.run_id, async tx => {
    await dropGraduationFence(tx);
    await setSourceState(tx, record.run_id, 'rolled_back');
  });
  await deps.beforeProbe?.();
  const probe = await deps.prober();
  record.failback!.probe = { ...probe, at: (deps.now?.() ?? new Date()).toISOString() };
  if (!probeOk(probe, previous)) {
    fail(record, deps, 'route_probe_failed', 'verification_incomplete');
    throw swapRefusal('verification_incomplete', `a fresh process did not open the ${previous.engine} engine (it saw ${probe.effective_engine ?? 'no engine'}${probe.ok ? '' : ', probe failed'}).`,
      'The old engine has authority and takes writes again; the Rust store is unchanged. Fix what the probe names, then check with gbrain engine status --probe.');
  }
  save(record, deps, 'succeeded');
  return record;
}

/** Compares both engines through every read call failback makes. Read only. */
export async function verifyFailback(rust: BrainEngine, primary: BrainEngine): Promise<{ ok: boolean; mismatches: Mismatch[] }> {
  const mismatches = mismatchesOf(await diffBrains(rust, primary));
  return { ok: mismatches.length === 0, mismatches };
}

