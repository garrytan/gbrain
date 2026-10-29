/**
 * Wave B write operations, CLI side (spec 6.1, 6.2, 6.5).
 *
 *   gbrain append <slug> [--file PATH]     append text to the end of a page
 *   gbrain put <slug> --file PATH          replace or create a page from a file
 *
 * `append` calls append_page with a generated request_id (`--request-id`
 * replays one) whenever the call's encoded frame fits the connection's part
 * cap (spec 6.2): 4 MiB less 4 KiB locally, on a remote brain the cap its
 * begin_page_upload reports. Only a larger append goes through an upload
 * session with mode `append`.
 * `put --file` (and `capture --file`) send one request while the page fits
 * it (the trusted local CLI: the page ceiling; a thin client: the smallest
 * transport cap). A larger file on the trusted local CLI streams through the
 * import's two-pass reader into this process's engine (spec 3.1); a thin
 * client, a managed brain or one a serve holds takes it through an upload
 * session. Neither holds the file as one string. Every other call goes where
 * any CLI write goes: the remote brain on a thin client, the resident owner
 * when a serve holds the brain, else this process's engine.
 */
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { BrainEngine } from '../../core/engine.ts';
import type { CliDispatchContext } from '../command-table.ts';
import { loadConfig, isThinClient } from '../../core/config.ts';
import { getCliOptions } from '../../core/cli-options.ts';
import { currentCliWriteWait } from '../../core/persistence/write-wait.ts';
import { RemoteMcpError } from '../../core/remote-mcp-error.ts';
import { OperationError, opError } from '../../core/ops/contract.ts';
import { PAGE_MAX_BYTES } from '../../core/page-size-policy.ts';
import type { ImportResult } from '../../core/import-file.ts';
import { FRONTMATTER_HEAD_MAX_BYTES } from '../../core/page-body/limits.ts';
import { maybeDelegateLocalOperation, residentPersistenceConfig } from '../../core/persistence/local-client.ts';
import { inspectLockHolder } from '../../core/pglite-lock.ts';
import { detectBinaryNullByte, detectBinarySignature } from '../../core/capture-content.ts';
import { readStdinPayload } from '../../core/stdin-read.ts';
import { finishCliTeardown, setCliExitVerdict, writeStdoutFinal } from '../../core/cli-force-exit.ts';
import { usageError, writeCliError } from '../cli-error.ts';
import { callRemoteTool, stringUploadBody, toolCallFrameBytes, unpackToolResult, uploadPageBody, type UploadBody, type UploadToolCall } from '../../core/mcp-client.ts';

/** The smallest inbound cap any transport has (legacy HTTP, 1 MiB) less the 4 KiB envelope reserve: a request this size reaches every brain. */
export const DIRECT_FRAME_MAX_BYTES = 1024 * 1024 - 4096;
/** The part cap of a local or stdio connection (4 MiB less the 4 KiB reserve), the largest frame any connection takes in one call. */
export const LOCAL_FRAME_MAX_BYTES = 4 * 1024 * 1024 - 4096;

/** Where a CLI write goes, plus the transient-failure test the upload driver resumes on. */
export interface PageWriteCaller {
  thin: boolean;
  call: UploadToolCall;
  transient(error: unknown): boolean;
  close(): Promise<void>;
}

/**
 * The CLI's route for page writes: `callRemoteTool` on a thin client, the
 * resident owner's socket when a serve holds this brain, else this process's
 * engine (connected on first use, torn down by `close`). `source` is the
 * `--source` flag; locally it resolves through the ambient chain, on a thin
 * client it travels as `source_id` and the host's grant decides. `teardown:
 * false` leaves an engine `connect` shares with the caller to the caller.
 */
