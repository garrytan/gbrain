#!/usr/bin/env bun
/**
 * Executed-test identity ledger (X2).
 *
 * Reads the receipts every CI lane writes (scripts/lib/test-env.sh
 * `receipts_init`: one `<id>.receipt` + `<id>.files` + Bun JUnit report per bun
 * invocation; verify writes one testcase per check) and accounts for every
 * executed test by identity: (lane, file, test name, backend arm). Each
 * identity also carries the database backend its name pins (`testBackend`):
 * a test registered per backend (`testBackends()`) names it, and a move of
 * such a test may change arm, because the backend, not the lane's arm, is
 * what it exercises.
 *
 * One side (head only) prints the per-lane executed/skipped/failed table and
 * every completeness problem. Two sides (base and head) also list each base
 * identity that no longer executes in head. A drop passes only when
 * docs/test-audit/2026-10-04/expected-deltas.tsv declares it (retirement,
 * move, pass-to-skip); otherwise the tool prints the exact row to declare it.
 * New tests need no declaration.
 *
 * Completeness (any problem means `incomplete`, which fails):
 *   - an assigned file with no valid JUnit from any attempt (a killed shard
 *     that no rescue re-ran, a truncated report); a later attempt (rerun or
 *     rescue) supersedes an earlier one for the files it re-ran;
 *   - a receipt from an earlier run attempt than the run's latest;
 *   - a missing shard, a lane that executed zero tests (unless the lane was
 *     declared empty), or a base artifact missing from head without a
 *     `job` row.
 *
 * Usage:
 *   bun scripts/ci-executed-counts.ts --head-run <id>[,<id>] [--base-run <id>[,<id>]]
 *   bun scripts/ci-executed-counts.ts --head-dir <dir> [--base-dir <dir>]
 * Options: --deltas <tsv>, --summary <file> (appends Markdown, e.g. the step
 * summary), --json <file>, --report-only (always exit 0), --fail-on-additions
 * (stability check between baseline runs), --expect-attempt <run>:<n>,
 * --missing-keys K1,K2 (count skipped tests in files that read those keys),
 * --repo owner/name.
 * Exit: 0 pass, 1 drop/incomplete, 2 usage or download error.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, appendFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

export const DEFAULT_DELTAS = 'docs/test-audit/2026-10-04/expected-deltas.tsv';
const DOCS = 'Docs: docs/TESTING.md#executed-test-receipts';

export type Status = 'pass' | 'fail' | 'skip' | 'todo';
export interface TestCase { file: string; test: string; status: Status }

export class JUnitError extends Error {}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ref] ?? whole;
  });
}

/** Unstable fragments (temp paths, UUIDs) must not split one test into two identities. Timestamps stay: test names use fixed dates on purpose. */
export function canonicalTestName(name: string): string {
  return name
    .replace(/\/(?:private\/)?(?:tmp|var\/folders)\/[^\s'"`),]+/g, '<tmp>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>');
}

/**
 * Strict parser for the JUnit subset Bun (and run-verify-parallel.sh) writes.
 * Anything malformed or cut short throws: a truncated report is never read as
 * a shorter test list.
 */
export function parseJUnit(xml: string): TestCase[] {
  const token = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>|[^<]+/y;
  const attrRe = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  const stack: { tag: string; attrs: Record<string, string> }[] = [];
  const cases: TestCase[] = [];
  let current: { file: string; test: string; status: Status } | undefined;
  let rootTests: number | undefined;
  let closedRoot = false;
  const open = (tag: string, attrs: Record<string, string>) => {
    if (tag === 'testcase') {
      const suites = stack.filter(s => s.tag === 'testsuite');
      const file = suites[0]?.attrs.file ?? attrs.file ?? suites[0]?.attrs.name ?? '';
      const describe = suites.slice(1).map(s => s.attrs.name ?? '');
      if (!attrs.name) throw new JUnitError('testcase without a name');
      current = { file, test: [...describe, attrs.name].join(' > '), status: 'pass' };
    } else if (current && tag === 'skipped') {
      if (current.status !== 'fail') current.status = attrs.message === 'TODO' ? 'todo' : 'skip';
    } else if (current && (tag === 'failure' || tag === 'error')) {
      current.status = 'fail';
    }
  };
  const close = (tag: string) => {
    if (tag === 'testcase' && current) {
      cases.push({ ...current, test: canonicalTestName(current.test) });
      current = undefined;
    }
    if (tag === 'testsuites' && stack.length === 0) closedRoot = true;
  };
  let index = 0;
  while (index < xml.length) {
    token.lastIndex = index;
    const match = token.exec(xml);
    if (!match) throw new JUnitError(`malformed or truncated report near byte ${index}`);
    index = token.lastIndex;
    const [whole, slash, tag, rawAttrs, selfClose] = match;
    if (!tag) {
      if (whole.startsWith('<') || stack.length || closedRoot || !whole.trim()) continue;
      throw new JUnitError('text outside the report root');
    }
    if (closedRoot) throw new JUnitError('content after the closing </testsuites>');
    if (slash) {
      const top = stack.pop();
      if (!top || top.tag !== tag) throw new JUnitError(`unbalanced </${tag}>`);
      close(tag);
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of (rawAttrs ?? '').matchAll(attrRe)) attrs[a[1]] = decode(a[2]);
    if (stack.length === 0) {
      if (tag !== 'testsuites') throw new JUnitError(`report root is <${tag}>, expected <testsuites>`);
      if (attrs.tests !== undefined) rootTests = Number(attrs.tests);
    }
    open(tag, attrs);
    if (selfClose) close(tag);
    else stack.push({ tag, attrs });
  }
  if (!closedRoot || stack.length) throw new JUnitError('report ends before </testsuites> (truncated)');
  if (rootTests !== undefined && rootTests !== cases.length) {
    throw new JUnitError(`report declares ${rootTests} tests but lists ${cases.length}`);
  }
  return cases;
}

const RANK: Record<string, number> = { primary: 0, rerun: 1, rescue: 2 };

export interface Receipt {
  id: string;
  artifact: string;
  lane: string;
  kind: string;
  shard?: number;
  of?: number;
  arm: string;
  runId: string;
  runAttempt?: number;
  sha: string;
  started: number;
  exit?: number;
  empty: boolean;
  declaredEmpty: boolean;
  files: string[];
  junit: 'ok' | 'missing' | 'truncated' | 'not-expected';
  junitError?: string;
  cases: TestCase[];
}

function normalizePath(path: string, root: string): string {
  let p = path.trim();
  if (root && p.startsWith(`${root}/`)) p = p.slice(root.length + 1);
  return p.replace(/^\.\//, '');
}

function readMeta(text: string): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) meta[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return meta;
}

const optionalInt = (value: string | undefined): number | undefined =>
  value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;

export function loadReceipt(dir: string, id: string, artifact: string): Receipt {
  const meta = readMeta(readFileSync(join(dir, `${id}.receipt`), 'utf8'));
  const root = meta.root ?? '';
  const filesPath = join(dir, `${id}.files`);
  const files = existsSync(filesPath)
    ? readFileSync(filesPath, 'utf8').split('\n').filter(Boolean).map(f => normalizePath(f, root))
    : [];
  const empty = meta.empty === '1' || meta.declared_empty === '1';
  const receipt: Receipt = {
    id, artifact, files, empty,
    lane: meta.lane || 'unknown',
    kind: meta.kind || 'primary',
    shard: optionalInt(meta.shard),
    of: optionalInt(meta.of),
    arm: meta.arm ?? '',
    runId: meta.run_id ?? '',
    runAttempt: optionalInt(meta.run_attempt),
    sha: meta.sha ?? '',
    started: optionalInt(meta.started) ?? 0,
    exit: optionalInt(meta.exit),
    declaredEmpty: meta.declared_empty === '1',
    junit: empty ? 'not-expected' : 'missing',
    cases: [],
  };
  const junitPath = join(dir, `${id}.junit.xml`);
  if (!empty && existsSync(junitPath)) {
    try {
      receipt.cases = parseJUnit(readFileSync(junitPath, 'utf8')).map(c => ({ ...c, file: normalizePath(c.file, root) }));
      receipt.junit = 'ok';
    } catch (error) {
      receipt.junit = 'truncated';
      receipt.junitError = error instanceof Error ? error.message : String(error);
    }
  }
  return receipt;
}

/** A directory of receipts is one artifact; a directory of such directories is several. */
export function loadReceiptDir(dir: string): Receipt[] {
  const ids = (d: string) => readdirSync(d).filter(n => n.endsWith('.receipt')).map(n => n.slice(0, -'.receipt'.length)).sort();
  const own = ids(dir);
  if (own.length) return own.map(id => loadReceipt(dir, id, basename(dir)));
  const receipts: Receipt[] = [];
  for (const name of readdirSync(dir).sort()) {
    const sub = join(dir, name);
    if (!statSync(sub).isDirectory()) continue;
    for (const id of ids(sub)) receipts.push(loadReceipt(sub, id, name));
  }
  return receipts;
}

export interface Identity { lane: string; file: string; test: string; arm: string; backend: TestBackend; status: Status; artifact: string; kind: string }
export interface Issue { kind: string; lane?: string; artifact?: string; file?: string; detail: string }
export interface LaneStats { lane: string; files: number; executed: number; passed: number; failed: number; skipped: number; superseded: number; declaredEmpty: boolean }
export interface Side {
  label: string;
  artifacts: Set<string>;
  identities: Map<string, Identity>;
  issues: Issue[];
  duplicates: { key: string; count: number }[];
  overlaps: string[];
  lanes: Map<string, LaneStats>;
  shas: Set<string>;
}

export const identityKey = (lane: string, file: string, test: string, arm: string) => [lane, file, test, arm].join('\u001f');

/**
 * The database backend a test name pins: `pglite` or `postgres` when its
 * top-level describe names exactly one of them as a word (testBackends()
 * suites prefix or suffix it, e.g. "postgres: semantic writes …" or "…
 * (pglite)"), else when the whole name does; otherwise '' (the name does not
 * say, or names both). A hyphenated compound such as postgres-unit-arms is
 * not a backend.
 */
export type TestBackend = 'pglite' | 'postgres' | '';
export function testBackend(test: string): TestBackend {
  const pins = (text: string): TestBackend => {
    const pglite = /(?<![\w-])pglite(?![\w-])/i.test(text);
    const postgres = /(?<![\w-])postgres(?:ql)?(?![\w-])/i.test(text);
    return pglite === postgres ? '' : pglite ? 'pglite' : 'postgres';
  };
  return pins(test.split(' > ')[0]!) || pins(test);
}
const executed = (status: Status | undefined) => status === 'pass' || status === 'fail';

function describeAttempt(r: Receipt): string {
  const state = r.junit === 'truncated' ? `truncated JUnit (${r.junitError})` : r.junit === 'missing' ? 'no JUnit report' : r.junit;
  return `${r.artifact}/${r.id} [${r.kind}${r.exit === undefined ? ', interrupted' : `, exit ${r.exit}`}]: ${state}`;
}

export function buildSide(label: string, all: Receipt[], expectedAttempts = new Map<string, number>()): Side {
  const side: Side = { label, artifacts: new Set(all.map(r => r.artifact)), identities: new Map(), issues: [], duplicates: [], overlaps: [], lanes: new Map(), shas: new Set() };
  const latest = new Map(expectedAttempts);
  for (const r of all) {
    if (r.runId && r.runAttempt !== undefined && r.runAttempt > (latest.get(r.runId) ?? 0)) latest.set(r.runId, r.runAttempt);
  }
  const receipts = all.filter(r => {
    const want = r.runId ? latest.get(r.runId) : undefined;
    if (want !== undefined && r.runAttempt !== undefined && r.runAttempt < want) {
      side.issues.push({ kind: 'prior-attempt', lane: r.lane, artifact: r.artifact, detail: `${r.artifact}/${r.id} comes from attempt ${r.runAttempt} of run ${r.runId}; the run's latest attempt is ${want}. Re-run all jobs, not only failed ones, so every lane reports from one attempt.` });
      return false;
    }
    if (r.sha) side.shas.add(r.sha);
    return true;
  });
  const byLane = new Map<string, Receipt[]>();
  for (const r of receipts) byLane.set(r.lane, [...(byLane.get(r.lane) ?? []), r]);
  const duplicateCounts = new Map<string, number>();
  for (const [lane, laneReceipts] of [...byLane].sort(([a], [b]) => a.localeCompare(b))) {
    const stats: LaneStats = { lane, files: 0, executed: 0, passed: 0, failed: 0, skipped: 0, superseded: 0, declaredEmpty: laneReceipts.some(r => r.declaredEmpty) };
    side.lanes.set(lane, stats);
    const sharded = laneReceipts.filter(r => r.of !== undefined);
    const ofs = new Set(sharded.map(r => r.of));
    if (ofs.size > 1) side.issues.push({ kind: 'missing-shard', lane, detail: `lane ${lane} mixes shard totals (${[...ofs].join(', ')})` });
    for (const of of ofs) {
      const present = new Set(sharded.filter(r => r.of === of).map(r => r.shard));
      for (let shard = 1; shard <= (of ?? 0); shard++) {
        if (!present.has(shard)) side.issues.push({ kind: 'missing-shard', lane, detail: `lane ${lane}: shard ${shard} of ${of} left no receipt (its job did not run, or its "Upload receipts" step found nothing)` });
      }
    }
    const byFile = new Map<string, Receipt[]>();
    for (const r of laneReceipts) {
      if (r.empty) continue;
      const files = new Set([...r.files, ...r.cases.map(c => c.file)]);
      for (const file of files) {
        const key = `${file}\u001f${r.arm}`;
        byFile.set(key, [...(byFile.get(key) ?? []), r]);
      }
    }
    stats.files = new Set([...byFile.keys()].map(k => k.split('\u001f')[0])).size;
    for (const [fileArm, attempts] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
      const [file, arm] = fileArm.split('\u001f');
      const where = arm ? `${file} [${arm}]` : file;
      const valid = attempts.filter(r => r.junit === 'ok');
      if (!valid.length) {
        side.issues.push({ kind: 'incomplete', lane, file, artifact: attempts[0].artifact, detail: `lane ${lane}: ${where} has no valid receipt from any attempt (${attempts.map(describeAttempt).join('; ')})` });
        continue;
      }
      const primaries = valid.filter(r => (RANK[r.kind] ?? 0) === 0);
      if (primaries.length > 1) side.overlaps.push(`lane ${lane}: ${where} ran in ${primaries.length} primary invocations (${primaries.map(r => `${r.artifact}/${r.id}`).join(', ')})`);
      const winner = valid.reduce((best, r) => {
        const order = (x: Receipt) => [RANK[x.kind] ?? 0, x.started];
        const [br, bs] = order(best);
        const [rr, rs] = order(r);
        return rr > br || (rr === br && (rs > bs || (rs === bs && r.id > best.id))) ? r : best;
      });
      if ((RANK[winner.kind] ?? 0) > 0) stats.superseded++;
      // Repeated names inside one file (Bun's JUnit keeps test.each titles as
      // the unformatted "%s" template) stay distinct by occurrence order.
      const seen = new Map<string, number>();
      for (const c of winner.cases) {
        if (c.file !== file) continue;
        const n = (seen.get(c.test) ?? 0) + 1;
        seen.set(c.test, n);
        const test = n === 1 ? c.test : `${c.test} [#${n}]`;
        if (n > 1) duplicateCounts.set(identityKey(lane, file, c.test, winner.arm), n);
        side.identities.set(identityKey(lane, file, test, winner.arm), { lane, file, test, arm: winner.arm, backend: testBackend(c.test), status: c.status, artifact: winner.artifact, kind: winner.kind });
      }
    }
  }
  for (const id of side.identities.values()) {
    const stats = side.lanes.get(id.lane)!;
    if (id.status === 'pass') stats.passed++;
    else if (id.status === 'fail') stats.failed++;
    else stats.skipped++;
    if (executed(id.status)) stats.executed++;
  }
  for (const stats of side.lanes.values()) {
    if (stats.executed === 0 && !stats.declaredEmpty && stats.files > 0) {
      side.issues.push({ kind: 'empty-lane', lane: stats.lane, detail: `lane ${stats.lane} executed 0 tests across ${stats.files} file(s)` });
    }
  }
  side.duplicates = [...duplicateCounts].map(([key, count]) => ({ key, count }));
  return side;
}

export type DeltaKind = 'retire' | 'move' | 'skip' | 'job';
export interface DeltaRow { line: number; kind: DeltaKind; lane: string; file: string; test: string; arm: string; newLane: string; newFile: string; newTest: string; reason: string; evidence: string }
export const DELTA_COLUMNS = ['kind', 'lane', 'file', 'test', 'arm', 'new_lane', 'new_file', 'new_test', 'reason', 'evidence'];

const unescapeField = (value: string) => value.replace(/\\(t|n|\\)/g, (_, c: string) => (c === 't' ? '\t' : c === 'n' ? '\n' : '\\'));
export const escapeField = (value: string) => value.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n');
const isTodo = (value: string) => !value.trim() || /^TODO\b/i.test(value.trim());

export function parseDeltas(text: string): { rows: DeltaRow[]; errors: string[] } {
  const rows: DeltaRow[] = [];
  const errors: string[] = [];
  let header = false;
  text.split('\n').forEach((raw, i) => {
    const line = i + 1;
    if (!raw.trim() || raw.startsWith('#')) return;
    const cells = raw.split('\t');
    if (!header) {
      if (cells.join('\t') !== DELTA_COLUMNS.join('\t')) errors.push(`line ${line}: header must be ${DELTA_COLUMNS.join(' ')}`);
      header = true;
      return;
    }
    if (cells.length !== DELTA_COLUMNS.length) {
      errors.push(`line ${line}: ${cells.length} columns, expected ${DELTA_COLUMNS.length} (tab-separated)`);
      return;
    }
    const [kind, lane, file, test, arm, newLane, newFile, newTest, reason, evidence] = cells.map(unescapeField);
    const row: DeltaRow = { line, kind: kind as DeltaKind, lane, file, test, arm, newLane, newFile, newTest, reason, evidence };
    if (!['retire', 'move', 'skip', 'job'].includes(kind)) errors.push(`line ${line}: kind "${kind}" is not retire, move, skip or job`);
    else if (isTodo(reason)) errors.push(`line ${line}: reason is empty or still TODO`);
    else if (kind === 'job' ? !lane : !lane || lane === '*' || !file || file === '*' || !test) errors.push(`line ${line}: ${kind === 'job' ? 'job rows name the artifact in the lane column' : 'lane and file must be exact; test is a name or *'}`);
    else if (kind === 'retire' && isTodo(evidence)) errors.push(`line ${line}: a retirement needs its Retiring-a-test evidence (docs/test-audit/.../implementation/<lane>.md#...)`);
    else if (kind === 'move' && !newLane && !newFile && !newTest) errors.push(`line ${line}: a move names new_lane, new_file or new_test`);
    else rows.push(row);
  });
  if (!header && text.trim()) errors.push('missing header row');
  return { rows, errors };
}

function globMatch(pattern: string, value: string): boolean {
  const parts = pattern.split('*');
  if (parts.length === 1) return pattern === value;
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!value.startsWith(first) || value.length < first.length + last.length || !value.endsWith(last)) return false;
  let at = first.length;
  const end = value.length - last.length;
  for (const part of parts.slice(1, -1)) {
    const found = value.indexOf(part, at);
    if (found === -1 || found + part.length > end) return false;
    at = found + part.length;
  }
  return true;
}

function rowMatches(row: DeltaRow, id: Identity): boolean {
  return row.kind !== 'job' && row.lane === id.lane && row.file === id.file
    && (row.test === '*' || row.test === id.test) && (row.arm === '*' || row.arm === id.arm);
}

export interface Drop { identity: Identity; head: Status | 'absent'; verdict: 'undeclared' | 'retired' | 'moved' | 'skipped' | 'lane-declared-empty' | 'move-target-missing' | 'skip-mismatch'; row?: DeltaRow; detail?: string }
export interface Comparison {
  ok: boolean;
  base?: Side;
  head: Side;
  drops: Drop[];
  additions: Identity[];
  issues: Issue[];
  deltaErrors: string[];
  unusedRows: DeltaRow[];
  suggestions: string[];
}

export function deltaRow(kind: DeltaKind, id: Pick<Identity, 'lane' | 'file' | 'test' | 'arm'>, target: { lane?: string; file?: string; test?: string } = {}): string {
  const evidence = kind === 'retire' ? 'TODO: docs/test-audit/2026-10-04/implementation/<lane>.md#<retiring-a-test row>' : '';
  return [kind, id.lane, id.file, id.test, id.arm, target.lane ?? '', target.file ?? '', target.test ?? '', 'TODO: why this test no longer runs here', evidence].map(escapeField).join('\t');
}

export function compare(head: Side, base: Side | undefined, deltas: { rows: DeltaRow[]; errors: string[] }, opts: { failOnAdditions?: boolean } = {}): Comparison {
  const result: Comparison = { ok: true, base, head, drops: [], additions: [], issues: [...(base?.issues.map(i => ({ ...i, detail: `base: ${i.detail}` })) ?? []), ...head.issues.map(i => ({ ...i, detail: base ? `head: ${i.detail}` : i.detail }))], deltaErrors: deltas.errors, unusedRows: [], suggestions: [] };
  const used = new Set<DeltaRow>();
  const headAt = new Map<string, Identity[]>();
  for (const h of head.identities.values()) {
    const at = identityKey(h.lane, h.file, h.test, '');
    headAt.set(at, [...(headAt.get(at) ?? []), h]);
  }
  const sideOf = (detail: string) => (base && detail.startsWith('base: ') ? base : head);
  result.issues = result.issues.filter(issue => {
    if (issue.kind !== 'empty-lane') return true;
    const ids = [...sideOf(issue.detail).identities.values()].filter(id => id.lane === issue.lane);
    const rows = ids.map(id => deltas.rows.find(r => r.kind === 'skip' && r.lane === id.lane && r.file === id.file && r.test === '*'));
    if (!ids.length || rows.some(r => !r)) return true;
    for (const r of rows) used.add(r!);
    return false;
  });
  if (base) {
    for (const artifact of base.artifacts) {
      if (head.artifacts.has(artifact)) continue;
      const row = deltas.rows.find(r => r.kind === 'job' && globMatch(r.lane, artifact));
      if (row) used.add(row);
      else result.issues.push({ kind: 'missing-artifact', artifact, detail: `artifact ${artifact} is in base but not in head: its job did not run or uploaded nothing. Declare a removed or renamed job with a "job" row naming the artifact.` });
    }
    for (const id of base.identities.values()) {
      if (!executed(id.status)) continue;
      const now = head.identities.get(identityKey(id.lane, id.file, id.test, id.arm));
      if (executed(now?.status)) continue;
      const drop: Drop = { identity: id, head: now?.status ?? 'absent', verdict: 'undeclared' };
      const row = deltas.rows.find(r => rowMatches(r, id));
      if (row) {
        used.add(row);
        drop.row = row;
        if (row.kind === 'retire') drop.verdict = 'retired';
        else if (row.kind === 'skip') drop.verdict = now && !executed(now.status) ? 'skipped' : 'skip-mismatch';
        else {
          const [lane, file, test] = [row.newLane || id.lane, row.newFile || id.file, row.test === '*' ? id.test : row.newTest || id.test];
          drop.verdict = (headAt.get(identityKey(lane, file, test, '')) ?? []).some(h => movedTo(id, h)) ? 'moved' : 'move-target-missing';
          if (drop.verdict === 'move-target-missing') drop.detail = `declared move target ${[lane, file, test, id.arm].join(' | ')} did not execute in head${id.backend ? ` under any arm on the ${id.backend} backend` : ''}`;
        }
      } else if (head.lanes.get(id.lane)?.declaredEmpty) {
        drop.verdict = 'lane-declared-empty';
      }
      result.drops.push(drop);
    }
    const baseExecuted = new Set([...base.identities].filter(([, id]) => executed(id.status)).map(([key]) => key));
    result.additions = [...head.identities].filter(([key, id]) => executed(id.status) && !baseExecuted.has(key)).map(([, id]) => id);
    result.suggestions = suggestRows(result.drops.filter(d => d.verdict === 'undeclared'), base, head);
  }
  result.unusedRows = deltas.rows.filter(r => !used.has(r));
  const failing = result.drops.some(d => d.verdict === 'undeclared' || d.verdict === 'move-target-missing' || d.verdict === 'skip-mismatch');
  result.ok = !failing && !result.issues.length && !result.deltaErrors.length && !(opts.failOnAdditions && result.additions.length);
  return result;
}

/**
 * Whether head identity `to` executes what base identity `from` did: the same
 * arm, or another arm when the test's name pins its backend. A PostgreSQL-arm
 * cell run with --postgres-only runs only the PostgreSQL side of testBackends()
 * suites, so their PGLite tests leave that lane (arm postgres) for the unit and serial
 * lanes (no arm) and still run on PGLite there. A PostgreSQL test may change
 * arm only to another database arm: a lane with no arm has no database.
 */
const movedTo = (from: Identity, to: Identity) =>
  executed(to.status) && (to.arm === from.arm
    || (from.backend !== '' && to.backend === from.backend && (from.backend === 'pglite' || to.arm !== '')));

/** The exact TSV rows that would declare each undeclared drop: a move when the test runs elsewhere in head, else a retirement. */
export function suggestRows(drops: Drop[], base: Side, head: Side): string[] {
  const rows: string[] = [];
  const headByTest = new Map<string, Identity[]>();
  for (const id of head.identities.values()) if (executed(id.status)) headByTest.set(id.test, [...(headByTest.get(id.test) ?? []), id]);
  const groups = new Map<string, Drop[]>();
  for (const d of drops) {
    const key = [d.identity.lane, d.identity.file, d.identity.arm].join('\u001f');
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  for (const group of groups.values()) {
    const { lane, file, arm } = group[0].identity;
    const baseExecuted = [...base.identities.values()].filter(id => id.lane === lane && id.file === file && id.arm === arm && executed(id.status)).length;
    const headFileRuns = [...head.identities.values()].some(id => id.lane === lane && id.file === file && id.arm === arm && executed(id.status));
    const elsewhere = (d: Drop) => (headByTest.get(d.identity.test) ?? []).find(h => (h.lane !== lane || h.file !== file) && movedTo(d.identity, h));
    const backend = group[0].identity.backend;
    const backendBase = [...base.identities.values()].filter(id => id.lane === lane && id.file === file && id.arm === arm && id.backend === backend && executed(id.status)).length;
    const targets = new Set(group.map(d => { const h = elsewhere(d); return h ? `${h.lane}\u001f${h.file}` : ''; }));
    if (backend && group.length > 1 && group.length === backendBase && group.every(d => d.identity.backend === backend) && targets.size === 1 && !targets.has('')) {
      const [newLane, newFile] = [...targets][0]!.split('\u001f');
      rows.push(deltaRow('move', { lane, file, test: '*', arm }, { lane: newLane === lane ? '' : newLane, file: newFile === file ? '' : newFile }));
      continue;
    }
    if (group.length === baseExecuted && !headFileRuns && group.length > 1) {
      const votes = new Map<string, number>();
      for (const d of group) {
        const h = elsewhere(d);
        if (h) votes.set(`${h.lane}\u001f${h.file}`, (votes.get(`${h.lane}\u001f${h.file}`) ?? 0) + 1);
      }
      const best = [...votes].sort((a, b) => b[1] - a[1])[0];
      if (best && best[1] * 2 >= group.length) {
        const [newLane, newFile] = best[0].split('\u001f');
        rows.push(deltaRow('move', { lane, file, test: '*', arm }, { lane: newLane === lane ? '' : newLane, file: newFile === file ? '' : newFile }));
      } else {
        rows.push(deltaRow('retire', { lane, file, test: '*', arm }));
      }
      continue;
    }
    for (const d of group) {
      const h = elsewhere(d);
      if (h) rows.push(deltaRow('move', d.identity, { lane: h.lane === lane ? '' : h.lane, file: h.file === file ? '' : h.file }));
      else if (d.head === 'skip' || d.head === 'todo') rows.push(deltaRow('skip', d.identity));
      else rows.push(deltaRow('retire', d.identity));
    }
  }
  return rows;
}

/** A9: skipped tests in files that read a provider key the run did not have. */
export function missingKeySkips(head: Side, keys: string[], root = '.'): { tests: number; files: string[] } {
  const files = new Map<string, number>();
  const reads = new Map<string, boolean>();
  for (const id of head.identities.values()) {
    if (executed(id.status) || id.file === 'verify') continue;
    if (!reads.has(id.file)) {
      let source = '';
      try { source = readFileSync(join(root, id.file), 'utf8'); } catch { /* deleted or out-of-tree file */ }
      reads.set(id.file, keys.some(k => source.includes(k)));
    }
    if (reads.get(id.file)) files.set(id.file, (files.get(id.file) ?? 0) + 1);
  }
  return { tests: [...files.values()].reduce((a, b) => a + b, 0), files: [...files.keys()].sort() };
}

const md = (value: string, max = 160) => {
  const text = value.length > max ? `${value.slice(0, max - 1)}…` : value;
  return text.replace(/[\r\n]+/g, ' ').replace(/([|`*_<>[\]\\])/g, '\\$1').replace(/@/g, '@\u200b');
};
const LIST_CAP = 200;

export function render(result: Comparison, extra: string[] = []): string {
  const out: string[] = [];
  const { base, head } = result;
  const verdict = result.ok ? 'PASS' : result.issues.length ? 'INCOMPLETE (fails)' : 'FAIL';
  out.push('## Executed-test identities (X2)', '');
  out.push(base ? `Base: ${md(base.label)} · Head: ${md(head.label)} · **${verdict}**` : `Head: ${md(head.label)} · **${verdict}**`, '');
  const lanes = [...new Set([...(base?.lanes.keys() ?? []), ...head.lanes.keys()])].sort();
  if (base) {
    out.push('| Lane | Base executed | Head executed | Head skipped | Head failed | Undeclared drops | Declared drops | Added |', '|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const lane of lanes) {
      const b = base.lanes.get(lane);
      const h = head.lanes.get(lane);
      const drops = result.drops.filter(d => d.identity.lane === lane);
      const bad = drops.filter(d => d.verdict === 'undeclared' || d.verdict === 'move-target-missing' || d.verdict === 'skip-mismatch').length;
      out.push(`| ${md(lane)} | ${b?.executed ?? 0} | ${h?.executed ?? 0} | ${h?.skipped ?? 0} | ${h?.failed ?? 0} | ${bad} | ${drops.length - bad} | ${result.additions.filter(a => a.lane === lane).length} |`);
    }
  } else {
    out.push('| Lane | Files | Executed | Passed | Failed | Skipped | Superseded by rerun/rescue |', '|---|---:|---:|---:|---:|---:|---:|');
    for (const lane of lanes) {
      const h = head.lanes.get(lane)!;
      out.push(`| ${md(lane)}${h.declaredEmpty ? ' (declared empty)' : ''} | ${h.files} | ${h.executed} | ${h.passed} | ${h.failed} | ${h.skipped} | ${h.superseded} |`);
    }
  }
  out.push('');
  const byBackend = lanes.map(lane => {
    const ids = [...head.identities.values()].filter(id => id.lane === lane && executed(id.status));
    return { lane, pglite: ids.filter(id => id.backend === 'pglite').length, postgres: ids.filter(id => id.backend === 'postgres').length, unnamed: ids.filter(id => !id.backend).length };
  }).filter(b => b.pglite || b.postgres);
  if (byBackend.length) {
    out.push('Head executed by backend (the backend a test name pins; testBackends() suites name it):', '', '| Lane | PGLite | PostgreSQL | Name pins none |', '|---|---:|---:|---:|');
    for (const b of byBackend) out.push(`| ${md(b.lane)} | ${b.pglite} | ${b.postgres} | ${b.unnamed} |`);
    out.push('');
  }
  out.push(...extra);
  if (result.issues.length) {
    out.push(`### Incomplete (${result.issues.length})`, '', 'Why: a lane without a complete receipt cannot prove which tests ran, so the comparison fails closed.', 'Fix: rerun every job of the run (not only failed jobs) so each lane uploads a receipt from one attempt; a killed shard needs its rescue or a rerun.', DOCS, '');
    for (const issue of result.issues.slice(0, LIST_CAP)) out.push(`- ${md(issue.detail, 400)}`);
    if (result.issues.length > LIST_CAP) out.push(`- … ${result.issues.length - LIST_CAP} more (see --json)`);
    out.push('');
  }
  if (result.deltaErrors.length) {
    out.push(`### expected-deltas.tsv errors (${result.deltaErrors.length})`, '');
    for (const e of result.deltaErrors) out.push(`- ${md(e, 300)}`);
    out.push('');
  }
  const bad = result.drops.filter(d => d.verdict === 'undeclared' || d.verdict === 'move-target-missing' || d.verdict === 'skip-mismatch');
  if (bad.length) {
    out.push(`### Dropped identities (${bad.length})`, '', 'Why: these base tests no longer execute in head and expected-deltas.tsv does not account for them.', `Fix: restore the tests, or add the rows below to ${DEFAULT_DELTAS} with a real reason (retirements also need their Retiring-a-test evidence).`, DOCS, '');
    for (const d of bad.slice(0, LIST_CAP)) out.push(`- ${md(d.identity.lane)} · ${md(d.identity.file)} · ${md(d.identity.test)}${d.identity.arm ? ` · ${md(d.identity.arm)}` : ''} — head: ${d.head}${d.verdict === 'undeclared' ? '' : ` (${d.verdict}${d.detail ? `: ${md(d.detail, 200)}` : ''})`}`);
    if (bad.length > LIST_CAP) out.push(`- … ${bad.length - LIST_CAP} more (see --json)`);
    if (result.suggestions.length) out.push('', 'Rows to declare them:', '', '```tsv', ...result.suggestions.slice(0, LIST_CAP), '```');
    out.push('');
  }
  const declared = result.drops.length - bad.length;
  if (declared) out.push(`Declared drops: ${declared} (${['retired', 'moved', 'skipped', 'lane-declared-empty'].map(v => `${v} ${result.drops.filter(d => d.verdict === v).length}`).join(', ')}).`, '');
  if (base) out.push(`Added identities (new tests need no declaration): ${result.additions.length}.`, '');
  if (head.overlaps.length) {
    out.push(`Files that ran in more than one primary invocation in head (sharding overlap; the latest attempt counts): ${head.overlaps.length}.`, '');
    for (const o of head.overlaps.slice(0, 20)) out.push(`- ${md(o, 300)}`);
    out.push('');
  }
  if (head.duplicates.length) out.push(`Repeated test names in head (numbered by occurrence, e.g. test.each titles): ${head.duplicates.length}.`, '');
  if (result.unusedRows.length) out.push(`expected-deltas.tsv rows that matched nothing: ${result.unusedRows.map(r => `line ${r.line}`).join(', ')}.`, '');
  if (head.shas.size > 1) out.push(`Head receipts come from ${head.shas.size} commits: ${[...head.shas].map(s => s.slice(0, 12)).join(', ')}.`, '');
  return `${out.join('\n')}\n`;
}

export function toJSON(result: Comparison): unknown {
  const side = (s: Side) => ({ label: s.label, artifacts: [...s.artifacts].sort(), shas: [...s.shas], lanes: [...s.lanes.values()], identities: [...s.identities.values()], duplicates: s.duplicates.length, overlaps: s.overlaps });
  return {
    ok: result.ok,
    base: result.base ? side(result.base) : null,
    head: side(result.head),
    issues: result.issues,
    deltaErrors: result.deltaErrors,
    drops: result.drops.map(d => ({ ...d.identity, head: d.head, verdict: d.verdict, row: d.row?.line, detail: d.detail })),
    additions: result.additions,
    suggestions: result.suggestions,
    unusedRows: result.unusedRows.map(r => r.line),
  };
}

class UsageError extends Error {}

function gh(args: string[]): string {
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    throw new UsageError(`gh ${args.join(' ')} failed: ${(r.stderr || r.error?.message || '').trim()}\nWhy: run artifacts are read through the GitHub CLI.\nFix: gh auth status (a token with actions:read), and check the run id exists in the repo.`);
  }
  return r.stdout;
}

/** Download a run's receipts-* artifacts; returns the receipts and the run's latest attempt. */
export function downloadRun(repo: string, runId: string, into: string): { receipts: Receipt[]; attempt: number; label: string } {
  if (!/^\d+$/.test(runId)) throw new UsageError(`run id "${runId}" is not numeric`);
  const run = JSON.parse(gh(['api', `repos/${repo}/actions/runs/${runId}`, '--jq', '{attempt: .run_attempt, sha: .head_sha, status: .status, name: .name, event: .event}']));
  if (run.status !== 'completed') throw new UsageError(`run ${runId} is ${run.status}\nWhy: a running workflow has not uploaded every receipt yet.\nFix: wait for it to finish (gh run watch ${runId} --repo ${repo}).`);
  const dir = join(into, runId);
  gh(['run', 'download', runId, '--repo', repo, '--pattern', 'receipts-*', '--dir', dir]);
  const receipts = existsSync(dir) ? loadReceiptDir(dir) : [];
  if (!receipts.length) throw new UsageError(`run ${runId} has no receipts-* artifacts\nWhy: the run predates executed-test receipts, or its upload steps did not run.\nFix: re-run the workflow on a commit whose test.yml/e2e.yml upload receipts.`);
  return { receipts, attempt: Number(run.attempt), label: `${run.name} #${runId} (${run.event}, ${String(run.sha).slice(0, 12)}, attempt ${run.attempt})` };
}

interface Args { baseRuns: string[]; headRuns: string[]; baseDirs: string[]; headDirs: string[]; deltas?: string; summary?: string; json?: string; reportOnly: boolean; failOnAdditions: boolean; expect: Map<string, number>; missingKeys?: string[]; repo: string }

export function parseArgs(argv: string[]): Args {
  const args: Args = { baseRuns: [], headRuns: [], baseDirs: [], headDirs: [], reportOnly: false, failOnAdditions: false, expect: new Map(), repo: process.env.GITHUB_REPOSITORY || 'garrytan/gbrain' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
      return v;
    };
    const list = () => value().split(',').map(s => s.trim()).filter(Boolean);
    switch (flag) {
      case '--base-run': args.baseRuns.push(...list()); break;
      case '--head-run': args.headRuns.push(...list()); break;
      case '--base-dir': args.baseDirs.push(value()); break;
      case '--head-dir': args.headDirs.push(value()); break;
      case '--deltas': args.deltas = value(); break;
      case '--summary': args.summary = value(); break;
      case '--json': args.json = value(); break;
      case '--repo': args.repo = value(); break;
      case '--report-only': args.reportOnly = true; break;
      case '--fail-on-additions': args.failOnAdditions = true; break;
      case '--missing-keys': args.missingKeys = list(); break;
      case '--expect-attempt': {
        const m = /^(\d+):(\d+)$/.exec(value());
        if (!m) throw new UsageError('--expect-attempt takes <run-id>:<attempt>');
        args.expect.set(m[1], Number(m[2]));
        break;
      }
      case '--help': case '-h': throw new UsageError('help');
      default: throw new UsageError(`unknown option ${flag}`);
    }
  }
  if (!args.headRuns.length && !args.headDirs.length) throw new UsageError('pass --head-run <id> or --head-dir <dir>');
  return args;
}

function loadSide(runs: string[], dirs: string[], args: Args, into: string): Side | undefined {
  if (!runs.length && !dirs.length) return undefined;
  const receipts: Receipt[] = [];
  const expect = new Map(args.expect);
  const labels: string[] = [];
  for (const run of runs) {
    const got = downloadRun(args.repo, run, into);
    receipts.push(...got.receipts);
    expect.set(run, got.attempt);
    labels.push(got.label);
  }
  for (const dir of dirs) {
    if (!existsSync(dir)) throw new UsageError(`receipt directory ${dir} does not exist`);
    receipts.push(...loadReceiptDir(dir));
    labels.push(dir);
  }
  const seen = new Map<string, string>();
  for (const r of receipts) {
    const key = `${r.artifact}/${r.id}`;
    const source = r.runId || 'local';
    if (seen.has(key) && seen.get(key) !== source) throw new UsageError(`artifact ${r.artifact} appears in two runs of one side; pass one test.yml run and one e2e.yml run per side`);
    seen.set(key, source);
  }
  return buildSide(labels.join(' + '), receipts, expect);
}

export function main(argv: string[]): number {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== 'help') console.error(`ci-executed-counts: ${message}`);
    console.error('usage: bun scripts/ci-executed-counts.ts (--head-run <id>[,<id>] | --head-dir <dir>) [--base-run <id>[,<id>] | --base-dir <dir>] [--deltas <tsv>] [--summary <file>] [--json <file>] [--report-only] [--fail-on-additions] [--expect-attempt <run>:<n>] [--missing-keys K1,K2] [--repo owner/name]');
    return message === 'help' ? 0 : 2;
  }
  try {
    const scratch = mkdtempSync(join(tmpdir(), 'gbrain-receipts-'));
    const head = loadSide(args.headRuns, args.headDirs, args, scratch)!;
    const base = loadSide(args.baseRuns, args.baseDirs, args, scratch);
    const deltasPath = args.deltas ?? (existsSync(DEFAULT_DELTAS) ? DEFAULT_DELTAS : undefined);
    const deltas = deltasPath ? parseDeltas(readFileSync(deltasPath, 'utf8')) : { rows: [], errors: [] };
    const result = compare(head, base, deltas, { failOnAdditions: args.failOnAdditions });
    const extra: string[] = [];
    if (args.missingKeys) {
      const keys = args.missingKeys;
      if (keys.length) {
        const skipped = missingKeySkips(head, keys);
        const listed = skipped.files.slice(0, 20).map(f => md(f)).join(', ') + (skipped.files.length > 20 ? ', …' : '');
        extra.push(`**${skipped.tests} tests skipped for missing keys**: skipped tests in ${skipped.files.length} file(s) that read ${keys.join(' or ')}, which at least one lane ran without${skipped.files.length ? ` (${listed})` : ''}.`, '');
      } else {
        extra.push('**0 tests skipped for missing keys** (every provider key was set).', '');
      }
    }
    const text = render(result, extra);
    process.stdout.write(text);
    if (args.summary) appendFileSync(args.summary, text);
    if (args.json) writeFileSync(args.json, `${JSON.stringify(toJSON(result), null, 2)}\n`);
    return result.ok || args.reportOnly ? 0 : 1;
  } catch (error) {
    console.error(`ci-executed-counts: ${error instanceof Error ? error.message : String(error)}`);
    console.error(DOCS);
    return 2;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
