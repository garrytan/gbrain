/**
 * Shadow evidence, the reading side (plan a1): the epoch manifest, the exactness table, and the aggregator that turns
 * the ledger, the usage files and the fault history into the `reads`, `search` and `child` fields readiness reads.
 *
 * Protects: counts are epoch-scoped and windowed by row time; a class that was used but never compared is listed with 0 and a
 * class under its minimum is named even when the 10,000 total is met; missing or corrupt evidence is absent, never zero; a
 * rust_error, an inconclusive exactness mismatch, a panic, a SIGABRT or a fault beyond the display tail each fail
 * the right criterion; a stale mismatch counts for nothing; filling a policy `brain_ref` does not start a new epoch.
 * Rows are written with the real ledger writers; the capture side is test/shadow-evidence-child.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEngineShadow } from '../src/commands/engine-shadow.ts';
import { evaluateReadiness } from '../src/core/engine-swap/readiness.ts';
import { policyHash, READINESS_POLICY } from '../src/core/engine-swap/policy.ts';
import { capabilitySetHash, currentBuild, ensureEpoch, readEpoch, SHADOW_ADAPTER_VERSION, type EpochBuild, type EpochInputs } from '../src/shadow/evidence-epoch.ts';
import { buildEvidenceStatus, DEFAULT_READINESS_DAYS, MIN_SUCCESSFUL_PER_OP, renderEvidenceStatus } from '../src/shadow/evidence.ts';
import { exactnessArm, isCollationOrder, qualifyMismatch } from '../src/shadow/exactness.ts';
import { appendFault, appendLedgerRows, ledgerDir, type ShadowFault, type ShadowLedgerRow } from '../src/shadow/ledger.ts';
import { SHADOW_READ_MEMBERS } from '../src/shadow/reads.ts';
import { appendPass, buildFollowStatus, NOT_RUN_PROBE } from '../src/shadow/follow-status.ts';
import { buildProvisionalReport, renderProvisionalMarkdown } from '../src/shadow/report.ts';
import { writeSeedRecord, type SeedRecord } from '../src/shadow/seed.ts';
import { SHADOW_STATE_VERSION, shadowBrainKey, shadowDirFor, writeShadowState } from '../src/shadow/state.ts';
import { appendUsage, readEpochUsage } from '../src/shadow/usage.ts';
import { readConfiguredShadowStatus } from '../src/shadow/status-document.ts';
import { withEnv } from './helpers/with-env.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'gbrain-shadow-evidence-agg-')); dirs.push(d); return d; };

const NOW = new Date('2026-11-30T12:00:00.000Z');
const DAY = 86_400_000;
const STARTED = Date.parse('2026-11-24T00:00:00.000Z');
const INPUTS: EpochInputs = {
  seed_id: 'seed-1', rust_addon_sha256: 'a'.repeat(64), comparator_version: 1, adapter_version: 'abi1.catalog3',
  capability_set_hash: capabilitySetHash(['pages', 'search']), readiness_policy_hash: policyHash(READINESS_POLICY),
};

/** A directory with an epoch opened at STARTED; returns the dir and the epoch id. */
function epochDir(inputs: EpochInputs = INPUTS): { dir: string; epoch: string } {
  const dir = tmp();
  return { dir, epoch: ensureEpoch(dir, inputs, STARTED).epoch_id };
}

type Counts = Partial<Record<ShadowLedgerRow['outcome'], number>>;
function rowsOf(epoch: string | undefined, op: string, counts: Counts, ts = new Date(NOW.getTime() - DAY).toISOString()): ShadowLedgerRow[] {
  const out: ShadowLedgerRow[] = [];
  for (const [outcome, n] of Object.entries(counts) as Array<[ShadowLedgerRow['outcome'], number]>) {
    for (let i = 0; i < n; i++) out.push({ ts, op, outcome, ...(epoch ? { epoch_id: epoch } : {}), primary_ms: 1, rust_ms: 1, primary_rows: 1, rust_rows: 1 });
  }
  return out;
}
const put = (dir: string, rows: ShadowLedgerRow[]): void => appendLedgerRows(dir, rows);
const used = (dir: string, epoch: string | null, ops: Record<string, Partial<{ offered: number; sampled_out: number; shed: number; skipped_in_transaction: number; unmirrorable: number }>>): void =>
  appendUsage(dir, { ts: new Date(NOW.getTime() - DAY).toISOString(), epoch_id: epoch, ops: Object.fromEntries(Object.entries(ops).map(([op, u]) => [op, { offered: 0, sampled_out: 0, shed: 0, skipped_in_transaction: 0, unmirrorable: 0, ...u }])) });
const status = (dir: string, extra: Partial<Parameters<typeof buildEvidenceStatus>[0]> = {}) => buildEvidenceStatus({ dir, now: NOW, ...extra });
const fault = (dir: string, f: Partial<ShadowFault> & Pick<ShadowFault, 'kind'>): void => appendFault(dir, { ts: new Date(NOW.getTime() - DAY).toISOString(), detail: '', ...f });