export function pageWriteCaller(connect: () => Promise<BrainEngine>, source: string | null, opts: { teardown?: boolean } = {}): PageWriteCaller {
  const cfg = loadConfig();
  const cli = getCliOptions();
  const writeWaitMs = currentCliWriteWait().waitMs;
  if (isThinClient(cfg)) {
    return {
      thin: true,
      call: async (tool, args) => {
        const raw = await callRemoteTool(cfg!, tool, { ...args, ...(source ? { source_id: source } : {}) }, { timeoutMs: cli.timeoutMs ?? 120_000, writeWaitMs });
        return unpackToolResult<Record<string, unknown>>(raw);
      },
      transient: error => error instanceof RemoteMcpError && error.reason === 'network' && error.detail?.kind !== 'aborted',
      close: async () => {},
    };
  }
  let engine: BrainEngine | undefined;
  let sourceId: string | undefined;
  return {
    thin: false,
    call: async (tool, args) => {
      const wire = { ...args };
      const delegated = await maybeDelegateLocalOperation(tool, wire, cfg, { brain: cli.brain, source, timeoutMs: cli.timeoutMs ?? undefined, writeWaitMs });
      if (delegated.handled) return delegated.result as Record<string, unknown>;
      engine ??= await connect();
      if (sourceId === undefined) {
        const { resolveSourceWithTier } = await import('../../core/source-resolver.ts');
        sourceId = (await resolveSourceWithTier(engine, source)).source_id;
      }
      const { handleToolCall } = await import('../../mcp/server.ts');
      return await handleToolCall(engine, tool, wire, { sourceId, writeWaitMs }) as Record<string, unknown>;
    },
    transient: () => false,
    close: async () => { if (engine && opts.teardown !== false) await finishCliTeardown({ engine, drainTimeoutMs: 1000 }); },
  };
}

const utf8 = () => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function notUtf8(label: string): OperationError {
  return opError('invalid_params', `${label} is not valid UTF-8 text.`,
    'Pages store UTF-8 text, so nothing was written. Convert the input to UTF-8 (for example with iconv) and run the command again.');
}

/** Refuses binary input by its head, the way capture does: a magic-byte signature or a NUL in the first 8 KiB. */
function assertTextHead(head: Buffer, label: string): void {
  const format = detectBinarySignature(head);
  const nul = detectBinaryNullByte(head);
  if (format === null && nul === -1) return;
  throw opError('invalid_params', `${label} is binary${format ? ` (${format})` : `: a NUL byte at offset ${nul}`}, not text.`,
    'Pages store text, so nothing was written. Extract the text first (for a PDF: pdftotext FILE -), then write that.');
}

/** Decodes bytes as strict UTF-8 after the binary guard; a BOM is kept so the stored bytes match the input. */
export function decodeTextInput(raw: Buffer, label: string): string {
  assertTextHead(raw.subarray(0, 8192), label);
  try { return utf8().decode(raw); } catch { throw notUtf8(label); }
}

/** A file as an upload body: hashed in one streaming pass, read again in order (strict UTF-8) for the parts. */
export async function fileUploadBody(path: string): Promise<UploadBody> {
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    assertTextHead(head.subarray(0, bytesRead), path);
  } finally { await handle.close(); }
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk as Buffer); bytes += (chunk as Buffer).length; }
  return {
    bytes,
    sha256: hash.digest('hex'),
    async *text(fromByte: number) {
      const decoder = utf8();
      try {
        for await (const chunk of createReadStream(path, { start: fromByte })) {
          const text = decoder.decode(chunk as Buffer, { stream: true });
          if (text) yield text;
        }
        const tail = decoder.decode();
        if (tail) yield tail;
      } catch (error) {
        if (error instanceof TypeError) throw notUtf8(path);
        throw error;
      }
    },
  };
}

async function reportFailure(error: unknown, command: string, json: boolean, requestId: string | undefined): Promise<void> {
  const { reportPersistenceCliError } = await import('../../commands/persistence-delegate.ts');
  const receipt = !(error instanceof OperationError) || !!error.writeRequest;
  if (!receipt || !await reportPersistenceCliError(error, json || !!(error as OperationError)?.writeRequest)) setCliExitVerdict(writeCliError(error, command));
  if (requestId) process.stderr.write(`Retry the same ${command} with --request-id ${requestId}.\n`);
}

