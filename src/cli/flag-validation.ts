/**
 * Pre-dispatch flag validation and the CLI alias table, kept out of
 * src/cli/main.ts so modules that only need to check an invocation (the
 * skill drift surface, src/cli/skill-surface.ts, which doctor reaches through
 * the operations graph) do not load the whole dispatcher. main.ts re-exports
 * every symbol here.
 */
import type { OperationMeta } from '../core/ops/contract.ts';
import { OPERATION_MANIFEST, cliOps } from './op-manifest.ts';
import { CLI_ONLY } from './command-table.ts';
import { findUnknownFlag } from './flag-equals.ts';
import { isBooleanLiteral } from '../core/op-flag-tokens.ts';
import { CLI_FLAG_REGISTRY } from '../core/cli-flag-registry.generated.ts';
import { migrationCliArgumentError } from '../core/embedding-migration-cli.ts';

// v114 (#1941): alias -> operation lookup, kept separate from `cliOps` so
// aliases don't double-list in printHelp's auto-generated section. Collisions
// with a primary CLI name, a CLI_ONLY command, or another alias throw at module
// load — a silent route-shadow is worse than a loud boot failure. CLI_ONLY is
// derived from the command table (src/cli/command-table.ts), so the check runs
// over every table record. Exported for the table test's collision case.
export function buildCliAliases<T extends OperationMeta>(
  ops: readonly T[],
  primary: ReadonlyMap<string, OperationMeta>,
  cliOnly: ReadonlySet<string>,
): Map<string, T> {
  const aliases = new Map<string, T>();
  for (const op of ops) {
    if (op.cliHints?.hidden) continue;
    for (const alias of op.cliHints?.aliases ?? []) {
      if (primary.has(alias) || cliOnly.has(alias) || aliases.has(alias)) {
        throw new Error(
          `CLI alias collision: '${alias}' (op '${op.name}') conflicts with an existing ` +
          `command or alias. Rename the alias in src/core/operations.ts.`,
        );
      }
      aliases.set(alias, op);
    }
  }
  return aliases;
}

export const cliAliases = buildCliAliases(OPERATION_MANIFEST, cliOps, CLI_ONLY);

// ─────────────────────────────────────────────────────────────────
// #2185 — strict unknown-flag validation (pre-dispatch, pre-engine).
// A flag no handler consults must fail loud instead of silently doing the
// destructive thing (`init --migrate-only --dry-run` applied REAL migrations
// while the user asked for a rehearsal). Two lanes:
//   - op commands: legal flags derive from the operation contract
//     (op.params) + the CLI-local formatter flags, mirroring parseOpArgs's
//     traversal so values that begin with '--' are never misread.
//   - CLI_ONLY commands: legal flags come from the generated
//     CLI_FLAG_REGISTRY (scripts/generate-flag-registry.ts scans each
//     command's source; freshness + coverage pinned by
//     test/cli-flag-validation.test.ts).
// Everything after a literal `--` is passthrough and never validated.
// ─────────────────────────────────────────────────────────────────

// Exempt by contract, not oversight:
//  - call: the generic op invoker — arbitrary --param names are its interface.
//  - config: `config set <key> <value>` values are arbitrary strings.
//  - jobs submit: job payloads carry handler-defined params (shell lane incl.).
//  - eval brainbench: owns the 0/1/2 CI exit-code contract (0 pass · 1
//    regression · 2 error/inconclusive) via its own arg parser. The global
//    validator's exit(1) on an unknown flag would be read by a CI harness as a
//    memory REGRESSION rather than a typo; brainbench maps a bad flag to exit 2
//    (error) with its own usage. Its legal flags still land in the generated
//    registry (the generator scans eval's modules), so freshness/drift hold.
function flagValidationExempt(command: string, subArgs: string[]): boolean {
  return command === 'call' || command === 'config'
    || (command === 'jobs' && subArgs[0] === 'submit')
    || (command === 'eval' && subArgs[0] === 'brainbench');
}

