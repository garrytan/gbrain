import { setupInAgent, type AgentSetupOptions } from './setup.ts';
import { AgentInstallError } from './state.ts';
import { BootstrapError } from '../bootstrap/lock.ts';
import { PgliteBusyError } from '../pglite-lock.ts';

export async function runAgentSetupCli(args: string[]): Promise<number> {
  const json = args.includes('--json');
  if (args.includes('--help') || args.includes('-h')) {
    console.log('setup-in-agent.sh --root ABS --harness grok-bot|muse [--adopt] [--upgrade] [--json]\nRepeat setup to repair the recorded runtime; existing memory is never reset.');
    return 0;
  }
  try {
    const values: Record<string, string> = {};
    const flags = new Set(['--adopt', '--upgrade', '--json']);
    const fields = new Set(['--root', '--harness', '--bundle', '--source-ref']);
    for (let i = 0; i < args.length; i++) {
      if (flags.has(args[i])) continue;
      if (!fields.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new AgentInstallError('usage', `Unknown or missing setup argument: ${args[i]}`);
      values[args[i]] = args[++i];
    }
    if (!values['--root'] || !values['--harness'] || !values['--bundle'] || !values['--source-ref']) throw new AgentInstallError('usage', 'Use the package-shipped setup-in-agent.sh helper with an absolute --root and --harness.');
    const result = await setupInAgent({ root: values['--root'], harness: values['--harness'] as AgentSetupOptions['harness'], bundle: values['--bundle'], sourceRef: values['--source-ref'], adopt: args.includes('--adopt'), upgrade: args.includes('--upgrade') });
    if (json) console.log(JSON.stringify({ ok: true, ...result }));
    else console.log(`${result.status}: ${result.launcher}\nInstructions: ${result.instructions}\nMaintenance: ${result.maintenance}\nNative harness integration is unverified; enable the skill and test a new conversation.${result.search_mode_confirmation_required ? '\nRelay the init search-mode matrix and confirm the user’s choice before optional provider setup.' : ''}`);
    return 0;
  } catch (error) {
    const setupBusy = error instanceof BootstrapError && error.code === 'BOOTSTRAP_IN_PROGRESS';
    const databaseBusy = error instanceof PgliteBusyError;
    const code = setupBusy ? 'setup_busy' : databaseBusy ? error.code : error instanceof AgentInstallError ? error.code : 'setup_failed';
    const message = setupBusy ? 'Another setup owns this installation. Wait for it to finish, then rerun the same setup command. Do not remove its lock.'
      : error instanceof Error ? error.message : String(error);
    const recovery = setupBusy || databaseBusy ? {
      retryable: true,
      recovery_action: 'Wait for the owning process to finish or stop it normally, then rerun the same setup command. Do not remove its lock.',
    } : {};
    if (json) console.log(JSON.stringify({ ok: false, reason: code, message, ...recovery }));
    else console.error(`${code}: ${message}`);
    return code === 'usage' ? 2 : 1;
  }
}

if (import.meta.main) process.exit(await runAgentSetupCli(process.argv.slice(2)));
