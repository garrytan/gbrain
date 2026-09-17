/**
 * gbrain capture — the single human-facing entrypoint for getting content
 * into the brain. Replaces the confusion of "do I call put_page, commit
 * a file, or wait for autopilot?" with one command that just works.
 *
 *   gbrain capture "thought to remember"
 *   gbrain capture --file ./notes/2026-05-20.md
 *   echo "from stdin" | gbrain capture --stdin
 *   gbrain capture "..." --slug inbox/specific
 *   gbrain capture "..." --quiet           # slug-only output for pipelines
 *
 * Behavior:
 *   - Local install: writes to ~/.gbrain/inbox/<slug>.md OR routes through
 *     put_page (which now writes through to disk via the v0.38 plumbing).
 *     Synchronous result with the slug, status, content_hash, and queue
 *     job id (when applicable).
 *   - Thin-client install: routes through callRemoteTool('put_page', ...)
 *     so the server's daemon handles ingestion. Same UX, transparent to
 *     the caller.
 *
 * Default slug: `inbox/YYYY-MM-DD-<sha8-of-content>`. Stable for same
 * content (the daemon's 24h content-hash dedup will catch duplicates if
 * you re-capture the same thought twice).
 *
 * Output:
 *   - Default: 5-line receipt block (slug, ingested_at, source_kind,
 *     content_hash, queue job id where applicable).
 *   - --quiet: just the slug on stdout for shell pipelines like
 *     `JOB=$(gbrain capture "..." --quiet)`.
 *   - --json: structured response for agents.
 */

import { readFileSync } from 'node:fs';
import type { BrainEngine } from '../core/engine.ts';
import { loadConfig, isThinClient } from '../core/config.ts';
import { callRemoteTool, unpackToolResult, RemoteMcpError } from '../core/mcp-client.ts';
import { computeContentHash } from '../core/ingestion/types.ts';
import { operations, OperationError } from '../core/operations.ts';
import type { OperationContext } from '../core/operations.ts';
import { resolveSourceWithTier } from '../core/source-resolver.ts';
// Pure content helpers moved to core (shared with the capture MCP op — the
// core module also breaks the capture.ts→operations.ts static import cycle).
// Re-exported below so existing importers/tests keep their entry point.
import {
  defaultSlug,
  detectBinaryNullByte,
  detectBinarySignature,
  normalizeForHash,
  deriveTitle,
  explicitCaptureType,
  mergeCaptureFrontmatter,
} from '../core/capture-content.ts';
import { randomUUID } from 'node:crypto';
import { parseMutationPrecondition } from '../core/persistence/preconditions.ts';
import { isWriteReceipt, type WriteReceipt } from '../core/persistence/types.ts';
import { maybeDelegateLocalOperation } from '../core/persistence/local-client.ts';
import { getCliOptions } from '../core/cli-options.ts';
import { reportPersistenceCliError } from './persistence-delegate.ts';

export { detectBinaryNullByte, normalizeForHash, mergeCaptureFrontmatter } from '../core/capture-content.ts';

interface RunOpts {
  content?: string;
  filePath?: string;
  stdin?: boolean;
  slug?: string;
  type?: string;
  source?: string;
  quiet?: boolean;
  json?: boolean;
  expected_revision?: string;
  request_id?: string;
  force?: boolean;
  // v0.42.x — Life Chronicle (#2390): manual `--type event` frontmatter sugar.
  who?: string;    // comma-separated entity slugs
  what?: string;
  where?: string;
  kind?: string;
  depth?: string;  // the depth page this event backlinks
}

