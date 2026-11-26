/**
 * gbrain telemetry: the person's control over opt-in usage telemetry
 * (docs/guides/telemetry.md). CLI only: no MCP operation reads or changes it.
 *
 *   status (default)            what is on, what is queued, where it goes
 *   show                        the exact JSON the next send would post, and recent sends
 *   off | anonymous | community set the tier (off deletes the local queue)
 *   forget                      delete this install's record on the server and unlink its stored events, then the local id and queue
 *   pulse                       the public aggregate; non-zero exit when it is stale or unreachable
 *   sync [--force]              send now (normally a detached background run does this)
 */
import { setCliExitVerdict, writeStdoutFinal } from '../core/cli-force-exit.ts';
import { opError } from '../core/ops/contract.ts';
import { usageError, writeCliError } from '../cli/cli-error.ts';
import {
  buildBatch, fetchPulse, forcedOff, forgetInstallation, heldEvents, readSettings, sentRecords, setTier, syncTelemetry, telemetryStatus, type Tier,
} from '../core/telemetry/client.ts';

export const TELEMETRY_HELP = `Usage: gbrain telemetry [status|show|off|anonymous|community|forget|pulse|sync] [--json]

gbrain sends no usage data unless you say yes. Nothing about your pages, queries,
file paths, source names or error messages is ever sent.

  status        what is on, what is queued and where it goes (default)
  show          the exact JSON the next send would post, and the last sends
  off           stop sending and delete the local queue
  anonymous     send usage counts and setup/upgrade/doctor results, with no install id
  community     the same plus a random install id, so a setup and a later upgrade on
                one machine can be linked
  forget        delete this install's record on the server and unlink its stored events, then the local install id
  pulse         the public aggregate of everyone's opt-in data
  sync          send now instead of waiting for the background send (--force skips
                the 6-hour window)
  --json        one JSON document on stdout

GBRAIN_TELEMETRY=off in the environment forces telemetry off.
Search telemetry (gbrain search stats) is a different, local-only log and is never sent.
`;

const out = (json: boolean, doc: unknown, human: string) => writeStdoutFinal(json ? `${JSON.stringify(doc, null, 2)}\n` : human);

function fail(e: ReturnType<typeof opError>, extra?: Record<string, unknown>): void {
  setCliExitVerdict(writeCliError(e, 'telemetry', { extra }));
}

async function status(json: boolean): Promise<void> {
  const s = telemetryStatus();
  const tierLine = s.forced_off_by_env ? 'off (GBRAIN_TELEMETRY=off)' : s.tier === 'off' && !s.answered ? 'off (not answered yet)' : s.tier;
  const lines = [
    `Telemetry: ${tierLine}`,
    ...(s.tier === 'community' && s.installation_id ? [`Install id: ${s.installation_id}`] : []),
    ...(s.held_events ? [`Waiting for your answer: ${s.held_events} setup/upgrade event(s), sent only if you choose anonymous or community, deleted on off`] : []),
    `Queued: ${s.queued_events} event(s), ${s.count_days} day(s) of counts`,
    `Last send: ${s.last_sent_at ?? 'never'}${s.last_status !== null ? ` (last try: ${s.last_status})` : ''}`,
    `Sends to: ${s.endpoint ?? 'nowhere (blocked in tests)'}`,
    `Files: ${s.dir}`,
    'Search telemetry (gbrain search stats) is local only and never sent.',
    'Change it: gbrain telemetry off|anonymous|community. See what is sent: gbrain telemetry show.',
  ];
  await out(json, { ...s, search_telemetry: 'local_only' }, `${lines.join('\n')}\n`);
}

async function show(json: boolean): Promise<void> {
  const settings = readSettings();
  const batch = settings.tier === 'off' || forcedOff() ? { events: [], bytes: 0 } : buildBatch(settings);
  const sent = sentRecords();
  const held = heldEvents().map(({ qid: _qid, ...e }) => e);
  const human = [
    ...(held.length ? [`Waiting for your answer (sent only if you choose anonymous or community, deleted on off): ${held.length} event(s)`, JSON.stringify(held, null, 2)] : []),
    `Next send: ${batch.events.length} event(s), ${batch.bytes} bytes`,
    JSON.stringify(batch.events, null, 2),
    `Recent sends: ${sent.length ? '' : 'none'}`,
    ...sent.map(r => `  ${r.sent_at}  HTTP ${r.http}  ${Array.isArray(r.events) ? r.events.length : 0} event(s)`),
  ];
  await out(json, { tier: forcedOff() ? 'off' : settings.tier, held_for_answer: held, next_send: batch.events, next_send_bytes: batch.bytes, sent }, `${human.join('\n')}\n`);
}