/** Returns the first unknown flag (e.g. '--dry-run') or null when clean. */
export function validateCommandFlags(command: string, subArgs: string[]): string | null {
  if (flagValidationExempt(command, subArgs)) return null;
  if (command === 'retrieval-upgrade' || command === 'migrate' && subArgs[0] === 'embeddings') return migrationCliArgumentError(command, subArgs)?.flag ?? null;
  // Lane order MUST mirror dispatch order (CLI_ONLY first): commands that are
  // BOTH an op and a CLI_ONLY member (think, salience, anomalies) dispatch to
  // handleCliOnly, whose handlers parse flags the op contract doesn't declare
  // (`salience --kind`, `think --with-calibration`) — validating those
  // against op.params rejected documented invocations.
  if (CLI_ONLY.has(command)) {
    const legal = CLI_FLAG_REGISTRY[command];
    // Registry drift fails OPEN at runtime (never brick a command); the
    // drift-guard test fails the build instead.
    if (!legal) return null;
    return findUnknownFlag(subArgs, new Set(legal));
  }
  const op = cliOps.get(command) ?? cliAliases.get(command);
  if (op) return findUnknownOpFlag(op, op.name === 'put_page' ? subArgs.filter((a, i) => !/^--file(=|$)/.test(a) && subArgs[i - 1] !== '--file') : subArgs); // put --file: cli/commands/append.ts
  return null; // unknown command — the dispatcher's own error handles it
}

/** Op lane: mirrors parseOpArgs so flag VALUES starting with '--' are skipped. */
export function findUnknownOpFlag(op: OperationMeta, args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    const m = /^--([a-z0-9][a-z0-9-]*)(?:=(.*))?$/i.exec(a);
    if (!m) continue;
    // Casing typo = unknown flag (see findUnknownFlag).
    if (/[A-Z]/.test(m[1])) return `--${m[1]}`;
    const rawKey = m[1];
    // CLI-local flags consumed OUTSIDE the op contract (never wire params):
    //   json/explain — formatter flags; help — short-circuits pre-dispatch;
    //   source — makeContext's 6-tier source resolution (deleted before wire);
    //   dry-run — makeContext's ctx.dryRun projection.
    // Pre-fix, rejecting these broke documented invocations
    // (`gbrain search "x" --source y`, `gbrain put x --dry-run`).
    if (rawKey === 'json') {
      // #4602: parseOpArgs consumes a literal true/false as this boolean's
      // value — mirror the traversal so the token counts as consumed here too.
      if (m[2] === undefined && isBooleanLiteral(args[i + 1])) i++;
      continue;
    }
    // Bare-only even where an op also declares `explain` (search/query): the `=` form is refused, never parsed as a value.
    if (rawKey === 'explain' || rawKey === 'help') { if (m[2] === undefined) continue; return `--${rawKey}`; }
    if (rawKey === 'source' || rawKey === 'dry-run') {
      // Non-boolean-style CLI-locals consume the next token as their value
      // in parseOpArgs (source does; dry-run is boolean-read) — mirror the
      // parser: source consumes a value when not inline-`=`; dry-run
      // consumes only a literal true/false (#4602).
      if (rawKey === 'source' && m[2] === undefined) i++;
      if (rawKey === 'dry-run' && m[2] === undefined && isBooleanLiteral(args[i + 1])) i++;
      continue;
    }
    if (rawKey.startsWith('no-')) {
      const positive = rawKey.slice(3).replace(/-/g, '_');
      if (op.params[positive]?.type === 'boolean') continue;
    }
    const key = rawKey.replace(/-/g, '_');
    const paramDef = op.params[key];
    if (paramDef) {
      // Non-boolean flags consume the next token as their value unless
      // provided inline via `=` — exactly like parseOpArgs. Boolean flags
      // consume only a literal true/false value token (#4602).
      if (paramDef.type !== 'boolean' && m[2] === undefined) i++;
      else if (paramDef.type === 'boolean' && m[2] === undefined && isBooleanLiteral(args[i + 1])) i++;
      continue;
    }
    return `--${rawKey}`;
  }
  return null;
}