const HELP = `Usage: gbrain append <slug> [--file PATH] [options]
       gbrain append <slug> [options] < file

Adds text to the end of a page in time proportional to the text added
(append_page). Use it for conversation logs and running notes: re-putting a
large page to add a message rewrites the whole page.

Options:
  --file PATH            Read the text from a file (default: stdin)
  --request-id UUID      Replay an earlier append (retries never double-append)
  --expected-revision R  Append only to this revision of the page
  --expect-tail SHA256   Append only if the region still ends with this tail
                         (get_page body:'none' returns tail_sha256)
  --region R             auto (default: the last non-empty region), truth, timeline
  --separator S          auto (default: one newline when the tail lacks one), none
  --source ID            Multi-source brains: append to a page in this source
  --json                 Print the receipt as JSON
  --help, -h             Show this help

Text whose call is over the connection's part cap (4 MiB less 4 KiB locally;
on a remote brain the cap it reports) goes through an upload session (begin,
parts, commit), which appends at the end of the page with region and
separator auto; --expect-tail, --region and --separator are refused there.

Examples:
  echo "- 14:02 the next message" | gbrain append conversations/sessions/2026-10-19-standup
  gbrain append notes/running-log --file ./today.md --request-id 5f0c…
`;

interface AppendArgs {
  slug?: string; file?: string; request_id?: string; expected_revision?: string; expected_tail_sha256?: string;
  region?: string; separator?: string; source?: string; json: boolean; help: boolean;
}

const APPEND_FLAGS: Record<string, keyof AppendArgs> = {
  '--file': 'file', '--request-id': 'request_id', '--expected-revision': 'expected_revision', '--expect-tail': 'expected_tail_sha256',
  '--region': 'region', '--separator': 'separator', '--source': 'source',
};
const CHOICES: Partial<Record<keyof AppendArgs, readonly string[]>> = { region: ['auto', 'truth', 'timeline'], separator: ['auto', 'none'] };

export function parseAppendArgs(args: string[]): AppendArgs {
  const out: AppendArgs = { json: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') { if (args[i + 1] !== undefined && out.slug === undefined) out.slug = args[++i]; continue; }
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    if (arg === '--json') { out.json = true; continue; }
    const m = /^(--[a-z-]+)(?:=(.*))?$/.exec(arg);
    if (m && APPEND_FLAGS[m[1]!]) {
      const key = APPEND_FLAGS[m[1]!]!;
      const value = m[2] ?? args[++i];
      if (value === undefined || value === '' || (m[2] === undefined && value.startsWith('--'))) throw usageError(`${m[1]} requires a value.`, 'Run gbrain append --help for the options.');
      const choices = CHOICES[key];
      if (choices && !choices.includes(value)) throw usageError(`${m[1]} must be one of: ${choices.join(', ')}; got '${value}'.`, 'Run gbrain append --help for the options.');
      (out as unknown as Record<string, unknown>)[key] = value;
      continue;
    }
    if (arg.startsWith('--')) throw usageError(`unknown flag ${arg.split('=')[0]} for 'gbrain append'`, 'Run gbrain append --help for the options.');
    if (out.slug !== undefined) throw usageError(`gbrain append takes one slug; got '${out.slug}' and '${arg}'.`, 'Pass the text with --file or on stdin, not as arguments.');
    out.slug = arg;
  }
  return out;
}

/** @internal The whole-file read `gbrain append --file` does for a file within one call's part cap; a test seam proves larger files are never read whole. */
export const appendFileIo = { readFileSync: (path: string): Buffer => readFileSync(path) };

const UPLOAD_ONLY_FLAGS = { expected_tail_sha256: '--expect-tail', region: '--region', separator: '--separator' } as const;

/** Refuses the flags an upload session cannot carry (it appends at the end with region and separator auto, unchecked). */
function refuseUploadFlags(parsed: AppendArgs, cap: number, size: string): void {
  const flags = (Object.keys(UPLOAD_ONLY_FLAGS) as Array<keyof typeof UPLOAD_ONLY_FLAGS>).filter(key => parsed[key] !== undefined).map(key => UPLOAD_ONLY_FLAGS[key]);
  if (!flags.length) return;
  throw usageError(`${flags.join(', ')} apply only to an append whose call fits this connection's ${cap}-byte part cap; this one is ${size}.`,
    'A larger append goes through an upload session, which appends at the end with region and separator auto and cannot check the tail. Drop those flags, or split the text into smaller appends.');
}

/**
 * The text to append: a string when it can fit one call (stdin, or a file of
 * at most LOCAL_FRAME_MAX_BYTES), otherwise the file as a streamed upload
 * body. A file is sized before it is read: one over the page ceiling (the most
 * an append upload carries) is refused unread, and one over the part cap is
 * never read whole.
 */
