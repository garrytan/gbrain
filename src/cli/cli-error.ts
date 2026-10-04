/**
 * Agent contract v1 (D1): the CLI's one error writer. Every top-level catch,
 * usage error and the fatal seam render through `renderCliError`: human
 * output is `Error [code]: …` / `Fix:` / `Why:` / `Docs:` on stderr; under
 * `--json` stdout carries exactly one envelope (a legacy JSON shape keeps its
 * keys and gains the v1 siblings). Writes go through the `cli-force-exit.ts`
 * interposer: `writeStdoutFinal` delivers synchronously when the chain is
 * idle and the patched `process.exit` drains anything queued, so callers may
 * exit right after.
 */
import { cliRenderContext, renderCliError, renderNotice, type AgentEnvelope, type Notice } from '../core/agent-output.ts';
import { renderCliNotices } from '../core/agent-markers.ts';
import { jsonGuardActive, jsonRequested, noteRenderedErrorCode, writeStdoutFinal } from '../core/cli-force-exit.ts';
import { opError, type OpErrorOpts, type OperationError } from '../core/ops/contract.ts';
import type { RegistryCode } from '../core/error-registry.ts';
import {
  classifyPgAccessError,
  formatDbAccessMarker,
  shouldEmitDbAccessMarker,
} from '../core/pg-access-classify.ts';
import { redactUrlsInText } from '../core/url-redact.ts';
import { redactConnectionInfo } from '../core/audit/redact-connection-info.ts';
import { suggestNearest } from '../core/levenshtein.ts';
import { isConsentRefusal, printConsentRefusal } from '../core/consent.ts';
import { exclusiveFix, liveServeOwner } from '../core/exclusive-fix.ts';

export interface CliErrorWriteOpts {
  /** Raw argv (defaults to process.argv.slice(2)); decides `--json`. */
  argv?: readonly string[];
  /** Overrides the argv `--json` probe (in-process callers that parsed their own flags). */
  json?: boolean;
  /** false: the caller prints its own human lines (stdout document only). */
  stderr?: boolean;
  /**
   * A pre-v1 JSON shape this site printed: its keys lead and keep their
   * values, the envelope adds the rest, and the document stays one line
   * (line-reading consumers of the old shape keep working).
   */
  legacy?: Record<string, unknown>;
}

/** The command word of an argv (first token that is not a flag), for E11 records. */
export function cliCommandOf(argv: readonly string[] = process.argv.slice(2)): string {
  return argv.find(a => !a.startsWith('-')) ?? '';
}

/** Render and write `e`; returns the exit code (the caller exits or sets the verdict). */
export function writeCliError(e: unknown, command: string, opts: CliErrorWriteOpts = {}): number {
  const json = opts.json ?? jsonRequested(opts.argv ?? process.argv.slice(2));
  if (isConsentRefusal(e)) return printConsentRefusal(e, { json });
  const r = renderCliError(e, { json, command, tty: process.stderr.isTTY === true });
  let stderr = r.stderr;
  if (r.stdout !== undefined) {
    const env = JSON.parse(r.stdout) as AgentEnvelope;
    noteRenderedErrorCode(env.code);
    // An NDJSON stream ends a failure with one `{status:"error", …envelope}` line (D2).
    const legacy = opts.legacy ?? (jsonGuardActive() === 'ndjson' ? { status: 'error' } : undefined);
    const doc = legacy ? `${JSON.stringify({ ...legacy, ...withoutUndefined(env), ...legacy })}\n` : r.stdout;
    void writeStdoutFinal(doc).catch(() => { /* fd 1 gone */ });
    // stderr stays the human channel under --json (same TTY order as renderCliError).
    stderr = [`Error [${env.code}]: ${env.message}`, `Fix: ${env.fix?.command ?? env.suggestion}`,
      ...(env.why ? [`Why: ${env.why}`] : [])].join('\n') + '\n';
  }
  if (opts.stderr !== false) try { process.stderr.write(stderr ?? ''); } catch { /* stderr gone */ }
  return r.exitCode;
}

/**
 * D2: a refusal that keeps its pre-v1 human stderr line verbatim (`human`,
 * default the message) and, under `--json`, writes the envelope as the
 * document. Returns the contract exit code.
 */
export function writeCliRefusal(e: OperationError, command: string, opts: { json: boolean; human?: string; legacy?: Record<string, unknown> }): number {
  console.error(opts.human ?? e.message);
  return writeCliError(e, command, { json: opts.json, stderr: false, ...(opts.legacy ? { legacy: opts.legacy } : {}) });
}

