/**
 * wakeshift (plan PR 1 item 9, PR 2): reporting back through Wakeshift. Off is
 * `ok` (disabled by choice). It warns when the key file is readable by other
 * users, when reporting back is enabled but no usable key is found (the watch
 * tools stay hidden), when the brain has live access members but no operator
 * terms links (every watch refuses), when watches died (5 failed attempts or a
 * final Wakeshift refusal) or hit `id_reused` (a bug signal) in the last 7
 * days, when `gbrain wakeshift emit` reported runs of crons nobody registered,
 * when a queued Wakeshift forget is older than a day or died in the last 30
 * days, when forgets are queued while reporting back is off (nothing sends
 * them then), and when the published
 * manifest is older than this build. A brain behind the Wakeshift migration
 * (doctor --no-migrate) reads as off when off, and warns when enabled. Shows the key's kid fingerprint only,
 * never the key. Guide: docs/guides/wakeshift.md.
 */
import { loadConfigFileOnly } from '../../../core/config.ts';
import { parseWakeshiftKey } from '../../../core/wakeshift/client.ts';
import { readWakeshiftKey, wakeshiftFileConfig, wakeshiftKeyFile } from '../../../core/wakeshift/config.ts';
import { liveAccessMembers } from '../../../core/wakeshift/drain.ts';
import { wakeshiftManifestHash } from '../../../core/wakeshift/events.ts';
import { operatorTerms } from '../../../core/wakeshift/terms.ts';
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

const DOCS = 'docs/guides/wakeshift.md#troubleshooting';

async function runWakeshiftCheck(ctx: DoctorContext): Promise<Check[]> {
  try {
    return await wakeshiftChecks(ctx);
  } catch (e) {
    if ((e as { code?: string } | null)?.code !== '42P01') throw e;
    return [wakeshiftFileConfig(loadConfigFileOnly()).enabled === true
      ? { name: 'wakeshift', status: 'warn', message: 'Wakeshift is enabled but this brain has no Wakeshift tables yet (migrations pending), so no watch can be recorded. Fix: gbrain apply-migrations --yes', details: { enabled: true, docs: DOCS } }
      : { name: 'wakeshift', status: 'ok', severity: 'info', readiness_state: 'disabled_by_choice', message: 'Reporting back through Wakeshift is off (gbrain wakeshift enable turns it on).', details: { enabled: false, docs: DOCS } }];
  }
}

async function wakeshiftChecks(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  const file = wakeshiftFileConfig(loadConfigFileOnly());
  const enabled = file.enabled === true;
  const read = readWakeshiftKey();
  let kid: string | null = null;
  let keyProblem: string | null = read.source === 'none' ? 'no key' : null;
  if (read.source === 'env' || read.source === 'file') {
    try { kid = parseWakeshiftKey(read.raw).kid; } catch (e) { keyProblem = (e as Error).message; }
  }
  if (read.source === 'file_too_open') {
    checks.push({ name: 'wakeshift', status: 'warn', message: `${wakeshiftKeyFile()} is readable by other users (mode ${read.mode}); gbrain ignores it until it is 0600. Fix: chmod 600 ${wakeshiftKeyFile()}`, details: { enabled, key_source: read.source, docs: DOCS } });
  } else if (!enabled) {
    const [queued] = await connectedEngine(ctx).executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM wake_forgets WHERE state = 'pending'");
    const pending = Number(queued?.n ?? 0);
    checks.push(pending > 0
      ? { name: 'wakeshift', status: 'warn', message: `Reporting back through Wakeshift is off, but ${pending} Wakeshift forget(s) for removed members or revoked credentials are queued, and nothing sends them while it is off. Fix: gbrain wakeshift enable (with the key in place), then gbrain serve or the job worker sends them.`, details: { enabled, key_source: read.source, pending_forgets: pending, docs: DOCS } }
      : { name: 'wakeshift', status: 'ok', severity: 'info', readiness_state: 'disabled_by_choice', message: 'Reporting back through Wakeshift is off (gbrain wakeshift enable turns it on).', details: { enabled, key_source: read.source, docs: DOCS } });
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
    const engine = connectedEngine(ctx);
    const members = await liveAccessMembers(engine);
    const termsMissing = members > 0 && !operatorTerms(file);
    const [extra] = await engine.executeRaw<{ unregistered: string[] | null; stale_forgets: number; dead_forgets: number }>(
      `SELECT (SELECT array_agg(DISTINCT r.name ORDER BY r.name) FROM wake_cron_runs r
                WHERE r.finished_at > now() - interval '7 days' AND NOT EXISTS (SELECT 1 FROM wake_crons c WHERE c.name = r.name)) AS unregistered,
              (SELECT count(*)::int FROM wake_forgets WHERE state = 'pending' AND created_at < now() - interval '1 day') AS stale_forgets,
              (SELECT count(*)::int FROM wake_forgets WHERE state = 'dead' AND updated_at > now() - interval '30 days') AS dead_forgets`);
    const unregistered = (extra?.unregistered ?? []).slice(0, 10);
    const staleForgets = Number(extra?.stale_forgets ?? 0);
    const deadForgets = Number(extra?.dead_forgets ?? 0);
    const manifestStale = file.manifest_hash !== wakeshiftManifestHash();
    const details = { enabled, key_source: read.source, kid, watches_7d: counts, live_members: members, terms_set: !termsMissing,
      unregistered_crons_7d: unregistered, stale_forgets: staleForgets, dead_forgets_30d: deadForgets, manifest_current: !manifestStale, docs: DOCS };
    const message = termsMissing
      ? `This brain has ${members} live access member(s) but no operator terms links, so every watch refuses and open watches end without a wake. Fix: gbrain wakeshift enable --terms-url <https url> --privacy-url <https url>`
      : counts.id_reused! > 0
      ? `${counts.id_reused} watch(es) were refused with id_reused in the last 7 days: a gbrain bug, so please report it with this output.`
      : counts.dead! > 0
        ? `${counts.dead} wake(s) died in the last 7 days (5 failed attempts or a final Wakeshift refusal); the agents were told the watch ended. Check the key and the app with gbrain wakeshift test.`
        : deadForgets > 0
          ? `${deadForgets} Wakeshift forget(s) failed for good in the last 30 days (a final refusal or 5 failed attempts), so those users were not deleted at Wakeshift. Check the key and the app with gbrain wakeshift test.`
        : staleForgets > 0
          ? `${staleForgets} Wakeshift forget(s) for removed members or revoked credentials have waited over a day; gbrain serve or the job worker sends them. Check gbrain wakeshift test, and that one of them runs.`
          : unregistered.length > 0
            ? `gbrain wakeshift emit reported runs of unregistered cron(s) in the last 7 days (${unregistered.join(', ')}), which no agent can watch. Fix: gbrain wakeshift cron add <name>, or fix the name in the cron script.`
            : manifestStale
              ? 'The published Wakeshift event manifest is older than this build, so agents cannot watch the newer events. Fix: gbrain wakeshift enable'
              : `Reporting back through Wakeshift is on (key kid ${kid}); ${counts.open} open watch(es), ${counts.delivered} delivered in the last 7 days.`;
    const warn = termsMissing || counts.id_reused! > 0 || counts.dead! > 0 || deadForgets > 0 || staleForgets > 0 || unregistered.length > 0 || manifestStale;
    checks.push({ name: 'wakeshift', status: warn ? 'warn' : 'ok', message, details });
  }
  return checks;
}

export const wakeshiftEntry: DoctorEntry = { name: 'wakeshift', emits: ['wakeshift'], run: runWakeshiftCheck };
