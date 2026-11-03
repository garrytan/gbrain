/** gbrain ingest-undo: preview (exit 3), then retract what one ingest attempt created, through the trusted-local op layer. Docs: docs/guides/ingest.md#undo. */
import type { BrainEngine } from '../core/engine.ts';
import { handleToolCall } from '../mcp/server.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { writeCliError } from '../cli/cli-error.ts';
import { flag, positional } from './ingest.ts';

export async function runIngestUndoCli(engine: BrainEngine, args: string[]): Promise<void> {
  if (!positional(args)) {
    process.stdout.write('gbrain ingest-undo <attempt_id> [--yes --expect <plan_hash>] [--json] — preview (exit 3), then retract what one ingest attempt created. Docs: docs/guides/ingest.md#undo\n');
    setCliExitVerdict(2);
    return;
  }
  const json = args.includes('--json');
  try {
    const expect = flag(args, '--expect');
    const result = await handleToolCall(engine, 'ingest_undo', { attempt_id: positional(args), ...(args.includes('--yes') ? { yes: true } : {}), ...(expect ? { expect } : {}) }) as Record<string, unknown>;
    if (json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else {
      process.stdout.write(String(result.summary) + '\n');
      if (result.status === 'preview') process.stdout.write('Apply: gbrain ingest-undo ' + result.attempt_id + ' --yes --expect ' + result.plan_hash + '\n');
    }
    setCliExitVerdict(result.status === 'preview' ? 3 : 0);
  } catch (error) {
    setCliExitVerdict(writeCliError(error, 'ingest-undo'));
  }
}