describe('evidence epoch manifest', () => {
  test('a changed seed, addon digest, comparator, adapter, capability set or policy hash starts a new epoch; an identical set does not', () => {
    const dir = tmp();
    const first = ensureEpoch(dir, INPUTS, STARTED);
    expect(first).toMatchObject({ version: 1, started_at: new Date(STARTED).toISOString(), inputs: INPUTS });
    expect(ensureEpoch(dir, { ...INPUTS }, STARTED + 99 * DAY)).toEqual(first); // an unrelated release with the same inputs
    expect(readEpoch(dir)).toEqual(first);
    const changes: Array<Partial<EpochInputs>> = [
      { seed_id: 'seed-2' }, { rust_addon_sha256: 'b'.repeat(64) }, { comparator_version: 2 }, { adapter_version: 'abi2.catalog3' },
      { capability_set_hash: capabilitySetHash(['pages']) }, { readiness_policy_hash: 'ffff' },
    ];
    const ids = new Set([first.epoch_id]);
    for (const [i, change] of changes.entries()) {
      const next = ensureEpoch(dir, { ...INPUTS, ...change }, STARTED + (i + 1) * DAY);
      expect(ids.has(next.epoch_id)).toBe(false);
      ids.add(next.epoch_id);
      expect(next.started_at).toBe(new Date(STARTED + (i + 1) * DAY).toISOString());
      ensureEpoch(dir, INPUTS, STARTED + 50 * DAY); // back to the first inputs: still a new epoch, it must not revive old rows
    }
    expect(readFileSync(join(dir, 'evidence', 'epochs.jsonl'), 'utf8').trim().split('\n').length).toBe(changes.length * 2);
  });

  test('going back to earlier inputs does not bring the earlier epoch back', () => {
    const dir = tmp();
    const a = ensureEpoch(dir, INPUTS, STARTED);
    ensureEpoch(dir, { ...INPUTS, rust_addon_sha256: 'c'.repeat(64) }, STARTED + DAY);
    expect(ensureEpoch(dir, INPUTS, STARTED + 2 * DAY).epoch_id).not.toBe(a.epoch_id);
  });

  test('two children that open the same new epoch agree on its id', () => {
    const [x, y] = [tmp(), tmp()];
    ensureEpoch(x, INPUTS, STARTED); ensureEpoch(y, INPUTS, STARTED);
    const next = { ...INPUTS, rust_addon_sha256: 'd'.repeat(64) };
    expect(ensureEpoch(x, next, STARTED + DAY).epoch_id).toBe(ensureEpoch(y, next, STARTED + DAY + 5).epoch_id);
  });

  test('the epoch input is the approved policy\'s policyHash; a filled-in brain_ref does not change it or the epoch', () => {
    // Cross-check of the value policyHash(READINESS_POLICY) gave when this was written (origin/vorflux/engine-swap-run 73961727d0),
    // and of the formula it documents: version, shadow_min and the unwaivable list.
    expect(policyHash(READINESS_POLICY)).toBe('69c02b309b037f6b');
    expect(policyHash(READINESS_POLICY)).toBe(createHash('sha256').update(JSON.stringify({
      v: 1, shadow_min: { kind: 'days', days: 14 },
      unwaivable: ['privacy', 'fingerprints', 'topology', 'platform', 'capabilities', 'recovery_drills', 'caught_up_following', 'final_digests'],
    })).digest('hex').slice(0, 16));
    const unbound = { ...READINESS_POLICY, overrides: READINESS_POLICY.overrides!.map((o) => ({ ...o, brain_ref: null })) };
    const bound = { ...READINESS_POLICY, overrides: READINESS_POLICY.overrides!.map((o) => ({ ...o, brain_ref: '0123456789abcdef' })) };
    const dir = tmp();
    const a = ensureEpoch(dir, { ...INPUTS, readiness_policy_hash: policyHash(unbound) }, STARTED);
    expect(ensureEpoch(dir, { ...INPUTS, readiness_policy_hash: policyHash(bound) }, STARTED + DAY)).toEqual(a);
    // The duration itself is policy: a different default duration is a different policy and a new epoch.
    expect(policyHash({ ...READINESS_POLICY, shadow_min: { kind: 'days', days: 5 } })).not.toBe(policyHash(READINESS_POLICY));
  });

  test('an unreadable manifest reads as no epoch', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'evidence'));
    writeFileSync(join(dir, 'evidence', 'epoch.json'), '{"version":1,"epoch_id":');
    expect(readEpoch(dir)).toBeNull();
    expect(status(dir)).toEqual({});
  });
});

const BUILD: EpochBuild = { gbrain_commit: 'a'.repeat(40), gbrain_version: '1.2.3', addon_target: 'linux-x64-glibc' };

describe('epoch build fields', () => {
  test('recorded when the epoch starts, kept by an unrelated update, replaced only by a new epoch', () => {
    const dir = tmp();
    const first = ensureEpoch(dir, INPUTS, STARTED, BUILD);
    expect(first.build).toEqual(BUILD);
    const updated = { gbrain_commit: 'b'.repeat(40), gbrain_version: '1.2.4', addon_target: 'linux-x64-glibc' };
    expect(ensureEpoch(dir, INPUTS, STARTED + DAY, updated)).toEqual(first); // the same epoch: its build is not rewritten
    expect(readEpoch(dir)!.build).toEqual(BUILD);
    const next = ensureEpoch(dir, { ...INPUTS, comparator_version: 2 }, STARTED + 2 * DAY, updated);
    expect(next.epoch_id).not.toBe(first.epoch_id);
    expect(next.build).toEqual(updated);
  });

  test('the build does not feed the epoch id, and an epoch from before the fields has no build and is never given one', () => {
    const [a, b] = [tmp(), tmp()];
    expect(ensureEpoch(a, INPUTS, STARTED, BUILD).epoch_id).toBe(ensureEpoch(b, INPUTS, STARTED).epoch_id);
    expect(readEpoch(b)!.build).toBeUndefined();
    ensureEpoch(b, INPUTS, STARTED + DAY, BUILD); // unknown history stays unknown
    expect(readEpoch(b)!.build).toBeUndefined();
    expect(status(b, { epoch: readEpoch(b) }).evidence!.build).toBeUndefined();
    expect(renderEvidenceStatus(status(b)).join('\n')).toContain('build: not recorded');
    expect(status(a).evidence!.build).toEqual(BUILD);
    expect(renderEvidenceStatus(status(a)).join('\n')).toContain(`commit ${'a'.repeat(40)}, gbrain 1.2.3, addon target linux-x64-glibc`);
  });

  test('a malformed build in the manifest reads as no build', () => {
    const dir = tmp();
    ensureEpoch(dir, INPUTS, STARTED, BUILD);
    const path = join(dir, 'evidence', 'epoch.json');
    writeFileSync(path, readFileSync(path, 'utf8').replace('"gbrain_version": "1.2.3"', '"gbrain_version": 7'));
    expect(readEpoch(dir)!.build).toBeUndefined();
  });

  test('the commit is the one a release build stamps with --define GBRAIN_BUILD_COMMIT; an unstamped run, or a malformed stamp, has none', () => {
    const script = join(tmp(), 'build.ts');
    writeFileSync(script, `import { currentBuild } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'shadow', 'evidence-epoch.ts'))};\nconsole.log(JSON.stringify(currentBuild()));\n`);
    const run = (define: string[]) => spawnSync(process.execPath, ['run', ...define, script], { encoding: 'utf8' });
    const stamped = run(['--define', `GBRAIN_BUILD_COMMIT="${'f'.repeat(40)}"`]);
    expect(JSON.parse(stamped.stdout).gbrain_commit).toBe('f'.repeat(40));
    expect(JSON.parse(run([]).stdout).gbrain_commit).toBeNull();
    expect(JSON.parse(run(['--define', 'GBRAIN_BUILD_COMMIT="not-a-sha"']).stdout).gbrain_commit).toBeNull();
    expect(currentBuild().gbrain_commit).toBeNull(); // this test process is unstamped
  });
});

