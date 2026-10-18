#!/usr/bin/env bun
/**
 * Build a typing-unit package ref (Q2 Track C): a local branch whose single extra commit on top of `--base` sets
 * ENABLED_TYPING_UNITS in src/core/link-typing-units.ts to the given units, in the given order. Prints the commit SHA.
 *
 *   bun scripts/q2-typing-package.ts --base <ref> --units U34,U1       # nested package arm (order = selection order)
 *   bun scripts/q2-typing-package.ts --base <ref> --arm U1             # one-unit arm (baseline + that unit; joint unit U34 = U3 with U4)
 *   bun scripts/q2-typing-package.ts --base <ref> --units none         # the base with no unit (equivalence checks)
 *   options: --branch <name> (default q2-typing/<base-short>/<arm-U1 | U3-U4-U1 | none>), --json
 *
 * The working tree, index and current branch are never touched (git plumbing on a temporary index). An existing
 * branch is reused only when it already points at a commit with the same parent and tree; otherwise the script
 * refuses and names the branch to delete or the --branch to pass. Measure the ref with gbrain-evals
 * `--gbrain <this checkout>@<sha>`.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JOINT_TYPING_UNITS, parseTypingUnits, type TypingUnit } from '../src/core/link-typing-units.ts';

const UNITS_FILE = 'src/core/link-typing-units.ts';
const ENABLED_RE = /export const ENABLED_TYPING_UNITS: ReadonlySet<TypingUnit> = new Set<TypingUnit>\(\[[^\]]*\]\);/;

function fail(what: string, why: string, next: string): never {
  console.error(`${what}\nWhy: ${why}\nNext: ${next}`);
  process.exit(2);
}

function arg(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : undefined;
}

function git(args: string[], env: Record<string, string> = {}, input?: string): string {
  return execFileSync('git', args, { encoding: 'utf8', env: { ...process.env, ...env }, input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/** The units file text with ENABLED_TYPING_UNITS set to `units` (order kept). */
export function withEnabledUnits(source: string, units: readonly TypingUnit[]): string {
  if (!ENABLED_RE.test(source)) {
    throw new Error(`${UNITS_FILE} has no "export const ENABLED_TYPING_UNITS: ReadonlySet<TypingUnit> = new Set<TypingUnit>([...]);" line to rewrite.`);
  }
  return source.replace(ENABLED_RE, `export const ENABLED_TYPING_UNITS: ReadonlySet<TypingUnit> = new Set<TypingUnit>([${units.map(u => `'${u}'`).join(', ')}]);`);
}

export function packageBranchName(baseShort: string, units: readonly TypingUnit[], arm: boolean): string {
  return `q2-typing/${baseShort}/${arm ? `arm-${units.join('')}` : units.length ? units.join('-') : 'none'}`;
}

function main(argv: readonly string[]): void {
  const base = arg(argv, '--base');
  const unitsArg = arg(argv, '--units');
  const armArg = arg(argv, '--arm');
  if (!base) fail('--base is required.', 'the package is one commit on top of a base ref (the frozen build).', 'bun scripts/q2-typing-package.ts --base <ref> --units U34,U1');
  if ((unitsArg === undefined) === (armArg === undefined)) fail('Pass exactly one of --units and --arm.', '--units builds a nested package in the given order; --arm builds a one-unit arm.', 'bun scripts/q2-typing-package.ts --base <ref> --arm U1');
  let units: TypingUnit[];
  try {
    units = armArg !== undefined ? parseTypingUnits([armArg]) : unitsArg === 'none' ? [] : parseTypingUnits(unitsArg!.split(','));
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), 'only the units declared in src/core/link-typing-units.ts exist.', 'pass a comma-separated subset of U1, U3, U4 (or U34), or --units none');
  }
  if (armArg !== undefined && armArg.includes(',')) fail(`--arm takes one unit (got "${armArg}").`, 'a unit arm is the baseline plus one unit (or one joint unit such as U34).', 'use --units for several units');
  const raw = (unitsArg ?? '').split(',').map(s => s.trim().toUpperCase()).filter(s => s && s !== 'NONE');
  if (unitsArg !== undefined && parseTypingUnits(raw).length !== raw.reduce((n, u) => n + (JOINT_TYPING_UNITS[u]?.length ?? 1), 0)) {
    fail(`--units ${unitsArg} repeats a unit.`, 'a package lists each unit once, in selection order.', 'remove the repeated unit');
  }

  let baseSha: string;
  try { baseSha = git(['rev-parse', '--verify', `${base}^{commit}`]); } catch {
    fail(`Base ${base} is not a commit in this checkout.`, 'the package commit needs its parent locally.', `git fetch origin ${base} (or pass a SHA), then rerun`);
  }
  let source: string;
  try { source = git(['show', `${baseSha}:${UNITS_FILE}`]); } catch {
    fail(`Base ${base} has no ${UNITS_FILE}.`, 'only builds with the typing units can be packaged.', 'pass a base that contains the Q2 typing units');
  }
  let next: string;
  try { next = withEnabledUnits(source, units); } catch (e) {
    fail(e instanceof Error ? e.message : String(e), 'the script rewrites exactly that line.', 'restore the ENABLED_TYPING_UNITS declaration format in the base, then rerun');
  }
  const blob = git(['hash-object', '-w', '--stdin'], {}, `${next}\n`);
  const tmp = mkdtempSync(join(tmpdir(), 'q2-typing-package-'));
  const index = { GIT_INDEX_FILE: join(tmp, 'index') };
  let tree: string;
  try {
    git(['read-tree', baseSha], index);
    git(['update-index', '--cacheinfo', `100644,${blob},${UNITS_FILE}`], index);
    tree = git(['write-tree'], index);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const label = armArg !== undefined ? `arm ${units.join('+')}` : units.length ? `package ${units.join(', ')}` : 'no units';
  const branch = arg(argv, '--branch') ?? packageBranchName(baseSha.slice(0, 9), units, armArg !== undefined);
  let existing: string | null = null;
  try { existing = git(['rev-parse', '--verify', `refs/heads/${branch}`]); } catch { existing = null; }
  let sha: string;
  if (existing) {
    const [parent, existingTree] = [git(['rev-parse', `${existing}^`]), git(['rev-parse', `${existing}^{tree}`])];
    if (parent !== baseSha || existingTree !== tree) {
      fail(`Branch ${branch} already exists at ${existing.slice(0, 9)} with different content.`, 'the script never moves an existing branch.', `git branch -D ${branch} (if it is yours and unpushed), or pass --branch <new name>`);
    }
    sha = existing;
  } else {
    sha = git(['commit-tree', tree, '-p', baseSha, '-m', `q2 typing ${label}: ENABLED_TYPING_UNITS = [${units.join(', ')}]\n\nBuilt by scripts/q2-typing-package.ts on ${baseSha}.`]);
    git(['branch', branch, sha]);
  }
  if (argv.includes('--json')) console.log(JSON.stringify({ sha, branch, base: baseSha, units, kind: armArg !== undefined ? 'arm' : 'package' }));
  else console.log(`${sha}\n(${label} on ${baseSha.slice(0, 9)}, branch ${branch}${existing ? ', reused' : ''}; measure with --gbrain ${process.cwd()}@${sha})`);
}

if (import.meta.main) main(process.argv.slice(2));