function parseArgs(args: string[]): RunOpts | { help: true; positional: string | undefined } {
  const opts: RunOpts = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') return { help: true, positional: undefined };
    if (a === '--quiet' || a === '-q') { opts.quiet = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--stdin') { opts.stdin = true; continue; }
    if (a === '--force') { opts.force = true; continue; }
    const mutationFlag = /^--(request-id|expected-revision)(?:=(.*))?$/.exec(a);
    if (mutationFlag) {
      const value = mutationFlag[2] ?? args[++i];
      if (!value || value.startsWith('--')) throw new OperationError('invalid_params', `${mutationFlag[1]} requires a UUID.`);
      if (mutationFlag[1] === 'request-id') opts.request_id = value;
      else opts.expected_revision = value;
      continue;
    }
    if (a === '--file') {
      const v = args[++i];
      if (v) opts.filePath = v;
      continue;
    }
    if (a === '--slug') {
      const v = args[++i];
      if (v) opts.slug = v;
      continue;
    }
    if (a === '--type') {
      const v = args[++i];
      if (v) opts.type = v;
      continue;
    }
    if (a === '--source') {
      const v = args[++i];
      if (v) opts.source = v;
      continue;
    }
    // v0.42.x — Life Chronicle event sugar.
    if (a === '--who') { const v = args[++i]; if (v) opts.who = v; continue; }
    if (a === '--what') { const v = args[++i]; if (v) opts.what = v; continue; }
    if (a === '--where') { const v = args[++i]; if (v) opts.where = v; continue; }
    if (a === '--kind') { const v = args[++i]; if (v) opts.kind = v; continue; }
    if (a === '--depth') { const v = args[++i]; if (v) opts.depth = v; continue; }
    if (a.startsWith('--')) throw new OperationError('invalid_params', `Unsupported capture option '${a}'.`);
    positional.push(a);
  }
  if (positional.length > 0) {
    opts.content = positional.join(' ');
  }
  return opts;
}

const HELP = `Usage: gbrain capture [content] [options]

The single entrypoint for getting content into the brain. One command,
local OR thin-client, synchronous receipt with the resulting page slug.

Modes (mutually exclusive — first match wins):
  gbrain capture "thought"          inline content
  gbrain capture --file PATH        read content from a file
  gbrain capture --stdin            read content from stdin (piped)

Options:
  --slug SLUG          Override the default inbox/YYYY-MM-DD-<hash6> slug
  --type TYPE          Override the page type (default: note)
  --source ID          Multi-source brains: write under a non-default source.
                       Resolution: --source flag > GBRAIN_SOURCE env >
                       .gbrain-source dotfile (walk-up) > local_path >
                       brain_default > 'default'. NOT supported on
                       thin-client installs (server-side OAuth client
                       registration scopes the source).
  --quiet, -q          Print just the slug on stdout (for shell pipelines)
  --json               JSON output for agents
  --request-id UUID     Retry the same logical capture with its original UUID
  --expected-revision UUID  Replace only this version of an existing page
  --force              Explicitly replace an existing page without a revision
  --help, -h           Show this help

Notes:
  - Binary files (image/audio/video/pdf, anything with NUL bytes in the
    first 8KB) are rejected with a friendly error. Use a content-type
    processor skillpack for those when available.
  - Capturing identical text twice produces the same slug and the same
    content_hash (whitespace + line endings + Unicode form are normalized
    before hashing). The daemon's 24h LRU dedup uses this hash.
  - source_kind in the DB is ALWAYS 'capture-cli' for invocations of this
    command. --source maps to the source_id DB column, NOT to source_kind.
    Replacing an existing slug requires --expected-revision or --force.
    Keep --request-id unchanged when retrying the same capture.

Examples:
  gbrain capture "remember to follow up on the X deal"
  echo "from a pipe" | gbrain capture --stdin
  gbrain capture --file ./notes/today.md --slug daily/2026-05-20
  JOB=$(gbrain capture "..." --quiet)
`;


async function readStdinBuffer(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}


/**
 * v0.39.3.0 A2 + CV6 — detect Postgres FK violation on the sources table
 * in an error message and return a friendly hint. Returns null when the
 * error doesn't match. Used by BOTH the local-engine catch block AND
 * the thin-client (callRemoteTool) catch block per T1.
 *
 * Pattern coverage:
 *   - Postgres SQLSTATE 23503 message: 'insert or update on table "pages" violates
 *     foreign key constraint "pages_source_id_fk"'
 *   - postgres.js may wrap with extra context; substring match is enough
 *   - The MCP error envelope passes the message through unchanged (the
 *     server-side put_page op converts to OperationError but the underlying
 *     PG message is in the .cause chain)
 */