describe('collation order', () => {
  const page = (slug: string, source_id = 'default') => ({ slug, source_id });
  test('compares the primary\'s rows re-sorted by the text key in C byte order, not JavaScript string order', () => {
    expect(isCollationOrder('getTags', [], ['alpha', 'Beta'], ['Beta', 'alpha'])).toBe(true);
    expect(isCollationOrder('getTags', [], ['é', 'z'], ['z', 'é'])).toBe(true); // 0xC3 0xA9 sorts after 'z'
    // UTF-8 byte order puts U+FF5E (EF BD 9E) before U+1F600 (F0 9F 98 80); UTF-16 string order does the opposite.
    expect(isCollationOrder('getTags', [], ['\u{1F600}', '\uFF5E'], ['\uFF5E', '\u{1F600}'])).toBe(true);
    expect(isCollationOrder('getTags', [], ['\uFF5E', '\u{1F600}'], ['\u{1F600}', '\uFF5E'])).toBe(false);
    expect(isCollationOrder('getTags', [], ['a', 'b'], ['a', 'b'])).toBe(false); // already equal: a match, never this
    expect(isCollationOrder('getTags', [], ['a', 'a', 'b'], ['b', 'a'])).toBe(false);
    expect(isCollationOrder('getTags', [], 'not rows', ['a'])).toBe(false);
    expect(isCollationOrder('getTags', [], [1, 2], [2, 1])).toBe(false); // a row with no text key
  });

  test('listPages is text-ordered only for sort: slug, by slug then source id', () => {
    const rows = [page('ab', 's2'), page('a-c', 's1'), page('ab', 's1')];
    const c = [page('a-c', 's1'), page('ab', 's1'), page('ab', 's2')];
    expect(isCollationOrder('listPages', [{ sort: 'slug' }], rows, c)).toBe(true);
    expect(isCollationOrder('listPages', [{ sort: 'slug' }], rows, [page('a-c', 's1'), page('ab', 's2'), page('ab', 's1')])).toBe(false);
    expect(isCollationOrder('listPages', [{ sort: 'updated_desc' }], rows, c)).toBe(false);
    expect(isCollationOrder('listPages', [], rows, c)).toBe(false);
    expect(isCollationOrder('getBacklinks', ['x'], [{ from_slug: 'b' }, { from_slug: 'a' }], [{ from_slug: 'a' }, { from_slug: 'b' }])).toBe(false);
  });

  test('qualifyMismatch names it before lag is considered, and only for an order-only difference of text-ordered rows', () => {
    const sample = { args: [], primary: ['alpha', 'Beta'], rust: ['Beta', 'alpha'] };
    expect(qualifyMismatch('getTags', { outcome: 'diff' }, false, sample)).toEqual({ outcome: 'collation_order', mismatch: 'diff' });
    expect(qualifyMismatch('getTags', { outcome: 'diff' }, true, sample)).toEqual({ outcome: 'collation_order', mismatch: 'diff' });
    expect(qualifyMismatch('getTags', { outcome: 'diff' }, true, { ...sample, rust: ['Beta'] })).toEqual({ outcome: 'stale', mismatch: 'diff' });
    expect(qualifyMismatch('getTags', { outcome: 'match' }, false, sample)).toEqual({ outcome: 'match' });
  });

  test('collation_order is explained and successful: counted per operation class and printed, never unexplained', () => {
    const { dir, epoch } = epochDir();
    put(dir, [...rowsOf(epoch, 'getTags', { match: 2, collation_order: 3, inconclusive: 1 }), ...rowsOf(epoch, 'listPages', { collation_order: 2 })]);
    const s = status(dir);
    expect(s.evidence!.collation_order).toEqual({ getTags: 3, listPages: 2 });
    expect(s.reads).toMatchObject({ diverged_unexplained_7d: 1 });
    expect(s.reads!.ops).toEqual([{ op: 'getTags', successful: 5, minimum: 100 }, { op: 'listPages', successful: 2, minimum: 100 }]);
    const text = renderEvidenceStatus(s).join('\n');
    expect(text).toContain('collation_order (explained and counted as successful: same rows, in the C byte order Rust follows; ICU and glibc hosts sort differently): getTags 3, listPages 2');
    expect(status(epochDir().dir).evidence!.collation_order).toEqual({});
  });
});

describe('exactness table', () => {
  test('every exact member, the trigram arm and the three ts_rank arms must match exactly; take searches count a different row set, and vector search counts under excludePrivate', () => {
    for (const [op, kind] of Object.entries(SHADOW_READ_MEMBERS)) {
      const expected = kind === 'exact' ? 'exact' : ({ findByTitleFuzzy: 'trigram', searchKeyword: 'keyword_title', searchKeywordChunks: 'keyword_title', searchTitles: 'keyword_title', searchTakes: 'membership', searchTakesVector: 'membership', searchVector: 'private_ranked' } as Record<string, string>)[op] ?? null;
      expect([op, exactnessArm(op)]).toEqual([op, expected]);
    }
    expect(exactnessArm('toString')).toBeNull(); // an inherited name is not an operation
    expect(exactnessArm('putPage')).toBeNull();
  });

  test('only a mismatch on an exactness comparison is qualified; lag decides stale', () => {
    expect(qualifyMismatch('getPage', { outcome: 'diff' }, false)).toEqual({ outcome: 'inconclusive', mismatch: 'diff' });
    expect(qualifyMismatch('findByTitleFuzzy', { outcome: 'order_diff' }, true)).toEqual({ outcome: 'stale', mismatch: 'order_diff' });
    expect(qualifyMismatch('searchVector', { outcome: 'order_diff' }, true)).toEqual({ outcome: 'order_diff' }); // the same rows in another order stay reported
    expect(qualifyMismatch('searchTakes', { outcome: 'order_diff' }, true)).toEqual({ outcome: 'order_diff' });
    expect(qualifyMismatch('searchTakes', { outcome: 'diff' }, false)).toEqual({ outcome: 'inconclusive', mismatch: 'diff' });
    expect(qualifyMismatch('getPage', { outcome: 'match' }, true)).toEqual({ outcome: 'match' });
    expect(qualifyMismatch('getPage', { outcome: 'error', reason: 'x' }, true)).toEqual({ outcome: 'error', reason: 'x' });
  });
});

