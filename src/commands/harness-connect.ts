import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { readCredentials, credentialReceipt } from '../core/harness/credentials.ts';
import { harnessAdapter } from '../core/harness/registry.ts';
import { installHarnessConnection, type inlineTokenReceipt } from '../core/harness/install.ts';
import { normalizeMcpUrl } from '../core/mcp-registration.ts';
import { validateHarnessArguments } from '../core/harness/arguments.ts';
import { readHarnessConnectionStatus } from '../core/harness/status.ts';

export async function runHarnessConnect(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('gbrain connect <endpoint> --harness <id> --credentials-file <private-file> [--install [--fresh-token] | --remove] [--root <persistent-root>] [--name <name>] [--json]\ngbrain connect --harness <id> --status [--root <persistent-root>] [--name <name>] [--json]');
    return;
  }
  const value = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  try {
    validateHarnessArguments(args[0]?.startsWith('--') ? args : args.slice(1), { values: ['--harness', '--credentials-file', '--root', '--name'], flags: ['--install', '--remove', '--status', '--json', '--fresh-token'], aliases: { '--agent': '--harness' }, exclusive: [['--install', '--remove', '--status']] });
    if (args.includes('--status')) {
      const harness = value('--harness') ?? value('--agent');
      if (!harness) throw new Error('--harness is required for local status; no credentials or live connection are needed');
      console.log(JSON.stringify(readHarnessConnectionStatus({ harness, root: value('--root'), name: value('--name') }), null, args.includes('--json') ? undefined : 2));
      return;
    }
    const path = value('--credentials-file');
    if (!path) throw new Error('--credentials-file is required; create the private handoff with gbrain mcp grant on the brain host');
    const c = readCredentials(path);
    const harness = harnessAdapter(value('--harness') ?? value('--agent') ?? c.harness ?? 'generic');
    const endpoint = normalizeMcpUrl(args[0] ?? '');
    if (!endpoint.ok || endpoint.url !== c.mcp_url) throw new Error('Endpoint does not match the private credential handoff');
    const result = args.includes('--install') || args.includes('--remove')
      ? await installHarnessConnection(c, { harness: harness.id, name: value('--name'), root: value('--root'), remove: args.includes('--remove'), credentialsFile: path, freshToken: args.includes('--fresh-token') })
      : { ...credentialReceipt(c), status: 'prepared', harness: harness.id, documentation: harness.guide, next_action: 'Run this command with --install inside the intended harness environment. Keep the credential file private.' };
    console.log(JSON.stringify(result, null, args.includes('--json') ? undefined : 2));
    const token = result as Partial<ReturnType<typeof inlineTokenReceipt>>;
    if (!args.includes('--json') && token.token_storage === 'inline' && token.if_exposed) {
      console.error(`The bearer token is stored inline in ${token.config_path}; this output never prints it. Renew it with: ${token.renew_command}`);
      console.error(`If it was exposed: ${token.if_exposed.steps.join(' Then: ')} See ${token.if_exposed.docs_url}.`);
      if (token.token_warning) console.error(`WARNING: ${token.token_warning}`);
    }
    if (result.status === 'pending' || 'remote_membership_pending' in result && result.remote_membership_pending) setCliExitVerdict(2);
  } catch (error) {
    console.log(JSON.stringify({ status: 'error', reason: 'connection_setup_failed', message: error instanceof Error ? error.message : 'Connection setup failed' }));
    setCliExitVerdict(1);
  }
}
