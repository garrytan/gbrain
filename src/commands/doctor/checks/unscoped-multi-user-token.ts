/**
 * GST-363 `unscoped_multi_user_token` (read-only, warn): credentials and local
 * agents that can read chat from several channels with no per-person scope.
 * An agent several people talk to through one such grant may answer one
 * person with another person's messages (HARN-13 host-harness pilot). The
 * detection is src/core/grants/shared-exposure.ts, the same module the install
 * routes warn from.
 *
 * Warns only when chat from MULTI_CHANNEL_MIN+ channels is in reach of an
 * active legacy token, a live OAuth client, or the stdio server of a wired bot
 * harness (or of Claude Code with a chat-channel plugin). A bot harness with
 * no such chat in reach is reported as information, so a brain that cannot
 * act on it before per-member keys (gbrain#7812) is not marked unhealthy.
 * A remote caller (run_doctor only) gets counts, never credential names.
 */
import { grantFromClient, grantFromRow, grantFromTokenRow, type PrincipalGrant } from '../../../core/grants/model.ts';
import { BOT_HARNESSES, NOTICE_CODE, chatChannelCensus, claudeCodeChannelPlugins, credentialReadSources, exposureFix, exposureReasons,
  stdioReadSources, subjectLabel, type ChatCensus, type ExposureSubject } from '../../../core/grants/shared-exposure.ts';
import { readBrainFirstLedger } from '../../../core/setup/brain-first.ts';
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

interface Finding { subject: ExposureSubject; label: string; reasons: string[]; census: ChatCensus }

async function runUnscopedMultiUserToken(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  const engine = connectedEngine(ctx);
  const memo = new Map<string, Promise<ChatCensus>>();
  const census = (sources: string[]) => {
    const key = [...sources].sort().join(',');
    if (!memo.has(key)) memo.set(key, chatChannelCensus(engine, sources));
    return memo.get(key)!;
  };
  const credentials: Array<{ subject: ExposureSubject; grant: PrincipalGrant }> = [];
  for (const row of await engine.executeRaw<Record<string, unknown>>('SELECT * FROM access_tokens WHERE revoked_at IS NULL ORDER BY created_at, id')) {
    credentials.push({ subject: { kind: 'legacy_token', name: String(row.name) }, grant: grantFromTokenRow(row) });
  }
  for (const row of await engine.executeRaw<Record<string, unknown>>('SELECT * FROM oauth_clients WHERE deleted_at IS NULL ORDER BY client_id')) {
    const grant = grantFromRow(row);
    credentials.push({ subject: { kind: 'oauth_client', id: grant.clientId, name: grant.clientName || undefined }, grant: grantFromClient(grant) });
  }
  const findings: Finding[] = [];
  for (const { subject, grant } of credentials) {
    const c = await census(await credentialReadSources(engine, grant));
    const reasons = exposureReasons({ census: c });
    if (reasons.length) findings.push({ subject, label: subjectLabel(subject), reasons, census: c });
  }
  const local: Finding[] = [];
  if (!ctx.remote) {
    const plugins = claudeCodeChannelPlugins();
    const harnesses = [...new Set([
      ...readBrainFirstLedger().filter(e => e.status === 'installed' && BOT_HARNESSES.includes(e.harness)).map(e => e.harness),
      ...(plugins.length ? ['claude-code'] : []),
    ])];
    const stdio = harnesses.length ? await census(await stdioReadSources(engine)) : null;
    for (const harness of harnesses) {
      const subject: ExposureSubject = { kind: 'stdio', harness };
      local.push({ subject, label: subjectLabel(subject), census: stdio!,
        reasons: exposureReasons({ harness, channelPlugins: harness === 'claude-code' ? plugins : undefined, census: stdio }) });
    }
  }
  const flagged = [...findings, ...local.filter(f => f.reasons.includes('multi_channel_chat'))];
  const details = (list: Finding[]) => list.map(f => ({ subject: f.subject, reasons: f.reasons, read_sources: f.census.sources, chat_sources: f.census.chat_sources,
    chat_pages: f.census.chat_pages, channels: f.census.channels, fix: exposureFix(f.subject, f.census) }));
  if (flagged.length === 0) {
    const bots = local.map(f => f.subject.kind === 'stdio' ? f.subject.harness : '').filter(Boolean);
    if (bots.length) {
      checks.push({ name: 'unscoped_multi_user_token', status: 'ok', severity: 'info', readiness_state: 'ok',
        message: `${bots.join(', ')} serve${bots.length === 1 ? 's' : ''} a chat agent from this brain with no per-person scope; no chat from several channels is in its reach now. `
          + 'Scope the agent before you add channel or DM pages (this check reports it then).',
        details: { local: details(local) } });
    } else {
      checks.push({ name: 'unscoped_multi_user_token', status: 'ok', message: 'No credential or local agent can read chat from several channels without a per-person scope.' });
    }
    return checks;
  }
  const first = flagged[0]!;
  checks.push({
    name: 'unscoped_multi_user_token', status: 'warn',
    message: ctx.remote
      ? `${flagged.length} credential(s) can read chat from several channels with no per-person scope, so an agent several people use may answer one person with another person's messages. Ask the brain host's operator to run gbrain doctor --only ${NOTICE_CODE}.`
      : `${flagged.length} credential(s) or local agent(s) can read chat from several channels with no per-person scope: ${first.label} reaches ${first.census.channels} channels in ${first.census.chat_sources.join(', ')}`
        + `${flagged.length > 1 ? `, and ${flagged.length - 1} more in details.flagged` : ''}. An agent several people use may answer one person with another person's messages.`,
    details: ctx.remote ? { flagged_count: flagged.length } : { flagged: details(flagged) },
    ...(ctx.remote ? {} : { fix: exposureFix(first.subject, first.census) }),
  });
  return checks;
}

export const unscopedMultiUserTokenEntry: DoctorEntry = {
  name: 'unscoped_multi_user_token',
  emits: ['unscoped_multi_user_token'],
  run: runUnscopedMultiUserToken,
};