describe('usage files', () => {
  test('lines are filtered by epoch; a corrupt middle line is unreadable, a torn last line is skipped', () => {
    const dir = tmp();
    used(dir, 'e1', { getPage: { offered: 2 } });
    used(dir, 'e2', { listPages: { offered: 1 } });
    used(dir, null, { getTags: { offered: 1 } });
    expect(readEpochUsage(dir, 'e1')!.map((l) => Object.keys(l.ops))).toEqual([['getPage']]);
    expect(readEpochUsage(tmp(), 'e1')).toEqual([]);
    const file = join(dir, 'usage', `${new Date(NOW.getTime() - DAY).toISOString().slice(0, 10)}.jsonl`);
    appendFileSync(file, '{"ts":"torn');
    expect(readEpochUsage(dir, 'e1')).toHaveLength(1);
    appendFileSync(file, '\n{"ts":"2026-11-29T00:00:00.000Z","epoch_id":"e1","ops":{}}\n');
    expect(readEpochUsage(dir, 'e1')).toBeNull();
  });
});

describe('reads', () => {
  test('a class that was used but never compared is listed with 0 successes next to classes that were', () => {
    const { dir, epoch } = epochDir();
    put(dir, rowsOf(epoch, 'getPage', { match: 3 }));
    used(dir, epoch, { getPage: { offered: 40, sampled_out: 37 }, getBacklinks: { offered: 12, sampled_out: 12 }, getTags: { offered: 1, skipped_in_transaction: 1 } });
    const s = status(dir);
    expect(s.reads!.ops).toEqual([
      { op: 'getBacklinks', successful: 0, minimum: MIN_SUCCESSFUL_PER_OP }, { op: 'getPage', successful: 3, minimum: 100 }, { op: 'getTags', successful: 0, minimum: 100 },
    ]);
    expect(s.evidence!.ops_lacking_samples).toEqual(['getBacklinks 0/100', 'getPage 3/100', 'getTags 0/100']);
    expect(s.evidence!.usage.getBacklinks).toMatchObject({ offered: 12, sampled_out: 12 });
    expect(renderEvidenceStatus(s).join('\n')).toContain('lacking samples: getBacklinks 0/100 (offered 12, sampled out 12');
  });

  test('a class at 99 is named while the total is over 10,000; successful means a match or a collation_order', () => {
    const { dir, epoch } = epochDir();
    put(dir, rowsOf(epoch, 'getPage', { match: 10_500 }));
    put(dir, rowsOf(epoch, 'listPages', { match: 99, stale: 40, inconclusive: 3, order_diff: 5, error: 2, capability_missing: 1 }));
    const s = status(dir);
    expect(s.reads!.ops).toEqual([{ op: 'getPage', successful: 10_500, minimum: 100 }, { op: 'listPages', successful: 99, minimum: 100 }]);
    expect(s.evidence!.ops_lacking_samples).toEqual(['listPages 99/100']);
  });

  test('collation_order counts toward the class minimum and the total, with its own count kept', () => {
    const { dir, epoch } = epochDir();
    put(dir, [...rowsOf(epoch, 'getTags', { match: 98, collation_order: 2 }), ...rowsOf(epoch, 'listPages', { match: 99, collation_order: 0, stale: 1 })]);
    const s = status(dir);
    expect(s.reads!.ops).toEqual([{ op: 'getTags', successful: 100, minimum: 100 }, { op: 'listPages', successful: 99, minimum: 100 }]);
    expect(s.evidence!.ops_lacking_samples).toEqual(['listPages 99/100']);
    expect(s.evidence!.collation_order).toEqual({ getTags: 2 });
    put(dir, rowsOf(epoch, 'getPage', { collation_order: 10_000 }));
    expect(status(dir).reads!.ops.reduce((n, o) => n + o.successful, 0)).toBe(100 + 99 + 10_000); // the 10,000 total counts it too
  });

  test('counts are scoped to the current epoch: rows of another epoch or of none are kept in the ledger and counted for nothing', () => {
    const { dir, epoch } = epochDir();
    put(dir, [...rowsOf(epoch, 'getPage', { match: 2 }), ...rowsOf('older-epoch', 'getPage', { match: 500, error: 5, inconclusive: 5 }), ...rowsOf(undefined, 'getPage', { match: 500, error: 5 })]);
    const s = status(dir);
    expect(s.reads).toEqual({ ops: [{ op: 'getPage', successful: 2, minimum: 100 }], capability_missing_7d: 0, rust_error_unresolved_7d: 0, diverged_unexplained_7d: 0 });
    // A new epoch starts every count over.
    ensureEpoch(dir, { ...INPUTS, rust_addon_sha256: 'e'.repeat(64) }, STARTED + 3 * DAY);
    expect(status(dir).reads).toBeUndefined();
  });

  test('the 7-day windows use each row\'s own time, even inside one day file', () => {
    const { dir, epoch } = epochDir({ ...INPUTS });
    const edge = NOW.getTime() - 7 * DAY;
    put(dir, [
      ...rowsOf(epoch, 'getPage', { error: 1, capability_missing: 1, inconclusive: 1 }, new Date(edge - 1_000).toISOString()),
      ...rowsOf(epoch, 'getPage', { timeout: 1, addon_unavailable: 1, capability_missing: 1, inconclusive: 1, diff: 1 }, new Date(edge + 1_000).toISOString()),
    ]);
    expect(status(dir).reads).toMatchObject({ rust_error_unresolved_7d: 2, capability_missing_7d: 1, diverged_unexplained_7d: 2 });
    // "only a new epoch clears it": a later clock does not clear a row still inside the window
    expect(status(dir, { now: new Date(NOW.getTime() + 6 * DAY) }).reads).toMatchObject({ rust_error_unresolved_7d: 0 });
  });

  test('unexplained means an inconclusive or diverged exactness mismatch; stale, vector order differences, a vector diff without excludePrivate and matches are not', () => {
    const { dir, epoch } = epochDir();
    put(dir, [
      ...rowsOf(epoch, 'getPage', { match: 4, stale: 7, inconclusive: 2 }), ...rowsOf(epoch, 'findByTitleFuzzy', { inconclusive: 1 }), ...rowsOf(epoch, 'searchKeyword', { diff: 1 }),
      ...rowsOf(epoch, 'searchVector', { order_diff: 9, diff: 3, inconclusive: 1 }), ...rowsOf(epoch, 'getStats', { privacy_diverged: 1 }),
    ]);
    // getPage 2 + fuzzy 1 + keyword 1, the unrerun vector inconclusive 1 and the leak 1; vector order_diff and a vector diff without excludePrivate are reported only
    expect(status(dir).reads).toMatchObject({ diverged_unexplained_7d: 6, rust_error_unresolved_7d: 0 });
  });

  test('absent, never zero: no epoch, a corrupt ledger day, a corrupt usage file, or nothing used', () => {
    expect(status(tmp())).toEqual({});
    const { dir, epoch } = epochDir();
    expect(status(dir).reads).toBeUndefined(); // an epoch with no class used: no evidence yet
    expect(status(dir).evidence).toMatchObject({ epoch_id: epoch });
    put(dir, rowsOf(epoch, 'getPage', { match: 1 }));
    expect(status(dir).reads!.ops).toHaveLength(1);
    const day = join(ledgerDir(dir), `${new Date(NOW.getTime() - DAY).toISOString().slice(0, 10)}.jsonl`);
    appendFileSync(day, '{"ts":"torn');
    expect(status(dir).reads!.ops).toHaveLength(1); // a torn last line is skipped
    appendFileSync(day, '\nnot json\n');
    expect(status(dir).reads).toBeUndefined();
    expect(status(dir).search).toBeUndefined();
    const bad = epochDir();
    put(bad.dir, rowsOf(bad.epoch, 'getPage', { match: 1 }));
    mkdirSync(join(bad.dir, 'usage'));
    writeFileSync(join(bad.dir, 'usage', '2026-11-29.jsonl'), 'garbage\n{"ts":"x"}\n');
    expect(status(bad.dir).reads).toBeUndefined();
    expect(status(bad.dir).child).toBeDefined(); // child health reads a different file
  });
});

