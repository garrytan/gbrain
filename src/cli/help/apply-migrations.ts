/** D3 curated help for `gbrain apply-migrations` (flags read by src/commands/apply-migrations.ts parseArgs). */
import type { CliHelpSpec } from '../command-table.ts';

export const help: CliHelpSpec = {
  summary: 'Run pending migration orchestrators (schema, data and host-file migrations).',
  usage: [
    'gbrain apply-migrations [--yes | --non-interactive] [--dry-run [--json]] [--list] [--mode always|pain_triggered|off]',
    'gbrain apply-migrations --migration <vX.Y.Z> | --force-retry <vX.Y.Z> | --force-orchestrator | --force-schema | --force',
    'gbrain apply-migrations --migration 0.53.0 --export-db-only --content-root <path> [--export-source <id>] --dry-run --json',
  ].join('\n'),
  flags: [
    { name: '--yes', type: 'boolean', desc: 'Run without prompting (default mode pain_triggered); authorizes the Phase F autopilot install.', consent: ['persistent_install'] },
    { name: '--non-interactive', type: 'boolean', desc: 'Never prompt; authorizes only the Phase F autopilot install.', consent: ['persistent_install'] },
    { name: '--dry-run', type: 'boolean', desc: 'Print the plan; take no action.' },
    { name: '--json', type: 'boolean', desc: 'One JSON document on stdout (plan, previews, per-migration results); a failure is the error envelope with code and suggestion.' },
    { name: '--list', type: 'boolean', desc: 'Show applied and pending migrations.' },
    { name: '--mode', type: 'enum', values: ['always', 'pain_triggered', 'off'], desc: 'Set minion_mode without prompting.' },
    { name: '--migration', type: 'string', desc: 'Force-run one migration by version.' },
    { name: '--force-retry', type: 'string', desc: 'Clear a wedged migration (3+ consecutive partials) so the next run treats it as fresh.' },
    { name: '--force-orchestrator', type: 'boolean', desc: 'Reset every wedged orchestrator migration in one shot.' },
    { name: '--force-schema', type: 'boolean', desc: 'Reset schema-version drift and re-run the schema migrations.' },
    { name: '--force', type: 'boolean', desc: 'Alias of --force-all: --force-orchestrator plus --force-schema.' },
    { name: '--force-all', type: 'boolean', desc: 'Both --force-orchestrator and --force-schema.' },
    { name: '--skip-verify', type: 'boolean', desc: 'Bypass post-condition verify hooks on non-idempotent migrations.' },
    { name: '--require-db', type: 'boolean', desc: 'Exit 1 when the database is unreachable instead of running the filesystem-only plan.' },
    { name: '--host-dir', type: 'string', desc: 'Include this directory in the host-file walk (default $HOME/.claude and $HOME/.openclaw).' },
    { name: '--no-autopilot-install', type: 'boolean', desc: 'Skip the Phase F autopilot install (also GBRAIN_NO_AUTOPILOT_INSTALL=1).' },
    { name: '--export-db-only', type: 'boolean', desc: 'Export DB-only content to markdown (needs --content-root and one backup choice).' },
    { name: '--content-root', type: 'string', desc: 'Directory the DB-only export writes into.' },
    { name: '--export-source', type: 'string', desc: 'Source id to export (default default).' },
    { name: '--confirm-quiesced', type: 'boolean', desc: 'Attest old writers and skill servers are stopped.' },
    { name: '--backup-confirmed', type: 'boolean', desc: 'Attest an operational backup was verified.' },
    { name: '--acknowledge-no-backup', type: 'boolean', desc: 'Proceed without a verified backup (explicit choice).', consent: ['destructive'] },
  ],
  examples: [
    'gbrain apply-migrations --dry-run --json',
    'gbrain apply-migrations --yes',
    'gbrain apply-migrations --yes --no-autopilot-install',
    'gbrain apply-migrations --force-retry 0.53.0',
  ],
};
