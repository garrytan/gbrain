/**
 * foresights inbox — the drop folder that turns files into pages.
 *
 *   foresights inbox [status]        where the inbox is, what is waiting, what was archived today
 *   foresights inbox run --once      capture every file waiting now, then exit
 *   foresights inbox run             keep watching; capture each file as it lands (Ctrl-C stops)
 *
 * Options: --dir <path> (default ~/.gbrain/inbox), --source <id> (the source the
 * pages land in; default: the brain's default source), --json.
 *
 * Each text, markdown, HTML or JSON file becomes an `ingest_capture`: on a
 * Postgres brain it is queued for the job worker (`foresights jobs work`, which
 * autopilot runs); on a PGLite brain, which has no worker, it is captured right
 * away. The file then moves to .archived/YYYY-MM-DD/, so the original is kept.
 * `--once` archives a file only after its capture was queued or written, so a
 * failure leaves it in the inbox. A file no processor can read yet (PDF, image,
 * audio, video) stays in the inbox with a note; convert it to text first.
 * Captures are content-addressed: the same bytes again apply once.
 */
import { join, relative } from 'path';
import { existsSync, readdirSync } from 'fs';
import type { BrainEngine } from '../core/engine.ts';
import { gbrainPath } from '../core/config.ts';
import {
  createInboxFolderSource,
  listInboxFiles,
  processInboxOnce,
  archiveDateFolder,
} from '../core/ingestion/sources/inbox-folder.ts';
import type { IngestionEvent, IngestionSourceContext } from '../core/ingestion/types.ts';
import type { Logger } from '../core/operations.ts';

const USAGE = `Usage: foresights inbox [status|run] [--once] [--dir <path>] [--source <id>] [--json]
  status          where the inbox is, what is waiting, what was archived today (default)
  run --once      capture every file waiting now, then exit
  run             keep watching and capture each file as it lands (Ctrl-C stops)
  --dir <path>    the inbox folder (default ~/.gbrain/inbox)
  --source <id>   the source the pages land in (default: the default source)
  --json          machine-readable output`;

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined; // the CLI entry splits --flag=value (cli/flag-equals.ts)
}

/** The capture key: one capture per source and content, the same as a queued job's idempotency key. */
export function inboxCaptureKey(sourceId: string | undefined, contentHash: string): string {
  return `ingest:inbox:${sourceId ?? 'default'}:${contentHash}`;
}

/**
 * Deliver one inbox event: queue it on a brain with a worker, capture it now on PGLite (no worker).
 * Resolves true when the capture was queued or written.
 */
