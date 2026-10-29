#!/usr/bin/env bun
/**
 * Per-write cost of the git door (src/core/persistence/git-door.ts) on a large checkout. Opt-in, never run in CI.
 *
 *   bun scripts/bench/door-write-overhead.ts [--files 15000,155000] [--writes 300] [--warmup 10] [--phases door,trace,e2e]
 *     [--database-url postgres://postgres:postgres@localhost:5434/gbrain_test] [--work ~/.capy/work/door-bench] [--label <name>] [--out <file.json>]
 *
 * For each checkout size it builds (once, then resets and reuses under --work) a synthetic Git checkout of N markdown
 * files in nested directories with a realistic set of ignore rules (a root .gitignore with a negation, nested
 * .gitignore files, .git/info/exclude), and measures over --writes writes, after --warmup unmeasured ones:
 *   door   commitThroughDoor alone with real git: two new pages for every edit of a page written earlier.
 *   trace  the same loop with GIT_TRACE2_EVENT on, giving the time of each git subprocess inside the door (git's own
 *          clock, without the spawn) and how many run per write.
 *   e2e    put_page end to end on a managed source over Postgres (docker pgvector; a fresh database is created and
 *          dropped), alternating blocks of door-on writes (`canonical: git`, strict) and door-off writes (mixed) on the
 *          same checkout. Each write's Git effect is settled, untimed, before the next write starts.
 *   e2etrace  (not in the default phases) the e2e loop with GIT_TRACE2_EVENT on during each put_page: the git
 *          subprocesses each mode runs per write.
 * It prints p50/p95 tables and the strict-minus-mixed overhead with its ratio, and writes the samples as JSON. Run it
 * with the git binary production uses: a git wrapper on PATH adds its own processes to every call.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '../..');
function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
function gitOut(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
}
const SIZES = flag('files', '15000,155000').split(',').map(Number);
const WRITES = Number(flag('writes', '300'));
const WARMUP = Number(flag('warmup', '10'));
const PHASES = new Set(flag('phases', 'door,trace,e2e').split(','));
const DATABASE_URL = flag('database-url', process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5434/gbrain_test');
const WORK = resolve(flag('work', join(homedir(), '.capy', 'work', 'door-bench')));
const LABEL = flag('label', `${gitOut(REPO, 'rev-parse', '--short', 'HEAD')}-bun${Bun.version}`);
const OUT = resolve(flag('out', join(WORK, `door-write-overhead-${LABEL.replace(/[^\w.-]/g, '_')}.json`)));
/** Writes per strict or mixed block in the e2e phase. */
const BLOCK = 10;
const log = (msg: string) => console.error(`[door-bench ${new Date().toISOString().slice(11, 19)}] ${msg}`);

const pct = (values: number[], p: number) => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
};
const r1 = (n: number) => Math.round(n * 10) / 10;
const stats = (values: number[]) => ({ n: values.length, p50: r1(pct(values, 50)), p95: r1(pct(values, 95)) });