describe('search arms', () => {
  test('an arm with no comparisons is absent; disagreements count inconclusive and diverged rows only', () => {
    const { dir, epoch } = epochDir();
    put(dir, rowsOf(epoch, 'searchVector', { match: 50 }));
    expect(status(dir).search).toBeUndefined(); // valid vector observations do not make a measured zero
    put(dir, rowsOf(epoch, 'findByTitleFuzzy', { match: 8, stale: 3, error: 4 }));
    expect(status(dir).search).toEqual({ trigram_exact_disagreements: 0 });
    put(dir, [...rowsOf(epoch, 'findByTitleFuzzy', { inconclusive: 2, diff: 1 }), ...rowsOf(epoch, 'searchKeywordChunks', { match: 1 }), ...rowsOf(epoch, 'searchTitles', { inconclusive: 1, stale: 5 })]);
    expect(status(dir).search).toEqual({ trigram_exact_disagreements: 3, keyword_title: { ranker: 'ts_rank', exact_disagreements: 1 } });
    expect(JSON.stringify(status(dir))).not.toMatch(/vector_recall|primary_recall/); // no scored recall samples yet (test/shadow-recall.test.ts)
  });

  test('an arm whose rows are all errors has no comparisons', () => {
    const { dir, epoch } = epochDir();
    put(dir, rowsOf(epoch, 'searchKeyword', { error: 3, timeout: 1 }));
    expect(status(dir).search).toBeUndefined();
    expect(status(dir).reads).toMatchObject({ rust_error_unresolved_7d: 4 });
  });
});

describe('child health', () => {
  test('panics are internal errors plus SIGABRT exits; faults are exits and failed spawns; the whole history counts', () => {
    const { dir, epoch } = epochDir();
    for (let i = 0; i < 40; i++) fault(dir, { kind: 'mirroring_disabled', detail: 'x', epoch_id: epoch }); // pushes the first lines out of the 20-line display tail
    fault(dir, { kind: 'child_exit', detail: 'code=1 signal=none', epoch_id: epoch });
    expect(status(dir).child).toEqual({ panics: 0, faults: 1 });
    const early = tmp();
    const e2 = ensureEpoch(early, INPUTS, STARTED).epoch_id;
    fault(early, { kind: 'rust_internal_error', detail: 'boundary=apply code=internal_error', epoch_id: e2 });
    for (let i = 0; i < 40; i++) fault(early, { kind: 'privacy_pause', detail: 'later', epoch_id: e2 });
    expect(status(early).child).toEqual({ panics: 1, faults: 0 });
    fault(early, { kind: 'child_exit', detail: 'code=none signal=SIGABRT', epoch_id: e2 });
    fault(early, { kind: 'child_exit', detail: 'code=134 signal=none', epoch_id: e2 });
    fault(early, { kind: 'spawn_failed', detail: 'Error', epoch_id: e2 });
    fault(early, { kind: 'child_hung', detail: 'no heartbeat for 61s', epoch_id: e2 });
    expect(status(early).child).toEqual({ panics: 3, faults: 3 });
  });

  test('another epoch\'s faults, and an old child\'s late line, are not counted; an untagged fault counts only from the epoch start', () => {
    const { dir, epoch } = epochDir();
    fault(dir, { kind: 'rust_internal_error', detail: 'boundary=read code=internal_error', epoch_id: 'older-epoch' });
    fault(dir, { kind: 'child_exit', detail: 'code=none signal=SIGABRT', epoch_id: 'older-epoch' });
    fault(dir, { kind: 'child_exit', detail: 'code=1 signal=none', ts: new Date(STARTED - 1_000).toISOString() });
    expect(status(dir).child).toEqual({ panics: 0, faults: 0 });
    fault(dir, { kind: 'child_exit', detail: 'code=1 signal=none', ts: new Date(STARTED + 1_000).toISOString() });
    fault(dir, { kind: 'rust_internal_error', detail: 'boundary=open code=internal_error', epoch_id: epoch });
    expect(status(dir).child).toEqual({ panics: 1, faults: 1 });
    ensureEpoch(dir, { ...INPUTS, comparator_version: 2 }, STARTED + DAY);
    expect(status(dir).child).toEqual({ panics: 0, faults: 0 });
  });

  test('a fault file that cannot be read leaves child absent; a missing one is zero', () => {
    const { dir } = epochDir();
    expect(status(dir).child).toEqual({ panics: 0, faults: 0 });
    mkdirSync(join(dir, 'faults.jsonl')); // reading a directory fails
    expect(status(dir).child).toBeUndefined();
  });
});

