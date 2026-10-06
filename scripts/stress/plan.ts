/**
 * Planning half of `bun run test:stress` (scripts/stress/run.ts) and of the
 * CI stress gate and race hunt (scripts/stress/gate.ts): which files a diff
 * touches, which execution profile each file needs, what a run costs, how
 * work splits into shards, and the replayable reproduce line.
 *
 * Pure except for the git helpers, which take an explicit cwd.
 * Docs: docs/TESTING.md#stress-gate and docs/TESTING.md#race-hunt.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { postgresArm, postgresLanes } from '../check-postgres-lane-coverage.ts';

export const STRESS_DOCS = 'docs/TESTING.md#stress-gate';
export const RACE_HUNT_DOCS = 'docs/TESTING.md#race-hunt';
export const TEST_PATH_RE = /^test\/[\w./-]+\.test\.ts$/;
export const DEFAULT_ITERATIONS = 10;
/** Helpers with more direct test importers than this are sampled (Eng fan-in rule). */
export const HELPER_FAN_IN_LIMIT = 25;
export const HELPER_SAMPLE = 10;
/** Estimated per-iteration overhead beyond a file's measured time: Bun startup plus database creation. */
export const ITERATION_OVERHEAD_MS = 3000;

export type ProfileName = 'unit' | 'serial' | 'slow' | 'postgres-arm' | 'e2e';

export interface Profile {
  name: ProfileName;
  /** `database` runs get a fresh database per iteration; `no-database` runs have DATABASE_URL unset. */
  env: 'database' | 'no-database';
  /** Backend arm recorded in receipts and failure identities. */
  arm: 'pglite' | 'pglite+postgres' | 'postgres';
  timeoutMs: number;
  /** Extra environment, mirroring the workflow's pull-request values. */
  vars: Record<string, string>;
  /** A prerequisite the runner builds once before the first iteration. */
  prereq?: 'old-binary';
}

export interface NotStressed { file: string; reason: string }

/**
 * Per-file execution specifics that differ from the suffix default. Values
 * mirror test.yml / persistence-validation.yml on pull requests; a test pins
 * the export-scale and old-binary rows to the workflow.
 */
export const SPECIAL_FILES: Record<string, Partial<Profile>> = {
  'test/export-scale.slow.test.ts': { timeoutMs: 900_000, vars: { GBRAIN_TEST_EXPORT_SCALE_PAGES: '10001' } },
  'test/entity-resolve-perf.slow.test.ts': { timeoutMs: 300_000 },
  'test/entity-card-perf.slow.test.ts': { timeoutMs: 300_000 },
  'test/eval-brainbench-e2e.slow.test.ts': { timeoutMs: 300_000 },
  'test/persistence-skill-old-binary.slow.test.ts': { timeoutMs: 180_000, prereq: 'old-binary' },
  'test/reconcile-crash.slow.test.ts': { timeoutMs: 180_000 },
  'test/persistence-crash-robot.slow.test.ts': { timeoutMs: 300_000 },
};

/** Files no stress run can execute here, with the reason the summary prints. */
export function notStressedReason(file: string, liveKeyOnly: Set<string>): string | null {
  if (/\.live\.test\.ts$/.test(file) || file.startsWith('test/live/')) return 'paid-provider test (needs live model keys); not stressed';
  if (liveKeyOnly.has(file)) return 'needs provider keys no CI job supplies (scripts/e2e-live-key-only.txt); not stressed';
  return null;
}

/**
 * The execution profile for one file. A file with a DATABASE_URL-gated arm
 * runs both arms against a fresh database when Postgres is available, exactly
 * like persistence-validation's unit-postgres-arms job; otherwise it runs its
 * suffix lane with DATABASE_URL unset.
 */
