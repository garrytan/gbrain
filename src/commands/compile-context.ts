/**
 * compile-context.ts — `gbrain compile-context` (cathedral-5, plan D3'/D4').
 *
 * Compiles a deterministic, sensitivity-scanned, token-budgeted context
 * file from the brain via src/core/context/compile-view.ts. Byte-stable:
 * an unchanged brain compiles to identical bytes (the header digest is the
 * freshness signal); check mode recompiles in memory and byte-compares.
 *
 * Targets (bootstrap spellings):
 *   claude-code  writes .claude/gbrain-context.md and prints the one-line
 *                CLAUDE.md import instruction (closed-harness: one line of
 *                user setup, no harness cooperation needed).
 *   codex        splices into AGENTS.md between the managed begin/end
 *                markers. Duplicate/orphan/out-of-order markers THROW
 *                (modeled on bootstrap/codex-toml.ts findBlock — hand-edits
 *                we must not guess through). Also serves opencode
 *                (AGENTS.md loads natively there).
 *   openclaw     writes <workspace>/.gbrain/compiled-context.md.
 *
 * Failure posture: read/config errors exit non-zero with NO partial
 * writes (atomicWriteTextFile is the only writer, and it only runs after
 * a full successful compile). Scan drops never abort — they are reported
 * on stderr (slug + family + fingerprint; never the matched text) and in
 * the json envelope.
 *
 * Exit codes: 0 ok / in-check identical; 1 check found a difference;
 * 2 error (usage, config, read failure, damaged markers).
 */

import { existsSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { atomicWriteTextFile } from '../core/bootstrap/atomic-write.ts';
import { compileView, type CompileViewMeta } from '../core/context/compile-view.ts';
import { loadSensitivityConfig } from '../core/context/sensitivity-scan.ts';
import { resolveSourceId, ALL_SOURCES } from '../core/source-resolver.ts';

// ── Constants ───────────────────────────────────────────────────────────────

export const COMPILE_TARGETS = ['claude-code', 'codex', 'openclaw'] as const;
export type CompileTarget = (typeof COMPILE_TARGETS)[number];

/** Managed-block markers for the codex (AGENTS.md) target. Exact-line match. */
export const COMPILED_BLOCK_BEGIN = '<!-- gbrain:compiled-context:begin -->';
export const COMPILED_BLOCK_END = '<!-- gbrain:compiled-context:end -->';

/** Default whole-file token budget when the budget flag is omitted. */
export const DEFAULT_COMPILE_BUDGET = 4000;

const EXIT_OK = 0;
const EXIT_DIFF = 1;
const EXIT_ERROR = 2;

// ── Flag parsing ────────────────────────────────────────────────────────────

interface CompileFlags {
  target: CompileTarget;
  budget: number;
  out?: string;
  stdout: boolean;
  source?: string;
  include?: string[];
  check: boolean;
  json: boolean;
}

class UsageError extends Error {}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i >= 0) {
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) {
      throw new UsageError(`${flag} requires a value`);
    }
    return v;
  }
  const prefix = `${flag}=`;
  const kv = args.find((a) => a.startsWith(prefix));
  return kv ? kv.slice(prefix.length) : undefined;
}

function parseCompileFlags(args: string[]): CompileFlags {
  const target = flagValue(args, '--target');
  if (!target) {
    throw new UsageError(`--target is required (${COMPILE_TARGETS.join(' | ')})`);
  }
  if (!(COMPILE_TARGETS as readonly string[]).includes(target)) {
    throw new UsageError(
      `unknown target "${target}" — expected one of: ${COMPILE_TARGETS.join(' | ')}`,
    );
  }
  const budgetRaw = flagValue(args, '--budget');
  let budget = DEFAULT_COMPILE_BUDGET;
  if (budgetRaw !== undefined) {
    budget = Number(budgetRaw);
    if (!Number.isFinite(budget) || !Number.isInteger(budget) || budget <= 0) {
      throw new UsageError(`--budget must be a positive integer (got "${budgetRaw}")`);
    }
  }
  const include = flagValue(args, '--include')
    ?.split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return {
    target: target as CompileTarget,
    budget,
    out: flagValue(args, '--out'),
    stdout: args.includes('--stdout'),
    source: flagValue(args, '--source'),
    ...(include && include.length > 0 ? { include } : {}),
    check: args.includes('--check'),
    json: args.includes('--json'),
  };
}

// ── Codex AGENTS.md splice ──────────────────────────────────────────────────

