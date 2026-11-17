/**
 * commands/connectors/index.ts — thin dispatcher for `foresights connectors <sub>`.
 *
 * Peeled-façade dir (ER-2): each subcommand is its own module so no handler
 * balloons past the module-size ratchet. This file only routes + prints help.
 *
 *   foresights connectors auth <provider> [--cookie V|--token V] [--no-browser] [--try-oauth] [--force]
 *   foresights connectors status [provider] [--json]
 *   foresights connectors sync <provider>|--all [--full] [--dry-run] [--limit N] [--window-days N] [--max-requests N] [--deadline D] [--source id] [--embed] [--background]
 *   foresights connectors logout <provider>
 *   foresights connectors providers
 */

import type { BrainEngine } from '../../core/engine.ts';
import { setCliExitVerdict } from '../../core/cli-force-exit.ts';
import { connectorProviders } from '../../core/connectors/registry.ts';

function printHelp(): void {
  console.log(
    [
      'foresights connectors — sync your own AI-assistant chat history into the brain',
      '',
      'Live sync of ChatGPT + Claude conversation history using your own session',
      'credential. Cookie paste-in is the primary lane. (For the manual export-file',
      'lane, see the conversation-archive skill / `foresights transcripts ingest`.)',
      '',
      'Subcommands:',
      '  auth <provider>       Store a session credential and verify it.',
      '                          --cookie <v>|-   raw Cookie header (- = read stdin)',
      '                          --token <v>      bearer accessToken (advanced)',
      '                          --token -        fireflies, slack: the API key or app token on stdin (probed before it is saved)',
      '                          --try-oauth      attempt OAuth PKCE first (chatgpt; best-effort)',
      '                          --no-browser     print the authorize URL instead of opening',
      '                          --force          save even if the probe fails',
      '  status [provider]     Show credential/sync state (never prints secrets). --json',
      '  sync <provider>|--all Fetch new conversations and ingest them (--all: providers with auto_sync on).',
      '                          --full --dry-run --limit N --window-days N --source <id>',
      '                          --max-requests N (at most 10000) --deadline <90s|30m|2h>',
      '                          --embed --background',
      '  logout <provider>     Delete a stored credential.',
      '  providers             List available connector providers.',
      '',
      'Runs on the host machine only; credentials live at ~/.gbrain/connectors/*.json (0600).',
      'Distinct from `foresights connect` (which onboards THIS agent to a remote brain).',
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