async function readAppendInput(parsed: AppendArgs, cap: number): Promise<{ text: string } | { body: UploadBody }> {
  if (parsed.file) {
    let size: number;
    try { size = statSync(parsed.file).size; } catch (error) {
      throw usageError(`Cannot read ${parsed.file}: ${error instanceof Error ? error.message : String(error)}`, 'Pass --file a readable text file.');
    }
    if (size > PAGE_MAX_BYTES) {
      throw opError('request_too_large', `${parsed.file} is ${size} bytes, over the ${PAGE_MAX_BYTES}-byte limit of one append; nothing was read or appended.`,
        'Split the text into several appends, each at most that size.');
    }
    if (size > LOCAL_FRAME_MAX_BYTES) {
      refuseUploadFlags(parsed, cap, `at least ${size} bytes`);
      return { body: await fileUploadBody(parsed.file) };
    }
    return { text: decodeTextInput(appendFileIo.readFileSync(parsed.file), parsed.file) };
  }
  if (process.stdin.isTTY) throw usageError('gbrain append needs text: pass --file PATH or pipe it on stdin.', 'Run gbrain append --help for examples.');
  const read = await readStdinPayload('echo "the next message" | gbrain append <slug>');
  if (!read.ok) throw usageError(read.message, 'Pipe the text on stdin, or pass --file PATH.');
  return { text: decodeTextInput(read.raw, 'stdin') };
}

function printAppendReceipt(result: Record<string, unknown>, json: boolean): Promise<void> {
  if (json) return writeStdoutFinal(JSON.stringify(result, null, 2) + '\n');
  const receipt = result.write_request as { state?: string; request_id?: string } | undefined;
  if (receipt?.state && receipt.state !== 'committed') {
    process.stderr.write(`Append ${receipt.state}; request_id ${receipt.request_id}. Retry the same request ID for its result.\n`);
    return Promise.resolve();
  }
  const lines = [`appended: ${String(result.slug)}`];
  for (const key of ['revision', 'appended_bytes', 'body_bytes', 'chunks_new', 'size_state']) {
    if (result[key] !== undefined) lines.push(`  ${key}: ${String(result[key])}`);
  }
  if (receipt?.request_id) lines.push(`  request_id: ${receipt.request_id}`);
  return writeStdoutFinal(lines.join('\n') + '\n');
}

/** `gbrain append` (a pre-connect-own-engine command: it opens the engine only when no owner or remote brain takes the call). */
export async function run(args: string[], ctx: CliDispatchContext): Promise<void> {
  let parsed: AppendArgs;
  try { parsed = parseAppendArgs(args); } catch (error) { setCliExitVerdict(writeCliError(error, 'append')); return; }
  if (parsed.help) { console.log(HELP); return; }
  const requestId = parsed.request_id ?? randomUUID();
  let caller: PageWriteCaller | undefined;
  try {
    if (!parsed.slug) throw usageError("Missing required parameter 'slug' for 'gbrain append'.", 'Usage: gbrain append <slug> [--file PATH] (see `gbrain append --help`).');
    caller = pageWriteCaller(() => ctx.connectEngine(), parsed.source ?? null);
    let cap = caller.thin ? DIRECT_FRAME_MAX_BYTES : LOCAL_FRAME_MAX_BYTES;
    const input = await readAppendInput(parsed, cap);
    if ('text' in input ? input.text.length === 0 : input.body.bytes === 0) throw usageError('Nothing to append: the text is empty.', 'Pass non-empty text with --file or on stdin.');
    const begin = { slug: parsed.slug, mode: 'append', request_id: requestId, ...(parsed.expected_revision ? { expected_revision: parsed.expected_revision } : {}) };
    const upload = (body: UploadBody, begun?: Record<string, unknown>) => uploadPageBody(caller!.call, begin, body,
      { transient: caller!.transient, wait_ms: Math.min(currentCliWriteWait().waitMs, 30_000), ...(begun ? { begun } : {}) });
    let result: Record<string, unknown>;
    if ('body' in input) {
      result = await upload(input.body);
    } else {
      const params: Record<string, unknown> = {
        slug: parsed.slug, text: input.text, request_id: requestId,
        ...(parsed.expected_revision ? { expected_revision: parsed.expected_revision } : {}),
        ...(parsed.expected_tail_sha256 ? { expected_tail_sha256: parsed.expected_tail_sha256 } : {}),
        ...(parsed.region ? { region: parsed.region } : {}),
        ...(parsed.separator ? { separator: parsed.separator } : {}),
      };
      const frame = toolCallFrameBytes('append_page', params);
      const body = stringUploadBody(input.text);
      let begun: Record<string, unknown> | undefined;
      if (frame > cap && caller.thin && frame <= LOCAL_FRAME_MAX_BYTES) {
        begun = await caller.call('begin_page_upload', { ...begin, total_bytes: body.bytes, sha256: body.sha256 });
        cap = Number(begun.part_max_frame_bytes);
        if (frame <= cap) {
          await caller.call('abort_page_upload', { upload_id: begun.upload_id });
          begun = undefined;
        }
      }
      if (frame <= cap) result = await caller.call('append_page', params);
      else {
        try { refuseUploadFlags(parsed, cap, `${frame} bytes`); } catch (error) {
          if (begun) await caller.call('abort_page_upload', { upload_id: begun.upload_id }).catch(() => undefined);
          throw error;
        }
        result = await upload(body, begun);
      }
    }
    await printAppendReceipt(result, parsed.json);
  } catch (error) {
    await reportFailure(error, 'append', parsed.json, requestId);
  } finally {
    await caller?.close();
  }
}

