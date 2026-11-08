/**
 * `gbrain sources record-origin <id>... --remote|--local [--apply] [--json]`: record who added older URL sources
 * (`url-source-origin.ts`), for the ids the operator names. Preview unless --apply; exit 1 when any id is refused,
 * 2 on a usage error. Trusted local CLI only; no MCP operation reaches it.
 */
import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { recordSourceOrigin, type SourceOrigin } from '../core/url-source-origin.ts';

const USAGE = 'Usage: gbrain sources record-origin <id>... --remote|--local [--apply] [--json]';

export async function runRecordOrigin(engine: BrainEngine, args: string[]): Promise<void> {
  const ids = args.filter(arg => !arg.startsWith('-'));
  const flags = args.filter(arg => arg.startsWith('-'));
  const origins = flags.filter(flag => flag === '--remote' || flag === '--local');
  if (!ids.length || origins.length !== 1 || flags.some(flag => !['--remote', '--local', '--apply', '--json'].includes(flag))) {
    console.error(USAGE);
    process.exit(2);
  }
  const report = await recordSourceOrigin(engine, ids, { origin: origins[0]!.slice(2) as SourceOrigin, apply: flags.includes('--apply'), remote: false });
  if (flags.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    for (const result of report.results) console.log(`[${result.source_id}] ${result.status}${result.code ? ` (${result.code})` : ''}: ${result.reason}`);
    if (!report.apply && report.results.some(result => result.status === 'would_record'))
      console.log(`(preview; nothing changed) Apply with: gbrain sources record-origin ${report.results.filter(result => result.status === 'would_record').map(result => result.source_id).join(' ')} --${report.origin} --apply`);
  }
  if (report.results.some(result => result.status === 'refused')) setCliExitVerdict(1);
}
