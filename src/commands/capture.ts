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
import matter from 'gray-matter';
import type { BrainEngine } from '../core/engine.ts';
import { loadConfig, isThinClient } from '../core/config.ts';
import { callRemoteTool, unpackToolResult, RemoteMcpError } from '../core/mcp-client.ts';
import { computeContentHash } from '../core/ingestion/types.ts';
import { operations } from '../core/operations.ts';
import type { OperationContext } from '../core/operations.ts';
import { resolveSourceWithTier } from '../core/source-resolver.ts';

interface RunOpts {
  content?: string;
  filePath?: string;
  stdin?: boolean;
  slug?: string;
  type?: string;
  source?: string;
  quiet?: boolean;
  json?: boolean;
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
    if (a.startsWith('--')) continue; // unknown flag, ignore
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
    Different --type values write to the SAME slug for the same content
    (slug = content hash), so a later capture with a different --type
    overwrites the prior page.

Examples:
  gbrain capture "remember to follow up on the X deal"
  echo "from a pipe" | gbrain capture --stdin
  gbrain capture --file ./notes/today.md --slug daily/2026-05-20
  JOB=$(gbrain capture "..." --quiet)
`;

// v0.42.x — Life Chronicle (#2390): route the default slug prefix by type so
// `gbrain capture --type diary` lands under life/diary/ and `--type event`
// under life/events/ (matching the chronicle path-prefix inference). Everything
// else keeps the inbox/ default.
function slugPrefixForType(type?: string): string {
  if (type === 'diary') return 'life/diary';
  if (type === 'event') return 'life/events';
  return 'inbox';
}
function defaultSlug(content: string, now: Date = new Date(), type?: string): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const hashPrefix = computeContentHash(content).slice(0, 8);
  return `${slugPrefixForType(type)}/${y}-${m}-${d}-${hashPrefix}`;
}

/**
 * v0.39.3.0 CV10 — binary file guard. Scans the first 8KB of `buf` for a
 * NUL byte (0x00). Real text files (including UTF-8 with multi-byte CJK,
 * emoji, BOM) never contain a NUL byte at any position — text encoding
 * uses non-zero continuation bytes. NUL appears in binary formats:
 * executables, archives, compressed images, PDFs (after the magic-byte
 * header), most office documents. Single-pass scan; constant memory.
 *
 * Returns the 0-indexed byte offset of the first NUL, or -1 if clean.
 * Caller decides the error shape (message vs JSON envelope).
 *
 * Known limit: a PNG-without-NUL-in-first-8KB slips through. v0.39
 * magic-byte allowlist (per CV10-B + TODOS.md) closes this hole. The
 * 8KB ceiling bounds the scan cost to ~microseconds even on huge files.
 */
export function detectBinaryNullByte(buf: Buffer): number {
  const limit = Math.min(buf.length, 8 * 1024);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return i;
  }
  return -1;
}

async function readStdinBuffer(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

/**
 * v0.39.3.0 CV9 — normalize content for content_hash so identical text
 * produces identical hashes regardless of leading/trailing whitespace,
 * line-ending style (CRLF vs LF), or Unicode normalization form. The
 * STORED body is preserved as-is (CRLF stays CRLF, BOM stays BOM).
 *
 * Two concerns, two transforms — the hash gets aggressive normalization
 * for dedup correctness; the stored body keeps user bytes for round-trip
 * fidelity. CQ2's CRLF/BOM preservation tests rely on this split.
 */
export function normalizeForHash(s: string): string {
  // Strip BOM, normalize line endings to LF, trim, NFKC for Unicode-stable hash.
  return s.replace(/^﻿/, '').replace(/\r\n/g, '\n').trim().normalize('NFKC');
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
 * Derive a title from the first non-empty, non-`---` line of the body,
 * stripping leading markdown heading marks, capped at 80 chars.
 * Falls back to 'Capture' when no usable line exists.
 */
function deriveTitle(rawBody: string): string {
  const firstLine = rawBody
    .split('\n')
    .find((l) => l.trim().length > 0 && l.trim() !== '---') ?? '';
  return firstLine.replace(/^#+\s*/, '').slice(0, 80) || 'Capture';
}

/**
 * v0.39.3.0 (BUG-1): merge capture's auto-stamped fields with any existing
 * frontmatter in `rawBody`, rather than always prepending a second
 * frontmatter block. The pre-fix code stamped its own `---` block on top
 * of files that already had frontmatter, producing `title: '---'` (the
 * file's opening delimiter became the outer title) and two consecutive
 * frontmatter blocks the parser interpreted as the outer block + a body
 * starting with a horizontal rule.
 *
 * Precedence rules (user-wins by default):
 *   - `type`:         opts.type (CLI flag) > userFm.type > 'note'
 *   - `title`:        userFm.title > derived-from-body
 *   - `captured_via`: userFm.captured_via > opts.source > 'capture-cli'
 *                     (CV3/Phase 3c will narrow this to always 'capture-cli';
 *                     for Phase 2a we preserve current semantics)
 *   - `captured_at`:  userFm.captured_at > now (user can pre-stamp for retroactive
 *                     captures; see CQ2 test case 4)
 *   - Any other user-declared keys (description, tags, slug, etc.) pass through verbatim.
 *
 * For files WITHOUT existing frontmatter, preserves the original behavior:
 * stamps a fresh frontmatter block, and if the body doesn't already look
 * like markdown (no `#` heading), wraps it under a `# {title}` heading.
 */
// v0.42.x — Life Chronicle (#2390): assemble the `event:` frontmatter block
// from the --who/--what/--where/--kind/--depth flags (only for --type event).
// Returns undefined when no event flags are set so non-event captures are
// untouched.
function buildEventBlock(opts: RunOpts): Record<string, unknown> | undefined {
  if (opts.type !== 'event') return undefined;
  const who = opts.who ? opts.who.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const block: Record<string, unknown> = {};
  if (opts.what) block.what = opts.what;
  if (who.length) block.who = who;
  if (opts.where) block.where = opts.where;
  if (opts.kind) block.kind = opts.kind;
  if (opts.depth) block.depth = opts.depth;
  return Object.keys(block).length ? block : undefined;
}

export function mergeCaptureFrontmatter(rawBody: string, opts: RunOpts): string {
  const nowIso = new Date().toISOString();
  // Detect frontmatter: leading `---\n` or `---\r\n`, tolerating leading BOM/whitespace.
  // We do NOT use the more permissive `startsWith('---')` because a body that opens
  // with a horizontal-rule like `--- separator ---` would false-positive.
  const trimmedStart = rawBody.replace(/^﻿/, '');
  const hasFrontmatter = /^---\r?\n/.test(trimmedStart);

  if (!hasFrontmatter) {
    // No existing frontmatter: stamp a fresh block and (if body lacks markdown
    // structure) wrap under a derived heading.
    const title = deriveTitle(rawBody);
    const fm: Record<string, unknown> = {
      type: opts.type ?? 'note',
      title,
      captured_via: opts.source ?? 'capture-cli',
      captured_at: nowIso,
    };
    const ev = buildEventBlock(opts);
    if (ev) fm.event = ev;
    const looksMarkdown = /^#{1,6}\s/.test(rawBody.trimStart());
    const body = looksMarkdown ? rawBody : `# ${title}\n\n${rawBody}`;
    return matter.stringify(body, fm);
  }

  // Existing frontmatter: parse, merge user-wins, re-emit as a SINGLE block.
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(rawBody);
  } catch (e) {
    throw new Error(
      `malformed frontmatter in capture input: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const userFm = (parsed.data ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = {
    // Spread user's declared keys first so 'description', 'tags', etc. pass through.
    ...userFm,
    // Then apply auto-fields with the precedence rules above. The explicit
    // assignment AFTER the spread is intentional: it lets us implement the
    // mixed precedence (CLI flag wins for `type`; user wins for `title`/
    // `captured_via`/`captured_at`) in one expression per key.
    type: opts.type ?? userFm.type ?? 'note',
    title: userFm.title ?? deriveTitle(parsed.content),
    captured_via: userFm.captured_via ?? opts.source ?? 'capture-cli',
    captured_at: userFm.captured_at ?? nowIso,
  };
  // v0.42.x — merge the event block (user-declared keys win per-key).
  const ev = buildEventBlock(opts);
  if (ev || userFm.event) {
    merged.event = { ...(ev ?? {}), ...((userFm.event as Record<string, unknown>) ?? {}) };
  }
  return matter.stringify(parsed.content, merged);
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
}

export async function runCapture(engine: BrainEngine | null, args: string[]): Promise<void> {
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

  // CV15: route source resolution through the canonical 6-tier chain
  // (flag → env → dotfile → local_path → brain_default → seed_default).
  // resolveSourceWithTier handles the assertSourceExists check and throws
  // a friendly error BEFORE put_page is called if the source is missing.
  // Only run on the LOCAL path — thin-client has no engine handle to
  // probe the sources table; CV7 above already rejected explicit --source
  // on thin-client. Implicit source resolution on thin-client uses
  // 'default' (the server's auth layer scopes the actual write).
  let resolvedSourceId = 'default';
  if (!isThinClient(cfg) && engine) {
    try {
      const { source_id } = await resolveSourceWithTier(engine, parsed.source ?? null);
      resolvedSourceId = source_id;
    } catch (e) {
      // assertSourceExists throws "Source 'X' not found. Available sources: ..."
      console.error(`gbrain capture: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  }

  // CV8 (CLI side): content_hash for the RECEIPT comes from the normalized
  // rawBody, NOT the assembled fullContent which contains a timestamp.
  // The daemon's 24h LRU dedup keys on this hash; identical captures must
  // produce identical hashes. The DB content_hash (importFromContent at
  // src/core/import-file.ts) gets the same treatment in Phase 3d.
  const slug = parsed.slug ?? defaultSlug(normalizedBody, new Date(), parsed.type);
  const fullContent = buildContent(rawBody, parsed);
  const capturedAt = new Date().toISOString();
  const contentHash = computeContentHash(normalizedBody);

  // Thin-client install: route through put_page over MCP. The server's
  // write-through plumbing handles disk persistence. Per CV6 trust gate,
  // the server overrides ANY provenance params we send to `mcp:put_page`
  // — so we deliberately do NOT thread source_kind/source_uri/ingested_via
  // through the wire (would be discarded server-side, and we don't want
  // to suggest the values reached the DB column when they didn't).
  if (isThinClient(cfg)) {
    let raw: unknown;
    try {
      raw = await callRemoteTool(
        cfg!,
        'put_page',
        { slug, content: fullContent },
        { timeoutMs: 30_000 },
      );
    } catch (e) {
      // A2/T1: detect server-side FK violation and rewrite to friendly hint.
      // RemoteMcpError wraps the server's error envelope; the underlying
      // PG message is in the wrapped string.
      const hint = maybeRewriteSourceFkError(e, parsed.source ?? resolvedSourceId);
      if (hint) {
        console.error(`gbrain capture: ${hint}`);
      } else if (e instanceof RemoteMcpError) {
        console.error(`gbrain capture: remote put_page failed: ${e.message}`);
        console.error('Run `gbrain remote doctor` to diagnose the connection.');
      } else {
        console.error(
          `gbrain capture: remote put_page failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        console.error('Run `gbrain remote doctor` to diagnose the connection.');
      }
      process.exit(1);
    }
    const remoteResult = unpackToolResult<{
      slug: string;
      status?: string;
      chunks?: number;
      write_through?: { written: boolean; path?: string };
    }>(raw);
    const result: CaptureResult = {
      slug: remoteResult.slug,
      status: remoteResult.status,
      chunks: remoteResult.chunks,
      content_hash: contentHash,
      written: remoteResult.write_through?.written ?? false,
      path: remoteResult.write_through?.path,
      // CV3: source_kind ALWAYS 'capture-cli' for capture invocations,
      // regardless of --source. --source maps to source_id (the DB FK),
      // not the ingestion-channel taxonomy. Conflating these was the
      // root cause of WARN-8's audit-trail labeling problem.
      source_kind: 'capture-cli',
      captured_at: capturedAt,
    };
    printReceipt(result, parsed.quiet ?? false, parsed.json ?? false);
    return;
  }

  // Local install: route through put_page operation directly so we
  // exercise the same write-through path the MCP server uses.
  if (!engine) {
    console.error('gbrain capture: engine not connected');
    process.exit(1);
  }
  const putPageOp = operations.find((o) => o.name === 'put_page');
  if (!putPageOp) {
    console.error('gbrain capture: put_page operation missing (gbrain build issue)');
    process.exit(1);
  }
  const ctx: OperationContext = {
    engine,
    config: cfg ?? { engine: 'pglite' as const },
    logger: {
      info: (msg: string) => { process.stderr.write(`[capture] ${msg}\n`); },
      warn: (msg: string) => { process.stderr.write(`[capture] WARN: ${msg}\n`); },
      error: (msg: string) => { process.stderr.write(`[capture] ERROR: ${msg}\n`); },
    },
    dryRun: false,
    remote: false,
    // v0.39.3.0 CV15: thread the resolved source from the canonical 6-tier
    // chain (was `parsed.source ?? 'default'` pre-fix, which silently
    // ignored env / dotfile / local_path / brain_default tiers — divergent
    // from every other CLI op's behavior).
    sourceId: resolvedSourceId,
  };
  try {
    // v0.39.3.0 WARN-8: pass provenance params to put_page. CV3 source_kind
    // is always 'capture-cli'; ingested_via is 'put_page' (the write API),
    // source_uri identifies the file path or stdin marker.
    const sourceUri = parsed.filePath
      ? `file://${parsed.filePath}`
      : parsed.stdin
        ? 'stdin'
        : 'cli-positional';
    const result = (await putPageOp.handler(ctx, {
      slug,
      content: fullContent,
      source_kind: 'capture-cli',
      source_uri: sourceUri,
      ingested_via: 'capture-cli',
    })) as {
      slug: string;
      status?: string;
      chunks?: number;
      write_through?: { written: boolean; path?: string; skipped?: string };
    };
    printReceipt(
      {
        slug: result.slug,
        status: result.status,
        chunks: result.chunks,
        content_hash: contentHash,
        written: result.write_through?.written ?? false,
        path: result.write_through?.path,
        // CV3: source_kind is the channel taxonomy, NOT the DB source FK.
        source_kind: 'capture-cli',
        captured_at: capturedAt,
      },
      parsed.quiet ?? false,
      parsed.json ?? false,
    );
  } catch (e) {
    // A2: detect FK violation on sources table and rewrite to friendly hint.
    // resolveSourceWithTier above usually catches missing sources upstream,
    // but a TOCTOU race (source deleted between pre-flight and put_page) or
    // an explicit --source bypass would surface here.
    const hint = maybeRewriteSourceFkError(e, parsed.source ?? resolvedSourceId);
    if (hint) {
      console.error(`gbrain capture: ${hint}`);
    } else {
      console.error(
        `gbrain capture: put_page failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    process.exit(1);
  }
}

/** Test seam. */
export const __testing = {
  defaultSlug,
  buildContent,
  mergeCaptureFrontmatter,
  deriveTitle,
  parseArgs,
  detectBinaryNullByte,
  normalizeForHash,
  maybeRewriteSourceFkError,
};