/** `--file PATH` / `--file=PATH` taken out of put's argv (before a bare `--`), and the args left. */
function takeFileArg(args: string[]): { path: string | undefined; rest: string[] } {
  const rest = [...args];
  for (let i = 0; i < rest.length && rest[i] !== '--'; i++) {
    if (rest[i] === '--file') return { path: rest[i + 1]?.startsWith('--') ? undefined : rest[i + 1], rest: [...rest.slice(0, i), ...rest.slice(i + 2)] };
    if (rest[i]!.startsWith('--file=')) return { path: rest[i]!.slice('--file='.length) || undefined, rest: [...rest.slice(0, i), ...rest.slice(i + 1)] };
  }
  return { path: undefined, rest };
}

/** Flags whose put_page semantics need the whole page as one request (or, for dry_run, write nothing). */
const ONE_REQUEST_ONLY = ['allow_empty', 'allow_shrink', 'drop_timeline', 'dry_run'] as const;

/**
 * `gbrain put <slug> --file PATH` (main.ts runs it before parsing put's args).
 * A page that fits one put_page request (the page ceiling locally, the
 * smallest transport cap on a thin client) returns false with `args` now
 * carrying the file as put's stdin param (content), so the ordinary put
 * dispatch sends it. A larger
 * file returns true after writing: on the trusted local CLI it streams through
 * the import's two-pass reader into this process's engine (spec 3.1), never
 * held as one string, when the brain is unmanaged; a thin client, a managed
 * brain (its coordinator admits a file only from the source root) or one a
 * serve holds takes it through an upload session, still streamed in parts.
 * Failures are rendered here, so true also means "done".
 */
