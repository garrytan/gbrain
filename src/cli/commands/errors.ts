/**
 * `gbrain errors <code> [--json]` / `gbrain errors --changed [--json]` /
 * `gbrain errors [--json]`: offline lookup in the error code registry
 * (agent contract v1, A2). Engine-free; the same rows as
 * docs/guides/error-codes.md.
 */
import { writeStdoutFinal, setCliExitVerdict } from '../../core/cli-force-exit.ts';
import { CODES } from '../../core/error-catalogue.ts';
import { changedCodeRows, errorCodeRow, renderErrorCodeText } from '../../core/error-docs.ts';
import { suggestNearest } from '../../core/levenshtein.ts';

const HELP = `Usage: gbrain errors [<code>] [--changed] [--json]

Look up a gbrain error code offline: what it means, why it happens, the next
step, who acts, and how to verify.

  gbrain errors <code>        one code (exit 2 when unknown, with a did-you-mean)
  gbrain errors --changed     codes whose legacy \`error\` value differs from \`code\`
  gbrain errors               every code, one line each
  --json                      machine-readable output
`;

export async function run(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    await writeStdoutFinal(HELP);
    return;
  }
  const json = args.includes('--json');
  const code = args.filter(a => !a.startsWith('-'))[0];
  if (args.includes('--changed')) {
    const rows = changedCodeRows();
    await writeStdoutFinal(json ? `${JSON.stringify({ codes: rows }, null, 2)}\n` : `${rows.map(renderErrorCodeText).join('\n\n')}\n`);
    return;
  }
  if (!code) {
    const all = Object.keys(CODES).sort().map(c => errorCodeRow(c)!);
    await writeStdoutFinal(json
      ? `${JSON.stringify({ codes: all }, null, 2)}\n`
      : `${all.map(r => `${r.code.padEnd(36)} ${r.class.padEnd(11)} ${r.meaning}`).join('\n')}\n`);
    return;
  }
  const row = errorCodeRow(code);
  if (!row) {
    const nearest = suggestNearest(code, Object.keys(CODES));
    const message = `Unknown error code: ${code}.${nearest ? ` Did you mean "${nearest}"?` : ''}`;
    if (json) {
      await writeStdoutFinal(`${JSON.stringify({
        error: 'invalid_params', code: 'invalid_params', message,
        suggestion: 'Run `gbrain errors` to list every code.', contract_version: 1,
      }, null, 2)}\n`);
    } else {
      console.error(message);
      console.error('Run `gbrain errors` to list every code.');
    }
    setCliExitVerdict(2);
    return;
  }
  await writeStdoutFinal(json ? `${JSON.stringify(row, null, 2)}\n` : `${renderErrorCodeText(row)}\n`);
}