async function choose(tier: Tier, json: boolean): Promise<void> {
  const s = setTier(tier);
  const note = forcedOff() ? ' GBRAIN_TELEMETRY=off in this environment still forces it off.' : '';
  const human = tier === 'off'
    ? `Telemetry is off. The local queue and anything waiting for your answer are deleted, and nothing more is sent.${s.installation_id ? ' To also delete what this install already sent, run gbrain telemetry forget.' : ''}\n`
    : `Telemetry is ${tier}.${note} See exactly what is sent with gbrain telemetry show; stop any time with gbrain telemetry off.\n`;
  await out(json, { tier, forced_off_by_env: forcedOff(), installation_id: tier === 'community' ? s.installation_id ?? null : null }, human);
}

async function forget(json: boolean): Promise<void> {
  const r = await forgetInstallation();
  if (r.status === 'no_id') {
    await out(json, { status: 'no_id' }, 'Nothing to forget: this install has no id on the server (anonymous never sends one).\n');
    return;
  }
  if (r.status !== 'forgotten') {
    fail(opError('telemetry_forget_failed', `The telemetry server did not confirm the deletion (${r.http ? `HTTP ${r.http}` : r.status === 'blocked' ? 'no endpoint in this environment' : r.status === 'busy' ? 'a send is in progress' : 'no connection'}), so the local install id is kept.`,
      'Run gbrain telemetry forget again when the machine is online; the id stays until the server confirms.', { retryable: true }));
    return;
  }
  const tier = readSettings().tier;
  const still = tier === 'off' || forcedOff() ? '' : ` Telemetry is still ${tier}: gbrain telemetry off stops sending.`;
  await out(json, r, `Deleted this install's record on the server (${r.events_cleared ?? 0} stored event(s) unlinked and kept only as anonymous rows), removed the local install id and deleted the local queue.${still}\n`);
}

async function pulse(json: boolean): Promise<void> {
  const r = await fetchPulse();
  if (r.ok && !r.stale) {
    await out(json, r.data, `${JSON.stringify(r.data, null, 2)}\n`);
    return;
  }
  const why = r.ok ? `the server answered from a stale cache (refreshed ${String(r.data.refreshed_at ?? 'unknown')})`
    : r.reason === 'blocked' ? 'no endpoint is set in this environment' : r.reason === 'offline' ? 'there is no connection' : `the server answered ${r.http ?? 'without a usable answer'}`;
  fail(opError('telemetry_pulse_unavailable', `The telemetry pulse is not current: ${why}. An outage is not the same as no problems.`,
    'Retry gbrain telemetry pulse later; do not read this run as zero failures.', { retryable: true }), { stale: r.ok, ...(r.ok ? { pulse: r.data } : {}) });
}

async function sync(args: string[], json: boolean): Promise<void> {
  const r = await syncTelemetry({ force: args.includes('--force') });
  if (args.includes('--background')) return;
  await out(json, r, `Telemetry sync: ${r.status}${r.http ? ` (HTTP ${r.http})` : ''}${r.events !== undefined ? `, ${r.events} event(s)` : ''}\n`);
}

export async function runTelemetry(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    await writeStdoutFinal(TELEMETRY_HELP);
    return;
  }
  const json = args.includes('--json');
  const positionals = args.filter(a => !a.startsWith('-'));
  if (positionals.length > 1) return fail(usageError(`gbrain telemetry takes one subcommand, got '${positionals.join(' ')}'`, 'Run gbrain telemetry --help for the subcommands.', { code: 'invalid_params' }));
  const sub = positionals[0] ?? 'status';
  if (sub === 'status') return status(json);
  if (sub === 'show') return show(json);
  if (sub === 'off' || sub === 'anonymous' || sub === 'community') return choose(sub, json);
  if (sub === 'forget') return forget(json);
  if (sub === 'pulse') return pulse(json);
  if (sub === 'sync') return sync(args, json);
  fail(usageError(`unknown telemetry subcommand '${sub}'`, 'Run gbrain telemetry --help for the subcommands.', { code: 'unknown_command' }));
}