export function profileFor(file: string, opts: { armed: boolean; postgres: boolean }): Profile {
  const special = SPECIAL_FILES[file] ?? {};
  let base: Profile;
  if (file.startsWith('test/e2e/')) base = { name: 'e2e', env: 'database', arm: 'postgres', timeoutMs: 60_000, vars: {} };
  else if (opts.armed && opts.postgres) base = { name: 'postgres-arm', env: 'database', arm: 'pglite+postgres', timeoutMs: 120_000, vars: {} };
  else if (file.endsWith('.serial.test.ts')) base = { name: 'serial', env: 'no-database', arm: 'pglite', timeoutMs: 120_000, vars: {} };
  else if (file.endsWith('.slow.test.ts')) base = { name: 'slow', env: 'no-database', arm: 'pglite', timeoutMs: 120_000, vars: {} };
  else base = { name: 'unit', env: 'no-database', arm: 'pglite', timeoutMs: 60_000, vars: {} };
  return { ...base, ...special, vars: { ...base.vars, ...(special.vars ?? {}) }, name: base.name, env: base.env, arm: base.arm };
}

let lanes: Map<string, string> | undefined;

/**
 * How a file's DATABASE_URL-gated PostgreSQL arm runs. A file in
 * test/postgres-unit-arms.txt or a DATABASE_URL workflow step runs it with
 * DATABASE_URL set (`armed`); a file whose only lane is a test/e2e wrapper
 * (registerPostgresTests, GBRAIN_TEST_BACKEND=postgres) runs it only through
 * that wrapper, so the wrapper is stressed instead.
 */
export function armMode(root: string, file: string): { armed: boolean; wrapper?: string } {
  if (file.startsWith('test/e2e/') || !existsSync(join(root, file)) || !postgresArm(join(root, file))) return { armed: false };
  lanes ??= postgresLanes();
  const lane = lanes.get(file);
  return lane?.startsWith('test/e2e/') ? { armed: false, wrapper: lane } : { armed: true };
}

/** Database URLs and tokens never reach a printed line. */
export function redact(text: string): string {
  return text
    .replace(/\b(postgres(?:ql)?:\/\/[^:/@\s]+):[^@\s]*@/gi, '$1:***@')
    .replace(/\b(PGPASSWORD|[A-Z_]*(?:TOKEN|API_KEY|SECRET))=\S+/g, '$1=***');
}

export interface ReproduceInput {
  file: string; iterations: number; firstIteration: number; seed: number;
  postgres: boolean; randomize?: boolean;
}

/** The exact local command that replays a stress context. Never carries a credential. */
export function reproduceLine(r: ReproduceInput): string {
  const parts = ['bun run test:stress', r.file, '--iterations', String(r.iterations)];
  if (r.firstIteration !== 1) parts.push('--first-iteration', String(r.firstIteration));
  parts.push('--seed', String(r.seed));
  if (r.postgres) parts.push('--postgres');
  if (r.randomize) parts.push('--randomize');
  return redact(parts.join(' '));
}

/** Deterministic base seed for a file at a commit, so a replay without --seed repeats the CI seeds. */
export function defaultSeed(sha: string, file: string): number {
  return parseInt(createHash('sha256').update(`${sha}\0${file}`).digest('hex').slice(0, 8), 16) % 1_000_000;
}

/** A ref from a dispatch input: a 40-hex SHA or a name `git check-ref-format --allow-onelevel` accepts. */
export function validRef(ref: string): boolean {
  if (/^[0-9a-f]{40}$/.test(ref)) return true;
  if (!/^[\w./-]+$/.test(ref) || ref.startsWith('-')) return false;
  return spawnSync('git', ['check-ref-format', '--allow-onelevel', ref], { encoding: 'utf8' }).status === 0;
}

/** Split a dispatch `stress_files` value; every entry must be a repo-relative test path. */
export function parseFileList(value: string): { files: string[]; invalid: string[] } {
  const entries = value.split(/[\s,]+/).filter(Boolean);
  return { files: [...new Set(entries.filter(f => TEST_PATH_RE.test(f) && !f.includes('..')))], invalid: entries.filter(f => !TEST_PATH_RE.test(f) || f.includes('..')) };
}

function git(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? '', err: (r.stderr ?? '').trim() };
}

export interface ChangedFiles { tests: string[]; helpers: string[]; mergeBase: string; error?: string }