describe('epoch, earliest READY date and printed rules', () => {
  test('the status names the epoch start and the earliest READY date for the duration it is given (default 14 days)', () => {
    const { dir } = epochDir();
    expect(status(dir).evidence).toMatchObject({ epoch_started_at: '2026-11-24T00:00:00.000Z', readiness_days: DEFAULT_READINESS_DAYS, earliest_ready_at: '2026-12-08T00:00:00.000Z', min_successful_per_op: 100 });
    expect(status(dir, { readinessDays: 5 }).evidence).toMatchObject({ readiness_days: 5, earliest_ready_at: '2026-11-29T00:00:00.000Z' });
  });

  test('the text prints the minimum as an engineering default, the 7-day rust_error rule next to its count, and the panics label', () => {
    const { dir, epoch } = epochDir();
    put(dir, rowsOf(epoch, 'getPage', { match: 5, error: 2 }));
    fault(dir, { kind: 'rust_internal_error', detail: 'boundary=apply code=internal_error', epoch_id: epoch });
    const text = renderEvidenceStatus(status(dir)).join('\n');
    expect(text).toContain('earliest READY 2026-12-08');
    expect(text).toContain('each class needs 100 successful comparisons (an engineering default)');
    expect(text).toContain('unresolved rust_error in the last 7 days: 2 (every rust_error (error, timeout, addon_unavailable) in the last 7 days of the epoch counts as unresolved; only a new epoch clears it)');
    expect(text).toContain('panics or internal errors (conservative) 1');
    expect(renderEvidenceStatus({}).join('\n')).toContain('evidence epoch: none yet');
  });
});

describe('through the status command, the report and the readiness evaluator', () => {
  const SEED = { version: 1, seed_id: 'seed-1', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:01:00.000Z', unseeded_gap_rows_total: 0, unseeded_gap_rows: {}, relations: {}, digests: true } as unknown as SeedRecord;

  test('status --json carries the manifest epoch and the evidence fields, no recall before it is scored; the text status prints the dates', async () => {
    const home = tmp();
    const config = { engine: 'pglite' as const, database_path: join(home, 'brain.pglite') };
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const dir = shadowDirFor(shadowBrainKey(config)!);
      mkdirSync(dir, { recursive: true });
      writeShadowState(dir, { version: SHADOW_STATE_VERSION, enabled: true, started_at: 'x', sample_rate: 0.1, queue_bound: 1, plan_hash: 'h', brain: 'b', primary_engine: 'pglite' });
      writeSeedRecord(dir, SEED);
      const epoch = ensureEpoch(dir, INPUTS, Date.now() - DAY);
      put(dir, rowsOf(epoch.epoch_id, 'getPage', { match: 3 }, new Date().toISOString()));
      used(dir, epoch.epoch_id, { getPage: { offered: 9 } });
      const json: string[] = [];
      expect(await runEngineShadow(['status', '--json'], { config: () => config, out: (l) => json.push(l) })).toBe(0);
      const doc = JSON.parse(json.join('\n'));
      expect(doc.epoch_id).toBe(epoch.epoch_id); // from the manifest, not the seed
      expect(doc.seed.seed_id).toBe('seed-1');
      expect(doc.epoch_started_at).toBe(epoch.started_at);
      expect(doc.reads.ops).toEqual([{ op: 'getPage', successful: 3, minimum: 100 }]);
      expect(doc.child).toEqual({ panics: 0, faults: 0 });
      // The swap reads the same document through readConfiguredShadowStatus.
      const viaSwap = await readConfiguredShadowStatus(() => config);
      expect(viaSwap).toMatchObject({ epoch_id: epoch.epoch_id, reads: doc.reads, child: doc.child });
      expect(doc.search).toBeUndefined();
      expect(doc.privacy_diverged).toBe(0); // reads were compared and none showed a page the caller may not read
      expect(doc.search).toBeUndefined();
      // The real document goes through the real evaluator: criterion 2 names the class lacking samples, 9 passes, 4 and 6 are missing.
      const verdict = evaluateReadiness(doc, new Date());
      const row = (n: number) => verdict.criteria.find((c) => c.n === n)!;
      expect(row(2)).toMatchObject({ state: 'fail' });
      expect(row(2).detail).toContain('getPage 3/100');
      expect(row(3).state).toBe('pass');
      expect(row(9).state).toBe('pass');
      expect(row(4).state).toBe('missing');
      expect(row(6).state).toBe('pass');
      expect(verdict.verdict).toBe('NOT READY');
      const text: string[] = [];
      await runEngineShadow(['status'], { config: () => config, out: (l) => text.push(l) });
      expect(text.join('\n')).toContain('earliest READY');
      expect(text.join('\n')).toContain('engineering default');
    });
  });

  test('the report carries the same evidence and prints the same rules', () => {
    const { dir, epoch } = epochDir();
    put(dir, rowsOf(epoch, 'getPage', { match: 1, inconclusive: 1 }));
    const report = buildProvisionalReport(dir, 'pglite-abc', null, NOW);
    expect(report.verdict).toBe('NOT READY');
    expect(report.evidence.reads).toMatchObject({ diverged_unexplained_7d: 1 });
    const md = renderProvisionalMarkdown(report);
    expect(md).toContain('earliest READY');
    expect(md).toContain('engineering default');
    expect(md).toContain('only a new epoch clears it');
    expect(md).toContain('| inconclusive |');
  });

  describe('evaluateReadiness', () => {
    async function evaluate(dir: string, extra: Record<string, unknown> = {}) {
      const { evidence, ...ev } = status(dir);
      const doc = { epoch_id: evidence?.epoch_id, epoch_started_at: evidence?.epoch_started_at, ...ev, ...extra };
      const v = evaluateReadiness(doc, NOW);
      return { v, row: (n: number) => v.criteria.find((c) => c.n === n)! };
    }
    const full = { search: { vector_recall_at_10: 1, primary_recall_at_10: 1 } };

    test('a healthy epoch passes criteria 2, 3, 6 and 9, and 4 once the recall fields exist; without them 4 stays missing and the verdict NOT READY', async () => {
      const { dir, epoch } = epochDir();
      put(dir, [...rowsOf(epoch, 'getPage', { match: 10_000, stale: 2 }), ...rowsOf(epoch, 'findByTitleFuzzy', { match: 100 }), ...rowsOf(epoch, 'searchKeyword', { match: 100 })]);
      const bare = await evaluate(dir);
      expect(bare.row(2).state).toBe('pass');
      expect(bare.row(3).state).toBe('pass');
      expect(bare.row(9).state).toBe('pass');
      expect(bare.row(4).state).toBe('missing');
      expect(bare.row(4).detail).toContain('search.vector_recall_at_10');
      expect(bare.row(6).state).toBe('pass');
      expect(bare.v.verdict).toBe('NOT READY');
      const { search } = status(dir);
      const with2 = await evaluate(dir, { search: { ...search, ...full.search } });
      expect(with2.row(4).state).toBe('pass');
    });

    test('each field fails its criterion', async () => {
      const bad = epochDir();
      put(bad.dir, [...rowsOf(bad.epoch, 'getPage', { match: 10_500, inconclusive: 1, error: 1 }), ...rowsOf(bad.epoch, 'listPages', { match: 99 }),
        ...rowsOf(bad.epoch, 'findByTitleFuzzy', { match: 5, inconclusive: 1 }), ...rowsOf(bad.epoch, 'searchTitles', { match: 5, inconclusive: 2 })]);
      fault(bad.dir, { kind: 'rust_internal_error', detail: 'boundary=apply code=internal_error', epoch_id: bad.epoch });
      const r = await evaluate(bad.dir, { search: { ...status(bad.dir).search, ...full.search } });
      expect(r.row(2).detail).toContain('listPages 99/100');
      expect(r.row(3)).toMatchObject({ state: 'fail' });
      expect(r.row(3).detail).toContain('1 unresolved rust_error');
      expect(r.row(3).detail).toContain('4 unexplained diverged');
      expect(r.row(4).detail).toContain('1 trigram disagreements');
      expect(r.row(4).detail).toContain('2 keyword/title disagreements under ts_rank');
      expect(r.row(9)).toMatchObject({ state: 'fail', detail: '1 panics' });
    });

    test('a class that was used but never compared fails criterion 2 by name', async () => {
      const { dir, epoch } = epochDir();
      put(dir, rowsOf(epoch, 'getPage', { match: 10_500 }));
      used(dir, epoch, { getBacklinks: { offered: 4, sampled_out: 4 } });
      expect((await evaluate(dir)).row(2).detail).toContain('getBacklinks 0/100');
    });
  });
});

