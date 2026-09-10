import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { readCredentials, credentialReceipt } from '../core/harness/credentials.ts';
import { harnessAdapter } from '../core/harness/registry.ts';
import { installHarnessConnection } from '../core/harness/install.ts';
import { normalizeMcpUrl } from '../core/mcp-registration.ts';
import { validateHarnessArguments } from '../core/harness/arguments.ts';

export async function runHarnessConnect(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('gbrain connect <endpoint> --harness <id> --credentials-file <private-file> [--install | --remove] [--root <persistent-root>] [--name <name>] [--json]');
    return;
  }
  const value = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  try {
    validateHarnessArguments(args.slice(1), { values: ['--harness', '--credentials-file', '--root', '--name'], flags: ['--install', '--remove', '--json'], aliases: { '--agent': '--harness' }, exclusive: [['--install', '--remove']] });
    const path = value('--credentials-file');
    if (!path) throw new Error('--credentials-file is required; create the private handoff with gbrain mcp grant on the brain host');
    const c = readCredentials(path);
    const harness = harnessAdapter(value('--harness') ?? value('--agent') ?? c.harness ?? 'generic');
    const endpoint = normalizeMcpUrl(args[0] ?? '');
    if (!endpoint.ok || endpoint.url !== c.mcp_url) throw new Error('Endpoint does not match the private credential handoff');
    const result = args.includes('--install') || args.includes('--remove')
      ? await installHarnessConnection(c, { harness: harness.id, name: value('--name'), root: value('--root'), remove: args.includes('--remove') })
      : { ...credentialReceipt(c), status: 'prepared', harness: harness.id, documentation: harness.guide, next_action: 'Run this command with --install inside the intended harness environment. Keep the credential file private.' };
    console.log(JSON.stringify(result, null, args.includes('--json') ? undefined : 2));
    if (result.status === 'pending') setCliExitVerdict(2);
  } catch (error) {
    console.log(JSON.stringify({ status: 'error', reason: 'connection_setup_failed', message: error instanceof Error ? error.message : 'Connection setup failed' }));
    setCliExitVerdict(1);
  }
}
