/**
 * `gbrain notices mute <code>` / `unmute <code>` / `list [--json]` (agent
 * contract v1, A6). The trusted local owner's mutes apply to every surface
 * for coaching/info notices. Engine-free.
 */
import { writeStdoutFinal, setCliExitVerdict } from '../../core/cli-force-exit.ts';
import { mutedNoticeCodes, setNoticeMuted } from '../../core/notice-ledger.ts';
import { MUTEABLE_NOTICE_CODES } from '../../core/ops/notices.ts';

const HELP = `Usage: gbrain notices <mute|unmute> <code> | gbrain notices list [--json]

Mute a coaching or info notice for every agent connected to this brain.
Safety, degraded and ask notices always show.
Muteable codes: ${MUTEABLE_NOTICE_CODES.join(', ')}
`;

export async function run(args: string[]): Promise<void> {
  const [sub, code] = args.filter(a => !a.startsWith('-'));
  const json = args.includes('--json');
  if (!sub || args.includes('--help') || args.includes('-h')) {
    await writeStdoutFinal(HELP);
    if (!sub && !args.includes('--help') && !args.includes('-h')) setCliExitVerdict(2);
    return;
  }
  if (sub === 'list') {
    const muted = [...mutedNoticeCodes()].sort();
    await writeStdoutFinal(json ? `${JSON.stringify({ muted, muteable: MUTEABLE_NOTICE_CODES }, null, 2)}\n` : `${muted.length ? muted.join('\n') : '(no muted notices)'}\n`);
    return;
  }
  if ((sub !== 'mute' && sub !== 'unmute') || !code || !MUTEABLE_NOTICE_CODES.includes(code)) {
    console.error(`Unknown notice or subcommand. ${HELP}`);
    setCliExitVerdict(2);
    return;
  }
  const muted = setNoticeMuted(code, sub === 'mute');
  await writeStdoutFinal(json ? `${JSON.stringify({ code, muted: sub === 'mute', muted_codes: muted }, null, 2)}\n` : `${sub === 'mute' ? 'Muted' : 'Unmuted'} ${code}.\n`);
}