/**
 * Test files and test helpers added or modified versus the merge base of
 * `base` and `head` (renames at their new path, deletions skipped). Without
 * `head`, the working tree and untracked files count, for local runs.
 */
export function changedFiles(cwd: string, base: string, head?: string): ChangedFiles {
  const mb = git(cwd, ['merge-base', base, head ?? 'HEAD']);
  if (!mb.ok) {
    return { tests: [], helpers: [], mergeBase: '', error: `cannot compute the merge base of ${base} and ${head ?? 'HEAD'} (${mb.err || 'no common history'}). Next: git fetch --no-tags origin ${base.replace(/^origin\//, '')} and fetch enough history for both commits (actions/checkout fetch-depth: 0), then re-run` };
  }
  const mergeBase = mb.out.trim();
  const diff = git(cwd, ['diff', '--name-status', '-M', '--no-color', mergeBase, ...(head ? [head] : [])]);
  if (!diff.ok) return { tests: [], helpers: [], mergeBase, error: `git diff against ${mergeBase} failed (${diff.err}). Next: fetch both commits and re-run` };
  const paths: string[] = [];
  for (const line of diff.out.split('\n')) {
    const cols = line.split('\t');
    const status = cols[0] ?? '';
    if (!status || status.startsWith('D')) continue;
    paths.push(status.startsWith('R') || status.startsWith('C') ? cols[2]! : cols[1]!);
  }
  if (!head) {
    const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard']);
    if (untracked.ok) paths.push(...untracked.out.split('\n').filter(Boolean));
  }
  const unique = [...new Set(paths)].sort();
  return {
    tests: unique.filter(p => TEST_PATH_RE.test(p) && !p.startsWith('test/fixtures/')),
    helpers: unique.filter(p => p.startsWith('test/helpers/') && /\.(ts|js|mjs)$/.test(p) && !p.endsWith('.test.ts')),
    mergeBase,
  };
}

/** Every `*.test.ts` under test/ (fixtures excluded), repo-relative and sorted. */
export function allTestFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      const rel = relative(root, full).replace(/\\/g, '/');
      if (rel === 'test/fixtures' || entry === 'node_modules') continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (TEST_PATH_RE.test(rel)) out.push(rel);
    }
  };
  walk(join(root, 'test'));
  return out;
}

const IMPORT_RE = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm;

/** Test files that import `helper` directly (relative specifiers, with or without the extension). */
export function directImporters(root: string, helper: string, tests: string[]): string[] {
  const target = helper.replace(/\.(ts|js|mjs)$/, '');
  return tests.filter(test => {
    const text = readFileSync(join(root, test), 'utf8');
    for (const [, spec] of text.matchAll(IMPORT_RE)) {
      const resolved = normalize(join(dirname(test), spec!)).replace(/\\/g, '/').replace(/\.(ts|js|mjs)$/, '').replace(/\/index$/, '');
      if (resolved === target) return true;
    }
    return false;
  });
}

/** Seeded Fisher-Yates over a sorted copy: the same head SHA always samples the same importers. */
export function seededSample<T>(items: T[], count: number, seed: string): T[] {
  let state = parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) || 1;
  const next = () => { state = (state + 0x6d2b79f5) | 0; let t = Math.imul(state ^ (state >>> 15), 1 | state); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [copy[i], copy[j]] = [copy[j]!, copy[i]!]; }
  return copy.slice(0, count);
}

export interface HelperExpansion {
  helper: string;
  importers: number;
  /** Files the gate stresses because of this helper. */
  stressed: string[];
  /** Importers left out by the fan-in rule, listed in the summary. */
  listedOnly: string[];
  mode: 'all-importers' | 'sampled';
}

/**
 * Eng fan-in rule: a changed helper with at most 25 direct test importers
 * stresses all of them; above 25, its own tests plus a deterministic sample of
 * 10 importers seeded by the head SHA, and the rest are listed. Changed test
 * files are added by the caller and are never sampled.
 */