export function maybeRewriteSourceFkError(err: unknown, sourceId: string | undefined): string | null {
  if (!sourceId) return null;
  const msg = err instanceof Error ? err.message : String(err);
  // Match both the raw Postgres wording and OperationError-wrapped variants.
  const matchesFk = msg.includes('pages_source_id_fk')
    || (msg.includes('foreign key constraint') && msg.includes('source'));
  if (!matchesFk) return null;
  return `source '${sourceId}' is not registered. Register it first:\n  gbrain sources add ${sourceId} --path <path>\n\nList registered sources:\n  gbrain sources list`;
}


/**
 * Build the put_page content (frontmatter + body). The user's --type and
 * the auto-stamped capture provenance go in the frontmatter so future
 * tools (e.g. the inbox triage UI) can find captures.
 *
 * v0.39.3.0: delegates to `mergeCaptureFrontmatter` so files with existing
 * frontmatter merge instead of double-wrap (BUG-1).
 */
function buildContent(rawBody: string, opts: RunOpts): string {
  return mergeCaptureFrontmatter(rawBody, opts);
}

interface CaptureResult {
  slug: string;
  status?: string;
  chunks?: number;
  content_hash: string;
  written?: boolean;
  path?: string;
  source_kind: string;
  captured_at: string;
  revision?: string;
  write_request?: WriteReceipt;
}

function printReceipt(result: CaptureResult, quiet: boolean, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (quiet) {
    console.log(result.slug);
    return;
  }
  console.log('captured:');
  console.log(`  slug:          ${result.slug}`);
  console.log(`  status:        ${result.status ?? 'unknown'}`);
  console.log(`  content_hash:  ${result.content_hash.slice(0, 16)}…`);
  if (result.path) {
    console.log(`  file:          ${result.path}`);
  }
  console.log(`  captured_at:   ${result.captured_at}`);
  if (result.revision) console.log(`  revision:      ${result.revision}`);
  if (result.write_request) console.log(`  request_id:    ${result.write_request.request_id}`);
}