describe('opening an epoch from several processes', () => {
  const script = (): string => {
    const path = join(tmp(), 'open-epoch.ts');
    writeFileSync(path, `import { existsSync } from 'node:fs';
import { ensureEpoch } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'shadow', 'evidence-epoch.ts'))};
const [dir, go] = process.argv.slice(2);
const deadline = Date.now() + 20000;
while (go && !existsSync(go) && Date.now() < deadline) { /* wait for the start signal */ }
const m = ensureEpoch(dir!, ${JSON.stringify(INPUTS)}, Date.now());
console.log(JSON.stringify({ epoch_id: m.epoch_id, started_at: m.started_at }));
`);
    return path;
  };
  const run = (file: string, ...args: string[]) => {
    const child = spawn(process.execPath, ['run', file, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    return { child, exited, out: () => out };
  };

  test('a child waits while another process holds the epoch lock, then opens the epoch', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'evidence'));
    writeFileSync(join(dir, 'evidence', 'epoch.lock'), String(process.pid)); // held by a live process: this one
    const p = run(script(), dir);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(p.child.exitCode).toBeNull();
    expect(existsSync(join(dir, 'evidence', 'epoch.json'))).toBe(false);
    rmSync(join(dir, 'evidence', 'epoch.lock'));
    expect(await p.exited).toBe(0);
    expect(JSON.parse(p.out()).epoch_id).toBe(readEpoch(dir)!.epoch_id);
    expect(existsSync(join(dir, 'evidence', 'epoch.lock'))).toBe(false); // released
  }, 30_000);

  test('processes that start together agree on one epoch, opened once', async () => {
    const file = script();
    for (let round = 0; round < 4; round++) {
      const dir = tmp();
      const go = join(tmp(), 'go');
      const procs = [run(file, dir, go), run(file, dir, go), run(file, dir, go)];
      await new Promise((resolve) => setTimeout(resolve, 400)); // all three are spinning on the start signal
      writeFileSync(go, '');
      expect(await Promise.all(procs.map((p) => p.exited))).toEqual([0, 0, 0]);
      const seen = procs.map((p) => JSON.parse(p.out()));
      expect(new Set(seen.map((m) => m.epoch_id)).size).toBe(1);
      expect(new Set(seen.map((m) => m.started_at)).size).toBe(1); // one process created it; the others found it
      expect(readEpoch(dir)).toMatchObject(seen[0]);
    }
  }, 60_000);

  test('a lock left by a process that is gone is taken over', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'evidence'));
    const gone = spawnSync(process.execPath, ['-e', '0']);
    writeFileSync(join(dir, 'evidence', 'epoch.lock'), String(gone.pid));
    expect(ensureEpoch(dir, INPUTS, STARTED).epoch_id).toBe(readEpoch(dir)!.epoch_id);
    expect(existsSync(join(dir, 'evidence', 'epoch.lock'))).toBe(false);
  });
});

describe('adapter identity', () => {
  test('the TS adapter version is pinned to a digest of the adapter source: a change to it must bump the version', () => {
    const root = join(import.meta.dir, '..', 'src', 'core', 'rust-engine');
    const files = [...readdirSync(join(root, 'store-members')).filter((n) => n.endsWith('.ts')).map((n) => `store-members/${n}`), 'store-codec.ts', 'members.ts'].sort();
    const digest = createHash('sha256');
    // test-reads-source-ok[raw-bytes]: the adapter's source bytes are the fingerprint under test; a change must bump the epoch input
    for (const f of files) digest.update(`${f}\0${readFileSync(join(root, f), 'utf8')}\0`);
    // When this fails, the adapter's mapping changed: bump SHADOW_ADAPTER_VERSION (a new evidence epoch) and set both values here.
    expect([SHADOW_ADAPTER_VERSION, digest.digest('hex')]).toEqual([10, 'd91220556707b6764c4d32797c3403177e60331e782673f1fd97b3a96d096783']);
  });
});