function withoutUndefined(o: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

/** Render, write and exit with the error's contract exit code. */
export function exitCliError(e: unknown, command: string, opts: CliErrorWriteOpts = {}): never {
  process.exit(writeCliError(e, command, opts));
}

/**
 * Open a brain, except one whose automatic PGLite repair failed: that exits 3
 * with the consent payload (the consented `pglite-repair`, effects
 * destructive), so no caller works around it (doctor's filesystem-only
 * fallback included).
 */
export async function exitOnRepairFailed<T>(open: () => Promise<T>): Promise<T> {
  try {
    return await open();
  } catch (e) {
    const { isRepairFailedRefusal } = await import('../core/pglite-repair-consent.ts');
    if (isRepairFailedRefusal(e)) exitCliError(e, cliCommandOf());
    throw e;
  }
}

/**
 * A warning-class notice from the CLI's own plumbing (not a command result):
 * stderr, as `Note [code]` lines on a TTY or an `[AGENT]` block otherwise.
 */
export function writeCliNotice(n: Notice): void {
  const out = renderCliNotices([renderNotice(n, cliRenderContext())], { json: false, tty: process.stderr.isTTY === true, stdoutIsData: true });
  try { if (out.stderr) process.stderr.write(out.stderr); } catch { /* stderr gone */ }
}

/**
 * A usage / invalid-input error (exit 2 via the registry): `invalid_params`
 * by default, `unknown_flag` / `unknown_command` for those cases.
 */
export function usageError(
  message: string,
  suggestion: string,
  opts: OpErrorOpts & { code?: Extract<RegistryCode, 'invalid_params' | 'unknown_flag' | 'unknown_command'> } = {},
): OperationError {
  const { code = 'invalid_params', ...rest } = opts;
  return opError(code, message, suggestion, rest);
}

/**
 * D3: `unknown_flag` with a did-you-mean drawn from `candidates`: the
 * command's curated help flags when it has a help module, else the generated
 * acceptance registry / op params (the caller resolves them, so this module
 * stays free of the command table's import closure).
 */
export function unknownFlagError(command: string, flag: string, message: string, candidates: readonly string[] = []): OperationError {
  const bare = flag.split('=')[0];
  const nearest = suggestNearest(bare, candidates.filter(c => c !== bare));
  const suggestion = nearest
    ? `Did you mean ${nearest}? Run \`gbrain ${command} --help\` for the accepted flags.`
    : `Run \`gbrain ${command} --help\` for the accepted flags.`;
  return usageError(nearest ? `${message} (did you mean ${nearest}?)` : message, suggestion, {
    code: 'unknown_flag',
    fix: { argv: ['gbrain', command, '--help'], consent: [], actor: 'agent', why: 'The help lists every flag this command accepts.', requires_exclusive: false },
  });
}

/**
 * The fatal seam (main() rejected). Same renderer, plus the two pre-v1
 * behaviours agents and skills depend on: the `pglite_busy` JSON keys
 * (`next_action`) and the `GBRAIN_DB_ACCESS` marker line skills/db-repair
 * literal-matches, with the classifier's remediation.
 */
export function writeFatalCliError(e: unknown, opts: { argv?: readonly string[]; dbUrl?: string | null; brainId?: string } = {}): number {
  const argv = opts.argv ?? process.argv.slice(2);
  const command = cliCommandOf(argv);
  const busy = e as { code?: unknown; reason?: unknown; message?: unknown } | null;
  if (busy?.code === 'pglite_busy') {
    const next = 'Wait for the current command or server to close, then retry. Do not remove a live lock.';
    // A7: a live serve owns the brain (usually an agent session's stdio serve), so
    // waiting never ends; the fix is the two-step plan: stop that serve, then re-run this command.
    const owner = liveServeOwner(e);
    const fix = owner ? exclusiveFix({ argv: ['gbrain', ...argv], consent: [], actor: 'agent', requires_exclusive: true,
      why: 'Re-runs this command once it has the brain to itself.' }, owner) : undefined;
    const suggestion = fix
      ? 'A live gbrain serve owns this brain, so waiting does not end. Ask the user to stop it (fix), then re-run this command (fix.then). Do not remove a live lock.'
      : next;
    const err = opError('pglite_busy', String(busy.message ?? 'The brain is busy.'), suggestion, {
      ...(typeof busy.reason === 'string' ? { reason: busy.reason } : {}),
      ...(fix ? { fix } : {}),
    });
    return writeCliError(err, command, { argv, legacy: { error: 'pglite_busy', retryable: true, reason: busy.reason, next_action: next } });
  }
  if (!jsonRequested(argv)) {
    try {
      const d = classifyPgAccessError(e, { url: opts.dbUrl ?? null, brainId: opts.brainId });
      if (d.reason !== 'unknown') {
        if (shouldEmitDbAccessMarker()) process.stderr.write(`${formatDbAccessMarker(d)}\n`);
        const raw = (e instanceof Error && e.message) || String(e);
        const safe = redactConnectionInfo(redactUrlsInText(raw));
        process.stderr.write(`Error [database_error]: ${safe}\n${d.remediation} Run: gbrain db-repair\n`);
        return 1;
      }
    } catch { /* classifier failure: the generic renderer below still reports it */ }
  }
  return writeCliError(e, command, { argv });
}