/**
 * Splice the compiled text into the managed block. No markers → append a
 * fresh block at EOF. Exactly one in-order pair → replace the interior.
 * Anything else (duplicates, an orphan, out of order) → THROW: those are
 * hand-edits we must not guess through (findBlock discipline).
 */
export function spliceCompiledBlock(existing: string, compiled: string): string {
  const lines = existing.length > 0 ? existing.split('\n') : [];
  const begins: number[] = [];
  const ends: number[] = [];
  lines.forEach((line, i) => {
    if (line === COMPILED_BLOCK_BEGIN) begins.push(i);
    if (line === COMPILED_BLOCK_END) ends.push(i);
  });
  // Neutralize marker-equal lines INSIDE the compiled body (adversarial
  // review): a page excerpt that is exactly a marker string would land as a
  // real marker line — the first splice succeeds, and every run after that
  // sees damaged markers (self-wedge until hand-edit). A leading space keeps
  // the text visible but fails the exact-line match. Deterministic, so the
  // check recompile compares like-for-like.
  const neutralized = compiled
    .split('\n')
    .map((l) => (l === COMPILED_BLOCK_BEGIN || l === COMPILED_BLOCK_END ? ` ${l}` : l))
    .join('\n');
  const body = neutralized.endsWith('\n') ? neutralized.slice(0, -1) : neutralized;
  if (begins.length === 0 && ends.length === 0) {
    const head =
      existing.length === 0 ? '' : existing.endsWith('\n') ? existing : `${existing}\n`;
    return `${head}${COMPILED_BLOCK_BEGIN}\n${body}\n${COMPILED_BLOCK_END}\n`;
  }
  if (begins.length !== 1 || ends.length !== 1 || begins[0] > ends[0]) {
    throw new Error(
      `the gbrain compiled-context markers in this file are damaged ` +
        `(${begins.length} begin / ${ends.length} end` +
        `${begins.length === 1 && ends.length === 1 ? ', out of order' : ''}) — ` +
        `the managed block was hand-edited. Fix the markers (or delete the whole block) and re-run.`,
    );
  }
  const out = [...lines.slice(0, begins[0] + 1), ...body.split('\n'), ...lines.slice(ends[0])];
  const joined = out.join('\n');
  return joined.endsWith('\n') ? joined : `${joined}\n`;
}

// ── Paths ───────────────────────────────────────────────────────────────────

// Semgrep path-join suppressions below: `cwd` is process.cwd() on a LOCAL,
// operator-invoked CLI command (CLI_ONLY, refused on thin clients) and every
// joined segment is a literal — there is no untrusted input in these paths.
export function defaultOutPath(target: CompileTarget, cwd: string): string {
  switch (target) {
    case 'claude-code':
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
      return join(cwd, '.claude', 'gbrain-context.md');
    case 'codex':
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
      return join(cwd, 'AGENTS.md');
    case 'openclaw':
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
      return join(cwd, '.gbrain', 'compiled-context.md');
  }
}

// ── Help ────────────────────────────────────────────────────────────────────

function printCompileContextHelp(): void {
  process.stdout.write(`Usage: gbrain compile-context --target <t> [flags]

Compile a deterministic, sensitivity-scanned, token-budgeted context file
from the brain. Unchanged brain => identical bytes; the header digest is
the freshness signal.

Flags:
  --target <t>       Required: claude-code | codex | openclaw.
  --budget <n>       Whole-file token budget (default ${DEFAULT_COMPILE_BUDGET}).
  --out <path>       Override the target's default output path.
  --stdout           Print the compiled text to stdout; write no files.
  --source <id>      Compile from this source (default: resolved source).
  --include <p,...>  Extra slug prefixes selected alongside the defaults.
  --check            Recompile in memory and byte-compare against the
                     existing output. Exit 0 same, 1 different, 2 error.
  --json             Machine-readable result envelope on stdout.
  --help             Show this help.

Targets:
  claude-code   .claude/gbrain-context.md + a one-line CLAUDE.md import.
  codex         AGENTS.md managed block (also loads natively in opencode).
  openclaw      .gbrain/compiled-context.md in the workspace.
`);
}

// ── Main ────────────────────────────────────────────────────────────────────

interface CompileEnvelope extends CompileViewMeta {
  target: CompileTarget;
  source_id: string;
  out: string | null;
  generated_at: string;
  check?: 'match' | 'diff';
}