export async function runCapture(engine: BrainEngine | null, args: string[], options: { getEngine?: () => Promise<BrainEngine> } = {}): Promise<void> {
  const parsed = parseArgs(args);
  if ('help' in parsed) {
    console.log(HELP);
    return;
  }

  // v0.39.3.0 CV7: thin-client installs cannot scope --source via put_page
  // params. The server's auth/transport layer (OAuth client registration's
  // source_id / federated_read) determines source scope. Reject early with
  // a clear error pointing at the right fix; matches CV6 trust posture
  // (server owns the source scope, client cannot override per-call).
  const cfg = loadConfig();
  if (parsed.source && isThinClient(cfg)) {
    console.error(`gbrain capture: --source is not supported on thin-client installs.`);
    console.error(`Server-side OAuth client registration determines source scope.`);
    console.error(`On the server, run:`);
    console.error(`  gbrain auth register-client <name> --source ${parsed.source} --scopes "read write"`);
    process.exit(1);
  }

  // v0.39.3.0 CV10 — resolve content as a Buffer FIRST so the binary guard
  // sees real bytes (not UTF-8-decoded mojibake). Stdin uses the same
  // Buffer path so --stdin gets the same protection as --file.
  let rawBuffer: Buffer | null = null;
  let inputLabel = ''; // for error messages
  if (parsed.stdin) {
    rawBuffer = await readStdinBuffer();
    inputLabel = 'stdin';
  } else if (parsed.filePath) {
    inputLabel = parsed.filePath;
    try {
      // No encoding => returns Buffer; binary guard sees raw bytes.
      rawBuffer = readFileSync(parsed.filePath);
    } catch (e) {
      console.error(
        `gbrain capture: failed to read ${parsed.filePath}: ${e instanceof Error ? e.message : String(e)}`,
      );
      process.exit(1);
    }
  } else if (parsed.content) {
    // Positional content: already a JS string, but route through a Buffer
    // for guard parity (a positional string with a literal `\x00` would
    // also be rejected). Inline thoughts almost never trigger this; it's
    // pure defense-in-depth.
    rawBuffer = Buffer.from(parsed.content, 'utf8');
    inputLabel = 'positional content';
  } else {
    console.error('gbrain capture: provide content positionally, --file PATH, or --stdin');
    console.error('Run `gbrain capture --help` for examples.');
    process.exit(1);
  }

  // #4022 magic-byte guard runs FIRST: it names the actual format, and it
  // catches the containers the NUL scan structurally cannot (an ASCII-armored
  // PDF has no NUL in its head, so pre-fix it was decoded to mojibake and
  // stored as a page body with its real text silently dropped).
  const binaryFormat = detectBinarySignature(rawBuffer!);
  if (binaryFormat !== null) {
    console.error(
      `gbrain capture: refusing to capture ${binaryFormat} content from ${inputLabel}\n` +
      `  Detected by magic bytes. Storing it would write UTF-8 replacement characters as the\n` +
      `  page body — for container formats the real text is compressed, so it would be lost\n` +
      `  entirely while the command reported success.\n` +
      `  Extract the text first, then capture that. For a PDF:\n` +
      `    pdftotext ${inputLabel === 'stdin' ? 'input.pdf' : inputLabel} - | gbrain capture --stdin --slug <slug>`,
    );
    process.exit(1);
  }

  // CV10 binary guard. Scans the first 8KB for NUL bytes; rejects with a
  // friendly message before UTF-8 decode mangles arbitrary bytes.
  const nullByteOffset = detectBinaryNullByte(rawBuffer!);
  if (nullByteOffset !== -1) {
    console.error(
      `gbrain capture: refusing to capture binary content from ${inputLabel}\n` +
      `  Found null byte at offset ${nullByteOffset} (first 8KB scan); ` +
      `text files (including UTF-8 CJK/emoji/BOM) never contain NUL bytes.\n` +
      `  Binary content (image/audio/video/pdf) is not yet supported via capture — ` +
      `install a content-type processor skillpack when available.`,
    );
    process.exit(1);
  }

  // Decode to UTF-8 string AFTER the binary guard.
  const rawBody = rawBuffer!.toString('utf8');

  // CV9: refuse empty content based on the normalized form (whitespace-only
  // input is still empty), but preserve original bytes in storedBody for
  // the put_page write so CRLF / BOM / trailing-newline tests pass.
  const normalizedBody = normalizeForHash(rawBody);
  if (normalizedBody.length === 0) {
    console.error('gbrain capture: refusing to capture empty content');
    process.exit(1);
  }

  // Raw input and explicit options are the idempotency intent. The owner
  // materializes its default slug and capture timestamp once after admission;
  // retrying a CLI invocation must not produce a different digest.
  const contentHash = computeContentHash(normalizedBody);
  const capturedAt = new Date().toISOString();
  let resolvedSourceId = 'default';
  let requestId: string | undefined;
  try {
    const precondition = parseMutationPrecondition(parsed as unknown as Record<string, unknown>);
    requestId = precondition.request_id ?? randomUUID();
    const params: Record<string, unknown> = {
      content: rawBody,
      ...precondition,
      request_id: requestId,
      ...(parsed.slug ? { slug: parsed.slug } : {}),
      ...(parsed.type ? { type: parsed.type } : {}),
      ...(parsed.who ? { who: parsed.who } : {}),
      ...(parsed.what ? { what: parsed.what } : {}),
      ...(parsed.where ? { where: parsed.where } : {}),
      ...(parsed.kind ? { kind: parsed.kind } : {}),
      ...(parsed.depth ? { depth: parsed.depth } : {}),
      source_kind: 'capture-cli',
      source_uri: parsed.filePath ? `file://${parsed.filePath}` : parsed.stdin ? 'stdin' : 'cli-positional',
      ingested_via: 'capture-cli',
    };
    let result: Record<string, unknown>;
    if (isThinClient(cfg)) {
      const raw = await callRemoteTool(cfg!, 'capture', params, { timeoutMs: getCliOptions().timeoutMs ?? 30_000 });
      result = unpackToolResult<Record<string, unknown>>(raw);
    } else {
      const cli = getCliOptions();
      const delegated = await maybeDelegateLocalOperation('capture', params, cfg, {
        brain: cli.brain, source: parsed.source ?? null, timeoutMs: cli.timeoutMs ?? undefined,
      });
      if (delegated.handled) result = delegated.result as Record<string, unknown>;
      else {
        if (!engine && options.getEngine) engine = await options.getEngine();
        if (!engine) throw new OperationError('owner_unavailable', 'Capture requires a connected engine or a local persistence owner.');
        const resolved = await resolveSourceWithTier(engine, parsed.source ?? null);
        resolvedSourceId = resolved.source_id;
        const captureOp = operations.find(operation => operation.name === 'capture');
        if (!captureOp) throw new OperationError('unavailable', 'The capture operation is missing; upgrade this installation.');
        const ctx: OperationContext = {
          engine, config: cfg ?? { engine: 'pglite' }, sourceId: resolvedSourceId,
          remote: false, dryRun: false,
          logger: {
            info: (message: string) => process.stderr.write(`[capture] ${message}\n`),
            warn: (message: string) => process.stderr.write(`[capture] WARN: ${message}\n`),
            error: (message: string) => process.stderr.write(`[capture] ERROR: ${message}\n`),
          },
        };
        result = await captureOp.handler(ctx, params) as Record<string, unknown>;
      }
    }
    const receipt = isWriteReceipt(result.write_request) ? result.write_request : undefined;
    if (receipt && receipt.state !== 'committed') {
      // Accepted is a real receipt, but never a false claim that capture
      // finished. Quiet pipelines must not receive a made-up page slug.
      if (parsed.json) console.log(JSON.stringify(result, null, 2));
      else console.error(`Capture ${receipt.state}; request_id ${receipt.request_id}. Retry the same request ID for its result.`);
      return;
    }
    const persistence = result.persistence as { file_written?: boolean } | undefined;
    const writeThrough = result.write_through as { written?: boolean; path?: string } | undefined;
    printReceipt({
      slug: result.slug as string,
      status: result.status as string | undefined,
      chunks: result.chunks as number | undefined,
      content_hash: contentHash,
      written: persistence?.file_written ?? writeThrough?.written ?? false,
      path: writeThrough?.path,
      source_kind: 'capture-cli',
      captured_at: receipt?.created_at ?? capturedAt,
      ...(receipt ? { write_request: receipt } : {}),
      ...(typeof result.revision === 'string' ? { revision: result.revision } : {}),
    }, parsed.quiet ?? false, parsed.json ?? false);
  } catch (error) {
    if (await reportPersistenceCliError(error, parsed.json ?? false)) return;
    const hint = maybeRewriteSourceFkError(error, parsed.source ?? resolvedSourceId);
    console.error(`gbrain capture: ${hint ?? (error instanceof Error ? error.message : String(error))}`);
    if (requestId) console.error(`Retry the same capture with --request-id ${requestId}.`);
    if (parsed.json && error instanceof RemoteMcpError && error.detail?.write_request) {
      console.log(JSON.stringify({ ...error.detail, request_id: requestId }, null, 2));
    }
    const { setCliExitVerdict } = await import('../core/cli-force-exit.ts');
    setCliExitVerdict(1);
  }
}

/** Test seam. */
export const __testing = {
  defaultSlug,
  buildContent,
  mergeCaptureFrontmatter,
  deriveTitle,
  explicitCaptureType,
  parseArgs,
  detectBinaryNullByte,
  detectBinarySignature,
  normalizeForHash,
  maybeRewriteSourceFkError,
};