export async function runPutFile(op: { name: string; cliHints?: { stdin?: string } }, args: string[], opts: {
  parse: (op: never, args: string[]) => Record<string, unknown>;
  connect: () => Promise<BrainEngine>;
  format: (op: string, result: unknown, params: Record<string, unknown>) => string;
}): Promise<boolean> {
  const { path, rest } = takeFileArg(args);
  let params: Record<string, unknown> = {};
  let caller: PageWriteCaller | undefined;
  let engine: Promise<BrainEngine> | undefined;
  const connect = () => engine ??= opts.connect();
  try {
    if (!path) throw usageError('--file requires a value.', 'Pass --file a readable text file.');
    params = opts.parse(op as never, rest);
    let size: number;
    try { size = statSync(path).size; } catch (error) {
      throw usageError(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`, 'Pass --file a readable text file.');
    }
    const thin = isThinClient(loadConfig());
    if (size <= PAGE_MAX_BYTES) {
      const content = decodeTextInput(readFileSync(path), path);
      if (!thin || toolCallFrameBytes('put_page', { ...params, content }) <= DIRECT_FRAME_MAX_BYTES) {
        args.splice(0, args.length, `--${op.cliHints?.stdin ?? 'content'}=${content}`, ...rest);
        return false;
      }
    }
    const flags = ONE_REQUEST_ONLY.filter(key => params[key] !== undefined && params[key] !== false);
    if (flags.length) {
      throw usageError(`${flags.map(key => `--${key.replace(/_/g, '-')}`).join(', ')} apply only to a page that fits one put_page request.`, `${path} is larger than one request. Drop those flags.`);
    }
    const source = typeof params.source === 'string' ? params.source : typeof params.source_id === 'string' ? params.source_id : null;
    if (!thin) {
      const streamed = await streamLocalPage(connect, path, String(params.slug), source, params);
      if (streamed) {
        const output = opts.format('put_page', streamed, params);
        if (output) await writeStdoutFinal(output);
        return true;
      }
    }
    if (params.force === true && typeof params.expected_revision !== 'string') {
      throw usageError('--force applies only to a page that fits one put_page request or streams locally.', `${path} goes through an upload session, which replaces a page only with --expected-revision. Pass the page's revision (gbrain get --json).`);
    }
    caller = pageWriteCaller(connect, source, { teardown: false });
    const result = await uploadPageBody(caller.call, {
      slug: params.slug, mode: typeof params.expected_revision === 'string' ? 'replace' : 'create',
      request_id: typeof params.request_id === 'string' ? params.request_id : (params.request_id = randomUUID()),
      ...(typeof params.expected_revision === 'string' ? { expected_revision: params.expected_revision } : {}),
    }, await fileUploadBody(path), {
      transient: caller.transient,
      wait_ms: typeof params.wait_ms === 'number' ? params.wait_ms : Math.min(currentCliWriteWait().waitMs, 30_000),
    });
    const output = opts.format('put_page', result, params);
    if (output) await writeStdoutFinal(output);
  } catch (error) {
    await reportFailure(error, 'put', params.json === true, typeof params.request_id === 'string' ? params.request_id : undefined);
  } finally {
    await caller?.close();
    if (engine) await finishCliTeardown({ engine: await engine, drainTimeoutMs: 1000 });
  }
  return true;
}

/**
 * A local file over the page ceiling written as page `slug` by the import's
 * two-pass streamed reader (spec 3.1) in this process's engine, with put's
 * revision precondition (`expected_revision` / `force` in `params`; a new
 * page needs neither). `head` replaces the file's first `skip` bytes
 * (capture's merged frontmatter). Returns null when this process cannot be the
 * writer: a serve holds the PGLite brain, or the brain is managed (its
 * coordinator takes a file outside the source root only through an upload
 * session).
 */
async function streamLocalPage(connect: () => Promise<BrainEngine>, path: string, slug: string, source: string | null, params: Record<string, unknown>,
  content: { head?: { skip: number; bytes: Uint8Array }; provenance?: { source_kind: string | null; source_uri: string | null; ingested_via: string | null } } = {}): Promise<ImportResult | null> {
  const resident = residentPersistenceConfig(loadConfig());
  if (resident?.engine === 'pglite' && resident.database_path && !resident.database_url) {
    const holder = inspectLockHolder(resident.database_path);
    if (holder.held && holder.pid !== process.pid) return null;
  }
  const engine = await connect();
  const [{ readManagedMode }, { readPageBodyPolicy }, { slugifyPath }, { resolveSourceWithTier }, { assertPageRevision }, { engineMutationPrecondition, parseMutationPrecondition }, { importStreamedMarkdownFile }] = await Promise.all([
    import('../../core/persistence/managed-mode.ts'), import('../../core/page-body/limits.ts'), import('../../core/sync.ts'), import('../../core/source-resolver.ts'),
    import('../../core/page-state/types.ts'), import('../../core/persistence/preconditions.ts'), import('../../core/page-body/streamed-import.ts')]);
  if (await readManagedMode(engine)) return null;
  const policy = await readPageBodyPolicy(engine);
  const stat = statSync(path);
  if (!policy.segmented || stat.size > policy.maxBytes) {
    throw opError('invalid_params', `File too large (${stat.size} bytes, max ${policy.segmented ? policy.maxBytes : PAGE_MAX_BYTES}).`,
      `${path} is over the single-string page ceiling and ${policy.segmented ? 'over pages.max_bytes' : 'segmented page storage (pages.segmented_storage) is off'}, so nothing was written. Split the file into smaller pages.`);
  }
  const relativePath = `${slug}.md`;
  if (!slug || slugifyPath(relativePath) !== slug) {
    throw usageError(`'${slug}' is not a canonical page slug.`, `A page over the single-string ceiling is written under its canonical slug; use '${slugifyPath(relativePath)}'.`);
  }
  const { source_id: sourceId } = await resolveSourceWithTier(engine, source);
  assertPageRevision(await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true }), engineMutationPrecondition(parseMutationPrecondition(params)));
  const result = await importStreamedMarkdownFile(engine, resolve(path), relativePath, { sourceId, inferFrontmatter: false, content }, stat, policy);
  if (result.status === 'skipped' && result.error) {
    throw opError(result.refusal?.code === 'invalid_frontmatter' ? 'invalid_frontmatter' : result.refusal?.code === 'visibility_noncanonical' ? 'visibility_not_applied' : 'invalid_params', result.error,
      `${path} was not written as ${slug}: fix what the message names (or split the file into smaller pages) and run the command again.`);
  }
  return result;
}