export function makeInboxDelivery(engine: BrainEngine, sourceId: string | undefined, logger: Logger): (event: IngestionEvent) => Promise<boolean> {
  return async (event) => {
    const data = { event, ...(sourceId ? { sourceId } : {}) };
    const key = inboxCaptureKey(sourceId, event.content_hash);
    try {
      if (engine.kind === 'pglite') {
        const { makeIngestCaptureHandler } = await import('../core/minions/handlers/ingest-capture.ts');
        const never = new AbortController().signal;
        await makeIngestCaptureHandler(engine)({
          id: 0, name: 'ingest_capture', data, attempts_made: 1, idempotency_key: key, signal: never, deadlineAtMs: null,
          shutdownSignal: never, updateProgress: async () => {}, updateTokens: async () => {}, log: async () => {},
          isActive: async () => true, readInbox: async () => [],
        });
      } else {
        const { MinionQueue } = await import('../core/minions/queue.ts');
        await new MinionQueue(engine).add('ingest_capture', data, { idempotency_key: key });
      }
      return true;
    } catch (err) {
      logger.warn(`inbox: ${event.metadata?.original_filename ?? event.source_uri} was not captured: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };
}

function stderrLogger(json: boolean): Logger {
  return {
    info: (m: string) => { if (!json) process.stderr.write(`${m}\n`); },
    warn: (m: string) => process.stderr.write(`${m}\n`),
    error: (m: string) => process.stderr.write(`${m}\n`),
  } as Logger;
}

function sourceContext(engine: BrainEngine, logger: Logger, signal: AbortSignal): IngestionSourceContext {
  return { emit: () => {}, engine, logger, abortSignal: signal, config: {} };
}

function archivedToday(inboxDir: string): number {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- the operator's own inbox folder (--dir or ~/.gbrain/inbox) joined with fixed segments (.archived, a YYYY-MM-DD date)
  const dir = join(inboxDir, '.archived', archiveDateFolder(new Date()));
  return existsSync(dir) ? readdirSync(dir).length : 0;
}

export async function runInbox(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return; }
  const sub = args[0] && !args[0].startsWith('--') ? args[0] : 'status';
  const inboxDir = flagValue(args, '--dir') ?? gbrainPath('inbox');
  const sourceId = flagValue(args, '--source');
  const json = args.includes('--json');
  const logger = stderrLogger(json);

  if (sub === 'status') {
    const waiting = listInboxFiles(inboxDir).map(f => relative(inboxDir, f));
    const report = { inbox: inboxDir, exists: existsSync(inboxDir), waiting, archived_today: archivedToday(inboxDir) };
    if (json) { console.log(JSON.stringify(report, null, 2)); return; }
    console.log(`Inbox: ${inboxDir}${report.exists ? '' : ' (not created yet; foresights inbox run creates it)'}`);
    console.log(`Waiting: ${waiting.length}${waiting.length ? `\n${waiting.slice(0, 20).map(f => `  ${f}`).join('\n')}${waiting.length > 20 ? '\n  ...' : ''}` : ''}`);
    console.log(`Archived today: ${report.archived_today}`);
    if (waiting.length) console.log('Capture them with: foresights inbox run --once');
    return;
  }

  if (sub !== 'run') { console.error(USAGE); process.exitCode = 1; return; }
  const deliver = makeInboxDelivery(engine, sourceId, logger);
  const where = engine.kind === 'pglite' ? 'written as pages' : 'queued for the job worker (foresights jobs work; autopilot runs one)';

  if (args.includes('--once')) {
    const { mkdirSync } = await import('fs');
    mkdirSync(inboxDir, { recursive: true });
    const r = await processInboxOnce({ inboxDir, textOnly: true, deliver }, sourceContext(engine, logger, new AbortController().signal));
    const rel = (fs: string[]) => fs.map(f => relative(inboxDir, f));
    if (r.failed.length) process.exitCode = 1;
    if (json) {
      console.log(JSON.stringify({ inbox: inboxDir, captured: rel(r.emitted), left_unreadable: rel(r.held), failed: rel(r.failed), skipped: rel(r.skipped),
        delivery: engine.kind === 'pglite' ? 'written' : 'queued' }, null, 2));
      return;
    }
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- display only: the operator's own inbox folder and the fixed .archived name; nothing is read or written
    console.log(`${r.emitted.length} file(s) ${where}; originals moved to ${join(inboxDir, '.archived')}.`);
    if (r.held.length) console.log(`${r.held.length} file(s) left in the inbox: no processor reads them yet. Convert them to text or markdown first.`);
    if (r.failed.length) console.log(`${r.failed.length} file(s) failed and stay in the inbox; see the messages above, then run this again.`);
    return;
  }

  const { IngestionDaemon } = await import('../core/ingestion/daemon.ts');
  const daemon = new IngestionDaemon({
    engine, logger,
    dispatch: async (event) => (await deliver(event)) ? { kind: 'queued' } : { kind: 'failed', error: 'capture failed' },
  });
  daemon.register({ source: createInboxFolderSource({ inboxDir, textOnly: true }) });
  await daemon.start();
  logger.info(`Watching ${inboxDir}: each text or markdown file dropped here is ${where}. Ctrl-C stops.`);
  await new Promise<void>(resolve => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await daemon.stop();
}