const pageDir = (i: number) => `area-${i % 23}/topic-${Math.floor(i / 23) % 67}/sub-${Math.floor(i / 1541) % 11}`;
const EXCLUDE = 'local-notes/\n';
const pageBody = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n\n${body}\n`;

/**
 * The checkout of `files` pages, reset to its base commit (and its ownership markers cleared) when it already exists.
 * The index is rewritten over a second after the last change so no entry is racily clean, as in a checkout at rest.
 */
function checkout(files: number): string {
  const root = join(WORK, `checkout-${files}`);
  const marker = join(root, '.git', 'gbrain-bench-base');
  if (existsSync(marker)) {
    gitOut(root, 'reset', '-q', '--hard', readFileSync(marker, 'utf8').trim());
    gitOut(root, 'clean', '-fdqx');
    for (const name of readdirSync(WORK)) if (name.startsWith('.gbrain-owner-')) rmSync(join(WORK, name), { force: true });
    rmSync(join(root, '.git', 'gbrain-managed.json'), { force: true });
    writeFileSync(join(root, '.git', 'info', 'exclude'), EXCLUDE);
  } else {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    log(`building a ${files}-file checkout in ${root}`);
    gitOut(root, 'init', '-q', '-b', 'main');
    gitOut(root, 'config', 'user.name', 'Example Writer');
    gitOut(root, 'config', 'user.email', 'writer@example.invalid');
    for (let i = 0; i < files; i++) {
      const dir = join(root, pageDir(i));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `page-${i}.md`), pageBody(`Page ${i}`, `Body of page ${i}, with a few lines of ordinary text.\nSee also page ${(i * 7) % files}.`));
    }
    mkdirSync(join(root, 'area-2', 'topic-3'), { recursive: true });
    mkdirSync(join(root, 'area-1'), { recursive: true });
    writeFileSync(join(root, '.gitignore'), ['node_modules/', '*.log', '!keep.log', '.DS_Store', '/dist', '*.tmp', '.obsidian/workspace*', 'scratch/', '**/drafts/*.swp', ''].join('\n'));
    writeFileSync(join(root, 'area-1', '.gitignore'), '*.bak\n/private/\n');
    writeFileSync(join(root, 'area-2', 'topic-3', '.gitignore'), 'cache-*\n');
    mkdirSync(join(root, '.git', 'info'), { recursive: true });
    writeFileSync(join(root, '.git', 'info', 'exclude'), EXCLUDE);
    execFileSync('git', ['-C', root, 'add', '-A'], { stdio: 'ignore' });
    gitOut(root, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Initial');
    const hook = join(root, '.git', 'hooks', 'post-commit');
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\n');
    chmodSync(hook, 0o755);
    writeFileSync(marker, gitOut(root, 'rev-parse', 'HEAD') + '\n');
  }
  Bun.sleepSync(1100);
  execFileSync('git', ['-C', root, 'update-index', '-q', '--really-refresh'], { stdio: 'ignore' });
  return root;
}

/** The subcommand of a traced git argv: the first word after git's own options. */
function subcommand(argv: string[]): string {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '-C' || arg === '-c') { i++; continue; }
    if (!arg.startsWith('-')) return arg;
  }
  return '?';
}

/** Each top-level git process traced since `offset` in `file`: its subcommand and its own elapsed milliseconds. */
function readTrace(file: string, offset: number): { offset: number; steps: { cmd: string; ms: number }[] } {
  if (!existsSync(file)) return { offset, steps: [] };
  const bytes = readFileSync(file).subarray(offset);
  const cmds = new Map<string, string>();
  const steps: { cmd: string; ms: number }[] = [];
  for (const line of bytes.toString('utf8').split('\n')) {
    if (!line) continue;
    const event = JSON.parse(line) as { event: string; sid: string; argv?: string[]; t_abs?: number };
    if (event.sid.includes('/')) continue;
    if (event.event === 'start') cmds.set(event.sid, subcommand(event.argv ?? []));
    if (event.event === 'exit' && cmds.has(event.sid)) steps.push({ cmd: cmds.get(event.sid)!, ms: event.t_abs! * 1000 });
  }
  return { offset: offset + bytes.length, steps };
}

/** Adds one write's traced git processes to the per-subcommand samples (time and calls summed per write). */
function collect(perCmd: Map<string, { ms: number[]; calls: number[] }>, steps: { cmd: string; ms: number }[]): void {
  const sums = new Map<string, { ms: number; calls: number }>([['(all git)', { ms: 0, calls: 0 }]]);
  for (const step of steps) for (const key of [step.cmd, '(all git)']) {
    const sum = sums.get(key) ?? { ms: 0, calls: 0 };
    sum.ms += step.ms; sum.calls++; sums.set(key, sum);
  }
  for (const [cmd, sum] of sums) { const e = perCmd.get(cmd) ?? { ms: [], calls: [] }; e.ms.push(sum.ms); e.calls.push(sum.calls); perCmd.set(cmd, e); }
}
/** p50/p95 per subcommand over the writes that ran it, and its mean calls over every write. */
const summarize = (perCmd: Map<string, { ms: number[]; calls: number[] }>) =>
  Object.fromEntries([...perCmd].map(([cmd, e]) => [cmd, { ...stats(e.ms), calls_per_write: r1(e.calls.reduce((a, b) => a + b, 0) / WRITES) }]));

let serial = 0;
/** The next write of a loop: two new pages for every edit of a page written earlier in the loop. */
function nextTarget(written: string[], files: number): string {
  const i = serial++;
  if (i % 3 === 2 && written.length) return written[(i * 31) % written.length]!;
  const rel = `${pageDir((i * 7919) % files)}/write-${process.pid}-${i}`;
  written.push(rel);
  return rel;
}

async function doorPhase(files: number, traced: boolean) {
  const { commitThroughDoor } = await import('../../src/core/persistence/git-door.ts');
  const { sha256 } = await import('../../src/core/persistence/digest.ts');
  const root = checkout(files);
  const trace = join(WORK, `trace-${process.pid}.jsonl`);
  rmSync(trace, { force: true });
  if (traced) process.env.GIT_TRACE2_EVENT = trace;
  const written: string[] = [];
  const totals: number[] = [];
  const perCmd = new Map<string, { ms: number[]; calls: number[] }>();
  let offset = 0;
  try {
    for (let w = 0; w < WARMUP + WRITES; w++) {
      const rel = nextTarget(written, files);
      const path = join(root, `${rel}.md`);
      const body = pageBody(rel, `Revision ${w} of ${rel}.`);
      writeFileSync(path, body);
      const planned = sha256(body);
      const start = performance.now();
      await commitThroughDoor(root, [{ path, planned }]);
      const ms = performance.now() - start;
      if (traced) {
        const read = readTrace(trace, offset);
        offset = read.offset;
        if (w >= WARMUP) collect(perCmd, read.steps);
      }
      if (w >= WARMUP) totals.push(ms);
    }
  } finally {
    delete process.env.GIT_TRACE2_EVENT;
    rmSync(trace, { force: true });
  }
  const dirty = gitOut(root, 'status', '--porcelain');
  if (dirty) throw new Error(`the checkout is not clean after the door loop:\n${dirty.slice(0, 500)}`);
  return { door: stats(totals), subprocess: summarize(perCmd), index_bytes: statSync(join(root, '.git', 'index')).size };
}

async function e2ePhase(files: number, traced: boolean) {
  const { isolatedPersistencePostgres } = await import('../../test/helpers/persistence-postgres.ts');
  const { settleManagedGitEffects } = await import('../../test/helpers/managed-brain.ts');
  const { claimWorktree } = await import('../../src/core/persistence/ownership.ts');
  const { activateSharedSkillPersistence } = await import('../../src/core/persistence/skill-activation.ts');
  const { disposePersistenceConsumer } = await import('../../src/core/persistence/service.ts');
  const { operations } = await import('../../src/core/operations.ts');
  const putPage = operations.find(op => op.name === 'put_page')!;
  const root = checkout(files);
  const home = join(WORK, `home-${process.pid}`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  const saved = { GBRAIN_HOME: process.env.GBRAIN_HOME, DATABASE_URL: process.env.DATABASE_URL, GBRAIN_DATABASE_URL: process.env.GBRAIN_DATABASE_URL };
  process.env.GBRAIN_HOME = home; delete process.env.DATABASE_URL; delete process.env.GBRAIN_DATABASE_URL;
  const { engine, close } = await isolatedPersistencePostgres(DATABASE_URL);
  const samples = { strict: [] as number[], mixed: [] as number[] };
  const perCmd = { strict: new Map<string, { ms: number[]; calls: number[] }>(), mixed: new Map<string, { ms: number[]; calls: number[] }>() };
  const trace = join(WORK, `trace-e2e-${process.pid}.jsonl`);
  rmSync(trace, { force: true });
  let offset = 0;
  try {
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
    await claimWorktree(engine, 'default', root);
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    const ctx = { engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId: 'default', remote: false, dryRun: false,
      logger: { info() {}, warn() {}, error() {} } } as never;
    const written: string[] = [];
    const revisions = new Map<string, string>();
    for (let w = 0; w < 2 * (WARMUP + WRITES); w++) {
      const strict = Math.floor(w / BLOCK) % 2 === 0;
      if (w % BLOCK === 0) await engine.executeRaw(strict ? `UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`
        : `UPDATE sources SET config = config - 'canonical' WHERE id='default'`);
      const slug = nextTarget(written, files);
      if (traced) process.env.GIT_TRACE2_EVENT = trace;
      const start = performance.now();
      const expected = revisions.get(slug);
      const result = await putPage.handler(ctx, { slug, content: pageBody(slug, `Revision ${w} of ${slug}.`), wait_ms: 30_000,
        ...(expected ? { expected_revision: expected } : {}) }) as { state?: string; revision?: string };
      const ms = performance.now() - start;
      if (result.state !== 'committed' || !result.revision) throw new Error(`put_page ${slug} ended ${JSON.stringify(result).slice(0, 400)}`);
      revisions.set(slug, result.revision);
      if (w >= 2 * WARMUP) samples[strict ? 'strict' : 'mixed'].push(ms);
      if (traced) {
        delete process.env.GIT_TRACE2_EVENT;
        const read = readTrace(trace, offset);
        offset = read.offset;
        if (w >= 2 * WARMUP) collect(perCmd[strict ? 'strict' : 'mixed'], read.steps);
      }
      await settleManagedGitEffects(engine);
    }
    const dirty = gitOut(root, 'status', '--porcelain');
    if (dirty) throw new Error(`the checkout is not clean after the put_page loop:\n${dirty.slice(0, 500)}`);
  } finally {
    delete process.env.GIT_TRACE2_EVENT;
    rmSync(trace, { force: true });
    await disposePersistenceConsumer(engine);
    await close();
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(home, { recursive: true, force: true });
  }
  const strict = stats(samples.strict), mixed = stats(samples.mixed);
  if (traced) return { strict, mixed, subprocess: { strict: summarize(perCmd.strict), mixed: summarize(perCmd.mixed) } };
  return { strict, mixed, overhead_p50: r1(strict.p50 - mixed.p50), overhead_p95: r1(strict.p95 - mixed.p95),
    ratio_p50: Math.round((strict.p50 / mixed.p50) * 100) / 100, ratio_p95: Math.round((strict.p95 / mixed.p95) * 100) / 100 };
}

mkdirSync(WORK, { recursive: true });
process.env.GBRAIN_HOME ??= join(WORK, 'gbrain-home');
const results: { label: string; bun: string; git: string; writes: number; warmup: number; sizes: Record<string, Record<string, any>> } =
  { label: LABEL, bun: Bun.version, git: gitOut(REPO, '--version'), writes: WRITES, warmup: WARMUP, sizes: {} };
for (const files of SIZES) {
  const entry: Record<string, any> = {};
  results.sizes[files] = entry;
  if (PHASES.has('door')) { log(`${files} files: commitThroughDoor x${WRITES}`); const run = await doorPhase(files, false); entry.door = run.door; entry.index_bytes = run.index_bytes; }
  if (PHASES.has('trace')) { log(`${files} files: traced commitThroughDoor x${WRITES}`); const run = await doorPhase(files, true); entry.door_traced = run.door; entry.subprocess = run.subprocess; entry.index_bytes = run.index_bytes; }
  if (PHASES.has('e2e')) { log(`${files} files: put_page strict and mixed x${WRITES} each`); entry.e2e = await e2ePhase(files, false); }
  if (PHASES.has('e2etrace')) { log(`${files} files: traced put_page strict and mixed x${WRITES} each`); entry.e2e_traced = await e2ePhase(files, true); }
  writeFileSync(OUT, JSON.stringify(results, null, 2) + '\n');
}

console.log(`\n## door write overhead: ${LABEL} (bun ${Bun.version}, ${results.git}, ${WRITES} writes after ${WARMUP} warmup)\n`);
for (const [files, entry] of Object.entries(results.sizes)) {
  console.log(`### ${files} files (index ${entry.index_bytes ? `${(entry.index_bytes / 1048576).toFixed(1)} MiB` : 'not measured'})\n`);
  console.log('| measure | p50 ms | p95 ms | calls/write |\n|---|---|---|---|');
  if (entry.door) console.log(`| commitThroughDoor | ${entry.door.p50} | ${entry.door.p95} | |`);
  if (entry.door_traced) console.log(`| commitThroughDoor (traced) | ${entry.door_traced.p50} | ${entry.door_traced.p95} | |`);
  for (const [cmd, s] of Object.entries((entry.subprocess ?? {}) as Record<string, any>).sort((a, b) => b[1].p95 - a[1].p95)) console.log(`| git ${cmd} | ${s.p50} | ${s.p95} | ${s.calls_per_write} |`);
  for (const mode of ['strict', 'mixed'] as const) {
    const traced = entry.e2e_traced?.subprocess?.[mode] as Record<string, any> | undefined;
    if (!traced) continue;
    console.log(`| put_page ${mode} (traced) | ${entry.e2e_traced[mode].p50} | ${entry.e2e_traced[mode].p95} | |`);
    for (const [cmd, s] of Object.entries(traced).sort((a, b) => b[1].p95 - a[1].p95)) console.log(`| ${mode}: git ${cmd} | ${s.p50} | ${s.p95} | ${s.calls_per_write} |`);
  }
  if (entry.e2e) {
    const e = entry.e2e;
    console.log(`| put_page strict (door on) | ${e.strict.p50} | ${e.strict.p95} | |\n| put_page mixed (door off) | ${e.mixed.p50} | ${e.mixed.p95} | |`);
    console.log(`| overhead (strict - mixed) | ${e.overhead_p50} | ${e.overhead_p95} | |\n| ratio (strict / mixed) | ${e.ratio_p50} | ${e.ratio_p95} | |`);
  }
  console.log('');
}
console.log(`samples: ${OUT}`);
process.exit(0);