/**
 * `computeContentHash(normalizeForHash(text))` of a UTF-8 file without holding
 * it: the BOM and surrounding whitespace dropped, CRLF folded, NFKC applied per
 * run of whole lines (a newline is a normalization boundary). Null when the
 * normalized text is empty.
 */
export async function normalizedFileHash(path: string): Promise<string | null> {
  const hasher = createHash('sha256');
  const decoder = utf8();
  let pending = '';
  let started = false;
  const take = (final: boolean) => {
    pending = pending.replace(/\r\n/g, '\n');
    if (!started) { pending = pending.replace(/^\s+/, ''); if (!pending) return; started = true; }
    const end = pending.search(/\s*$/);
    const cut = final ? end : pending.lastIndexOf('\n', end - 1) + 1;
    if (cut > 0) hasher.update(pending.slice(0, cut).normalize('NFKC'));
    pending = final ? '' : pending.slice(cut);
  };
  try {
    for await (const chunk of createReadStream(path)) { pending += decoder.decode(chunk as Buffer, { stream: true }); take(false); }
    pending += decoder.decode();
  } catch (error) {
    if (error instanceof TypeError) throw notUtf8(path);
    throw error;
  }
  take(true);
  return started ? hasher.digest('hex') : null;
}

/** A capture's receipt fields, for capture.ts printReceipt. */
export interface StreamedCapture { slug: string; status?: string; chunks?: number; content_hash: string }

/**
 * `gbrain capture --file` over the page ceiling on the trusted local CLI:
 * the capture op's slug (from the normalized content hash) and frontmatter
 * merge are computed from a streamed hash and the file head, and the body
 * streams through the import's reader (spec 3.1). Null when this process
 * cannot be the writer (a serve holds the brain, or it is managed): the caller
 * reads the file and takes the upload path.
 */
