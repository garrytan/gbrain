/**
 * commands/connectors/index.ts — thin dispatcher for `gbrain connectors <sub>`.
 *
 * Peeled-façade dir (ER-2): each subcommand is its own module so no handler
 * balloons past the module-size ratchet. This file only routes + prints help.
 *
 *   gbrain connectors auth <provider> [--cookie V|--token V] [--no-browser] [--try-oauth] [--force]
 *   gbrain connectors status [provider] [--json]
 *   gbrain connectors sync <provider>|--all [--full] [--dry-run] [--limit N] [--window-days N] [--source id] [--embed] [--background]
 *   gbrain connectors logout <provider>
 *   gbrain connectors providers
 */

import type { BrainEngine } from '../../core/engine.ts';
import { setCliExitVerdict } from '../../core/cli-force-exit.ts';
import { connectorProviders } from '../../core/connectors/registry.ts';

function printHelp(): void {
  console.log(
    [
      'gbrain connectors — sync your own AI-assistant chat history into the brain',
      '',
      'Live sync of ChatGPT + Claude conversation history using your own session',
      'credential. Cookie paste-in is the primary lane. (For the manual export-file',
      'lane, see the conversation-archive skill / `gbrain transcripts ingest`.)',
      '',
      'Subcommands:',
      '  auth <provider>       Store a session credential and verify it.',
      '                          --cookie <v>|-   raw Cookie header (- = read stdin)',
      '                          --token <v>      bearer accessToken (advanced)',
      '                          --try-oauth      attempt OAuth PKCE first (chatgpt; best-effort)',
      '                          --no-browser     print the authorize URL instead of opening',
      '                          --force          save even if the probe fails',
      '  status [provider]     Show credential/sync state (never prints secrets). --json',
      '  sync <provider>|--all Fetch new conversations and ingest them.',
      '                          --full --dry-run --limit N --window-days N --source <id>',
      '                          --embed --background',
      '  logout <provider>     Delete a stored credential.',
      '  providers             List available connector providers.',
      '',
      'Runs on the host machine only; credentials live at ~/.gbrain/connectors/*.json (0600).',
      'Distinct from `gbrain connect` (which onboards THIS agent to a remote brain).',
    ].join('\n'),
  );
}

export async function runConnectors(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    printHelp();
    return;
  }
  const rest = args.slice(1);
  switch (sub) {
    case 'providers': {
      for (const p of connectorProviders) {
        console.log(`${p.name}\t${p.spoolFormat}\tstrategies: ${p.strategies.join(', ')}\t(${p.specTarget.status})`);
      }
      return;
    }
    case 'auth': {
      const { runConnectorAuth } = await import('./auth.ts');
      await runConnectorAuth(engine, rest);
      return;
    }
    case 'status': {
      const { runConnectorStatus } = await import('./status.ts');
      await runConnectorStatus(engine, rest);
      return;
    }
    case 'sync': {
      const { runConnectorSyncCmd } = await import('./sync.ts');
      await runConnectorSyncCmd(engine, rest);
      return;
    }
    case 'logout': {
      const { runConnectorLogout } = await import('./auth.ts');
      await runConnectorLogout(rest);
      return;
    }
    default:
      console.error(`Unknown connectors subcommand: ${sub}`);
      printHelp();
      setCliExitVerdict(1);
  }
}
