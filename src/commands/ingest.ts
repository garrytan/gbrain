/**
 * gbrain ingest / ingest-show / ingest-undo — save a pasted document and undo one attempt. Every path dispatches through
 * the trusted-local op layer (handleToolCall, remote:false), so the CLI and the ingest / ingest_undo MCP tools share one
 * behaviour. Exit codes: 0 complete, 1 failed, 2 invalid input, 3 undo preview, 10 pending writes, 11 incomplete or
 * resumable (docs/guides/exit-codes.md). Docs: docs/guides/ingest.md.
 */
import { readFileSync, statSync } from 'node:fs';
import type { BrainEngine } from '../core/engine.ts';
import { handleToolCall } from '../mcp/server.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { writeCliError } from '../cli/cli-error.ts';
import { opError } from '../core/ops/contract.ts';
import { INGEST_MAX_CHARS } from '../core/ingest/extract.ts';
import { readStdinPayload } from '../core/stdin-read.ts';

const VALUE_FLAGS = new Set(['--file', '--type', '--title', '--slug', '--source', '--valid-from', '--visibility', '--max-usd', '--request-id', '--attempt', '--expect', '--brain']);

export function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

export function positional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.has(args[i]!)) { i++; continue; }
    if (args[i] === '--') return args[i + 1];
    if (!args[i]!.startsWith('-')) return args[i];
  }
  return undefined;
}

const inputError = (reason: string, message: string, suggestion: string) =>
  opError('ingest_input_invalid', message, 'Nothing was written. ' + suggestion, { reason, docs: 'docs/guides/ingest.md#errors' });

async function readStdin(): Promise<string> {
  const read = await readStdinPayload('gbrain ingest --stdin < transcript.txt', { maxBytes: INGEST_MAX_CHARS * 4 });
  if (!read.ok) throw inputError('unreadable', read.message, 'Pass the document with --file <path>, or pipe it and close stdin.');
  return read.text;
}

async function readDocument(args: string[]): Promise<string> {
  const file = flag(args, '--file');
  const stdin = args.includes('--stdin');
  if (file && stdin) throw inputError('conflicting', 'Both --file and --stdin were passed.', 'Pass one of them.');
  if (!file && !stdin) throw inputError('missing', 'No document was passed.', 'Pass --file <path> or --stdin.');
  if (stdin) return readStdin();
  try {
    if (statSync(file!).size > INGEST_MAX_CHARS * 4) throw inputError('too_large', 'File ' + file + ' is over ' + INGEST_MAX_CHARS * 4 + ' bytes.', 'Split it into parts of at most ' + INGEST_MAX_CHARS + ' characters.');
    return readFileSync(file!, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT' || (error as { code?: string }).code === 'EACCES' || (error as { code?: string }).code === 'EISDIR') {
      throw inputError('unreadable', 'File ' + file + ' cannot be read (' + (error as { code: string }).code + ').', 'Check the path and its permissions.');
    }
    throw error;
  }
}

function exitFor(report: Record<string, unknown>): number {
  if (report.dry_run === true) return 0;
  if (report.status === 'failed') return 1;
  if (report.status === 'pending') return 10;
  if (report.complete === false || report.status === 'incomplete') return 11;
  return 0;
}

function render(report: Record<string, unknown>): string {
  const lines = [String(report.summary ?? '')];
  if (report.attempt_id) lines.push('attempt: ' + report.attempt_id + '  storage: ' + report.storage + '  status: ' + report.status);
  for (const pg of (report.pages as Array<Record<string, unknown>> | undefined) ?? []) {
    lines.push('  page ' + pg.status + ': ' + (pg.slug || pg.name) + (pg.reason ? ' (' + pg.reason + ')' : '') + (Array.isArray(pg.near_names) && pg.near_names.length ? ' near ' + (pg.near_names as Array<{ slug: string }>).map(n => n.slug).join(', ') : ''));
  }
  for (const a of (report.actions as Array<Record<string, unknown>> | undefined) ?? []) lines.push('  next (' + a.kind + '): ' + (a.argv as string[]).join(' '));
  return lines.join('\n');
}

export function out(json: boolean, value: Record<string, unknown>): void {
  process.stdout.write((json ? JSON.stringify(value, null, 2) : render(value)) + '\n');
}

export async function runIngestCli(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  try {
    const attempt = flag(args, '--attempt');
    const maxUsd = flag(args, '--max-usd');
    const params: Record<string, unknown> = { content: await readDocument(args) };
    const map: Array<[string, string]> = [['--type', 'type'], ['--title', 'title'], ['--slug', 'slug'], ['--source', 'source_id'], ['--valid-from', 'valid_from'], ['--visibility', 'visibility'], ['--request-id', 'request_id']];
    for (const [f, key] of map) { const v = flag(args, f); if (v !== undefined) params[key] = v; }
    if (maxUsd !== undefined) params.max_usd = Number(maxUsd);
    if (args.includes('--no-facts')) params.no_facts = true;
    if (args.includes('--trusted-extraction')) params.trusted_extraction = true;
    if (args.includes('--dry-run')) params.dry_run = true;
    if (args.includes('--resume')) { params.resume = true; if (attempt) params.attempt_id = attempt; }
    process.stderr.write('[ingest] reading ' + (params.content as string).length + ' characters\n');
    const report = await handleToolCall(engine, 'ingest', params) as Record<string, unknown>;
    process.stderr.write('[ingest] done elapsed_ms=' + report.elapsed_ms + '\n');
    out(json, report);
    setCliExitVerdict(exitFor(report));
  } catch (error) {
    setCliExitVerdict(writeCliError(error, 'ingest'));
  }
}
