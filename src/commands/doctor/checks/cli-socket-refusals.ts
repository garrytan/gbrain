/**
 * cli_socket_refusals (GBRA-156): warns while the warm CLI socket refused CLI calls in the last 24 hours. A refused
 * call is answered by the CLI's own cold path, several times slower, and a caller whose environment differs from the
 * serve's (a cron, another agent harness) is refused on every call. The serve counts refusals by the identity part
 * that differed, never its value (core/cli-socket/refusals.ts). Read-only; reads one file in the run directory.
 */
import type { Check } from '../../doctor.ts';
import type { DoctorContext, DoctorEntry } from '../context.ts';
import { configDir } from '../../../core/config.ts';
import { cliSocketDir } from '../../../core/cli-socket/fs-guard.ts';
import { readRefusals } from '../../../core/cli-socket/refusals.ts';

const WINDOW_MS = 24 * 60 * 60 * 1000;
const DOCS = 'docs/guides/cli-socket.md';

async function runCliSocketRefusals(_ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  const record = readRefusals(cliSocketDir(configDir()));
  const since = Date.now() - WINDOW_MS;
  const recent = Object.entries(record?.parts ?? {}).filter(([, part]) => Date.parse(part.last_at) >= since).sort((a, b) => b[1].count - a[1].count);
  if (recent.length === 0) {
    checks.push({ name: 'cli_socket_refusals', status: 'ok', details: { refusals: 0, docs: DOCS }, message: 'The warm CLI socket refused no CLI call in the last 24 hours.' });
    return checks;
  }
  const total = recent.reduce((n, [, part]) => n + part.count, 0);
  checks.push({ name: 'cli_socket_refusals', status: 'warn',
    details: { refusals: total, serve_pid: record!.pid, serve_started_at: record!.started_at, parts: Object.fromEntries(recent), docs: DOCS },
    message: `The warm CLI socket refused ${total} CLI call(s) since ${recent.map(([, p]) => p.first_at).sort()[0]}, so each ran on the slower cold path: `
      + recent.map(([name, part]) => `${name} differs from the serve's (${part.count}, last ${part.last_at})`).join('; ')
      + '. Run the caller with the same value as the serve (or restart the serve with the caller\'s), then the calls are answered warm. Values are never recorded.',
    fix: { argv: ['gbrain', 'doctor', '--only', 'cli_socket_refusals', '--json'], consent: [], actor: 'agent', requires_exclusive: false, docs: DOCS,
      why: 'Read-only: names each identity part that differed and how often; align that part between the caller and the serve.' } });
  return checks;
}

export const cliSocketRefusalsEntry: DoctorEntry = { name: 'cli_socket_refusals', emits: ['cli_socket_refusals'], run: runCliSocketRefusals };