export async function streamLocalCapture(path: string, input: CaptureUploadInput & { request_id?: string }, connect: () => Promise<BrainEngine>): Promise<StreamedCapture | null> {
  const handle = await open(path, 'r');
  let head: Buffer;
  try {
    head = Buffer.alloc(Math.min(FRONTMATTER_HEAD_MAX_BYTES, (await handle.stat()).size));
    head = head.subarray(0, (await handle.read(head, 0, head.length, 0)).bytesRead);
  } finally { await handle.close(); }
  assertTextHead(head.subarray(0, 8192), path);
  const bom = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
  const lineEnd = head.lastIndexOf(0x0a);
  if (lineEnd < bom) throw opError('invalid_params', `${path} has no line break in its first ${FRONTMATTER_HEAD_MAX_BYTES} bytes.`, 'A capture this large is written by its head and its streamed body; add line breaks to the file and capture it again.');
  let headText: string;
  try { headText = utf8().decode(head.subarray(bom, lineEnd + 1)); } catch { throw notUtf8(path); }
  if (/^---\r?\n/.test(headText) && !/\n---\r?\n/.test(headText)) {
    throw opError('invalid_frontmatter', `${path}'s frontmatter does not close within its first ${FRONTMATTER_HEAD_MAX_BYTES} bytes.`, 'Close the frontmatter block with a --- line near the top of the file, then capture it again.');
  }
  const contentHash = await normalizedFileHash(path);
  if (!contentHash) throw opError('invalid_params', 'Capture requires nonempty text.', `${path} is empty or whitespace, so nothing was captured.`);
  const { explicitCaptureType, mergeCaptureFrontmatter, slugPrefixForType } = await import('../../core/capture-content.ts');
  const type = explicitCaptureType(headText, input.type) ?? 'note';
  const slug = input.slug?.toLowerCase() ?? `${slugPrefixForType(type)}/${new Date().toISOString().slice(0, 10)}-${contentHash.slice(0, 8)}`;
  const merged = mergeCaptureFrontmatter(headText, { type, capturedVia: 'capture-cli',
    ...Object.fromEntries((['who', 'what', 'where', 'kind', 'depth'] as const).filter(key => input[key] !== undefined).map(key => [key, input[key]])) });
  const result = await streamLocalPage(connect, path, slug, input.source ?? null,
    { ...(input.expected_revision ? { expected_revision: input.expected_revision } : {}), ...(input.force ? { force: true } : {}) },
    { head: { skip: lineEnd + 1 - bom, bytes: Buffer.from(merged, 'utf8') }, provenance: { source_kind: null, source_uri: 'cli-file', ingested_via: null } });
  return result && { slug: result.slug, status: result.status, chunks: result.chunks, content_hash: contentHash };
}

/** The capture options an upload of a large capture honors (capture.ts RunOpts). */
export interface CaptureUploadInput {
  slug?: string; type?: string; who?: string; what?: string; where?: string; kind?: string; depth?: string;
  source?: string; expected_revision?: string; force?: boolean;
}

/**
 * `capture --file` with a page larger than one request: the trusted local
 * CLI over the page ceiling, a thin client over the smallest transport cap.
 * The capture op's own admission composes the default slug and the capture
 * frontmatter (page-mutations.ts); an upload session carries a finished page,
 * so this composes them the same way before uploading.
 */
export async function uploadCapture(rawBody: string, input: CaptureUploadInput, requestId: string, connect: () => Promise<BrainEngine>): Promise<Record<string, unknown>> {
  if (input.force && !input.expected_revision) {
    throw usageError('--force applies only to a capture that fits one request.',
      'This capture is larger than one request, so it goes through an upload session, which replaces a page only with --expected-revision. Read the page revision with gbrain get --json and pass it.');
  }
  const caller = pageWriteCaller(connect, input.source ?? null, { teardown: false });
  const { defaultSlug, explicitCaptureType, mergeCaptureFrontmatter, normalizeForHash } = await import('../../core/capture-content.ts');
  const type = explicitCaptureType(rawBody, input.type) ?? 'note';
  const slug = input.slug ?? defaultSlug(normalizeForHash(rawBody), new Date(), type);
  const content = mergeCaptureFrontmatter(rawBody, {
    type, capturedVia: caller.thin ? 'capture-mcp' : 'capture-cli',
    ...Object.fromEntries((['who', 'what', 'where', 'kind', 'depth'] as const).filter(key => input[key] !== undefined).map(key => [key, input[key]])),
  });
  try {
    const result = await uploadPageBody(caller.call, {
      slug, mode: input.expected_revision ? 'replace' : 'create', request_id: requestId,
      ...(input.expected_revision ? { expected_revision: input.expected_revision } : {}),
    }, stringUploadBody(content), { transient: caller.transient, wait_ms: Math.min(currentCliWriteWait().waitMs, 30_000) });
    return { slug, ...result };
  } finally {
    await caller.close();
  }
}

/** Whether a capture's params are over one request on this route: the page ceiling locally, the smallest transport cap on a thin client. */
export function captureNeedsUpload(params: Record<string, unknown>, thin: boolean): boolean {
  if (thin) return toolCallFrameBytes('capture', params) > DIRECT_FRAME_MAX_BYTES;
  return typeof params.content === 'string' && Buffer.byteLength(params.content, 'utf8') > PAGE_MAX_BYTES;
}
