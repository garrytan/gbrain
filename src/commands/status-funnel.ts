/**
 * `foresights status --funnel` (D8): the local, opt-in adoption funnel.
 *
 *   foresights status --funnel [--json]   counts per stage (never rates)
 *   foresights status --funnel --enable   start recording (creates ~/.gbrain/funnel.jsonl; GBRAIN_HOME moves it)
 *   foresights status --funnel --delete   delete the record, which stops recording
 *
 * Engine-free: it reads and writes only the local funnel file, so it works
 * before `foresights init` and on a thin client. Nothing is sent anywhere.
 */

import { deleteFunnel, enableFunnel, funnelPath, readFunnelReport } from '../core/funnel.ts';

export function runStatusFunnel(
  args: string[],
  opts: { stdout?: (s: string) => void; stderr?: (s: string) => void } = {},
): { exitCode: 0 | 2 } {
  const stdout = opts.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = opts.stderr ?? ((s: string) => process.stderr.write(s));
  const enable = args.includes('--enable');
  const del = args.includes('--delete');
  const other = args.filter(a => !['--funnel', '--enable', '--delete', '--json'].includes(a));
  if ((enable && del) || other.length) {
    stderr(`foresights status --funnel: ${enable && del ? 'choose --enable or --delete, not both' : `unexpected argument ${other[0]}`}. Usage: foresights status --funnel [--json] [--enable | --delete]\n`);
    return { exitCode: 2 };
  }
  if (enable) enableFunnel();
  const deleted = del ? deleteFunnel() : false;
  const report = readFunnelReport();
  if (args.includes('--json')) {
    stdout(JSON.stringify(report) + '\n');
    return { exitCode: 0 };
  }
  const lines: string[] = [];
  if (del) lines.push(deleted ? `Deleted ${funnelPath()}; recording is off.` : 'No funnel record to delete; recording is off.');
  else if (!report.enabled) lines.push('Adoption funnel: off (nothing is recorded).', 'Turn it on with `foresights status --funnel --enable`. It stays on this machine.');
  else {
    lines.push(`Adoption funnel: on since ${report.enabled_on ?? 'unknown'}, recorded in ${funnelPath()} (counts and dates only; nothing leaves this machine).`);
    for (const s of report.stages) lines.push(`  ${s.stage.padEnd(22)} ${String(s.count).padStart(5)}${s.first_on ? `   first ${s.first_on}` : ''}`);
    lines.push('Share it with `foresights status --funnel --json` if you choose; delete it with `foresights status --funnel --delete`.');
  }
  stdout(lines.join('\n') + '\n');
  return { exitCode: 0 };
}