/**
 * Signature matches the SELF_HELP_WITHOUT_ENGINE convention in cli.ts:
 * `(engine, args)` with `engine: BrainEngine | null` — the help guard runs
 * FIRST, before the engine is touched, so help answers with no brain.
 */
export async function runCompileContext(
  engine: BrainEngine | null,
  args: string[],
  opts: { cwd?: string } = {},
): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    printCompileContextHelp();
    return EXIT_OK;
  }
  if (!engine) {
    // Defensive: the dispatcher connects before calling with real work.
    process.stderr.write('compile-context: no brain configured (run `gbrain init` first).\n');
    return EXIT_ERROR;
  }

  let flags: CompileFlags;
  try {
    flags = parseCompileFlags(args);
  } catch (err) {
    process.stderr.write(`compile-context: ${(err as Error).message}\n`);
    process.stderr.write('Run `gbrain compile-context --help` for usage.\n');
    return EXIT_ERROR;
  }

  const cwd = opts.cwd ?? process.cwd();

  try {
    // Source resolution runs even when the source flag is omitted (6-tier
    // resolution: flag > env > dotfile > ... > 'default').
    const sourceId = await resolveSourceId(engine, flags.source ?? null, cwd);
    if (sourceId === ALL_SOURCES) {
      process.stderr.write(
        'compile-context: compiles exactly ONE source — pass a concrete source id.\n',
      );
      return EXIT_ERROR;
    }

    // Config loads BEFORE any compile work: a loader failure (malformed
    // operator regex, unreadable allowlist) aborts here, before anything
    // could be written.
    const scanConfig = loadSensitivityConfig({ workspaceRoot: cwd });

    const { text, meta } = await compileView({
      engine,
      sourceId,
      target: flags.target,
      budget: flags.budget,
      ...(flags.include ? { includePrefixes: flags.include } : {}),
      scanConfig,
    });

    // Drops are always reported: slug + family + fingerprint, never the text.
    for (const d of meta.scan_drops) {
      process.stderr.write(
        `compile-context: dropped ${d.slug} (${d.family} ${d.fingerprint})\n`,
      );
    }

    const outPath = flags.out ?? defaultOutPath(flags.target, cwd);
    const existing = existsSync(outPath) ? readFileSync(outPath, 'utf-8') : null;

    const envelope = (extra: Partial<CompileEnvelope>): CompileEnvelope => ({
      target: flags.target,
      source_id: sourceId,
      out: flags.stdout ? null : outPath,
      generated_at: new Date().toISOString(),
      ...meta,
      ...extra,
    });

    if (flags.check) {
      let same: boolean;
      if (flags.target === 'codex') {
        // "Would a write change the file?" — includes missing/absent block.
        same = existing !== null && spliceCompiledBlock(existing, text) === existing;
      } else {
        same = existing === text;
      }
      const verdict: 'match' | 'diff' = same ? 'match' : 'diff';
      if (flags.json) {
        process.stdout.write(`${JSON.stringify(envelope({ check: verdict, out: outPath }))}\n`);
      } else {
        process.stdout.write(
          same
            ? `compile-context: up to date (${outPath})\n`
            : `compile-context: STALE — a recompile would change ${outPath}\n`,
        );
      }
      return same ? EXIT_OK : EXIT_DIFF;
    }

    if (flags.stdout) {
      if (flags.json) {
        process.stdout.write(`${JSON.stringify({ ...envelope({}), text })}\n`);
      } else {
        process.stdout.write(text);
      }
      return EXIT_OK;
    }

    const fileText =
      flags.target === 'codex' ? spliceCompiledBlock(existing ?? '', text) : text;
    atomicWriteTextFile(outPath, fileText, { freshMode: 0o644 });

    if (flags.json) {
      process.stdout.write(`${JSON.stringify(envelope({}))}\n`);
    } else {
      process.stdout.write(
        `compile-context: wrote ${meta.entries_used} entr${meta.entries_used === 1 ? 'y' : 'ies'} ` +
          `(${meta.total_output_tokens} tokens, budget ${meta.requested_budget}) → ${outPath}\n`,
      );
      if (flags.target === 'claude-code') {
        const rel = relative(cwd, outPath);
        process.stdout.write(`Add this line to CLAUDE.md to load it: @${rel}\n`);
      }
    }
    return EXIT_OK;
  } catch (err) {
    process.stderr.write(`compile-context: ${(err as Error).message}\n`);
    return EXIT_ERROR;
  }
}
