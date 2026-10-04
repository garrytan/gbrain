/** D3 curated help for `gbrain autopilot` (flags read by src/commands/autopilot.ts, autopilot-daemon.ts, autopilot-pause.ts). */
import type { CliHelpSpec } from '../command-table.ts';

export const help: CliHelpSpec = {
  summary: 'Self-maintaining brain daemon: lint, backlinks, sync, extract, embed and orphans on an interval.',
  usage: [
    'gbrain autopilot [--repo <path>] [--interval <s>] [--json] [--no-worker] [--inline]',
    'gbrain autopilot --install [--repo <path>] [--target macos|linux-systemd|ephemeral-container|linux-cron] [--force]',
    'gbrain autopilot --uninstall | --status [--json] | pause [--reason <text>] | resume',
  ].join('\n'),
  flags: [
    { name: '--repo', type: 'string', desc: 'Brain repository to maintain (default: config sync.repo_path).' },
    { name: '--interval', type: 'number', desc: 'Seconds between cycles (default 300).' },
    { name: '--json', type: 'boolean', desc: 'Machine-readable output: daemon cycle events, or the --status / pause report as JSON.' },
    { name: '--no-worker', type: 'boolean', desc: 'Do not spawn the jobs worker child.' },
    { name: '--inline', type: 'boolean', desc: 'Run each cycle in-process instead of dispatching it through the Postgres job queue.' },
    { name: '--install', type: 'boolean', desc: 'Install the daemon under the host supervisor (launchd, systemd, cron or a start script).', consent: ['persistent_install'] },
    { name: '--target', type: 'enum', values: ['macos', 'linux-systemd', 'ephemeral-container', 'linux-cron'], desc: 'With --install: force the supervisor instead of detecting it.' },
    { name: '--force', type: 'boolean', desc: 'With --install: allow a daemon on a PGLite brain (it holds the single-writer lock).' },
    { name: '--inject-bootstrap', type: 'boolean', desc: 'With --install in an ephemeral container: add the start script to the agent bootstrap (automatic when OpenClaw is detected).' },
    { name: '--no-inject', type: 'boolean', desc: 'With --install: never edit the agent bootstrap files.' },
    { name: '--uninstall', type: 'boolean', desc: 'Remove the installed daemon.' },
    { name: '--status', type: 'boolean', desc: 'Report whether the daemon is installed and running.' },
    { name: '--pause', type: 'boolean', desc: 'Operator hold: the daemon skips cycles until resumed (same as `pause`).' },
    { name: '--resume', type: 'boolean', desc: 'Lift the operator hold (same as `resume`).' },
    { name: '--reason', type: 'string', desc: 'With --pause: why the brain is held (recorded in the pause marker).' },
  ],
  examples: [
    'gbrain autopilot --status --json',
    'gbrain autopilot --install --repo ~/brain',
    'gbrain autopilot --repo ~/brain --interval 600 --json',
    'gbrain autopilot pause --reason "migrating"',
  ],
};
