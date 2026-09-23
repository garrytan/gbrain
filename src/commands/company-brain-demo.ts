import { runCompanyBrainDemo } from '../core/company-brain/demo.ts';
import { OperationError } from '../core/ops/contract.ts';
import { setCliExitVerdict, writeStdoutFinal } from '../core/cli-force-exit.ts';

export const COMPANY_BRAIN_DEMO_HELP = `Usage: gbrain sources demo company-brain [--json]

Import the bundled fictional company into a disposable in-memory brain.
Demonstrates real ownership and decision-history links with source citations.
No keys, network, existing brain, source edits, or saved database required.
`;

export async function runCompanyBrainDemoCli(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { await writeStdoutFinal(COMPANY_BRAIN_DEMO_HELP); return; }
  const json = args.includes('--json');
  if (args.some(arg => arg !== '--json')) {
    if (json) await writeStdoutFinal(`${JSON.stringify({ schema_version: 1, status: 'blocked', code: 'invalid_params', message: 'The offline company demo accepts only --json.' })}\n`);
    else console.error(COMPANY_BRAIN_DEMO_HELP);
    setCliExitVerdict(2);
    return;
  }
  try {
    const result = await runCompanyBrainDemo();
    const output = [`Fictional company demo: ${result.pages} pages verified; ${result.links} typed/reference links.`,
      ...result.answers.flatMap(answer => [answer.question, answer.answer, `Sources: ${answer.citations.join(', ')}`]),
      'No user brain or repository was changed. No provider was called.',
      'Next: gbrain sources inspect <your-company-repo> --profile company-brain'];
    await writeStdoutFinal(json ? `${JSON.stringify(result)}\n` : `${output.join('\n\n')}\n`);
  } catch (error) {
    const code = error instanceof OperationError ? error.code : 'demo_failed';
    const message = error instanceof OperationError ? error.message : 'The offline demo could not complete. Run gbrain doctor on your installation.';
    if (json) await writeStdoutFinal(`${JSON.stringify({ schema_version: 1, status: 'failed', code, message })}\n`);
    else console.error(`Error [${code}]: ${message}`);
    setCliExitVerdict(1);
  }
}
