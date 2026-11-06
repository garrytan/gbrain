/**
 * wakeshift (plan PR 1 item 9): reporting back through Wakeshift. Off is
 * `ok` (disabled by choice). It warns when the key file is readable by other
 * users, when reporting back is enabled but no usable key is found (the watch
 * tools stay hidden), when the brain gained live access members after enable
 * (reporting back pauses), and when watches died (5 failed attempts or a final
 * Wakeshift refusal) or hit `id_reused` (a bug signal) in the last 7 days.
 * Shows the key's kid fingerprint only, never the key. Guide: docs/guides/wakeshift.md.
 */
import { loadConfigFileOnly } from '../../../core/config.ts';
import { parseWakeshiftKey } from '../../../core/wakeshift/client.ts';
import { readWakeshiftKey, wakeshiftFileConfig, wakeshiftKeyFile } from '../../../core/wakeshift/config.ts';
import { liveAccessMembers } from '../../../core/wakeshift/drain.ts';
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

const DOCS = 'docs/guides/wakeshift.md#troubleshooting';

async function runWakeshiftCheck(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  const enabled = wakeshiftFileConfig(loadConfigFileOnly()).enabled === true;
  const read = readWakeshiftKey();
  let kid: string | null = null;
  let keyProblem: string | null = read.source === 'none' ? 'no key' : null;
  if (read.source === 'env' || read.source === 'file') {
    try { kid = parseWakeshiftKey(read.raw).kid; } catch (e) { keyProblem = (e as Error).message; }
  }
  if (read.source === 'file_too_open') {
    checks.push({ name: 'wakeshift', status: 'warn', message: `${wakeshiftKeyFile()} is readable by other users (mode ${read.mode}); gbrain ignores it until it is 0600. Fix: chmod 600 ${wakeshiftKeyFile()}`, details: { enabled, key_source: read.source, docs: DOCS } });
  } else if (!enabled) {
    checks.push({ name: 'wakeshift', status: 'ok', severity: 'info', readiness_state: 'disabled_by_choice', message: 'Reporting back through Wakeshift is off (gbrain wakeshift enable turns it on).', details: { enabled, key_source: read.source, docs: DOCS } });
  } else if (!kid) {
    checks.push({ name: 'wakeshift', status: 'warn', message: `Wakeshift is enabled but has no usable key (${keyProblem}), so the watch tools are hidden. Fix: put the key in ${wakeshiftKeyFile()} (0600) or WAKESHIFT_API_KEY, then run gbrain wakeshift test.`, details: { enabled, key_source: read.source, docs: DOCS } });
  } else {
    const rows = await connectedEngine(ctx).executeRaw<{ state: string; id_reused: boolean; n: number }>(
      `SELECT state, (last_error = 'id_reused') AS id_reused, count(*)::int AS n FROM wake_subscriptions
        WHERE state = 'open' OR updated_at > now() - interval '7 days' GROUP BY 1, 2`);
    const counts: Record<string, number> = { open: 0, delivered: 0, dead: 0, ended: 0, id_reused: 0 };
    for (const r of rows) {
      counts[r.state] = (counts[r.state] ?? 0) + Number(r.n);
      if (r.id_reused) counts.id_reused! += Number(r.n);
    }
    const members = await liveAccessMembers(connectedEngine(ctx));
    const details = { enabled, key_source: read.source, kid, watches_7d: counts, live_members: members, docs: DOCS };
    const message = members > 0
      ? `Reporting back is paused: this brain now has ${members} live access member(s), and this release reports back only on a brain that serves its owner alone. watch_job refuses and no wakes are sent. Fix: gbrain wakeshift disable, or remove the members.`
      : counts.id_reused! > 0
      ? `${counts.id_reused} watch(es) were refused with id_reused in the last 7 days: a gbrain bug, so please report it with this output.`
      : counts.dead! > 0
        ? `${counts.dead} wake(s) died in the last 7 days (5 failed attempts or a final Wakeshift refusal); the agents were told the watch ended. Check the key and the app with gbrain wakeshift test.`
        : `Reporting back through Wakeshift is on (key kid ${kid}); ${counts.open} open watch(es), ${counts.delivered} delivered in the last 7 days.`;
    checks.push({ name: 'wakeshift', status: members > 0 || counts.id_reused! > 0 || counts.dead! > 0 ? 'warn' : 'ok', message, details });
  }
  return checks;
}

export const wakeshiftEntry: DoctorEntry = { name: 'wakeshift', emits: ['wakeshift'], run: runWakeshiftCheck };