describe('unreadable fault history', () => {
  const faultsFile = (dir: string): string => join(dir, 'faults.jsonl');
  const good = (epoch: string): string => JSON.stringify({ ts: new Date(NOW.getTime() - DAY).toISOString(), kind: 'child_exit', detail: 'code=1 signal=none', epoch_id: epoch }) + '\n';

  test('only an unfinished final line is tolerated; any malformed complete line or record makes child health absent', () => {
    const { dir, epoch } = epochDir();
    writeFileSync(faultsFile(dir), good(epoch) + good(epoch));
    expect(status(dir).child).toEqual({ panics: 0, faults: 2 });
    appendFileSync(faultsFile(dir), '{"ts":"2026-11-29T00:00:00.000Z","ki'); // a writer died mid-line
    expect(status(dir).child).toEqual({ panics: 0, faults: 2 });
    for (const bad of ['not json\n', '{}\n', '[]\n', 'null\n', '{"ts":"x","kind":5}\n', JSON.stringify({ ts: 'x', kind: 'child_exit', epoch_id: 7 }) + '\n']) {
      writeFileSync(faultsFile(dir), good(epoch) + bad + good(epoch));
      expect([bad, status(dir).child]).toEqual([bad, undefined]);
      writeFileSync(faultsFile(dir), good(epoch) + bad); // a malformed COMPLETE final line is not an unfinished one
      expect([bad, status(dir).child]).toEqual([bad, undefined]);
    }
    expect(status(dir).reads).toBeUndefined(); // no ledger rows were written here, and the child field alone is what went missing
    const doc = { epoch_id: epoch, epoch_started_at: STARTED_ISO, ...status(dir) };
    const verdict = evaluateReadiness(doc, NOW).criteria.find((c) => c.n === 9)!;
    expect(verdict.state).toBe('missing');
  });
});

const STARTED_ISO = new Date(STARTED).toISOString();

describe('follower readiness inputs are reported only for the current epoch', () => {
  const SEED = { version: 1, seed_id: 'seed-1', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:01:00.000Z', unseeded_gap_rows_total: 0, unseeded_gap_rows: {}, relations: {}, digests: true } as unknown as SeedRecord;
  const STATE = { version: SHADOW_STATE_VERSION, enabled: true, started_at: 'x', sample_rate: 0.1, queue_bound: 1, plan_hash: 'h', brain: 'b', primary_engine: 'pglite' };
  const AT = new Date(NOW.getTime());
  function follower(dir: string, tag: string | null | undefined): void {
    writeSeedRecord(dir, SEED);
    const lag: number[] = []; lag[3] = 100;
    writeFileSync(join(dir, 'follower.json'), JSON.stringify({
      version: 1, epoch_id: 'seed-1', seed_id: 'seed-1', ...(tag === undefined ? {} : { evidence_epoch: tag }), epoch_started_at: 't', updated_at: AT.toISOString(), applied_rows: 12, queue_depth: 0, lag_ms: 0, last_seq: 1,
      watermark: { valid: true, through: AT.toISOString(), invalidated_reason: null }, lag: { epoch: lag, hours: { [String(Math.floor(AT.getTime() / 3_600_000))]: lag } },
      fingerprints: { checked_rows: 50, mismatches: 1 }, probe: { state: 'pass', checked_at: 't', server_version: '16', collation: 'C', mismatches: 0 }, allocators: { verified: true, checked_at: 't' },
    }));
  }
  const pass = (dir: string, over: Record<string, unknown> = {}) => appendPass(dir, {
    id: 'p', kind: 'full', started_at: new Date(NOW.getTime() - 3_600_000).toISOString(), finished_at: new Date(NOW.getTime() - 3_000_000).toISOString(), repaired_rows: 0, repaired_by_relation: {}, follower_misses: 0, ...over,
  } as never);

  test('probe, fingerprints, allocators and lag count when tagged with the manifest epoch, and not otherwise', () => {
    const { dir, epoch } = epochDir();
    follower(dir, epoch);
    const ok = buildFollowStatus(dir, STATE as never, AT);
    expect(ok.fingerprints).toMatchObject({ checked_rows: 50, mismatches: 1, probe: { state: 'pass' } });
    expect(ok.allocators.verified).toBe(true);
    expect(ok.follower.lag_ms_p99_epoch).toBe(8);
    expect(ok.follower.lag_ms_p99_24h).toBe(8);
    for (const tag of ['an-older-epoch', null, undefined]) {
      follower(dir, tag);
      const other = buildFollowStatus(dir, STATE as never, AT);
      expect([tag, other.fingerprints, other.allocators, other.follower.lag_ms_p99_epoch, other.follower.lag_ms_p99_24h]).toEqual([
        tag, { checked_rows: 0, mismatches: 0, probe: NOT_RUN_PROBE }, { verified: false, checked_at: null }, null, null,
      ]);
      expect(other.follower).toMatchObject({ applied_rows: 12, state: 'following' }); // the Rust store's state is the seed's, not the epoch's
    }
    // After a rotation the manifest names a new epoch: the same file no longer counts.
    follower(dir, epoch);
    ensureEpoch(dir, { ...INPUTS, rust_addon_sha256: 'f'.repeat(64) }, STARTED + DAY);
    expect(buildFollowStatus(dir, STATE as never, AT).fingerprints.probe.state).toBe('not_run');
  });

  test('a reconcile pass counts only if it started and finished under the current epoch', () => {
    const { dir, epoch } = epochDir();
    follower(dir, epoch);
    pass(dir, { id: 'older', epoch_id: 'an-older-epoch' });
    pass(dir, { id: 'legacy' }); // appendPass tags it with the current epoch...
    const legacy = readFileSync(join(dir, 'reconcile', 'passes.jsonl'), 'utf8');
    expect(JSON.parse(legacy.trim().split('\n')[1]!).epoch_id).toBe(epoch); // ...so this one does count
    pass(dir, { id: 'before-epoch', started_at: new Date(STARTED - 1_000).toISOString() });
    appendFileSync(join(dir, 'reconcile', 'passes.jsonl'), JSON.stringify({ id: 'untagged', kind: 'full', started_at: new Date(NOW.getTime() - 1_000).toISOString(), finished_at: NOW.toISOString(), repaired_rows: 0, repaired_by_relation: {}, follower_misses: 0 }) + '\n');
    const s = buildFollowStatus(dir, STATE as never, AT).reconcile;
    expect(s.consecutive_clean_full_passes).toBe(1); // only 'legacy' (now tagged) qualifies
    expect(s.last_pass).toMatchObject({ id: 'legacy' });
    ensureEpoch(dir, { ...INPUTS, comparator_version: 9 }, STARTED + DAY);
    expect(buildFollowStatus(dir, STATE as never, AT).reconcile).toMatchObject({ state: 'never_run', consecutive_clean_full_passes: 0, last_pass: null, next_full_pass_due: null });
  });

  test('with no epoch yet nothing is filtered and the status carries no epoch', () => {
    const dir = tmp();
    follower(dir, undefined);
    const s = buildFollowStatus(dir, STATE as never, AT);
    expect(s.epoch_id).toBeNull();
    expect(s.fingerprints.probe.state).toBe('pass');
  });
});