export function expandHelper(root: string, helper: string, tests: string[], headSha: string): HelperExpansion {
  const importers = directImporters(root, helper, tests);
  if (importers.length <= HELPER_FAN_IN_LIMIT) return { helper, importers: importers.length, stressed: importers, listedOnly: [], mode: 'all-importers' };
  const stem = helper.split('/').pop()!.replace(/\.(ts|js|mjs)$/, '');
  const own = tests.filter(t => t.split('/').pop()!.replace(/(\.(serial|slow|unit))?\.test\.ts$/, '') === stem);
  const sample = seededSample(importers.filter(f => !own.includes(f)), HELPER_SAMPLE, `${headSha}\0${helper}`);
  const stressed = [...new Set([...own, ...sample])].sort();
  return { helper, importers: importers.length, stressed, listedOnly: importers.filter(f => !stressed.includes(f)), mode: 'sampled' };
}

export interface WorkItem { file: string; first: number; count: number; estimateMs: number }
export interface Shard { index: number; items: WorkItem[]; estimateMs: number }

/**
 * Split files into work items (a file's iterations are chunked when ten of
 * them exceed the budget) and pack them into the fewest shards whose
 * estimates stay within `budgetMs`. No shard-count cap: runners queue.
 */
export function planShards(files: Array<{ file: string; perIterationMs: number; setupMs?: number }>, iterations: number, budgetMs: number, firstIteration = 1): Shard[] {
  const items: WorkItem[] = [];
  for (const f of files) {
    const per = f.perIterationMs + ITERATION_OVERHEAD_MS;
    const chunk = Math.max(1, Math.min(iterations, Math.floor((budgetMs - (f.setupMs ?? 0)) / per)));
    for (let first = 0; first < iterations; first += chunk) {
      const count = Math.min(chunk, iterations - first);
      items.push({ file: f.file, first: firstIteration + first, count, estimateMs: (f.setupMs ?? 0) + per * count });
    }
  }
  if (!items.length) return [];
  items.sort((a, b) => b.estimateMs - a.estimateMs || (a.file < b.file ? -1 : a.file > b.file ? 1 : a.first - b.first));
  const total = items.reduce((s, i) => s + i.estimateMs, 0);
  for (let n = Math.max(1, Math.ceil(total / budgetMs)); ; n++) {
    const shards: Shard[] = Array.from({ length: n }, (_, i) => ({ index: i + 1, items: [], estimateMs: 0 }));
    for (const item of items) {
      const target = shards.reduce((min, s) => (s.estimateMs < min.estimateMs ? s : min));
      target.items.push(item);
      target.estimateMs += item.estimateMs;
    }
    if (shards.every(s => s.estimateMs <= budgetMs) || n >= items.length) return shards.filter(s => s.items.length);
  }
}

export interface Weights { unit: Map<string, number>; serialSeconds: Map<string, number>; e2e: Map<string, number>; arms: Map<string, number> }

const loadMap = (path: string): Map<string, number> => (existsSync(path) ? new Map(Object.entries(JSON.parse(readFileSync(path, 'utf8')) as Record<string, number>)) : new Map());

export function loadWeights(root: string): Weights {
  return {
    unit: loadMap(join(root, 'scripts/test-weights.json')),
    serialSeconds: loadMap(join(root, 'scripts/serial-weights.json')),
    e2e: loadMap(join(root, 'scripts/e2e-weights.json')),
    arms: loadMap(join(root, 'scripts/postgres-arm-weights.json')),
  };
}

const p75 = (values: number[]) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(0.75 * s.length) - 1)]! : 30_000; };

/** Measured milliseconds for one iteration of `file` in `profile`, or the lane's p75 for an unmeasured file. */
export function iterationEstimateMs(file: string, profile: ProfileName, w: Weights): number {
  switch (profile) {
    case 'postgres-arm': return w.arms.get(file) ?? p75([...w.arms.values()]);
    case 'e2e': return w.e2e.get(file) ?? p75([...w.e2e.values()]);
    case 'serial': return (w.serialSeconds.get(file) ?? p75([...w.serialSeconds.values()])) * 1000;
    case 'slow': return w.unit.get(file) ?? 120_000;
    default: return w.unit.get(file) ?? p75([...w.unit.values()]);
  }
}
