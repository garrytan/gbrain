/** gbrain ingest-show: read an ingest report through the trusted-local op layer (no provider calls). Docs: docs/guides/ingest.md. */
import type { BrainEngine } from '../core/engine.ts';
import { handleToolCall } from '../mcp/server.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { writeCliError } from '../cli/cli-error.ts';
import { out, positional } from './ingest.ts';

export async function runIngestShowCli(engine: BrainEngine, args: string[]): Promise<void> {
  if (!positional(args)) {
    process.stdout.write('gbrain ingest-show <attempt_id> [--json] — read an ingest report (read-only, no provider calls). Docs: docs/guides/ingest.md\n');
    setCliExitVerdict(2);
    return;
  }
  const json = args.includes('--json');
  try {
    const report = await handleToolCall(engine, 'ingest', { attempt_id: positional(args) }) as Record<string, unknown>;
    out(json, report);
    setCliExitVerdict(report.status === 'failed' ? 1 : 0);
  } catch (error) {
    setCliExitVerdict(writeCliError(error, 'ingest-show'));
  }
}
